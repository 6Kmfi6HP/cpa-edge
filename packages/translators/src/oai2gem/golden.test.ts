/**
 * Golden replay: every recorded S2d1 case, service-level end to end.
 *
 * Each recorded client request is driven through `createOai2GemService`
 * against a mock transport that replays the case's own mock-response.json
 * with the recorded mock byte style (Python json.dumps spacing - the raw
 * argument bytes the fixtures pin ride inside it). The captured upstream
 * wire (method, url, ordered headers, body) is compared byte-exact
 * against upstream.jsonl; the downstream surface (status,
 * direction-owned headers, body bytes / decoded SSE frames per R-SSE) is
 * compared byte-exact against downstream.md with the volatile tool-call
 * id tails masked.
 *
 * C16 is composed like the contract suite: the recorded C15 429 opens the
 * ~1s rate-limit window, then C16's request lands inside it (shared
 * service + Store, frozen clock).
 */
import { describe, expect, it } from 'vitest'
import { MemoryStore } from '@cpa-edge/core'
import { createOai2GemService } from './service'
import type {
  Oai2GemChatResponse,
  Oai2GemCredential,
  Oai2GemUpstreamRequest,
  Oai2GemUpstreamResponse,
  Oai2GemUpstreamSender,
} from './service'
import type { HeaderList } from './types'
import {
  listCaseIds,
  readCaseMeta,
  readMockResponse,
  readRecordedDownstream,
  readRecordedRequest,
  readRecordedUpstreams,
} from './fixture-reader'
import type { RecordedDownstream, RecordedUpstream } from './fixture-reader'

const GATEWAY_API_KEYS: readonly string[] = ['oracle-local-key-1']
const FROZEN_NOW_MS = 1_789_507_015_000
const BASE_URL = 'http://host.docker.internal:20001'
const API_KEY = 'mock-gemini-upstream-key'

const CREDENTIALS: readonly Oai2GemCredential[] = [
  {
    apiKey: API_KEY,
    baseUrl: BASE_URL,
    models: [
      { name: 'gemini-mock-model', alias: 'mock-gemini-flash' },
      { name: 'gemini-mock-model-tools', alias: 'mock-gemini-tools' },
      { name: 'gemini-mock-model-maxtok', alias: 'mock-gemini-maxtok' },
      { name: 'gemini-mock-model-usage', alias: 'mock-gemini-usage' },
      { name: 'gemini-mock-model-think', alias: 'mock-gemini-think' },
      { name: 'gemini-mock-model-n2', alias: 'mock-gemini-n2' },
      { name: 'gemini-mock-model-img', alias: 'mock-gemini-img' },
      { name: 'gemini-mock-model-split', alias: 'mock-gemini-split' },
      { name: 'gemini-mock-model-err429', alias: 'mock-gemini-err429' },
      { name: 'gemini-mock-model-err400', alias: 'mock-gemini-err400' },
      { name: 'gemini-mock-model-streamerr', alias: 'mock-gemini-streamerr' },
      { name: 'gemini-mock-model-disc', alias: 'mock-gemini-disc' },
      { name: 'gemini-mock-model-force', alias: 'mock-gemini-force', forceMapping: true },
      { name: 'gemini-mock-model-n2stream', alias: 'mock-gemini-n2stream' },
    ],
  },
]

const CASES = [
  'C01-nostream-basic',
  'C02-nostream-multiturn',
  'C03-nostream-tools-history',
  'C04-nostream-tool-call',
  'C05-nostream-max-tokens',
  'C06-nostream-usage-details',
  'C07-nostream-reasoning-effort',
  'C08-nostream-model-suffix',
  'C09-nostream-n2-candidates',
  'C10-nostream-image-data-url',
  'C11-stream-basic',
  'C12-stream-tool-call',
  'C13-stream-max-tokens',
  'C14-stream-no-terminal-merge',
  'C15-error-429-nostream',
  'C16-error-429-cooldown',
  'C17-error-400-nostream',
  'C18-stream-error-before-first-byte',
  'C19-stream-disconnect-mid-stream',
  'C20-nostream-force-mapping',
  'C21-stream-force-mapping',
  'C22-stream-n2-candidates',
  'C23-stream-c1-only-finish',
] as const

type CaseId = (typeof CASES)[number]

/** C16 recorded only the in-window delta; its replay composes C15 first. */
const COMPOSED_STEPS: Readonly<Record<string, readonly string[]>> = {
  'C16-error-429-cooldown': ['C15-error-429-nostream', 'C16-error-429-cooldown'],
}

const encoder = new TextEncoder()

/** The mock's built-in gemini error body (recorded verbatim in C15/C18). */
const DEFAULT_GEMINI_ERROR_BODY = '{"error": {"code": 429, "message": "mock rate limit", "status": "RESOURCE_EXHAUSTED"}}'

/** Python json.dumps byte style - the recording mock's serialization. */
function pythonJson(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean') return value === null ? 'null' : String(value)
  if (value === null) return 'null'
  if (Array.isArray(value)) return `[${value.map(pythonJson).join(', ')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}: ${pythonJson(entry)}`).join(', ')}}`
  }
  throw new Error(`mock upstream cannot serialize value of type ${typeof value}`)
}

/** The mock's default non-stream reply (C01 recorded it end to end). */
function defaultNonStreamReply(modelVersion: string): unknown {
  return {
    candidates: [
      {
        content: { parts: [{ text: 'Hello from mock gemini upstream more' }], role: 'model' },
        finishReason: 'STOP',
        index: 0,
      },
    ],
    usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 6, totalTokenCount: 15 },
    modelVersion,
  }
}

/**
 * The mock's default reply for the `-tools` model: the recorded C03
 * downstream (tool_calls + usage 11/3/14) pins it; C04 transcribes the
 * same behavior as its scripted reply.
 */
function toolsDefaultReply(modelVersion: string): unknown {
  return {
    candidates: [
      {
        content: { parts: [{ functionCall: { name: 'get_weather', args: { city: 'Paris' } } }], role: 'model' },
        finishReason: 'STOP',
        index: 0,
      },
    ],
    usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 3, totalTokenCount: 14 },
    modelVersion,
  }
}

/** The mock's default 3-event stream (C11 recorded it end to end). */
function defaultStreamEvents(modelVersion: string): readonly unknown[] {
  return [
    { candidates: [{ content: { parts: [{ text: 'Hello from mock gemini upstream' }], role: 'model' }, index: 0 }] },
    { candidates: [{ content: { parts: [{ text: ' more' }], role: 'model' }, index: 0 }] },
    {
      candidates: [{ content: { parts: [], role: 'model' }, finishReason: 'STOP', index: 0 }],
      usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 6, totalTokenCount: 15 },
      modelVersion,
    },
  ]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function translatedModel(body: string, fallback: string): string {
  try {
    const parsed = JSON.parse(body) as { model?: unknown }
    if (typeof parsed.model === 'string' && parsed.model !== '') return parsed.model
  } catch {
    // fall through to the recorded fallback
  }
  return fallback
}

/** Demand-driven byte stream; the read after the last chunk closes or errors. */
function scriptedByteStream(
  chunks: readonly Uint8Array[],
  options: { readonly abortAfter?: number; readonly abortError?: string } = {},
): ReadableStream<Uint8Array> {
  let served = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const index = served
      served += 1
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

/** Builds the upstream response for one captured call from the case's script. */
function buildMockResponse(
  caseId: string,
  control: Readonly<Record<string, unknown>>,
  scripted: unknown,
  metaStream: boolean,
  upstreamModel: string,
  upstreamRequest: Oai2GemUpstreamRequest,
): Oai2GemUpstreamResponse {
  const mode = typeof control['mode'] === 'string' ? control['mode'] : 'happy'
  if (mode === 'error') {
    const status = typeof control['status'] === 'number' ? control['status'] : 429
    const bodyText = control['error_body'] !== undefined ? pythonJson(control['error_body']) : DEFAULT_GEMINI_ERROR_BODY
    return { status, headers: [['Content-Type', 'application/json']], body: scriptedByteStream([encoder.encode(bodyText)]) }
  }
  if (mode !== 'happy' && mode !== 'disconnect') {
    throw new Error(`${caseId}: unrecognized mock control mode ${JSON.stringify(mode)}`)
  }

  const modelVersion = translatedModel(upstreamRequest.body, upstreamModel)
  let events: readonly unknown[]
  if (typeof scripted === 'string') {
    if (metaStream) {
      events = defaultStreamEvents(modelVersion)
    } else if (caseId === 'C03-nostream-tools-history') {
      events = [toolsDefaultReply(modelVersion)]
    } else {
      events = [defaultNonStreamReply(modelVersion)]
    }
  } else if (isRecord(scripted) && Array.isArray(scripted['stream_events'])) {
    events = scripted['stream_events']
  } else if (isRecord(scripted)) {
    events = [scripted]
  } else {
    throw new Error(`${caseId}: scripted_mock_response shape not recognized`)
  }

  if (metaStream) {
    const frames = events.map((event) => encoder.encode(`data: ${pythonJson(event)}\n\n`))
    return {
      status: 200,
      headers: [['Content-Type', 'text/event-stream']],
      body: scriptedByteStream(frames, {
        abortAfter: mode === 'disconnect' ? (typeof control['after'] === 'number' ? control['after'] : undefined) : undefined,
        abortError: 'unexpected EOF',
      }),
    }
  }
  const bodyText = events.map((event) => pythonJson(event)).join('\n')
  return { status: 200, headers: [['Content-Type', 'application/json']], body: scriptedByteStream([encoder.encode(bodyText)]) }
}

// ---------------------------------------------------------------------------
// Comparison helpers
// ---------------------------------------------------------------------------

const TOOL_CALL_ID_TAIL_RE = /("id":")([A-Za-z0-9_.:-]+)-\d+-\d+(")/g

function maskToolCallIds(text: string): string {
  return text.replace(TOOL_CALL_ID_TAIL_RE, '$1$2-<ID>$3')
}

function headerValue(headers: HeaderList, name: string): string | undefined {
  const key = name.toLowerCase()
  for (const [headerName, value] of headers) {
    if (headerName.toLowerCase() === key) return value
  }
  return undefined
}

async function readResponseBody(body: Oai2GemChatResponse['body']): Promise<string> {
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

/** R-SSE decoder: the ordered `data:` payload strings of a downstream body. */
function decodeSseFrames(body: string, context: string): readonly string[] {
  const frames: string[] = []
  for (const block of body.split('\n\n')) {
    if (block === '') continue
    const dataLines: string[] = []
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) throw new Error(`${context}: SSE comment line: ${line}`)
      if (line.startsWith('event: ')) throw new Error(`${context}: unexpected event name: ${line}`)
      if (line.startsWith('data: ')) {
        dataLines.push(line.slice('data: '.length))
        continue
      }
      if (line === '') continue
      throw new Error(`${context}: unrecognized SSE line: ${line}`)
    }
    if (dataLines.length > 0) frames.push(dataLines.join('\n'))
  }
  return frames
}

function assertUpstreamWire(
  caseId: string,
  recorded: RecordedUpstream,
  call: Oai2GemUpstreamRequest,
): void {
  const context = `S2d1[${caseId}] upstream wire`
  expect(call.method, `${context}: method`).toBe(recorded.method)
  expect(call.url, `${context}: url`).toBe(`${BASE_URL}${recorded.path}`)
  const expectedPairs: Array<[string, string]> = []
  for (const [name, value] of Object.entries(recorded.headers)) {
    if (name.toLowerCase() === 'content-length') continue
    expectedPairs.push([name, value])
  }
  const actualPairs: Array<[string, string]> = []
  let contentLength: string | undefined
  for (const [name, value] of call.headers) {
    if (name.toLowerCase() === 'content-length') {
      contentLength = value
      continue
    }
    if (name.toLowerCase() === 'x-goog-api-key') {
      expect(value, `${context}: x-goog-api-key carries the credential key`).toBe(API_KEY)
      actualPairs.push([name, '<redacted>'])
      continue
    }
    actualPairs.push([name, value])
  }
  expect(actualPairs, `${context}: header list (order + names + values)`).toEqual(expectedPairs)
  if (contentLength !== undefined) {
    expect(contentLength, `${context}: Content-Length matches the body bytes`).toBe(String(encoder.encode(call.body).length))
  }
  expect(call.body, `${context}: translated body bytes`).toBe(recorded.body)
}

async function assertDownstream(
  caseId: string,
  response: Oai2GemChatResponse,
  expected: RecordedDownstream,
): Promise<void> {
  const context = `S2d1[${caseId}] downstream`
  const body = await readResponseBody(response.body)
  expect(response.status, `${context}: status`).toBe(expected.status)
  expect(headerValue(response.headers, 'content-type'), `${context}: Content-Type`).toBe(
    expected.headers['Content-Type'],
  )
  const expectedCacheControl = expected.headers['Cache-Control']
  const actualCacheControl = headerValue(response.headers, 'cache-control')
  if (expectedCacheControl === undefined) {
    expect(actualCacheControl, `${context}: Cache-Control absent outside SSE commits`).toBeUndefined()
  } else {
    expect(actualCacheControl, `${context}: Cache-Control`).toBe(expectedCacheControl)
  }
  const expectedRetryAfter = expected.headers['Retry-After']
  const actualRetryAfter = headerValue(response.headers, 'retry-after')
  if (expectedRetryAfter === undefined) {
    expect(actualRetryAfter, `${context}: Retry-After absent when the recording has none`).toBeUndefined()
  } else {
    expect(actualRetryAfter, `${context}: Retry-After`).toBe(expectedRetryAfter)
  }
  expect(
    headerValue(response.headers, 'x-cpa-trace-id') !== undefined,
    `${context}: X-Cpa-Trace-Id presence matches the recorded head`,
  ).toBe(expected.headers['X-Cpa-Trace-Id'] !== undefined)

  if (expected.headers['Content-Type'] === 'text/event-stream') {
    const expectedFrames = decodeSseFrames(expected.body, `${context}: recorded`)
    const actualFrames = decodeSseFrames(body, `${context}: produced`)
    expect(actualFrames.length, `${context}: decoded frame count`).toBe(expectedFrames.length)
    for (let index = 0; index < expectedFrames.length; index += 1) {
      expect(maskToolCallIds(actualFrames[index] ?? ''), `${context}: frame ${index}`).toBe(
        maskToolCallIds(expectedFrames[index] ?? ''),
      )
    }
    return
  }
  expect(maskToolCallIds(body), `${context}: body bytes`).toBe(maskToolCallIds(expected.body))
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

interface StepPlan {
  readonly caseId: string
  readonly request: ReturnType<typeof readRecordedRequest>
  readonly expected: RecordedDownstream
  readonly mockFile: ReturnType<typeof readMockResponse>
  readonly meta: ReturnType<typeof readCaseMeta>
  readonly recordedUpstream: readonly RecordedUpstream[]
}

async function loadCaseSteps(caseId: CaseId | string): Promise<readonly StepPlan[]> {
  const stepCaseIds = COMPOSED_STEPS[caseId] ?? [caseId]
  const steps: StepPlan[] = []
  for (const stepCaseId of stepCaseIds) {
    steps.push({
      caseId: stepCaseId,
      request: readRecordedRequest(stepCaseId),
      expected: readRecordedDownstream(stepCaseId),
      mockFile: readMockResponse(stepCaseId),
      meta: readCaseMeta(stepCaseId),
      recordedUpstream: readRecordedUpstreams(stepCaseId),
    })
  }
  return steps
}

async function replayCase(caseId: CaseId): Promise<void> {
  const steps = await loadCaseSteps(caseId)
  const now = (): number => FROZEN_NOW_MS
  const service = createOai2GemService({
    apiKeys: GATEWAY_API_KEYS,
    credentials: CREDENTIALS,
    store: new MemoryStore({ now }),
    now,
    requestRetry: 0,
    transientErrorCooldownSeconds: -1,
  })

  const captured: Array<{ step: number; call: Oai2GemUpstreamRequest }> = []
  let currentStep = 0
  const send: Oai2GemUpstreamSender = async (call) => {
    const step = steps[currentStep]
    if (step === undefined) throw new Error('harness bug: no step plan for the current upstream call')
    captured.push({ step: currentStep, call })
    return buildMockResponse(
      step.caseId,
      step.mockFile.control,
      step.mockFile.scripted,
      step.meta.stream,
      step.meta.upstreamModel,
      call,
    )
  }

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]
    if (step === undefined) throw new Error('unreachable: step index out of range')
    currentStep = index
    const response = await service.handleChatCompletions(
      {
        method: step.request.method,
        path: step.request.path,
        headers: Object.entries(step.request.headers).map(([name, value]) => [name, value] as [string, string]),
        body: step.request.body,
      },
      send,
    )
    await assertDownstream(step.caseId, response, step.expected)
  }

  const expectedTotal = steps.reduce((sum, step) => sum + step.recordedUpstream.length, 0)
  expect(captured.length, `S2d1[${caseId}]: upstream call count (cooldown steps dispatch nothing)`).toBe(expectedTotal)
  let cursor = 0
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]
    if (step === undefined) throw new Error('unreachable: step index out of range')
    for (const recorded of step.recordedUpstream) {
      const capturedCall = captured[cursor]
      expect(capturedCall, `S2d1[${caseId}]: missing upstream call ${cursor + 1}`).toBeDefined()
      if (capturedCall !== undefined) {
        expect(capturedCall.step, `S2d1[${caseId}]: call ${cursor + 1} belongs to step ${index + 1}`).toBe(index)
        assertUpstreamWire(step.caseId, recorded, capturedCall.call)
      }
      cursor += 1
    }
  }
}

describe('S2d1 — oai2gem golden replay (recorded fixtures)', () => {
  it('exposes exactly the 23 recorded cases', () => {
    expect([...listCaseIds()]).toEqual([...CASES].sort())
  })

  for (const caseId of CASES) {
    if (caseId === 'C16-error-429-cooldown') continue
    it(`${caseId} — replays the recorded exchange byte-exact`, async () => {
      await replayCase(caseId)
    })
  }

  it('C15 -> C16 — cooldown pair on one shared session, recording order', async () => {
    await replayCase('C16-error-429-cooldown')
  })
})
