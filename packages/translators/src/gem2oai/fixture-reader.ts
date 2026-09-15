/**
 * Test-only reader for the oracle-recorded S2d2 goldens
 * (tests/fixtures/S2d2, RECIPES layout). Runtime code never imports this
 * module; the vitest suites use it to replay the recorded cases.
 */

import { readFileSync } from 'node:fs'

export const FIXTURE_ROOT = 'tests/fixtures/S2d2'

export interface RecordedRequest {
  readonly method: string
  readonly path: string
  readonly headers: ReadonlyArray<readonly [string, string]>
  readonly body: string
}

export interface RecordedResponse {
  readonly status: number
  readonly headers: ReadonlyArray<readonly [string, string]>
  readonly body: string
  readonly claimedBodyBytes: number
}

export interface RecordedUpstream {
  readonly method: string
  readonly path: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}

export interface MockControlFile {
  readonly mode?: string
  readonly status?: number
  readonly scenario?: string
  readonly after?: number
  readonly delay_ms?: number
}

export interface MockReply {
  readonly status?: number
  readonly response_body?: string
  readonly body_raw?: string
  readonly sse_frames?: readonly string[]
}

export interface MockResponseFile {
  readonly control_file?: MockControlFile
  readonly reply?: MockReply | null
}

export interface CaseMeta {
  readonly case: string
  readonly dynamic_fields: readonly string[]
  readonly upstream_wire_lines_per_request: readonly number[]
}

function readText(path: string): string {
  // Fixture files carry CRLF terminators; every compared surface is
  // CR-free, so terminators are normalized on read.
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
}

export function readCaseText(caseId: string, name: string): string {
  return readText(`${FIXTURE_ROOT}/${caseId}/${name}`)
}

export function readCaseJson<T>(caseId: string, name: string): T {
  return JSON.parse(readText(`${FIXTURE_ROOT}/${caseId}/${name}`)) as T
}

/** Splits request.http into its `### Rn` request blocks. */
export function readRecordedRequests(caseId: string): readonly RecordedRequest[] {
  const text = readCaseText(caseId, 'request.http')
  const blocks = text.split(/\n### R\d+[^\n]*\n/).slice(1)
  return blocks.map((block) => {
    const separator = block.indexOf('\n\n')
    if (separator < 0) throw new Error(`${caseId}: request block is missing a head/body separator`)
    const head = block.slice(0, separator)
    const body = block.slice(separator + 2).replace(/^\n+/, '').replace(/\n+$/, '')
    const lines = head.split('\n')
    const requestLine = (lines[0] ?? '').split(' ')
    const headers: Array<[string, string]> = []
    for (const line of lines.slice(1)) {
      const colon = line.indexOf(': ')
      if (colon <= 0) continue
      headers.push([line.slice(0, colon), line.slice(colon + 2)])
    }
    return { method: requestLine[0] ?? '', path: requestLine[1] ?? '', headers, body }
  })
}

/** Splits downstream.md into its `## Rn` response sections. */
export function readRecordedDownstreams(caseId: string): Readonly<Record<string, RecordedResponse>> {
  const text = `\n${readCaseText(caseId, 'downstream.md')}`
  const markers = [...text.matchAll(/\n## (R\d+)\n/g)]
  const sections: Record<string, RecordedResponse> = {}
  for (let index = 0; index < markers.length; index++) {
    const marker = markers[index]
    if (marker === undefined) continue
    const sectionId = marker[1] ?? ''
    const start = (marker.index ?? 0) + marker[0].length
    const next = markers[index + 1]
    const section = text.slice(start, next?.index ?? text.length)

    const headMatch = section.match(/```\n(HTTP\/1\.1[^\n]*)\n([\s\S]*?)\n```/)
    if (headMatch === null) throw new Error(`${caseId} ${sectionId}: missing response-head fence`)
    const statusLine = headMatch[1] ?? ''
    const status = Number(statusLine.split(' ')[1])
    const headers: Array<[string, string]> = []
    for (const line of (headMatch[2] ?? '').split('\n')) {
      const colon = line.indexOf(': ')
      if (colon <= 0) continue
      headers.push([line.slice(0, colon), line.slice(colon + 2)])
    }

    const bodyMatch = section.match(/### Body \((\d+) bytes, exact\)\n```\n([\s\S]*?)\n```/)
    if (bodyMatch === null) throw new Error(`${caseId} ${sectionId}: missing body fence`)
    sections[sectionId] = {
      status,
      headers,
      body: bodyMatch[2] ?? '',
      claimedBodyBytes: Number(bodyMatch[1]),
    }
  }
  return sections
}

/** Upstream wire log lines, in request order. */
export function readRecordedUpstreams(caseId: string): readonly RecordedUpstream[] {
  return readCaseText(caseId, 'upstream.jsonl')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as RecordedUpstream)
}

export function readMockResponse(caseId: string): MockResponseFile {
  return readCaseJson<MockResponseFile>(caseId, 'mock-response.json')
}

export function readCaseMeta(caseId: string): CaseMeta {
  return readCaseJson<CaseMeta>(caseId, 'meta.yaml')
}

/** All 26 admitted case ids, sorted. */
export function listCaseIds(): readonly string[] {
  return [
    'gem2oai-auth-styles',
    'gem2oai-auth-transports',
    'gem2oai-basic-params',
    'gem2oai-cooldown-after-429',
    'gem2oai-count-tokens',
    'gem2oai-count-tokens-tools',
    'gem2oai-error-429',
    'gem2oai-error-in-stream-payload',
    'gem2oai-model-resolution-errors',
    'gem2oai-models-list',
    'gem2oai-resp-nonstream-reasoning',
    'gem2oai-resp-nonstream-toolcall',
    'gem2oai-role-mapping',
    'gem2oai-stream-alt-json',
    'gem2oai-stream-disconnect',
    'gem2oai-stream-reasoning',
    'gem2oai-stream-slow',
    'gem2oai-stream-text-full',
    'gem2oai-stream-toolcall',
    'gem2oai-stream-toolcall-multi',
    'gem2oai-system-snake-multimodal',
    'gem2oai-thinking-clamps',
    'gem2oai-thinking-config',
    'gem2oai-thinking-invalid',
    'gem2oai-tool-roundtrip-request',
    'gem2oai-tools-toolconfig',
  ]
}
