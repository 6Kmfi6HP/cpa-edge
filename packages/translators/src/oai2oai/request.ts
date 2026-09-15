/**
 * Request translation: OpenAI chat-completions body -> the same body,
 * byte-preserving.
 *
 * The direction is a passthrough - nothing is re-marshaled, reordered or
 * dropped. Exactly two members are rewritten, both with set-if-different
 * semantics on the RAW client bytes (the executor's recorded helper
 * family):
 *
 * - `model`: the client-facing alias is replaced in place with the
 *   upstream model name; an already-matching value leaves the body
 *   untouched, and every other byte - spacing, key order, duplicates -
 *   survives exactly as the client sent it;
 * - `stream_options.include_usage` (streaming requests only): the flag
 *   is ensured to be JSON `true` - appended at the top level when the
 *   member is absent (the recorded literal `,"stream_options":
 *   {"include_usage":true}` before the closing brace), set inside the
 *   client's own `stream_options` object when one exists, and left
 *   untouched when the client already asked for usage.
 *
 * Non-streaming requests carry no `stream_options` (recorded: the
 * non-stream wire never gains the member).
 */
import { ensureTopLevelFlag, setTopLevelStringIfDifferent } from './json'
import type { ChatPassthroughContext, ChatPassthroughRequest } from './types'

/** The streaming flag the executor ensures on streamed requests. */
export const STREAM_OPTIONS_KEY = 'stream_options'
export const INCLUDE_USAGE_FLAG = 'include_usage'

/**
 * Applies the two recorded rewrites to the raw client body. The body must
 * already have passed the strict request boundary and alias resolution.
 */
export function translateChatPassthrough(
  rawBody: string,
  ctx: ChatPassthroughContext,
): ChatPassthroughRequest {
  let body = setTopLevelStringIfDifferent(rawBody, 'model', ctx.upstreamModel)
  if (ctx.stream) {
    body = ensureTopLevelFlag(body, STREAM_OPTIONS_KEY, INCLUDE_USAGE_FLAG)
  }
  return { body }
}
