/**
 * Golden replay: every recorded S2d4 case, service-level end to end.
 *
 * Each recorded client request is driven through `createCla2OaiService`
 * against a mock transport that replays the case's own canned reply
 * (non-stream JSON, SSE chunk scripts, an error status/body, or a hard
 * mid-stream close). The captured upstream wire (method, url, ordered
 * headers, body) is compared byte-exact against upstream.jsonl - the
 * Content-Length header doubles as a byte-parity check of the
 * serializer; the downstream surface (status, direction-owned headers,
 * body bytes - and the SSE byte stream after R-SSE decoding) is compared
 * byte-exact against downstream.md. `message_start.usage.input_tokens`
 * and the count_tokens `input_tokens` are deterministic (o200k_base)
 * and are compared exactly. The cooldown case seeds the rate-limit
 * window through the recorded S2d4-error-429 exchange first (the same
 * service instance + store, clock advanced 100ms), then asserts the
 * recorded 429 model_cooldown surface with an empty wire slice.
 */
import { describe, expect, it } from 'vitest'
import { MemoryStore } from '@cpa-edge/core'
import { createCla2OaiService } from './service'
import type {
  Cla2OaiRequest,
  Cla2OaiResponse,
  Cla2OaiUpstreamRequest,
  Cla2OaiUpstreamResponse,
  Cla2OaiUpstreamSender,
} from './service'
import {
  readRecordedDownstream,
  readRecordedMock,
  readRecordedRequest,
  readRecordedUpstreams,
} from './fixture-reader'
import type { RecordedUpstream } from './fixture-reader'

const GATEWAY_API_KEYS: readonly string[] = ['oracle-local-key-1']
const CREDENTIALS = [
  {
    name: 'mock-openai',
    apiKey: 'mock-upstream-key',
    baseUrl: 'http://host.docker.internal:21999/v1',
    models: [{ name: 'mock-gpt-model', alias: 'mock-model' }],
  },
  {
    name: 'mock-openai-compat',
    apiKey: 'mock-upstream-key',
    baseUrl: 'http://host.docker.internal:21999/v1',
    models: [{ name: 'mock-gpt-model', alias: 'mock-model-compat', isCompat: true }],
  },
]
const BASE_URL = 'http://host.docker.internal:21999/v1'
const encoder = new TextEncoder()

const CASES = [
  'S2d4-min-nonstream',
  'S2d4-params',
  'S2d4-system-attribution-temperature',
  'S2d4-stream-text',
  'S2d4-thinking-budget',
  'S2d4-tools-request',
  'S2d4-tool-roundtrip',
  'S2d4-images',
  'S2d4-toolresult-image-relay',
  'S2d4-count-tokens',
  'S2d4-nostream-rich',
  'S2d4-stream-tools',
  'S2d4-stream-reasoning',
  'S2d4-stream-usage',
  'S2d4-empty-messages',
  'S2d4-compat-thinking',
  'S2d4-auth-missing',
  'S2d4-unknown-model',
  'S2d4-error-429',
  'S2d4-cooldown-second',
  'S2d4-stream-error-429',
  'S2d4-stream-disconnect',
  'S2d4-thinking-disabled',
  'S2d4-thinking-budget-0',
  'S2d4-thinking-budget-300',
  'S2d4-thinking-budget-30000',
  'S2d4-thinking-adaptive-auto',
  'S2d4-thinking-adaptive-max',
  'S2d4-thinking-adaptive-noeffort',
  'S2d4-thinking-adaptive-unknown',
  'S2d4-count-tokens-bad-budget',
  'S2d4-stream-truthy-null',
  'S2d4-topp-no-temperature',
] as const

/** Python json.dumps-style serialization (', ' / ': ' separators). */
function pyDump(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return `[${value.map(pyDump).join(', ')}]`
  if (typeof value === 'object') {
    const members = Object.entries(value as Record<string, unknown>).map(
      ([key, member]) => `${JSON.stringify(key)}: ${pyDump(member)}`,
    )
    return `{${members.join(', ')}}`
  }
  return 'null'
}

/** Demand-driven byte stream; the read after the last chunk errors or closes. */
function scriptedByteStream(
  chunks: readonly Uint8Array[],
  options: { readonly abortAfter?: number } = {},
): ReadableStream<Uint8Array> {
  let served = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const index = served
      served += 1
      if (options.abortAfter !== undefined && index >= options.abortAfter) {
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

/** Normalizes one scripted stream entry: a [delay, value] pair or a bare chunk. */
function streamEntryValue(entry: unknown): unknown {
  if (Array.isArray(entry) && entry.length === 2 && typeof entry[0] !== 'object') {
    return entry[1]
  }
  return entry
}

/** Builds the upstream reply the recorded mock served for this case. */
function buildMockResponse(caseId: string): Cla2OaiUpstreamResponse {
  const { mock, reply } = readRecordedMock(caseId)
  if (mock.mode === 'error') {
    const status = reply.errorStatus ?? 500
    const bodyText = pyDump(reply.servedObject ?? {})
    return {
      status,
      headers: [['Content-Type', 'application/json']],
      body: scriptedByteStream([encoder.encode(bodyText)]),
    }
  }
  if (mock.mode === 'script') {
    if (reply.scriptedNonStream !== undefined) {
      return {
        status: 200,
        headers: [['Content-Type', 'application/json']],
        body: scriptedByteStream([encoder.encode(pyDump(reply.scriptedNonStream))]),
      }
    }
    const frames = (reply.scriptedStream ?? []).map((entry) => {
      const value = streamEntryValue(entry)
      return encoder.encode(value === '[DONE]' ? 'data: [DONE]\n\n' : `data: ${pyDump(value)}\n\n`)
    })
    return {
      status: 200,
      headers: [['Content-Type', 'text/event-stream']],
      body: scriptedByteStream(frames),
    }
  }
  if (mock.mode === 'disconnect') {
    const after = typeof mock.control['after'] === 'number' ? mock.control['after'] : undefined
    const frames = (reply.servedStream ?? []).map((entry) =>
      encoder.encode(`data: ${pyDump(streamEntryValue(entry))}\n\n`),
    )
    return {
      status: 200,
      headers: [['Content-Type', 'text/event-stream']],
      body: scriptedByteStream(frames, { abortAfter: after }),
    }
  }
  // happy mode: canned non-stream JSON or the canned SSE chunk script.
  if (reply.servedObject !== undefined) {
    return {
      status: 200,
      headers: [['Content-Type', 'application/json']],
      body: scriptedByteStream([encoder.encode(pyDump(reply.servedObject))]),
    }
  }
  const frames = (reply.servedStream ?? []).map((entry) => {
    const value = streamEntryValue(entry)
    return encoder.encode(value === '[DONE]' ? 'data: [DONE]\n\n' : `data: ${pyDump(value)}\n\n`)
  })
  return {
    status: 200,
    headers: [['Content-Type', 'text/event-stream']],
    body: scriptedByteStream(frames),
  }
}

async function readResponseBody(body: Cla2OaiResponse['body']): Promise<string> {
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

function headerValue(headers: ReadonlyArray<readonly [string, string]>, name: string): string | undefined {
  const key = name.toLowerCase()
  for (const [headerName, value] of headers) {
    if (headerName.toLowerCase() === key) return value
  }
  return undefined
}

/** Splits a downstream Claude SSE body into its `event:`/`data:` pairs (R-SSE). */
function parseDownstreamSse(text: string): ReadonlyArray<{ event?: string; data: string }> {
  const frames: Array<{ event?: string; data: string }> = []
  for (const block of text.split('\n\n')) {
    let event: string | undefined
    const dataLines: string[] = []
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trimStart().replace(/^ /, '')
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''))
    }
    if (event === undefined && dataLines.length === 0) continue
    frames.push({ event, data: dataLines.join('\n') })
  }
  return frames
}

function assertUpstreamWire(recorded: RecordedUpstream, call: Cla2OaiUpstreamRequest, caseId: string): void {
  const context = `${caseId} upstream wire`
  expect(call.method, `${context}: method`).toBe(recorded.method)
  expect(call.url, `${context}: url`).toBe(`${BASE_URL}${recorded.path}`)
  const expectedPairs: Array<[string, string]> = []
  for (const [name, value] of Object.entries(recorded.headers)) {
    if (name.toLowerCase() === 'content-length') continue
    expectedPairs.push([name, value])
  }
  const actualPairs: Array<[string, string]> = []
  for (const [name, value] of call.headers) {
    if (name.toLowerCase() === 'content-length') {
      expect(value, `${context}: Content-Length matches the body bytes`).toBe(
        String(encoder.encode(call.body).length),
      )
      continue
    }
    actualPairs.push([name, name.toLowerCase() === 'authorization' ? '<redacted>' : value])
  }
  expect(actualPairs, `${context}: ordered header list`).toEqual(expectedPairs)
  expect(call.body, `${context}: translated body bytes`).toBe(recorded.body)
}

async function assertDownstream(response: Cla2OaiResponse, caseId: string): Promise<void> {
  const expected = readRecordedDownstream(caseId)
  const body = await readResponseBody(response.body)
  expect(response.status, `${caseId}: status`).toBe(expected.status)
  expect(headerValue(response.headers, 'content-type'), `${caseId}: Content-Type`).toBe(
    expected.headers['Content-Type'],
  )
  // Trace ids are the runtime interceptor's business, never the facade's.
  expect(headerValue(response.headers, 'x-cpa-trace-id'), `${caseId}: no trace from the facade`).toBeUndefined()
  if (expected.headers['Retry-After'] !== undefined) {
    expect(headerValue(response.headers, 'retry-after'), `${caseId}: Retry-After`).toBe(
      expected.headers['Retry-After'],
    )
  }
  if (expected.sse) {
    expect(body, `${caseId}: SSE byte stream`).toBe(expected.body)
    expect(parseDownstreamSse(body), `${caseId}: decoded SSE event sequence (R-SSE)`).toEqual(
      parseDownstreamSse(expected.body),
    )
  } else {
    expect(body, `${caseId}: body bytes`).toBe(expected.body)
  }
}

function buildService(store: MemoryStore, now: () => number) {
  return createCla2OaiService({
    apiKeys: GATEWAY_API_KEYS,
    credentials: CREDENTIALS,
    store,
    now,
    requestRetry: 0,
    transientErrorCooldownSeconds: -1,
  })
}

function toServiceRequest(recorded: ReturnType<typeof readRecordedRequest>): Cla2OaiRequest {
  return {
    method: recorded.method,
    path: recorded.path,
    headers: Object.entries(recorded.headers).map(([name, value]) => [name, value] as [string, string]),
    body: recorded.body,
  }
}

describe('S2d4 golden replay — service-level', () => {
  for (const caseId of CASES) {
    it(`${caseId}: upstream wire + downstream surface byte-exact`, async () => {
      // A controllable clock: the cooldown case advances it after the
      // seeding exchange; every other case is time-independent.
      let clockMs = 1_789_506_604_000
      const service = buildService(new MemoryStore(), () => clockMs)
      const captured: Cla2OaiUpstreamRequest[] = []
      const send: Cla2OaiUpstreamSender = async (call) => {
        captured.push(call)
        return buildMockResponse(caseId)
      }

      if (caseId === 'S2d4-cooldown-second') {
        // Seed the rate-limit window exactly like the recording did: the
        // S2d4-error-429 exchange arms the cooldown, then this case's
        // request lands inside the window (< 0.5s apart there; 100ms on
        // the frozen clock here).
        const seedRequest = toServiceRequest(readRecordedRequest('S2d4-error-429'))
        const seed: Cla2OaiUpstreamSender = async (call) => {
          captured.push(call)
          return buildMockResponse('S2d4-error-429')
        }
        await service.handleV1Messages(seedRequest, seed)
        expect(captured.length, 'cooldown seed reached the upstream once').toBe(1)
        clockMs += 100
      }

      const recorded = readRecordedRequest(caseId)
      const response = await service.handleV1Messages(toServiceRequest(recorded), send)
      await assertDownstream(response, caseId)

      const upstreams = readRecordedUpstreams(caseId)
      const expectedCalls =
        caseId === 'S2d4-cooldown-second' ? captured.length - 1 : upstreams.length
      expect(captured.length, `${caseId}: upstream call count`).toBe(expectedCalls)
      if (caseId === 'S2d4-cooldown-second') {
        // The recorded wire slice of this case is EMPTY: the request
        // never left the gateway.
        expect(upstreams.length, `${caseId}: recorded slice is empty`).toBe(0)
        return
      }
      for (let i = 0; i < upstreams.length; i++) {
        const expected = upstreams[i]
        const actual = captured[i]
        expect(expected).toBeDefined()
        expect(actual).toBeDefined()
        if (expected === undefined || actual === undefined) continue
        assertUpstreamWire(expected, actual, caseId)
      }
    })
  }
})
