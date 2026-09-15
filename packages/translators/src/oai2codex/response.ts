/**
 * Response translation: Codex (Responses API) -> OpenAI chat.
 *
 * Both downstream modes consume upstream SSE: stream clients get one
 * `chat.completion.chunk` per translated event (section 2.6), non-stream
 * clients get the whole body aggregated - item collection, output patch,
 * usage capture - and rendered as a single `chat.completion` (sections
 * 2.4-2.5). Usage mapping (section 2.7) and the finish matrix (2.8) are
 * shared.
 */
import { codexTerminalFailureBody, codexTerminalFailureStatus, emptyIncompleteBody, incompleteStreamBody } from './errors'
import { serializeOrdered, wireObject } from './json'
import { scanDataLines } from './sse'
import { restoreToolName } from './tools'
import type { CodexToChatContext, WireObject } from './types'

function readRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function readString(value: unknown, key: string): string | undefined {
  const record = readRecord(value)
  if (record === undefined) return undefined
  const raw = record[key]
  return typeof raw === 'string' ? raw : undefined
}

function readNumber(value: unknown, key: string): number | undefined {
  const record = readRecord(value)
  if (record === undefined) return undefined
  const raw = record[key]
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined
}

function readArrayValue(value: unknown, key: string): readonly unknown[] | undefined {
  const record = readRecord(value)
  if (record === undefined) return undefined
  const raw = record[key]
  return Array.isArray(raw) ? raw : undefined
}

// ---------------------------------------------------------------------------
// Usage mapping (S2d5 2.7)
// ---------------------------------------------------------------------------

/**
 * Maps one upstream `response.usage` object to the downstream shape, in the
 * exact wire key order: completion, total, prompt, then
 * prompt_tokens_details (cached_tokens, cache_write_tokens AND its
 * cached_creation_tokens duplicate - integers only), then
 * completion_tokens_details (reasoning_tokens). Returns `undefined` when the
 * source is not a usage object.
 */
export function codexUsageObject(usage: unknown): WireObject | undefined {
  const record = readRecord(usage)
  if (record === undefined) return undefined
  const out: WireObject = {}
  const outputTokens = readNumber(record, 'output_tokens')
  if (outputTokens !== undefined) out['completion_tokens'] = outputTokens
  const totalTokens = readNumber(record, 'total_tokens')
  if (totalTokens !== undefined) out['total_tokens'] = totalTokens
  const inputTokens = readNumber(record, 'input_tokens')
  if (inputTokens !== undefined) out['prompt_tokens'] = inputTokens

  const inputDetails = readRecord(record['input_tokens_details'])
  if (inputDetails !== undefined) {
    const details: WireObject = {}
    const cached = readNumber(inputDetails, 'cached_tokens')
    if (cached !== undefined) details['cached_tokens'] = cached
    const cacheWrite = inputDetails['cache_write_tokens']
    if (typeof cacheWrite === 'number' && Number.isInteger(cacheWrite)) {
      details['cache_write_tokens'] = cacheWrite
      details['cached_creation_tokens'] = cacheWrite
    }
    if (Object.keys(details).length > 0) out['prompt_tokens_details'] = details
  }

  const outputDetails = readRecord(record['output_tokens_details'])
  if (outputDetails !== undefined) {
    const reasoning = readNumber(outputDetails, 'reasoning_tokens')
    if (reasoning !== undefined) out['completion_tokens_details'] = { reasoning_tokens: reasoning }
  }
  return out
}

/** Non-empty `response.service_tier` of an event's response object, trimmed. */
export function serviceTierOf(response: unknown): string | undefined {
  const tier = readString(response, 'service_tier')
  if (tier === undefined) return undefined
  const trimmed = tier.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/** MIME type of an image item's `output_format` (S2d5 2.5). */
export function imageMimeType(outputFormat: string | undefined): string {
  const format = outputFormat ?? ''
  if (format === 'png') return 'image/png'
  if (format === 'jpg' || format === 'jpeg') return 'image/jpeg'
  if (format === 'webp') return 'image/webp'
  if (format === 'gif') return 'image/gif'
  if (format.includes('/')) return format
  return 'image/png'
}

/** Finish-reason mapping for `incomplete` terminals (S2d5 2.8). */
export function incompleteFinishReason(reason: string | undefined): string {
  if (reason === 'max_tokens' || reason === 'max_output_tokens') return 'length'
  if (reason === 'content_filter') return 'content_filter'
  return 'stop'
}

// ---------------------------------------------------------------------------
// Stream translation (S2d5 2.6)
// ---------------------------------------------------------------------------

/** Result of translating one upstream data line. */
export type CodexStreamLineResult =
  | { readonly kind: 'frames'; readonly frames: readonly string[] }
  /** Terminal reached; the read loop stops. `frames` may hold the terminal chunk. */
  | { readonly kind: 'stop'; readonly frames: readonly string[] }
  /** `response.done` alias: terminal switch stops, NO chunk is emitted. */
  | { readonly kind: 'alias-stop' }
  /** Terminal failure event: pre-commit or in-stream, decided by the pipeline. */
  | { readonly kind: 'failure'; readonly status: number; readonly body: string }
  /** `response.incomplete` with zero output (E6). */
  | { readonly kind: 'empty-incomplete' }

interface ToolState {
  index: number
  id: string
  name: string
  announced: boolean
  argsStreamed: boolean
  done: boolean
}

/**
 * Per-request state for the stream translation. Feed each decoded upstream
 * data line through {@link translateDataLine}; each call returns the
 * downstream chunk JSON strings for that event, strictly in upstream order.
 */
export class CodexStreamChunkTranslator {
  private readonly model: string
  private readonly nameMap: Readonly<Record<string, string>> | undefined
  private readonly nowSeconds: () => number
  private id = ''
  private created = 0
  private serviceTier: string | undefined
  private toolsById = new Map<string, ToolState>()
  private toolsByIndex = new Map<number, ToolState>()
  private lastTool: ToolState | undefined
  private nextToolSeq = 0
  private toolCallSeen = false
  private sawOutputItem = false
  private sawMeaningfulDelta = false
  private lastImagePayload = new Map<string, string>()

  constructor(ctx: CodexToChatContext) {
    this.model = ctx.streamModel
    this.nameMap = ctx.nameMap
    this.nowSeconds = ctx.nowSeconds ?? defaultNowSeconds
  }

  /** Translates one decoded upstream data line. */
  translateDataLine(data: string): CodexStreamLineResult {
    let value: Record<string, unknown> | undefined
    try {
      const parsed: unknown = JSON.parse(data)
      value = readRecord(parsed)
    } catch {
      return { kind: 'frames', frames: [] }
    }
    if (value === undefined) return { kind: 'frames', frames: [] }
    const type = value['type']
    if (typeof type !== 'string') return { kind: 'frames', frames: [] }

    switch (type) {
      case 'response.created': {
        const response = value['response']
        this.id = readString(response, 'id') ?? ''
        const createdAt = readNumber(response, 'created_at')
        if (createdAt !== undefined) this.created = createdAt
        const reportedModel = readString(response, 'model')
        if (reportedModel !== undefined && reportedModel.length > 0) this.modelEcho = reportedModel
        this.latchServiceTier(response)
        return none()
      }
      case 'response.in_progress':
      case 'response.content_part.added':
      case 'response.content_part.done':
      case 'response.output_text.done':
      case 'response.reasoning_summary_part.added':
      case 'response.reasoning_summary_part.done':
        return none()
      case 'response.output_item.added':
        return this.onItemAdded(value)
      case 'response.output_text.delta': {
        const delta = value['delta']
        if (typeof delta !== 'string') return none()
        if (delta.trim().length > 0) this.sawMeaningfulDelta = true
        return this.chunk({ role: 'assistant', content: delta })
      }
      case 'response.reasoning_text.delta':
      case 'response.reasoning_summary_text.delta': {
        const delta = value['delta']
        if (typeof delta !== 'string') return none()
        if (delta.trim().length > 0) this.sawMeaningfulDelta = true
        return this.chunk({ role: 'assistant', reasoning_content: delta })
      }
      case 'response.reasoning_text.done':
      case 'response.reasoning_summary_text.done':
        return this.chunk({ role: 'assistant', reasoning_content: '\n\n' })
      case 'response.function_call_arguments.delta':
      case 'response.custom_tool_call_input.delta':
        return this.onArgumentsDelta(value)
      case 'response.function_call_arguments.done':
      case 'response.custom_tool_call_input.done':
        return this.onArgumentsDone(value)
      case 'response.output_item.done':
        return this.onItemDone(value)
      case 'response.image_generation_call.partial_image':
        return this.onPartialImage(value)
      case 'response.completed':
        return this.onTerminal(value, 'completed')
      case 'response.incomplete':
        return this.onTerminal(value, 'incomplete')
      case 'response.failed':
      case 'error':
        return { kind: 'failure', status: codexTerminalFailureStatus(data), body: codexTerminalFailureBody(data) }
      case 'response.done':
        return { kind: 'alias-stop' }
      default:
        return none()
    }
  }

  /** True when the empty-incomplete condition (E6) holds. */
  isEmptyIncomplete(response: unknown): boolean {
    if (this.sawOutputItem || this.sawMeaningfulDelta) return false
    const output = readArrayValue(response, 'output')
    if (output !== undefined && output.length > 0) return false
    return zeroOutputTokens(response)
  }

  // -- internals -----------------------------------------------------------

  private modelEcho: string | undefined

  private latchServiceTier(response: unknown): void {
    if (this.serviceTier !== undefined) return
    const tier = serviceTierOf(response)
    if (tier !== undefined) this.serviceTier = tier
  }

  private chunkBase(): WireObject {
    return {
      id: this.id,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.modelEcho ?? this.model,
    }
  }

  private chunk(delta: WireObject, usage?: WireObject): CodexStreamLineResult {
    const chunk = this.chunkBase()
    chunk['choices'] = [{ index: 0, delta, finish_reason: null, native_finish_reason: null }]
    this.attachTail(chunk, usage)
    return { kind: 'frames', frames: [serializeOrdered(chunk)] }
  }

  private attachTail(chunk: WireObject, usage: WireObject | undefined): void {
    if (this.serviceTier !== undefined) chunk['service_tier'] = this.serviceTier
    if (usage !== undefined) chunk['usage'] = usage
  }

  private registerTool(item: Record<string, unknown>, outputIndex: number | undefined, announced: boolean): ToolState {
    const state: ToolState = {
      index: this.nextToolSeq++,
      id: readString(item, 'call_id') ?? readString(item, 'id') ?? '',
      name: readString(item, 'name') ?? '',
      announced,
      argsStreamed: false,
      done: false,
    }
    const itemId = readString(item, 'id')
    if (itemId !== undefined) this.toolsById.set(itemId, state)
    if (outputIndex !== undefined) this.toolsByIndex.set(outputIndex, state)
    this.lastTool = state
    return state
  }

  /**
   * Tool-call state lookup (S2d5 2.6): `item_id` - the event's, or the item
   * id for `output_item.done` events - then the raw `output_index`, then the
   * most recent item. An absent state means the flow skipped `added`.
   */
  private lookupTool(value: Record<string, unknown>, itemId?: string): ToolState | undefined {
    const key = readString(value, 'item_id') ?? itemId
    if (key !== undefined) {
      const byId = this.toolsById.get(key)
      if (byId !== undefined) return byId
    }
    const outputIndex = readNumber(value, 'output_index')
    if (outputIndex !== undefined) {
      const byIndex = this.toolsByIndex.get(outputIndex)
      if (byIndex !== undefined) return byIndex
    }
    return this.lastTool
  }

  private restore(name: string): string {
    return restoreToolName(name, this.nameMap)
  }

  private onItemAdded(value: Record<string, unknown>): CodexStreamLineResult {
    const item = readRecord(value['item'])
    if (item === undefined) return none()
    this.sawOutputItem = true
    const type = item['type']
    if (type !== 'function_call' && type !== 'custom_tool_call') return none()
    const state = this.registerTool(item, readNumber(value, 'output_index'), true)
    this.toolCallSeen = true
    const delta: WireObject = {
      role: 'assistant',
      tool_calls: [
        {
          index: state.index,
          id: state.id,
          type: 'function',
          function: { name: this.restore(state.name), arguments: '' },
        },
      ],
    }
    return this.chunk(delta)
  }

  private onArgumentsDelta(value: Record<string, unknown>): CodexStreamLineResult {
    const state = this.lookupTool(value)
    if (state === undefined || state.done) return none()
    const delta = value['delta']
    if (typeof delta !== 'string' || delta.length === 0) return none()
    this.sawMeaningfulDelta = true
    state.argsStreamed = true
    const entry: WireObject = { index: state.index, function: { arguments: delta } }
    return this.chunk({ tool_calls: [entry] })
  }

  private onArgumentsDone(value: Record<string, unknown>): CodexStreamLineResult {
    const state = this.lookupTool(value)
    if (state === undefined) return none()
    state.done = true
    if (state.argsStreamed) return none()
    const full = readString(value, 'arguments') ?? readString(value, 'input')
    if (full === undefined || full.length === 0) return none()
    const entry: WireObject = { index: state.index, function: { arguments: full } }
    return this.chunk({ tool_calls: [entry] })
  }

  private onItemDone(value: Record<string, unknown>): CodexStreamLineResult {
    const item = readRecord(value['item'])
    if (item === undefined) return none()
    this.sawOutputItem = true
    const type = item['type']
    if (type === 'function_call' || type === 'custom_tool_call') {
      const full = readString(item, 'arguments') ?? readString(item, 'input') ?? ''
      const existing = this.lookupTool(value, readString(item, 'id'))
      if (existing !== undefined && existing.announced) {
        existing.done = true
        if (existing.argsStreamed || full.length === 0) return none()
        const entry: WireObject = { index: existing.index, function: { arguments: full } }
        return this.chunk({ tool_calls: [entry] })
      }
      // Upstream skipped the `added` event: emit one complete chunk.
      const state = this.registerTool(item, readNumber(value, 'output_index'), false)
      this.toolCallSeen = true
      const delta: WireObject = {
        role: 'assistant',
        tool_calls: [
          {
            index: state.index,
            id: state.id,
            type: 'function',
            function: { name: this.restore(state.name), arguments: full },
          },
        ],
      }
      return this.chunk(delta)
    }
    if (type === 'image_generation_call') {
      const result = readString(item, 'result')
      if (result === undefined || result.length === 0) return none()
      return this.imageChunk(readString(item, 'id') ?? '', result, readString(item, 'output_format'))
    }
    return none()
  }

  private onPartialImage(value: Record<string, unknown>): CodexStreamLineResult {
    const b64 = readString(value, 'partial_image_b64')
    if (b64 === undefined || b64.length === 0) return none()
    return this.imageChunk(readString(value, 'item_id') ?? '', b64, readString(value, 'output_format'))
  }

  /** Image chunks always carry `index: 0`; identical consecutive payloads dedup. */
  private imageChunk(itemId: string, payload: string, outputFormat: string | undefined): CodexStreamLineResult {
    const last = this.lastImagePayload.get(itemId)
    if (last === payload) return none()
    this.lastImagePayload.set(itemId, payload)
    const delta: WireObject = {
      role: 'assistant',
      images: [
        {
          index: 0,
          type: 'image_url',
          image_url: { url: `data:${imageMimeType(outputFormat)};base64,${payload}` },
        },
      ],
    }
    return this.chunk(delta)
  }

  private onTerminal(value: Record<string, unknown>, status: 'completed' | 'incomplete'): CodexStreamLineResult {
    const response = value['response']
    if (status === 'incomplete' && this.isEmptyIncomplete(response)) {
      return { kind: 'empty-incomplete' }
    }
    let finish: string
    let native: string
    if (status === 'completed') {
      finish = this.toolCallSeen ? 'tool_calls' : 'stop'
      native = finish
    } else {
      const reason = readString(readRecord(response)?.['incomplete_details'], 'reason')
      native = reason ?? ''
      finish = incompleteFinishReason(reason)
    }
    const usageSource = readRecord(response)?.['usage']
    const usage = usageSource !== undefined ? codexUsageObject(usageSource) : undefined
    this.latchServiceTier(response)
    const chunk = this.chunkBase()
    chunk['choices'] = [{ index: 0, delta: {}, finish_reason: finish, native_finish_reason: native }]
    this.attachTail(chunk, usage)
    return { kind: 'stop', frames: [serializeOrdered(chunk)] }
  }
}

function none(): CodexStreamLineResult {
  return { kind: 'frames', frames: [] }
}

function zeroOutputTokens(response: unknown): boolean {
  return readNumber(readRecord(response)?.['usage'], 'output_tokens') === 0
}

export function defaultNowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

// ---------------------------------------------------------------------------
// Non-stream aggregation (S2d5 2.4 / 2.5)
// ---------------------------------------------------------------------------

/** Result of the non-stream translation. */
export type CodexNonStreamResult =
  | { readonly kind: 'ok'; readonly body: string; readonly value: WireObject }
  | { readonly kind: 'failure'; readonly status: number; readonly body: string }

interface CollectedItem {
  readonly outputIndex: number | undefined
  readonly item: Record<string, unknown>
}

/**
 * Aggregates an upstream SSE body into one `chat.completion`. The whole body
 * is read before anything is written, so failures anywhere surface as
 * pre-commit errors: terminal failure events (E4), the empty-incomplete
 * terminal (E6), or a body that ends without a terminal event (E5, 408).
 */
export function translateCodexBufferToChatCompletion(
  buffer: string,
  ctx: CodexToChatContext,
): CodexNonStreamResult {
  const nameMap = ctx.nameMap
  const collected: CollectedItem[] = []
  const indexless: CollectedItem[] = []
  let sawMeaningfulDelta = false

  for (const data of scanDataLines(buffer)) {
    let value: Record<string, unknown> | undefined
    try {
      value = readRecord(JSON.parse(data))
    } catch {
      value = undefined
    }
    if (value === undefined) continue
    const type = value['type']
    if (type === 'error' || type === 'response.failed') {
      return { kind: 'failure', status: codexTerminalFailureStatus(data), body: codexTerminalFailureBody(data) }
    }
    if (type === 'response.output_item.done') {
      const item = readRecord(value['item'])
      if (item === undefined) continue
      const outputIndex = readNumber(value, 'output_index')
      const entry: CollectedItem = { outputIndex, item }
      if (outputIndex !== undefined) collected.push(entry)
      else indexless.push(entry)
      continue
    }
    if (
      type === 'response.output_text.delta' ||
      type === 'response.reasoning_text.delta' ||
      type === 'response.reasoning_summary_text.delta' ||
      type === 'response.function_call_arguments.delta'
    ) {
      const delta = value['delta']
      if (typeof delta === 'string' && delta.trim().length > 0) sawMeaningfulDelta = true
      continue
    }
    if (type === 'response.completed' || type === 'response.incomplete') {
      const response = readRecord(value['response'])
      if (response === undefined) continue
      if (type === 'response.incomplete' && isEmptyIncompleteAggregate(response, collected, indexless, sawMeaningfulDelta)) {
        return { kind: 'failure', status: 502, body: emptyIncompleteBody() }
      }
      const output = patchOutput(response, collected, indexless)
      const body = renderChatCompletion(response, output, nameMap, ctx)
      return { kind: 'ok', body, value: wireObject(JSON.parse(body)) }
    }
  }
  return { kind: 'failure', status: 408, body: incompleteStreamBody() }
}

/** E6 condition over the aggregated view: no items, no deltas, zero tokens. */
function isEmptyIncompleteAggregate(
  response: Record<string, unknown>,
  collected: readonly CollectedItem[],
  indexless: readonly CollectedItem[],
  sawMeaningfulDelta: boolean,
): boolean {
  if (sawMeaningfulDelta) return false
  if (collected.length > 0 || indexless.length > 0) return false
  const output = readArrayValue(response, 'output')
  if (output !== undefined && output.length > 0) return false
  return readNumber(response['usage'], 'output_tokens') === 0
}

/**
 * Output patch (S2d5 2.4 step 4): a missing/empty `response.output` is
 * replaced by the collected items sorted by `output_index` (indexless items
 * appended); a non-empty output only has missing item ids hydrated from the
 * collected items at the same position.
 */
function patchOutput(
  response: Record<string, unknown>,
  collected: readonly CollectedItem[],
  indexless: readonly CollectedItem[],
): readonly unknown[] {
  const output = readArrayValue(response, 'output')
  if (output === undefined || output.length === 0) {
    if (collected.length === 0 && indexless.length === 0) return output ?? []
    const sorted = [...collected].sort((left, right) => (left.outputIndex ?? 0) - (right.outputIndex ?? 0))
    return [...sorted.map((entry) => entry.item), ...indexless.map((entry) => entry.item)]
  }
  const indexed = [...collected].sort((left, right) => (left.outputIndex ?? 0) - (right.outputIndex ?? 0))
  return output.map((element, position) => {
    const record = readRecord(element)
    if (record === undefined) return element
    const hasId = typeof record['id'] === 'string' && (record['id'] as string).length > 0
    if (hasId) return element
    const source = indexed[position]?.item
    const sourceId = source !== undefined ? readString(source, 'id') : undefined
    if (sourceId === undefined) return element
    return { ...record, id: sourceId }
  })
}

/** Renders the aggregated `chat.completion` (S2d5 2.5). */
function renderChatCompletion(
  response: Record<string, unknown>,
  output: readonly unknown[],
  nameMap: Readonly<Record<string, string>> | undefined,
  ctx: CodexToChatContext,
): string {
  const nowSeconds = ctx.nowSeconds ?? defaultNowSeconds
  const id = readString(response, 'id') ?? ''
  const model = readString(response, 'model') ?? ctx.streamModel
  const createdAt = readNumber(response, 'created_at') ?? nowSeconds()

  let content: string | null = null
  let reasoning: string | null = null
  let sawReasoning = false
  const toolCalls: WireObject[] = []
  const images: WireObject[] = []
  let toolCallItems = 0

  for (const element of output) {
    const item = readRecord(element)
    if (item === undefined) continue
    const type = item['type']
    if (type === 'message') {
      // Only the FIRST content part of each message item is taken.
      const partRecord = readRecord((readArrayValue(item, 'content') ?? [])[0])
      if (partRecord !== undefined && partRecord['type'] === 'output_text') {
        content = (content ?? '') + (readString(partRecord, 'text') ?? '')
      }
      continue
    }
    if (type === 'reasoning') {
      const summary = readArrayValue(item, 'summary') ?? []
      for (const entry of summary) {
        const summaryRecord = readRecord(entry)
        if (summaryRecord === undefined) continue
        if (summaryRecord['type'] === 'summary_text') {
          reasoning = (reasoning ?? '') + (readString(summaryRecord, 'text') ?? '')
          sawReasoning = true
          break
        }
      }
      for (const entry of readArrayValue(item, 'content') ?? []) {
        const contentRecord = readRecord(entry)
        if (contentRecord === undefined) continue
        if (contentRecord['type'] === 'reasoning_text') {
          reasoning = (reasoning ?? '') + (readString(contentRecord, 'text') ?? '')
          sawReasoning = true
        }
      }
      continue
    }
    if (type === 'function_call' || type === 'custom_tool_call') {
      toolCallItems += 1
      toolCalls.push({
        id: readString(item, 'call_id') ?? '',
        type: 'function',
        function: {
          name: restoreToolName(readString(item, 'name') ?? '', nameMap),
          arguments: readString(item, 'arguments') ?? readString(item, 'input') ?? '',
        },
      })
      continue
    }
    if (type === 'image_generation_call') {
      const result = readString(item, 'result')
      if (result === undefined || result.length === 0) continue
      images.push({
        index: images.length,
        type: 'image_url',
        image_url: { url: `data:${imageMimeType(readString(item, 'output_format'))};base64,${result}` },
      })
    }
  }

  const message: WireObject = {
    role: 'assistant',
    content,
    reasoning_content: sawReasoning ? reasoning : null,
    tool_calls: toolCalls.length > 0 ? toolCalls : null,
  }
  if (images.length > 0) message['images'] = images

  const status = readString(response, 'status')
  let finish: string
  let native: string
  if (status === 'incomplete') {
    const reason = readString(readRecord(response['incomplete_details']), 'reason')
    native = reason ?? ''
    finish = incompleteFinishReason(reason)
  } else {
    finish = toolCallItems > 0 ? 'tool_calls' : 'stop'
    native = finish
  }

  const completion: WireObject = {
    id,
    object: 'chat.completion',
    created: createdAt,
    model,
    choices: [{ index: 0, message, finish_reason: finish, native_finish_reason: native }],
  }
  const tier = serviceTierOf(response)
  if (tier !== undefined) completion['service_tier'] = tier
  const usage = codexUsageObject(response['usage'])
  if (usage !== undefined) completion['usage'] = usage
  return serializeOrdered(completion)
}
