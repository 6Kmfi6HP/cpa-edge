/**
 * SSE framing helpers for the gem2cla direction.
 *
 * Upstream: the Claude stream is decoded into per-data-line frames - the
 * translation switches on each payload's own `type` field and never reads
 * the enclosing `event:` name. Downstream, every translated chunk is framed
 * as `data: <json>\n\n` with NO `event:` line and NO `[DONE]` marker
 * (S2d7 4.1); `alt=json` requests skip the framing entirely and
 * concatenate the raw chunk bytes (S2d7 4.2).
 */
import { formatTerminalErrorFrame, UNEXPECTED_EOF_MESSAGE } from './errors'
import type { DownstreamFraming, SseFrame } from './types'

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
  // as a frame; any other unterminated line is dropped. Complete streams
  // always end with a newline, so this only fires on truncated inputs.
  if (buffer.startsWith('data:')) {
    yield { event: undefined, data: fieldBody(buffer.slice(5)) }
  }
}

/**
 * One frame of the downstream stream: either a translated chunk or the
 * terminal failure frame written after a post-commit transport failure.
 */
export type GeminiStreamFrame =
  | { readonly kind: 'chunk'; readonly payload: string }
  | { readonly kind: 'terminal-error' }

/**
 * Wraps the chunk payloads emitted by the stream pipeline in the
 * downstream framing: `data: <payload>\n\n` per chunk for SSE mode, raw
 * concatenation for `alt=json`; the terminal failure frame keeps its
 * `event: error` block in both modes.
 */
export function frameForMode(frame: GeminiStreamFrame, framing: DownstreamFraming): string {
  if (frame.kind === 'terminal-error') return formatTerminalErrorFrame(UNEXPECTED_EOF_MESSAGE)
  return framing === 'sse' ? `data: ${frame.payload}\n\n` : frame.payload
}

/** Parses a downstream wire stream into its data payloads, in order. */
export function parseDownstreamSse(text: string): readonly string[] {
  const payloads: string[] = []
  for (const block of text.split('\n\n')) {
    if (!block.startsWith('data:')) continue
    payloads.push(fieldBody(block.slice(5)))
  }
  return payloads
}
