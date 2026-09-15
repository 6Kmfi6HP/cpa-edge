/**
 * Golden replay: every recorded S2d7 case, service-level end to end.
 *
 * Each recorded client request is driven through `createGem2ClaService`
 * against a mock transport that replays the case's own mock-response.json
 * (error replies, scripted SSE, raw wire lines, disconnect aborts). The
 * captured upstream wire (method, url, ordered headers, body) is compared
 * byte-exact against upstream.jsonl; the downstream surface (status,
 * direction-owned headers, body bytes / decoded SSE frames per R-SSE) is
 * compared byte-exact against downstream.md with `createTime` masked.
 *
 * S2d7-19 is composed like the contract suite: the recorded 429 of
 * S2d7-10 starts the cooldown, then S2d7-19's request lands inside the
 * window (shared service + Store, frozen clock).
 */
import { describe, expect, it } from 'vitest'
import { MemoryStore } from '@cpa-edge/core'
import { createGem2ClaService } from './service'
import type {
  Gem2ClaRequest,
  Gem2ClaResponse,
  Gem2ClaUpstreamRequest,
  Gem2ClaUpstreamResponse,
  Gem2ClaUpstreamSender,
  HeaderList,
} from './service'
import {
  readMockResponse,
  readRecordedDownstream,
  readRecordedRequest,
  readRecordedSteps,
  readRecordedUpstreams,
  readStepMockResponse,
} from './fixture-reader'
import type { RecordedDownstream, RecordedUpstream } from './fixture-reader'

const GATEWAY_VERSION = 'v7.3.4'
const GATEWAY_API_KEYS: readonly string[] = ['oracle-local-key-1']
const FROZEN_NOW_MS = 1_789_494_944_000
const CREDENTIALS = [
  { apiKey: 'mock-claude-key', baseUrl: 'http://host.docker.internal:21002', models: [{ name: 'claude-mock-model', alias: 'cm' }] },
]
const RECORDED_UPSTREAM_MODEL = 'claude-mock-model'
const encoder = new TextEncoder()

const CREATE_TIME_RE = /"createTime":"[^"]*"/g
const PORT_SUFFIX_RE = /:\d+$/

function mask(text: string): string {
  return text.replace(CREATE_TIME_RE, '"createTime":"<CREATE_TIME>"')
}

/** Serializes like Python's json.dumps defaults - the mock's recorded byte style. */
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

/** The mock echoes the request model; a mis-translation must propagate. */
function echoModel(value: unknown, model: string): unknown {
  if (typeof value === 'string') return value.split(RECORDED_UPSTREAM_MODEL).join(model)
  if (Array.isArray(value)) return value.map((item) => echoModel(item, model))
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) out[key] = echoModel(entry, model)
    return out
  }
  return value
}

function translatedModel(body: string): string {
  try {
    const parsed = JSON.parse(body) as { model?: unknown }
    return typeof parsed.model === 'string' ? parsed.model : RECORDED_UPSTREAM_MODEL
  } catch {
    return RECORDED_UPSTREAM_MODEL
  }
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

function buildMockResponse(
  control: Readonly<Record<string, unknown>>,
  reply: { readonly status?: unknown; readonly body?: unknown } | undefined,
  script: ReadonlyArray<readonly [string, unknown]>,
  upstreamRequest: Gem2ClaUpstreamRequest,
): Gem2ClaUpstreamResponse {
  const mode = typeof control['mode'] === 'string' ? control['mode'] : 'happy'
  if (mode === 'error') {
    const status = typeof control['status'] === 'number' ? control['status'] : typeof reply?.status === 'number' ? reply?.status : 500
    const rawBody = control['raw_body']
    const bodyText = typeof rawBody === 'string' ? rawBody : pythonJson(control['error_body'] ?? reply?.body)
    return {
      status,
      headers: [['Content-Type', 'application/json']],
      body: scriptedByteStream([encoder.encode(bodyText)]),
    }
  }
  const model = translatedModel(upstreamRequest.body)
  const chunks: Uint8Array[] = []
  for (const [name, data] of script) {
    if (name === 'RAW') {
      const text = typeof data === 'string' ? data : pythonJson(data)
      chunks.push(encoder.encode(`${text}\n\n`))
      continue
    }
    chunks.push(encoder.encode(`event: ${name}\ndata: ${pythonJson(echoModel(data, model))}\n\n`))
  }
  const abortAfter = mode === 'disconnect' ? (typeof control['after'] === 'number' ? control['after'] : chunks.length) : undefined
  return {
    status: 200,
    headers: [['Content-Type', 'text/event-stream']],
    body: scriptedByteStream(chunks, { abortAfter }),
  }
}

async function readResponseBody(body: Gem2ClaResponse['body']): Promise<string> {
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

function headerValue(headers: HeaderList, name: string): string | undefined {
  const key = name.toLowerCase()
  for (const [headerName, value] of headers) {
    if (headerName.toLowerCase() === key) return value
  }
  return undefined
}

interface SseFrame {
  readonly event: string | undefined
  readonly data: string
}

/** R-SSE decoder: ordered `{event, data}` blocks per `\n\n`-separated frame. */
function decodeSseFrames(body: string): SseFrame[] {
  const frames: SseFrame[] = []
  for (const block of body.split('\n\n')) {
    let event: string | undefined
    const dataLines: string[] = []
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice('event: '.length)
      else if (line.startsWith('data: ')) dataLines.push(line.slice('data: '.length))
    }
    if (event === undefined && dataLines.length === 0) continue
    frames.push({ event, data: dataLines.join('\n') })
  }
  return frames
}

async function assertDownstream(
  response: Gem2ClaResponse,
  expected: RecordedDownstream,
  caseId: string,
): Promise<void> {
  const body = await readResponseBody(response.body)
  expect(response.status, `${caseId}: status`).toBe(expected.status)
  expect(headerValue(response.headers, 'content-type'), `${caseId}: Content-Type`).toBe(
    expected.headers['Content-Type'],
  )
  const expectedCacheControl = expected.headers['Cache-Control']
  const actualCacheControl = headerValue(response.headers, 'cache-control')
  if (expectedCacheControl === undefined) {
    expect(actualCacheControl, `${caseId}: Cache-Control must be absent outside SSE commits`).toBeUndefined()
  } else {
    expect(actualCacheControl, `${caseId}: Cache-Control`).toBe(expectedCacheControl)
  }
  const expectedRetryAfter = expected.headers['Retry-After']
  const actualRetryAfter = headerValue(response.headers, 'retry-after')
  if (expectedRetryAfter === undefined) {
    expect(actualRetryAfter, `${caseId}: Retry-After must be absent when the recording has none`).toBeUndefined()
  } else {
    expect(actualRetryAfter, `${caseId}: Retry-After`).toBe(expectedRetryAfter)
  }
  if (expected.headers['Content-Type'] === 'text/event-stream') {
    expect(
      decodeSseFrames(body).map((frame) => ({ event: frame.event, data: mask(frame.data) })),
      `${caseId}: decoded SSE event sequence (R-SSE)`,
    ).toEqual(decodeSseFrames(expected.body).map((frame) => ({ event: frame.event, data: mask(frame.data) })))
  } else {
    expect(mask(body), `${caseId}: body bytes`).toBe(mask(expected.body))
  }
}

function assertUpstreamWire(recorded: RecordedUpstream, call: Gem2ClaUpstreamRequest, caseId: string): void {
  const context = `${caseId} upstream wire`
  expect(call.method, `${context}: method`).toBe(recorded.method)
  expect(call.url, `${context}: url`).toBe(`${CREDENTIALS[0]?.baseUrl ?? ''}${recorded.path}`)
  const expectedPairs: Array<[string, string]> = []
  for (const [name, value] of Object.entries(recorded.headers)) {
    if (name.toLowerCase() === 'content-length') continue
    const normalized = name.toLowerCase() === 'host' ? value.replace(PORT_SUFFIX_RE, ':<PORT>') : value
    expectedPairs.push([name, normalized])
  }
  const actualPairs: Array<[string, string]> = []
  for (const [name, value] of call.headers) {
    if (name.toLowerCase() === 'content-length') {
      expect(value, `${context}: Content-Length matches the body bytes`).toBe(
        String(encoder.encode(call.body).length),
      )
      continue
    }
    if (name.toLowerCase() === 'authorization') {
      expect(value.startsWith('Bearer '), `${context}: Bearer scheme`).toBe(true)
      actualPairs.push([name, '<redacted>'])
      continue
    }
    const normalized = name.toLowerCase() === 'host' ? value.replace(PORT_SUFFIX_RE, ':<PORT>') : value
    actualPairs.push([name, normalized])
  }
  expect(actualPairs, `${context}: ordered header list`).toEqual(expectedPairs)
  expect(mask(call.body), `${context}: translated body bytes`).toBe(mask(recorded.body))
}

const SINGLE_STEP_CASES = [
  'S2d7-00-auth-401',
  'S2d7-01-nonstream-minimal',
  'S2d7-02-stream-sse',
  'S2d7-03-stream-noalt',
  'S2d7-04-system-snake',
  'S2d7-05-system-camel',
  'S2d7-06-tools-roundtrip',
  'S2d7-07-genconfig-sampling',
  'S2d7-08-thinking-level',
  'S2d7-09-inline-media',
  'S2d7-10-upstream-429',
  'S2d7-11-disconnect',
  'S2d7-12-counttokens',
  'S2d7-13-tool-stream',
  'S2d7-14-errstream',
  'S2d7-15-maxtokens',
  'S2d7-16-roleless-dropped',
  'S2d7-17-role-merge',
  'S2d7-18-alt-json',
  'S2d7-20-errstream-nonstream',
  'S2d7-21-tool-nonstream',
  'S2d7-22-verbatim-model',
  'S2d7-23-tool-stream-valid-args',
  'S2d7-24-tool-nonstream-valid-args',
  'S2d7-25-counttokens-validation',
  'S2d7-26-empty-stream',
  'S2d7-27-missing-message-start',
  'S2d7-28-missing-message-delta',
  'S2d7-29-malformed-stream',
  'S2d7-30-stream-empty-200',
] as const

async function replaySteps(stepCaseIds: readonly string[]): Promise<void> {
  const service = createGem2ClaService({
    apiKeys: GATEWAY_API_KEYS,
    credentials: CREDENTIALS,
    gatewayVersion: GATEWAY_VERSION,
    store: new MemoryStore(),
    now: () => FROZEN_NOW_MS,
    requestRetry: 0,
    transientErrorCooldownSeconds: -1,
  })
  const captured: Array<{ step: number; call: Gem2ClaUpstreamRequest }> = []
  let currentStep = 0
  const send: Gem2ClaUpstreamSender = async (call) => {
    const stepCaseId = stepCaseIds[currentStep]
    if (stepCaseId === undefined) throw new Error('harness bug: no step for the current index')
    const mock = readMockResponse(stepCaseId)
    captured.push({ step: currentStep, call })
    return buildMockResponse(mock.control, mock.reply, mock.script, call)
  }
  for (let index = 0; index < stepCaseIds.length; index++) {
    currentStep = index
    const stepCaseId = stepCaseIds[index]
    if (stepCaseId === undefined) throw new Error('unreachable: step index out of range')
    const recorded = readRecordedRequest(stepCaseId)
    const request: Gem2ClaRequest = {
      method: recorded.method,
      path: recorded.path,
      headers: Object.entries(recorded.headers).map(([name, value]) => [name, value] as [string, string]),
      body: recorded.body,
    }
    const response = await service.handleV1beta(request, send)
    await assertDownstream(response, readRecordedDownstream(stepCaseId), stepCaseId)
  }
  const expectedCalls = stepCaseIds.flatMap((stepCaseId) => readRecordedUpstreams(stepCaseId))
  expect(captured.length, `${stepCaseIds.join(' + ')}: upstream call count`).toBe(expectedCalls.length)
  const stepOfCall: number[] = []
  stepCaseIds.forEach((stepCaseId, step) => {
    const count = readRecordedUpstreams(stepCaseId).length
    for (let k = 0; k < count; k++) stepOfCall.push(step)
  })
  for (let i = 0; i < expectedCalls.length; i++) {
    const expected = expectedCalls[i]
    const actual = captured[i]
    expect(expected).toBeDefined()
    expect(actual).toBeDefined()
    if (expected === undefined || actual === undefined) continue
    expect(actual.step, `upstream call ${i + 1} belongs to the right step`).toBe(stepOfCall[i])
    assertUpstreamWire(expected, actual.call, stepCaseIds.join(' + '))
  }
}

describe('S2d7 golden replay — service-level', () => {
  for (const caseId of SINGLE_STEP_CASES) {
    it(`${caseId}: upstream wire + downstream surface byte-exact`, async () => {
      await replaySteps([caseId])
    })
  }

  it('S2d7-19-cooldown-after-429: composed with the S2d7-10 429 (shared service + Store)', async () => {
    await replaySteps(['S2d7-10-upstream-429', 'S2d7-19-cooldown-after-429'])
  })

  it('S2d7-31-counttokens-cooldown: 429 setup, then a countTokens gated by the live window', async () => {
    const caseId = 'S2d7-31-counttokens-cooldown'
    const service = createGem2ClaService({
      apiKeys: GATEWAY_API_KEYS,
      credentials: CREDENTIALS,
      gatewayVersion: GATEWAY_VERSION,
      store: new MemoryStore(),
      now: () => FROZEN_NOW_MS,
      requestRetry: 0,
      transientErrorCooldownSeconds: -1,
    })
    const steps = readRecordedSteps(caseId)
    expect(steps.length, `${caseId}: recorded step count`).toBe(2)
    const mock = readStepMockResponse(caseId, 1)
    const captured: Gem2ClaUpstreamRequest[] = []
    const send: Gem2ClaUpstreamSender = async (call) => {
      captured.push(call)
      return buildMockResponse(mock.control, mock.reply, mock.script, call)
    }
    for (let step = 0; step < steps.length; step++) {
      const recorded = steps[step]
      if (recorded === undefined) throw new Error('harness bug: missing recorded step')
      const request: Gem2ClaRequest = {
        method: recorded.request.method,
        path: recorded.request.path,
        headers: Object.entries(recorded.request.headers).map(([name, value]) => [name, value] as [string, string]),
        body: recorded.request.body,
      }
      const response = await service.handleV1beta(request, send)
      await assertDownstream(response, recorded.downstream, `${caseId} step ${step + 1}`)
    }
    const expectedCalls = readRecordedUpstreams(caseId)
    expect(captured.length, `${caseId}: upstream calls (the gated count must add none)`).toBe(expectedCalls.length)
    for (let i = 0; i < expectedCalls.length; i++) {
      const expected = expectedCalls[i]
      const actual = captured[i]
      expect(expected).toBeDefined()
      expect(actual).toBeDefined()
      if (expected === undefined || actual === undefined) continue
      assertUpstreamWire(expected, actual, caseId)
    }
  })
})
