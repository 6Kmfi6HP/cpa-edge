/**
 * Stream pipeline: upstream Gemini SSE -> downstream Claude events.
 *
 * Implements the downstream commit contract (S2d8 sections 3.5, 4.2): no
 * SSE header is committed before the first translated event; every
 * translated event of one upstream chunk lands in one downstream write;
 * a clean upstream end feeds the synthetic `[DONE]` pass (message_stop,
 * HasContent-gated); a post-commit transport failure appends the `[DONE]`
 * pass plus exactly ONE terminal `event: error` frame with the pinned
 * `unexpected EOF` message; a stream that ends (clean or broken) before
 * any translated event never commits and surfaces as a pre-commit plain
 * HTTP error.
 */
import { decodeUpstreamDataLines } from './sse'
import type { DownstreamFrame } from './sse'
import { GeminiToClaudeStreamTranslator } from './response'
import { UNEXPECTED_EOF_MESSAGE } from './errors'

/** Stream translation input. */
export interface Cla2GemStreamContext {
  /** o200k estimate of the ORIGINAL client request (message_start). */
  readonly inputTokens: number
  /** Name-restore index built from the request's tools. */
  readonly toolNames: import('./schema').ToolNameIndex
}

/**
 * Translates the upstream byte/text source into framed downstream events,
 * in strict upstream order. Each `chunk` frame holds every event of one
 * upstream data line (the flush boundary of the recorded wire).
 */
export async function* translateGeminiSseToClaudeFrames(
  source: AsyncIterable<string | Uint8Array>,
  ctx: Cla2GemStreamContext,
): AsyncIterable<DownstreamFrame> {
  const translator = new GeminiToClaudeStreamTranslator({
    inputTokens: ctx.inputTokens,
    toolNames: ctx.toolNames,
  })
  let committed = false
  try {
    for await (const line of decodeUpstreamDataLines(source)) {
      const events = translator.translateChunk(line.data)
      if (events.length === 0) continue
      committed = true
      yield { kind: 'chunk', payload: events }
    }
  } catch {
    if (!committed) throw new PreCommitTransportError()
    // Post-commit failures still run the [DONE] pass first (message_stop,
    // HasContent-gated), then render the pinned terminal frame regardless
    // of what the transport reported (the recording pins the hard-close
    // bytes).
    const tail = translator.handleStreamEnd()
    if (tail.length > 0) yield { kind: 'chunk', payload: tail }
    yield { kind: 'terminal-error', message: UNEXPECTED_EOF_MESSAGE }
    return
  }
  const tail = translator.handleStreamEnd()
  if (tail.length > 0) yield { kind: 'chunk', payload: tail }
}

/** Raised when the upstream died before the first translated event. */
export class PreCommitTransportError extends Error {
  constructor() {
    super(UNEXPECTED_EOF_MESSAGE)
    this.name = 'PreCommitTransportError'
  }
}

/** Result of the stream bootstrap (commit rule). */
export type Cla2GemStreamBootstrap =
  | {
      readonly kind: 'live'
      /** First downstream frame; headers may be committed once it is held. */
      readonly firstFrame: DownstreamFrame
      /** Remaining frames of the same stream (terminal frame included). */
      readonly rest: AsyncIterable<DownstreamFrame>
    }
  | {
      /**
       * The upstream (HTTP 200) ended before any translated event: no SSE
       * header may be committed; the facade renders a plain pre-commit
       * error response instead.
       */
      readonly kind: 'dead'
    }

/**
 * Pulls the stream until the first translated frame. On success the caller
 * commits the SSE headers and continues with `rest`. An upstream end or
 * failure before the first translated event yields the `dead` gate.
 */
export async function bootstrapCla2GemStream(
  source: AsyncIterable<string | Uint8Array>,
  ctx: Cla2GemStreamContext,
): Promise<Cla2GemStreamBootstrap> {
  const stream = translateGeminiSseToClaudeFrames(source, ctx)[Symbol.asyncIterator]()
  const first = await stream.next()
  if (first.done === true) return { kind: 'dead' }
  return {
    kind: 'live',
    firstFrame: first.value,
    rest: { [Symbol.asyncIterator]: () => stream },
  }
}
