/**
 * SSE framing helpers for the res2oai direction (S2d6 section 4.1).
 *
 * Upstream: the chat SSE stream is decoded into per-data-line frames; the
 * translation switches on each payload's parsed shape (and the enclosing
 * `event:` name only for the error classification). Downstream: every
 * translated event is framed as `event: <type>\ndata: <json>\n\n` - single
 * space after each colon, LF endings, no `id:`/`retry:` lines, no `[DONE]`
 * marker. Terminal error frames carry one leading `\n`; a clean close
 * after a terminal event writes one extra `\n` byte.
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
 * Decodes a byte or text chunk source into SSE frames. Handles re-chunked
 * transport (frames split across chunks), `\r\n` line endings, comment
 * lines and `event:` names.
 */
export async function* decodeSseFrames(source: AsyncIterable<string | Uint8Array>): AsyncIterable<SseFrame> {
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
      }
    }
  }
  // A trailing `data:` line without a newline terminator is still
  // delivered as a frame; any other unterminated line drops.
  if (buffer.startsWith('data:')) {
    yield { event: undefined, data: fieldBody(buffer.slice(5)) }
  }
}

/** One emitted downstream stream unit, before byte framing. */
export type ResponsesStreamFrame =
  | { readonly kind: 'event'; readonly event: string; readonly data: string }
  | { readonly kind: 'error-frame'; readonly text: string }
  | { readonly kind: 'end' }

/** Frames one translated event: `event: <type>\ndata: <json>\n\n`. */
export function frameEvent(event: string, data: string): string {
  return `event: ${event}\ndata: ${data}\n\n`
}

/** Byte form of one stream unit (the trailing `\n` end marker included). */
export function frameBytes(frame: ResponsesStreamFrame): string {
  if (frame.kind === 'event') return frameEvent(frame.event, frame.data)
  if (frame.kind === 'error-frame') return frame.text
  return '\n'
}

/** Parses a downstream wire stream into its `(event, data)` pairs, in order. */
export function parseDownstreamSse(text: string): ReadonlyArray<{ readonly event?: string; readonly data: string }> {
  const frames: Array<{ event?: string; data: string }> = []
  for (const block of text.split('\n\n')) {
    let event: string | undefined
    const dataLines: string[] = []
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice('event: '.length)
      else if (line.startsWith('data: ')) dataLines.push(line.slice('data: '.length))
    }
    if (event === undefined && dataLines.length === 0) continue
    frames.push({ event, data: dataLines.join('\n') })
  }
  return frames
}
