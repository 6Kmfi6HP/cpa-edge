/**
 * Test-only reader for the oracle-recorded S2d3 goldens
 * (tests/fixtures/S2d3, RECIPES layout). Runtime code never imports this
 * module; the vitest suites use it to replay recorded cases.
 */

import { readFileSync } from 'node:fs'

export const FIXTURE_ROOT = 'tests/fixtures/S2d3'

export interface RecordedRequest {
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}

export interface RecordedUpstream {
  readonly method: string
  readonly path: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}

export interface RecordedDownstream {
  readonly status: number
  readonly body: string
}

/** Splits a raw `.http` transcript into headers + body. */
function parseRequestFile(text: string): RecordedRequest {
  const separator = text.indexOf('\n\n')
  const head = separator < 0 ? text : text.slice(0, separator)
  const body = separator < 0 ? '' : text.slice(separator + 2).replace(/\n$/, '')
  const headers: Record<string, string> = {}
  for (const line of head.split('\n').slice(1)) {
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim()
  }
  return { headers, body }
}

function requestFile(step: number): string {
  return step === 1 ? 'request.http' : `request-${step}.http`
}

function downstreamFile(step: number): string {
  return step === 1 ? 'downstream.md' : `downstream-${step}.md`
}

/** Reads the client request of one recording step. */
export function readRecordedRequest(caseId: string, step: number): RecordedRequest {
  const text = readText(`${FIXTURE_ROOT}/${caseId}/${requestFile(step)}`)
  return parseRequestFile(text)
}

/** Reads all upstream wire records (one per step, in order). */
export function readRecordedUpstreams(caseId: string): RecordedUpstream[] {
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

/** Reads the downstream response (status + exact body bytes) of one step. */
export function readRecordedDownstream(caseId: string, step: number): RecordedDownstream {
  const text = readText(`${FIXTURE_ROOT}/${caseId}/${downstreamFile(step)}`)
  const statusLine = text.split('\n')[0] ?? ''
  const statusMatch = /HTTP\/1\.1 (\d+)/.exec(statusLine)
  const status = statusMatch !== null ? Number(statusMatch[1]) : 0
  const bodyMarker = text.indexOf('## Body')
  const section = text.slice(bodyMarker)
  const openFence = section.indexOf('\n```')
  const closeFence = section.indexOf('```', openFence + 4)
  const body = section.slice(openFence + 4, closeFence).replace(/^\n/, '').replace(/\n$/, '')
  return { status, body }
}

/** Reads the mock control record (per-step control-file contents). */
export function readMockResponse(caseId: string): { readonly controls: readonly Record<string, unknown>[] } {
  const parsed = JSON.parse(readText(`${FIXTURE_ROOT}/${caseId}/mock-response.json`)) as {
    control_file_per_step?: unknown
  }
  const controls: Record<string, unknown>[] = []
  if (Array.isArray(parsed.control_file_per_step)) {
    for (const entry of parsed.control_file_per_step) {
      if (typeof entry === 'object' && entry !== null) controls.push(entry as Record<string, unknown>)
    }
  }
  return { controls }
}

/** Number of recorded request steps of a case. */
export function countRecordedSteps(caseId: string): number {
  return readRecordedUpstreams(caseId).length
}

function readText(path: string): string {
  // The oracle transcripts use CRLF line endings; normalize so body and
  // frame comparisons see LF-only text (the bodies themselves are
  // single-line, so no payload bytes are affected).
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
}

