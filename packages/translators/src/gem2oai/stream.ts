/**
 * Stream pipeline: upstream OpenAI SSE -> downstream Gemini chunks
 * (S2d2 sections 4.1-4.3).
 *
 * Upstream `data:` payloads map one-to-one onto translated Gemini chunk
 * frames: role-only chunks vanish, content and reasoning deltas become
 * text / thought frames, tool-call deltas buffer silently and flush once
 * on the finish frame, and the usage-only frame closes the sequence.
 * `[DONE]` and a clean upstream EOF both end the stream with no extra
 * frame. Terminal failures surface as `event: error` payloads: an error
 * object inside a data frame passes through VERBATIM, a stray JSON line
 * or an unparseable payload renders per the shared error-body derivation,
 * and transport failures render the transport's own text (recorded:
 * `unexpected EOF`). The alt parameter selects the framing - SSE
 * `data:` blocks or raw byte-adjacent JSON - the chunks themselves are
 * identical either way.
 */
import { parseLeadingJson, readArray, readObject, readString, serializeOrdered } from './json'
import { renderGatewayError } from './errors'
import { extractReasoningTexts, mapFinishReason, parseToolArguments, usageMetadata } from './response'
import type { DownstreamFraming, DownstreamStreamEvent, OpenAIToGeminiContext, SseFrame, WireObject } from './types'

// ---------------------------------------------------------------------------
// Upstream SSE decoding
// ---------------------------------------------------------------------------

/** One decoded upstream event: a `data:` payload, its `event:` name, or a stray JSON line. */
export type UpstreamSseEvent =
  | { readonly kind: 'frame'; readonly frame: SseFrame }
  | { readonly kind: 'json-line'; readonly line: string }

function splitLine(text: string): { readonly line: string; readonly consumed: number } | undefined {
  const lf = text.indexOf('\n')
  if (lf < 0) return undefined
  const line = lf > 0 && text.charCodeAt(lf - 1) === 0x0d ? text.slice(0, lf - 1) : text.slice(0, lf)
  return { line, consumed: lf + 1 }
}

/** Strips the single optional space after an SSE field colon. */
function fieldBody(text: string): string {
  return text.startsWith(' ') ? text.slice(1) : text
}

/**
 * Decodes a byte or text chunk source into upstream SSE events. Re-chunked
 * transport, `\r\n` endings, `event:`/`id:`/`retry:` and comment lines are
 * handled; a complete line that is not an SSE field but starts a JSON
 * value is surfaced as a `json-line` terminal (section 4.2).
 */
export async function* decodeUpstreamSse(
  source: AsyncIterable<string | Uint8Array>,
): AsyncIterable<UpstreamSseEvent> {
  // One decoder per stream: under {stream: true} a TextDecoder keeps the
  // unfinished tail of a multibyte sequence between decode calls.
  const decoder = new TextDecoder()
  const iterator = source[Symbol.asyncIterator]()
  let buffer = ''
  let currentEvent: string | undefined
  let done = false
  while (!done) {
    const next = await iterator.next()
    if (next.done === true) {
      buffer += decoder.decode()
      done = true
    } else {
      const chunk = next.value
      buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
    }
    for (;;) {
      const split = splitLine(buffer)
      if (split === undefined) break
      buffer = buffer.slice(split.consumed)
      const line = split.line
      if (line.length === 0) {
        currentEvent = undefined
        continue
      }
      if (line.startsWith(':')) continue
      if (line.startsWith('event:')) {
        currentEvent = fieldBody(line.slice(6))
        continue
      }
      if (line.startsWith('data:')) {
        yield { kind: 'frame', frame: { event: currentEvent, data: fieldBody(line.slice(5)) } }
        continue
      }
      if (line.startsWith('id:') || line.startsWith('retry:')) continue
      if (line.startsWith('{') || line.startsWith('[')) {
        yield { kind: 'json-line', line }
      }
    }
  }
  // A trailing `data:` line without its terminator still delivers its
  // payload; any other unterminated line is dropped.
  if (buffer.startsWith('data:')) {
    yield { kind: 'frame', frame: { event: undefined, data: fieldBody(buffer.slice(5)) } }
  } else if (buffer.startsWith('{') || buffer.startsWith('[')) {
    yield { kind: 'json-line', line: buffer }
  }
}

// ---------------------------------------------------------------------------
// Chunk mapping
// ---------------------------------------------------------------------------

/** Buffered tool call, one per upstream tool index. */
interface BufferedToolCall {
  id: string
  name: string
  arguments: string
}

/**
 * Stateful upstream-chunk translator. One instance per stream; the tool
 * buffer flushes only on a finish frame and clears afterwards, so a stream
 * that ends without one drops its buffered calls (recorded rule). Frames
 * with two or more buffered calls may emit their parts in any order (the
 * reference iterates a map) - contract comparisons canonicalize them.
 */
export class OpenAIChunkTranslator {
  private readonly ctx: OpenAIToGeminiContext
  private readonly tools = new Map<number, BufferedToolCall>()
  private lastModel: string

  constructor(ctx: OpenAIToGeminiContext) {
    this.ctx = ctx
    this.lastModel = ctx.streamModel
  }

  /** Model stamped onto a frame: the chunk's own, sticky when absent. */
  private modelOf(chunk: Record<string, unknown>): string {
    const model = readString(chunk, 'model')
    if (model !== undefined && model.length > 0) this.lastModel = model
    return this.ctx.forceMappingModel ?? this.lastModel
  }

  /** Maps one parsed upstream chunk to zero or more downstream frame bodies. */
  translateChunk(chunk: Record<string, unknown>): readonly string[] {
    const model = this.modelOf(chunk)
    const frames: string[] = []
    const choices = readArray(chunk, 'choices')
    const usage = chunk['usage']

    if (choices === undefined || choices.length === 0) {
      const metadata = usage !== undefined ? usageMetadata(usage) : undefined
      if (metadata !== undefined) frames.push(this.usageOnlyFrame(metadata, model))
      return frames
    }

    const choice = choices[0]
    if (typeof choice !== 'object' || choice === null || Array.isArray(choice)) return frames
    const record = choice as Record<string, unknown>
    const delta = readObject(record, 'delta')
    const finishReason = readString(record, 'finish_reason')

    const hasContent = delta !== undefined && typeof delta['content'] === 'string' && (delta['content'] as string).length > 0
    const hasToolCalls = delta !== undefined && Array.isArray(delta['tool_calls'])

    if (delta !== undefined) {
      for (const text of extractReasoningTexts(delta['reasoning_content'])) {
        frames.push(this.thoughtFrame(text, model))
      }
      const content = delta['content']
      if (typeof content === 'string' && content.length > 0) {
        frames.push(this.textFrame(content, model))
      }
      if (hasToolCalls) this.bufferToolCalls(delta['tool_calls'])
    }

    // The finish mapping fires only when the delta carries no content and
    // no tool_calls (open question Q8): a combined frame loses the finish.
    if (finishReason !== undefined && finishReason.length > 0) {
      if (!hasContent && !hasToolCalls) frames.push(this.finishFrame(mapFinishReason(finishReason), model))
    } else if (
      delta !== undefined &&
      Object.keys(delta).length === 0 &&
      !hasToolCalls &&
      usage !== undefined
    ) {
      // Non-empty choices with an empty delta, no finish and root usage:
      // the per-choice usage frame (different key order from the
      // usage-only frame).
      const metadata = usageMetadata(usage)
      if (metadata !== undefined) frames.push(this.perChoiceUsageFrame(metadata, model))
    }
    return frames
  }

  private envelope(candidate: WireObject, model: string): string {
    return serializeOrdered({ candidates: [candidate], model })
  }

  private textFrame(text: string, model: string): string {
    return this.envelope({ content: { parts: [{ text }], role: 'model' }, index: 0 }, model)
  }

  private thoughtFrame(text: string, model: string): string {
    return this.envelope({ content: { parts: [{ thought: true, text }], role: 'model' }, index: 0 }, model)
  }

  private finishFrame(finishReason: string, model: string): string {
    const parts = this.flushToolParts()
    return this.envelope({ content: { parts, role: 'model' }, index: 0, finishReason }, model)
  }

  /** Usage-only frame: candidates, usageMetadata, model (recorded order). */
  private usageOnlyFrame(metadata: WireObject, model: string): string {
    return serializeOrdered({ candidates: [], usageMetadata: metadata, model })
  }

  /** Per-choice usage frame: candidates, model, usageMetadata (recorded order). */
  private perChoiceUsageFrame(metadata: WireObject, model: string): string {
    return serializeOrdered({
      candidates: [{ content: { parts: [], role: 'model' }, index: 0 }],
      model,
      usageMetadata: metadata,
    })
  }

  /** Buffers tool-call deltas per tool index; no frame is emitted here. */
  private bufferToolCalls(raw: unknown): void {
    if (!Array.isArray(raw)) return
    for (const entry of raw) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
      const record = entry as Record<string, unknown>
      const index = record['index']
      if (typeof index !== 'number' || !Number.isFinite(index)) continue
      let buffered = this.tools.get(index)
      if (buffered === undefined) {
        buffered = { id: '', name: '', arguments: '' }
        this.tools.set(index, buffered)
      }
      const id = readString(record, 'id')
      if (id !== undefined) buffered.id = id
      const fn = readObject(record, 'function')
      if (fn !== undefined) {
        const name = readString(fn, 'name')
        if (name !== undefined) buffered.name = name
        const args = readString(fn, 'arguments')
        if (args !== undefined) buffered.arguments += args
      }
    }
  }

  /** Flushes buffered tool calls in tool-index order and clears the buffer. */
  private flushToolParts(): WireObject[] {
    const parts: WireObject[] = []
    for (const index of [...this.tools.keys()].sort((left, right) => left - right)) {
      const call = this.tools.get(index)
      if (call === undefined) continue
      const args = parseToolArguments(call.arguments)
      const functionCall: WireObject =
        call.id.length > 0 ? { id: call.id, name: call.name, args } : { name: call.name, args }
      parts.push({ functionCall })
    }
    this.tools.clear()
    return parts
  }
}

// ---------------------------------------------------------------------------
// Terminal-error detection
// ---------------------------------------------------------------------------

const ERROR_EVENT_NAMES: readonly string[] = Object.freeze(['error', 'response.error', 'response.failed'])

/** Status hint of an upstream error payload: `status`/`status_code` in 400..599, else 502. */
export function upstreamErrorStatus(payload: Record<string, unknown>): number {
  for (const key of ['status', 'status_code'] as const) {
    const raw = payload[key]
    if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 400 && raw <= 599) return raw
  }
  return 502
}

/** Recognizes an OpenAI error object inside an upstream data frame (section 4.2). */
export function isUpstreamErrorPayload(payload: Record<string, unknown>): boolean {
  if ('error' in payload) return true
  const response = payload['response']
  if (typeof response === 'object' && response !== null && 'error' in (response as Record<string, unknown>)) {
    return true
  }
  if ('code' in payload && 'message' in payload) return true
  const type = payload['type']
  if (typeof type === 'string' && ERROR_EVENT_NAMES.includes(type)) return true
  return false
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

/**
 * Translates an upstream OpenAI SSE source into downstream stream events.
 * The iterator ends on `[DONE]`, on a clean upstream EOF (treated the
 * same) and after a terminal error. Transport failures propagate as
 * exceptions - the caller decides between a pre-commit plain HTTP error
 * and a post-commit terminal frame.
 */
export async function* translateOpenAIStreamToGemini(
  source: AsyncIterable<string | Uint8Array>,
  ctx: OpenAIToGeminiContext,
): AsyncIterable<DownstreamStreamEvent> {
  const translator = new OpenAIChunkTranslator(ctx)
  for await (const event of decodeUpstreamSse(source)) {
    if (event.kind === 'json-line') {
      yield { kind: 'terminal-error', body: renderGatewayError(event.line, 502), status: 502 }
      return
    }
    const frame = event.frame
    if (frame.event !== undefined && ERROR_EVENT_NAMES.includes(frame.event)) {
      yield { kind: 'terminal-error', body: frame.data, status: 502 }
      return
    }
    if (frame.data === '[DONE]') return
    // Leading-value parse (S1-17 pin): trailing bytes after the JSON value
    // are ignored; a payload without a complete leading value is the
    // terminal non-JSON case.
    const parsed = parseLeadingJson(frame.data)
    if (parsed === undefined) {
      yield { kind: 'terminal-error', body: renderGatewayError(frame.data, 502), status: 502 }
      return
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue
    const payload = parsed as Record<string, unknown>
    if (isUpstreamErrorPayload(payload)) {
      yield { kind: 'terminal-error', body: frame.data, status: upstreamErrorStatus(payload) }
      return
    }
    for (const body of translator.translateChunk(payload)) {
      yield { kind: 'chunk', body }
    }
  }
}

// ---------------------------------------------------------------------------
// Downstream framing (section 4.1)
// ---------------------------------------------------------------------------

/**
 * Frames one downstream event for the selected mode. SSE mode wraps every
 * chunk in `data:` blocks and marks terminal errors with an `event: error`
 * line; raw mode emits the bytes verbatim with no framing at all.
 */
export function frameDownstreamEvent(framing: DownstreamFraming, event: DownstreamStreamEvent): string {
  if (framing === 'raw') return event.body
  if (event.kind === 'terminal-error') return `event: error\ndata: ${event.body}\n\n`
  return `data: ${event.body}\n\n`
}

/** Effective framing for the `alt` value: `sse`, empty or absent -> SSE; else raw. */
export function framingForAlt(alt: string | undefined): DownstreamFraming {
  if (alt === undefined || alt === '' || alt === 'sse') return 'sse'
  return 'raw'
}
