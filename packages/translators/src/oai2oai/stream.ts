/**
 * Stream pipeline: upstream chat SSE -> downstream chat SSE, re-framed.
 *
 * The translation is a re-framing, not a re-marshaling: every upstream
 * `data:` payload crosses with its ORIGINAL BYTES - the lenient
 * leading-value scan parses the chunk and slices out the value's own
 * byte range, so trailing garbage after the JSON value is dropped while
 * the spacing inside the value survives untouched. The rules, in order:
 *
 * - `data: [DONE]` ends the stream through the shared terminator (no
 *   further frame is forwarded, even when more bytes follow);
 * - a payload that starts with a complete JSON value is forwarded as
 *   one `data:` frame carrying exactly the value's original bytes -
 *   unless the parsed value is an upstream error object, which ends the
 *   stream as ONE terminal `data:` frame (no `[DONE]` after it);
 * - a payload without a complete leading value is a terminal failure
 *   rendered through the shared error-body derivation;
 * - a clean upstream close that never sent `[DONE]` synthesizes the
 *   terminator (the chat surface closes every healthy stream with it);
 * - transport failures propagate to the caller, which decides between
 *   the pre-commit plain HTTP error and the post-commit terminal frame.
 */
import { isUpstreamErrorPayload, renderGatewayError, upstreamErrorStatus } from './errors'
import { lastMemberSpan, scanLeadingJsonValue, serializeJsonString, topLevelStart } from './json'
import { decodeUpstreamSse } from './sse'
import type { ChatResponseContext, DownstreamStreamEvent, SseFrame } from './types'

/**
 * Maps one decoded upstream frame to its re-framed event under the
 * response context (the force-mapping model rewrite). `undefined` means
 * the frame produces no downstream event (the caller keeps reading).
 */
export function reframeUpstreamFrame(
  frame: SseFrame,
  ctx: ChatResponseContext,
): DownstreamStreamEvent | undefined {
  if (frame.data === '[DONE]') return { kind: 'done' }
  const leading = scanLeadingJsonValue(frame.data)
  if (leading === undefined) {
    return { kind: 'terminal-error', body: renderGatewayError(frame.data, 502), status: 502 }
  }
  const parsed = leading.value
  const payload = frame.data.slice(leading.start, leading.end)
  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>
    if (isUpstreamErrorPayload(record)) {
      return { kind: 'terminal-error', body: payload, status: upstreamErrorStatus(record) }
    }
    if (ctx.forceMappingModel !== undefined) {
      return { kind: 'chunk', body: rewriteResponseModel(payload, ctx.forceMappingModel) }
    }
  }
  return { kind: 'chunk', body: payload }
}

/**
 * Rewrites the `model` member of a re-framed payload back to the
 * client-facing alias (force-mapping). The splice keeps every other
 * byte; an absent, non-string or already-matching member leaves the
 * payload untouched.
 */
export function rewriteResponseModel(payload: string, model: string): string {
  const start = topLevelStart(payload)
  const span = lastMemberSpan(payload, start, 'model')
  if (span === undefined) return payload
  let current: unknown
  try {
    current = JSON.parse(payload.slice(span.valueStart, span.valueEnd))
  } catch {
    return payload
  }
  if (typeof current !== 'string' || current === model) return payload
  return payload.slice(0, span.valueStart) + serializeJsonString(model) + payload.slice(span.valueEnd)
}

/**
 * Re-frames an upstream byte/text source into downstream stream events.
 * The iterator ends on `[DONE]`, on a terminal error, and on a clean
 * upstream EOF (which yields the synthesized terminator last).
 * Transport failures propagate as exceptions.
 */
export async function* reframeUpstreamSse(
  source: AsyncIterable<string | Uint8Array>,
  ctx: ChatResponseContext,
): AsyncIterable<DownstreamStreamEvent> {
  for await (const frame of decodeUpstreamSse(source)) {
    const event = reframeUpstreamFrame(frame, ctx)
    if (event === undefined) continue
    yield event
    if (event.kind !== 'chunk') return
  }
  // Clean close without `[DONE]`: the chat surface still ends with the
  // terminator.
  yield { kind: 'done' }
}
