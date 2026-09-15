/**
 * SSE framing helpers.
 *
 * The upstream Claude stream is decoded into per-data-line frames - the
 * reference translates each `data:` line independently, so a frame here is
 * one data payload with the enclosing `event:` name attached (the
 * translation switches on the payload's own `type` field and never reads
 * the name). Downstream, every translated chunk is framed as
 * `data: <json>\n\n` and successful streams close with `data: [DONE]\n\n`.
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
export async function* decodeSseFrames(
  source: AsyncIterable<string | Uint8Array>,
): AsyncIterable<SseFrame> {
  // One decoder per stream: under {stream: true} a TextDecoder holds the
  // unfinished tail of a multibyte sequence between decode calls, so a
  // decoder shared across streams would let one stream's pending bytes leak
  // into another live stream whenever a chunk boundary splits a character.
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
  // A trailing `data:` line without a newline terminator is still delivered
  // as a frame (a line scanner hands back the final unterminated token, so
  // a truncated stream keeps its last complete-looking payload); any other
  // unterminated line is dropped. Complete streams always end with a
  // newline, so this only fires on truncated inputs.
  if (buffer.startsWith('data:')) {
    yield { event: undefined, data: fieldBody(buffer.slice(5)) }
  }
}

/** Frames one translated payload as a downstream SSE data frame. */
export function formatSseData(payload: string): string {
  return `data: ${payload}\n\n`
}

/** Terminal frame of a successful downstream stream. */
export function formatSseDone(): string {
  return 'data: [DONE]\n\n'
}

/** Parses a downstream wire stream into its data payloads, in order. */
export function parseDownstreamSse(text: string): readonly string[] {
  const payloads: string[] = []
  for (const frame of text.split('\n\n')) {
    if (!frame.startsWith('data:')) continue
    const payload = fieldBody(frame.slice(5))
    payloads.push(payload)
  }
  return payloads
}
