/**
 * Golden replay: every recorded S2d6 case, service-level end to end.
 *
 * Each recorded client request is driven through `createRes2OaiService`
 * against a mock transport that replays the case's own scripted reply
 * (canned non-stream JSON, scripted SSE with the `[DONE]` terminator,
 * the recorded 429 body with its original spacing, disconnect aborts).
 * The captured upstream wire (method, url, ordered headers, body) is
 * compared byte-exact against upstream.jsonl; the downstream surface
 * (status, direction-owned headers, body bytes - full SSE byte streams
 * included, which is stronger than the R-SSE decoded-frame floor) is
 * compared byte-exact against downstream.md.
 *
 * The 429 pair replays as one session like the recording did: the
 * non-stream 429 first (starting the ~1s rate-limit cooldown), the stream
 * 429 second with the shared frozen clock advanced past the window.
 *
 * `S2d6-badbody-notfound` is a reference-behavior golden only: the
 * rewrite enforces the NE-LENIENT strict boundary, so the replay asserts
 * the rewrite's own 400 shape (still: zero upstream calls).
 */
import { describe, expect, it } from 'vitest'
import { MemoryStore } from '@cpa-edge/core'
import { createRes2OaiService } from './service'
import type {
  Res2OaiRequest,
  Res2OaiResponse,
  Res2OaiUpstreamRequest,
  Res2OaiUpstreamResponse,
  Res2OaiUpstreamSender,
} from './service'
import { buildMalformedBodyEnvelope } from './errors'
import {
  readRecordedDownstream,
  readRecordedMock,
  readRecordedRequest,
  readRecordedUpstreams,
} from './fixture-reader'
import type { RecordedMock, RecordedUpstream } from './fixture-reader'

const GATEWAY_API_KEYS: readonly string[] = ['oracle-local-key-1']
const CREDENTIALS = [
  {
    apiKey: 'mock-upstream-key',
    baseUrl: 'http://host.docker.internal:18999/v1',
    provider: 'mock-openai',
    models: [{ name: 'mock-gpt-model', alias: 'mock-model' }],
  },
]
const FROZEN_NOW_MS = 1_789_504_600_000
/** Gap between the two 429 recordings (~2.5s; the rate-limit cooldown is ~1s). */
const STEP_ADVANCE_MS = 2_500
const encoder = new TextEncoder()

/** NE-LENIENT: the badbody golden pins reference behavior, not the rewrite. */
const EXPECTED_OVERRIDES: Readonly<Record<string, { readonly body: string; readonly contentType: string }>> = {
  'S2d6-badbody-notfound': {
    body: buildMalformedBodyEnvelope(),
    contentType: 'application/json; charset=utf-8',
  },
}

const SINGLE_STEP_CASES = [
  'S2d6-nostream-basic',
  'S2d6-nostream-roles',
  'S2d6-nostream-image',
  'S2d6-nostream-string-input',
  'S2d6-nostream-tool-roundtrip',
  'S2d6-nostream-custom-tool',
  'S2d6-nostream-namespace-tool',
  'S2d6-nostream-reasoning',
  'S2d6-nostream-incomplete',
  'S2d6-stream-basic',
  'S2d6-stream-usage-incomplete',
  'S2d6-stream-toolcalls',
  'S2d6-stream-reasoning',
  'S2d6-stream-disconnect',
  'S2d6-stream-disconnect-codex',
  'S2d6-stream-nodone',
  'S2d6-stream-slow',
  'S2d6-stream-empty200',
  'S2d6-stream-closeterminal',
  'S2d6-auth-missing',
  'S2d6-model-notfound',
  'S2d6-compact-passthrough',
  'S2d6-compact-streamfalse',
  'S2d6-compact-stream-rejected',
  'S2d6-badbody-notfound',
] as const

const FOUR_29_PAIR = ['S2d6-error-nostream-429', 'S2d6-error-stream-429'] as const

/** Serializes like Python's json.dumps defaults - the recorder's byte style. */
function pythonJson(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return value === null ? 'null' : String(value)
  }
  if (Array.isArray(value)) return `[${value.map(pythonJson).join(', ')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}: ${pythonJson(entry)}`).join(', ')}}`
  }
  throw new Error(`mock upstream cannot serialize value of type ${typeof value}`)
}

/** Demand-driven byte stream; the read after the last chunk errors or closes. */
function scriptedByteStream(chunks: readonly Uint8Array[], abortAfter: number | undefined): ReadableStream<Uint8Array> {
  let served = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const index = served
      served += 1
      if (abortAfter !== undefined && index >= abortAfter) {
        controller.error(new Error('mock upstream: connection reset mid-stream'))
        return
      }
      const chunk = chunks[index]
      if (chunk === undefined) {
        controller.close()
        return
      }
      controller.enqueue(chunk)
    },
  })
}

/** True when the recorded request selected streaming. */
function streamRequested(caseId: string): boolean {
  try {
    const parsed = JSON.parse(readRecordedRequest(caseId).body) as { stream?: unknown }
    return parsed.stream === true
  } catch {
    return false
  }
}

/** Builds the mock upstream reply for one recorded case. */
function buildMockResponse(mock: RecordedMock, caseId: string): Res2OaiUpstreamResponse {
  if (mock.mode === 'error') {
    const status = mock.status ?? 500
    const bodyText = pythonJson(mock.errorBody)
    return {
      status,
      headers: [['Content-Type', 'application/json']],
      body: scriptedByteStream([encoder.encode(bodyText)], undefined),
    }
  }
  if (mock.script !== undefined) {
    const chunks: Uint8Array[] = []
    for (const event of mock.script.events) {
      chunks.push(encoder.encode(`data: ${pythonJson(event)}\n\n`))
    }
    if (mock.script.terminator !== null) {
      chunks.push(encoder.encode(`data: [DONE]\n\n`))
    }
    const abortAfter = mock.mode === 'disconnect' ? (mock.after ?? chunks.length) : undefined
    return {
      status: 200,
      headers: [['Content-Type', 'text/event-stream']],
      body: scriptedByteStream(chunks, abortAfter),
    }
  }
  const reply = mock.nonStreamReply
  if (reply === undefined) {
    throw new Error(`${caseId}: no scripted or canned mock reply available`)
  }
  return {
    status: 200,
    headers: [['Content-Type', 'application/json']],
    body: scriptedByteStream([encoder.encode(pythonJson(reply))], undefined),
  }
}

async function readResponseBody(body: Res2OaiResponse['body']): Promise<string> {
  if (typeof body === 'string') return body
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let out = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    out += decoder.decode(value, { stream: true })
  }
  return out + decoder.decode()
}

function headerValue(headers: Res2OaiResponse['headers'], name: string): string | undefined {
  const key = name.toLowerCase()
  for (const [headerName, value] of headers) {
    if (headerName.toLowerCase() === key) return value
  }
  return undefined
}

async function assertDownstream(response: Res2OaiResponse, caseId: string): Promise<void> {
  const expected = readRecordedDownstream(caseId)
  const override = EXPECTED_OVERRIDES[caseId]
  const expectedContentType = override?.contentType ?? expected.headers['Content-Type']
  const expectedBody = override?.body ?? expected.body
  const body = await readResponseBody(response.body)
  expect(response.status, `${caseId}: status`).toBe(expected.status)
  expect(headerValue(response.headers, 'content-type'), `${caseId}: Content-Type`).toBe(expectedContentType)
  if (expectedContentType === 'text/event-stream') {
    expect(
      response.headers.map(([name]) => name),
      `${caseId}: recorded SSE commit order (Cache-Control, Connection, Content-Type)`,
    ).toEqual(['Cache-Control', 'Connection', 'Content-Type', 'Access-Control-Allow-Origin'])
    expect(headerValue(response.headers, 'cache-control'), `${caseId}: Cache-Control`).toBe(
      expected.headers['Cache-Control'],
    )
    expect(headerValue(response.headers, 'connection'), `${caseId}: Connection`).toBe(expected.headers['Connection'])
    expect(headerValue(response.headers, 'access-control-allow-origin'), `${caseId}: ACAO`).toBe(
      expected.headers['Access-Control-Allow-Origin'],
    )
  }
  expect(body, `${caseId}: body bytes (full stream bytes for SSE)`).toBe(expectedBody)
}

function assertUpstreamWire(recorded: RecordedUpstream, call: Res2OaiUpstreamRequest, caseId: string): void {
  const context = `${caseId} upstream wire`
  expect(call.method, `${context}: method`).toBe(recorded.method)
  // The recorded path is what the mock saw (base-url included); the
  // facade composes it from the credential base-url + direction path.
  const origin = new URL(CREDENTIALS[0]?.baseUrl ?? 'http://localhost').origin
  expect(call.url, `${context}: url`).toBe(`${origin}${recorded.path}`)
  const expectedPairs: Array<[string, string]> = []
  for (const [name, value] of Object.entries(recorded.headers)) {
    if (name.toLowerCase() === 'content-length') continue
    expectedPairs.push([name, name.toLowerCase() === 'authorization' ? '<redacted>' : value])
  }
  const actualPairs: Array<[string, string]> = []
  for (const [name, value] of call.headers) {
    if (name.toLowerCase() === 'content-length') {
      expect(value, `${context}: Content-Length matches the body bytes`).toBe(String(encoder.encode(call.body).length))
      continue
    }
    actualPairs.push([name, name.toLowerCase() === 'authorization' ? '<redacted>' : value])
  }
  expect(actualPairs, `${context}: ordered header list`).toEqual(expectedPairs)
  expect(call.body, `${context}: translated body bytes`).toBe(recorded.body)
}

async function replaySteps(stepCaseIds: readonly string[]): Promise<void> {
  const defaultScript = readRecordedMock('S2d6-stream-basic').script
  const defaultReply = readRecordedMock('S2d6-nostream-basic').nonStreamReply
  let step = 0
  const service = createRes2OaiService({
    apiKeys: GATEWAY_API_KEYS,
    credentials: CREDENTIALS,
    store: new MemoryStore(),
    now: () => FROZEN_NOW_MS + step * STEP_ADVANCE_MS,
    requestRetry: 0,
    transientErrorCooldownSeconds: -1,
  })
  const captured: Array<{ step: number; call: Res2OaiUpstreamRequest }> = []
  const send: Res2OaiUpstreamSender = async (call) => {
    const stepCaseId = stepCaseIds[step]
    if (stepCaseId === undefined) throw new Error('harness bug: no step for the current index')
    const own = readRecordedMock(stepCaseId)
    const mock =
      own.script === undefined && own.nonStreamReply === undefined &&
      (streamRequested(stepCaseId) ? defaultScript !== undefined : defaultReply !== undefined)
        ? readRecordedMock(stepCaseId, {
            script: streamRequested(stepCaseId) ? defaultScript : undefined,
            nonStreamReply: streamRequested(stepCaseId) ? undefined : defaultReply,
          })
        : own
    captured.push({ step, call })
    return buildMockResponse(mock, stepCaseId)
  }
  for (let index = 0; index < stepCaseIds.length; index++) {
    step = index
    const stepCaseId = stepCaseIds[index]
    if (stepCaseId === undefined) throw new Error('unreachable: step index out of range')
    const recorded = readRecordedRequest(stepCaseId)
    const request: Res2OaiRequest = {
      method: recorded.method,
      path: recorded.path,
      headers: Object.entries(recorded.headers).map(([name, value]) => [name, value] as [string, string]),
      body: recorded.body,
    }
    const response = await service.handleResponses(request, send)
    await assertDownstream(response, stepCaseId)
  }
  const expectedCalls = stepCaseIds.flatMap((stepCaseId) => readRecordedUpstreams(stepCaseId))
  expect(captured.length, `${stepCaseIds.join(' + ')}: upstream call count`).toBe(expectedCalls.length)
  for (let i = 0; i < expectedCalls.length; i++) {
    const expected = expectedCalls[i]
    const actual = captured[i]
    expect(expected).toBeDefined()
    expect(actual).toBeDefined()
    if (expected === undefined || actual === undefined) continue
    assertUpstreamWire(expected, actual.call, stepCaseIds.join(' + '))
  }
}

describe('S2d6 golden replay — service-level', () => {
  for (const caseId of SINGLE_STEP_CASES) {
    it(`${caseId}: upstream wire + downstream surface byte-exact`, async () => {
      await replaySteps([caseId])
    })
  }

  it('S2d6-error-nostream-429 + S2d6-error-stream-429: one session, cooldown skipped by the recorded 2.5s gap', async () => {
    await replaySteps([...FOUR_29_PAIR])
  })
})
