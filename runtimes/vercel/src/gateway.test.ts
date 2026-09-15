/**
 * Vercel runtime tests (mission R5): the S7 vercel-column matrix, the
 * streaming-boundary abort behavior (R3, the charter's T3 review
 * focus), and one end-to-end composition smoke.
 *
 * Byte-exact strings below are the S7 3.2 degradation bodies and the
 * recorded auth-gate bodies (oracle fixtures); upstream mock content is
 * fixture-shaped test data.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createInMemoryKvStore } from './kv-store'
import {
  createVercelGateway,
  DEFAULT_MAX_STREAMING_DURATION_MS,
  type VercelGatewayOptions,
} from './gateway'
import { createVercelHandler } from './handler'
import {
  emitBlockYaml,
  type VercelConfigSource,
} from './config'
import {
  createBoundaryFetch,
  startRequestDeadline,
  WEBSOCKET_UNAVAILABLE_BODY,
  PROXY_UNAVAILABLE_BODY,
  LOCAL_CALLBACK_UNAVAILABLE_BODY,
  FILE_LOGGING_UNAVAILABLE_BODY,
  PLUGIN_INSTALL_UNAVAILABLE_BODY,
  PROXY_TRANSPORT_UNAVAILABLE_BODY,
  VERCEL_RUNTIME_CAPABILITIES,
} from './index'
import { makeGatewayRequest, type GatewayRequest, type GatewayResponse } from '@cpa-edge/runtime-node'

const API_KEY = 'vercel-client-key-1'
const MGMT_KEY = 'vercel-mgmt-key-1'
const CLAUDE_DIRECT_URL = 'http://127.0.0.1:20002'
const CLAUDE_PROXY_URL = 'http://127.0.0.1:20003'

/** Baseline config: one direct and one proxied claude provider. */
const BASE_RECORD: Record<string, unknown> = {
  port: 18317,
  'api-keys': [API_KEY],
  'remote-management': {
    'allow-remote': true,
    'secret-key': MGMT_KEY,
    'disable-control-panel': true,
  },
  'request-retry': 0,
  'transient-error-cooldown-seconds': -1,
  'claude-api-key': [
    {
      'api-key': 'claude-direct-key',
      'base-url': CLAUDE_DIRECT_URL,
      models: [{ name: 'claude-direct-model', alias: 'claude-direct-model' }],
    },
    {
      'api-key': 'claude-proxied-key',
      'base-url': CLAUDE_PROXY_URL,
      'proxy-url': 'socks5://127.0.0.1:1080',
      models: [{ name: 'claude-proxied-model', alias: 'claude-proxied-model' }],
    },
  ],
}

/** Upstream SSE the claude direction translates (fixture-shaped). */
const CLAUDE_SSE = [
  'event: message_start',
  `data: ${JSON.stringify({
    type: 'message_start',
    message: {
      id: 'msg_mock_01',
      type: 'message',
      role: 'assistant',
      model: 'claude-direct-model',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 9, output_tokens: 1 },
    },
  })}`,
  '',
  'event: content_block_start',
  `data: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}`,
  '',
  'event: content_block_delta',
  `data: ${JSON.stringify({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'Hello from mock claude upstream' },
  })}`,
  '',
  'event: content_block_stop',
  `data: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}`,
  '',
  'event: message_delta',
  `data: ${JSON.stringify({
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 6 },
  })}`,
  '',
  'event: message_stop',
  `data: ${JSON.stringify({ type: 'message_stop' })}`,
  '',
  '',
].join('\n')

const EOF_FRAME =
  'data: {"error":{"message":"unexpected EOF","type":"server_error","code":"internal_server_error"}}\n\n'

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

interface RecordedCall {
  readonly url: string
  readonly method: string
  readonly body: string
}

/** Scripted upstream transport that records every call. */
function scriptedFetch(
  respond: (call: RecordedCall) => { status: number; headers: Record<string, string>; body: string | ReadableStream<Uint8Array> },
): { fetch: (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<Response>; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const fake = (
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ): Promise<Response> => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ?? '' })
    const reply = respond({ url, method: init?.method ?? 'GET', body: init?.body ?? '' })
    return Promise.resolve(new Response(reply.body, { status: reply.status, headers: reply.headers }))
  }
  return { fetch: fake, calls }
}

/** Splits text into a multi-chunk stream so byte budgets can cut mid-body. */
function chunkedBody(text: string, chunkSize: number): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  let offset = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= text.length) {
        controller.close()
        return
      }
      const end = Math.min(offset + chunkSize, text.length)
      controller.enqueue(encoder.encode(text.slice(offset, end)))
      offset = end
    },
  })
}

/** Builds a config source pair (record + emitted YAML) for the gateway. */
function sourceOf(record: Record<string, unknown>): VercelConfigSource {
  return { record, yaml: emitBlockYaml(record), origin: 'env-json' }
}

/** Builds the vercel gateway over the given record. */
function gatewayWith(
  record: Record<string, unknown> = BASE_RECORD,
  overrides: Partial<VercelGatewayOptions> = {},
) {
  return createVercelGateway({
    configSource: sourceOf(record),
    store: overrides.store ?? createInMemoryKvStore(),
    ...overrides,
  })
}

const bearer = (key: string): Array<[string, string]> => [['Authorization', `Bearer ${key}`]]

function request(
  method: string,
  path: string,
  headers: ReadonlyArray<readonly [string, string]> = [],
  body: string = '',
): GatewayRequest {
  return makeGatewayRequest(method, path, headers, body)
}

async function text(response: GatewayResponse): Promise<string> {
  if (typeof response.body === 'string') return response.body
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let out = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value !== undefined) out += decoder.decode(value, { stream: true })
  }
  return out + decoder.decode()
}

function header(response: GatewayResponse, name: string): string | undefined {
  const lower = name.toLowerCase()
  for (const [headerName, value] of response.headers) {
    if (headerName.toLowerCase() === lower) return value
  }
  return undefined
}

function corsPresent(response: GatewayResponse): void {
  expect(header(response, 'Access-Control-Allow-Origin')).toBe('*')
  expect(header(response, 'Access-Control-Allow-Methods')).toBe('GET, POST, PUT, PATCH, DELETE, OPTIONS')
  expect(header(response, 'Access-Control-Allow-Headers')).toBe('*')
  expect(header(response, 'Access-Control-Expose-Headers')).toContain('X-CPA-TRACE-ID')
}

const CHAT_BODY = (model: string, stream: boolean): string =>
  JSON.stringify({ model, stream, messages: [{ role: 'user', content: 'hi' }] })

/** The direct (non-proxied) claude provider entry of the baseline. */
const DIRECT_CLAUDE = (BASE_RECORD['claude-api-key'] as Array<Record<string, unknown>>)[0] as Record<string, unknown>

/** Baseline config with only the direct claude provider wired. */
const DIRECT_RECORD = (): Record<string, unknown> => ({
  ...BASE_RECORD,
  'claude-api-key': [structuredClone(DIRECT_CLAUDE)],
})

// ---------------------------------------------------------------------------
// R4: the vercel capability matrix (S7 3.1)
// ---------------------------------------------------------------------------

describe('vercel capability matrix (S7 3.1)', () => {
  it('declares the mostly-false vercel profile', () => {
    expect(VERCEL_RUNTIME_CAPABILITIES).toEqual({
      inboundWebSocket: false,
      proxyTransport: false,
      pluginLoading: false,
      fileLogging: false,
      fileWatching: false,
      localCallbackServer: false,
    })
  })

  it('the composed gateway pins the same descriptor and a sane default budget', () => {
    const gateway = gatewayWith()
    expect(gateway.capabilities).toEqual(VERCEL_RUNTIME_CAPABILITIES)
    expect(DEFAULT_MAX_STREAMING_DURATION_MS).toBeLessThan(300_000)
  })
})

// ---------------------------------------------------------------------------
// F4: GET /v1/ws (NE-S7-07) - auth contract preserved, then the 501 seam
// ---------------------------------------------------------------------------

describe('GET /v1/ws (F4, NE-S7-07)', () => {
  it('missing key: the upstream 401 body, CORS block, no upgrade', async () => {
    const response = await gatewayWith().handle(request('GET', '/v1/ws'))
    expect(response.status).toBe(401)
    const missing = await text(response)
    expect(missing).toBe('{"error":"Missing API key"}')
    expect(missing).toHaveLength(27)
    corsPresent(response)
  })

  it('invalid key: the upstream invalid-key 401', async () => {
    const response = await gatewayWith().handle(request('GET', '/v1/ws', bearer('wrong-key')))
    expect(response.status).toBe(401)
    expect(await text(response)).toBe('{"error":"Invalid API key"}')
  })

  it('valid key: the pinned 501 seam body after the auth gate', async () => {
    const response = await gatewayWith().handle(request('GET', '/v1/ws', bearer(API_KEY)))
    expect(response.status).toBe(501)
    expect(header(response, 'Content-Type')).toBe('application/json; charset=utf-8')
    expect(await text(response)).toBe(WEBSOCKET_UNAVAILABLE_BODY)
    expect(await text(response)).toBe(
      '{"error":{"message":"inbound WebSocket is not available on this runtime","type":"not_implemented","code":"websocket_unavailable"}}',
    )
    corsPresent(response)
  })

  it('ws-auth: false skips auth and answers the 501 directly', async () => {
    const record = { ...BASE_RECORD, 'ws-auth': false }
    const response = await gatewayWith(record).handle(request('GET', '/v1/ws'))
    expect(response.status).toBe(501)
    expect(await text(response)).toBe(WEBSOCKET_UNAVAILABLE_BODY)
  })

  it('wrong method stays R-404; OPTIONS stays 204 + CORS', async () => {
    const gateway = gatewayWith()
    const post = await gateway.handle(request('POST', '/v1/ws', bearer(API_KEY)))
    expect(post.status).toBe(404)
    expect(await text(post)).toBe('')
    const options = await gateway.handle(request('OPTIONS', '/v1/ws'))
    expect(options.status).toBe(204)
    corsPresent(options)
  })

  it('a successful management ws-auth write flips the live gate', async () => {
    const gateway = gatewayWith()
    const put = await gateway.handle(
      request('PUT', '/v0/management/ws-auth', bearer(MGMT_KEY), '{"value": false}'),
    )
    expect(put.status).toBe(200)
    expect(await text(put)).toBe('{"status":"ok"}')
    const response = await gateway.handle(request('GET', '/v1/ws'))
    expect(response.status).toBe(501)
    expect(await text(response)).toBe(WEBSOCKET_UNAVAILABLE_BODY)
  })
})

// ---------------------------------------------------------------------------
// F1: fail-closed proxy exclusion (NE-S7-01)
// ---------------------------------------------------------------------------

describe('proxy-credentialed models (F1, NE-S7-01)', () => {
  it('auth precedes the 501: no key on a proxied model keeps the 401', async () => {
    const response = await gatewayWith().handle(
      request('POST', '/v1/chat/completions', [], CHAT_BODY('claude-proxied-model', true)),
    )
    expect(response.status).toBe(401)
    expect(await text(response)).toBe('{"error":"Missing API key"}')
  })

  it('all-proxied model: the pinned client 501 body', async () => {
    const response = await gatewayWith().handle(
      request('POST', '/v1/chat/completions', bearer(API_KEY), CHAT_BODY('claude-proxied-model', true)),
    )
    expect(response.status).toBe(501)
    expect(header(response, 'Content-Type')).toBe('application/json; charset=utf-8')
    expect(await text(response)).toBe(PROXY_UNAVAILABLE_BODY)
    corsPresent(response)
  })

  it('the 501 reaches the messages and v1beta surfaces too', async () => {
    const record: Record<string, unknown> = {
      ...BASE_RECORD,
      'gemini-api-key': [
        {
          'api-key': 'gemini-key',
          'base-url': 'http://127.0.0.1:20004',
          'proxy-url': 'http://127.0.0.1:3128',
          models: [{ name: 'gemini-proxied-model' }],
        },
      ],
    }
    const gateway = gatewayWith(record)
    const messages = await gateway.handle(
      request('POST', '/v1/messages', bearer(API_KEY), CHAT_BODY('claude-proxied-model', false)),
    )
    expect(messages.status).toBe(501)
    expect(await text(messages)).toBe(PROXY_UNAVAILABLE_BODY)
    const v1beta = await gateway.handle(
      request(
        'POST',
        '/v1beta/models/gemini-proxied-model:generateContent',
        bearer(API_KEY),
        '{"contents":[{"parts":[{"text":"hi"}]}]}',
      ),
    )
    expect(v1beta.status).toBe(501)
    expect(await text(v1beta)).toBe(PROXY_UNAVAILABLE_BODY)
  })

  it('unknown model keeps the facade 400, proxied providers or not', async () => {
    const response = await gatewayWith().handle(
      request('POST', '/v1/chat/completions', bearer(API_KEY), CHAT_BODY('no-such-model', true)),
    )
    expect(response.status).toBe(400)
    expect(await text(response)).toContain('model_not_found')
  })

  it('mixed families succeed through the direct credential only', async () => {
    const record: Record<string, unknown> = {
      ...BASE_RECORD,
      'claude-api-key': [
        ...(BASE_RECORD['claude-api-key'] as Array<Record<string, unknown>>),
        {
          'api-key': 'claude-shared-alias',
          'base-url': CLAUDE_DIRECT_URL,
          'proxy-url': 'http://127.0.0.1:3128',
          models: [{ name: 'claude-direct-model', alias: 'claude-direct-model' }],
        },
      ],
    }
    const transport = scriptedFetch(() => ({
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
      body: chunkedBody(CLAUDE_SSE, 96),
    }))
    const gateway = gatewayWith(record, { fetch: transport.fetch })
    const response = await gateway.handle(
      request('POST', '/v1/chat/completions', bearer(API_KEY), CHAT_BODY('claude-direct-model', true)),
    )
    expect(response.status).toBe(200)
    const body = await text(response)
    expect(body).toContain('Hello from mock claude upstream')
    expect(body).toContain('[DONE]')
    // Fail-closed: the proxied credential never receives traffic.
    const dialed = transport.calls.map((call) => call.url)
    expect(dialed).toHaveLength(1)
    expect(dialed[0]).toContain(CLAUDE_DIRECT_URL)
    expect(dialed[0]).not.toContain(CLAUDE_PROXY_URL)
  })

  it('global proxy-url excludes unopinionated providers of that config', async () => {
    const record: Record<string, unknown> = {
      ...BASE_RECORD,
      'proxy-url': 'socks5://127.0.0.1:1080',
      'claude-api-key': [
        {
          'api-key': 'only-key',
          'base-url': CLAUDE_DIRECT_URL,
          models: [{ name: 'claude-direct-model' }],
        },
      ],
    }
    const response = await gatewayWith(record).handle(
      request('POST', '/v1/chat/completions', bearer(API_KEY), CHAT_BODY('claude-direct-model', true)),
    )
    expect(response.status).toBe(501)
    expect(await text(response)).toBe(PROXY_UNAVAILABLE_BODY)
  })

  it('model lists drop proxied-only models (documented unpinned choice)', async () => {
    const response = await gatewayWith().handle(request('GET', '/v1/models', bearer(API_KEY)))
    expect(response.status).toBe(200)
    const body = JSON.parse(await text(response)) as { data: Array<{ id: string }> }
    const ids = body.data.map((model) => model.id)
    expect(ids).toContain('claude-direct-model')
    expect(ids).not.toContain('claude-proxied-model')
  })
})

// ---------------------------------------------------------------------------
// R3: the streaming boundary (charter review focus)
// ---------------------------------------------------------------------------

describe('streaming boundary (R3)', () => {
  it('a forced mid-stream abort at an arbitrary byte count renders the family terminal frame', async () => {
    // Cut AFTER the first translated chunk (the content delta event) but
    // well before the stream ends: an arbitrary boundary byte-count.
    const cut = CLAUDE_SSE.indexOf('"content_block_delta"') + 140
    expect(cut).toBeGreaterThan(0)
    expect(cut).toBeLessThan(CLAUDE_SSE.length - 100)
    const transport = scriptedFetch(() => ({
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
      body: chunkedBody(CLAUDE_SSE, 64),
    }))
    const gateway = gatewayWith(DIRECT_RECORD(), {
      fetch: transport.fetch,
      boundaryMaxBytes: cut,
    })
    const response = await gateway.handle(
      request('POST', '/v1/chat/completions', bearer(API_KEY), CHAT_BODY('claude-direct-model', true)),
    )
    expect(response.status).toBe(200)
    expect(header(response, 'Content-Type')).toBe('text/event-stream')
    const body = await text(response)
    // Translated prefix frames flowed, then ONE pinned terminal frame
    // and NO [DONE]: the family's recorded disconnect shape.
    expect(body).toContain('Hello from mock claude upstream')
    expect(body.endsWith(EOF_FRAME)).toBe(true)
    expect(body).not.toContain('[DONE]')
  })

  it('an abort before the first translated frame stays a plain 500 (pre-commit)', async () => {
    const transport = scriptedFetch(() => ({
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
      body: chunkedBody(CLAUDE_SSE, 64),
    }))
    const gateway = gatewayWith(DIRECT_RECORD(), {
      fetch: transport.fetch,
      boundaryMaxBytes: 10,
    })
    const response = await gateway.handle(
      request('POST', '/v1/chat/completions', bearer(API_KEY), CHAT_BODY('claude-direct-model', true)),
    )
    expect(response.status).toBe(500)
    expect(await text(response)).toBe(
      '{"error":{"message":"unexpected EOF","type":"server_error","code":"internal_server_error"}}',
    )
  })

  it('the boundary arms, fires and clears through the timer seam', async () => {
    const armed: Array<() => void> = []
    let cleared = 0
    const timers = {
      setTimeout: (callback: () => void) => {
        armed.push(callback)
        return () => {}
      },
      clearTimeout: () => {
        cleared += 1
      },
    }
    const fetcher = async (): Promise<Response> =>
      new Response(chunkedBody('abcdefgh', 3), { status: 200 })
    const deadline = startRequestDeadline({ maxDurationMs: 500, timers })
    const send = createBoundaryFetch(fetcher, deadline, { maxDurationMs: 500, timers })
    const response = await send('http://upstream')
    const reader = response.body?.getReader()
    expect(reader).toBeDefined()
    expect(armed.length).toBe(1)
    const first = await reader?.read()
    expect(new TextDecoder().decode(first?.value ?? new Uint8Array())).toBe('abc')
    ;(armed[0] as () => void)()
    await expect(reader?.read()).rejects.toThrow(/budget/)
    // The guard settles its timer once the stream ends in any way.
    expect(cleared).toBe(1)
  })

  it('a clean end clears the timer; no budget means no timer', async () => {
    let fired = 0
    let cleared = 0
    const timers = {
      setTimeout: (callback: () => void) => {
        fired += 1
        void callback
        return () => {}
      },
      clearTimeout: () => {
        cleared += 1
      },
    }
    const fetcher = async (): Promise<Response> => new Response('whole body', { status: 200 })
    const deadline = startRequestDeadline({ maxDurationMs: 500, timers })
    const send = createBoundaryFetch(fetcher, deadline, { maxDurationMs: 500, timers })
    const response = await send('http://upstream')
    await response.text()
    expect(fired).toBe(1)
    expect(cleared).toBe(1)

    const unbounded = createBoundaryFetch(fetcher, startRequestDeadline({ timers }), { timers })
    const passthrough = await unbounded('http://upstream')
    expect(await passthrough.text()).toBe('whole body')
    expect(fired).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Management-surface degradations (F2/F3/F5a, api-call F1)
// ---------------------------------------------------------------------------

describe('management degradations', () => {
  it('without a key the management 401 ladder is unchanged', async () => {
    const response = await gatewayWith().handle(request('GET', '/v0/management/anthropic-auth-url'))
    expect(response.status).toBe(401)
    expect(await text(response)).toBe('{"error":"missing management key"}')
  })

  it('redirect auth-URLs answer the F5 501 after auth (anthropic sample)', async () => {
    const gateway = gatewayWith()
    for (const provider of ['anthropic', 'codex', 'antigravity', 'devin']) {
      const response = await gateway.handle(
        request('GET', `/v0/management/${provider}-auth-url`, bearer(MGMT_KEY)),
      )
      expect(response.status).toBe(501)
      expect(await text(response)).toBe(LOCAL_CALLBACK_UNAVAILABLE_BODY)
      expect(header(response, 'Content-Type')).toBe('application/json; charset=utf-8')
      corsPresent(response)
    }
  })

  it('logs: 400 gating stays; enabled logs read the F3 501', async () => {
    const gateway = gatewayWith()
    const disabled = await gateway.handle(request('GET', '/v0/management/logs', bearer(MGMT_KEY)))
    expect(disabled.status).toBe(400)
    expect(await text(disabled)).toBe('{"error":"logging to file disabled"}')
    const put = await gateway.handle(
      request('PUT', '/v0/management/logging-to-file', bearer(MGMT_KEY), '{"value": true}'),
    )
    expect(put.status).toBe(200)
    const read = await gateway.handle(request('GET', '/v0/management/logs', bearer(MGMT_KEY)))
    expect(read.status).toBe(501)
    expect(await text(read)).toBe(FILE_LOGGING_UNAVAILABLE_BODY)
    const clear = await gateway.handle(request('DELETE', '/v0/management/logs', bearer(MGMT_KEY)))
    expect(clear.status).toBe(501)
    expect(await text(clear)).toBe(FILE_LOGGING_UNAVAILABLE_BODY)
  })

  it('request-error-logs family reads the F3 501, validations kept', async () => {
    const gateway = gatewayWith()
    const list = await gateway.handle(request('GET', '/v0/management/request-error-logs', bearer(MGMT_KEY)))
    expect(list.status).toBe(501)
    expect(await text(list)).toBe(FILE_LOGGING_UNAVAILABLE_BODY)
    const badName = await gateway.handle(
      request('GET', '/v0/management/request-error-logs/bad%2Fname.log', bearer(MGMT_KEY)),
    )
    expect(badName.status).toBe(400)
    expect(await text(badName)).toBe('{"error":"invalid log file name"}')
    // Names that pass validation would look for a dump; that substrate
    // does not exist here (OQ-S7-02), so both read the 501.
    const wrongSuffix = await gateway.handle(
      request('GET', '/v0/management/request-error-logs/not-a-log.txt', bearer(MGMT_KEY)),
    )
    expect(wrongSuffix.status).toBe(501)
    expect(await text(wrongSuffix)).toBe(FILE_LOGGING_UNAVAILABLE_BODY)
    const good = await gateway.handle(
      request('GET', '/v0/management/request-error-logs/error-abc.log', bearer(MGMT_KEY)),
    )
    expect(good.status).toBe(501)
    expect(await text(good)).toBe(FILE_LOGGING_UNAVAILABLE_BODY)
  })

  it('request-log-by-id keeps the config-state 404 then degrades to 501', async () => {
    const gateway = gatewayWith()
    const off = await gateway.handle(
      request('GET', '/v0/management/request-log-by-id/req-1', bearer(MGMT_KEY)),
    )
    expect(off.status).toBe(404)
    expect(await text(off)).toBe('{"error":"log directory not found"}')
    await gateway.handle(
      request('PUT', '/v0/management/logging-to-file', bearer(MGMT_KEY), '{"value": true}'),
    )
    const on = await gateway.handle(
      request('GET', '/v0/management/request-log-by-id/req-1', bearer(MGMT_KEY)),
    )
    expect(on.status).toBe(501)
    expect(await text(on)).toBe(FILE_LOGGING_UNAVAILABLE_BODY)
  })

  it('plugin installation answers the F2 501 (project-wide absence)', async () => {
    const response = await gatewayWith().handle(
      request('POST', '/v0/management/plugin-store/sample-plugin/install', bearer(MGMT_KEY)),
    )
    expect(response.status).toBe(501)
    expect(await text(response)).toBe(PLUGIN_INSTALL_UNAVAILABLE_BODY)
  })

  it('api-call in proxy mode answers the F1 management 501; direct calls proceed', async () => {
    const transport = scriptedFetch(() => ({
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: '{"vendor":"ok"}',
    }))
    const gateway = gatewayWith(BASE_RECORD, { fetch: transport.fetch })
    const proxied = await gateway.handle(
      request(
        'POST',
        '/v0/management/api-call',
        bearer(MGMT_KEY),
        JSON.stringify({ method: 'GET', url: 'http://vendor.example/x', proxy_url: 'http://127.0.0.1:3128' }),
      ),
    )
    expect(proxied.status).toBe(501)
    expect(await text(proxied)).toBe(PROXY_TRANSPORT_UNAVAILABLE_BODY)
    expect(transport.calls).toHaveLength(0)
    const direct = await gateway.handle(
      request(
        'POST',
        '/v0/management/api-call',
        bearer(MGMT_KEY),
        JSON.stringify({ method: 'GET', url: 'http://vendor.example/x' }),
      ),
    )
    expect(direct.status).toBe(200)
    expect(transport.calls).toHaveLength(1)
    const body = JSON.parse(await text(direct)) as { status_code: number; body: string }
    expect(body.status_code).toBe(200)
    expect(body.body).toBe('{"vendor":"ok"}')
  })

  it('invalid api-call bodies keep the facade 400s (no 501 bypass)', async () => {
    const gateway = gatewayWith()
    const badBody = await gateway.handle(
      request('POST', '/v0/management/api-call', bearer(MGMT_KEY), 'not json'),
    )
    expect(badBody.status).toBe(400)
    expect(await text(badBody)).toBe('{"error":"invalid body"}')
    const badProxy = await gateway.handle(
      request(
        'POST',
        '/v0/management/api-call',
        bearer(MGMT_KEY),
        JSON.stringify({ method: 'GET', url: 'http://vendor.example/x', proxy_url: '::::' }),
      ),
    )
    expect(badProxy.status).toBe(400)
    expect(await text(badProxy)).toBe('{"error":"invalid proxy_url"}')
  })
})

// ---------------------------------------------------------------------------
// F5b/F5c: device flows on vercel (NE-S7-11) - envelope-only, never complete
// ---------------------------------------------------------------------------

describe('device flows (NE-S7-11)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns the envelope, persists the session, and NEVER completes it', async () => {
    const vendorCalls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        vendorCalls.push(String(url))
        return new Response(
          JSON.stringify({
            device_code: 'dev-code-1',
            user_code: 'ABCD-EFGH',
            verification_uri: 'https://auth.kimi.com/device',
            verification_uri_complete: 'https://auth.kimi.com/device?user_code=ABCD-EFGH',
            interval: 5,
            expires_in: 900,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }),
    )
    let clock = 1_700_000_000_000
    const store = createInMemoryKvStore()
    const gateway = gatewayWith(BASE_RECORD, { store, now: () => clock })
    const response = await gateway.handle(
      request('GET', '/v0/management/kimi-auth-url', bearer(MGMT_KEY)),
    )
    expect(response.status).toBe(200)
    const envelope = JSON.parse(await text(response)) as {
      status: string
      state: string
      flow: string
      user_code: string
      expires_in: number
    }
    expect(envelope.status).toBe('ok')
    expect(envelope.flow).toBe('device')
    expect(envelope.user_code).toBe('ABCD-EFGH')
    expect(envelope.state.startsWith('kmi-')).toBe(true)

    // The session registry is Store-backed: the poll loop never runs on
    // this platform, so the status stays wait for the whole TTL.
    const waiting = await gateway.handle(
      request('GET', `/v0/management/get-auth-status?state=${envelope.state}`, bearer(MGMT_KEY)),
    )
    expect(waiting.status).toBe(200)
    expect(await text(waiting)).toBe('{"status":"wait"}')

    clock += 30 * 60_000 + 1
    const expired = await gateway.handle(
      request('GET', `/v0/management/get-auth-status?state=${envelope.state}`, bearer(MGMT_KEY)),
    )
    expect(expired.status).toBe(200)
    // gin.H serialization: alphabetical keys (goJson), as recorded.
    expect(await text(expired)).toBe('{"error":"unknown or expired state","status":"error"}')

    // Exactly one vendor call: the device authorization. No polling
    // substrate exists on vercel (NE-S7-11's core claim).
    expect(vendorCalls).toHaveLength(1)
    expect(vendorCalls[0]).toContain('auth.kimi.com')
  })

  it('the oauth-callback ladder stays upstream-shaped without completion', async () => {
    const gateway = gatewayWith()
    const badState = await gateway.handle(
      request('POST', '/v0/management/oauth-callback', [], '{"code": "x"}'),
    )
    expect(badState.status).toBe(400)
    expect(await text(badState)).toBe('{"error":"state is required","status":"error"}')
    const unknown = await gateway.handle(
      request('GET', '/v0/management/get-auth-status?state=validstate1', bearer(MGMT_KEY)),
    )
    expect(unknown.status).toBe(200)
    expect(await text(unknown)).toBe('{"error":"unknown or expired state","status":"error"}')
  })
})

// ---------------------------------------------------------------------------
// e2e composition smoke + config persistence (F6)
// ---------------------------------------------------------------------------

describe('end-to-end composition smoke', () => {
  it('serves the full pipeline through the platform handler', async () => {
    const transport = scriptedFetch(() => ({
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
      body: chunkedBody(CLAUDE_SSE, 128),
    }))
    const handler = createVercelHandler({
      env: { CPA_CONFIG_JSON: JSON.stringify(DIRECT_RECORD()) },
      store: createInMemoryKvStore(),
      fetch: transport.fetch,
    })
    const health = await handler(new Request('https://deploy.example/healthz'))
    expect(health.status).toBe(200)
    expect(await health.text()).toBe('{"status":"ok"}')

    const models = await handler(
      new Request('https://deploy.example/v1/models', { headers: { authorization: `Bearer ${API_KEY}` } }),
    )
    expect(models.status).toBe(200)
    expect((JSON.parse(await models.text()) as { data: unknown[] }).data.length).toBeGreaterThan(0)

    const chat = await handler(
      new Request('https://deploy.example/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
        body: CHAT_BODY('claude-direct-model', false),
      }),
    )
    expect(chat.status).toBe(200)
    const completion = JSON.parse(await chat.text()) as {
      object: string
      choices: Array<{ message: { content: string } }>
    }
    expect(completion.object).toBe('chat.completion')
    expect(completion.choices[0]?.message.content).toBe('Hello from mock claude upstream')

    const proxied = await handler(
      new Request('https://deploy.example/v1/ws', { headers: { authorization: `Bearer ${API_KEY}` } }),
    )
    expect(proxied.status).toBe(501)
    expect(await proxied.text()).toBe(WEBSOCKET_UNAVAILABLE_BODY)
  })

  it('management config mutations persist to the KV document and survive reboots', async () => {
    const record: Record<string, unknown> = {
      ...DIRECT_RECORD(),
      'logging-to-file': false,
    }
    const store = createInMemoryKvStore()
    const first = createVercelHandler({
      env: { CPA_CONFIG_JSON: JSON.stringify(record), CPA_CONFIG_PERSIST: '1' },
      store,
    })
    const put = await first(
      new Request('https://deploy.example/v1/0/management', {
        method: 'PUT',
        headers: { authorization: `Bearer ${MGMT_KEY}`, 'content-type': 'application/json' },
        body: '{"value": true}',
      }),
    )
    expect(put.status).toBe(404) // wrong path shape: the recorded unknown-subroute 404
    const realPut = await first(
      new Request('https://deploy.example/v0/management/logging-to-file', {
        method: 'PUT',
        headers: { authorization: `Bearer ${MGMT_KEY}`, 'content-type': 'application/json' },
        body: '{"value": true}',
      }),
    )
    expect(realPut.status).toBe(200)
    expect(await realPut.text()).toBe('{"status":"ok"}')

    const persisted = await store.get('config', 'effective')
    expect(typeof persisted).toBe('string')
    expect(persisted).toContain('logging-to-file: true')

    // Reboot from the KV document: no env config, management mutations
    // still in effect (the F6 management-writes-only substrate).
    const rebooted = createVercelHandler({ env: { CPA_CONFIG_FROM_KV: '1' }, store })
    const read = await rebooted(
      new Request('https://deploy.example/v0/management/logging-to-file', {
        headers: { authorization: `Bearer ${MGMT_KEY}` },
      }),
    )
    expect(read.status).toBe(200)
    expect(await read.text()).toBe('{"logging-to-file":true}')
  })
})
