/**
 * Test-only reader for the oracle-recorded S1 goldens this direction
 * replays (tests/fixtures/S1, RECIPES layout). Runtime code never
 * imports this module; the vitest suites use it to drive the facade
 * with the recorded bytes.
 */
import { readFileSync } from 'node:fs'

export const FIXTURE_ROOT = 'tests/fixtures/S1'

/** Ordered client request of one recorded case. */
export interface RecordedRequest {
  readonly method: string
  readonly path: string
  readonly headers: ReadonlyArray<readonly [string, string]>
  readonly body: string
}

/** Downstream golden of one recorded case (status + exact body bytes). */
export interface RecordedDownstream {
  readonly status: number
  readonly headers: ReadonlyArray<readonly [string, string]>
  readonly body: string
  /** `Content-Length` the golden declares, when present. */
  readonly contentLength: number | null
}

/** One upstream wire record (a line of upstream.jsonl). */
export interface RecordedUpstream {
  readonly method: string
  readonly path: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}

/** Scripted mock reply of one recorded case. */
export interface RecordedMock {
  readonly mode: string
  readonly nonStreamReply: Record<string, unknown> | undefined
  readonly sseFrames: readonly string[] | undefined
}

function readText(path: string): string {
  return readFileSync(path, 'utf8')
}

/**
 * Splits one `*.request.http` transcript into the request line, ordered
 * headers and the exact body bytes. The file format ends the head with a
 * blank line and opens the body with one more newline; the recorded
 * `Content-Length` decides how many of those edge newlines were sent.
 */
export function readRecordedRequest(caseId: string, file: string): RecordedRequest {
  const text = readText(`${FIXTURE_ROOT}/${caseId}/${file}`)
  const separator = text.indexOf('\n\n')
  if (separator < 0) throw new Error(`${caseId}/${file}: missing head/body separator`)
  const head = text.slice(0, separator)
  let bodyText = text.slice(separator + 2)
  const lines = head.split('\n')
  const requestLine = (lines[0] ?? '').split(' ')
  if (requestLine.length !== 3) throw new Error(`${caseId}/${file}: malformed request line`)
  const headers: Array<[string, string]> = []
  let contentLength: number | null = null
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(': ')
    if (colon < 0) continue
    const name = line.slice(0, colon)
    const value = line.slice(colon + 2)
    if (name.toLowerCase() === 'content-length') contentLength = Number(value)
    headers.push([name, value])
  }
  if (bodyText.startsWith('\n')) bodyText = bodyText.slice(1)
  if (bodyText.endsWith('\n')) bodyText = bodyText.slice(0, -1)
  if (contentLength !== null && new TextEncoder().encode(bodyText).length !== contentLength) {
    throw new Error(
      `${caseId}/${file}: body is ${new TextEncoder().encode(bodyText).length} bytes, Content-Length declares ${contentLength}`,
    )
  }
  return { method: requestLine[0] ?? '', path: requestLine[1] ?? '', headers, body: bodyText }
}

const HEAD_FENCE = /## Status[^\n]*\n```\n([\s\S]*?)\n```/
const BODY_FENCE = /\n## [Bb]ody[^\n]*\n```\n([\s\S]*?)\n```/

/**
 * Reads one recorded downstream response. The head fence pins status and
 * the ordered response headers; the body fence pins the exact body
 * bytes. A display newline the renderer may have appended after a
 * non-stream body is removed only when the golden `Content-Length`
 * confirms it was not part of the payload.
 */
export function readRecordedDownstream(caseId: string, file: string): RecordedDownstream {
  const text = readText(`${FIXTURE_ROOT}/${caseId}/${file}`)
  const headMatch = HEAD_FENCE.exec(text)
  if (headMatch === null) throw new Error(`${caseId}/${file}: missing response-head fence`)
  const headLines = (headMatch[1] ?? '').split('\n')
  const statusMatch = /^HTTP\/1\.1 (\d{3}) /.exec(headLines[0] ?? '')
  if (statusMatch === null) throw new Error(`${caseId}/${file}: missing HTTP/1.1 status line`)
  const headers: Array<[string, string]> = []
  let contentLength: number | null = null
  for (const line of headLines.slice(1)) {
    const colon = line.indexOf(': ')
    if (colon < 0) continue
    const name = line.slice(0, colon)
    const value = line.slice(colon + 2)
    if (name.toLowerCase() === 'content-length') contentLength = Number(value)
    headers.push([name, value])
  }
  const bodyMatch = BODY_FENCE.exec(text)
  if (bodyMatch === null) throw new Error(`${caseId}/${file}: missing body fence`)
  let body = bodyMatch[1] ?? ''
  if (
    body.endsWith('\n') &&
    contentLength !== null &&
    new TextEncoder().encode(body).length - 1 === contentLength
  ) {
    body = body.slice(0, -1)
  }
  return { status: Number(statusMatch[1]), headers, body, contentLength }
}

/** All upstream wire records of one case, in request order. */
export function readRecordedUpstreams(caseId: string): readonly RecordedUpstream[] {
  const text = readText(`${FIXTURE_ROOT}/${caseId}/upstream.jsonl`)
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const record = JSON.parse(line) as {
        method?: unknown
        path?: unknown
        headers?: unknown
        body?: unknown
      }
      const headers: Record<string, string> = {}
      if (typeof record.headers === 'object' && record.headers !== null) {
        for (const [name, value] of Object.entries(record.headers as Record<string, unknown>)) {
          headers[name] = String(value)
        }
      }
      return {
        method: typeof record.method === 'string' ? record.method : '',
        path: typeof record.path === 'string' ? record.path : '',
        headers,
        body: typeof record.body === 'string' ? record.body : '',
      }
    })
}

/** The scripted mock reply of one recorded case. */
export function readRecordedMock(caseId: string): RecordedMock {
  const parsed = JSON.parse(readText(`${FIXTURE_ROOT}/${caseId}/mock-response.json`)) as {
    mode?: unknown
    canned_non_stream?: unknown
    canned_sse_frames?: unknown
  }
  return {
    mode: typeof parsed.mode === 'string' ? parsed.mode : 'happy',
    nonStreamReply:
      typeof parsed.canned_non_stream === 'object' && parsed.canned_non_stream !== null
        ? (parsed.canned_non_stream as Record<string, unknown>)
        : undefined,
    sseFrames: Array.isArray(parsed.canned_sse_frames)
      ? (parsed.canned_sse_frames as unknown[]).filter((frame): frame is string => typeof frame === 'string')
      : undefined,
  }
}
