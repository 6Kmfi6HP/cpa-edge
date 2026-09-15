/**
 * Golden replay: all 26 recorded S2d2 cases through the facade.
 *
 * Each case replays its recorded requests against a mock upstream built
 * from the case's mock-response.json control (exactly like the oracle
 * recording), and asserts BOTH sides of the wire:
 *  - the upstream wire (captured calls vs upstream.jsonl): URL, header
 *    list (port masked, Authorization redacted, Content-Length
 *    consistency-checked) and body bytes byte-exact;
 *  - the downstream surface (downstream.md): status, Content-Type exact or
 *    absent, Cache-Control / Connection / Retry-After presence, trace-id
 *    presence, and the body - byte-exact, or as the DECODED SSE event
 *    sequence per R-SSE with multi-tool finish frames canonicalized per
 *    R-ORDER (the N5 volatility whitelist).
 *
 * The cooldown escalation pair replays on ONE shared session with the
 * recorded inter-request clock schedule, so the third consecutive 429
 * opens the recorded 4-second window and the in-window step byte-matches
 * the fixture (Retry-After 4 / reset_seconds 4, no masking).
 */
import { describe, expect, it } from 'vitest'
import { MemoryStore } from '@cpa-edge/core'
import type { Store } from '@cpa-edge/core'
import {
  listCaseIds,
  readCaseMeta,
  readCaseText,
  readMockResponse,
  readRecordedDownstreams,
  readRecordedRequests,
  readRecordedUpstreams,
} from './fixture-reader'
import type {
  MockControlFile,
  MockReply,
  MockResponseFile,
  RecordedRequest,
  RecordedResponse,
  RecordedUpstream,
} from './fixture-reader'
import type { Gem2OaiRegistryEntry } from './models'
import { createGem2OaiService } from './service'
import type {
  Gem2OaiCredential,
  Gem2OaiResponse,
  Gem2OaiUpstreamRequest,
  Gem2OaiUpstreamResponse,
  Gem2OaiUpstreamSender,
} from './service'

const FROZEN_NOW_MS = 1_789_492_684_000
const CREDENTIALS: readonly Gem2OaiCredential[] = [
  {
    name: 'mock-openai',
    apiKey: 'mock-upstream-key',
    baseUrl: 'http://host.docker.internal:20999/v1',
    models: [{ name: 'mock-gpt-model', alias: 'mock-model' }],
  },
]
const REGISTRY: readonly Gem2OaiRegistryEntry[] = [
  { id: 'mock-model', displayName: 'mock-model' },
  { id: 'cm', displayName: 'claude-mock-model' },
  { id: 'vm', displayName: 'vertex-mock-model' },
  { id: 'gm', displayName: 'gemini-mock-model' },
  { id: 'xg', displayName: 'grok-mock' },
  { id: 'im', displayName: 'gemini-mock-model' },
  { id: 'mm', displayName: 'muse-mock' },
  { id: 'cx', displayName: 'gpt-mock-codex' },
]
const API_KEYS: readonly string[] = ['oracle-local-key-1']

/** Recorded inter-request clock offsets of the escalation pair (ms). */
const STEP_CLOCK_OFFSETS_MS: Readonly<Record<string, readonly number[]>> = {
  'gem2oai-error-429': [0, 2_500],
  'gem2oai-cooldown-after-429': [5_000, 5_100],
}
const COOLDOWN_PAIR_ORDER: readonly string[] = ['gem2oai-error-429', 'gem2oai-cooldown-after-429']

const encoder = new TextEncoder()

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Demand-driven byte stream; the read after `abortAfter` chunks errors (disconnect). */
function scriptedByteStream(
  chunks: readonly Uint8Array[],
  options: { readonly abortAfter?: number; readonly delayMs?: number; readonly abortError?: string } = {},
): ReadableStream<Uint8Array> {
  let served = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const index = served
      served += 1
      if (options.delayMs !== undefined && index > 0) await sleep(options.delayMs)
      if (options.abortAfter !== undefined && index >= options.abortAfter) {
        controller.error(new Error(options.abortError ?? 'mock upstream: connection reset mid-stream'))
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

function buildMockResponse(mockFile: MockResponseFile, caseId: string): Gem2OaiUpstreamResponse {
  const control: MockControlFile = mockFile.control_file ?? {}
  const reply: MockReply | null | undefined = mockFile.reply
  if (reply === null || reply === undefined) {
    throw new Error(`${caseId}: gateway-local fixture - the upstream must NOT be called`)
  }
  const mode = control.mode ?? 'happy'
  if (mode === 'error') {
    if (reply.body_raw === undefined) throw new Error(`${caseId}: error control carries no body_raw`)
    const status = reply.status ?? control.status
    if (status === undefined) throw new Error(`${caseId}: error control carries no status`)
    return { status, headers: [], body: scriptedByteStream([encoder.encode(reply.body_raw)]) }
  }
  if (reply.sse_frames !== undefined) {
    return {
      status: 200,
      headers: [],
      body: scriptedByteStream(reply.sse_frames.map((frame) => encoder.encode(frame)), {
        delayMs: mode === 'slow' ? control.delay_ms : undefined,
        abortAfter: mode === 'disconnect' ? control.after : undefined,
        abortError: 'unexpected EOF',
      }),
    }
  }
  if (reply.response_body !== undefined) {
    return { status: reply.status ?? 200, headers: [], body: scriptedByteStream([encoder.encode(reply.response_body)]) }
  }
  throw new Error(`${caseId}: mock reply shape not recognized`)
}

interface Session {
  readonly service: ReturnType<typeof createGem2OaiService>
  setClock(offsetMs: number): void
}

function createSession(store: Store): Session {
  let clockMs = FROZEN_NOW_MS
  const service = createGem2OaiService({
    credentials: CREDENTIALS,
    registry: REGISTRY,
    apiKeys: API_KEYS,
    store,
    now: () => clockMs,
    requestRetry: 0,
    transientErrorCooldownSeconds: -1,
  })
  return { service, setClock: (offsetMs: number) => (clockMs = FROZEN_NOW_MS + offsetMs) }
}

function headerValue(headers: ReadonlyArray<readonly [string, string]>, name: string): string | undefined {
  const key = name.toLowerCase()
  for (const [headerName, value] of headers) {
    if (headerName.toLowerCase() === key) return value
  }
  return undefined
}

async function readResponseBody(body: Gem2OaiResponse['body']): Promise<string> {
  if (typeof body === 'string') return body
  const reader = (body as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  let out = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value !== undefined) out += decoder.decode(value, { stream: true })
  }
  return out + decoder.decode()
}

interface SseFrame {
  readonly event: string | undefined
  readonly data: string
}

function decodeSseEvents(body: string): readonly SseFrame[] {
  const frames: SseFrame[] = []
  for (const block of body.split('\n\n')) {
    if (block === '') continue
    let event: string | undefined
    const dataLines: string[] = []
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) throw new Error(`SSE comment line violates the golden configuration: ${line}`)
      if (line === '') continue
      if (line.startsWith('event: ')) {
        event = line.slice('event: '.length)
        continue
      }
      if (line.startsWith('data: ')) {
        dataLines.push(line.slice('data: '.length))
        continue
      }
      throw new Error(`unrecognized SSE line: ${line}`)
    }
    if (dataLines.length > 0) frames.push({ event, data: dataLines.join('\n') })
  }
  return frames
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** R-ORDER sort key: functionCall.name, then functionCall.id. */
function canonicalPartKey(part: unknown): string {
  if (isRecord(part) && isRecord(part['functionCall'])) {
    const call = part['functionCall']
    const name = typeof call['name'] === 'string' ? call['name'] : ''
    const id = typeof call['id'] === 'string' ? call['id'] : ''
    return `functionCall\u0000${name}\u0000${id}`
  }
  return `raw\u0000${JSON.stringify(part) ?? ''}`
}

/** Canonicalizes multi-tool finish frames; every other frame is untouched. */
function canonicalizeFrameData(data: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return data
  }
  if (!isRecord(parsed)) return data
  const candidates = parsed['candidates']
  if (!Array.isArray(candidates)) return data
  const first = candidates[0]
  if (!isRecord(first) || !isRecord(first['content'])) return data
  const parts = first['content']['parts']
  if (!Array.isArray(parts)) return data
  if (parts.filter((part) => isRecord(part) && 'functionCall' in part).length < 2) return data
  const sortedParts = [...parts].sort((left, right) => {
    const leftKey = canonicalPartKey(left)
    const rightKey = canonicalPartKey(right)
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
  })
  const rebuiltFirst: Record<string, unknown> = { ...first, content: { ...first['content'], parts: sortedParts } }
  const rebuiltCandidates = candidates.map((entry, index) => (index === 0 ? rebuiltFirst : entry))
  return JSON.stringify({ ...parsed, candidates: rebuiltCandidates })
}

function firstFrameDifference(actual: readonly SseFrame[], expected: readonly SseFrame[]): string {
  const count = Math.min(actual.length, expected.length)
  for (let index = 0; index < count; index++) {
    const expectedFrame = expected[index]
    const actualFrame = actual[index]
    if (expectedFrame === undefined || actualFrame === undefined) continue
    if (expectedFrame.event !== actualFrame.event || expectedFrame.data !== actualFrame.data) {
      return `frame ${index}: recorded ${expectedFrame.data.slice(0, 120)} vs produced ${actualFrame.data.slice(0, 120)}`
    }
  }
  return count === 0 ? 'one side is empty' : 'common prefix matches; one side has extra trailing frames'
}

function expectEventSequence(actual: readonly SseFrame[], expected: readonly SseFrame[], context: string): void {
  expect(actual.length, `${context}: decoded SSE frame count (${firstFrameDifference(actual, expected)})`).toBe(expected.length)
  for (let index = 0; index < expected.length; index++) {
    const expectedFrame = expected[index]
    const actualFrame = actual[index]
    if (expectedFrame === undefined || actualFrame === undefined) continue
    expect(actualFrame.event, `${context}: SSE frame ${index} event name`).toBe(expectedFrame.event)
    expect(canonicalizeFrameData(actualFrame.data), `${context}: SSE frame ${index} payload`).toBe(
      canonicalizeFrameData(expectedFrame.data),
    )
  }
}

function assertUpstreamWire(recorded: RecordedUpstream, call: Gem2OaiUpstreamRequest, caseId: string): void {
  const context = `${caseId} upstream wire`
  expect(call.method, `${context}: method`).toBe(recorded.method)
  expect(call.url, `${context}: url`).toBe(`${CREDENTIALS[0]?.baseUrl.replace(/\/$/, '')}/chat/completions`)

  const expectedPairs: Array<[string, string]> = []
  for (const [name, value] of Object.entries(recorded.headers)) {
    if (name.toLowerCase() === 'content-length') continue
    expectedPairs.push([name, name.toLowerCase() === 'host' ? value.replace(/:\d+$/, ':<PORT>') : value])
  }
  const actualPairs: Array<[string, string]> = []
  let actualContentLength: string | undefined
  for (const [name, value] of call.headers) {
    if (name.toLowerCase() === 'content-length') {
      actualContentLength = value
      continue
    }
    if (name.toLowerCase() === 'authorization') {
      expect(value.startsWith('Bearer '), `${context}: Authorization carries the Bearer scheme`).toBe(true)
      actualPairs.push([name, '<redacted>'])
      continue
    }
    actualPairs.push([name, name.toLowerCase() === 'host' ? value.replace(/:\d+$/, ':<PORT>') : value])
  }
  expect(actualPairs, `${context}: header list (order + names + values)`).toEqual(expectedPairs)
  if (actualContentLength !== undefined) {
    expect(actualContentLength, `${context}: Content-Length matches the body bytes`).toBe(
      String(encoder.encode(call.body).length),
    )
  }
  expect(call.body, `${context}: translated body bytes`).toBe(recorded.body)
}

async function assertDownstreamStep(
  response: Gem2OaiResponse,
  expected: RecordedResponse,
  caseId: string,
  step: number,
): Promise<void> {
  const context = `${caseId} step ${step} downstream`
  const body = await readResponseBody(response.body)
  expect(response.status, `${context}: status`).toBe(expected.status)

  const expectedContentType = headerValue(expected.headers, 'content-type')
  const actualContentType = headerValue(response.headers, 'content-type')
  if (expectedContentType === undefined) {
    expect(actualContentType, `${context}: Content-Type absent when the recording has none`).toBeUndefined()
  } else {
    expect(actualContentType, `${context}: Content-Type`).toBe(expectedContentType)
  }

  for (const name of ['cache-control', 'connection', 'retry-after']) {
    const expectedValue = headerValue(expected.headers, name)
    const actualValue = headerValue(response.headers, name)
    if (expectedValue === undefined) {
      expect(actualValue, `${context}: ${name} absent when the recording has none`).toBeUndefined()
    } else {
      expect(actualValue, `${context}: ${name}`).toBe(expectedValue)
    }
  }

  const expectedTrace = headerValue(expected.headers, 'x-cpa-trace-id') !== undefined
  expect(
    headerValue(response.headers, 'x-cpa-trace-id') !== undefined,
    `${context}: X-Cpa-Trace-Id presence matches the recorded head`,
  ).toBe(expectedTrace)

  if (expectedContentType === 'text/event-stream') {
    expect(body.includes('data: [DONE]'), `${context}: [DONE] never reaches a gemini client`).toBe(false)
    expectEventSequence(decodeSseEvents(body), decodeSseEvents(expected.body), context)
  } else {
    expect(body, `${context}: body bytes`).toBe(expected.body)
  }
}

async function replayCase(
  caseId: string,
  session: Session,
  sendLog: Gem2OaiUpstreamRequest[],
  callsBefore = 0,
): Promise<void> {
  const meta = readCaseMeta(caseId)
  const mockFile = readMockResponse(caseId)
  const requests: readonly RecordedRequest[] = readRecordedRequests(caseId)
  const downstream = readRecordedDownstreams(caseId)
  const recordedUpstream = readRecordedUpstreams(caseId)
  const offsets = STEP_CLOCK_OFFSETS_MS[caseId]

  expect(requests.length, `${caseId}: request blocks match the meta per-request line counts`).toBe(
    meta.upstream_wire_lines_per_request.length,
  )

  const send: Gem2OaiUpstreamSender = async (call) => {
    sendLog.push(call)
    return buildMockResponse(mockFile, caseId)
  }

  for (let step = 1; step <= requests.length; step++) {
    const request = requests[step - 1]
    const expected = downstream[`R${step}`]
    if (request === undefined || expected === undefined) throw new Error(`${caseId}: fixture step ${step} missing`)
    session.setClock(offsets?.[step - 1] ?? 0)
    const response = await session.service.handleV1Beta(
      { method: request.method, path: request.path, headers: request.headers, body: request.body },
      send,
    )
    await assertDownstreamStep(response, expected, caseId, step)
  }

  const caseCalls = sendLog.slice(callsBefore)
  expect(caseCalls.length, `${caseId}: upstream call count (gateway-local steps make no call)`).toBe(recordedUpstream.length)
  for (let index = 0; index < recordedUpstream.length; index++) {
    const recorded = recordedUpstream[index]
    const call = caseCalls[index]
    if (recorded === undefined || call === undefined) continue
    assertUpstreamWire(recorded, call, caseId)
  }
}

const ISOLATED_CASES = listCaseIds().filter((caseId) => !COOLDOWN_PAIR_ORDER.includes(caseId))

describe('S2d2 golden replay - facade over the recorded fixtures', () => {
  for (const caseId of ISOLATED_CASES) {
    it(`${caseId}: upstream wire byte-exact, downstream surface byte-exact`, async () => {
      const sendLog: Gem2OaiUpstreamRequest[] = []
      await replayCase(caseId, createSession(new MemoryStore()), sendLog, 0)
    })
  }

  it('gem2oai-error-429 then gem2oai-cooldown-after-429: escalation pair on one shared session (reset_seconds 4 byte-exact)', async () => {
    const sendLog: Gem2OaiUpstreamRequest[] = []
    const session = createSession(new MemoryStore())
    await replayCase('gem2oai-error-429', session, sendLog, 0)
    // Third consecutive 429 opens the recorded 4-second window; the next
    // request lands inside it and never reaches the upstream.
    await replayCase('gem2oai-cooldown-after-429', session, sendLog, sendLog.length)
    expect(sendLog.length, 'escalation pair: 3 upstream calls total').toBe(3)
  })

  it('every fixture body claim is byte-true and every dynamic field is recognized', () => {
    for (const caseId of listCaseIds()) {
      const meta = readCaseMeta(caseId)
      const downstream = readRecordedDownstreams(caseId)
      for (const step of Object.keys(downstream)) {
        const expected = downstream[step]
        if (expected === undefined) continue
        expect(encoder.encode(expected.body).length, `${caseId} ${step}: body bytes match the claim`).toBe(
          expected.claimedBodyBytes,
        )
      }
      for (const field of meta.dynamic_fields) {
        expect(
          [
            'Date',
            'X-Cpa-Trace-Id',
            'upstream Host header port (20999)',
            'mock wire log ts field',
            'createTime / responseId-like ids where present',
          ].includes(field),
          `${caseId}: recognized meta dynamic field ${field}`,
        ).toBe(true)
      }
      expect(readCaseText(caseId, 'upstream.jsonl').trim().split('\n').filter((l) => l.length > 0).length).toBe(
        meta.upstream_wire_lines_per_request.reduce((sum, count) => sum + count, 0),
      )
    }
  })
})
