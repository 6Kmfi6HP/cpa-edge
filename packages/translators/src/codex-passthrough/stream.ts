
/**
 * Stream pipeline of the Codex passthrough (S2d9 4.1-4.4, 5.2, 5.3).
 *
 * Upstream frames are reassembled line by line and forwarded as one
 * downstream chunk per COMPLETE frame, with the arriving line endings
 * preserved and extended (LF -> `\n\n`, CRLF -> `\r\n\r\n`); comment and
 * `event:` lines that arrive without their data line are held and glued
 * onto the following frame, while lines the SSE grammar does not know
 * (no `data:`/`event:`/`id:` field, no comment, not blank) are dropped -
 * the recorded S2d9-08 wire never carries the mock's annotation line.
 * `event:` names pass through byte-identical and `data:` lines re-prefix
 * as `data: <payload>`.
 *
 * Terminal handling: a `response.completed`/`response.incomplete` frame
 * (or the `response.done` alias, renamed before it is forwarded) closes
 * the stream after ONE extra `\n` byte; an `error`/`response.failed`
 * frame is never forwarded - instead ONE synthesized failure frame
 * follows the already-forwarded frames. A source that ends or rejects
 * before a terminal synthesizes the disconnect failure. Failures that
 * happen before the FIRST forwarded frame never commit SSE headers: they
 * surface as plain HTTP errors through {@link PassthroughPreCommitError}.
 */
import {
  STREAM_DISCONNECTED_MESSAGE,
  codexTerminalFailureStatus,
  formatTerminalFailureFrame,
  incompleteStreamBody,
  preCommitFailureBody,
  synthesizedDetailForStatus,
  terminalFailureDetail,
} from './errors'
import { isPlainObject, rawSpanAt, tryParseJson } from './json'
import { formatDataLine, scanSseLines } from './sse'
import { transformFramePayload } from './response'
import type { FrameTransformState } from './response'

/** Context of one live passthrough stream. */
export interface PassthroughStreamContext {
  /** Client-requested model injected into created frames (4.3). */
  readonly clientModel: string
  /** Force-mapping alias for model-field rewrites (4.3). */
  readonly forceMappingAlias?: string
  /** Native Lite dialect: output repair rebuilds but never hydrates. */
  readonly lite: boolean
  /** `error` for plain clients, `response.failed` for Codex clients. */
  readonly failureEvent: 'error' | 'response.failed'
}

/** Pre-commit failure: rendered as a plain HTTP error, never as SSE. */
export class PassthroughPreCommitError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(body)
    this.name = 'PassthroughPreCommitError'
  }
}

/** Downstream wire frames of a live stream, in order. */
export async function* translatePassthroughStream(
  source: AsyncIterable<string | Uint8Array>,
  ctx: PassthroughStreamContext,
): AsyncIterable<string> {
  const state: FrameTransformState = { items: [] }
  const frameContext = {
    clientModel: ctx.clientModel,
    forceMappingAlias: ctx.forceMappingAlias,
    // Lite streams rebuild an empty terminal output but never hydrate ids
    // (the executor-side patch is skipped for Lite clients, 4.6).
    outputRepair: ctx.lite === true ? { rebuild: true, hydrate: false } : { rebuild: true, hydrate: true },
  }
  let pending: string[] = []
  let pendingHasData = false
  let lastEnding: '\n' | '\r\n' = '\n'
  let emittedFrames = 0

  const flushPending = (terminator: string): string | undefined => {
    if (!pendingHasData) return undefined
    const frame = pending.join('') + terminator
    pending = []
    pendingHasData = false
    emittedFrames += 1
    return frame
  }

  const failureAfterCommit = (detail: string, sequenceNumber: number): string => {
    return formatTerminalFailureFrame(ctx.failureEvent, detail, sequenceNumber)
  }

  try {
    for await (const item of scanSseLines(source)) {
      if (item.kind === 'blank') {
        lastEnding = item.ending
        const frame = flushPending(item.ending)
        if (frame !== undefined) yield frame
        continue
      }
      if (item.kind === 'end') break
      lastEnding = item.ending
      if (item.data === undefined) {
        // A line outside the SSE grammar - no `event:`/`id:` field, no
        // comment - never reaches the wire (recorded S2d9-08: the mock's
        // plain annotation line is dropped from the forwarded bytes).
        if (!isSseFieldLine(item.raw)) continue
        // A new `event:` line starts the next frame: one already holding
        // data completes first (recorded S2d9-13/14 - the upstream sends
        // its blocks without blank separators there). Comments and id
        // lines never complete a frame; without data they stay glued to
        // the following frame.
        if (item.raw.startsWith('event:') && pendingHasData) {
          const frame = flushPending(lastEnding)
          if (frame !== undefined) yield frame
        }
        pending.push(item.raw + item.ending)
        continue
      }
      if (item.data === '[DONE]') {
        // Forwarded verbatim as a data line; not a terminal event.
        pending.push(`${formatDataLine(item.data)}${item.ending}`)
        pendingHasData = true
        continue
      }
      const outcome = transformFramePayload(item.data, frameContext, state)
      if (outcome.kind === 'terminal-failure') {
        const detail = failureDetailOf(outcome.parsed)
        const pendingFrame = flushPending(lastEnding)
        if (pendingFrame !== undefined) yield pendingFrame
        if (emittedFrames === 0) {
          throw new PassthroughPreCommitError(
            codexTerminalFailureStatus(outcome.parsed),
            preCommitFailureBody(detail),
          )
        }
        // Sequence number: the upstream error payload's own value when it
        // carried one, else the count of already-forwarded data frames.
        yield failureAfterCommit(detail, sequenceNumberOf(outcome.parsed, emittedFrames))
        return
      }
      // The completion normalization renames a `response.done` frame on
      // BOTH lines: the payload type (transformed above) and the event
      // name of the enclosing block.
      if (item.data !== undefined && item.data !== '[DONE]' && isResponseDonePayload(item.data)) {
        renamePendingDoneEvent(pending)
      }
      pending.push(`${formatDataLine(outcome.payload)}${item.ending}`)
      pendingHasData = true
      if (outcome.kind === 'terminal-success') {
        const pendingFrame = flushPending(lastEnding)
        if (pendingFrame !== undefined) yield pendingFrame
        yield '\n'
        return
      }
    }
  } catch (error) {
    if (error instanceof PassthroughPreCommitError) throw error
    // Transport failure (hard close / rejected read): same synthesized
    // disconnect as a clean end without a terminal event.
  }

  // The source ended (cleanly or abruptly) without a terminal event.
  const pendingFrame = flushPending(lastEnding)
  if (pendingFrame !== undefined) {
    yield pendingFrame
  }
  if (emittedFrames === 0) {
    throw new PassthroughPreCommitError(408, incompleteStreamBody())
  }
  const detail = synthesizedDetailForStatus(408, STREAM_DISCONNECTED_MESSAGE)
  yield failureAfterCommit(detail, emittedFrames)
}

/**
 * True for non-data lines the SSE grammar recognizes: `event:`/`id:`
 * fields and `:`-prefixed comments. Anything else is transport noise the
 * reference framer never forwards.
 */
function isSseFieldLine(raw: string): boolean {
  return raw.startsWith('event:') || raw.startsWith('id:') || raw.startsWith(':')
}

/** True when a data payload carries the response.done alias type. */
function isResponseDonePayload(data: string): boolean {
  const parsed = tryParseJson(data)
  return isPlainObject(parsed) && parsed['type'] === 'response.done'
}

/** Rewrites a pending `event: response.done` line to the normalized name. */
function renamePendingDoneEvent(pending: string[]): void {
  for (let i = pending.length - 1; i >= 0; i--) {
    const line = pending[i]
    if (line === undefined) continue
    if (line.startsWith('event: response.done')) {
      pending[i] = line.replace('event: response.done', 'event: response.completed')
      return
    }
    if (line.startsWith('data:')) return
  }
}

function sequenceNumberOf(payload: Record<string, unknown>, emittedFrames: number): number {
  const carried = payload['sequence_number']
  return typeof carried === 'number' ? carried : emittedFrames
}

function failureDetailOf(payload: Record<string, unknown>): string {
  const detail = terminalFailureDetail(payload)
  if (detail !== undefined) return detail
  const status = codexTerminalFailureStatus(payload)
  const message = typeof payload['message'] === 'string' ? (payload['message'] as string) : ''
  return synthesizedDetailForStatus(status, message)
}

/** Result shape of the live-stream bootstrap (the commit rule of 4.4). */
export type PassthroughStreamBootstrap =
  | {
      readonly kind: 'live'
      /** First downstream frame; headers may be committed once it is held. */
      readonly firstFrame: string
      /** Remaining frames of the same stream (terminator included). */
      readonly rest: AsyncIterable<string>
    }
  | {
      /** Failure before any frame: no SSE header may be committed. */
      readonly kind: 'pre-commit'
      readonly status: number
      readonly body: string
    }

/**
 * Pulls the stream until the first downstream frame. On success the caller
 * commits SSE headers and continues with `rest`; a pre-commit failure
 * (terminal error frame before any forwarded data, or a disconnect before
 * any frame) renders as a plain HTTP error instead.
 */
export async function bootstrapPassthroughStream(
  source: AsyncIterable<string | Uint8Array>,
  ctx: PassthroughStreamContext,
): Promise<PassthroughStreamBootstrap> {
  const stream = translatePassthroughStream(source, ctx)[Symbol.asyncIterator]()
  try {
    const first = await stream.next()
    if (first.done === true) {
      return { kind: 'pre-commit', status: 408, body: incompleteStreamBody() }
    }
    const rest: AsyncIterable<string> = {
      [Symbol.asyncIterator]: async function* (): AsyncGenerator<string> {
        for (;;) {
          const next = await stream.next()
          if (next.done === true) return
          yield next.value
        }
      },
    }
    return { kind: 'live', firstFrame: first.value, rest }
  } catch (error) {
    if (error instanceof PassthroughPreCommitError) {
      return { kind: 'pre-commit', status: error.status, body: error.body }
    }
    return { kind: 'pre-commit', status: 408, body: incompleteStreamBody() }
  }
}

// ---------------------------------------------------------------------------
// Non-stream aggregation (4.7)
// ---------------------------------------------------------------------------

/** Result of the non-stream aggregation over an upstream SSE body. */
export type AggregationResult =
  | { readonly kind: 'ok'; readonly body: string }
  | { readonly kind: 'error'; readonly status: number; readonly body: string }
  | { readonly kind: 'incomplete'; readonly status: 408; readonly body: string }

/**
 * Aggregates the upstream SSE of a non-stream client: collects
 * `output_item.done` items, reads until the FIRST terminal event and
 * returns its `response` object (repaired and usage-ensured) as the whole
 * downstream body. An in-stream error frame yields the mapped plain-JSON
 * error; a stream without a terminal yields the 408 disconnect body. The
 * non-stream path never injects a model and never rewrites model fields
 * (4.3); Lite requests skip the output repair entirely (4.6).
 */
export function aggregatePassthroughStream(buffer: string, lite: boolean): AggregationResult {
  const state: FrameTransformState = { items: [] }
  const outputRepair = lite === true ? { rebuild: false, hydrate: false } : { rebuild: true, hydrate: true }
  for (const line of buffer.split('\n')) {
    if (!line.startsWith('data:')) continue
    const payloadText = line.startsWith('data: ') ? line.slice('data: '.length) : line.slice('data:'.length)
    if (payloadText.length === 0 || payloadText === '[DONE]') continue
    const outcome = transformFramePayload(payloadText, { clientModel: undefined, outputRepair }, state)
    if (outcome.kind === 'terminal-failure') {
      const detail = failureDetailOf(outcome.parsed)
      return { kind: 'error', status: codexTerminalFailureStatus(outcome.parsed), body: preCommitFailureBody(detail) }
    }
    if (outcome.kind === 'terminal-success') {
      const responseSpan = rawResponseSpan(outcome.payload)
      if (responseSpan === undefined) continue
      return { kind: 'ok', body: outcome.payload.slice(responseSpan.start, responseSpan.end) }
    }
  }
  return { kind: 'incomplete', status: 408, body: incompleteStreamBody() }
}

function rawResponseSpan(payload: string): { readonly start: number; readonly end: number } | undefined {
  return rawSpanAt(payload, ['response'])
}
