
/**
 * Golden replay of the S2d9 oracle fixtures (tests/fixtures/S2d9, 17
 * contract cases plus the S2d9-18 cooldown-window observation).
 *
 * Rulings applied: R-SSE (downstream SSE compares as the DECODED byte
 * stream, never transport chunk boundaries - the replay feeds the recorded
 * split writes of S2d9-17 as separate stream chunks), R-FIXTURE (every
 * case is a RECORDABLE-LOCALLY codex-api-key replay), NE-LENIENT (all
 * byte-replayed bodies are well-formed JSON), R-ORDER (inert here - the
 * passthrough forwards frames in arrival order).
 *
 * Masked dynamic fields per meta.yaml: the upstream `Authorization` value
 * (recorded as `<redacted>` by the mock) and the DERIVED session identity
 * (body `prompt_cache_key` + `Session-Id` header) whenever the client sent
 * no prompt_cache_key. Every other byte - upstream request bodies,
 * downstream statuses, headers and full SSE byte streams - compares
 * EXACTLY against the recordings.
 *
 * Session pairs (one shared service + Store, frozen clock): S2d9-11 ->
 * S2d9-12 (the 429 -> model_cooldown window) and S2d9-10 -> S2d9-18 (the
 * 404 -> auth_unavailable window), exactly as the oracle recorded them.
 */
import { describe, expect, test } from 'vitest'
import { MemoryStore } from '@cpa-edge/core'
import { readCase } from './fixture-reader'
import type { RecordedCase, RecordedUpstream } from './fixture-reader'
import { createCodexPassthroughService } from './service'
import type {
  CodexPassthroughRequest,
  CodexPassthroughResponse,
  CodexPassthroughService,
  CodexPassthroughUpstreamRequest,
  CodexPassthroughUpstreamResponse,
} from './service'

const FROZEN_NOW = 1_789_506_658_255

const SINGLE_CASES = [
  'S2d9-01',
  'S2d9-02',
  'S2d9-03',
  'S2d9-04',
  'S2d9-05',
  'S2d9-06',
  'S2d9-07',
  'S2d9-08',
  'S2d9-09',
  'S2d9-13',
  'S2d9-14',
  'S2d9-15',
  'S2d9-16',
  'S2d9-17',
] as const

interface CapturedUpstream {
  readonly request: CodexPassthroughUpstreamRequest
  readonly path: string
}

function streamOf(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

/** Serves one recorded case's scripted mock behavior. */
function recordedSend(caseRecord: RecordedCase, log: CapturedUpstream[]) {
  return async (request: CodexPassthroughUpstreamRequest): Promise<CodexPassthroughUpstreamResponse> => {
    log.push({ request, path: new URL(request.url).pathname })
    const mock = caseRecord.mock
    if (mock.httpError !== undefined) {
      return {
        status: mock.httpError.status,
        headers: [['Content-Type', mock.httpError.contentType]],
        body: streamOf([mock.httpError.body]),
      }
    }
    if (mock.compactReply !== undefined) {
      return { status: 200, headers: [['Content-Type', 'application/json']], body: streamOf([mock.compactReply]) }
    }
    if (mock.writes !== undefined && mock.writes.length > 0) {
      return { status: 200, headers: [], body: streamOf(mock.writes) }
    }
    if (mock.sseScript !== undefined) {
      // Some scripts end with a `MOCK: ` control instruction for the
      // recording harness (e.g. the S2d9-08 disconnect note); it is not
      // wire bytes. Serve the script up to that line, then close.
      const instruction = mock.sseScript.indexOf('\nMOCK: ')
      const served = instruction === -1 ? mock.sseScript : mock.sseScript.slice(0, instruction + 1)
      return { status: 200, headers: [], body: streamOf([served]) }
    }
    throw new Error(`unexpected upstream call for ${caseRecord.id}`)
  }
}

function buildService(caseRecord: RecordedCase): CodexPassthroughService {
  return createCodexPassthroughService({
    apiKeys: caseRecord.config.apiKeys,
    credentials: caseRecord.config.credentials,
    store: new MemoryStore(),
    now: () => FROZEN_NOW,
  })
}

function clientRequestOf(caseRecord: RecordedCase): CodexPassthroughRequest {
  return {
    method: caseRecord.request.method,
    path: caseRecord.request.path,
    headers: Object.entries(caseRecord.request.headers),
    body: caseRecord.request.body,
  }
}

async function collectBody(response: CodexPassthroughResponse): Promise<string> {
  if (typeof response.body === 'string') return response.body
  const reader = (response.body as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  let out = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value !== undefined) out += decoder.decode(value, { stream: true })
  }
  return out + decoder.decode()
}

/** Masks the derived-session and credential fields the recordings mask. */
function maskValue(name: string, value: string, maskSession: boolean): string {
  if (name === 'Authorization') return '<redacted>'
  if (maskSession && name === 'Session-Id') return '<SESSION>'
  return value
}

function maskBody(body: string, maskSession: boolean): string {
  if (!maskSession) return body
  return body.replace(/("prompt_cache_key":")[^"]*(")/g, '$1<SESSION>$2')
}

function expectedUpstreamLines(
  caseRecord: RecordedCase,
  maskSession: boolean,
): Array<{ method: string; path: string; headers: Array<[string, string]>; body: string }> {
  return caseRecord.upstream.map((line: RecordedUpstream) => ({
    method: line.method,
    path: line.path,
    headers: Object.entries(line.headers).map(([name, value]) => [name, maskValue(name, value, maskSession)] as [string, string]),
    body: maskBody(line.body, maskSession),
  }))
}

function assertUpstream(
  log: CapturedUpstream[],
  expected: ReturnType<typeof expectedUpstreamLines>,
  context: string,
  maskSession: boolean,
): void {
  expect(log.length, `${context}: upstream call count`).toBe(expected.length)
  for (let i = 0; i < expected.length; i++) {
    const captured = log[i]
    const want = expected[i]
    if (captured === undefined || want === undefined) continue
    expect(captured.request.method, `${context}: upstream ${i} method`).toBe(want.method)
    expect(captured.path, `${context}: upstream ${i} path`).toBe(want.path)
    expect(
      captured.request.headers.map(([name, value]) => [name, maskValue(name, value, maskSession)] as [string, string]),
      `${context}: upstream ${i} headers (ordered)`,
    ).toEqual(want.headers)
    expect(maskBody(captured.request.body, maskSession), `${context}: upstream ${i} body`).toBe(want.body)
  }
}

async function assertDownstream(response: CodexPassthroughResponse, caseRecord: RecordedCase, context: string): Promise<void> {
  const recorded = caseRecord.downstream
  expect(response.status, `${context}: status`).toBe(recorded.status)
  const headers = response.headers
  const contentType = headers.find(([name]) => name === 'Content-Type')?.[1]
  expect(contentType, `${context}: Content-Type`).toBe(recorded.headers['Content-Type'])
  if (recorded.stream !== undefined) {
    expect(headers.find(([name]) => name === 'Cache-Control')?.[1], `${context}: SSE Cache-Control`).toBe('no-cache')
    expect(headers.find(([name]) => name === 'Connection')?.[1], `${context}: SSE Connection`).toBe('keep-alive')
    expect(headers.find(([name]) => name === 'Access-Control-Allow-Origin')?.[1], `${context}: SSE ACAO`).toBe('*')
  }
  const retryAfter = recorded.headers['Retry-After']
  if (retryAfter !== undefined) {
    expect(headers.find(([name]) => name === 'Retry-After')?.[1], `${context}: Retry-After`).toBe(retryAfter)
  }
  const body = await collectBody(response)
  expect(body, `${context}: body bytes`).toBe(recorded.body)
}

describe('S2d9 golden replay - single-session cases', () => {
  for (const caseId of SINGLE_CASES) {
    test(caseId, async () => {
      const caseRecord = readCase(caseId)
      const service = buildService(caseRecord)
      const log: CapturedUpstream[] = []
      const response = await service.handleResponses(clientRequestOf(caseRecord), recordedSend(caseRecord, log))
      await assertDownstream(response, caseRecord, caseId)
      assertUpstream(log, expectedUpstreamLines(caseRecord, !caseRecord.clientPromptCacheKey), caseId, !caseRecord.clientPromptCacheKey)
    })
  }
})

describe('S2d9 golden replay - cooldown-window session pairs', () => {
  test('S2d9-11 -> S2d9-12: upstream 429, then model_cooldown with Retry-After (no upstream call)', async () => {
    const first = readCase('S2d9-11')
    const second = readCase('S2d9-12')
    const service = buildService(first)
    const log: CapturedUpstream[] = []

    const responseA = await service.handleResponses(clientRequestOf(first), recordedSend(first, log))
    await assertDownstream(responseA, first, 'S2d9-11')

    const responseB = await service.handleResponses(clientRequestOf(second), recordedSend(second, log))
    await assertDownstream(responseB, second, 'S2d9-12')

    expect(log.length, 'S2d9-11/12 pair: exactly one upstream call').toBe(1)
    assertUpstream(log, expectedUpstreamLines(first, true), 'S2d9-11/12 pair', true)
  })

  test('S2d9-10 -> S2d9-18: upstream 404 model_not_found, then 503 auth_unavailable (no upstream call)', async () => {
    const first = readCase('S2d9-10')
    const second = readCase('S2d9-18')
    const service = buildService(first)
    const log: CapturedUpstream[] = []

    const responseA = await service.handleResponses(clientRequestOf(first), recordedSend(first, log))
    await assertDownstream(responseA, first, 'S2d9-10')

    const responseB = await service.handleResponses(clientRequestOf(second), recordedSend(second, log))
    await assertDownstream(responseB, second, 'S2d9-18')

    expect(log.length, 'S2d9-10/18 pair: exactly one upstream call').toBe(1)
    assertUpstream(log, expectedUpstreamLines(first, true), 'S2d9-10/18 pair', true)
  })
})
