/**
 * SSE framing helpers for the oai2gem direction (spec 4).
 *
 * Upstream: the Gemini stream (`?alt=sse`) is decoded into per-data-line
 * payloads - `event:` names, comments, empty lines and the internal
 * `[DONE]` marker are skipped, and each `data: <json>` line is translated
 * independently. Downstream, every translated chunk is framed as
 * `data: <chunk>\n\n`, the clean-EOF terminator is `data: [DONE]\n\n`,
 * and a mid-stream terminal error renders one `data: {"error":...}\n\n`
 * frame with NO `[DONE]` after it (fixture C19).
 */

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

/** One decoded upstream payload (per `data:` line; names are ignored). */
export interface UpstreamDataLine {
  readonly data: string
}

/**
 * Decodes a byte or text chunk source into upstream `data:` payloads.
 * Handles re-chunked transport (payloads split across reads), `\r\n`
 * line endings, comment lines, `event:`/`id:`/`retry:` fields, the
 * internal `[DONE]` marker and any complete non-data line (skipped, no
 * downstream frame - spec 4.6).
 */
export async function* decodeUpstreamDataLines(
  source: AsyncIterable<string | Uint8Array>,
): AsyncIterable<UpstreamDataLine> {
  // One decoder per stream: a TextDecoder holds the unfinished tail of a
  // multibyte sequence between decode calls.
  const decoder = new TextDecoder()
  const iterator = source[Symbol.asyncIterator]()
  let buffer = ''
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
      if (line.length === 0) continue
      if (line.startsWith(':')) continue
      if (line.startsWith('event:') || line.startsWith('id:') || line.startsWith('retry:')) continue
      if (line.trim() === 'data: [DONE]') continue
      if (line.startsWith('data:')) {
        yield { data: fieldBody(line.slice(5)) }
      }
      // Complete non-data lines carry no payload on this surface.
    }
  }
  // A trailing `data:` line without its terminator still delivers its
  // payload; complete streams always end with a newline.
  if (buffer.startsWith('data:')) {
    yield { data: fieldBody(buffer.slice(5)) }
  }
}

/** Downstream framing: one `data:` block per translated chunk (spec 4.2). */
export function frameChunk(body: string): string {
  return `data: ${body}\n\n`
}

/** Clean-EOF terminator appended by the gateway itself (spec 4.3). */
export const DONE_FRAME = 'data: [DONE]\n\n'
