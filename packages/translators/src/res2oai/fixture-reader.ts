/**
 * Test-only reader for the oracle-recorded S2d6 goldens
 * (tests/fixtures/S2d6, RECIPES layout) plus the recording case
 * definitions (spec/recordings/S2d6.cases.json, which carry the mock
 * controls the fixtures do not inline). Runtime code never imports this
 * module; the vitest suites use it to replay recorded cases.
 */
import { readFileSync } from 'node:fs'

export const FIXTURE_ROOT = 'tests/fixtures/S2d6'
export const CASES_FILE = 'spec/recordings/S2d6.cases.json'

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

/** Scripted SSE reply of one recorded case. */
export interface RecordedScript {
  readonly events: readonly unknown[]
  readonly terminator: string | null
}

/** Mock control of one recorded case (fixture file or case definition). */
export interface RecordedMock {
  readonly mode: string
  readonly status: number | undefined
  readonly after: number | undefined
  /** Scripted SSE reply; absent when neither the fixture nor the case definition carries one. */
  readonly script: RecordedScript | undefined
  /** Non-stream canned reply (compacted JSON on the wire). */
  readonly nonStreamReply: unknown
  /** Error-mode reply body (the recorder's Python json.dumps spacing). */
  readonly errorBody: unknown
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
  // The oracle transcripts use CRLF line endings; normalize so body and
  // frame comparisons see LF-only text (the bodies themselves are
  // single-line, so no payload bytes are affected).
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
}

/** Reads the client request of one recorded case. */
export function readRecordedRequest(caseId: string): RecordedRequest {
  return parseRequestFile(readText(`${FIXTURE_ROOT}/${caseId}/request.http`))
}

/** Reads all upstream wire records of one recorded case, in order. */
export function readRecordedUpstreams(caseId: string): readonly RecordedUpstream[] {
  const text = readText(`${FIXTURE_ROOT}/${caseId}/upstream.jsonl`)
  const lines = text.split('\n').filter((line) => line.trim().length > 0)
  return lines.map((line) => {
    const record = JSON.parse(line) as { method?: unknown; path?: unknown; headers?: unknown; body?: unknown }
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

/** All fenced code blocks of a downstream.md, in order. */
function fencedBlocks(text: string): ReadonlyArray<readonly string[]> {
  const lines = text.split('\n')
  const blocks: Array<readonly string[]> = []
  let index = 0
  while (index < lines.length) {
    if ((lines[index] ?? '').startsWith('```')) {
      const content: string[] = []
      index += 1
      while (index < lines.length && !(lines[index] ?? '').startsWith('```')) {
        content.push(lines[index] ?? '')
        index += 1
      }
      blocks.push(content)
    }
    index += 1
  }
  return blocks
}

/**
 * Reads the recorded downstream response. The body is the second fenced
 * block minus its trailing newline (the recorder closes the fence on its
 * own line) - Content-Length pins the cut byte-exactly.
 */
export function readRecordedDownstream(caseId: string): RecordedDownstream {
  const blocks = fencedBlocks(readText(`${FIXTURE_ROOT}/${caseId}/downstream.md`))
  const head = blocks[0]
  const bodyBlock = blocks[1]
  if (head === undefined || bodyBlock === undefined) {
    throw new Error(`downstream.md of ${caseId} misses a fenced block`)
  }
  const statusLine = head[0] ?? ''
  const statusMatch = /HTTP\/1\.1 (\d+)/.exec(statusLine)
  if (statusMatch === null) throw new Error(`downstream.md of ${caseId} has no status line`)
  const headers: Record<string, string> = {}
  for (const line of head.slice(1)) {
    if (line.trim() === '') continue
    const separator = line.indexOf(': ')
    if (separator <= 0) continue
    headers[line.slice(0, separator)] = line.slice(separator + 2)
  }
  const bodyText = bodyBlock.join('\n')
  return {
    status: Number(statusMatch[1]),
    headers,
    body: bodyText.endsWith('\n') ? bodyText.slice(0, -1) : bodyText,
  }
}

interface CaseDefinition {
  readonly id?: unknown
  readonly mock?: unknown
  readonly mock_response_nonstream?: unknown
  readonly mock_response_sse?: unknown
}

function readCaseDefinitions(): Readonly<Record<string, CaseDefinition>> {
  const parsed = JSON.parse(readText(CASES_FILE)) as { cases?: unknown }
  const out: Record<string, CaseDefinition> = {}
  if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed['cases'])) {
    for (const entry of parsed['cases'] as readonly unknown[]) {
      if (typeof entry !== 'object' || entry === null) continue
      const record = entry as CaseDefinition
      if (typeof record.id === 'string') out[record.id] = record
    }
  }
  return out
}

function readMockResponseFile(caseId: string): Record<string, unknown> | undefined {
  const path = `${FIXTURE_ROOT}/${caseId}/mock-response.json`
  try {
    return JSON.parse(readText(path)) as Record<string, unknown>
  } catch {
    return undefined
  }
}

/**
 * Assembles the recorded mock control of one case. Scripted SSE replies
 * prefer the fixture's mock-response.json, then the case definition;
 * disconnect and slow cases record only their control (mode/after/delay)
 * and replay the default stream script (the caller supplies the fallback
 * script of S2d6-stream-basic).
 */
export function readRecordedMock(
  caseId: string,
  fallbacks: { readonly script?: RecordedScript; readonly nonStreamReply?: unknown } = {},
): RecordedMock {
  const definition = readCaseDefinitions()[caseId]
  const control =
    typeof definition?.mock === 'object' && definition.mock !== null
      ? (definition.mock as Record<string, unknown>)
      : {}
  const file = readMockResponseFile(caseId)
  const definitionSse =
    typeof definition?.mock_response_sse === 'object' && definition.mock_response_sse !== null
      ? (definition.mock_response_sse as Record<string, unknown>)
      : undefined

  let script: RecordedScript | undefined = undefined
  if (file !== undefined && Array.isArray(file['events'])) {
    script = {
      events: file['events'] as readonly unknown[],
      terminator: typeof file['terminator'] === 'string' ? file['terminator'] : null,
    }
  } else if (definitionSse !== undefined && Array.isArray(definitionSse['events'])) {
    script = {
      events: definitionSse['events'] as readonly unknown[],
      terminator: typeof definitionSse['terminator'] === 'string' ? definitionSse['terminator'] : null,
    }
  } else if (fallbacks.script !== undefined) {
    script = fallbacks.script
  }

  const nonStreamReply =
    file !== undefined && file['events'] === undefined
      ? file
      : definition?.mock_response_nonstream !== undefined
        ? definition.mock_response_nonstream
        : fallbacks.nonStreamReply

  return {
    mode: typeof control['mode'] === 'string' ? control['mode'] : 'happy',
    status: typeof control['status'] === 'number' ? control['status'] : undefined,
    after: typeof control['after'] === 'number' ? control['after'] : undefined,
    script,
    nonStreamReply,
    errorBody:
      typeof control['error_body'] === 'object' && control['error_body'] !== null ? control['error_body'] : undefined,
  }
}
