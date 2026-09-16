/**
 * Targeted unit tests for the oai2oai direction: the alias-rewrite and
 * stream_options splice rules on raw bytes, the upstream header policy,
 * the VERBATIM non-stream pass-through, the data-only re-framing (event
 * lines dropped, trailing garbage stripped, `[DONE]` terminator, in-stream
 * terminal errors, the commit rule), and the facade slices the goldens do
 * not pin (gate 401s, the strict boundary, model_not_found, the 429 ->
 * model-cooldown window with its escalation ladder, request-retry,
 * Store-failure isolation, trace-id absence).
 */
import { describe, expect, it } from 'vitest'
import type { Store } from '@cpa-edge/core'
import { MemoryStore } from '@cpa-edge/core'
import { ensureTopLevelFlag, setTopLevelStringIfDifferent } from './json'
import { buildUpstreamHeaders, orderUpstreamHeaders } from './headers'
import { translateChatPassthrough } from './request'
import { reframeUpstreamSse } from './stream'
import { DONE_TERMINATOR } from './sse'
import { createOai2OaiService } from './service'
import type {
  Oai2OaiCredential,
  Oai2OaiRequest,
  Oai2OaiResponse,
  Oai2OaiUpstreamRequest,
  Oai2OaiUpstreamResponse,
  Oai2OaiUpstreamSender,
} from './service'

const encoder = new TextEncoder()
const UPSTREAM_MODEL = 'mock-gpt-model'
const ALIAS = 'mock-model'

const CREDENTIALS: readonly Oai2OaiCredential[] = [
  {
    name: 'mock-openai',
    apiKey: 'mock-upstream-key',
    baseUrl: 'http://host.docker.internal:18999/v1',
    models: [{ name: UPSTREAM_MODEL, alias: ALIAS }],
  },
]

const FROZEN = 1_789_490_000_000

/** A facade over a stepwise clock: tests advance it deterministically. */
function facade(overrides: Partial<Parameters<typeof createOai2OaiService>[0]> = {}): {
  readonly service: ReturnType<typeof createOai2OaiService>
  readonly advanceClock: (ms: number) => void
} {
  let clock = FROZEN
  const options = {
    apiKeys: ['oracle-local-key-1'] as readonly string[],
    credentials: CREDENTIALS,
    store: new MemoryStore({ now: () => clock }),
    now: () => clock,
    requestRetry: 0,
    transientErrorCooldownSeconds: -1,
    ...overrides,
  }
  return {
    service: createOai2OaiService(options),
    advanceClock: (ms: number) => {
      clock += ms
    },
  }
}

function request(body: string, headers: ReadonlyArray<readonly [string, string]> = []): Oai2OaiRequest {
  return {
    method: 'POST',
    path: '/v1/chat/completions',
    headers: [['Authorization', 'Bearer oracle-local-key-1'], ...headers],
    body,
  }
}

function textStream(chunks: readonly string[]): ReadableStream<Uint8Array> {
  let served = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const index = served
      served += 1
      const chunk = chunks[index]
      if (chunk === undefined) {
        controller.close()
        return
      }
      controller.enqueue(encoder.encode(chunk))
    },
  })
}

/** An upstream reply with the given raw body bytes. */
function upstreamJson(body: string, status = 200): Oai2OaiUpstreamResponse {
  return { status, headers: [['Content-Type', 'application/json']], body: textStream([body]) }
}

/** An upstream SSE reply; each scripted frame lands as its own chunk. */
function upstreamSse(frames: readonly string[], status = 200): Oai2OaiUpstreamResponse {
  return {
    status,
    headers: [['Content-Type', 'text/event-stream']],
    body: textStream(frames.map((frame) => `${frame}\n\n`)),
  }
}

const cannedSseFrames = [
  'data: {"id": "chatcmpl-mock-0001", "object": "chat.completion.chunk", "created": 1770000000, "model": "mock-gpt-model", "choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": null}]}}',
  'data: {"id": "chatcmpl-mock-0001", "object": "chat.completion.chunk", "created": 1770000000, "model": "mock-gpt-model", "choices": [{"index": 0, "delta": {"content": "Hello"}, "finish_reason": null}]}}',
  'data: {"id": "chatcmpl-mock-0001", "object": "chat.completion.chunk", "created": 1770000000, "model": "mock-gpt-model", "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}}',
  'data: [DONE]',
] as const

async function readBody(body: Oai2OaiResponse['body']): Promise<string> {
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

function headerOf(headers: ReadonlyArray<readonly [string, string]>, name: string): string | undefined {
  const key = name.toLowerCase()
  for (const [headerName, value] of headers) {
    if (headerName.toLowerCase() === key) return value
  }
  return undefined
}

/** A sender that captures the wire and serves a fixed reply. */
function senderWith(reply: () => Oai2OaiUpstreamResponse): {
  readonly send: Oai2OaiUpstreamSender
  readonly calls: Oai2OaiUpstreamRequest[]
} {
  const calls: Oai2OaiUpstreamRequest[] = []
  const send: Oai2OaiUpstreamSender = async (call) => {
    calls.push(call)
    return reply()
  }
  return { send, calls }
}

const RATE_LIMIT_BODY = '{"error":{"message":"mock rate limit","type":"rate_limit_exceeded","code":"rate_limit_exceeded"}}'

// ---------------------------------------------------------------------------
// R1: the alias rewrite (set-if-different on raw bytes)
// ---------------------------------------------------------------------------

describe('R1 - alias rewrite on raw client bytes', () => {
  it('splices the upstream model and preserves every other byte (the recorded S1-14 exchange)', () => {
    const client = '{"model": "mock-model", "messages": [{"role": "user", "content": "Say hello"}]}'
    const { body } = translateChatPassthrough(client, { upstreamModel: UPSTREAM_MODEL, stream: false })
    expect(body).toBe(
      '{"model": "mock-gpt-model", "messages": [{"role": "user", "content": "Say hello"}]}',
    )
  })

  it('leaves the body untouched when the model already matches (set-if-different)', () => {
    const client = '{"model":"mock-gpt-model","messages":[]  }'
    expect(setTopLevelStringIfDifferent(client, 'model', UPSTREAM_MODEL)).toBe(client)
  })

  it('splices the model wherever it sits, keeping spacing and key order', () => {
    const client = '{ "messages" : [ ] ,\n  "model" : "mock-model" , "temperature": 0.5 }'
    const { body } = translateChatPassthrough(client, { upstreamModel: UPSTREAM_MODEL, stream: false })
    expect(body).toBe('{ "messages" : [ ] ,\n  "model" : "mock-gpt-model" , "temperature": 0.5 }')
  })

  it('resolves escaped model values and rewrites the raw span with the plain serialization', () => {
    const client = '{"model": "mock\u002dmodel", "messages": []}'
    expect((JSON.parse(client) as Record<string, unknown>)['model']).toBe(ALIAS)
    const { body } = translateChatPassthrough(client, { upstreamModel: UPSTREAM_MODEL, stream: false })
    expect(body).toBe('{"model": "mock-gpt-model", "messages": []}')
    expect(JSON.parse(body)['model']).toBe(UPSTREAM_MODEL)
  })

  it('rewrites the LAST of duplicated model keys (the occurrence JSON.parse keeps)', () => {
    const client = '{"model":"other","model":"mock-model"}'
    const { body } = translateChatPassthrough(client, { upstreamModel: UPSTREAM_MODEL, stream: false })
    expect(body).toBe('{"model":"other","model":"mock-gpt-model"}')
  })

  it('spares non-string and absent model members', () => {
    expect(setTopLevelStringIfDifferent('{"model": 42}', 'model', UPSTREAM_MODEL)).toBe('{"model": 42}')
    expect(setTopLevelStringIfDifferent('{"messages":[]}', 'model', UPSTREAM_MODEL)).toBe('{"messages":[]}')
  })

  it('keeps whitespace around the document untouched', () => {
    const client = '  {"model": "mock-model"}  '
    const { body } = translateChatPassthrough(client, { upstreamModel: UPSTREAM_MODEL, stream: false })
    expect(body).toBe('  {"model": "mock-gpt-model"}  ')
  })
})

// ---------------------------------------------------------------------------
// R1: the stream_options.include_usage injection (set-if-different)
// ---------------------------------------------------------------------------

describe('R1 - stream_options.include_usage injection', () => {
  it('appends the member before the closing brace with no spaces (the recorded S1-15 exchange)', () => {
    const client = '{"model": "mock-model", "stream": true, "messages": [{"role": "user", "content": "Say hello"}]}'
    const { body } = translateChatPassthrough(client, { upstreamModel: UPSTREAM_MODEL, stream: true })
    expect(body).toBe(
      '{"model": "mock-gpt-model", "stream": true, "messages": [{"role": "user", "content": "Say hello"}],"stream_options":{"include_usage":true}}',
    )
  })

  it('never touches non-streaming bodies (the recorded S1-14 exchange)', () => {
    const client = '{"model": "mock-model", "messages": [{"role": "user", "content": "Say hello"}]}'
    const { body } = translateChatPassthrough(client, { upstreamModel: UPSTREAM_MODEL, stream: false })
    expect(body).not.toContain('stream_options')
  })

  it('leaves an already-true include_usage untouched', () => {
    const client = '{"model":"m","stream":true,"stream_options":{"include_usage":true}}'
    expect(ensureTopLevelFlag(client, 'stream_options', 'include_usage')).toBe(client)
  })

  it('replaces a false include_usage value in place, keeping sibling members', () => {
    const client = '{"model":"m","stream":true,"stream_options":{"include_usage":false,"x":1}}'
    expect(ensureTopLevelFlag(client, 'stream_options', 'include_usage')).toBe(
      '{"model":"m","stream":true,"stream_options":{"include_usage":true,"x":1}}',
    )
  })

  it('inserts include_usage inside the client stream_options object when absent', () => {
    const client = '{"model":"m","stream":true,"stream_options":{"x":1}}'
    expect(ensureTopLevelFlag(client, 'stream_options', 'include_usage')).toBe(
      '{"model":"m","stream":true,"stream_options":{"x":1,"include_usage":true}}',
    )
  })

  it('replaces a non-object stream_options wholesale', () => {
    const client = '{"model":"m","stream":true,"stream_options":"x"}'
    expect(ensureTopLevelFlag(client, 'stream_options', 'include_usage')).toBe(
      '{"model":"m","stream":true,"stream_options":{"include_usage":true}}',
    )
  })

  it('injects into an empty top-level object without a leading comma', () => {
    expect(ensureTopLevelFlag('{}', 'stream_options', 'include_usage')).toBe(
      '{"stream_options":{"include_usage":true}}',
    )
  })

  it('keeps a client stream_options on a non-stream request untouched', () => {
    const client = '{"model":"m","stream":false,"stream_options":{"include_usage":false}}'
    const { body } = translateChatPassthrough(client, { upstreamModel: 'm2', stream: false })
    expect(body).toBe('{"model":"m2","stream":false,"stream_options":{"include_usage":false}}')
  })
})

// ---------------------------------------------------------------------------
// R2: the upstream wire (header set + order, no client-header forwarding)
// ---------------------------------------------------------------------------

describe('R2 - upstream wire', () => {
  it('emits the recorded non-stream header order', () => {
    const headers = orderUpstreamHeaders(
      buildUpstreamHeaders({ apiKey: 'k', stream: false }),
      'http://host.docker.internal:18999/v1/chat/completions',
      'x',
    )
    expect(headers).toEqual([
      ['Host', 'host.docker.internal:18999'],
      ['User-Agent', 'cli-proxy-openai-compat'],
      ['Content-Length', '1'],
      ['Authorization', 'Bearer k'],
      ['Content-Type', 'application/json'],
      ['Accept-Encoding', 'gzip'],
    ])
  })

  it('emits the recorded stream header order', () => {
    const headers = orderUpstreamHeaders(
      buildUpstreamHeaders({ apiKey: 'k', stream: true }),
      'http://host.docker.internal:18999/v1/chat/completions',
      'xy',
    )
    expect(headers).toEqual([
      ['Host', 'host.docker.internal:18999'],
      ['User-Agent', 'cli-proxy-openai-compat'],
      ['Content-Length', '2'],
      ['Accept', 'text/event-stream'],
      ['Authorization', 'Bearer k'],
      ['Cache-Control', 'no-cache'],
      ['Content-Type', 'application/json'],
      ['Accept-Encoding', 'gzip'],
    ])
  })

  it('applies credential headers after the gateway set, ASCII-sorted, transport name last', () => {
    const base = buildUpstreamHeaders({ apiKey: 'k', stream: false })
    base['X-Zebra'] = 'z'
    base['X-Alpha'] = 'a'
    const headers = orderUpstreamHeaders(base, 'http://u.example/v1/chat/completions', 'body')
    const names = headers.map(([name]) => name)
    expect(names).toEqual([
      'Host',
      'User-Agent',
      'Content-Length',
      'Authorization',
      'Content-Type',
      'X-Alpha',
      'X-Zebra',
      'Accept-Encoding',
    ])
  })

  it('forwards no client headers to the upstream', async () => {
    const { service: handle } = facade()
    const { send, calls } = senderWith(() => upstreamJson('{"ok":true}'))
    await handle.handleChatCompletions(
      request('{"model":"mock-model","messages":[]}', [
        ['User-Agent', 'curl/8.7.1'],
        ['Accept', '*/*'],
        ['X-Custom', 'client-secret'],
      ]),
      send,
    )
    const call = calls[0]
    if (call === undefined) throw new Error('no upstream call captured')
    const names = call.headers.map(([name]) => name.toLowerCase())
    expect(names).not.toContain('x-custom')
    expect(names).not.toContain('accept')
    expect(headerOf(call.headers, 'user-agent')).toBe('cli-proxy-openai-compat')
  })

  it('composes the URL from the credential base-url with one trailing slash tolerated', async () => {
    const clock = FROZEN
    const handle = createOai2OaiService({
      apiKeys: [],
      credentials: [{ name: 'p', apiKey: 'k', baseUrl: 'http://u.example/v1//', models: [{ name: 'm' }] }],
      store: new MemoryStore({ now: () => clock }),
      now: () => clock,
    })
    const { send, calls } = senderWith(() => upstreamJson('{}'))
    await handle.handleChatCompletions(request('{"model":"m"}'), send)
    expect(calls[0]?.url).toBe('http://u.example/v1/chat/completions')
  })
})

// ---------------------------------------------------------------------------
// R3: non-stream replies cross VERBATIM
// ---------------------------------------------------------------------------

describe('R3 - non-stream pass-through', () => {
  it('forwards the upstream reply byte-exact, spacing included (the S1-14 pin)', async () => {
    const { service: handle } = facade()
    const reply = '{"id": "chatcmpl-mock-0001", "object": "chat.completion",  "created" : 1770000000}'
    const { send } = senderWith(() => upstreamJson(reply))
    const response = await handle.handleChatCompletions(request('{"model":"mock-model","messages":[]}'), send)
    expect(response.status).toBe(200)
    expect(headerOf(response.headers, 'content-type')).toBe('application/json')
    expect(await readBody(response.body)).toBe(reply)
  })

  it('rewrites the response model back to the alias under force-mapping', async () => {
    const clock = FROZEN
    const handle = createOai2OaiService({
      apiKeys: [],
      credentials: [{ name: 'p', apiKey: 'k', baseUrl: 'http://u.example/v1', models: [{ name: UPSTREAM_MODEL, alias: ALIAS, forceMapping: true }] }],
      store: new MemoryStore({ now: () => clock }),
      now: () => clock,
    })
    const reply = '{"id": "x", "model": "mock-gpt-model", "choices": []}'
    const { send } = senderWith(() => upstreamJson(reply))
    const response = await handle.handleChatCompletions(request('{"model":"mock-model"}'), send)
    expect(await readBody(response.body)).toBe('{"id": "x", "model": "mock-model", "choices": []}')
  })

  it('keeps a force-mapping reply untouched when the model already matches', async () => {
    const clock = FROZEN
    const handle = createOai2OaiService({
      apiKeys: [],
      credentials: [{ name: 'p', apiKey: 'k', baseUrl: 'http://u.example/v1', models: [{ name: 'm', alias: 'a', forceMapping: true }] }],
      store: new MemoryStore({ now: () => clock }),
      now: () => clock,
    })
    const reply = '{"model": "a", "choices": []}'
    const { send } = senderWith(() => upstreamJson(reply))
    const response = await handle.handleChatCompletions(request('{"model":"a"}'), send)
    expect(await readBody(response.body)).toBe(reply)
  })
})

// ---------------------------------------------------------------------------
// R3: the data-only SSE re-framing
// ---------------------------------------------------------------------------

describe('R3 - stream re-framing', () => {
  const streamRequest = '{"model":"mock-model","stream":true,"messages":[]}'

  it('drops upstream event: lines and forwards data payloads with the [DONE] terminator (S1-15 pin)', async () => {
    const frames = [
      'event: message',
      'data: {"delta": {"role": "assistant"}}',
      'data: {"delta": {"content": "hi"}}',
      'data: [DONE]',
      'data: {"never": "forwarded"}',
    ]
    const { service: handle } = facade()
    const { send, calls } = senderWith(() => upstreamSse(frames))
    const response = await handle.handleChatCompletions(request(streamRequest), send)
    expect(response.status).toBe(200)
    expect(response.headers.map(([name]) => name), 'recorded SSE commit order (T4 F2)').toEqual([
      'Cache-Control',
      'Connection',
      'Content-Type',
    ])
    expect(headerOf(response.headers, 'content-type')).toBe('text/event-stream')
    expect(headerOf(response.headers, 'cache-control')).toBe('no-cache')
    expect(headerOf(response.headers, 'connection')).toBe('keep-alive')
    // Full byte pin: every frame - the terminator included - ends with
    // its blank line, and nothing is forwarded after [DONE].
    expect(await readBody(response.body)).toBe(
      'data: {"delta": {"role": "assistant"}}\n\ndata: {"delta": {"content": "hi"}}\n\ndata: [DONE]\n\n',
    )
    expect(calls[0]?.body).toContain('"stream_options":{"include_usage":true}')
  })

  it('strips exactly the trailing garbage the upstream appends after the JSON value (the family pin)', async () => {
    const { service: handle } = facade()
    const { send } = senderWith(() => upstreamSse(cannedSseFrames))
    const response = await handle.handleChatCompletions(request(streamRequest), send)
    const body = await readBody(response.body)
    const frames = body.split('\n\n').filter((frame) => frame !== '')
    expect(frames[0]).toBe(
      'data: {"id": "chatcmpl-mock-0001", "object": "chat.completion.chunk", "created": 1770000000, "model": "mock-gpt-model", "choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": null}]}',
    )
    expect(frames[frames.length - 1]).toBe('data: [DONE]')
    expect(body.endsWith('data: [DONE]\n\n'), 'terminator keeps its trailing blank line').toBe(true)
  })

  it('synthesizes the terminator on a clean close that never sent [DONE]', async () => {
    const { service: handle } = facade()
    const { send } = senderWith(() => upstreamSse(['data: {"delta": {}}']))
    const response = await handle.handleChatCompletions(request(streamRequest), send)
    expect(await readBody(response.body)).toBe('data: {"delta": {}}\n\ndata: [DONE]\n\n')
  })

  it('commits headers and the terminator alone when the upstream stream is empty', async () => {
    const { service: handle } = facade()
    const { send } = senderWith(() => upstreamSse([]))
    const response = await handle.handleChatCompletions(request(streamRequest), send)
    expect(response.status).toBe(200)
    expect(headerOf(response.headers, 'content-type')).toBe('text/event-stream')
    expect(await readBody(response.body)).toBe(DONE_TERMINATOR)
  })

  it('ends the stream with one terminal data frame and no [DONE] when a frame carries an error object', async () => {
    const { service: handle } = facade()
    const errorFrame = 'data: {"error": {"message": "boom", "code": 500}}'
    const { send } = senderWith(() => upstreamSse(['data: {"delta": {}}', errorFrame, 'data: [DONE]']))
    const response = await handle.handleChatCompletions(request(streamRequest), send)
    expect(await readBody(response.body)).toBe('data: {"delta": {}}\n\ndata: {"error": {"message": "boom", "code": 500}}\n\n')
  })

  it('wraps a payload without a leading JSON value into the 502 envelope', async () => {
    const { service: handle } = facade()
    const { send } = senderWith(() => upstreamSse(['data: {"delta": {}}', 'data: not-json']))
    const response = await handle.handleChatCompletions(request(streamRequest), send)
    expect(await readBody(response.body)).toBe(
      'data: {"delta": {}}\n\ndata: {"error":{"message":"not-json","type":"server_error","code":"internal_server_error"}}\n\n',
    )
  })

  it('re-chunked transport and CRLF endings decode to the same frames', async () => {
    const events: string[] = []
    for await (const event of reframeUpstreamSse(
      (async function* (): AsyncIterable<Uint8Array> {
        // The chunks split one payload mid-line and a CRLF terminator
        // across reads; the decoder must not care.
        yield encoder.encode('data: {"a":')
        yield encoder.encode('1}\r\nda')
        yield encoder.encode('ta: {"b": 2}\r\ndata: [DONE]')
      })(),
      {},
    )) {
      events.push(event.kind === 'chunk' ? event.body : event.kind)
    }
    expect(events).toEqual(['{"a":1}', '{"b": 2}', 'done'])
  })

  it('skips comments and non-data lines without emitting a frame', async () => {
    const events: string[] = []
    for await (const event of reframeUpstreamSse(
      (async function* (): AsyncIterable<Uint8Array> {
        yield encoder.encode(': keep-alive\nid: 7\nretry: 100\ndata: {"a":1}\n\ndata: [DONE]\n\n')
      })(),
      {},
    )) {
      events.push(event.kind === 'chunk' ? event.body : event.kind)
    }
    expect(events).toEqual(['{"a":1}', 'done'])
  })

  it('rewrites chunk models under force-mapping, splicing only the model span', async () => {
    const clock = FROZEN
    const handle = createOai2OaiService({
      apiKeys: [],
      credentials: [{ name: 'p', apiKey: 'k', baseUrl: 'http://u.example/v1', models: [{ name: UPSTREAM_MODEL, alias: ALIAS, forceMapping: true }] }],
      store: new MemoryStore({ now: () => clock }),
      now: () => clock,
    })
    const frames = [
      `data: {"model": "${UPSTREAM_MODEL}", "choices": []}`,
      'data: [DONE]',
    ]
    const { send } = senderWith(() => upstreamSse(frames))
    const response = await handle.handleChatCompletions(request(streamRequest), send)
    expect(await readBody(response.body)).toBe('data: {"model": "mock-model", "choices": []}\n\ndata: [DONE]\n\n')
  })

  it('answers an upstream error before the first frame with a plain HTTP error, never SSE (the C18 pin)', async () => {
    const { service: handle } = facade()
    const { send } = senderWith(() => upstreamJson(RATE_LIMIT_BODY, 429))
    const response = await handle.handleChatCompletions(request(streamRequest), send)
    expect(response.status).toBe(429)
    expect(headerOf(response.headers, 'content-type')).toBe('application/json')
    expect(await readBody(response.body)).toBe(RATE_LIMIT_BODY)
  })

  it('keeps flushed frames and appends one terminal frame on a post-commit transport failure', async () => {
    const { service: handle } = facade()
    // The upstream serves one frame, then the transport hard-closes
    // mid-line: the committed frame survives and the failure renders as
    // the single terminal frame (the same-surface disconnect pin).
    let served = 0
    const upstreamBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        served += 1
        if (served === 1) {
          controller.enqueue(encoder.encode('data: {"delta": {"a": 1}}\n\ndata: {"delta"'))
          return
        }
        controller.error(new Error('unexpected EOF'))
      },
    })
    const send: Oai2OaiUpstreamSender = async () => ({
      status: 200,
      headers: [['Content-Type', 'text/event-stream']],
      body: upstreamBody,
    })
    const response = await handle.handleChatCompletions(request(streamRequest), send)
    expect(await readBody(response.body)).toBe(
      'data: {"delta": {"a": 1}}\n\ndata: {"error":{"message":"unexpected EOF","type":"server_error","code":"internal_server_error"}}\n\n',
    )
  })

  it('renders a pre-commit transport failure as the wrapped 500 envelope', async () => {
    const { service: handle } = facade()
    const send: Oai2OaiUpstreamSender = async () => {
      throw new Error('connection reset')
    }
    const response = await handle.handleChatCompletions(request('{"model":"mock-model","messages":[]}'), send)
    expect(response.status).toBe(500)
    expect(await readBody(response.body)).toBe(
      '{"error":{"message":"connection reset","type":"server_error","code":"internal_server_error"}}',
    )
  })
})

// ---------------------------------------------------------------------------
// R4: facade slices the goldens do not pin
// ---------------------------------------------------------------------------

describe('R4 - facade: gate, boundary, resolution', () => {
  it('rejects a missing gateway key with the plain 401 body', async () => {
    const { service: handle } = facade()
    const { send } = senderWith(() => upstreamJson('{}'))
    const response = await handle.handleChatCompletions(
      { method: 'POST', path: '/v1/chat/completions', headers: [], body: '{"model":"mock-model"}' },
      send,
    )
    expect(response.status).toBe(401)
    expect(headerOf(response.headers, 'content-type')).toBe('application/json; charset=utf-8')
    expect(await readBody(response.body)).toBe('{"error":"Missing API key"}')
  })

  it('rejects a wrong gateway key with the plain 401 body', async () => {
    const { service: handle } = facade()
    const { send } = senderWith(() => upstreamJson('{}'))
    const response = await handle.handleChatCompletions(
      {
        method: 'POST',
        path: '/v1/chat/completions',
        headers: [['Authorization', 'Bearer nope']],
        body: '{"model":"mock-model"}',
      },
      send,
    )
    expect(response.status).toBe(401)
    expect(await readBody(response.body)).toBe('{"error":"Invalid API key"}')
  })

  it('stays open when no gateway keys are configured (open mode)', async () => {
    const { service: handle } = facade({ apiKeys: [] })
    const { send, calls } = senderWith(() => upstreamJson('{"ok":true}'))
    const response = await handle.handleChatCompletions(
      { method: 'POST', path: '/v1/chat/completions', headers: [], body: '{"model":"mock-model"}' },
      send,
    )
    expect(response.status).toBe(200)
    expect(calls.length).toBe(1)
  })

  it('rejects malformed bodies with the 400 envelope before resolution (NE-LENIENT)', async () => {
    const { service: handle } = facade()
    const { send, calls } = senderWith(() => upstreamJson('{}'))
    const response = await handle.handleChatCompletions(request('{"model": "mock-model"'), send)
    expect(response.status).toBe(400)
    expect(headerOf(response.headers, 'content-type')).toBe('application/json')
    expect(await readBody(response.body)).toBe(
      '{"error":{"message":"Invalid request: malformed JSON body","type":"invalid_request_error"}}',
    )
    expect(calls.length).toBe(0)
  })

  it('rejects a top-level non-object body with the same 400 envelope', async () => {
    const { service: handle } = facade()
    const { send } = senderWith(() => upstreamJson('{}'))
    const response = await handle.handleChatCompletions(request('[1,2,3]'), send)
    expect(response.status).toBe(400)
    expect(await readBody(response.body)).toBe(
      '{"error":{"message":"Invalid request: malformed JSON body","type":"invalid_request_error"}}',
    )
  })

  it('renders the model_not_found 400 for unknown models, with no upstream call', async () => {
    const { service: handle } = facade()
    const { send, calls } = senderWith(() => upstreamJson('{}'))
    const response = await handle.handleChatCompletions(request('{"model":"nope"}'), send)
    expect(response.status).toBe(400)
    expect(await readBody(response.body)).toBe(
      '{"error":{"message":"unknown provider for model nope","type":"invalid_request_error","code":"model_not_found","param":"model"}}',
    )
    expect(calls.length).toBe(0)
  })

  it('routes a model without an alias by its name', async () => {
    const clock = FROZEN
    const handle = createOai2OaiService({
      apiKeys: [],
      credentials: [{ name: 'p', apiKey: 'k', baseUrl: 'http://u.example/v1', models: [{ name: 'm' }] }],
      store: new MemoryStore({ now: () => clock }),
      now: () => clock,
    })
    const { send, calls } = senderWith(() => upstreamJson('{"ok":true}'))
    const response = await handle.handleChatCompletions(request('{"model":"m"}'), send)
    expect(response.status).toBe(200)
    expect(calls[0]?.body).toBe('{"model":"m"}')
  })

  it('treats only a JSON-true stream flag as streaming', async () => {
    const { service: handle } = facade()
    for (const streamValue of ['"true"', 'null', '1']) {
      const { send, calls } = senderWith(() => upstreamJson('{"ok":true}'))
      const response = await handle.handleChatCompletions(
        request(`{"model":"mock-model","stream":${streamValue}}`),
        send,
      )
      expect(response.status).toBe(200)
      expect(headerOf(response.headers, 'content-type')).toBe('application/json')
      expect(calls[0]?.headers.some(([name]) => name === 'Accept')).toBe(false)
    }
  })

  it('never emits a trace id of its own (R-TRACE)', async () => {
    const { service: handle } = facade()
    const ok = senderWith(() => upstreamJson('{"ok":true}'))
    const response = await handle.handleChatCompletions(request('{"model":"mock-model"}'), ok.send)
    expect(headerOf(response.headers, 'x-cpa-trace-id')).toBeUndefined()
    const notFound = await handle.handleChatCompletions(request('{"model":"zzz"}'), ok.send)
    expect(headerOf(notFound.headers, 'x-cpa-trace-id')).toBeUndefined()
  })
})

describe('R4 - facade: upstream errors and the 429 cooldown', () => {
  it('passes a valid-JSON upstream error through VERBATIM and opens the 1s window', async () => {
    const { service: handle } = facade()
    const error = senderWith(() => upstreamJson(RATE_LIMIT_BODY, 429))
    const first = await handle.handleChatCompletions(request('{"model":"mock-model"}'), error.send)
    expect(first.status).toBe(429)
    expect(await readBody(first.body)).toBe(RATE_LIMIT_BODY)

    const second = senderWith(() => {
      throw new Error('must not be called - the model is cooling down')
    })
    const inWindow = await handle.handleChatCompletions(request('{"model":"mock-model"}'), second.send)
    expect(inWindow.status).toBe(429)
    expect(headerOf(inWindow.headers, 'retry-after')).toBe('1')
    expect(await readBody(inWindow.body)).toBe(
      '{"error":{"code":"model_cooldown","last_upstream_error":"rate_limit_exceeded: mock rate limit","message":"All credentials for model mock-model are cooling down via provider openai-compatible-mock-openai (last error: rate_limit_exceeded: mock rate limit)","model":"mock-model","provider":"openai-compatible-mock-openai","reset_seconds":1,"reset_time":"1s"}}',
    )
    expect(second.calls.length).toBe(0)
  })

  it('wraps a non-JSON upstream error with the status-mapped envelope', async () => {
    const { service: handle } = facade()
    const { send } = senderWith(() => upstreamJson('<html>oops</html>', 503))
    const response = await handle.handleChatCompletions(request('{"model":"mock-model"}'), send)
    expect(response.status).toBe(503)
    expect(await readBody(response.body)).toBe(
      '{"error":{"message":"<html>oops</html>","type":"server_error","code":"internal_server_error"}}',
    )
  })

  it('escalates the window per consecutive failure and resets after a success', async () => {
    const { service: handle, advanceClock } = facade()
    const error = senderWith(() => upstreamJson(RATE_LIMIT_BODY, 429))
    await handle.handleChatCompletions(request('{"model":"mock-model"}'), error.send)
    advanceClock(2_000) // past the 1s window
    await handle.handleChatCompletions(request('{"model":"mock-model"}'), error.send)
    const afterSecond = senderWith(() => {
      throw new Error('must not be called')
    })
    const inWindow = await handle.handleChatCompletions(request('{"model":"mock-model"}'), afterSecond.send)
    expect(headerOf(inWindow.headers, 'retry-after')).toBe('2') // 2^(2-1)
    advanceClock(3_000) // past the 2s window
    const ok = senderWith(() => upstreamJson('{"ok":true}'))
    const success = await handle.handleChatCompletions(request('{"model":"mock-model"}'), ok.send)
    expect(success.status).toBe(200)
    const afterReset = senderWith(() => upstreamJson('{"ok":true}'))
    const again = await handle.handleChatCompletions(request('{"model":"mock-model"}'), afterReset.send)
    expect(again.status).toBe(200)
  })

  it('honors an upstream Retry-After hint over the ladder and opens 60s on TPM bodies', async () => {
    const { service: handle, advanceClock } = facade()
    const hinted = senderWith(() => ({
      status: 429,
      headers: [['Retry-After', '30']],
      body: textStream([RATE_LIMIT_BODY]),
    }))
    await handle.handleChatCompletions(request('{"model":"mock-model"}'), hinted.send)
    const next = senderWith(() => {
      throw new Error('must not be called')
    })
    const inWindow = await handle.handleChatCompletions(request('{"model":"mock-model"}'), next.send)
    expect(headerOf(inWindow.headers, 'retry-after')).toBe('30')

    advanceClock(31_000)
    const tpmBody = '{"error":{"code":"TPMRateLimitExceeded","message":"You exceeded your tokens per minute limit"}}'
    const tpm = senderWith(() => upstreamJson(tpmBody, 429))
    await handle.handleChatCompletions(request('{"model":"mock-model"}'), tpm.send)
    const tpmNext = senderWith(() => {
      throw new Error('must not be called')
    })
    const tpmWindow = await handle.handleChatCompletions(request('{"model":"mock-model"}'), tpmNext.send)
    expect(headerOf(tpmWindow.headers, 'retry-after')).toBe('60')
  })

  it('keeps the cooldown document in the Store under the model key', async () => {
    const clock = FROZEN
    const store = new MemoryStore({ now: () => clock })
    const handle = createOai2OaiService({
      apiKeys: ['oracle-local-key-1'],
      credentials: CREDENTIALS,
      store,
      now: () => clock,
      requestRetry: 0,
    })
    const error = senderWith(() => upstreamJson(RATE_LIMIT_BODY, 429))
    await handle.handleChatCompletions(request('{"model":"mock-model"}'), error.send)
    const document = await store.get('oai2oai', 'model-cooldown:mock-model')
    expect(document).toMatchObject({
      reset_seconds: 1,
      last_error: 'rate_limit_exceeded: mock rate limit',
      last_status: 429,
      provider: 'openai-compatible-mock-openai',
      failure_count: 1,
    })
  })

  it('a failing Store never rejects the rendered 429 and surfaces through reportError', async () => {
    const failingStore: Store = {
      get: async () => undefined,
      put: async () => undefined,
      delete: async () => true,
      list: async () => [],
      update: async () => {
        throw new Error('store down')
      },
      enqueue: async () => 'id',
      claim: async () => undefined,
      ack: async () => true,
      release: async () => true,
      ringAppend: async () => undefined,
      ringRead: async () => [],
    }
    const reported: unknown[] = []
    const original = globalThis.reportError
    globalThis.reportError = (error: unknown) => {
      reported.push(error)
    }
    try {
      const { service: handle } = facade({ store: failingStore })
      const error = senderWith(() => upstreamJson(RATE_LIMIT_BODY, 429))
      const response = await handle.handleChatCompletions(request('{"model":"mock-model"}'), error.send)
      expect(response.status).toBe(429)
      expect(await readBody(response.body)).toBe(RATE_LIMIT_BODY)
      expect(reported.length).toBeGreaterThan(0)
      expect((reported[0] as Error).message).toBe('store down')
    } finally {
      globalThis.reportError = original
    }
  })

  it('rotates to the next credential on a 429 under request-retry, rendering the last response', async () => {
    const clock = FROZEN
    const credentials: readonly Oai2OaiCredential[] = [
      { name: 'a', apiKey: 'ka', baseUrl: 'http://a.example/v1', models: [{ name: UPSTREAM_MODEL, alias: ALIAS }] },
      { name: 'b', apiKey: 'kb', baseUrl: 'http://b.example/v1', models: [{ name: 'alt-upstream', alias: ALIAS }] },
    ]
    const handle = createOai2OaiService({
      apiKeys: ['oracle-local-key-1'],
      credentials,
      store: new MemoryStore({ now: () => clock }),
      now: () => clock,
      requestRetry: 1,
    })
    const first = senderWith(() => upstreamJson(RATE_LIMIT_BODY, 429))
    const second = senderWith(() => upstreamJson('{"ok":true}'))
    const send: Oai2OaiUpstreamSender = async (call) => {
      const url = call.url
      if (url.startsWith('http://a.example')) return first.send(call)
      return second.send(call)
    }
    const response = await handle.handleChatCompletions(request('{"model":"mock-model"}'), send)
    expect(response.status).toBe(200)
    expect(first.calls.length).toBe(1)
    expect(second.calls.length).toBe(1)
    expect(second.calls[0]?.body).toContain('"alt-upstream"') // each candidate rewrites with its own upstream name
    expect(second.calls[0]?.headers.some(([name, value]) => name === 'Authorization' && value === 'Bearer kb')).toBe(true)
  })
})
