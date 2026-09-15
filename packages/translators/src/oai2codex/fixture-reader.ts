/**
 * Test-only reader for the oracle-recorded S2d5 goldens
 * (tests/fixtures/S2d5, RECIPES layout). Runtime code never imports this
 * module; the vitest suites use it to replay recorded cases.
 *
 * S2d5 layout: `request.http` holds one `### R<n>` block per recorded
 * request; `downstream.md` holds one `## R<n>` section per recorded
 * response; `upstream.jsonl` holds one wire line per request that actually
 * reached the upstream (cooldown steps record none).
 */

import { readFileSync } from 'node:fs'

export const FIXTURE_ROOT = 'tests/fixtures/S2d5'

export interface RecordedRequest {
  readonly method: string
  readonly path: string
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
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}

/** Splits one `### R<n>` request block into method/path/headers/body. */
function parseRequestBlock(block: string): RecordedRequest {
  const lines = block.split('\n')
  let index = 0
  while (index < lines.length && (lines[index] ?? '').startsWith('#')) index++
  const requestLine = lines[index] ?? ''
  const parts = requestLine.split(' ')
  const headers: Record<string, string> = {}
  index += 1
  while (index < lines.length && (lines[index] ?? '').trim().length > 0) {
    const line = lines[index] ?? ''
    const colon = line.indexOf(':')
    if (colon > 0) headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim()
    index += 1
  }
  while (index < lines.length && (lines[index] ?? '').trim().length === 0) index++
  const body = lines.slice(index).join('\n').replace(/\n$/, '')
  return { method: parts[0] ?? '', path: parts[1] ?? '', headers, body }
}

/** Splits one `## R<n>` response section into status/headers/body. */
function parseDownstreamBlock(block: string): RecordedDownstream {
  const lines = block.split('\n')
  const statusIndex = lines.findIndex((line) => line.startsWith('HTTP/1.1 '))
  const statusMatch = /HTTP\/1\.1 (\d+)/.exec(lines[statusIndex] ?? '')
  const status = statusMatch !== null ? Number(statusMatch[1]) : 0
  const headers: Record<string, string> = {}
  let index = statusIndex + 1
  while (index >= 0 && index < lines.length && (lines[index] ?? '').trim().length > 0) {
    const line = lines[index] ?? ''
    const colon = line.indexOf(':')
    if (colon > 0) headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim()
    index += 1
  }
  const bodyMarker = block.indexOf('### Body')
  const section = block.slice(bodyMarker)
  const openFence = section.indexOf('\n```')
  const closeFence = section.indexOf('```', openFence + 4)
  const body = section.slice(openFence + 4, closeFence).replace(/^\n/, '').replace(/\n$/, '')
  return { status, headers, body }
}

/** All recorded client requests of a case, in R-order. */
export function readRecordedRequests(caseId: string): readonly RecordedRequest[] {
  const text = readText(`${FIXTURE_ROOT}/${caseId}/request.http`)
  const blocks = text.split(/\n(?=### R\d)/).filter((block) => /^### R\d/.test(block.trim()))
  return blocks.map((block) => parseRequestBlock(block.trim()))
}

/** All recorded downstream responses of a case, in R-order. */
export function readRecordedDownstreams(caseId: string): readonly RecordedDownstream[] {
  const text = readText(`${FIXTURE_ROOT}/${caseId}/downstream.md`)
  const blocks = text.split(/\n(?=## R\d)/).filter((block) => /^## R\d/.test(block.trim()))
  return blocks.map((block) => parseDownstreamBlock(block.trim()))
}

/** Reads all upstream wire records (one per upstream call, in order). */
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

/** Mock control + embedded script events of a case. */
export interface MockRecord {
  readonly control: Readonly<Record<string, unknown>>
  readonly scriptEvents: readonly Record<string, unknown>[]
}

/** Reads the mock control record and any embedded script events. */
export function readMockResponse(caseId: string): MockRecord {
  const parsed = JSON.parse(readText(`${FIXTURE_ROOT}/${caseId}/mock-response.json`)) as Record<string, unknown>
  const control = parsed['control_file']
  if (typeof control !== 'object' || control === null) {
    throw new Error(`${caseId}: mock-response.json has no control_file`)
  }
  const events = parsed['script_events']
  const scriptEvents: Record<string, unknown>[] = []
  if (Array.isArray(events)) {
    for (const entry of events) {
      if (typeof entry === 'object' && entry !== null) scriptEvents.push(entry as Record<string, unknown>)
    }
  }
  return { control: control as Record<string, unknown>, scriptEvents }
}

function readText(path: string): string {
  // The oracle transcripts use CRLF line endings; normalize so body and
  // frame comparisons see LF-only text (the bodies themselves are
  // single-line, so no payload bytes are affected).
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
}
