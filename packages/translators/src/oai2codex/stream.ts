/**
 * Stream pipeline: upstream Codex SSE -> downstream OpenAI chat SSE.
 *
 * Downstream contract (S2d5 sections 2.6 and 5): SSE headers commit only
 * once the first frame is in hand; every translated chunk frames as
 * `data: <json>\n\n`; a clean terminal appends `data: [DONE]\n\n` (even when
 * the terminal produced no chunk, e.g. the `response.done` alias); failures
 * with no committed frame surface pre-commit as plain HTTP errors, failures
 * after commit surface as ONE in-stream error frame with NO `[DONE]` - the
 * terminal-failure body verbatim (E3), the empty-incomplete body (E6) or the
 * pinned disconnect body (E5).
 */
import { emptyIncompleteBody, formatInStreamErrorFrame, incompleteStreamBody } from './errors'
import { decodeSseFrames, formatSseData, formatSseDone } from './sse'
import { CodexStreamChunkTranslator } from './response'
import type { CodexToChatContext } from './types'

/** Pre-commit failure: rendered as a plain HTTP error, never as SSE. */
export class CodexPreCommitError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(body)
    this.name = 'CodexPreCommitError'
  }
}

/** Downstream wire frames of a live stream, in order. */
export async function* translateCodexSseToChatSse(
  source: AsyncIterable<string | Uint8Array>,
  ctx: CodexToChatContext,
): AsyncIterable<string> {
  const translator = new CodexStreamChunkTranslator(ctx)
  let committed = false
  try {
    for await (const frame of decodeSseFrames(source)) {
      const result = translator.translateDataLine(frame.data)
      if (result.kind === 'failure') {
        if (!committed) throw new CodexPreCommitError(result.status, result.body)
        yield formatInStreamErrorFrame(result.body)
        return
      }
      if (result.kind === 'empty-incomplete') {
        const body = emptyIncompleteBody()
        if (!committed) throw new CodexPreCommitError(502, body)
        yield formatInStreamErrorFrame(body)
        return
      }
      if (result.kind === 'alias-stop') {
        // Terminal alias with NO chunk: the stream still ends with [DONE].
        yield formatSseDone()
        return
      }
      for (const chunk of result.frames) {
        committed = true
        yield formatSseData(chunk)
      }
      if (result.kind === 'stop') {
        yield formatSseDone()
        return
      }
    }
  } catch (error) {
    if (error instanceof CodexPreCommitError) throw error
    // Transport failure (hard close / rejected read).
    if (!committed) throw new CodexPreCommitError(408, incompleteStreamBody())
    yield formatInStreamErrorFrame(incompleteStreamBody())
    return
  }
  // The upstream ended without a terminal event (E5).
  if (!committed) throw new CodexPreCommitError(408, incompleteStreamBody())
  yield formatInStreamErrorFrame(incompleteStreamBody())
}

/** Result of the stream bootstrap (commit rule). */
export type CodexStreamBootstrap =
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
 * (terminal failure as the first event, empty-incomplete, disconnect before
 * any chunk) renders as a plain HTTP error instead.
 */
export async function bootstrapCodexChunkStream(
  source: AsyncIterable<string | Uint8Array>,
  ctx: CodexToChatContext,
): Promise<CodexStreamBootstrap> {
  const stream = translateCodexSseToChatSse(source, ctx)[Symbol.asyncIterator]()
  try {
    const first = await stream.next()
    if (first.done === true) {
      // Defensive: every terminal path yields at least the [DONE] frame or
      // throws, so an exhausted stream models a connection that closed
      // before any terminal event.
      return { kind: 'pre-commit', status: 408, body: incompleteStreamBody() }
    }
    return {
      kind: 'live',
      firstFrame: first.value,
      rest: { [Symbol.asyncIterator]: () => stream },
    }
  } catch (error) {
    if (error instanceof CodexPreCommitError) return { kind: 'pre-commit', status: error.status, body: error.body }
    throw error
  }
}
