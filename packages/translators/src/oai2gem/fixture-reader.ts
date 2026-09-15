/**
 * Test-only reader for the oracle-recorded S2d1 goldens
 * (tests/fixtures/S2d1, RECIPES layout). Runtime code never imports this
 * module; the vitest suites use it to replay the recorded cases.
 */
import { readFileSync, readdirSync } from 'node:fs'

export const FIXTURE_ROOT = 'tests/fixtures/S2d1'

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
}

/** meta.yaml of one recorded case. */
export interface CaseMeta {
  readonly case: string
  readonly alias: string
  readonly upstreamModel: string
  readonly stream: boolean
  readonly observedUpstreamLines: number
  readonly observedHttpStatus: number
}

/** mock-response.json of one recorded case. */
export interface MockFile {
  readonly control: Readonly<Record<string, unknown>>
  readonly scripted: unknown
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

/** Reads the recorded downstream response (status + exact body bytes). */
export function readRecordedDownstream(caseId: string): RecordedDownstream {
  const text = readText(`${FIXTURE_ROOT}/${caseId}/downstream.md`)
  const lines = text.split('\n')
  const sectionStart = (marker: string): number => {
    const index = lines.findIndex((line) => line.startsWith(marker))
    if (index === -1) throw new Error(`${caseId}: downstream.md misses ${marker}`)
    return index
  }

  const statusIndex = sectionStart('## Status line')
  const statusLine = lines[statusIndex + 1] ?? ''
  const statusMatch = /HTTP\/1\.1 (\d+)/.exec(statusLine)
  if (statusMatch === null) throw new Error(`${caseId}: no status line`)

  const headersIndex = sectionStart('## Response headers')
  const headers: Record<string, string> = {}
  for (const line of lines.slice(headersIndex + 1)) {
    if (line === '') break
    const separator = line.indexOf(': ')
    if (separator <= 0) continue
    headers[line.slice(0, separator)] = line.slice(separator + 2)
  }

  const bodyIndex = sectionStart('## Body / SSE byte stream')
  let cursor = bodyIndex + 1
  while (cursor < lines.length && !(lines[cursor] ?? '').startsWith('```')) cursor += 1
  cursor += 1
  const content: string[] = []
  while (cursor < lines.length && !(lines[cursor] ?? '').startsWith('```')) {
    content.push(lines[cursor] ?? '')
    cursor += 1
  }
  return { status: Number(statusMatch[1]), headers, body: content.join('\n') }
}

/** Reads the case meta (alias, upstream model, stream flag). */
export function readCaseMeta(caseId: string): CaseMeta {
  const parsed = JSON.parse(readText(`${FIXTURE_ROOT}/${caseId}/meta.yaml`)) as Readonly<Record<string, unknown>>
  return {
    case: typeof parsed['case'] === 'string' ? parsed['case'] : '',
    alias: typeof parsed['alias'] === 'string' ? parsed['alias'] : '',
    upstreamModel: typeof parsed['upstream_model'] === 'string' ? parsed['upstream_model'] : '',
    stream: parsed['stream'] === true,
    observedUpstreamLines: typeof parsed['observed_upstream_lines'] === 'number' ? parsed['observed_upstream_lines'] : 0,
    observedHttpStatus: typeof parsed['observed_http_status'] === 'number' ? parsed['observed_http_status'] : 0,
  }
}

/** Reads the mock control + scripted reply of one recorded case. */
export function readMockResponse(caseId: string): MockFile {
  const parsed = JSON.parse(readText(`${FIXTURE_ROOT}/${caseId}/mock-response.json`)) as Readonly<
    Record<string, unknown>
  >
  const controlSource = parsed['control_file']
  const control: Record<string, unknown> = {}
  if (typeof controlSource === 'object' && controlSource !== null) {
    Object.assign(control, controlSource as Record<string, unknown>)
  }
  return { control, scripted: parsed['scripted_mock_response'] }
}

/** Lists the recorded case directories, sorted. */
export function listCaseIds(): readonly string[] {
  return readdirSync(FIXTURE_ROOT)
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

function readText(path: string): string {
  // The oracle transcripts use CRLF line endings; normalize so body and
  // frame comparisons see LF-only text (payload bytes are unaffected).
  return readFileSync(path, 'utf8').replaceAll('\r\n', '\n')
}
