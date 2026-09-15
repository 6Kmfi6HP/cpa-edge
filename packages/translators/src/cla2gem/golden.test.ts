/**
 * Golden replay: every recorded S2d8 case, service-level end to end.
 *
 * Each recorded client request is driven through `createCla2GemService`
 * against a mock transport that replays the case's own `mock_control`
 * (canned non-stream JSON, canned SSE chunks, slow-chunk delivery without
 * delays, mid-stream disconnect aborts, canned error replies). The
 * captured upstream wire (method, url, ordered headers, body) is compared
 * byte-exact against upstream.jsonl; the downstream surface (status,
 * direction-owned headers, body bytes - and the decoded SSE event
 * sequence per R-SSE) is compared byte-exact against downstream.md.
 * `message_start.usage.input_tokens` is asserted byte-exactly (ruling
 * S2d8-1; recorded values 4/9/32/4).
 */
import { describe, expect, it } from 'vitest'
import { MemoryStore } from '@cpa-edge/core'
import { createCla2GemService } from './service'
import type {
  Cla2GemRequest,
  Cla2GemResponse,
  Cla2GemUpstreamRequest,
  Cla2GemUpstreamResponse,
  Cla2GemUpstreamSender,
} from './service'
import { parseDownstreamSse } from './sse'
import {
  readMockControl,
  readRecordedDownstream,
  readRecordedRequest,
  readRecordedUpstreams,
} from './fixture-reader'
import type { RecordedUpstream } from './fixture-reader'

const GATEWAY_API_KEYS: readonly string[] = ['oracle-local-key-1']
const FROZEN_NOW_MS = 1_789_504_384_000
const CREDENTIALS = [
  {
    apiKey: 'mock-gem-key',
    baseUrl: 'http://host.docker.internal:19001',
    models: [{ name: 'gemini-mock-model', alias: 'gm', thinking: false as const }],
  },
]
const encoder = new TextEncoder()

const CASES = [
  'S2d8-01-nostream-basic',
  'S2d8-02-nostream-alias',
  'S2d8-03-nostream-system-array',
  'S2d8-04-nostream-tool-call',
  'S2d8-05-nostream-tool-history',
  'S2d8-06-nostream-image',
  'S2d8-07-nostream-thinking',
  'S2d8-08-nostream-maxtokens',
  'S2d8-09-stream-basic',
  'S2d8-10-stream-thinking',
  'S2d8-11-stream-tool-call',
  'S2d8-12-stream-empty',
  'S2d8-13-count-tokens',
  'S2d8-14-err-429',
  'S2d8-15-err-400',
  'S2d8-16-slow-chunks',
  'S2d8-17-disconnect',
  'S2d8-18-stream-error-before-first-chunk',
] as const

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

/** Builds the upstream reply the recorded mock served for this case. */
function buildMockResponse(control: Readonly<Record<string, unknown>>): Cla2GemUpstreamResponse {
  const mode = typeof control['mode'] === 'string' ? control['mode'] : 'happy'
  if (mode === 'error') {
    const status = typeof control['status'] === 'number' ? control['status'] : 500
    const bodyText =
      typeof control['error_body'] === 'string'
        ? control['error_body']
        : JSON.stringify(control['error_body'] ?? {})
    return {
      status,
      headers: [['Content-Type', 'application/json']],
      body: scriptedByteStream([encoder.encode(bodyText)]),
    }
  }

  const cannedCount = control['canned_count']
  if (typeof cannedCount === 'object' && cannedCount !== null) {
    return {
      status: 200,
      headers: [['Content-Type', 'application/json']],
      body: scriptedByteStream([encoder.encode(JSON.stringify(cannedCount))]),
    }
  }

  const cannedStream = control['canned_stream']
  if (Array.isArray(cannedStream)) {
    // One `data: <json>` line per canned chunk, compact serialization (the
    // recorded mock serialized args compactly; partial_json splices them).
    const chunks = cannedStream.map((chunk) => encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
    const abortAfter =
      mode === 'disconnect' && typeof control['after'] === 'number' ? control['after'] : undefined
    return {
      status: 200,
      headers: [['Content-Type', 'text/event-stream']],
      body: scriptedByteStream(chunks, { abortAfter }),
    }
  }

  const cannedNonStream = control['canned_nonstream']
  const bodyText =
    typeof cannedNonStream === 'string' ? cannedNonStream : JSON.stringify(cannedNonStream ?? {})
  return {
    status: 200,
    headers: [['Content-Type', 'application/json']],
    body: scriptedByteStream([encoder.encode(bodyText)]),
  }
}

async function readResponseBody(body: Cla2GemResponse['body']): Promise<string> {
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

function assertUpstreamWire(recorded: RecordedUpstream, call: Cla2GemUpstreamRequest, caseId: string): void {
  const context = `${caseId} upstream wire`
  expect(call.method, `${context}: method`).toBe(recorded.method)
  expect(call.url, `${context}: url`).toBe(`${CREDENTIALS[0]?.baseUrl ?? ''}${recorded.path}`)
  const expectedPairs: Array<[string, string]> = []
  for (const [name, value] of Object.entries(recorded.headers)) {
    if (name.toLowerCase() === 'content-length') continue
    expectedPairs.push([name, value === '<redacted>' ? '<redacted>' : value])
  }
  const actualPairs: Array<[string, string]> = []
  for (const [name, value] of call.headers) {
    if (name.toLowerCase() === 'content-length') {
      expect(value, `${context}: Content-Length matches the body bytes`).toBe(
        String(encoder.encode(call.body).length),
      )
      continue
    }
    actualPairs.push([name, name.toLowerCase() === 'x-goog-api-key' ? '<redacted>' : value])
  }
  expect(actualPairs, `${context}: ordered header list`).toEqual(expectedPairs)
  expect(call.body, `${context}: translated body bytes`).toBe(recorded.body)
}

async function assertDownstream(response: Cla2GemResponse, caseId: string): Promise<void> {
  const expected = readRecordedDownstream(caseId)
  const body = await readResponseBody(response.body)
  expect(response.status, `${caseId}: status`).toBe(expected.status)
  expect(headerValue(response.headers, 'content-type'), `${caseId}: Content-Type`).toBe(
    expected.headers['Content-Type'],
  )
  if (expected.sse) {
    // Raw byte stream first (my framing is deterministic), then the
    // R-SSE decoded event sequence.
    expect(body, `${caseId}: SSE byte stream`).toBe(expected.body)
    expect(
      parseDownstreamSse(body),
      `${caseId}: decoded SSE event sequence (R-SSE)`,
    ).toEqual(parseDownstreamSse(expected.body))
  } else {
    expect(body, `${caseId}: body bytes`).toBe(expected.body)
  }
}

describe('S2d8 golden replay — service-level', () => {
  for (const caseId of CASES) {
    it(`${caseId}: upstream wire + downstream surface byte-exact`, async () => {
      const service = createCla2GemService({
        apiKeys: GATEWAY_API_KEYS,
        credentials: CREDENTIALS,
        store: new MemoryStore(),
        now: () => FROZEN_NOW_MS,
        requestRetry: 0,
        transientErrorCooldownSeconds: -1,
      })
      const recorded = readRecordedRequest(caseId)
      const request: Cla2GemRequest = {
        method: recorded.method,
        path: recorded.path,
        headers: Object.entries(recorded.headers).map(([name, value]) => [name, value] as [string, string]),
        body: recorded.body,
      }
      const captured: Cla2GemUpstreamRequest[] = []
      const send: Cla2GemUpstreamSender = async (call) => {
        captured.push(call)
        return buildMockResponse(readMockControl(caseId).control)
      }
      const response = await service.handleV1Messages(request, send)
      await assertDownstream(response, caseId)

      const upstreams = readRecordedUpstreams(caseId)
      expect(captured.length, `${caseId}: upstream call count`).toBe(upstreams.length)
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
