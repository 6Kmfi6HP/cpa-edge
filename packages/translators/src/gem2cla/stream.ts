/**
 * Stream pipeline: upstream Claude SSE -> downstream Gemini frames.
 *
 * Implements the downstream commit contract (S2d7 4.1): no SSE header is
 * committed before the first translated chunk; a post-commit transport
 * failure appends ONE terminal `event: error` frame (the pinned
 * "unexpected EOF" payload) and ends the stream; a pre-commit failure
 * propagates so the facade renders a plain HTTP error; an upstream that
 * closes cleanly without producing any translatable chunk returns the
 * empty-stream gate (the facade renders the pre-commit 500 `empty_stream`,
 * retryable). Successful streams have no terminator: no `[DONE]`, no
 * trailing bytes.
 */
import { decodeSseFrames } from './sse'
import type { GeminiStreamFrame } from './sse'
import { ClaudeToGeminiStreamTranslator } from './response'
import type { ClaudeToGeminiContext } from './types'

/**
 * Translates the upstream byte/text source into downstream frames, in
 * strict upstream event order. Each frame is framed later according to
 * the request's `alt` mode (see {@link frameForMode}).
 */
export async function* translateClaudeSseToGeminiFrames(
  source: AsyncIterable<string | Uint8Array>,
  ctx: ClaudeToGeminiContext,
): AsyncIterable<GeminiStreamFrame> {
  const translator = new ClaudeToGeminiStreamTranslator(ctx)
  let committed = false
  try {
    for await (const frame of decodeSseFrames(source)) {
      for (const payload of translator.translateDataLine(frame.data)) {
        committed = true
        yield { kind: 'chunk', payload }
      }
    }
  } catch (error) {
    if (!committed) throw error
    // Post-commit failures render the pinned terminal frame regardless of
    // what the transport reported (the recording pins the hard-close bytes).
    yield { kind: 'terminal-error' }
    return
  }
}

/** Result of the stream bootstrap (commit rule, S2d7 4.1). */
export type GeminiStreamBootstrap =
  | {
      readonly kind: 'live'
      /** First downstream frame; headers may be committed once it is held. */
      readonly firstFrame: GeminiStreamFrame
      /** Remaining frames of the same stream (terminal frame included). */
      readonly rest: AsyncIterable<GeminiStreamFrame>
    }
  | {
      /**
       * The upstream (HTTP 200) closed before any translatable chunk: no
       * SSE header may be committed; render the pre-commit 500
       * `empty_stream` envelope instead (S2d7-30). Retryable, so callers
       * with `request-retry > 0` may re-enter with another credential.
       */
      readonly kind: 'empty-stream'
    }

/**
 * Pulls the stream until the first translated frame. On success the caller
 * commits the SSE (or raw) headers and continues with `rest`. An upstream
 * failure before the first chunk propagates as an exception (rendered as a
 * plain HTTP error by the facade); a clean chunk-less upstream returns the
 * empty-stream gate.
 */
export async function bootstrapGeminiStream(
  source: AsyncIterable<string | Uint8Array>,
  ctx: ClaudeToGeminiContext,
): Promise<GeminiStreamBootstrap> {
  const stream = translateClaudeSseToGeminiFrames(source, ctx)[Symbol.asyncIterator]()
  const first = await stream.next()
  if (first.done === true) return { kind: 'empty-stream' }
  return {
    kind: 'live',
    firstFrame: first.value,
    rest: { [Symbol.asyncIterator]: () => stream },
  }
}
