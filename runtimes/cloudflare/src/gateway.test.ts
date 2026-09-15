/**
 * Capability/wiring matrix + routing smoke tests (mission T2, R6):
 * the S7 degradation rows observable at the gateway (F1 proxy 501s,
 * F4 ws-auth gates, F5a redirect 501s, F5b device-flow substrate, F2
 * install 501), the S1 framework semantics, and one merged direction
 * facade composed end-to-end (oai2cla over a scripted upstream).
 */
import { describe, expect, it } from 'vitest'
import { CLOUDFLARE_RUNTIME_CAPABILITIES } from '@cpa-edge/core'
import { KIMI, type FetchLike } from '@cpa-edge/auth'
import { createCloudflareGateway, type CloudflareGateway } from './gateway'
import { DEVICE_POLL_PREFIX, SCHEDULER_NAMESPACE } from './alarm'
import { SimulatedAlarm, SimulatedDoStorage } from './harness'
import { createDurableObjectStore } from './do-store'
import type { GatewayRequest, GatewayResponse } from './types'

const API_KEY = 'oracle-local-key-1'
const MGMT_KEY = 'oracle-mgmt-key-1'

const BASE_CONFIG: Readonly<Record<string, unknown>> = {
  port: 8317,
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
      'api-key': 'claude-upstream-key',
      'base-url': 'http://127.0.0.1:20002',
      models: [{ name: 'claude-mock-model', alias: 'claude-mock-model' }],
    },
  ],
}

const BASE_CONFIG_YAML = `port: 8317
api-keys:
  - "${API_KEY}"
remote-management:
  allow-remote: true
  secret-key: "${MGMT_KEY}"
  disable-control-panel: true
request-retry: 0
transient-error-cooldown-seconds: -1
claude-api-key:
  - api-key: "claude-upstream-key"
    base-url: "http://127.0.0.1:20002"
    models:
      - name: claude-mock-model
        alias: claude-mock-model
`

function gatewayWith(
  overrides: {
    readonly config?: Readonly<Record<string, unknown>>
    readonly configYaml?: string
    readonly fetch?: FetchLike
    readonly alarm?: { setAlarm(ms: number): Promise<void>; getAlarm(): Promise<number | null> }
  } = {},
): CloudflareGateway {
  const store = createDurableObjectStore(new SimulatedDoStorage())
  return createCloudflareGateway({
    config: overrides.config ?? BASE_CONFIG,
    ...(overrides.configYaml === undefined ? {} : { configYaml: overrides.configYaml }),
    store,
    ...(overrides.fetch === undefined ? {} : { fetch: overrides.fetch }),
    ...(overrides.alarm === undefined ? {} : { alarm: overrides.alarm }),
  })
}

function makeRequest(
  method: string,
  pathAndQuery: string,
  headers: ReadonlyArray<readonly [string, string]> = [],
  body: string | Uint8Array = '',
  host = 'workers.example',
): GatewayRequest {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body
  return { method, url: `https://${host}${pathAndQuery}`, headers, body: bytes }
}

function header(response: GatewayResponse, name: string): string | undefined {
  const lower = name.toLowerCase()
  for (const [headerName, value] of response.headers) {
    if (headerName.toLowerCase() === lower) return value
  }
  return undefined
}

const CORS_BLOCK_PRESENT = (response: GatewayResponse): void => {
  expect(header(response, 'Access-Control-Allow-Origin')).toBe('*')
  expect(header(response, 'Access-Control-Allow-Methods')).toBe('GET, POST, PUT, PATCH, DELETE, OPTIONS')
  expect(header(response, 'Access-Control-Allow-Headers')).toBe('*')
  expect(header(response, 'Access-Control-Expose-Headers')).toContain('X-CPA-TRACE-ID, X-CPA-VERSION')
}

const bearer = (key: string): Array<[string, string]> => [['Authorization', `Bearer ${key}`]]

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

/** Scripted upstream transport recording calls. */
function scriptedFetch(
  respond: (call: { url: string; method: string; body: string }) => {
    status: number
    headers: Record<string, string>
    body: string
  },
): { fetch: FetchLike; calls: Array<{ url: string; method: string; body: string }> } {
  const calls: Array<{ url: string; method: string; body: string }> = []
  const fake: FetchLike = (url, init) => {
    const call = { url, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? init.body : '' }
    calls.push(call)
    const reply = respond(call)
    return Promise.resolve(new Response(reply.body, { status: reply.status, headers: reply.headers }))
  }
  return { fetch: fake, calls }
}

const CLAUDE_SSE = [
  'event: message_start',
  `data: ${JSON.stringify({
    type: 'message_start',
    message: {
      id: 'msg_mock_01',
      type: 'message',
      role: 'assistant',
      model: 'claude-mock-model',
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
    delta: { type: 'text_delta', text: 'Hello from mock claude upstream more' },
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

// ---------------------------------------------------------------------------
// R4: capability descriptor (S7 section 3.1, cloudflare column)
// ---------------------------------------------------------------------------

describe('runtime capabilities', () => {
  it('declares the S7 cloudflare column exactly', () => {
    expect(CLOUDFLARE_RUNTIME_CAPABILITIES).toEqual({
      inboundWebSocket: true,
      proxyTransport: false,
      pluginLoading: false,
      fileLogging: true,
      fileWatching: false,
      localCallbackServer: false,
    })
  })

  it('is frozen (immutable for the process lifetime)', () => {
    expect(Object.isFrozen(CLOUDFLARE_RUNTIME_CAPABILITIES)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// S1 framework semantics
// ---------------------------------------------------------------------------

describe('S1 framework semantics', () => {
  it('serves the root info payload and healthz', async () => {
    const gateway = gatewayWith()
    const root = await gateway.handle(makeRequest('GET', '/'))
    expect(root.status).toBe(200)
    expect(await text(root)).toBe(
      '{"endpoints":["POST /v1/chat/completions","POST /v1/completions","GET /v1/models"],"message":"CLI Proxy API Server"}',
    )
    CORS_BLOCK_PRESENT(root)
    const health = await gateway.handle(makeRequest('GET', '/healthz'))
    expect(health.status).toBe(200)
    expect(await text(health)).toBe('{"status":"ok"}')
  })

  it('answers every OPTIONS with 204 + CORS and no content type', async () => {
    const gateway = gatewayWith()
    for (const path of ['/v1/chat/completions', '/v0/management/config', '/nope']) {
      const response = await gateway.handle(makeRequest('OPTIONS', path))
      expect(response.status).toBe(204)
      expect(response.body).toBe('')
      expect(header(response, 'Content-Type')).toBeUndefined()
      CORS_BLOCK_PRESENT(response)
    }
  })

  it('R-404: unknown routes and wrong methods are empty 404s with CORS', async () => {
    const gateway = gatewayWith()
    const unknown = await gateway.handle(makeRequest('GET', '/definitely-not-here'))
    expect(unknown.status).toBe(404)
    expect(unknown.body).toBe('')
    expect(header(unknown, 'Content-Type')).toBeUndefined()
    CORS_BLOCK_PRESENT(unknown)
    const wrongMethod = await gateway.handle(makeRequest('GET', '/v1/chat/completions', bearer(API_KEY)))
    expect(wrongMethod.status).toBe(404)
    expect(wrongMethod.body).toBe('')
  })

  it('trailing-slash redirects carry Location and no CORS block', async () => {
    const gateway = gatewayWith()
    const get = await gateway.handle(makeRequest('GET', '/v1/models/'))
    expect(get.status).toBe(301)
    expect(header(get, 'Location')).toBe('/v1/models')
    expect(header(get, 'Content-Type')).toBe('text/html; charset=utf-8')
    expect(await text(get)).toBe('<a href="/v1/models">Moved Permanently</a>.\n')
    expect(header(get, 'Access-Control-Allow-Origin')).toBeUndefined()
  })

  it('client routes without a key answer the upstream 401 shapes', async () => {
    const gateway = gatewayWith()
    const missing = await gateway.handle(
      makeRequest('POST', '/v1/chat/completions', [], JSON.stringify({ model: 'claude-mock-model' })),
    )
    expect(missing.status).toBe(401)
    expect(await text(missing)).toBe('{"error":"Missing API key"}')
    CORS_BLOCK_PRESENT(missing)
    const invalid = await gateway.handle(
      makeRequest('POST', '/v1/chat/completions', bearer('nope'), JSON.stringify({ model: 'claude-mock-model' })),
    )
    expect(invalid.status).toBe(401)
    expect(await text(invalid)).toBe('{"error":"Invalid API key"}')
  })
})

// ---------------------------------------------------------------------------
// S7 F4: /v1/ws gates (goldens S7-01/02/03)
// ---------------------------------------------------------------------------

describe('S7 F4: inbound WebSocket route', () => {
  it('default config: plain GET without a key is the 401 Missing API key (S7-01)', async () => {
    const gateway = gatewayWith()
    const response = await gateway.handle(makeRequest('GET', '/v1/ws'))
    expect(response.status).toBe(401)
    expect(await text(response)).toBe('{"error":"Missing API key"}')
    CORS_BLOCK_PRESENT(response)
  })

  it('valid key without an upgrade is the gorilla 400 with handshake headers (S7-02)', async () => {
    const gateway = gatewayWith()
    const response = await gateway.handle(makeRequest('GET', '/v1/ws', bearer(API_KEY)))
    expect(response.status).toBe(400)
    expect(response.body).toBe('Bad Request\n')
    expect(header(response, 'Content-Type')).toBe('text/plain; charset=utf-8')
    expect(header(response, 'Sec-Websocket-Version')).toBe('13')
    expect(header(response, 'X-Content-Type-Options')).toBe('nosniff')
    CORS_BLOCK_PRESENT(response)
  })

  it('invalid key keeps the 401 Invalid shape (auth precedes the gorilla 400)', async () => {
    const gateway = gatewayWith()
    const response = await gateway.handle(makeRequest('GET', '/v1/ws', bearer('wrong')))
    expect(response.status).toBe(401)
    expect(await text(response)).toBe('{"error":"Invalid API key"}')
  })

  it('POST /v1/ws is the empty 404 (S7-03, R-404)', async () => {
    const gateway = gatewayWith()
    const response = await gateway.handle(makeRequest('POST', '/v1/ws', bearer(API_KEY), '{}'))
    expect(response.status).toBe(404)
    expect(response.body).toBe('')
    CORS_BLOCK_PRESENT(response)
  })

  it('explicit ws-auth: false opens the route - plain GET gets the gorilla 400', async () => {
    const gateway = gatewayWith({ config: { ...BASE_CONFIG, 'ws-auth': false } })
    const response = await gateway.handle(makeRequest('GET', '/v1/ws'))
    expect(response.status).toBe(400)
    expect(response.body).toBe('Bad Request\n')
    expect(header(response, 'Sec-Websocket-Version')).toBe('13')
  })
})

// ---------------------------------------------------------------------------
// S7 F5a/F5b: auth-URL endpoints
// ---------------------------------------------------------------------------

describe('S7 F5a: redirect-flow auth-URLs answer the 501 after the management gate', () => {
  for (const provider of ['anthropic', 'codex', 'antigravity', 'devin']) {
    it(`${provider}-auth-url answers the pinned 501 body with the key`, async () => {
      const gateway = gatewayWith({ configYaml: BASE_CONFIG_YAML })
      const response = await gateway.handle(
        makeRequest('GET', `/v0/management/${provider}-auth-url`, bearer(MGMT_KEY)),
      )
      expect(response.status).toBe(501)
      expect(await text(response)).toBe('{"error":"local callback server is not available on this runtime"}')
      expect(header(response, 'Content-Type')).toBe('application/json; charset=utf-8')
      CORS_BLOCK_PRESENT(response)
    })
  }

  it('the management key gate runs first: no key is the 401', async () => {
    const gateway = gatewayWith({ configYaml: BASE_CONFIG_YAML })
    const response = await gateway.handle(makeRequest('GET', '/v0/management/anthropic-auth-url'))
    expect(response.status).toBe(401)
    expect(await text(response)).toBe('{"error":"missing management key"}')
  })
})

describe('S7 F5b: device-flow auth-URLs stay live on the alarm substrate', () => {
  it('kimi-auth-url returns the envelope, registers the session, arms the poll loop', async () => {
    const alarm = new SimulatedAlarm()
    const { fetch, calls } = scriptedFetch(() => ({
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        device_code: 'dc-1',
        user_code: 'ABCD-EFGH',
        verification_uri_complete: 'https://vendor.example/activate?user_code=ABCD-EFGH',
        interval: 5,
        expires_in: 900,
      }),
    }))
    const gateway = gatewayWith({ configYaml: BASE_CONFIG_YAML, fetch, alarm })
    const response = await gateway.handle(makeRequest('GET', '/v0/management/kimi-auth-url', bearer(MGMT_KEY)))
    expect(response.status).toBe(200)
    const body = JSON.parse(await text(response)) as Record<string, unknown>
    expect(body['status']).toBe('ok')
    expect(body['flow']).toBe('device')
    expect(body['user_code']).toBe('ABCD-EFGH')
    expect(String(body['url'])).toContain('vendor.example')
    expect(calls[0]?.url).toBe(KIMI.deviceAuthorizationEndpoint)

    const state = String(body['state'])
    const store = gateway.store
    const pollDoc = await store.get(SCHEDULER_NAMESPACE, `${DEVICE_POLL_PREFIX}${state}`)
    expect(pollDoc).toBeDefined()
    // Kimi's first poll waits one interval; the alarm is armed there.
    expect(alarm.lastArmed()).toBeLessThanOrEqual(Date.now() + 5_000)
    // get-auth-status reads the pending session: {"status":"wait"}.
    const status = await gateway.handle(
      makeRequest('GET', `/v0/management/get-auth-status?state=${encodeURIComponent(state)}`, bearer(MGMT_KEY)),
    )
    expect(await text(status)).toBe('{"status":"wait"}')
  })

  it('meta-auth-url and xai-auth-url reach their vendor endpoints', async () => {
    const alarm = new SimulatedAlarm()
    const { fetch, calls } = scriptedFetch((call) => {
      if (call.url.includes('openid-configuration')) {
        return {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            device_authorization_endpoint: 'https://auth.x.ai/device/authorize',
            token_endpoint: 'https://auth.x.ai/oauth/token',
          }),
        }
      }
      return {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          device_code: 'dc-x',
          user_code: 'WXYZ',
          verification_uri_complete: 'https://vendor.example/x',
          interval: 5,
        }),
      }
    })
    const gateway = gatewayWith({ configYaml: BASE_CONFIG_YAML, fetch, alarm })
    const xai = await gateway.handle(makeRequest('GET', '/v0/management/xai-auth-url', bearer(MGMT_KEY)))
    expect(xai.status).toBe(200)
    const meta = await gateway.handle(makeRequest('GET', '/v0/management/meta-auth-url', bearer(MGMT_KEY)))
    expect(meta.status).toBe(200)
    // xAI discovery + device authorization + meta device authorization.
    expect(calls.length).toBeGreaterThanOrEqual(3)
    expect(calls.some((call) => call.url.includes('openid-configuration'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// S7 F1: proxy scheduling exclusion + 501s
// ---------------------------------------------------------------------------

describe('S7 F1: proxy-credentialed credentials', () => {
  const PROXIED_CLAUDE: Readonly<Record<string, unknown>> = {
    port: 8317,
    'api-keys': [API_KEY],
    'remote-management': { 'allow-remote': true, 'secret-key': MGMT_KEY },
    'request-retry': 0,
    'transient-error-cooldown-seconds': -1,
    'claude-api-key': [
      {
        'api-key': 'proxied-key',
        'base-url': 'http://127.0.0.1:20002',
        'proxy-url': 'socks5://127.0.0.1:1080',
        models: [{ name: 'claude-mock-model', alias: 'claude-mock-model' }],
      },
    ],
  }

  it('a model offered only by proxied credentials answers the pinned 501', async () => {
    const { fetch, calls } = scriptedFetch(() => ({ status: 200, headers: {}, body: '' }))
    const gateway = gatewayWith({ config: PROXIED_CLAUDE, configYaml: BASE_CONFIG_YAML, fetch })
    const response = await gateway.handle(
      makeRequest(
        'POST',
        '/v1/chat/completions',
        bearer(API_KEY),
        JSON.stringify({ model: 'claude-mock-model', messages: [{ role: 'user', content: 'hi' }] }),
      ),
    )
    expect(response.status).toBe(501)
    expect(await text(response)).toBe(
      '{"error":{"message":"outbound proxy transport (proxy-url) is not available on this runtime","type":"not_implemented","code":"proxy_unavailable"}}',
    )
    expect(header(response, 'Content-Type')).toBe('application/json; charset=utf-8')
    CORS_BLOCK_PRESENT(response)
    // No upstream attempt, no retry rounds, no cooldown side effects.
    expect(calls).toHaveLength(0)
  })

  it('model resolution precedes the 501: unknown models keep the 400', async () => {
    const gateway = gatewayWith({ config: PROXIED_CLAUDE, configYaml: BASE_CONFIG_YAML })
    const response = await gateway.handle(
      makeRequest(
        'POST',
        '/v1/chat/completions',
        bearer(API_KEY),
        JSON.stringify({ model: 'not-configured', messages: [{ role: 'user', content: 'hi' }] }),
      ),
    )
    expect(response.status).toBe(400)
    expect(await text(response)).toContain('model_not_found')
  })

  it('a proxied and a direct credential coexist: the direct one serves the request', async () => {
    const { fetch, calls } = scriptedFetch(() => ({
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
      body: CLAUDE_SSE,
    }))
    const mixed: Readonly<Record<string, unknown>> = {
      ...PROXIED_CLAUDE,
      'claude-api-key': [
        ...(PROXIED_CLAUDE['claude-api-key'] as ReadonlyArray<Record<string, unknown>>),
        {
          'api-key': 'direct-key',
          'base-url': 'http://127.0.0.1:20003',
          models: [{ name: 'claude-mock-model', alias: 'claude-mock-model' }],
        },
      ],
    }
    const gateway = gatewayWith({ config: mixed, configYaml: BASE_CONFIG_YAML, fetch })
    const response = await gateway.handle(
      makeRequest(
        'POST',
        '/v1/chat/completions',
        bearer(API_KEY),
        JSON.stringify({ model: 'claude-mock-model', messages: [{ role: 'user', content: 'hi' }] }),
      ),
    )
    expect(response.status).toBe(200)
    expect(calls).toHaveLength(1)
    // The direct credential carried the request (base-url 20003).
    expect(calls[0]?.url).toContain('127.0.0.1:20003')
  })

  it('api-call with a proxy_url resolves to the F1-501 management body', async () => {
    const { fetch, calls } = scriptedFetch(() => ({ status: 200, headers: {}, body: 'upstream-body' }))
    const gateway = gatewayWith({ configYaml: BASE_CONFIG_YAML, fetch })
    const blocked = await gateway.handle(
      makeRequest(
        'POST',
        '/v0/management/api-call',
        bearer(MGMT_KEY),
        JSON.stringify({ method: 'GET', url: 'https://upstream.example/x', proxy_url: 'socks5://127.0.0.1:1080' }),
      ),
    )
    expect(blocked.status).toBe(501)
    expect(await text(blocked)).toBe('{"error":"proxy transport is not available on this runtime"}')
    expect(calls).toHaveLength(0)

    const malformed = await gateway.handle(
      makeRequest(
        'POST',
        '/v0/management/api-call',
        bearer(MGMT_KEY),
        JSON.stringify({ method: 'GET', url: 'https://upstream.example/x', proxy_url: 'ftp://bad' }),
      ),
    )
    expect(malformed.status).toBe(400)
    expect(await text(malformed)).toBe('{"error":"invalid proxy_url"}')

    const direct = await gateway.handle(
      makeRequest(
        'POST',
        '/v0/management/api-call',
        bearer(MGMT_KEY),
        JSON.stringify({ method: 'GET', url: 'http://127.0.0.1:20999/direct' }),
      ),
    )
    expect(direct.status).toBe(200)
    expect(JSON.parse(await text(direct))['status_code']).toBe(200)
    expect(calls).toHaveLength(1)
  })

  it('the global config proxy-url excludes credentials without their own value', async () => {
    const config: Readonly<Record<string, unknown>> = {
      ...BASE_CONFIG,
      'proxy-url': 'http://proxy.example:8080',
    }
    const { fetch, calls } = scriptedFetch(() => ({ status: 200, headers: {}, body: '' }))
    const gateway = gatewayWith({ config, fetch })
    const response = await gateway.handle(
      makeRequest(
        'POST',
        '/v1/chat/completions',
        bearer(API_KEY),
        JSON.stringify({ model: 'claude-mock-model', messages: [{ role: 'user', content: 'hi' }] }),
      ),
    )
    expect(response.status).toBe(501)
    expect(calls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// S7 F2: plugin install
// ---------------------------------------------------------------------------

describe('S7 F2: plugin-store installs', () => {
  it('answers the pinned 501 body after the management gate', async () => {
    const gateway = gatewayWith({ configYaml: BASE_CONFIG_YAML })
    const noKey = await gateway.handle(makeRequest('POST', '/v0/management/plugin-store/x/install', [], '{}'))
    expect(noKey.status).toBe(401)
    const response = await gateway.handle(
      makeRequest('POST', '/v0/management/plugin-store/x/install', bearer(MGMT_KEY), '{}'),
    )
    expect(response.status).toBe(501)
    expect(await text(response)).toBe('{"error":"plugin installation is not available on this runtime"}')
    CORS_BLOCK_PRESENT(response)
  })
})

// ---------------------------------------------------------------------------
// Management availability (B19) + panel absence (NE-S7-08)
// ---------------------------------------------------------------------------

describe('management availability and absent surfaces', () => {
  it('without a secret the whole management surface is the empty 404', async () => {
    const config: Readonly<Record<string, unknown>> = {
      'api-keys': [API_KEY],
      'remote-management': { 'allow-remote': true },
    }
    const gateway = gatewayWith({ config })
    for (const path of ['/v0/management/config', '/v0/management/get-auth-status', '/v0/management/api-keys']) {
      const response = await gateway.handle(makeRequest('GET', path, bearer(MGMT_KEY)))
      expect(response.status).toBe(404)
      expect(response.body).toBe('')
      CORS_BLOCK_PRESENT(response)
    }
  })

  it('the management control panel route 404s (no writable filesystem)', async () => {
    const gateway = gatewayWith({ configYaml: BASE_CONFIG_YAML })
    const response = await gateway.handle(makeRequest('GET', '/management.html'))
    expect(response.status).toBe(404)
    expect(response.body).toBe('')
  })
})

// ---------------------------------------------------------------------------
// The end-to-end smoke: one merged direction facade through the fetch
// handler (oai2cla, S2d3) + the model list
// ---------------------------------------------------------------------------

describe('direction-facade smoke through the gateway', () => {
  it('chat/completions streams the translated claude SSE downstream with trace + CORS', async () => {
    const { fetch, calls } = scriptedFetch(() => ({
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
      body: CLAUDE_SSE,
    }))
    const gateway = gatewayWith({ fetch })
    const response = await gateway.handle(
      makeRequest(
        'POST',
        '/v1/chat/completions',
        bearer(API_KEY),
        JSON.stringify({
          model: 'claude-mock-model',
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
        }),
      ),
    )
    expect(response.status).toBe(200)
    expect(header(response, 'Content-Type')).toContain('text/event-stream')
    const body = await text(response)
    // The downstream speaks the client surface's protocol: OpenAI
    // chat.completion.chunk frames translated from the claude SSE.
    expect(body).toContain('"object":"chat.completion.chunk"')
    expect(body).toContain('"model":"claude-mock-model"')
    expect(body).toContain('Hello from mock claude upstream more')
    expect(body).toContain('"finish_reason":"stop"')
    expect(body).toContain('data: [DONE]')
    expect(header(response, 'X-Cpa-Trace-Id')).toMatch(/^\d{14}-0-[0-9a-f]{8}$/)
    CORS_BLOCK_PRESENT(response)
    // The upstream call carried the claude credential key.
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toContain('127.0.0.1:20002')
  })

  it('serves the OpenAI-shaped model list from the registry', async () => {
    const gateway = gatewayWith()
    const response = await gateway.handle(makeRequest('GET', '/v1/models', bearer(API_KEY)))
    expect(response.status).toBe(200)
    const body = JSON.parse(await text(response)) as { data: Array<Record<string, unknown>>; object: string }
    expect(body['object']).toBe('list')
    expect(body['data']).toEqual([
      { created: expect.any(Number), id: 'claude-mock-model', object: 'model', owned_by: 'claude' },
    ])
  })
})

// ---------------------------------------------------------------------------
// S1 transport: zstd request bodies (S1-25 parity, fzstd decoder)
// ---------------------------------------------------------------------------

describe('S1 transport: zstd request bodies', () => {
  /** Decodes embedded base64 into bytes (fixture keeps the test node-free). */
  function b64Bytes(b64: string): Uint8Array {
    const raw = atob(b64)
    const out = new Uint8Array(raw.length)
    for (let index = 0; index < raw.length; index++) {
      out[index] = raw.charCodeAt(index)
    }
    return out
  }

  /**
   * One deterministic zstd frame of the smoke chat body (produced with
   * the reference toolchain, embedded verbatim so the test bundle stays
   * dependency-free).
   */
  const ZSTD_FRAME_B64 =
    'KLUv/SBXTQIAEkUQFaClbRVahBLa3/3/kjjL/17pMP/DEOsp13zkuWoxLAsCNi/6IiwWzmuy+QfTSjDrAUT1ZzEGBW/cJHKKzecGzyoBAG6YTQ=='
  const ZSTD_HEADERS: ReadonlyArray<readonly [string, string]> = [
    ['Authorization', `Bearer ${API_KEY}`],
    ['Content-Encoding', 'zstd'],
  ]

  it('decodes a zstd body and serves the request through the facade end-to-end', async () => {
    const { fetch, calls } = scriptedFetch(() => ({
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
      body: CLAUDE_SSE,
    }))
    const gateway = gatewayWith({ fetch })
    const response = await gateway.handle(
      makeRequest('POST', '/v1/chat/completions', ZSTD_HEADERS, b64Bytes(ZSTD_FRAME_B64)),
    )
    expect(response.status).toBe(200)
    const body = await text(response)
    expect(body).toContain('"object":"chat.completion.chunk"')
    expect(body).toContain('Hello from mock claude upstream more')
    // The decoded JSON reached the facade: the upstream call carries the
    // translated request for the decoded model.
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toContain('127.0.0.1:20002')
    expect(calls[0]?.body).toContain('claude-mock-model')
  })

  it('renders the pinned magic-mismatch wording for undecodable zstd bodies', async () => {
    const { fetch, calls } = scriptedFetch(() => ({ status: 200, headers: {}, body: '' }))
    const gateway = gatewayWith({ fetch })
    const response = await gateway.handle(
      makeRequest(
        'POST',
        '/v1/chat/completions',
        ZSTD_HEADERS,
        Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8),
      ),
    )
    expect(response.status).toBe(400)
    expect(header(response, 'Content-Type')).toBe('application/json; charset=utf-8')
    expect(await text(response)).toBe(
      '{"error":{"message":"Invalid request: failed to decode zstd request body: invalid input: magic number mismatch","type":"invalid_request_error"}}',
    )
    expect(calls).toHaveLength(0)
  })
})
