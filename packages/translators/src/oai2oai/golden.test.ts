/**
 * Golden replay: the recorded S1 cases of this seam, facade-level end to
 * end.
 *
 * S1-14 (chat-nostream) and S1-15 (chat-stream) replay their recorded
 * requests through `createOai2OaiService` against a mock transport that
 * replays the case's own scripted reply (the recorder's Python
 * json.dumps serialization for non-stream bodies; the canned SSE frames
 * served verbatim, trailing-garbage braces and the `data: [DONE]` marker
 * included). BOTH sides of the wire are asserted byte-exact: the
 * captured upstream exchange (method, url, ordered headers with
 * Content-Length consistency, body bytes) against upstream.jsonl, and
 * the downstream surface (status, direction-owned headers, body bytes -
 * the full SSE byte stream included) against downstream.md.
 *
 * S1-16 recorded the SAME executor wire from the Claude client surface
 * (the messages:openai-compatibility seam - the cla2oai direction owns
 * its downstream translation). Its upstream.jsonl still pins THIS
 * executor's non-stream wire, so the third test replays the equivalent
 * chat-completions client body and asserts the byte-exact recorded
 * upstream exchange; the downstream side asserted there is the S1-14
 * verbatim rule applied to the same canned reply, not S1-16's
 * claude-shaped golden.
 */
import { describe, expect, it } from 'vitest'
import { MemoryStore } from '@cpa-edge/core'
import { createOai2OaiService } from './service'
import type {
  Oai2OaiRequest,
  Oai2OaiResponse,
  Oai2OaiUpstreamRequest,
  Oai2OaiUpstreamResponse,
  Oai2OaiUpstreamSender,
} from './service'
import {
  readRecordedDownstream,
  readRecordedMock,
  readRecordedRequest,
  readRecordedUpstreams,
} from './fixture-reader'
import type { RecordedDownstream, RecordedUpstream } from './fixture-reader'

const GATEWAY_API_KEYS: readonly string[] = ['oracle-local-key-1']
const CREDENTIALS = [
  {
    name: 'mock-openai',
    apiKey: 'mock-upstream-key',
    baseUrl: 'http://host.docker.internal:18999/v1',
    models: [{ name: 'mock-gpt-model', alias: 'mock-model' }],
  },
]
const FROZEN_NOW_MS = 1_789_490_828_000
const encoder = new TextEncoder()

/** Serializes a canned mock value the way the recording mock did. */
function pythonJson(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value === null || value === undefined) return 'null'
  if (Array.isArray(value)) return `[${value.map(pythonJson).join(', ')}]`
  if (typeof value === 'object') {
    const members = Object.entries(value as Record<string, unknown>).map(
      ([key, item]) => `${JSON.stringify(key)}: ${pythonJson(item)}`,
    )
    return `{${members.join(', ')}}`
  }
  throw new Error(`mock upstream cannot serialize value of type ${typeof value}`)
}

/** Demand-driven byte stream; each scripted chunk lands as one read. */
function byteStream(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoded = chunks.map((chunk) => encoder.encode(chunk))
  let served = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = encoded[served]
      served += 1
      if (chunk === undefined) {
        controller.close()
        return
      }
      controller.enqueue(chunk)
    },
  })
}

/** SSE reply: each canned frame lands as one chunk with its terminator. */
function scriptedSseStream(frames: readonly string[]): ReadableStream<Uint8Array> {
  return byteStream(frames.map((frame) => `${frame}\n\n`))
}

/** Builds the mock upstream reply for one recorded case (stream flag from the wire headers). */
function buildMockResponse(caseId: string, isStream: boolean): Oai2OaiUpstreamResponse {
  const mock = readRecordedMock(caseId)
  if (isStream) {
    if (mock.sseFrames === undefined) throw new Error(`${caseId}: no canned SSE frames to replay`)
    return {
      status: 200,
      headers: [['Content-Type', 'text/event-stream']],
      body: scriptedSseStream(mock.sseFrames),
    }
  }
  if (mock.nonStreamReply === undefined) throw new Error(`${caseId}: no canned non-stream reply to replay`)
  return {
    status: 200,
    headers: [['Content-Type', 'application/json']],
    // The recorder's mock serialized the canned object with Python
    // json.dumps defaults; the body crosses with no trailing newline.
    body: byteStream([pythonJson(mock.nonStreamReply)]),
  }
}

async function readResponseBody(body: Oai2OaiResponse['body']): Promise<string> {
  if (typeof body === 'string') return body
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let out = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value !== undefined) out += decoder.decode(value, { stream: true })
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

/** Downstream assertion: status, direction-owned headers, body bytes. */
async function assertDownstream(
  response: Oai2OaiResponse,
  golden: RecordedDownstream,
  caseId: string,
): Promise<void> {
  const body = await readResponseBody(response.body)
  expect(response.status, `${caseId}: status`).toBe(golden.status)
  expect(headerValue(response.headers, 'content-type'), `${caseId}: Content-Type`).toBe(
    headerValue(golden.headers, 'content-type'),
  )
  if (headerValue(golden.headers, 'content-type') === 'text/event-stream') {
    expect(headerValue(response.headers, 'cache-control'), `${caseId}: Cache-Control`).toBe(
      headerValue(golden.headers, 'cache-control'),
    )
    expect(headerValue(response.headers, 'connection'), `${caseId}: Connection`).toBe(
      headerValue(golden.headers, 'connection'),
    )
  }
  expect(body, `${caseId}: body bytes (full stream bytes for SSE)`).toBe(golden.body)
}

/** Upstream-wire assertion: the s2d2 order discipline at the facade seam. */
function assertUpstreamWire(
  recorded: RecordedUpstream,
  call: Oai2OaiUpstreamRequest,
  caseId: string,
): void {
  const context = `${caseId} upstream wire`
  expect(call.method, `${context}: method`).toBe(recorded.method)
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
      expect(value, `${context}: Content-Length matches the body bytes`).toBe(
        String(encoder.encode(call.body).length),
      )
      continue
    }
    actualPairs.push([name, name.toLowerCase() === 'authorization' ? '<redacted>' : value])
  }
  expect(actualPairs, `${context}: ordered header list`).toEqual(expectedPairs)
  expect(call.body, `${context}: rewritten body bytes`).toBe(recorded.body)
}

/** Drives one recorded case through the facade; returns the captured wire. */
async function replayCase(caseId: string, requestFile: string, downstreamFile: string): Promise<readonly Oai2OaiUpstreamRequest[]> {
  const recorded = readRecordedRequest(caseId, requestFile)
  const golden = readRecordedDownstream(caseId, downstreamFile)
  const wire = readRecordedUpstreams(caseId)
  const service = createOai2OaiService({
    apiKeys: GATEWAY_API_KEYS,
    credentials: CREDENTIALS,
    store: new MemoryStore(),
    now: () => FROZEN_NOW_MS,
    requestRetry: 0,
    transientErrorCooldownSeconds: -1,
  })
  const captured: Oai2OaiUpstreamRequest[] = []
  const send: Oai2OaiUpstreamSender = async (call) => {
    captured.push(call)
    const isStream = call.headers.some(
      ([name, value]) => name.toLowerCase() === 'accept' && value === 'text/event-stream',
    )
    return buildMockResponse(caseId, isStream)
  }
  const request: Oai2OaiRequest = {
    method: recorded.method,
    path: recorded.path,
    headers: recorded.headers,
    body: recorded.body,
  }
  const response = await service.handleChatCompletions(request, send)
  await assertDownstream(response, golden, caseId)

  expect(captured.length, `${caseId}: upstream call count`).toBe(wire.length)
  for (let index = 0; index < wire.length; index++) {
    const expected = wire[index]
    const call = captured[index]
    if (expected === undefined || call === undefined) continue
    assertUpstreamWire(expected, call, caseId)
  }
  return captured
}

describe('S1 golden replay - chat seam over the openai-compat executor', () => {
  it('S1-14 chat-nostream: alias rewrite + VERBATIM reply, both sides byte-exact', async () => {
    await replayCase('S1-14', 'chat-nostream.request.http', 'chat-nostream.downstream.md')
  })

  it('S1-15 chat-stream: stream_options injection + data-only re-framing, both sides byte-exact', async () => {
    await replayCase('S1-15', 'chat-stream.request.http', 'chat-stream.downstream.md')
  })

  it('S1-16 executor wire: the recorded non-stream exchange, replayed from the equivalent chat body', async () => {
    // S1-16 recorded POST /v1/messages (the claude client surface); the
    // cla2oai seam owns that downstream translation. Its upstream.jsonl
    // still pins THIS executor's wire, so the equivalent chat-completions
    // client body (the pre-rewrite form of the recorded upstream body)
    // replays the recorded exchange byte-exact.
    const wire = readRecordedUpstreams('S1-16')
    expect(wire.length).toBe(1)
    const recorded = wire[0]
    if (recorded === undefined) throw new Error('S1-16: upstream wire record missing')
    const clientBody = recorded.body.replace('"mock-gpt-model"', '"mock-model"')

    const service = createOai2OaiService({
      apiKeys: GATEWAY_API_KEYS,
      credentials: CREDENTIALS,
      store: new MemoryStore(),
      now: () => FROZEN_NOW_MS,
      requestRetry: 0,
      transientErrorCooldownSeconds: -1,
    })
    const captured: Oai2OaiUpstreamRequest[] = []
    const send: Oai2OaiUpstreamSender = async (call) => {
      captured.push(call)
      return buildMockResponse('S1-16', false)
    }
    const response = await service.handleChatCompletions(
      {
        method: 'POST',
        path: '/v1/chat/completions',
        headers: [['Authorization', `Bearer ${GATEWAY_API_KEYS[0] ?? ''}`]],
        body: clientBody,
      },
      send,
    )
    expect(captured.length, 'S1-16 wire: upstream call count').toBe(1)
    const call = captured[0]
    if (call === undefined) throw new Error('S1-16 wire: captured call missing')
    assertUpstreamWire(recorded, call, 'S1-16')

    // The downstream side of this replay is the S1-14 verbatim rule: the
    // canned reply crosses untouched, Python spacing included.
    const mock = readRecordedMock('S1-16')
    if (mock.nonStreamReply === undefined) throw new Error('S1-16: no canned reply')
    expect(response.status).toBe(200)
    expect(headerValue(response.headers, 'content-type')).toBe('application/json')
    expect(await readResponseBody(response.body)).toBe(pythonJson(mock.nonStreamReply))
  })

  it('fixture self-check: recorded bodies match their declared Content-Length and the canned frames carry the family trailing-garbage pin', async () => {
    for (const [caseId, file] of [
      ['S1-14', 'chat-nostream.downstream.md'],
      ['S1-16', 'messages-nostream.downstream.md'],
    ] as const) {
      const golden = readRecordedDownstream(caseId, file)
      if (golden.contentLength !== null) {
        expect(encoder.encode(golden.body).length, `${caseId}: golden body bytes match the declaration`).toBe(
          golden.contentLength,
        )
      }
    }
    for (const caseId of ['S1-14', 'S1-15', 'S1-16'] as const) {
      const mock = readRecordedMock(caseId)
      if (mock.sseFrames === undefined) continue
      // The recorded mock appended one stray closing brace after the
      // first three chunk objects; the S1-15 golden proves the re-framed
      // stream drops exactly that garbage and nothing else.
      for (const frame of mock.sseFrames.slice(0, 3)) {
        expect(frame.endsWith('}]}}'), `${caseId}: canned chunk frame shape`).toBe(true)
        const opens = (frame.match(/{/g) ?? []).length
        const closes = (frame.match(/}/g) ?? []).length
        expect(closes, `${caseId}: canned chunk carries exactly one stray closing brace`).toBe(opens + 1)
      }
      expect(mock.sseFrames[mock.sseFrames.length - 1], `${caseId}: canned terminator`).toBe('data: [DONE]')
    }
  })
})
