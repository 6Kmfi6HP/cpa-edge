/**
 * Golden replay: every recorded S2d5 case through the full facade.
 *
 * Per case the harness builds a fresh service + fresh MemoryStore (the
 * cooldown pair of S2D5-24 shares them WITHIN the case) with a frozen
 * clock, plays the mock upstream from the fixture's own mock-response.json
 * (control + embedded script events, plus the default canned stream), and
 * asserts:
 *
 * - upstream wire byte-exact after masking the derived session UUID and the
 *   Authorization token (method, url, ordered header list, body bytes);
 * - upstream call count: cooldown steps make NO upstream call;
 * - downstream surface byte-exact (status, Content-Type/Cache-Control
 *   presence, body bytes; SSE bodies compare as decoded data frames per
 *   R-SSE, adjacent tool_calls deltas as a sorted multiset per R-ORDER; the
 *   cooldown timing fields are time-dependent and masked per spec section 7
 *   note 13).
 */
import { describe, expect, it } from 'vitest'
import { MemoryStore } from '@cpa-edge/core'
import { createOai2CodexService } from './service'
import type {
  Oai2CodexChatRequest,
  Oai2CodexChatResponse,
  Oai2CodexUpstreamRequest,
  Oai2CodexUpstreamResponse,
  Oai2CodexUpstreamSender,
} from './service'
import {
  readMockResponse,
  readRecordedDownstreams,
  readRecordedRequests,
  readRecordedUpstreams,
} from './fixture-reader'

const UPSTREAM_MODEL = 'gpt-mock-codex'
const UPSTREAM_BASE = 'http://host.docker.internal:21003'
const UPSTREAM_KEY = 'mock-codex-key'
const GATEWAY_VERSION = 'v7.3.4'
const FROZEN_NOW_MS = 1_789_495_200_000

const encoder = new TextEncoder()

interface MockEvent {
  readonly event: string
  readonly data: unknown
}

/** Default canned stream (mock "happy" mode), transcribed from the recordings. */
const DEFAULT_SCRIPT: readonly MockEvent[] = [{"event":"response.created","data":{"type":"response.created","response":{"id":"resp_mock_01","object":"response","created_at":1770000000,"status":"in_progress","model":"gpt-mock-codex","output":[],"usage":{"input_tokens":9,"output_tokens":6,"total_tokens":15},"parallel":false,"tool_choice":"auto","tools":[]}}},{"event":"response.output_item.added","data":{"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_mock_01","role":"assistant","status":"in_progress","content":[]}}},{"event":"response.content_part.added","data":{"type":"response.content_part.added","item_id":"msg_mock_01","output_index":0,"content_index":0,"part":{"type":"output_text","text":"","annotations":[]}}},{"event":"response.output_text.delta","data":{"type":"response.output_text.delta","item_id":"msg_mock_01","output_index":0,"content_index":0,"delta":"Hello from mock codex upstream"}},{"event":"response.output_text.delta","data":{"type":"response.output_text.delta","item_id":"msg_mock_01","output_index":0,"content_index":0,"delta":" more"}},{"event":"response.output_text.done","data":{"type":"response.output_text.done","item_id":"msg_mock_01","output_index":0,"content_index":0,"text":"Hello from mock codex upstream more"}},{"event":"response.content_part.done","data":{"type":"response.content_part.done","item_id":"msg_mock_01","output_index":0,"content_index":0,"part":{"type":"output_text","text":"Hello from mock codex upstream more","annotations":[]}}},{"event":"response.output_item.done","data":{"type":"response.output_item.done","output_index":0,"item":{"type":"message","id":"msg_mock_01","role":"assistant","status":"completed","content":[{"type":"output_text","text":"Hello from mock codex upstream more","annotations":[]}]}}},{"event":"response.completed","data":{"type":"response.completed","response":{"id":"resp_mock_01","object":"response","created_at":1770000000,"status":"completed","model":"gpt-mock-codex","output":[{"type":"message","id":"msg_mock_01","role":"assistant","status":"completed","content":[{"type":"output_text","text":"Hello from mock codex upstream more","annotations":[]}]}],"usage":{"input_tokens":9,"output_tokens":6,"total_tokens":15},"parallel":false,"tool_choice":"auto","tools":[]}}}]

/** Serializes like Python's json.dumps defaults - the recorded verbatim error bodies depend on it. */
function pythonJson(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value)
  if (Array.isArray(value)) return `[${value.map(pythonJson).join(', ')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}: ${pythonJson(entry)}`).join(', ')}}`
  }
  throw new Error(`mock upstream cannot serialize value of type ${typeof value}`)
}

/** Demand-driven byte stream; the read after `abortAfter` chunks errors. */
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

/** Script events for a control: embedded fixture events, else the default. */
function scriptEventsFor(control: Record<string, unknown>, embedded: readonly Record<string, unknown>[]): readonly MockEvent[] {
  if (embedded.length > 0) {
    return embedded.map((entry) => ({ event: String(entry['event'] ?? ''), data: entry['data'] }))
  }
  void control
  return DEFAULT_SCRIPT
}

/** Upstream response for one mock control. */
function buildMockResponse(
  control: Record<string, unknown>,
  embedded: readonly Record<string, unknown>[],
  reply: Readonly<Record<string, unknown>> | undefined,
): Oai2CodexUpstreamResponse {
  const mode = typeof control['mode'] === 'string' ? control['mode'] : 'happy'
  if (mode === 'error') {
    const replyRecord = reply ?? {}
    const status = typeof control['status'] === 'number' ? control['status'] : typeof replyRecord['status'] === 'number' ? (replyRecord['status'] as number) : 500
    const bodyObject = replyRecord['body']
    const bodyText = bodyObject !== undefined ? pythonJson(bodyObject) : ''
    return { status, headers: [['Content-Type', 'application/json']], body: scriptedByteStream([encoder.encode(bodyText)]) }
  }
  const events = scriptEventsFor(control, embedded)
  const chunks = events.map((mockEvent) => {
    const data = pythonJson(mockEvent.data)
    return encoder.encode(`event: ${mockEvent.event}\ndata: ${data}\n\n`)
  })
  const abortAfter = mode === 'disconnect' ? (typeof control['after'] === 'number' ? (control['after'] as number) : events.length) : undefined
  return { status: 200, headers: [['Content-Type', 'text/event-stream']], body: scriptedByteStream(chunks, { abortAfter }) }
}

// ---------------------------------------------------------------------------
// Comparison helpers
// ---------------------------------------------------------------------------

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

/** Masks the derived session UUID (both sides) and cooldown timing fields. */
function normalize(text: string): string {
  return text
    .replace(UUID_RE, '<UUID>')
    .replace(/"reset_seconds":\d+/g, '"reset_seconds":<N>')
    .replace(/"reset_time":"[^"]*"/g, '"reset_time":"<T>"')
}

function headerValue(headers: ReadonlyArray<readonly [string, string]>, name: string): string | undefined {
  const key = name.toLowerCase()
  for (const [headerName, value] of headers) {
    if (headerName.toLowerCase() === key) return value
  }
  return undefined
}

async function readResponseBody(body: Oai2CodexChatResponse['body']): Promise<string> {
  if (typeof body === 'string') return body
  if (body !== null && typeof body === 'object' && typeof body.getReader === 'function') {
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
  throw new Error('adapter response body must be a string or a web ReadableStream')
}

function decodeSseDataFrames(body: string): string[] {
  const frames: string[] = []
  for (const block of body.split('\n\n')) {
    for (const line of block.split('\n')) {
      if (line.startsWith('data: ')) frames.push(line.slice('data: '.length))
    }
  }
  return frames
}

/** R-ORDER allowance: adjacent tool_calls delta frames compare as a sorted multiset. */
function expectFrameSequence(actual: readonly string[], expected: readonly string[], context: string): void {
  expect(actual.length, `${context}: decoded frame count (${expected.length} recorded)`).toBe(expected.length)
  const isToolFrame = (frame: string | undefined) => frame !== undefined && frame.includes('"delta":{"tool_calls"')
  let index = 0
  while (index < expected.length) {
    if (isToolFrame(expected[index]) && isToolFrame(actual[index])) {
      let expectedEnd = index
      while (expectedEnd < expected.length && isToolFrame(expected[expectedEnd])) expectedEnd += 1
      let actualEnd = index
      while (actualEnd < actual.length && isToolFrame(actual[actualEnd])) actualEnd += 1
      expect([...actual.slice(index, actualEnd)].sort(), `${context}: tool_calls frame multiset`).toEqual(
        [...expected.slice(index, expectedEnd)].sort(),
      )
      index = expectedEnd
      continue
    }
    expect(actual[index], `${context}: SSE frame ${index}`).toBe(expected[index])
    index += 1
  }
}

// ---------------------------------------------------------------------------
// Case replay
// ---------------------------------------------------------------------------

const CASE_IDS = [
  'S2D5-01-nonstream-basic-aggregation',
  'S2D5-02-stream-basic',
  'S2D5-03-system-developer-multimodal',
  'S2D5-04-reasoning-effort-high',
  'S2D5-05-reasoning-effort-none',
  'S2D5-06-tools-history',
  'S2D5-07-stream-toolcall',
  'S2D5-08-nonstream-toolcall',
  'S2D5-09-stream-reasoning-deltas',
  'S2D5-10-nonstream-reasoning-item',
  'S2D5-11-stream-incomplete-length',
  'S2D5-12-nonstream-empty-output-patch',
  'S2D5-13-usage-rich',
  'S2D5-14-service-tier',
  'S2D5-15-upstream-429-nonstream',
  'S2D5-16-upstream-429-stream-precommit',
  'S2D5-17-disconnect-midstream',
  'S2D5-18-terminal-failure-midstream',
  'S2D5-19-terminal-failure-first',
  'S2D5-20-model-not-found',
  'S2D5-21-prompt-cache-key-passthrough',
  'S2D5-22-client-session-id-header',
  'S2D5-23-response-format-json-schema',
  'S2D5-24-rate-limit-cooldown-pair',
  'S2D5-25-union-schema-enum-rewrite',
  'S2D5-26-empty-incomplete-zero-tokens',
] as const

function toChatRequest(record: {
  readonly method: string
  readonly path: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}): Oai2CodexChatRequest {
  const headers: Array<[string, string]> = []
  for (const [name, value] of Object.entries(record.headers)) headers.push([name, value])
  return { method: record.method, path: record.path, headers, body: record.body }
}

describe('S2d5 golden replay - full facade', () => {
  for (const caseId of CASE_IDS) {
    it(`${caseId}: upstream wire + downstream bytes replay exactly`, async () => {
      const mock = readMockResponse(caseId)
      const recordedRequests = readRecordedRequests(caseId)
      const recordedDownstreams = readRecordedDownstreams(caseId)
      const recordedUpstreams = readRecordedUpstreams(caseId)
      expect(recordedRequests.length).toBeGreaterThan(0)
      expect(recordedDownstreams.length).toBe(recordedRequests.length)

      const service = createOai2CodexService({
        credentials: [
          {
            apiKey: UPSTREAM_KEY,
            baseUrl: UPSTREAM_BASE,
            models: [{ name: UPSTREAM_MODEL, alias: 'cx' }],
          },
        ],
        gatewayVersion: GATEWAY_VERSION,
        store: new MemoryStore({ now: () => FROZEN_NOW_MS }),
        now: () => FROZEN_NOW_MS,
        requestRetry: 0,
        transientErrorCooldownSeconds: -1,
      })

      const captured: Oai2CodexUpstreamRequest[] = []
      const send: Oai2CodexUpstreamSender = async (call) => {
        captured.push(call)
        return buildMockResponse(mock.control, mock.scriptEvents, mock.reply)
      }

      for (let step = 0; step < recordedRequests.length; step++) {
        const recorded = recordedRequests[step]
        const expected = recordedDownstreams[step]
        expect(recorded).toBeDefined()
        expect(expected).toBeDefined()
        if (recorded === undefined || expected === undefined) continue
        const response = await service.handleChatCompletions(toChatRequest(recorded), send)
        const body = await readResponseBody(response.body)

        expect(response.status, `${caseId} step ${step + 1}: status`).toBe(expected.status)
        const expectedContentType = headerValue(Object.entries(expected.headers), 'content-type')
        expect(expectedContentType, `${caseId} step ${step + 1}: fixture records Content-Type`).toBeDefined()
        expect(headerValue(response.headers, 'content-type'), `${caseId} step ${step + 1}: Content-Type`).toBe(expectedContentType)
        const expectedCacheControl = headerValue(Object.entries(expected.headers), 'cache-control')
        const actualCacheControl = headerValue(response.headers, 'cache-control')
        if (expectedCacheControl === undefined) {
          expect(actualCacheControl, `${caseId} step ${step + 1}: Cache-Control must be absent outside SSE`).toBeUndefined()
        } else {
          expect(actualCacheControl, `${caseId} step ${step + 1}: Cache-Control`).toBe(expectedCacheControl)
        }
        const expectedRetryAfter = headerValue(Object.entries(expected.headers), 'retry-after')
        if (expectedRetryAfter === undefined) {
          expect(headerValue(response.headers, 'retry-after'), `${caseId} step ${step + 1}: Retry-After must be absent`).toBeUndefined()
        } else {
          expect(headerValue(response.headers, 'retry-after'), `${caseId} step ${step + 1}: Retry-After present`).toBeDefined()
        }

        if (expectedContentType === 'text/event-stream') {
          for (const line of body.split('\n')) {
            expect(line.startsWith('event:'), `${caseId} step ${step + 1}: downstream must be data:-only`).toBe(false)
          }
          expectFrameSequence(decodeSseDataFrames(body), decodeSseDataFrames(expected.body), `${caseId} step ${step + 1}`)
        } else {
          expect(normalize(body), `${caseId} step ${step + 1}: body bytes`).toBe(normalize(expected.body))
        }
      }

      expect(captured.length, `${caseId}: upstream call count (cooldown steps call nothing)`).toBe(recordedUpstreams.length)
      for (let index = 0; index < recordedUpstreams.length; index++) {
        const recorded = recordedUpstreams[index]
        const call = captured[index]
        expect(call, `${caseId}: missing upstream call ${index}`).toBeDefined()
        if (recorded === undefined || call === undefined) continue
        expect(call.method, `${caseId}: method`).toBe(recorded.method)
        expect(call.url, `${caseId}: url`).toBe(`${UPSTREAM_BASE}${recorded.path}`)

        const expectedPairs: Array<[string, string]> = []
        for (const [name, value] of Object.entries(recorded.headers)) {
          if (name.toLowerCase() === 'content-length') continue
          expectedPairs.push([name, name.toLowerCase() === 'authorization' ? '<redacted>' : normalize(value)])
        }
        const actualPairs: Array<[string, string]> = []
        let actualContentLength: string | undefined
        for (const [name, value] of call.headers) {
          if (name.toLowerCase() === 'content-length') {
            actualContentLength = value
            continue
          }
          actualPairs.push([name, name.toLowerCase() === 'authorization' ? '<redacted>' : normalize(value)])
        }
        expect(actualPairs, `${caseId}: ordered upstream header list`).toEqual(expectedPairs)
        if (actualContentLength !== undefined) {
          expect(actualContentLength, `${caseId}: Content-Length matches body`).toBe(String(encoder.encode(call.body).length))
        }
        expect(normalize(call.body), `${caseId}: translated upstream body`).toBe(normalize(recorded.body))
      }
    })
  }
})
