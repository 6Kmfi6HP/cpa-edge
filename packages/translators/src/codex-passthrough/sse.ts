
/**
 * Incremental SSE line scanner for the passthrough stream (S2d9 4.1/4.2).
 *
 * The reference reassembles whatever the upstream writes - comment lines,
 * `event:` lines, `data:` lines with or without the optional space,
 * payloads split across TCP chunk boundaries, LF or CRLF endings - and
 * forwards every COMPLETE frame as one downstream chunk. This scanner
 * feeds that reassembly one line at a time: each completed line arrives
 * with its own terminator, blank lines arrive as frame-terminator signals,
 * and the source end is reported once. Callers hold non-data lines that
 * have no data line yet and glue them onto the following frame (the
 * recorded keepalive behavior).
 */

/** One completed upstream line (terminator excluded from `raw`). */
export interface SseLineEvent {
  readonly kind: 'line'
  readonly raw: string
  readonly ending: '\n' | '\r\n'
  /** Payload of a `data:` line (one optional space stripped); absent otherwise. */
  readonly data?: string
}

/** One blank line - the frame terminator signal, with its own ending. */
export interface SseBlankEvent {
  readonly kind: 'blank'
  readonly ending: '\n' | '\r\n'
}

/** The byte source ended (the final decoder flush already applied). */
export interface SseEndEvent {
  readonly kind: 'end'
}

export type SseScanItem = SseLineEvent | SseBlankEvent | SseEndEvent

interface LineSplit {
  readonly line: string
  readonly ending: '\n' | '\r\n'
  readonly consumed: number
}

/** Splits one line off the buffer; `undefined` while no terminator is present. */
function splitLine(text: string): LineSplit | undefined {
  const lf = text.indexOf('\n')
  if (lf < 0) return undefined
  const ending: '\n' | '\r\n' = lf > 0 && text.charCodeAt(lf - 1) === 0x0d ? '\r\n' : '\n'
  const line = ending === '\r\n' ? text.slice(0, lf - 1) : text.slice(0, lf)
  return { line, ending, consumed: lf + 1 }
}

/** Payload of a `data:` line: the text after `data:` minus one optional space. */
export function dataPayloadOf(raw: string): string | undefined {
  if (!raw.startsWith('data:')) return undefined
  return raw.startsWith('data: ') ? raw.slice('data: '.length) : raw.slice('data:'.length)
}

/**
 * Scans a byte or text chunk source into SSE lines, blank-line signals and
 * a final `end`. Splitting the source at different byte offsets yields
 * identical items (chunk-boundary independence, S2d9 4.2).
 */
export async function* scanSseLines(source: AsyncIterable<string | Uint8Array>): AsyncIterable<SseScanItem> {
  // One decoder per stream: a TextDecoder keeps the unfinished tail of a
  // multibyte sequence between chunks, so decoders must never be shared.
  const decoder = new TextDecoder()
  const iterator = source[Symbol.asyncIterator]()
  let buffer = ''
  let lastEnding: '\n' | '\r\n' = '\n'
  for (;;) {
    const next = await iterator.next()
    if (next.done === true) {
      buffer += decoder.decode()
      break
    }
    const chunk = next.value
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
    for (;;) {
      const split = splitLine(buffer)
      if (split === undefined) break
      buffer = buffer.slice(split.consumed)
      lastEnding = split.ending
      if (split.line.length === 0) {
        yield { kind: 'blank', ending: split.ending }
        continue
      }
      const data = dataPayloadOf(split.line)
      yield data === undefined ? { kind: 'line', raw: split.line, ending: split.ending } : { kind: 'line', raw: split.line, ending: split.ending, data }
    }
  }
  // A trailing unterminated line is still delivered (a truncated stream
  // keeps its last complete-looking token); anything else drops.
  const remainder = buffer
  if (remainder.length > 0) {
    const data = dataPayloadOf(remainder)
    yield data === undefined
      ? { kind: 'line', raw: remainder, ending: lastEnding }
      : { kind: 'line', raw: remainder, ending: lastEnding, data }
  }
  yield { kind: 'end' }
}

/** Frames one downstream data line with the normalized single space. */
export function formatDataLine(payload: string): string {
  return `data: ${payload}`
}

/**
 * Parses a downstream wire stream into its `(event, data)` pairs for
 * tests: blocks split on blank lines, one `event:` and the joined
 * `data:` payloads each.
 */
export function parseDownstreamSse(text: string): ReadonlyArray<{ readonly event?: string; readonly data: string }> {
  const frames: Array<{ event?: string; data: string }> = []
  for (const block of text.split('\n\n')) {
    let event: string | undefined
    const dataLines: string[] = []
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice('event: '.length)
      else if (line.startsWith('data: ')) dataLines.push(line.slice('data: '.length))
      else if (line === 'event:') event = ''
    }
    if (event === undefined && dataLines.length === 0) continue
    frames.push({ event, data: dataLines.join('\n') })
  }
  return frames
}
