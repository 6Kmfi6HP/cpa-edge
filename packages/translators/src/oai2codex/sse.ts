/**
 * SSE framing helpers.
 *
 * The upstream Codex stream is decoded into per-data-line frames: the
 * translation switches on each payload's own `type` field, so a frame here
 * is one `data:` payload with the enclosing `event:` name attached but
 * never read. Downstream, every translated chunk is framed as
 * `data: <json>\n\n` and successful streams close with `data: [DONE]\n\n`.
 */
import type { CodexSseFrame } from './types'

interface LineSplit {
  readonly line: string
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
export async function* decodeSseFrames(source: AsyncIterable<string | Uint8Array>): AsyncIterable<CodexSseFrame> {
  // One decoder per stream: under {stream: true} a TextDecoder holds the
  // unfinished tail of a multibyte sequence between decode calls, so a
  // decoder shared across streams would leak one stream's pending bytes
  // into another live stream.
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
  // (a line scanner hands back the final unterminated token, so a truncated
  // stream keeps its last complete-looking payload); complete streams always
  // end with a newline, so this only fires on truncated inputs.
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
    payloads.push(fieldBody(frame.slice(5)))
  }
  return payloads
}

/**
 * Extracts the `data:` payloads of an aggregated upstream body (the
 * non-stream executor reads the whole body, then splits on newlines and
 * processes only `data:`-prefixed lines).
 */
export function scanDataLines(buffer: string): readonly string[] {
  const payloads: string[] = []
  for (const line of buffer.split('\n')) {
    if (!line.startsWith('data:')) continue
    payloads.push(fieldBody(line.slice(5)))
  }
  return payloads
}
