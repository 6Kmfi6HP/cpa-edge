/**
 * SSE framing helpers for the oai2oai direction (the recorded chat
 * wire).
 *
 * Upstream: the chat SSE stream is decoded into `data:` payloads; every
 * other line is dropped - `event:` names never cross the gateway (the
 * recorded re-framing rule), and comments, `id:`/`retry:` fields and
 * complete non-data lines carry no payload. Downstream: each forwarded
 * payload is framed as `data: <payload>\n\n`, and the stream ends with
 * the `[DONE]` terminator, itself a full SSE frame: the raw-chunked
 * cross-golden capture of this surface records the closing chunk as
 * `data: [DONE]\n\n` (14 bytes), so the terminator carries its trailing
 * blank line like every other frame. The S1-15 markdown fixture lost
 * that tail to the recorder's display stripping (a capture artifact,
 * ruled so); the wire truth is asserted here.
 */
import type { SseFrame } from './types'

interface LineSplit {
  /** Line content without its terminator. */
  readonly line: string
  /** Input consumed so far (terminator included). */
  readonly consumed: number
}

function splitLine(text: string): LineSplit | undefined {
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
 * Decodes a byte or text chunk source into upstream SSE frames. Handles
 * re-chunked transport (payloads split across reads), `\r\n` endings,
 * comment lines and the non-data fields; the `event:` name is captured
 * on the frame for diagnostics but never forwarded.
 */
export async function* decodeUpstreamSse(source: AsyncIterable<string | Uint8Array>): AsyncIterable<SseFrame> {
  // One decoder per stream: a TextDecoder holds the unfinished tail of a
  // multibyte sequence between decode calls, so a decoder shared across
  // streams would leak one stream's pending bytes into another.
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
        yield { event: currentEvent, data: fieldBody(line.slice(5)) }
        continue
      }
      // `id:`/`retry:` fields and any other complete line carry no
      // payload on this surface - the wire forwards data lines only.
    }
  }
  // A trailing `data:` line without its terminator is still delivered as
  // a frame; any other unterminated line drops.
  if (buffer.startsWith('data:')) {
    yield { event: undefined, data: fieldBody(buffer.slice(5)) }
  }
}

/** Downstream framing of one forwarded payload: `data: <payload>\n\n`. */
export function dataFrame(payload: string): string {
  return `data: ${payload}\n\n`
}

/**
 * The `[DONE]` terminator, a full SSE frame. Emitted verbatim -
 * forwarded when the upstream stream carries its own marker, synthesized
 * at a clean close that never sent one (the same chat surface
 * synthesizes it over non-OpenAI upstreams) - with the trailing blank
 * line the raw-chunked cross-golden capture records.
 */
export const DONE_TERMINATOR = 'data: [DONE]\n\n'
