/**
 * SSE framing helpers for the cla2gem direction.
 *
 * Upstream: the Gemini stream (`?alt=sse`) is decoded into per-data-line
 * payloads - `event:` names, `[DONE]`, blank and comment lines are skipped
 * and each `data: <json>` line is translated independently (section
 * 3.5.10). Downstream, every translated event is framed as
 * `event: <name>\ndata: <json>\n\n\n` (three newlines; recorded framing),
 * and no `[DONE]` marker is ever sent to a Claude client (section 5).
 */
import { formatClaudeEvent } from './response'

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

/** One decoded upstream payload (per `data:` line; the name is ignored). */
export interface UpstreamDataLine {
  readonly data: string
}

/**
 * Decodes a byte or text chunk source into upstream `data:` payloads.
 * Handles re-chunked transport (frames split across chunks), `\r\n`
 * line endings, comment lines and `event:` names.
 */
export async function* decodeUpstreamDataLines(
  source: AsyncIterable<string | Uint8Array>,
): AsyncIterable<UpstreamDataLine> {
  // One decoder per stream: a TextDecoder holds the unfinished tail of a
  // multibyte sequence between decode calls, so a decoder shared across
  // streams would leak one stream's pending bytes into another.
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
      if (line.startsWith('event:')) continue
      if (line.trim() === 'data: [DONE]') continue
      if (line.startsWith('data:')) {
        yield { data: fieldBody(line.slice(5)) }
      }
    }
  }
  // A trailing `data:` line without a newline terminator is still
  // delivered; complete streams always end with a newline.
  if (buffer.startsWith('data:')) {
    yield { data: fieldBody(buffer.slice(5)) }
  }
}

import { serializeOrdered } from './json'

/** Downstream frame of the stream pipeline (already framed event text). */
export type DownstreamFrame =
  | { readonly kind: 'chunk'; readonly payload: string }
  | { readonly kind: 'terminal-error'; readonly message: string }

/**
 * Frames one pipeline result for the downstream wire: translated chunks
 * are already framed (three newlines per event); the terminal transport
 * failure carries the Claude error payload with TWO-newline framing
 * (recorded: S2d8-17).
 */
export function frameDownstream(frame: DownstreamFrame): string {
  if (frame.kind === 'terminal-error') {
    const payload = serializeOrdered({
      type: 'error',
      error: { type: 'api_error', message: frame.message },
    })
    return `event: error\ndata: ${payload}\n\n`
  }
  return frame.payload
}

export { formatClaudeEvent }

/** Splits a downstream Claude SSE body into its `event:`/`data:` pairs. */
export function parseDownstreamSse(text: string): ReadonlyArray<{ readonly event?: string; readonly data: string }> {
  const frames: Array<{ event?: string; data: string }> = []
  for (const block of text.split('\n\n')) {
    let event: string | undefined
    const dataLines: string[] = []
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = fieldBody(line.slice(6))
      else if (line.startsWith('data:')) dataLines.push(fieldBody(line.slice(5)))
    }
    if (event === undefined && dataLines.length === 0) continue
    frames.push({ event, data: dataLines.join('\n') })
  }
  return frames
}
