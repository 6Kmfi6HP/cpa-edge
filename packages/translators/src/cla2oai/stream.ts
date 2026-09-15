/**
 * Stream pipeline: upstream OpenAI SSE -> downstream Claude events
 * (S2d4 sections 4.1-4.4).
 *
 * Upstream frames are parsed line-wise: `data:` lines of one frame join
 * with `\n`, `event:` names are captured, comments and `id:`/`retry:`
 * lines are ignored, a blank line ends the frame, and `data: [DONE]`
 * terminates the stream. A clean EOF without `[DONE]` synthesizes one
 * (recorded: the mock's canned SSE has no [DONE] and the golden still
 * records message_delta + message_stop). The chunk translator is the
 * recorded state machine: lazy text/thinking block starts, tool blocks
 * that start mid-stream once id and name are known, tool arguments
 * buffered and emitted as ONE `input_json_delta` at finalize (ascending
 * OpenAI-index order, belated starts with synthesized `tool_<index>`
 * names), interleaved text/thinking buffered and flushed after the tool
 * blocks, and `message_delta` + `message_stop` together at the first
 * finish-or-trailing-usage chunk that carries usage - otherwise at
 * `[DONE]`. An upstream that closes without ANY data frame leaves the
 * downstream empty (the handler still commits the SSE headers); a
 * transport failure renders the pinned `unexpected EOF` - a plain HTTP
 * error before the first event, an `event: error` frame after it.
 */
import { isPlainObject, readArray, readObject, readString } from './json'
import { UNEXPECTED_EOF_MESSAGE } from './errors'
import {
  captureFinishReason,
  contentBlockStartEvent,
  contentBlockStopEvent,
  contentDeltaEvent,
  extractOpenAIUsage,
  extractReasoningTexts,
  inputJsonDeltaEvent,
  mapFinishReasonToStopReason,
  messageDeltaEvent,
  messageStartEvent,
  messageStopEvent,
  toolBlockStartEvent,
} from './response'
import { fixJson, generatedToolUseId, restoreToolName, sanitizeClaudeToolId } from './schema'
import type { ToolNameIndex } from './schema'

// ---------------------------------------------------------------------------
// Upstream SSE decoding (frame-batched, section 4.1)
// ---------------------------------------------------------------------------

/** One decoded upstream frame: its `data:` payloads and `event:` name. */
export interface SseFrame {
  /** `event:` name when the frame carried one. */
  readonly event?: string
  /** Payloads of the frame's `data:` lines, in order. */
  readonly dataLines: readonly string[]
}

/** One decoded upstream event: a complete frame or a stray JSON line. */
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
 * Decodes a byte or text chunk source into upstream SSE frames. Re-chunked
 * transport, `\r\n` endings, comments, `event:`/`id:`/`retry:` lines are
 * handled; a complete line that is not an SSE field but starts a JSON
 * value is surfaced as a `json-line` terminal.
 */
export async function* decodeUpstreamSseFrames(
  source: AsyncIterable<string | Uint8Array>,
): AsyncIterable<UpstreamSseEvent> {
  // One decoder per stream: under streaming a TextDecoder keeps the
  // unfinished tail of a multibyte sequence between decode calls.
  const decoder = new TextDecoder()
  const iterator = source[Symbol.asyncIterator]()
  let buffer = ''
  let currentEvent: string | undefined
  let dataLines: string[] = []
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
        // A blank line ends the frame.
        if (dataLines.length > 0) {
          yield { kind: 'frame', frame: { event: currentEvent, dataLines: [...dataLines] } }
        }
        currentEvent = undefined
        dataLines = []
        continue
      }
      if (line.startsWith(':')) continue
      if (line.startsWith('event:')) {
        currentEvent = fieldBody(line.slice(6))
        continue
      }
      if (line.startsWith('data:')) {
        dataLines.push(fieldBody(line.slice(5)))
        continue
      }
      if (line.startsWith('id:') || line.startsWith('retry:')) continue
      if (line.startsWith('{') || line.startsWith('[')) {
        yield { kind: 'json-line', line }
      }
    }
  }
  // A trailing `data:` line without its blank-line terminator still
  // delivers its frame; a stray unterminated JSON line fails the stream.
  if (dataLines.length > 0) {
    yield { kind: 'frame', frame: { event: currentEvent, dataLines: [...dataLines] } }
  } else if (buffer.startsWith('{') || buffer.startsWith('[')) {
    yield { kind: 'json-line', line: buffer }
  }
}

// ---------------------------------------------------------------------------
// Terminal-error detection (section 4.1)
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

/** Recognizes an error object inside an upstream data frame (section 4.1). */
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
// The chunk state machine (section 4.2)
// ---------------------------------------------------------------------------

/** Context the stream translation needs. */
export interface Cla2OaiStreamContext {
  /** Local input-token estimate of the ORIGINAL client request (4.3). */
  readonly inputTokens: number
  /** Name-restore index built from the request's tools. */
  readonly toolNames: ToolNameIndex
}

/** One buffered tool call, keyed by its OpenAI tool index. */
interface ToolAccumulator {
  id: string
  name: string
  args: string
  started: boolean
  blockIndex: number
}

/** The currently open text/thinking block. */
interface OpenBlock {
  readonly kind: 'text' | 'thinking'
  readonly index: number
}

/** One buffered interleaved delta (section 4.2 rule 4). */
interface BufferedDelta {
  readonly kind: 'text' | 'thinking'
  readonly text: string
}

/**
 * Stateful upstream-chunk translator. One instance per stream; the
 * downstream event order is fully deterministic.
 */
export class OpenAIToClaudeStreamTranslator {
  private readonly inputTokens: number
  private readonly toolNames: ToolNameIndex
  private firstId = ''
  private firstModel = ''
  private firstChunkSeen = false
  private started = false
  private nextIndex = 0
  private openBlock: OpenBlock | undefined
  private readonly tools = new Map<number, ToolAccumulator>()
  private currentTool: ToolAccumulator | undefined
  private readonly buffered: BufferedDelta[] = []
  private reason = ''
  private finishCaptured = false
  private usage: unknown
  private toolAnnounced = false
  private anyBlockStarted = false
  private contentAccumulated = false
  private messageDeltaSent = false
  private messageStopSent = false

  constructor(ctx: Cla2OaiStreamContext) {
    this.inputTokens = ctx.inputTokens
    this.toolNames = ctx.toolNames
  }

  /**
   * Maps one parsed upstream chunk to the framed downstream events of
   * that chunk, in recorded order.
   */
  processChunk(chunk: Record<string, unknown>): readonly string[] {
    const events: string[] = []
    if (!this.firstChunkSeen) {
      this.firstChunkSeen = true
      const id = readString(chunk, 'id')
      const model = readString(chunk, 'model')
      if (id !== undefined) this.firstId = id
      if (model !== undefined) this.firstModel = model
    }
    const rawUsage = chunk['usage']
    if (rawUsage !== null && rawUsage !== undefined) this.usage = rawUsage
    const chunkHasUsage = rawUsage !== null && rawUsage !== undefined
    const choices = readArray(chunk, 'choices')
    let hasChoice0 = false
    if (choices !== undefined && choices.length > 0) {
      const choice = choices[0]
      if (isPlainObject(choice)) {
        hasChoice0 = true
        const delta = readObject(choice, 'delta')
        if (delta !== undefined && !this.started) {
          this.started = true
          events.push(
            messageStartEvent(this.inputTokens > 0 ? this.inputTokens : 0, this.firstId, this.firstModel),
          )
        }
        if (delta !== undefined) this.handleDelta(delta, events)
        const finish = readString(choice, 'finish_reason')
        if (finish !== undefined && finish.length > 0) {
          this.captureFinish(finish)
          this.finalizeBlocks(events)
        }
      }
    }
    // Terminal condition (rule 6): message_delta + message_stop together
    // at the first chunk where finish was captured or the trailing-usage
    // condition holds AND usage is on record.
    const trailingUsage =
      chunkHasUsage &&
      !hasChoice0 &&
      (this.finishCaptured ||
        this.toolAnnounced ||
        this.anyBlockStarted ||
        this.contentAccumulated ||
        this.buffered.length > 0)
    if (!this.messageDeltaSent && (this.finishCaptured || trailingUsage) && this.usage !== undefined) {
      this.emitMessageDeltaAndStop(events)
    }
    return events
  }

  /** The `[DONE]` pass (real or synthesized): only what is still missing. */
  handleDone(): readonly string[] {
    const events: string[] = []
    this.finalizeBlocks(events)
    if (!this.messageDeltaSent) {
      events.push(
        messageDeltaEvent(
          mapFinishReasonToStopReason(this.reason.length > 0 ? this.reason : 'stop'),
          extractOpenAIUsage(this.usage),
        ),
      )
      this.messageDeltaSent = true
    }
    if (!this.messageStopSent) {
      events.push(messageStopEvent())
      this.messageStopSent = true
    }
    return events
  }

  /** Whether any downstream event was ever produced. */
  get producedEvents(): boolean {
    return this.started
  }

  private handleDelta(delta: Record<string, unknown>, events: string[]): void {
    for (const text of extractReasoningTexts(delta['reasoning_content'])) {
      this.handleTextLike('thinking', text, events)
    }
    const content = delta['content']
    if (typeof content === 'string' && content.length > 0) {
      this.handleTextLike('text', content, events)
    }
    const toolCalls = delta['tool_calls']
    if (Array.isArray(toolCalls)) this.handleToolCalls(toolCalls, events)
  }

  private handleTextLike(kind: 'text' | 'thinking', text: string, events: string[]): void {
    this.contentAccumulated = true
    if (this.currentTool !== undefined) {
      // Interleaved deltas buffer while a tool block is open (rule 4).
      this.buffered.push({ kind, text })
      return
    }
    const open = this.openBlock
    if (open !== undefined && open.kind === kind) {
      events.push(contentDeltaEvent(kind, open.index, text))
      return
    }
    if (open !== undefined) {
      events.push(contentBlockStopEvent(open.index))
      this.openBlock = undefined
    }
    const index = this.nextIndex
    this.nextIndex += 1
    this.openBlock = { kind, index }
    this.anyBlockStarted = true
    events.push(contentBlockStartEvent(kind, index))
    events.push(contentDeltaEvent(kind, index, text))
  }

  private handleToolCalls(raw: readonly unknown[], events: string[]): void {
    for (const entry of raw) {
      if (!isPlainObject(entry)) continue
      const index = entry['index']
      if (typeof index !== 'number' || !Number.isFinite(index)) continue
      let acc = this.tools.get(index)
      if (acc === undefined) {
        acc = { id: '', name: '', args: '', started: false, blockIndex: -1 }
        this.tools.set(index, acc)
      }
      const id = readString(entry, 'id')
      if (id !== undefined && id.length > 0) acc.id = id
      const fn = readObject(entry, 'function')
      if (fn !== undefined) {
        const name = readString(fn, 'name')
        if (name !== undefined && name.length > 0) acc.name = name
        const args = readString(fn, 'arguments')
        if (args !== undefined) acc.args += args
      }
      this.maybeStartToolBlock(acc, events)
    }
  }

  /** Starts a tool block mid-stream once id and name are known (rule 3). */
  private maybeStartToolBlock(acc: ToolAccumulator, events: string[]): void {
    if (acc.started) return
    if (acc.id.length === 0 || acc.name.length === 0) return
    if (this.currentTool !== undefined) return
    const open = this.openBlock
    if (open !== undefined) {
      events.push(contentBlockStopEvent(open.index))
      this.openBlock = undefined
    }
    const index = this.nextIndex
    this.nextIndex += 1
    events.push(
      toolBlockStartEvent(index, sanitizeClaudeToolId(acc.id), restoreToolName(this.toolNames, acc.name)),
    )
    acc.started = true
    acc.blockIndex = index
    this.currentTool = acc
    this.toolAnnounced = true
    this.anyBlockStarted = true
  }

  /** Rule 5: the effective internal reason of a finish frame. */
  private captureFinish(finish: string): void {
    const announcedArguments: string[] = []
    for (const acc of this.tools.values()) {
      if (acc.started) announcedArguments.push(acc.args)
    }
    this.reason = captureFinishReason(finish, announcedArguments).reason
    this.finishCaptured = true
  }

  /**
   * Finalizes every open block (rules 3-4): stops the open text/thinking
   * block, flushes the tool blocks in ascending OpenAI-index order
   * (emitting belated starts with synthesized names), then flushes the
   * buffered text/thinking runs as fresh blocks. Idempotent.
   */
  private finalizeBlocks(events: string[]): void {
    const open = this.openBlock
    if (open !== undefined) {
      events.push(contentBlockStopEvent(open.index))
      this.openBlock = undefined
    }
    const indexes = [...this.tools.keys()].sort((left, right) => left - right)
    for (const openaiIndex of indexes) {
      const acc = this.tools.get(openaiIndex)
      if (acc === undefined) continue
      if (!acc.started) {
        if (acc.id.length === 0 && acc.name.length === 0 && acc.args.length === 0) continue
        const name = acc.name.length > 0 ? acc.name : `tool_${openaiIndex}`
        const id = acc.id.length > 0 ? sanitizeClaudeToolId(acc.id) : generatedToolUseId()
        const index = this.nextIndex
        this.nextIndex += 1
        events.push(
          toolBlockStartEvent(index, id, restoreToolName(this.toolNames, name)),
        )
        acc.started = true
        acc.blockIndex = index
        this.toolAnnounced = true
      }
      if (acc.args.length > 0) {
        events.push(inputJsonDeltaEvent(acc.blockIndex, fixJson(acc.args)))
      }
      events.push(contentBlockStopEvent(acc.blockIndex))
    }
    this.tools.clear()
    this.currentTool = undefined
    // Buffered interleaved deltas flush after the tool blocks, one block
    // per run of consecutive same-type pieces (rule 4).
    let runKind: 'text' | 'thinking' | undefined
    let runText = ''
    for (const piece of this.buffered) {
      if (runKind === piece.kind) {
        runText += piece.text
        continue
      }
      if (runKind !== undefined) this.emitBufferedRun(runKind, runText, events)
      runKind = piece.kind
      runText = piece.text
    }
    if (runKind !== undefined) this.emitBufferedRun(runKind, runText, events)
    this.buffered.length = 0
  }

  private emitBufferedRun(kind: 'text' | 'thinking', text: string, events: string[]): void {
    const index = this.nextIndex
    this.nextIndex += 1
    events.push(contentBlockStartEvent(kind, index))
    events.push(contentDeltaEvent(kind, index, text))
    events.push(contentBlockStopEvent(index))
  }

  private emitMessageDeltaAndStop(events: string[]): void {
    events.push(
      messageDeltaEvent(
        mapFinishReasonToStopReason(this.reason.length > 0 ? this.reason : 'stop'),
        extractOpenAIUsage(this.usage),
      ),
    )
    this.messageDeltaSent = true
    events.push(messageStopEvent())
    this.messageStopSent = true
  }
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

/** Downstream frame of the stream pipeline (already framed event text). */
export type DownstreamFrame =
  | { readonly kind: 'chunk'; readonly payload: string }
  | { readonly kind: 'terminal-error'; readonly message: string }

/**
 * Raised when the stream fails before the first downstream event: the
 * facade renders a plain HTTP error (status + text) instead of committing
 * SSE headers.
 */
export class StreamFailureError extends Error {
  readonly status: number
  readonly text: string

  constructor(status: number, text: string) {
    super(text)
    this.name = 'StreamFailureError'
    this.status = status
    this.text = text
  }
}

function isDoneFrame(frame: SseFrame): boolean {
  return frame.dataLines.includes('[DONE]')
}

/**
 * Translates an upstream OpenAI SSE source into framed downstream Claude
 * events, in strict upstream order. Pre-commit failures throw
 * {@link StreamFailureError}; post-commit failures yield exactly one
 * terminal `event: error` frame. A clean upstream end runs the
 * synthesized `[DONE]` pass; an upstream that produced no data frame at
 * all ends the stream empty (the handler still commits SSE headers).
 */
export async function* translateOpenAIToClaudeFrames(
  source: AsyncIterable<string | Uint8Array>,
  ctx: Cla2OaiStreamContext,
): AsyncIterable<DownstreamFrame> {
  const translator = new OpenAIToClaudeStreamTranslator(ctx)
  let committed = false
  let sawAnyData = false

  const fail = (status: number, text: string): DownstreamFrame => {
    if (!committed) throw new StreamFailureError(status, text)
    return { kind: 'terminal-error', message: text }
  }

  try {
    for await (const event of decodeUpstreamSseFrames(source)) {
      if (event.kind === 'json-line') {
        yield fail(502, event.line)
        return
      }
      const frame = event.frame
      if (frame.event !== undefined && ERROR_EVENT_NAMES.includes(frame.event)) {
        yield fail(502, frame.dataLines.join('\n'))
        return
      }
      if (isDoneFrame(frame)) {
        for (const payload of translator.handleDone()) yield { kind: 'chunk', payload }
        return
      }
      sawAnyData = true
      const data = frame.dataLines.join('\n')
      let parsed: unknown
      try {
        parsed = JSON.parse(data)
      } catch {
        yield fail(502, data)
        return
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue
      const payload = parsed as Record<string, unknown>
      if (isUpstreamErrorPayload(payload)) {
        yield fail(upstreamErrorStatus(payload), data)
        return
      }
      for (const payloadEvent of translator.processChunk(payload)) {
        committed = true
        yield { kind: 'chunk', payload: payloadEvent }
      }
    }
    // Clean EOF without [DONE]: synthesize the [DONE] pass (section 4.1)
    // unless the upstream produced no data frame at all (section 4.2
    // rule 8 - the downstream stays empty).
    if (sawAnyData) {
      for (const payload of translator.handleDone()) yield { kind: 'chunk', payload }
    }
  } catch (error) {
    if (error instanceof StreamFailureError) throw error
    if (!committed) throw new StreamFailureError(500, UNEXPECTED_EOF_MESSAGE)
    // Post-commit transport failure: the pinned hard-close bytes,
    // regardless of what the transport reported (section 4.4).
    yield { kind: 'terminal-error', message: UNEXPECTED_EOF_MESSAGE }
  }
}

/** Result of the stream bootstrap (commit rule, sections 4.2/4.4). */
export type Cla2OaiStreamBootstrap =
  | {
      readonly kind: 'live'
      /** First downstream frame; headers may be committed once it is held. */
      readonly firstFrame: DownstreamFrame
      /** Remaining frames of the same stream (terminal frame included). */
      readonly rest: AsyncIterable<DownstreamFrame>
    }
  | {
      /**
       * The upstream ended cleanly before any translated event and no
       * data frame existed: SSE headers are still committed and the
       * downstream body stays empty (section 4.2 rule 8).
       */
      readonly kind: 'committed-empty'
    }

/**
 * Pulls the stream until the first translated frame. On success the
 * caller commits the SSE headers and continues with `rest`. Pre-commit
 * failures reject with {@link StreamFailureError}; a clean end before
 * any data yields the `committed-empty` gate.
 */
export async function bootstrapCla2OaiStream(
  source: AsyncIterable<string | Uint8Array>,
  ctx: Cla2OaiStreamContext,
): Promise<Cla2OaiStreamBootstrap> {
  const stream = translateOpenAIToClaudeFrames(source, ctx)[Symbol.asyncIterator]()
  const first = await stream.next()
  if (first.done === true) return { kind: 'committed-empty' }
  return {
    kind: 'live',
    firstFrame: first.value,
    rest: { [Symbol.asyncIterator]: () => stream },
  }
}
