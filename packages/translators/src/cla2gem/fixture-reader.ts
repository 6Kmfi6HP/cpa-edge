/**
 * Test-only reader for the oracle-recorded S2d8 goldens
 * (tests/fixtures/S2d8, RECIPES layout). Runtime code never imports this
 * module; the vitest suites use it to replay recorded cases.
 */
import { readFileSync } from 'node:fs'

export const FIXTURE_ROOT = 'tests/fixtures/S2d8'

/** Ordered client request of one recorded case. */
export interface RecordedRequest {
  readonly method: string
  readonly path: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}

/** One upstream wire record (a line of upstream.jsonl). */
export interface RecordedUpstream {
  readonly method: string
  readonly path: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}

/** Downstream response of one recorded case (status + exact body bytes). */
export interface RecordedDownstream {
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
  /** True when the recorded downstream is an SSE byte stream. */
  readonly sse: boolean
}

/** Mock control block of one recorded case (meta.yaml `mock_control`). */
export interface RecordedMock {
  readonly control: Readonly<Record<string, unknown>>
}

/** Splits a raw `.http` transcript into the request line, headers and body. */
function parseRequestFile(text: string): RecordedRequest {
  const boundary = text.indexOf('\n\n')
  const head = boundary === -1 ? text : text.slice(0, boundary)
  let rest = boundary === -1 ? '' : text.slice(boundary + 2)
  // The recorder separates the request head from the body with one extra
  // blank line.
  while (rest.startsWith('\n')) rest = rest.slice(1)
  const body = rest.endsWith('\n') ? rest.slice(0, -1) : rest
  const lines = head.split('\n')
  const requestLine = lines[0] ?? ''
  const parts = requestLine.split(' ')
  const headers: Record<string, string> = {}
  for (const line of lines.slice(1)) {
    const separator = line.indexOf(': ')
    if (separator <= 0) continue
    headers[line.slice(0, separator)] = line.slice(separator + 2)
  }
  return { method: parts[0] ?? '', path: parts[1] ?? '', headers, body }
}

function readText(path: string): string {
  // The oracle transcripts use CRLF line endings in some files; normalize
  // so body and frame comparisons see LF-only text (single-line JSON
  // bodies are unaffected).
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
}

/** Reads the client request of one recorded case. */
export function readRecordedRequest(caseId: string): RecordedRequest {
  return parseRequestFile(readText(`${FIXTURE_ROOT}/${caseId}/request.http`))
}

/** Reads all upstream wire records of one recorded case, in order. */
export function readRecordedUpstreams(caseId: string): readonly RecordedUpstream[] {
  const lines = readText(`${FIXTURE_ROOT}/${caseId}/upstream.jsonl`)
    .split('\n')
    .filter((line) => line.trim().length > 0)
  return lines.map((line) => {
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

/**
 * Reads the recorded downstream response. The `.md` transcript carries the
 * status line plus headers in one fence and the exact body bytes in a
 * second fence (`## body` for JSON surfaces, `## full SSE byte stream` for
 * SSE). The recorder's markdown template appends two trailing newlines
 * after SSE byte streams; they are not part of the stream itself.
 */
export function readRecordedDownstream(caseId: string): RecordedDownstream {
  const text = readText(`${FIXTURE_ROOT}/${caseId}/downstream.md`)
  const lines = text.split('\n')
  const fenced = (marker: string): string => {
    const start = lines.findIndex((line) => line.startsWith(marker))
    if (start === -1) throw new Error(`downstream.md of ${caseId} misses ${marker}`)
    let cursor = start + 1
    while (cursor < lines.length && !(lines[cursor] ?? '').startsWith('```')) cursor += 1
    cursor += 1
    const content: string[] = []
    while (cursor < lines.length && !(lines[cursor] ?? '').startsWith('```')) {
      content.push(lines[cursor] ?? '')
      cursor += 1
    }
    return content.join('\n')
  }
  const head = fenced('## Status + headers')
  const headLines = head.split('\n')
  const statusMatch = /HTTP\/1\.1 (\d+)/.exec(headLines[0] ?? '')
  if (statusMatch === null) throw new Error(`downstream.md of ${caseId} has no status line`)
  const headers: Record<string, string> = {}
  for (const line of headLines.slice(1)) {
    const separator = line.indexOf(': ')
    if (separator <= 0) continue
    headers[line.slice(0, separator)] = line.slice(separator + 2)
  }
  const sseMarker = '## full SSE byte stream'
  const hasSse = text.includes(sseMarker)
  const bodyMarker = hasSse ? sseMarker : '## body'
  let body = fenced(bodyMarker)
  if (hasSse) {
    // Strip the recorder template's two trailing newlines.
    if (body.endsWith('\n\n')) body = body.slice(0, -2)
  } else if (body.endsWith('\n')) {
    body = body.slice(0, -1)
  }
  return { status: Number(statusMatch[1]), headers, body, sse: hasSse }
}

/** Reads the mock control of one recorded case (meta.yaml `mock_control`). */
export function readMockControl(caseId: string): RecordedMock {
  const parsed = JSON.parse(readText(`${FIXTURE_ROOT}/${caseId}/meta.yaml`)) as {
    mock_control?: unknown
  }
  const control: Record<string, unknown> = {}
  if (typeof parsed.mock_control === 'object' && parsed.mock_control !== null) {
    Object.assign(control, parsed.mock_control as Record<string, unknown>)
  }
  return { control }
}
