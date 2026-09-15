/**
 * Test-only reader for the oracle-recorded S2d7 goldens
 * (tests/fixtures/S2d7, RECIPES layout). Runtime code never imports this
 * module; the vitest suites use it to replay recorded cases.
 */
import { readFileSync } from 'node:fs'

export const FIXTURE_ROOT = 'tests/fixtures/S2d7'

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
  return readDownstreamFile(`${FIXTURE_ROOT}/${caseId}/downstream.md`)
}

function readDownstreamFile(path: string): RecordedDownstream {
  const text = readText(path)
  const lines = text.split('\n')
  const fenced = (marker: string): string[] => {
    const start = lines.findIndex((line) => line.startsWith(marker))
    if (start === -1) throw new Error(`${path} misses ${marker}`)
    let cursor = start + 1
    while (cursor < lines.length && !(lines[cursor] ?? '').startsWith('```')) cursor += 1
    cursor += 1
    const content: string[] = []
    while (cursor < lines.length && !(lines[cursor] ?? '').startsWith('```')) {
      content.push(lines[cursor] ?? '')
      cursor += 1
    }
    return content
  }
  const headLines = fenced('### Response head')
  const bodyLines = fenced('### Body')
  const statusLine = headLines[0] ?? ''
  const statusMatch = /HTTP\/1\.1 (\d+)/.exec(statusLine)
  if (statusMatch === null) throw new Error(`${path} has no status line`)
  const headers: Record<string, string> = {}
  for (const line of headLines.slice(1)) {
    if (line.trim() === '') continue
    const separator = line.indexOf(': ')
    if (separator <= 0) continue
    headers[line.slice(0, separator)] = line.slice(separator + 2)
  }
  return { status: Number(statusMatch[1]), headers, body: bodyLines.join('\n') }
}

/** Mock control + scripted events of one recorded case. */
export interface MockFile {
  readonly control: Readonly<Record<string, unknown>>
  readonly script: ReadonlyArray<readonly [string, unknown]>
  readonly reply: { readonly status?: unknown; readonly body?: unknown } | undefined
}

export function readMockResponse(caseId: string): MockFile {
  return readMockFile(`${FIXTURE_ROOT}/${caseId}/mock-response.json`, 'control_file')
}

/** Mock control of one step of a multi-step case (`control_file_stepN`). */
export function readStepMockResponse(caseId: string, step: number): MockFile {
  return readMockFile(`${FIXTURE_ROOT}/${caseId}/mock-response.json`, `control_file_step${step}`)
}

function readMockFile(path: string, controlKey: string): MockFile {
  const parsed = JSON.parse(readText(path)) as Readonly<Record<string, unknown>>
  const controlSource = parsed[controlKey]
  const control: Record<string, unknown> = {}
  if (typeof controlSource === 'object' && controlSource !== null) {
    Object.assign(control, controlSource as Record<string, unknown>)
  }
  const script: Array<readonly [string, unknown]> = []
  const scriptSource = parsed['script_sse']
  if (Array.isArray(scriptSource)) {
    for (const entry of scriptSource) {
      if (Array.isArray(entry) && entry.length === 2) {
        script.push([String(entry[0]), entry[1]])
      }
    }
  }
  const replySource = parsed['reply']
  const reply =
    typeof replySource === 'object' && replySource !== null
      ? (replySource as { status?: unknown; body?: unknown })
      : undefined
  return { control, script, reply }
}

/** One step of a multi-step recorded case: its request and downstream pair. */
export interface RecordedStep {
  readonly request: RecordedRequest
  readonly downstream: RecordedDownstream
}

/**
 * Reads a multi-step recorded case: request.http carries one `### step N …`
 * divider per step, each followed by one request block, and the step's
 * downstream surface lives in downstream-N.md (recorded: S2d7-31).
 */
export function readRecordedSteps(caseId: string): readonly RecordedStep[] {
  const lines = readText(`${FIXTURE_ROOT}/${caseId}/request.http`).split('
')
  const blocks: string[][] = []
  for (const line of lines) {
    if (line.startsWith('### step ')) {
      blocks.push([])
      continue
    }
    if (blocks.length === 0) continue
    const block = blocks[blocks.length - 1]
    if (block === undefined) continue
    block.push(line)
  }
  return blocks.map((block, index) => ({
    request: parseRequestFile(block.join('
')),
    downstream: readDownstreamFile(`${FIXTURE_ROOT}/${caseId}/downstream-${index + 1}.md`),
  }))
}

function readText(path: string): string {
  // The oracle transcripts use CRLF line endings; normalize so body and
  // frame comparisons see LF-only text (the bodies themselves are
  // single-line, so no payload bytes are affected).
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
}
