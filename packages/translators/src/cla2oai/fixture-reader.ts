/**
 * Test-only reader for the oracle-recorded S2d4 goldens
 * (tests/fixtures/S2d4, RECIPES layout). Runtime code never imports this
 * module; the vitest suites use it to replay recorded cases.
 */
import { readFileSync } from 'node:fs'

export const FIXTURE_ROOT = 'tests/fixtures/S2d4'

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

/** Mock control of one recorded case (meta.yaml `mock_upstream_mode` + `mock_control_file`). */
export interface RecordedMock {
  readonly mode: string
  readonly control: Readonly<Record<string, unknown>>
}

/** Parsed `mock-response.json` of one recorded case. */
export interface RecordedMockReply {
  /** Canned non-stream reply object, when the case has one. */
  readonly servedObject: Record<string, unknown> | undefined
  /** Canned stream chunks: objects, or the `"[DONE]"` string. */
  readonly servedStream: readonly unknown[] | undefined
  /** Script-mode non-stream reply, when the control carries one. */
  readonly scriptedNonStream: Record<string, unknown> | undefined
  /** Script-mode stream events, when the control carries them. */
  readonly scriptedStream: readonly unknown[] | undefined
  /** Error-mode status, when the case is an error case. */
  readonly errorStatus: number | undefined
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
  // S2d4 transcripts open with a `### <case-id> STEP ...` comment line;
  // the request line is the first METHOD-formatted one.
  const requestAt = lines.findIndex((line) => /^[A-Z]+ \/[^ ]* HTTP\//.test(line))
  if (requestAt === -1) throw new Error('request.http has no request line')
  const requestLine = lines[requestAt] ?? ''
  const parts = requestLine.split(' ')
  const headers: Record<string, string> = {}
  for (const line of lines.slice(requestAt + 1)) {
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
 * Raw content between the code fences that follow a `###` marker in a
 * recorded downstream.md. The first byte is the newline after the
 * opening fence; body fences close after exactly one trailing newline,
 * SSE fences keep their full trailing `\n\n`.
 */
function fencedContent(text: string, marker: string): string {
  const markerAt = text.indexOf(marker)
  if (markerAt === -1) throw new Error(`downstream.md misses ${marker}`)
  const opening = text.indexOf('```', markerAt)
  if (opening === -1) throw new Error(`downstream.md has no fence after ${marker}`)
  let contentStart = opening + 3
  if (text[contentStart] === '\n') contentStart += 1
  const closing = text.indexOf('```', contentStart)
  if (closing === -1) throw new Error(`downstream.md has no closing fence after ${marker}`)
  return text.slice(contentStart, closing)
}

/**
 * Reads the recorded downstream response. The `.md` transcript carries
 * the status line plus headers in one fence, and the exact bytes in a
 * second fence (`### Body` for JSON surfaces, `### SSE byte stream` for
 * SSE).
 */
export function readRecordedDownstream(caseId: string): RecordedDownstream {
  const text = readText(`${FIXTURE_ROOT}/${caseId}/downstream.md`)
  const head = fencedContent(text, '### Status + response headers')
  const headLines = head.split('\n')
  const statusMatch = /HTTP\/1\.1 (\d+)/.exec(headLines[0] ?? '')
  if (statusMatch === null) throw new Error(`downstream.md of ${caseId} has no status line`)
  const headers: Record<string, string> = {}
  for (const line of headLines.slice(1)) {
    const separator = line.indexOf(': ')
    if (separator <= 0) continue
    headers[line.slice(0, separator)] = line.slice(separator + 2)
  }
  const sseMarker = '### SSE byte stream'
  const hasSse = text.includes(sseMarker)
  const bodyMarker = hasSse ? sseMarker : '### Body'
  let body = fencedContent(text, bodyMarker)
  // Body fences carry exactly one trailing newline that is not part of
  // the body; SSE fences keep their full trailing `\n\n`.
  if (!hasSse && body.endsWith('\n')) body = body.slice(0, -1)
  return { status: Number(statusMatch[1]), headers, body, sse: hasSse }
}

/** Reads the mock control + canned reply of one recorded case. */
export function readRecordedMock(caseId: string): { mock: RecordedMock; reply: RecordedMockReply } {
  const meta = JSON.parse(readText(`${FIXTURE_ROOT}/${caseId}/meta.yaml`)) as {
    mock_upstream_mode?: unknown
    mock_control_file?: unknown
  }
  const mode = typeof meta.mock_upstream_mode === 'string' ? meta.mock_upstream_mode : 'happy'
  const control: Record<string, unknown> = {}
  if (typeof meta.mock_control_file === 'object' && meta.mock_control_file !== null) {
    Object.assign(control, meta.mock_control_file as Record<string, unknown>)
  }
  const mockResponse = JSON.parse(readText(`${FIXTURE_ROOT}/${caseId}/mock-response.json`)) as {
    status?: unknown
    served?: unknown
  }
  const served = mockResponse.served
  const servedObject =
    typeof served === 'object' && served !== null && !Array.isArray(served)
      ? (served as Record<string, unknown>)
      : undefined
  const servedStream = Array.isArray(served) ? served : undefined
  const scriptedNonStream =
    typeof control['non_stream'] === 'object' && control['non_stream'] !== null
      ? (control['non_stream'] as Record<string, unknown>)
      : undefined
  const scriptedStream = Array.isArray(control['stream_events']) ? (control['stream_events'] as readonly unknown[]) : undefined
  const errorStatus = typeof mockResponse.status === 'number' ? mockResponse.status : undefined
  return {
    mock: { mode, control },
    reply: { servedObject, servedStream, scriptedNonStream, scriptedStream, errorStatus },
  }
}
