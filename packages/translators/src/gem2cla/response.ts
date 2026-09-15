/**
 * Response translation: Claude (Anthropic Messages SSE) -> Gemini.
 *
 * The Claude upstream is always streamed, so both downstream modes consume
 * SSE events: stream clients get one Gemini chunk per translated upstream
 * event (`alt=sse` framing or raw concatenation), non-stream clients get
 * the aggregated buffer validated first (502 family, S2d7 5.2) and rendered
 * as one Gemini JSON object.
 *
 * Byte-exact pins reproduced here:
 * - chunk skeleton order `candidates, usageMetadata, modelVersion,
 *   createTime, responseId`; `finishReason` sits inside `candidates[0]`;
 * - `finishReason` is ALWAYS "STOP" (the stop_reason mapping is dead code);
 * - `promptTokenCount` reads only `message_delta.usage.input_tokens`;
 * - tool arguments are spliced RAW and, when the spliced bytes are invalid
 *   JSON, later structured writes on the same chunk degrade to root-level
 *   appends (stream: finishReason after responseId; non-stream: a second
 *   root-level usageMetadata);
 * - empty/unknown deltas emit ONE empty-parts chunk; `input_json_delta`
 *   emits nothing (accumulates silently).
 */
import { isPlainObject, isValidJson, readObject, readString, serializeOrdered } from './json'
import { RawJson } from './json'
import type { WireObject } from './types'
import type { ClaudeToGeminiContext } from './types'

/** Traffic-type literal stamped into every usageMetadata block. */
export const TRAFFIC_TYPE = 'PROVISIONED_THROUGHPUT'

// ---------------------------------------------------------------------------
// Aggregation validation (non-stream clients only, S2d7 5.2)
// ---------------------------------------------------------------------------

export const MESSAGE_EMPTY_STREAM = 'claude executor: upstream returned empty stream response'
export const MESSAGE_MISSING_MESSAGE_START = 'claude executor: upstream stream response is missing message_start'
export const MESSAGE_ENDED_BEFORE_COMPLETION = 'claude executor: upstream stream response ended before message completion'
export const MESSAGE_MALFORMED_STREAM = 'claude executor: upstream returned malformed stream data'
export const MESSAGE_START_MISSING_ID_OR_MODEL = 'claude executor: upstream stream message_start is missing id or model'
export const MESSAGE_ERROR_EVENT_PREFIX = 'claude executor: upstream returned error event: '
export const UNKNOWN_UPSTREAM_ERROR = 'unknown upstream error'

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
      if (isPlainObject(parsed)) value = parsed
    } catch {
      value = undefined
    }
    events.push({ data, value })
  }
  return events
}

export type AggregatedStreamValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string }

/**
 * Validation contract for aggregated buffers (S2d7 5.2). Per line, in order:
 * each non-skipped `data:` payload short-circuits on invalid JSON, then an
 * `error` event, then an incomplete `message_start`. When the scan
 * completes, the post-loop gates fire in order: zero payloads, no
 * message_start, no message_delta. Empty payloads and the literal `[DONE]`
 * are skipped. The stream client path performs none of these checks.
 */
export function validateClaudeAggregatedStream(buffer: string): AggregatedStreamValidation {
  const events = scanDataLines(buffer)
  let payloadCount = 0
  let sawMessageStart = false
  let sawMessageDelta = false
  for (const event of events) {
    if (event.data.length === 0 || event.data === '[DONE]') continue
    payloadCount += 1
    if (event.value === undefined) return { ok: false, message: MESSAGE_MALFORMED_STREAM }
    const value = event.value
    const type = value['type']
    if (type === 'error') return { ok: false, message: errorEventValidationMessage(value) }
    if (type === 'message_start') {
      sawMessageStart = true
      const message = readObject(value, 'message')
      const id = message !== undefined ? readString(message, 'id') : undefined
      const model = message !== undefined ? readString(message, 'model') : undefined
      if (id === undefined || id.length === 0 || model === undefined || model.length === 0) {
        return { ok: false, message: MESSAGE_START_MISSING_ID_OR_MODEL }
      }
    }
    if (type === 'message_delta') sawMessageDelta = true
  }
  if (payloadCount === 0) return { ok: false, message: MESSAGE_EMPTY_STREAM }
  if (!sawMessageStart) return { ok: false, message: MESSAGE_MISSING_MESSAGE_START }
  if (!sawMessageDelta) return { ok: false, message: MESSAGE_ENDED_BEFORE_COMPLETION }
  return { ok: true }
}

/** `upstream returned error event: <msg>` with the three-step fallback. */
function errorEventValidationMessage(value: Record<string, unknown>): string {
  const error = readObject(value, 'error')
  const message = error !== undefined ? readString(error, 'message') : undefined
  if (message !== undefined && message.length > 0) return MESSAGE_ERROR_EVENT_PREFIX + message
  const errorType = error !== undefined ? readString(error, 'type') : undefined
  if (errorType !== undefined && errorType.length > 0) return MESSAGE_ERROR_EVENT_PREFIX + errorType
  return MESSAGE_ERROR_EVENT_PREFIX + UNKNOWN_UPSTREAM_ERROR
}

// ---------------------------------------------------------------------------
// Usage helpers
// ---------------------------------------------------------------------------

function readNumber(value: Record<string, unknown>, key: string): number | undefined {
  const raw = value[key]
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined
}

/**
 * `cachedContentTokenCount`: `cache_creation_input_tokens`, replaced by
 * creation + read when `cache_read_input_tokens` is present.
 */
function cachedTokenCount(usage: Record<string, unknown>): number | undefined {
  const creation = readNumber(usage, 'cache_creation_input_tokens')
  const read = readNumber(usage, 'cache_read_input_tokens')
  if (read !== undefined) return (creation ?? 0) + read
  return creation
}

/** Stream-chunk usageMetadata: trafficType FIRST, then the counts. */
function streamUsageMetadata(usage: Record<string, unknown> | undefined): WireObject {
  const out: WireObject = { trafficType: TRAFFIC_TYPE }
  if (usage === undefined) return out
  const input = readNumber(usage, 'input_tokens') ?? 0
  const output = readNumber(usage, 'output_tokens') ?? 0
  out['promptTokenCount'] = input
  out['candidatesTokenCount'] = output
  out['totalTokenCount'] = input + output
  const cached = cachedTokenCount(usage)
  if (cached !== undefined) out['cachedContentTokenCount'] = cached
  const thoughts = readNumber(usage, 'thinking_tokens')
  if (thoughts !== undefined) out['thoughtsTokenCount'] = thoughts
  return out
}

/** Non-stream usageMetadata: the counts first, trafficType LAST. */
function aggregatedUsageMetadata(usage: Record<string, unknown>): WireObject {
  const input = readNumber(usage, 'input_tokens') ?? 0
  const output = readNumber(usage, 'output_tokens') ?? 0
  const out: WireObject = {
    promptTokenCount: input,
    candidatesTokenCount: output,
    totalTokenCount: input + output,
  }
  const cached = cachedTokenCount(usage)
  if (cached !== undefined) out['cachedContentTokenCount'] = cached
  const thoughts = readNumber(usage, 'thinking_tokens')
  if (thoughts !== undefined) out['thoughtsTokenCount'] = thoughts
  out['trafficType'] = TRAFFIC_TYPE
  return out
}

// ---------------------------------------------------------------------------
// Timestamps
// ---------------------------------------------------------------------------

/**
 * RFC3339 with second precision and a numeric zone offset, e.g.
 * `2026-09-16T01:04:46+08:00` - the sub-second part is dropped entirely.
 */
export function formatRfc3339Seconds(epochMs: number): string {
  const date = new Date(epochMs)
  const offsetMinutes = -date.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const absolute = Math.abs(offsetMinutes)
  const pad = (value: number): string => String(value).padStart(2, '0')
  const dateText = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  const timeText = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  const offsetText = `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`
  return `${dateText}T${timeText}${offsetText}`
}

// ---------------------------------------------------------------------------
// Tool accumulators
// ---------------------------------------------------------------------------

interface ToolAccumulator {
  readonly name: string
  readonly id: string | undefined
  parts: string[]
}

function toolAccumulator(block: Record<string, unknown>): ToolAccumulator {
  const id = readString(block, 'id')
  return { name: readString(block, 'name') ?? '', id, parts: [] }
}

/** Joins and trims the accumulated fragments; empty runs default to `{}`. */
function assembledToolArgs(acc: ToolAccumulator): { readonly text: string; readonly valid: boolean } {
  const trimmed = acc.parts.join('').trim()
  const text = trimmed.length > 0 ? trimmed : '{}'
  return { text, valid: isValidJson(text) }
}

/**
 * Ordered functionCall part. With VALID spliced args the id lands inside
 * `functionCall` (name, args, id). Corrupt args shift every later write
 * one level out: the id lands on the part, next to `functionCall`
 * (recorded: S2d7-13 frame 1 and S2d7-21).
 */
function functionCallPart(acc: ToolAccumulator, argsValid: boolean): WireObject {
  const { text } = assembledToolArgs(acc)
  const functionCall: WireObject = { name: acc.name, args: new RawJson(text) }
  if (argsValid) {
    if (acc.id !== undefined) functionCall['id'] = acc.id
    return { functionCall }
  }
  const part: WireObject = { functionCall }
  if (acc.id !== undefined) part['id'] = acc.id
  return part
}

function isToolUseBlock(block: unknown): boolean {
  return isPlainObject(block) && block['type'] === 'tool_use'
}

// ---------------------------------------------------------------------------
// Stream translation (one chunk per translated upstream event)
// ---------------------------------------------------------------------------

/**
 * Per-request state for the stream translation. Feed each decoded upstream
 * data line through {@link translateDataLine}; each call returns zero or
 * more downstream chunk JSON strings, strictly in upstream event order.
 */
export class ClaudeToGeminiStreamTranslator {
  private readonly now: () => number
  private id = ''
  private model = ''
  private createTime: string | undefined
  private tools = new Map<number, ToolAccumulator>()

  constructor(ctx: ClaudeToGeminiContext) {
    this.now = ctx.now ?? (() => Date.now())
  }

  /** Samples the wall-clock timestamp once per request (second precision). */
  private timestamp(): string {
    if (this.createTime === undefined) this.createTime = formatRfc3339Seconds(this.now())
    return this.createTime
  }

  /** Translates one decoded upstream data line into chunk payloads. */
  translateDataLine(data: string): readonly string[] {
    let value: Record<string, unknown> | undefined
    try {
      const parsed: unknown = JSON.parse(data)
      if (isPlainObject(parsed)) value = parsed
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
    if (type === 'error') return [inStreamErrorChunk(value)]
    return []
  }

  /**
   * message_start carries the response id and the model echoed upstream
   * (stream chunks read `modelVersion` from it, not from the resolved
   * name); absent values keep the literal empty-string defaults.
   */
  private onMessageStart(value: Record<string, unknown>): readonly string[] {
    const message = readObject(value, 'message')
    this.id = message !== undefined ? (readString(message, 'id') ?? '') : ''
    this.model = message !== undefined ? (readString(message, 'model') ?? '') : ''
    this.timestamp()
    return []
  }

  private onBlockStart(value: Record<string, unknown>): readonly string[] {
    const block = readObject(value, 'content_block')
    if (block === undefined || !isToolUseBlock(block)) return []
    const index = value['index']
    if (typeof index !== 'number') return []
    this.tools.set(index, toolAccumulator(block))
    return []
  }

  private onBlockDelta(value: Record<string, unknown>): readonly string[] {
    const index = value['index']
    const delta = readObject(value, 'delta')
    if (delta === undefined) return [this.chunk([])]
    const kind = delta['type']
    if (kind === 'input_json_delta') {
      // The only delta that never emits: fragments accumulate by index.
      const partial = readString(delta, 'partial_json')
      if (typeof index === 'number' && partial !== undefined) {
        const acc = this.tools.get(index)
        if (acc !== undefined) acc.parts.push(partial)
      }
      return []
    }
    if (kind === 'text_delta') {
      const text = readString(delta, 'text')
      return [this.chunk(text !== undefined && text.length > 0 ? [{ text }] : [])]
    }
    if (kind === 'thinking_delta') {
      const thinking = readString(delta, 'thinking')
      return [
        this.chunk(thinking !== undefined && thinking.length > 0 ? [{ thought: true, text: thinking }] : []),
      ]
    }
    if (kind === 'signature_delta') {
      const signature = readString(delta, 'signature')
      return [
        this.chunk(
          signature !== undefined && signature.length > 0
            ? [{ thought: true, thoughtSignature: signature }]
            : [],
        ),
      ]
    }
    // Unknown delta payloads still emit one empty-parts chunk.
    return [this.chunk([])]
  }

  /**
   * A completed tool_use block emits the assembled functionCall chunk and
   * carries `finishReason` on the same chunk. With VALID spliced args the
   * marker lands inside `candidates[0]`; invalid args corrupt the chunk and
   * the write degrades to a root-level append after `responseId`.
   */
  private onBlockStop(value: Record<string, unknown>): readonly string[] {
    const index = value['index']
    if (typeof index !== 'number') return []
    const acc = this.tools.get(index)
    if (acc === undefined) return []
    const { valid } = assembledToolArgs(acc)
    if (valid) return [this.chunk([functionCallPart(acc, true)], 'STOP')]
    const base = this.chunk([functionCallPart(acc, false)])
    return [base.slice(0, -1) + ',"finishReason":"STOP"}']
  }

  /**
   * message_delta emits the terminal STOP chunk regardless of the upstream
   * stop_reason (the mapping is dead code for this pair). A message_delta
   * without a usage object keeps the trafficType-only usageMetadata.
   */
  private onMessageDelta(value: Record<string, unknown>): readonly string[] {
    const usage = readObject(value, 'usage')
    const candidate: WireObject = { content: { role: 'model', parts: [] }, finishReason: 'STOP' }
    const chunk: WireObject = {
      candidates: [candidate],
      usageMetadata: streamUsageMetadata(usage),
      modelVersion: this.model,
      createTime: this.timestamp(),
      responseId: this.id,
    }
    return [serializeOrdered(chunk)]
  }

  /** Chunk skeleton: candidates, usageMetadata, modelVersion, createTime, responseId. */
  private chunk(parts: readonly WireObject[], finishReason?: string): string {
    const candidate: WireObject = { content: { role: 'model', parts: [...parts] } }
    if (finishReason !== undefined) candidate['finishReason'] = finishReason
    const chunk: WireObject = {
      candidates: [candidate],
      usageMetadata: { trafficType: TRAFFIC_TYPE },
      modelVersion: this.model,
      createTime: this.timestamp(),
      responseId: this.id,
    }
    return serializeOrdered(chunk)
  }
}

/**
 * In-stream `error` events translate to a normal data frame with a
 * Gemini-shaped error object - fixed code 400 / INVALID_ARGUMENT
 * regardless of the upstream error type.
 */
export function inStreamErrorChunk(value: Record<string, unknown>): string {
  const error = readObject(value, 'error')
  const message = error !== undefined ? readString(error, 'message') : undefined
  const text = message !== undefined && message.length > 0 ? message : 'Unknown error occurred'
  return serializeOrdered({ error: { code: 400, message: text, status: 'INVALID_ARGUMENT' } })
}

// ---------------------------------------------------------------------------
// Non-stream aggregation
// ---------------------------------------------------------------------------

export type GeminiNonStreamResult =
  | { readonly kind: 'ok'; readonly body: string }
  | { readonly kind: 'validation-failed'; readonly message: string }

/**
 * Aggregates an upstream SSE buffer into one Gemini response body. The
 * buffer is validated first (502 family); violations surface with the
 * pinned messages. `modelVersion` is the gateway-resolved model name.
 */
export function translateClaudeBufferToGemini(buffer: string, ctx: ClaudeToGeminiContext): GeminiNonStreamResult {
  const validation = validateClaudeAggregatedStream(buffer)
  if (!validation.ok) return { kind: 'validation-failed', message: validation.message }

  const now = ctx.now ?? (() => Date.now())
  const events = scanDataLines(buffer)
  const parts: WireObject[] = []
  const tools = new Map<number, ToolAccumulator>()
  let id = ''
  let usage: Record<string, unknown> | undefined
  let corrupted = false

  for (const event of events) {
    const value = event.value
    if (value === undefined) continue
    const type = value['type']
    if (type === 'message_start') {
      const message = readObject(value, 'message')
      id = message !== undefined ? (readString(message, 'id') ?? '') : ''
    } else if (type === 'content_block_start') {
      const block = readObject(value, 'content_block')
      const index = value['index']
      if (block !== undefined && isToolUseBlock(block) && typeof index === 'number') {
        tools.set(index, toolAccumulator(block))
      }
    } else if (type === 'content_block_delta') {
      const index = value['index']
      const delta = readObject(value, 'delta')
      if (delta === undefined) continue
      const kind = delta['type']
      if (kind === 'text_delta') {
        const text = readString(delta, 'text')
        if (text !== undefined && text.length > 0) parts.push({ text })
      } else if (kind === 'thinking_delta') {
        const thinking = readString(delta, 'thinking')
        if (thinking !== undefined && thinking.length > 0) parts.push({ thought: true, text: thinking })
      } else if (kind === 'signature_delta') {
        const signature = readString(delta, 'signature')
        if (signature !== undefined && signature.length > 0) {
          parts.push({ thought: true, thoughtSignature: signature })
        }
      } else if (kind === 'input_json_delta') {
        const partial = readString(delta, 'partial_json')
        if (typeof index === 'number' && partial !== undefined) {
          const acc = tools.get(index)
          if (acc !== undefined) acc.parts.push(partial)
        }
      }
    } else if (type === 'content_block_stop') {
      const index = value['index']
      if (typeof index !== 'number') continue
      const acc = tools.get(index)
      if (acc === undefined) continue
      const { valid } = assembledToolArgs(acc)
      if (!valid) corrupted = true
      parts.push(functionCallPart(acc, valid))
    } else if (type === 'message_delta') {
      const eventUsage = readObject(value, 'usage')
      if (eventUsage !== undefined) usage = eventUsage
    }
  }

  const merged = consolidateParts(parts)
  const candidate: WireObject = { content: { role: 'model', parts: merged }, finishReason: 'STOP' }
  const body: WireObject = {
    candidates: [candidate],
    usageMetadata: { trafficType: TRAFFIC_TYPE },
    modelVersion: ctx.resolvedModel,
    createTime: formatRfc3339Seconds(now()),
    responseId: id,
  }
  let out = serializeOrdered(body)
  if (usage !== undefined) {
    const counts = aggregatedUsageMetadata(usage)
    if (!corrupted) {
      body['usageMetadata'] = counts
      out = serializeOrdered(body)
    } else {
      // Corrupted splices turn the usage replacement into a root-level
      // append: the skeleton's trafficType-only block stays in place.
      out = out.slice(0, -1) + ',"usageMetadata":' + serializeOrdered(counts) + '}'
    }
  }
  return { kind: 'ok', body: out }
}

function isThoughtPart(part: Readonly<WireObject>): boolean {
  return part['thought'] === true
}

function isTextPart(part: Readonly<WireObject>): boolean {
  return part['text'] !== undefined && part['thought'] === undefined
}

/**
 * Merges consecutive text parts into one block and consecutive thought
 * parts into one block (the LAST thoughtSignature wins); functionCall and
 * other parts stay in place.
 */
export function consolidateParts(parts: readonly WireObject[]): WireObject[] {
  const merged: WireObject[] = []
  for (const part of parts) {
    const last = merged[merged.length - 1]
    if (isTextPart(part) && last !== undefined && isTextPart(last)) {
      last['text'] = String(last['text']) + String(part['text'])
      continue
    }
    if (isThoughtPart(part) && last !== undefined && isThoughtPart(last)) {
      const text = part['text']
      if (typeof text === 'string') {
        const previous = last['text']
        last['text'] = typeof previous === 'string' ? previous + text : text
      }
      const signature = part['thoughtSignature']
      if (typeof signature === 'string') last['thoughtSignature'] = signature
      continue
    }
    merged.push(part)
  }
  return merged
}
