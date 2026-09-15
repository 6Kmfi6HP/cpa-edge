/**
 * Stream pipeline: upstream Claude SSE -> downstream OpenAI chat SSE.
 *
 * Implements the nine-rule downstream contract (S2d3 section 4): the commit
 * rule (no SSE header before the first translated chunk), `data:` framing,
 * the `[DONE]` terminator on clean closes, one in-stream terminal error
 * frame with no `[DONE]` after a post-commit transport failure, strict
 * upstream order, no forwarded `event:` names, and the empty-stream
 * bootstrap gate that turns a chunk-less upstream into a pre-commit 500
 * (`empty_stream`, retryable) instead of an SSE stream.
 */
import { decodeSseFrames, formatSseData, formatSseDone } from './sse'
import { formatInStreamErrorFrame } from './errors'
import { ClaudeStreamChunkTranslator } from './response'
import type { ClaudeToChatContext } from './types'

/** Downstream wire frames of a live stream, in order. */
export async function* translateClaudeSseToChatSse(
  source: AsyncIterable<string | Uint8Array>,
  ctx: ClaudeToChatContext,
): AsyncIterable<string> {
  const translator = new ClaudeStreamChunkTranslator(ctx)
  let committed = false
  try {
    for await (const frame of decodeSseFrames(source)) {
      for (const chunk of translator.translateDataLine(frame.data)) {
        committed = true
        yield formatSseData(chunk)
      }
    }
  } catch (error) {
    if (!committed) throw error
    yield formatInStreamErrorFrame(errorMessage(error))
    return
  }
  // Rule 9: an upstream that produced no translatable chunk never commits -
  // no terminator either; the bootstrap gate reports the empty stream.
  if (committed) yield formatSseDone()
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message
  return 'unexpected EOF'
}

/** Result of the stream bootstrap (commit rule, S2d3 section 4 rule 1/9). */
export type ChatStreamBootstrap =
  | {
      readonly kind: 'live'
      /** First downstream frame; headers may be committed once it is held. */
      readonly firstFrame: string
      /** Remaining frames of the same stream (terminator included). */
      readonly rest: AsyncIterable<string>
    }
  | {
      /**
       * The upstream (HTTP 200) closed before any translatable chunk: no
       * SSE header may be committed; render
       * {@link renderEmptyStreamFailure} instead. Retryable, so callers
       * with `request-retry > 0` may re-enter with another credential.
       */
      readonly kind: 'empty-stream'
    }

/**
 * Pulls the stream until the first translated frame. On success the caller
 * commits SSE headers and continues with `rest`. An upstream failure before
 * the first chunk propagates as an exception (rendered as a plain HTTP
 * error by the executor); an empty upstream returns the empty-stream gate.
 */
export async function bootstrapChatChunkStream(
  source: AsyncIterable<string | Uint8Array>,
  ctx: ClaudeToChatContext,
): Promise<ChatStreamBootstrap> {
  const stream = translateClaudeSseToChatSse(source, ctx)[Symbol.asyncIterator]()
  const first = await stream.next()
  if (first.done === true) return { kind: 'empty-stream' }
  return {
    kind: 'live',
    firstFrame: first.value,
    rest: { [Symbol.asyncIterator]: () => stream },
  }
}
