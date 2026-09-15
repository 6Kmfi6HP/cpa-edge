/**
 * Response translation: Claude (Anthropic Messages SSE) -> OpenAI chat.
 *
 * The Claude upstream is always streamed, so both downstream modes consume
 * SSE events: stream clients get one `chat.completion.chunk` per translated
 * upstream event, non-stream clients get the aggregated buffer validated
 * first (S2d3 section 5.3) and rendered as one `chat.completion`.
 */
import { serializeOrdered } from './json'
import type { ClaudeToChatContext, WireObject, WireValue } from './types'

/** Upstream stop_reason -> downstream finish_reason (S2d3 section 3.3). */
export function mapStopReason(stopReason: string | undefined): string {
  switch (stopReason) {
    case 'end_turn':
      return 'stop'
    case 'tool_use':
      return 'tool_calls'
    case 'max_tokens':
      return 'length'
    case 'stop_sequence':
      return 'stop'
    case 'refusal':
    case 'sensitive':
      return 'content_filter'
    default:
      return 'stop'
  }
}

/** Usage fields merged from message_start and message_delta (absolute). */
export interface UsageTracker {
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  seen: boolean
}

export function emptyUsage(): UsageTracker {
  return { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, seen: false }
}

export function mergeUsage(tracker: UsageTracker, usage: unknown): UsageTracker {
  if (typeof usage !== 'object' || usage === null) return tracker
  const record = usage as Record<string, unknown>
  const input = record['input_tokens']
  if (typeof input === 'number' && Number.isFinite(input)) tracker.inputTokens = input
  const output = record['output_tokens']
  if (typeof output === 'number' && Number.isFinite(output)) tracker.outputTokens = output
  const creation = record['cache_creation_input_tokens']
  if (typeof creation === 'number' && Number.isFinite(creation)) tracker.cacheCreationInputTokens = creation
  const read = record['cache_read_input_tokens']
  if (typeof read === 'number' && Number.isFinite(read)) tracker.cacheReadInputTokens = read
  tracker.seen = true
  return tracker
}

/** Downstream usage arithmetic (S2d3 section 3.4), in wire key order. */
export function usageObject(tracker: UsageTracker): WireObject {
  const promptTokens = tracker.inputTokens + tracker.cacheCreationInputTokens + tracker.cacheReadInputTokens
  const completionTokens = tracker.outputTokens
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    prompt_tokens_details: {
      cached_tokens: tracker.cacheReadInputTokens,
      cached_creation_tokens: tracker.cacheCreationInputTokens,
      cache_write_tokens: tracker.cacheCreationInputTokens,
    },
  }
}

/** Template zeros for the non-stream completion when no usage was seen. */
export function zeroUsageObject(): WireObject {
  return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
}

interface ToolAccumulator {
  readonly seq: number
  readonly id: string
  readonly name: string
  parts: string[]
}

function readMessageField(event: Record<string, unknown>, key: string): string | undefined {
  const message = event['message']
  if (typeof message !== 'object' || message === null) return undefined
  const raw = (message as Record<string, unknown>)[key]
  return typeof raw === 'string' ? raw : undefined
}

/** Stream chunk entry: index first, then id/type/function. */
function toolCallChunkEntry(acc: ToolAccumulator): WireObject {
  return {
    index: acc.seq,
    id: acc.id,
    type: 'function',
    function: { name: acc.name, arguments: acc.parts.length > 0 ? acc.parts.join('') : '{}' },
  }
}

/** Aggregated message entry: no index field on the wire. */
function toolCallMessageEntry(acc: ToolAccumulator): WireObject {
  return {
    id: acc.id,
    type: 'function',
    function: { name: acc.name, arguments: acc.parts.length > 0 ? acc.parts.join('') : '{}' },
  }
}

// ---------------------------------------------------------------------------
// Non-stream aggregation
// ---------------------------------------------------------------------------

/** One decoded `data:` payload with its parse result. */
export interface AggregatedEvent {
  readonly data: string
  readonly value: Record<string, unknown> | undefined
}

/** SSE `data:` payloads may carry one space after the colon. */
function stripOneLeadingSpace(text: string): string {
  return text.startsWith(' ') ? text.slice(1) : text
}

/** Extracts the data lines of an aggregated upstream SSE buffer. */
export function scanDataLines(buffer: string): readonly AggregatedEvent[] {
  const events: AggregatedEvent[] = []
  for (const line of buffer.split('\n')) {
    if (!line.startsWith('data:')) continue
    const data = stripOneLeadingSpace(line.slice(5))
    let value: Record<string, unknown> | undefined
    try {
      const parsed: unknown = JSON.parse(data)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        value = parsed as Record<string, unknown>
      }
    } catch {
      value = undefined
    }
    events.push({ data, value })
  }
  return events
}

/** Result of the non-stream translation. */
export type ChatNonStreamResult =
  | { readonly kind: 'ok'; readonly body: string; readonly value: WireObject }
  | { readonly kind: 'validation-failed'; readonly message: string }

/**
 * Aggregates an upstream SSE buffer into one `chat.completion` body. The
 * buffer is validated first (S2d3 section 5.3); violations surface with the
 * pinned messages.
 */
export function translateClaudeBufferToChatCompletion(
  buffer: string,
  ctx: ClaudeToChatContext,
): ChatNonStreamResult {
  const validation = validateClaudeAggregatedStream(buffer)
  if (!validation.ok) return { kind: 'validation-failed', message: validation.message }

  const events = scanDataLines(buffer)
  const now = ctx.nowSeconds ?? defaultNow
  const usage = emptyUsage()

  let id = ''
  let created = 0
  let model = ''
  let content = ''
  let reasoning = ''
  let finishReason = 'stop'
  const tools = new Map<number, ToolAccumulator>()
  let nextToolSeq = 0

  for (const event of events) {
    const value = event.value
    if (value === undefined) continue
    const type = value['type']
    if (type === 'message_start') {
      id = readMessageField(value, 'id') ?? ''
      const reportedModel = readMessageField(value, 'model')
      if (reportedModel !== undefined && reportedModel.length > 0) model = reportedModel
      created = now()
      mergeUsage(usage, (value['message'] as Record<string, unknown> | undefined)?.['usage'])
    } else if (type === 'content_block_start') {
      const block = value['content_block']
      if (isToolUse(block)) {
        const index = value['index']
        if (typeof index === 'number') {
          const record = block as Record<string, unknown>
          tools.set(index, {
            seq: nextToolSeq++,
            id: typeof record['id'] === 'string' ? record['id'] : '',
            name: typeof record['name'] === 'string' ? record['name'] : '',
            parts: [],
          })
        }
      }
    } else if (type === 'content_block_delta') {
      const delta = value['delta']
      if (typeof delta !== 'object' || delta === null) continue
      const record = delta as Record<string, unknown>
      const kind = record['type']
      if (kind === 'text_delta' && typeof record['text'] === 'string') {
        content += record['text']
      } else if (kind === 'thinking_delta' && typeof record['thinking'] === 'string') {
        reasoning += record['thinking']
      } else if (kind === 'input_json_delta') {
        const index = value['index']
        const acc = typeof index === 'number' ? tools.get(index) : undefined
        if (acc !== undefined && typeof record['partial_json'] === 'string') acc.parts.push(record['partial_json'])
      }
    } else if (type === 'message_delta') {
      const delta = value['delta']
      if (typeof delta === 'object' && delta !== null) {
        const stop = (delta as Record<string, unknown>)['stop_reason']
        if (typeof stop === 'string') finishReason = mapStopReason(stop)
      }
      mergeUsage(usage, value['usage'])
    }
  }

  const message: WireObject = { role: 'assistant', content }
  if (reasoning.length > 0) message['reasoning_content'] = reasoning
  if (tools.size > 0) {
    message['tool_calls'] = [...tools.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([, acc]) => toolCallMessageEntry(acc))
    finishReason = 'tool_calls'
  }

  const completion: WireObject = {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: usage.seen ? usageObject(usage) : zeroUsageObject(),
  }
  return { kind: 'ok', body: serializeOrdered(completion), value: completion }
}

function isToolUse(block: unknown): boolean {
  if (typeof block !== 'object' || block === null) return false
  return (block as Record<string, unknown>)['type'] === 'tool_use'
}

export function defaultNow(): number {
  return Math.floor(Date.now() / 1000)
}

// ---------------------------------------------------------------------------
// Aggregation validation (non-stream clients only)
// ---------------------------------------------------------------------------

export type AggregatedStreamValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string }

export const MESSAGE_MALFORMED_STREAM = 'claude executor: upstream returned malformed stream data'
export const MESSAGE_EMPTY_STREAM = 'claude executor: upstream returned empty stream response'
export const MESSAGE_MISSING_MESSAGE_START = 'claude executor: upstream stream response is missing message_start'
export const MESSAGE_START_MISSING_ID_OR_MODEL = 'claude executor: upstream stream message_start is missing id or model'
export const MESSAGE_ENDED_BEFORE_COMPLETION = 'claude executor: upstream stream response ended before message completion'
export const UNKNOWN_UPSTREAM_ERROR = 'unknown upstream error'

/**
 * Validation contract for aggregated buffers (S2d3 section 5.3). Evaluation
 * order: any data line at all, then well-formed JSON, then an in-stream
 * error event, then message_start presence/id+model, then message_delta.
 * The stream path performs none of these checks.
 */
export function validateClaudeAggregatedStream(buffer: string): AggregatedStreamValidation {
  const events = scanDataLines(buffer)
  if (events.length === 0) return { ok: false, message: MESSAGE_EMPTY_STREAM }
  for (const event of events) {
    if (event.value === undefined) return { ok: false, message: MESSAGE_MALFORMED_STREAM }
  }
  let sawMessageStart = false
  let startComplete = false
  let sawMessageDelta = false
  for (const event of events) {
    const value = event.value
    if (value === undefined) continue
    const type = value['type']
    if (type === 'error') {
      const error = value['error']
      const record = typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : {}
      const message = record['message']
      if (typeof message === 'string' && message.length > 0) {
        return { ok: false, message: `claude executor: upstream returned error event: ${message}` }
      }
      const errorType = record['type']
      if (typeof errorType === 'string' && errorType.length > 0) {
        return { ok: false, message: `claude executor: upstream returned error event: ${errorType}` }
      }
      return { ok: false, message: `claude executor: upstream returned error event: ${UNKNOWN_UPSTREAM_ERROR}` }
    }
    if (type === 'message_start') {
      sawMessageStart = true
      const id = readMessageField(value, 'id')
      const model = readMessageField(value, 'model')
      if (id !== undefined && id.length > 0 && model !== undefined && model.length > 0) {
        startComplete = true
      }
    }
    if (type === 'message_delta') sawMessageDelta = true
  }
  if (!sawMessageStart) return { ok: false, message: MESSAGE_MISSING_MESSAGE_START }
  if (!startComplete) return { ok: false, message: MESSAGE_START_MISSING_ID_OR_MODEL }
  if (!sawMessageDelta) return { ok: false, message: MESSAGE_ENDED_BEFORE_COMPLETION }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Stream translation
// ---------------------------------------------------------------------------

/**
 * Per-request state for the stream translation. Feed each decoded upstream
 * data line through {@link translateDataLine}; each call returns zero or
 * more downstream chunk JSON strings, strictly in upstream event order.
 */
export class ClaudeStreamChunkTranslator {
  private readonly model: string
  private readonly now: () => number
  private id = ''
  private created = 0
  private usage = emptyUsage()
  private tools = new Map<number, ToolAccumulator>()
  private nextToolSeq = 0
  private trailingSent = false

  constructor(ctx: ClaudeToChatContext) {
    this.model = ctx.streamModel
    this.now = ctx.nowSeconds ?? defaultNow
  }

  private chunkBase(): WireObject {
    return {
      id: this.id,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
    }
  }

  /** Translates one decoded upstream data line. */
  translateDataLine(data: string): readonly string[] {
    let value: Record<string, unknown> | undefined
    try {
      const parsed: unknown = JSON.parse(data)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        value = parsed as Record<string, unknown>
      }
    } catch {
      return []
    }
    if (value === undefined) return []
    const type = value['type']
    if (type === 'message_start') return this.onMessageStart(value)
    if (type === 'content_block_start') return this.onBlockStart(value)
    if (type === 'content_block_delta') return this.onBlockDelta(value)
    if (type === 'content_block_stop') return this.onBlockStop(value)
    if (type === 'message_delta') return this.onMessageDelta(value)
    if (type === 'message_stop') return this.onMessageStop()
    if (type === 'error') return [this.onStreamError(value)]
    return []
  }

  private onMessageStart(value: Record<string, unknown>): readonly string[] {
    this.id = readMessageField(value, 'id') ?? ''
    this.created = this.now()
    const message = value['message']
    mergeUsage(this.usage, typeof message === 'object' && message !== null ? (message as Record<string, unknown>)['usage'] : undefined)
    const chunk = this.chunkBase()
    chunk['choices'] = [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
    return [serializeOrdered(chunk)]
  }

  /** content_block_start: no output; tool_use blocks open an accumulator. */
  private onBlockStart(value: Record<string, unknown>): readonly string[] {
    const block = value['content_block']
    if (!isToolUse(block)) return []
    const index = value['index']
    if (typeof index !== 'number') return []
    const record = block as Record<string, unknown>
    this.tools.set(index, {
      seq: this.nextToolSeq++,
      id: typeof record['id'] === 'string' ? record['id'] : '',
      name: typeof record['name'] === 'string' ? record['name'] : '',
      parts: [],
    })
    return []
  }

  private onBlockDelta(value: Record<string, unknown>): readonly string[] {
    const delta = value['delta']
    if (typeof delta !== 'object' || delta === null) return []
    const record = delta as Record<string, unknown>
    const kind = record['type']
    if (kind === 'text_delta' && typeof record['text'] === 'string') {
      const chunk = this.chunkBase()
      chunk['choices'] = [{ index: 0, delta: { content: record['text'] }, finish_reason: null }]
      return [serializeOrdered(chunk)]
    }
    if (kind === 'thinking_delta' && typeof record['thinking'] === 'string') {
      const chunk = this.chunkBase()
      chunk['choices'] = [{ index: 0, delta: { reasoning_content: record['thinking'] }, finish_reason: null }]
      return [serializeOrdered(chunk)]
    }
    if (kind === 'input_json_delta') {
      const index = value['index']
      const acc = typeof index === 'number' ? this.tools.get(index) : undefined
      if (acc !== undefined && typeof record['partial_json'] === 'string') acc.parts.push(record['partial_json'])
    }
    return []
  }

  private onBlockStop(value: Record<string, unknown>): readonly string[] {
    const index = value['index']
    const acc = typeof index === 'number' ? this.tools.get(index) : undefined
    if (acc === undefined) return []
    const chunk = this.chunkBase()
    chunk['choices'] = [
      { index: 0, delta: { tool_calls: [toolCallChunkEntry(acc)] }, finish_reason: null },
    ]
    return [serializeOrdered(chunk)]
  }

  private onMessageDelta(value: Record<string, unknown>): readonly string[] {
    let finish: string | null = null
    const delta = value['delta']
    if (typeof delta === 'object' && delta !== null) {
      const stop = (delta as Record<string, unknown>)['stop_reason']
      if (typeof stop === 'string') finish = mapStopReason(stop)
    }
    // Usage is attached to THIS chunk only when the event carries it
    // (S2d3 section 3.2); earlier usage still merges into the tracker.
    const carriesUsage = typeof value['usage'] === 'object' && value['usage'] !== null
    mergeUsage(this.usage, value['usage'])
    const chunk = this.chunkBase()
    chunk['choices'] = [{ index: 0, delta: {}, finish_reason: finish }]
    if (carriesUsage) chunk['usage'] = usageObject(this.usage)
    return [serializeOrdered(chunk)]
  }

  private onMessageStop(): readonly string[] {
    if (!this.usage.seen || this.trailingSent) return []
    this.trailingSent = true
    const chunk = this.chunkBase()
    chunk['choices'] = []
    chunk['usage'] = usageObject(this.usage)
    return [serializeOrdered(chunk)]
  }

  private onStreamError(value: Record<string, unknown>): string {
    const error = value['error']
    const record = typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : {}
    const message = typeof record['message'] === 'string' ? record['message'] : ''
    const type = typeof record['type'] === 'string' ? record['type'] : ''
    return serializeOrdered({ error: { message, type } })
  }
}
