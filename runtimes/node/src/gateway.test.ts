/**
 * Route-layer unit tests against the recorded S1 goldens.
 *
 * Every byte-exact string below is transcribed from
 * tests/fixtures/S1/* (oracle recordings of CLIProxyAPI v7.3.4). The
 * runtime owns exactly these surfaces; direction semantics stay with
 * the packages' own suites.
 */
import { describe, expect, it } from 'vitest'
import {
  createNodeGateway,
  makeGatewayRequest,
  type NodeGateway,
  type NodeGatewayOptions,
} from './index'
import type { GatewayRequest, GatewayResponse, HeaderList } from './index'

const API_KEY = 'oracle-local-key-1'
const MGMT_KEY = 'oracle-mgmt-key-1'

const BASE_CONFIG: Readonly<Record<string, unknown>> = {
  port: 18317,
  'api-keys': [API_KEY],
  'remote-management': {
    'allow-remote': true,
    'secret-key': MGMT_KEY,
    'disable-control-panel': true,
  },
  'request-retry': 0,
  'transient-error-cooldown-seconds': -1,
  'openai-compatibility': [
    {
      name: 'mock-openai',
      'api-key': 'mock-upstream-key',
      'base-url': 'http://127.0.0.1:18999/v1',
      models: [{ name: 'mock-gpt-model', alias: 'mock-model' }],
    },
  ],
  'claude-api-key': [
    {
      'api-key': 'claude-upstream-key',
      'base-url': 'http://127.0.0.1:20002',
      models: [{ name: 'claude-mock-model', alias: 'claude-mock-model' }],
    },
  ],
}

/** Builds a gateway with the baseline oracle config. */
function gatewayWith(overrides: Partial<NodeGatewayOptions> = {}): NodeGateway {
  return createNodeGateway({ config: BASE_CONFIG, ...overrides })
}

/** Case-insensitive header lookup. */
function header(response: GatewayResponse, name: string): string | undefined {
  const lower = name.toLowerCase()
  for (const [headerName, value] of response.headers) {
    if (headerName.toLowerCase() === lower) return value
  }
  return undefined
}

/** Reads a (string) body plus the CORS names, for compact assertions. */
const CORS_BLOCK_PRESENT = (response: GatewayResponse): void => {
  expect(header(response, 'Access-Control-Allow-Origin')).toBe('*')
  expect(header(response, 'Access-Control-Allow-Methods')).toBe('GET, POST, PUT, PATCH, DELETE, OPTIONS')
  expect(header(response, 'Access-Control-Allow-Headers')).toBe('*')
  expect(header(response, 'Access-Control-Expose-Headers')).toContain('X-CPA-TRACE-ID, X-CPA-VERSION')
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

// ---------------------------------------------------------------------------
// Scripted upstream transport for the merged-direction wiring tests
// ---------------------------------------------------------------------------

interface RecordedCall {
  readonly url: string
  readonly method: string
  readonly headers: HeaderList
  readonly body: string
}

function scriptedFetch(
  respond: (call: RecordedCall) => { status: number; headers: Record<string, string>; body: string },
): { fetch: (url: string, init?: RequestInit) => Promise<Response>; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const fake = (url: string, init?: RequestInit): Promise<Response> => {
    const headers: Array<[string, string]> = []
    const record = (init?.headers ?? {}) as Record<string, string>
    for (const [name, value] of Object.entries(record)) headers.push([name, value])
    const call: RecordedCall = {
      url,
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : '',
    }
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

const OPENAI_CHAT_JSON = JSON.stringify({
  id: 'chatcmpl-mock-0001',
  object: 'chat.completion',
  created: 1770000000,
  model: 'mock-gpt-model',
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: 'Hello from mock openai upstream more' },
      finish_reason: 'stop',
    },
  ],
  usage: { prompt_tokens: 9, completion_tokens: 6, total_tokens: 15 },
})

// ---------------------------------------------------------------------------
// 3.1 meta routes + framework semantics
// ---------------------------------------------------------------------------

describe('S1 meta routes and framework semantics', () => {
  it('serves the root info payload byte-exact', async () => {
    const gateway = gatewayWith()
    const response = await gateway.handle(request('GET', '/'))
    expect(response.status).toBe(200)
    expect(header(response, 'Content-Type')).toBe('application/json; charset=utf-8')
    expect(await text(response)).toBe(
      '{"endpoints":["POST /v1/chat/completions","POST /v1/completions","GET /v1/models"],"message":"CLI Proxy API Server"}',
    )
    CORS_BLOCK_PRESENT(response)
  })

  it('serves /healthz on GET and HEAD, HEAD elsewhere is R-404', async () => {
    const gateway = gatewayWith()
    const get = await gateway.handle(request('GET', '/healthz'))
    expect(get.status).toBe(200)
    expect(await text(get)).toBe('{"status":"ok"}')
    const head = await gateway.handle(request('HEAD', '/healthz'))
    expect(head.status).toBe(200)
    expect(head.body).toBe('')
    expect(header(head, 'Content-Type')).toBeUndefined()
    const headRoot = await gateway.handle(request('HEAD', '/'))
    expect(headRoot.status).toBe(404)
    expect(headRoot.body).toBe('')
  })

  it('answers every OPTIONS with 204 + CORS and no content type', async () => {
    const gateway = gatewayWith()
    for (const path of ['/v1/chat/completions', '/v0/management/config', '/nope']) {
      const response = await gateway.handle(request('OPTIONS', path))
      expect(response.status).toBe(204)
      expect(response.body).toBe('')
      expect(header(response, 'Content-Type')).toBeUndefined()
      CORS_BLOCK_PRESENT(response)
    }
  })

  it('R-404: unknown routes and wrong methods are empty 404s with CORS', async () => {
    const gateway = gatewayWith()
    const unknown = await gateway.handle(request('GET', '/definitely-not-here'))
    expect(unknown.status).toBe(404)
    expect(unknown.body).toBe('')
    expect(header(unknown, 'Content-Type')).toBeUndefined()
    CORS_BLOCK_PRESENT(unknown)
    const wrongMethod = await gateway.handle(request('GET', '/v1/chat/completions', bearer(API_KEY)))
    expect(wrongMethod.status).toBe(404)
    expect(wrongMethod.body).toBe('')
    const wrongMethod2 = await gateway.handle(request('POST', '/v1/models', bearer(API_KEY)))
    expect(wrongMethod2.status).toBe(404)
    expect(wrongMethod2.body).toBe('')
  })

  it('trailing-slash redirects carry Location and no CORS block', async () => {
    const gateway = gatewayWith()
    const get = await gateway.handle(request('GET', '/v1/models/'))
    expect(get.status).toBe(301)
    expect(header(get, 'Location')).toBe('/v1/models')
    expect(header(get, 'Content-Type')).toBe('text/html; charset=utf-8')
    expect(await text(get)).toBe('<a href="/v1/models">Moved Permanently</a>.\n')
    expect(header(get, 'Access-Control-Allow-Origin')).toBeUndefined()
    const post = await gateway.handle(request('POST', '/v1/chat/completions/', bearer(API_KEY), '{}'))
    expect(post.status).toBe(307)
    expect(header(post, 'Location')).toBe('/v1/chat/completions')
    expect(post.body).toBe('')
    expect(header(post, 'Access-Control-Allow-Origin')).toBeUndefined()
    // POST /v1beta/models redirects to the wildcard at the slash form.
    const noSlash = await gateway.handle(request('POST', '/v1beta/models', bearer(API_KEY), '{}'))
    expect(noSlash.status).toBe(307)
    expect(header(noSlash, 'Location')).toBe('/v1beta/models/')
    expect(header(noSlash, 'Access-Control-Allow-Origin')).toBeUndefined()
  })

  it('keep-alive is absent in server mode (404 empty)', async () => {
    const gateway = gatewayWith()
    const response = await gateway.handle(request('GET', '/keep-alive'))
    expect(response.status).toBe(404)
    expect(response.body).toBe('')
  })
})

// ---------------------------------------------------------------------------
// 4.1 client auth gate (five transports, shared by /v1 and /v1beta)
// ---------------------------------------------------------------------------

describe('S1 client auth gate', () => {
  it('rejects missing and invalid credentials byte-exact on every surface', async () => {
    const gateway = gatewayWith()
    for (const path of [
      '/v1/models',
      '/v1/chat/completions',
      '/v1/messages',
      '/v1/responses',
      '/v1beta/models',
      '/backend-api/codex/responses',
      '/openai/v1/videos',
    ]) {
      const method = path === '/v1/models' || path === '/v1beta/models' ? 'GET' : 'POST'
      const missing = await gateway.handle(request(method, path, [], method === 'POST' ? '{}' : ''))
      expect(missing.status).toBe(401)
      expect(header(missing, 'Content-Type')).toBe('application/json; charset=utf-8')
      expect(await text(missing)).toBe('{"error":"Missing API key"}')
      expect(header(missing, 'X-Cpa-Trace-Id')).toBeUndefined()
      const invalid = await gateway.handle(request(method, path, bearer('nope'), method === 'POST' ? '{}' : ''))
      expect(invalid.status).toBe(401)
      expect(await text(invalid)).toBe('{"error":"Invalid API key"}')
    }
  })

  it('accepts all five transports on /v1 and /v1beta', async () => {
    const gateway = gatewayWith()
    const transports: ReadonlyArray<readonly [string, Array<[string, string]>]> = [
      ['Authorization', bearer(API_KEY)],
      ['X-Goog-Api-Key', [['X-Goog-Api-Key', API_KEY]]],
      ['X-Api-Key', [['X-Api-Key', API_KEY]]],
    ]
    for (const [name, headers] of transports) {
      const v1 = await gateway.handle(request('GET', '/v1/models', headers))
      expect(v1.status).toBe(200)
      const v1beta = await gateway.handle(request('GET', '/v1beta/models', headers))
      expect(v1beta.status).toBe(200)
      expect(name).toBeTruthy()
    }
    for (const path of ['/v1/models?key=' + API_KEY, '/v1/models?auth_token=' + API_KEY]) {
      const response = await gateway.handle(request('GET', path))
      expect(response.status).toBe(200)
    }
  })

  it('treats a non-Bearer Authorization scheme as a verbatim (invalid) key', async () => {
    const gateway = gatewayWith()
    const response = await gateway.handle(request('GET', '/v1/models', [['Authorization', 'Basic dXNlcjpwYXNz']]))
    expect(response.status).toBe(401)
    expect(await text(response)).toBe('{"error":"Invalid API key"}')
  })

  it('open mode: empty api-keys leaves every client route open', async () => {
    // Recorded variant V1: baseline config (no providers) minus api-keys.
    const { 'openai-compatibility': _compat, 'claude-api-key': _claude, ...rest } = BASE_CONFIG
    const gateway = createNodeGateway({ config: { ...rest, 'api-keys': [] } })
    const models = await gateway.handle(request('GET', '/v1/models'))
    expect(models.status).toBe(200)
    expect(await text(models)).toBe('{"data":[],"object":"list"}')
    const chat = await gateway.handle(
      request('POST', '/v1/chat/completions', [], '{"model": "no-such-model", "messages": []}'),
    )
    expect(chat.status).toBe(400)
    expect(await text(chat)).toBe(
      '{"error":{"message":"unknown provider for model no-such-model","type":"invalid_request_error","code":"model_not_found","param":"model"}}',
    )
  })
})

// ---------------------------------------------------------------------------
// 6.2 model lists
// ---------------------------------------------------------------------------

describe('S1 model lists', () => {
  it('renders the OpenAI shape with the provider-named owned_by', async () => {
    const gateway = gatewayWith()
    const response = await gateway.handle(request('GET', '/v1/models', bearer(API_KEY)))
    expect(response.status).toBe(200)
    const body = await text(response)
    const parsed = JSON.parse(body) as { data: Array<{ id: string; owned_by: string }>; object: string }
    expect(body.startsWith('{"data":[')).toBe(true)
    expect(parsed.object).toBe('list')
    expect(parsed.data.map((entry) => [entry.id, entry.owned_by])).toEqual([
      ['mock-model', 'mock-openai'],
      ['claude-mock-model', 'claude'],
    ])
  })

  it('switches to the Claude shape on Anthropic-Version and claude-cli UA, with cloaking', async () => {
    const gateway = gatewayWith()
    const byHeader = await gateway.handle(
      request('GET', '/v1/models', [...bearer(API_KEY), ['Anthropic-Version', '2023-06-01']]),
    )
    expect(byHeader.status).toBe(200)
    const body = await text(byHeader)
    expect(body).toContain('"id":"claude-fable-5-dd-ledom-kcom"')
    expect(body).toContain('"display_name":"mock-model"')
    expect(body).toContain('"max_input_tokens":200000')
    expect(body).toContain('"max_tokens":64000')
    expect(body).toContain('"first_id":"claude-fable-5-dd-ledom-kcom"')
    expect(body).toContain('"has_more":false')
    expect(body).toContain('"last_id":"claude-mock-model"')
    const byUa = await gateway.handle(
      request('GET', '/v1/models', [...bearer(API_KEY), ['User-Agent', 'claude-cli/1.0.72 (external, cli)']]),
    )
    expect(await text(byUa)).toBe(body)
  })

  it('disable-cloaking-model-list keeps ids verbatim', async () => {
    const gateway = createNodeGateway({
      config: { ...BASE_CONFIG, 'claude-code': { 'disable-cloaking-model-list': true } },
    })
    const response = await gateway.handle(
      request('GET', '/v1/models', [...bearer(API_KEY), ['Anthropic-Version', '2023-06-01']]),
    )
    const body = await text(response)
    expect(body).toContain('"id":"mock-model"')
    expect(body).toContain('"id":"claude-mock-model"')
  })

  it('renders the /v1beta list and the raw single-model GET asymmetry', async () => {
    const gateway = gatewayWith()
    const list = await gateway.handle(request('GET', '/v1beta/models', bearer(API_KEY)))
    expect(list.status).toBe(200)
    expect(await text(list)).toBe(
      '{"models":[{"description":"mock-model","displayName":"mock-model","name":"models/mock-model","supportedGenerationMethods":["generateContent"]},{"description":"claude-mock-model","displayName":"claude-mock-model","name":"models/claude-mock-model","supportedGenerationMethods":["generateContent"]}]}',
    )
    const single = await gateway.handle(request('GET', '/v1beta/models/mock-model', bearer(API_KEY)))
    expect(single.status).toBe(200)
    expect(await text(single)).toBe('{"displayName":"mock-model","name":"models/mock-model"}')
    const unknown = await gateway.handle(request('GET', '/v1beta/models/absent', bearer(API_KEY)))
    expect(unknown.status).toBe(404)
    expect(header(unknown, 'Content-Type')).toBe('application/json; charset=utf-8')
    expect(await text(unknown)).toBe('{"error":{"message":"Not Found","type":"not_found"}}')
  })
})

// ---------------------------------------------------------------------------
// 3.4 gemini surface routing (structural dispatch)
// ---------------------------------------------------------------------------

describe('S1 v1beta action routing', () => {
  it('unknown :method is the silent 200 fall-through', async () => {
    const gateway = gatewayWith()
    const response = await gateway.handle(
      request('POST', '/v1beta/models/mock-model:bogus', bearer(API_KEY), '{}'),
    )
    expect(response.status).toBe(200)
    expect(response.body).toBe('')
    expect(header(response, 'Content-Type')).toBeUndefined()
    expect(header(response, 'X-Cpa-Trace-Id')).toBeUndefined()
  })

  it('action without a colon is the handler 404 JSON', async () => {
    const gateway = gatewayWith()
    const response = await gateway.handle(request('POST', '/v1beta/models/bogusaction', bearer(API_KEY), '{}'))
    expect(response.status).toBe(404)
    expect(header(response, 'Content-Type')).toBe('application/json; charset=utf-8')
    expect(await text(response)).toBe('{"error":{"message":"/v1beta/models/bogusaction not found.","type":"invalid_request_error"}}')
  })

  it('empty action (trailing slash form) is the handler 404 JSON', async () => {
    const gateway = gatewayWith()
    const response = await gateway.handle(request('POST', '/v1beta/models/', bearer(API_KEY), '{}'))
    expect(response.status).toBe(404)
    expect(await text(response)).toBe('{"error":{"message":"/v1beta/models/ not found.","type":"invalid_request_error"}}')
  })

  it('unknown model on an action is the OpenAI-shaped 400', async () => {
    const gateway = gatewayWith()
    const response = await gateway.handle(
      request('POST', '/v1beta/models/no-such-model:generateContent', bearer(API_KEY), '{"contents":[]}'),
    )
    expect(response.status).toBe(400)
    expect(header(response, 'Content-Type')).toBe('application/json')
    expect(await text(response)).toBe(
      '{"error":{"message":"unknown provider for model no-such-model","type":"invalid_request_error","code":"model_not_found","param":"model"}}',
    )
    expect(header(response, 'X-Cpa-Trace-Id')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 8 error semantics: model_not_found per surface
// ---------------------------------------------------------------------------

describe('S1 model_not_found matrix', () => {
  it('chat surface renders the hand-built literal (no charset, no trace)', async () => {
    const gateway = gatewayWith()
    const response = await gateway.handle(
      request('POST', '/v1/chat/completions', bearer(API_KEY), '{"model": "no-such-model", "messages": []}'),
    )
    expect(response.status).toBe(400)
    expect(header(response, 'Content-Type')).toBe('application/json')
    expect(await text(response)).toBe(
      '{"error":{"message":"unknown provider for model no-such-model","type":"invalid_request_error","code":"model_not_found","param":"model"}}',
    )
    expect(header(response, 'X-Cpa-Trace-Id')).toBeUndefined()
  })

  it('stream:true with an unknown model is still the 400 JSON (pre-stream error)', async () => {
    const gateway = gatewayWith()
    const response = await gateway.handle(
      request(
        'POST',
        '/v1/chat/completions',
        bearer(API_KEY),
        '{"model": "no-such-model", "stream": true, "messages": []}',
      ),
    )
    expect(response.status).toBe(400)
    expect(header(response, 'Content-Type')).toBe('application/json')
  })

  it('claude messages surface renders the collapsed envelope', async () => {
    const gateway = gatewayWith()
    const messages = await gateway.handle(
      request('POST', '/v1/messages', bearer(API_KEY), '{"model": "no-such-model", "messages": []}'),
    )
    expect(messages.status).toBe(400)
    expect(header(messages, 'Content-Type')).toBe('application/json')
    expect(await text(messages)).toBe(
      '{"type":"error","error":{"type":"invalid_request_error","message":"unknown provider for model no-such-model"}}',
    )
    const countTokens = await gateway.handle(
      request('POST', '/v1/messages/count_tokens', bearer(API_KEY), '{"model": "no-such-model", "messages": []}'),
    )
    expect(countTokens.status).toBe(400)
    expect(await text(countTokens)).toBe(
      '{"type":"error","error":{"type":"invalid_request_error","message":"unknown provider for model no-such-model"}}',
    )
  })

  it('responses surface (and codex-direct) render the OpenAI literal', async () => {
    const gateway = gatewayWith()
    for (const path of ['/v1/responses', '/backend-api/codex/responses']) {
      const response = await gateway.handle(
        request('POST', path, bearer(API_KEY), '{"model": "no-such-model", "input": "hi"}'),
      )
      expect(response.status).toBe(400)
      expect(header(response, 'Content-Type')).toBe('application/json')
      expect(await text(response)).toBe(
        '{"error":{"message":"unknown provider for model no-such-model","type":"invalid_request_error","code":"model_not_found","param":"model"}}',
      )
    }
  })
})

// ---------------------------------------------------------------------------
// 3.2/3.3/3.5 image, video, responses, interactions gates
// ---------------------------------------------------------------------------

describe('S1 images and video gates', () => {
  it('disable-image-generation true removes the images routes (404 empty)', async () => {
    const gateway = createNodeGateway({
      config: { ...BASE_CONFIG, 'disable-image-generation': true },
    })
    const response = await gateway.handle(
      request('POST', '/v1/images/generations', bearer(API_KEY), '{"model": "gpt-image-1.5", "prompt": "x"}'),
    )
    expect(response.status).toBe(404)
    expect(response.body).toBe('')
    expect(header(response, 'Content-Type')).toBeUndefined()
  })

  it('images 400 family is byte-exact', async () => {
    const gateway = gatewayWith()
    const invalidJson = await gateway.handle(request('POST', '/v1/images/generations', bearer(API_KEY), 'not json'))
    expect(invalidJson.status).toBe(400)
    expect(header(invalidJson, 'Content-Type')).toBe('application/json; charset=utf-8')
    expect(await text(invalidJson)).toBe('{"error":{"message":"Invalid request: body must be valid JSON","type":"invalid_request_error"}}')
    const missingPrompt = await gateway.handle(
      request('POST', '/v1/images/generations', bearer(API_KEY), '{"model": "gpt-image-1.5"}'),
    )
    expect(await text(missingPrompt)).toBe('{"error":{"message":"Invalid request: prompt is required","type":"invalid_request_error"}}')
    const unsupported = await gateway.handle(
      request('POST', '/v1/images/generations', bearer(API_KEY), '{"model": "gpt-4o", "prompt": "a cat"}'),
    )
    expect(await text(unsupported)).toBe(
      '{"error":{"message":"Model gpt-4o is not supported on /v1/images/generations or /v1/images/edits. Use gpt-image-1.5, gpt-image-2, gpt-image-2.5-flare, gpt-image-2.5-sunburst, gpt-image-2.5, grok-imagine-image, grok-imagine-image-quality, grok-imagine-image-2.0, or a configured openai-compatibility image model.","type":"invalid_request_error"}}',
    )
  })

  it('image-only models on the chat route are the 503 gate (no charset)', async () => {
    const gateway = gatewayWith()
    const response = await gateway.handle(
      request(
        'POST',
        '/v1/chat/completions',
        bearer(API_KEY),
        '{"model": "gpt-image-1.5", "messages": [{"role": "user", "content": "hi"}]}',
      ),
    )
    expect(response.status).toBe(503)
    expect(header(response, 'Content-Type')).toBe('application/json')
    expect(await text(response)).toBe(
      '{"error":{"message":"model gpt-image-1.5 is only supported on /v1/images/generations and /v1/images/edits","type":"server_error","code":"internal_server_error"}}',
    )
  })

  it('video routes are registered; the dispatch is the seam', async () => {
    const gateway = gatewayWith()
    const create = await gateway.handle(
      request('POST', '/v1/videos', bearer(API_KEY), '{"model": "grok-video"}'),
    )
    expect(create.status).toBe(503)
    const retrieve = await gateway.handle(request('GET', '/openai/v1/videos/vid_1', bearer(API_KEY)))
    expect(retrieve.status).toBe(503)
  })
})

describe('S1 responses WS + compact + interactions', () => {
  it('GET /v1/responses without upgrade is the gorilla handshake failure', async () => {
    const gateway = gatewayWith()
    const response = await gateway.handle(request('GET', '/v1/responses', bearer(API_KEY)))
    expect(response.status).toBe(400)
    expect(header(response, 'Content-Type')).toBe('text/plain; charset=utf-8')
    expect(await text(response)).toBe('Bad Request')
    expect(header(response, 'Sec-Websocket-Version')).toBe('13')
    expect(header(response, 'X-Content-Type-Options')).toBe('nosniff')
  })

  it('compact with stream:true is the recorded 400', async () => {
    const gateway = gatewayWith()
    const response = await gateway.handle(
      request('POST', '/v1/responses/compact', bearer(API_KEY), '{"model": "mock-model", "input": "Say hello", "stream": true}'),
    )
    expect(response.status).toBe(400)
    expect(header(response, 'Content-Type')).toBe('application/json; charset=utf-8')
    expect(await text(response)).toBe('{"error":{"message":"Streaming not supported for compact responses","type":"invalid_request_error"}}')
  })

  it('interactions validation bodies are byte-exact', async () => {
    const gateway = gatewayWith()
    const invalidJson = await gateway.handle(request('POST', '/v1beta/interactions', bearer(API_KEY), 'not json'))
    expect(await text(invalidJson)).toBe('{"error":{"message":"invalid JSON body","type":"invalid_request_error"}}')
    const both = await gateway.handle(
      request('POST', '/v1beta/interactions', bearer(API_KEY), '{"model": "m", "agent": "a"}'),
    )
    expect(await text(both)).toBe('{"error":{"message":"request requires exactly one of model or agent","type":"invalid_request_error"}}')
    const neither = await gateway.handle(request('POST', '/v1beta/interactions', bearer(API_KEY), '{}'))
    expect(await text(neither)).toBe('{"error":{"message":"request requires exactly one of model or agent","type":"invalid_request_error"}}')
    const stream = await gateway.handle(
      request('POST', '/v1beta/interactions', bearer(API_KEY), '{"model": "m", "stream": "yes"}'),
    )
    expect(await text(stream)).toBe('{"error":{"message":"stream must be a boolean","type":"invalid_request_error"}}')
  })
})

// ---------------------------------------------------------------------------
// 3.7 realtime/live surface
// ---------------------------------------------------------------------------

describe('S1 realtime and live surface', () => {
  it('realtime auth failures use the nested 401 envelope', async () => {
    const gateway = gatewayWith()
    const missing = await gateway.handle(request('GET', '/v1/realtime'))
    expect(missing.status).toBe(401)
    expect(header(missing, 'Content-Type')).toBe('application/json; charset=utf-8')
    expect(await text(missing)).toBe(
      '{"error":{"code":"invalid_api_key","message":"Missing API key","param":null,"type":"authentication_error"}}',
    )
    const invalid = await gateway.handle(request('GET', '/v1/realtime', bearer('nope')))
    expect(await text(invalid)).toBe(
      '{"error":{"code":"invalid_api_key","message":"Invalid API key","param":null,"type":"authentication_error"}}',
    )
  })

  it('non-WS realtime requests are the nested 426s', async () => {
    const gateway = gatewayWith()
    const plain = await gateway.handle(request('GET', '/v1/realtime', bearer(API_KEY)))
    expect(plain.status).toBe(426)
    expect(header(plain, 'Upgrade')).toBe('websocket')
    expect(await text(plain)).toBe(
      '{"error":{"code":"websocket_upgrade_required","message":"WebSocket upgrade required","param":null,"type":"invalid_request_error"}}',
    )
    const withCallId = await gateway.handle(request('GET', '/v1/realtime?call_id=abc', bearer(API_KEY)))
    expect(await text(withCallId)).toBe(
      '{"error":{"code":"realtime_request_failed","message":"WebSocket upgrade required","param":null,"type":"invalid_request_error"}}',
    )
    const sideband = await gateway.handle(request('GET', '/v1/realtime/calls/abc123', bearer(API_KEY)))
    expect(sideband.status).toBe(426)
    expect(await text(sideband)).toBe(
      '{"error":{"code":"realtime_request_failed","message":"WebSocket upgrade required","param":null,"type":"invalid_request_error"}}',
    )
  })

  it('capability stubs and hangup bodies are byte-exact', async () => {
    const gateway = gatewayWith()
    const accept = await gateway.handle(
      request('POST', '/v1/realtime/calls/abc123/accept', bearer(API_KEY), '{}'),
    )
    expect(accept.status).toBe(501)
    expect(await text(accept)).toBe(
      '{"error":{"code":"realtime_capability_not_supported","message":"Realtime SIP accept are not supported by the ChatGPT/Codex OAuth upstream","param":null,"type":"not_supported_error"}}',
    )
    const reject = await gateway.handle(
      request('POST', '/v1/realtime/calls/abc123/reject', bearer(API_KEY), '{}'),
    )
    expect(await text(reject)).toContain('Realtime SIP reject are not supported')
    const refer = await gateway.handle(
      request('POST', '/v1/realtime/calls/abc123/refer', bearer(API_KEY), '{}'),
    )
    expect(await text(refer)).toContain('Realtime SIP refer are not supported')
    const translations = await gateway.handle(request('GET', '/v1/realtime/translations', bearer(API_KEY)))
    expect(translations.status).toBe(501)
    expect(await text(translations)).toBe(
      '{"error":{"code":"realtime_capability_not_supported","message":"Realtime translation sessions are not supported by the ChatGPT/Codex OAuth upstream","param":null,"type":"not_supported_error"}}',
    )
    const transcription = await gateway.handle(
      request('POST', '/v1/realtime/transcription_sessions', bearer(API_KEY), '{}'),
    )
    expect(await text(transcription)).toContain('Realtime transcription-only sessions are not supported')
    const hangupBad = await gateway.handle(
      request('POST', '/v1/realtime/calls/bad%20id/hangup', bearer(API_KEY), '{}'),
    )
    expect(hangupBad.status).toBe(400)
    expect(await text(hangupBad)).toBe(
      '{"error":{"code":"invalid_call_id","message":"Invalid Realtime call ID","param":null,"type":"invalid_request_error"}}',
    )
    const hangupUnknown = await gateway.handle(
      request('POST', '/v1/realtime/calls/abc123/hangup', bearer(API_KEY), '{}'),
    )
    expect(hangupUnknown.status).toBe(404)
    expect(await text(hangupUnknown)).toBe(
      '{"error":{"code":"realtime_call_not_found","message":"Realtime call not found","param":null,"type":"invalid_request_error"}}',
    )
  })

  it('client_secrets: bad JSON 400, valid mint returns a client_secret', async () => {
    const gateway = gatewayWith()
    const bad = await gateway.handle(request('POST', '/v1/realtime/client_secrets', bearer(API_KEY), 'not-json'))
    expect(bad.status).toBe(400)
    expect(await text(bad)).toBe(
      '{"error":{"code":"invalid_request","message":"Invalid Realtime client secret request","param":null,"type":"invalid_request_error"}}',
    )
    const good = await gateway.handle(
      request('POST', '/v1/realtime/client_secrets', bearer(API_KEY), '{"lifetime_ms": 600000}'),
    )
    expect(good.status).toBe(200)
    const parsed = JSON.parse(await text(good)) as { client_secret: { value: string } }
    expect(parsed.client_secret.value.startsWith('ek_')).toBe(true)
  })

  it('codex-only routes without codex credentials are the recorded 503', async () => {
    const gateway = gatewayWith()
    for (const path of ['/v1/alpha/search', '/backend-api/codex/alpha/search', '/v1/live']) {
      const response = await gateway.handle(request('POST', path, bearer(API_KEY), '{}'))
      expect(response.status).toBe(503)
      expect(header(response, 'Content-Type')).toBe('application/json; charset=utf-8')
      expect(await text(response)).toBe('{"error":"auth_not_found: no auth available"}')
    }
    const call = await gateway.handle(request('POST', '/v1/realtime', bearer(API_KEY), '{}'))
    expect(call.status).toBe(503)
    expect(await text(call)).toBe(
      '{"error":{"code":"realtime_request_failed","message":"auth_not_found: no auth available","param":null,"type":"api_error"}}',
    )
  })

  it('live sideband: 426 plain, malformed id 400, unknown id 404', async () => {
    const gateway = gatewayWith()
    const upgrade = await gateway.handle(request('GET', '/v1/live/abc123', bearer(API_KEY)))
    expect(upgrade.status).toBe(426)
    expect(await text(upgrade)).toBe('{"error":"WebSocket upgrade required"}')
    const malformed = await gateway.handle(request('GET', '/v1/live/bad%20id', bearer(API_KEY)))
    expect(malformed.status).toBe(400)
    expect(await text(malformed)).toBe('{"error":"Invalid Codex live call ID"}')
    const wsRequest = makeGatewayRequest('GET', '/v1/live/abc123', [
      ...bearer(API_KEY),
      ['Connection', 'Upgrade'],
      ['Upgrade', 'websocket'],
    ])
    const unknown = await gateway.handle(wsRequest)
    expect(unknown.status).toBe(404)
    expect(await text(unknown)).toBe('{"error":"Codex live session not found"}')
  })
})

// ---------------------------------------------------------------------------
// 3.8 OAuth callbacks + safe mode + management
// ---------------------------------------------------------------------------

describe('S1 OAuth callbacks', () => {
  it('serves the fixed success page on every plain callback', async () => {
    const gateway = gatewayWith()
    for (const path of ['/anthropic/callback', '/codex/callback', '/antigravity/callback']) {
      const response = await gateway.handle(request('GET', path + '?code=x&state=y'))
      expect(response.status).toBe(200)
      expect(header(response, 'Content-Type')).toBe('text/html; charset=utf-8')
      expect(await text(response)).toContain('Authentication successful!')
    }
  })

  it('devin-style callbacks require code or error', async () => {
    const gateway = gatewayWith()
    for (const path of ['/devin/callback', '/callback']) {
      const missing = await gateway.handle(request('GET', path))
      expect(missing.status).toBe(400)
      expect(header(missing, 'Content-Type')).toBe('application/json; charset=utf-8')
      expect(await text(missing)).toBe('{"error":"code or error is required"}')
    }
  })
})

describe('S1 example-key safe mode', () => {
  const SAFE_CONFIG = { ...BASE_CONFIG, 'api-keys': ['your-api-key-1'] }
  it('seals proxy paths before auth and serves the warning pages', async () => {
    const gateway = createNodeGateway({ config: SAFE_CONFIG })
    const sealed = await gateway.handle(request('GET', '/v1/models'))
    expect(sealed.status).toBe(403)
    expect(header(sealed, 'X-Cpa-Safe-Mode')).toBe('example-api-key')
    expect(header(sealed, 'Content-Type')).toBe('application/json; charset=utf-8')
    expect(await text(sealed)).toBe(
      '{"error":"unsafe_example_api_key","message":"Proxy API endpoints are disabled because api-keys contains template values. Open /management.html?safe-mode=configure, update api-keys in Management, then retry."}',
    )
    const root = await gateway.handle(request('GET', '/'))
    expect(root.status).toBe(200)
    expect(header(root, 'Content-Type')).toBe('text/html; charset=utf-8')
    expect(header(root, 'Cache-Control')).toBe('no-store')
    expect(await text(root)).toContain('Example API key detected')
    expect(await text(root)).toContain('<code>your-api-key-1</code>')
    const options = await gateway.handle(request('OPTIONS', '/v1/chat/completions'))
    expect(options.status).toBe(204)
  })
})

describe('S1 management surface', () => {
  it('is absent (404 empty) without a management secret', async () => {
    const gateway = createNodeGateway({
      config: { ...BASE_CONFIG, 'remote-management': { 'allow-remote': true } },
    })
    const response = await gateway.handle(request('GET', '/v0/management/config', bearer(MGMT_KEY)))
    expect(response.status).toBe(404)
    expect(response.body).toBe('')
    const callback = await gateway.handle(request('GET', '/v0/management/oauth-callback?state=x'))
    expect(callback.status).toBe(404)
  })

  it('auth matrix: missing/invalid key, build headers, unknown subroute', async () => {
    const gateway = gatewayWith()
    const missing = await gateway.handle(request('GET', '/v0/management/config'))
    expect(missing.status).toBe(401)
    expect(await text(missing)).toBe('{"error":"missing management key"}')
    expect(header(missing, 'X-Cpa-Version')).toBe('v7.3.4')
    expect(header(missing, 'X-Cpa-Commit')).toBe('8335eac')
    expect(header(missing, 'X-Cpa-Support-Plugin')).toBe('1')
    const invalid = await gateway.handle(request('GET', '/v0/management/config', bearer('wrong')))
    expect(invalid.status).toBe(401)
    expect(await text(invalid)).toBe('{"error":"invalid management key"}')
    const unknown = await gateway.handle(
      request('GET', '/v0/management/nope', [['X-Management-Key', MGMT_KEY]]),
    )
    expect(unknown.status).toBe(404)
    expect(unknown.body).toBe('')
    const wrongMethod = await gateway.handle(request('PUT', '/v0/management/config', bearer(MGMT_KEY), '{}'))
    expect(wrongMethod.status).toBe(404)
    expect(wrongMethod.body).toBe('')
  })

  it('oauth-callback sits outside the key gate and renders the error family', async () => {
    const gateway = gatewayWith()
    const noState = await gateway.handle(request('GET', '/v0/management/oauth-callback'))
    expect(noState.status).toBe(400)
    expect(await text(noState)).toBe('{"error":"state is required","status":"error"}')
    expect(header(noState, 'X-Cpa-Version')).toBeUndefined()
  })

  it('regression (T2 parity): the composed-management path still key-gates the plane-owned routes', async () => {
    // A composed facade must NOT leave the auth-url family open: the
    // plane-owned subset is gated by the plane regardless (cloudflare
    // gates them explicitly; the node runtime must match).
    const gateway = createNodeGateway({
      config: BASE_CONFIG,
      configYaml: [
        'port: 18317',
        'api-keys:',
        '  - oracle-local-key-1',
        'remote-management:',
        '  allow-remote: true',
        '  secret-key: oracle-mgmt-key-1',
        '',
      ].join('\n'),
    })
    const noKey = await gateway.handle(request('GET', '/v0/management/anthropic-auth-url'))
    expect(noKey.status).toBe(401)
    expect(await text(noKey)).toBe('{"error":"missing management key"}')
    expect(header(noKey, 'X-Cpa-Version')).toBe('v7.3.4')
    expect(header(noKey, 'X-Cpa-Commit')).toBe('8335eac')
    expect(header(noKey, 'X-Cpa-Build-Date')).toBe('2026-09-15T14:07:06Z')
    expect(header(noKey, 'X-Cpa-Support-Plugin')).toBe('1')
    const wrongKey = await gateway.handle(request('GET', '/v0/management/get-auth-status', bearer('nope')))
    expect(wrongKey.status).toBe(401)
    expect(await text(wrongKey)).toBe('{"error":"invalid management key"}')
    const noKeySession = await gateway.handle(request('DELETE', '/v0/management/oauth-session'))
    expect(noKeySession.status).toBe(401)
    const withKey = await gateway.handle(request('GET', '/v0/management/anthropic-auth-url', bearer(MGMT_KEY)))
    expect(withKey.status).toBe(200)
    expect(JSON.parse(await text(withKey))).toMatchObject({ status: 'ok' })
  })

  it('auth-url, get-auth-status and oauth-session answer via the plane', async () => {
    const gateway = gatewayWith()
    const authUrl = await gateway.handle(request('GET', '/v0/management/codex-auth-url', bearer(MGMT_KEY)))
    expect(authUrl.status).toBe(200)
    expect(JSON.parse(await text(authUrl))).toMatchObject({ status: 'ok' })
    const status = await gateway.handle(request('GET', '/v0/management/get-auth-status', bearer(MGMT_KEY)))
    expect(status.status).toBe(200)
    expect(await text(status)).toBe('{"status":"ok"}')
    const session = await gateway.handle(request('DELETE', '/v0/management/oauth-session', bearer(MGMT_KEY)))
    expect(session.status).toBe(400)
    expect(await text(session)).toBe('{"error":"missing state","status":"error"}')
  })
})

// ---------------------------------------------------------------------------
// 5 request-body decoding
// ---------------------------------------------------------------------------

describe('S1 content-encoding handling', () => {
  it('zstd decode failure renders the pinned 400', async () => {
    const gateway = gatewayWith()
    const garbage = new Uint8Array([0x00, 0x01, 0x02, 0xff, 0xff, 0xff, 0xff, 0x00])
    const response = await gateway.handle(
      makeGatewayRequest('POST', '/v1/chat/completions', [...bearer(API_KEY), ['Content-Encoding', 'zstd']], garbage),
    )
    expect(response.status).toBe(400)
    expect(await text(response)).toBe(
      '{"error":{"message":"Invalid request: failed to decode zstd request body: invalid input: magic number mismatch","type":"invalid_request_error"}}',
    )
  })

  it('unsupported encodings are rejected', async () => {
    const gateway = gatewayWith()
    const response = await gateway.handle(
      makeGatewayRequest('POST', '/v1/chat/completions', [...bearer(API_KEY), ['Content-Encoding', 'br']], '{}'),
    )
    expect(response.status).toBe(400)
    expect(await text(response)).toContain('unsupported content encoding: br')
  })

  it('a valid zstd frame decodes and reaches model resolution (fzstd round trip)', async () => {
    const gateway = gatewayWith()
    const content = new TextEncoder().encode('{"model": "no-such-model", "messages": []}')
    const size = content.length
    // Minimal zstd frame: magic (LE), single-segment header with a 1-byte
    // frame-content-size, one last Raw block. Built by hand because the
    // runtime ships a decoder only.
    const header = 1 | (0 << 1) | (size << 3)
    const frame = new Uint8Array(4 + 1 + 1 + 3 + size)
    frame.set([0x28, 0xb5, 0x2f, 0xfd], 0)
    frame.set([0x20], 4)
    frame.set([size], 5)
    frame.set([header & 0xff, (header >> 8) & 0xff, (header >> 16) & 0xff], 6)
    frame.set(content, 9)
    const response = await gateway.handle(
      makeGatewayRequest('POST', '/v1/chat/completions', [...bearer(API_KEY), ['Content-Encoding', 'zstd']], frame),
    )
    // The body decoded and parsed: the model resolution 400 proves the
    // JSON reached the handler (a decode failure would be the pinned
    // magic-mismatch body instead).
    expect(response.status).toBe(400)
    expect(await text(response)).toBe(
      '{"error":{"message":"unknown provider for model no-such-model","type":"invalid_request_error","code":"model_not_found","param":"model"}}',
    )
  })
})

// ---------------------------------------------------------------------------
// Hostile-input guard + dispatch seams
// ---------------------------------------------------------------------------

describe('route-layer hostile-input guard', () => {
  // Nesting depth goes into a position the facades re-serialize (a
  // tool-parameters schema), mirroring the >=10k-depth RangeError escapes
  // found in the gem2oai/res2oai impl reviews; the guard answers 400 for
  // the whole chat/v1beta family uniformly.
  const deepSchema = '{"a":'.repeat(20000) + '1' + '}'.repeat(20000)

  it('deeply nested chat bodies surface the depth 400, not a crash', async () => {
    const gateway = gatewayWith()
    const body = `{"model":"claude-mock-model","messages":[{"role":"user","content":"hi"}],"tools":[{"type":"function","function":{"name":"t","parameters":${deepSchema}}}]}`
    const response = await gateway.handle(request('POST', '/v1/chat/completions', bearer(API_KEY), body))
    expect(response.status).toBe(400)
    expect(await text(response)).toBe(
      '{"error":{"message":"Invalid request: exceeded max depth","type":"invalid_request_error"}}',
    )
  })

  it('deeply nested v1beta bodies are caught around the facade too', async () => {
    const gateway = gatewayWith()
    const body = `{"contents":[{"parts":[{"text":"hi"}]}],"tools":[{"functionDeclarations":[{"name":"t","parameters":${deepSchema}}]}]}`
    const response = await gateway.handle(
      request('POST', '/v1beta/models/mock-model:generateContent', bearer(API_KEY), body),
    )
    expect(response.status).toBe(400)
    expect(await text(response)).toBe(
      '{"error":{"message":"Invalid request: exceeded max depth","type":"invalid_request_error"}}',
    )
  })
})

describe('dispatch seams for unmerged directions', () => {
  const SEAM_BODY =
    '{"error":{"message":"direction not yet available in this build","type":"server_error","code":"not_implemented"}}'

  it('native same-protocol directions stay at the designed 503 seam (ruling: never recorded -> never implemented)', async () => {
    const gateway = gatewayWith()
    // messages:claude-api-key (Claude->Claude passthrough) is the v1
    // scope boundary: unmerged by design, not by backlog.
    const messages = await gateway.handle(
      request('POST', '/v1/messages', bearer(API_KEY), '{"model": "claude-mock-model", "messages": []}'),
    )
    expect(messages.status).toBe(503)
    expect(await text(messages)).toBe(SEAM_BODY)
  })

  it('responses:codex-api-key dispatches through codex-passthrough', async () => {
    const transport = scriptedFetch(() => ({
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
      body: CODEX_SSE,
    }))
    const gateway = createNodeGateway({
      config: {
        ...BASE_CONFIG,
        'codex-api-key': [
          {
            'api-key': 'codex-upstream-key',
            'base-url': 'http://127.0.0.1:21003',
            models: [{ name: 'gpt-mock-codex', alias: 'codex-mock-model' }],
          },
        ],
      },
      fetch: transport.fetch,
    })
    const response = await gateway.handle(
      request('POST', '/v1/responses', bearer(API_KEY), '{"model": "codex-mock-model", "input": "hi"}'),
    )
    expect(response.status).toBe(200)
    expect(transport.calls[0]?.url).toBe('http://127.0.0.1:21003/responses')
    expect(header(response, 'X-Cpa-Trace-Id')).toMatch(/^\d{14}-\d+-[0-9a-f]{8}$/)
    const body = JSON.parse(await text(response)) as { object: string; status: string }
    expect(body.object).toBe('response')
    expect(body.status).toBe('completed')
  })

  it('chat:openai-compatibility dispatches through oai2oai', async () => {
    const transport = scriptedFetch(() => ({
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: OPENAI_CHAT_JSON,
    }))
    const gateway = createNodeGateway({ config: BASE_CONFIG, fetch: transport.fetch })
    const response = await gateway.handle(
      request(
        'POST',
        '/v1/chat/completions',
        bearer(API_KEY),
        '{"model": "mock-model", "messages": [{"role": "user", "content": "Say hello"}]}',
      ),
    )
    expect(response.status).toBe(200)
    expect(transport.calls[0]?.url).toBe('http://127.0.0.1:18999/v1/chat/completions')
    expect(header(response, 'X-Cpa-Trace-Id')).toMatch(/^\d{14}-\d+-[0-9a-f]{8}$/)
    const body = JSON.parse(await text(response)) as { object: string; choices: Array<{ message: { content: string } }> }
    expect(body.object).toBe('chat.completion')
    expect(body.choices[0]?.message.content).toBe('Hello from mock openai upstream more')
  })

  it('chat:gemini-api-key dispatches through oai2gem', async () => {
    const GEMINI_JSON = JSON.stringify({
      candidates: [
        {
          content: { parts: [{ text: 'Hello from mock gemini upstream' }], role: 'model' },
          index: 0,
          finishReason: 'STOP',
        },
      ],
      modelVersion: 'gemini-mock-model',
      usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 6, totalTokenCount: 15 },
    })
    const transport = scriptedFetch(() => ({
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: GEMINI_JSON,
    }))
    const gateway = createNodeGateway({
      config: {
        ...BASE_CONFIG,
        'gemini-api-key': [
          {
            'api-key': 'gemini-upstream-key',
            'base-url': 'http://127.0.0.1:23000',
            models: [{ name: 'gemini-mock-model' }],
          },
        ],
      },
      fetch: transport.fetch,
    })
    const response = await gateway.handle(
      request(
        'POST',
        '/v1/chat/completions',
        bearer(API_KEY),
        '{"model": "gemini-mock-model", "messages": [{"role": "user", "content": "Say hello"}]}',
      ),
    )
    expect(response.status).toBe(200)
    expect(transport.calls[0]?.url).toContain('/v1beta/models/gemini-mock-model:')
    expect(header(response, 'X-Cpa-Trace-Id')).toMatch(/^\d{14}-\d+-[0-9a-f]{8}$/)
    const body = JSON.parse(await text(response)) as { choices: Array<{ message: { content: string } }> }
    expect(body.choices[0]?.message.content).toBe('Hello from mock gemini upstream')
  })

  it('messages:openai-compatibility dispatches through cla2oai', async () => {
    const transport = scriptedFetch(() => ({
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: OPENAI_CHAT_JSON,
    }))
    const gateway = createNodeGateway({ config: BASE_CONFIG, fetch: transport.fetch })
    const response = await gateway.handle(
      request(
        'POST',
        '/v1/messages',
        bearer(API_KEY),
        '{"model": "mock-model", "messages": [{"role": "user", "content": "Say hello"}], "max_tokens": 100}',
      ),
    )
    expect(response.status).toBe(200)
    expect(transport.calls[0]?.url).toBe('http://127.0.0.1:18999/v1/chat/completions')
    expect(header(response, 'X-Cpa-Trace-Id')).toMatch(/^\d{14}-\d+-[0-9a-f]{8}$/)
    const body = JSON.parse(await text(response)) as { type: string; content: Array<{ text: string }> }
    expect(body.type).toBe('message')
    expect(body.content[0]?.text).toBe('Hello from mock openai upstream more')
  })
})

// ---------------------------------------------------------------------------
// Merged-direction wiring end to end
// ---------------------------------------------------------------------------

describe('merged facade wiring', () => {
  it('routes a claude-alias chat completion through oai2cla with trace + CORS', async () => {
    const transport = scriptedFetch(() => ({
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
      body: CLAUDE_SSE,
    }))
    const gateway = createNodeGateway({ config: BASE_CONFIG, fetch: transport.fetch })
    const response = await gateway.handle(
      request(
        'POST',
        '/v1/chat/completions',
        bearer(API_KEY),
        '{"model": "claude-mock-model", "messages": [{"role": "user", "content": "Say hello"}]}',
      ),
    )
    expect(response.status).toBe(200)
    expect(header(response, 'Content-Type')).toBe('application/json')
    const trace = header(response, 'X-Cpa-Trace-Id')
    expect(trace).toBeDefined()
    expect(trace).toMatch(/^\d{14}-\d+-[0-9a-f]{8}$/)
    CORS_BLOCK_PRESENT(response)
    expect(transport.calls.length).toBe(1)
    expect(transport.calls[0]?.url).toBe('http://127.0.0.1:20002/v1/messages?beta=true')
    const body = JSON.parse(await text(response)) as { choices: Array<{ message: { content: string } }> }
    expect(body.choices[0]?.message.content).toBe('Hello from mock claude upstream more')
  })

  it('routes an openai-compat alias through gem2oai on the v1beta surface', async () => {
    const transport = scriptedFetch(() => ({
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: OPENAI_CHAT_JSON,
    }))
    const gateway = createNodeGateway({ config: BASE_CONFIG, fetch: transport.fetch })
    const response = await gateway.handle(
      request(
        'POST',
        '/v1beta/models/mock-model:generateContent',
        bearer(API_KEY),
        '{"contents":[{"parts":[{"text":"Say hello"}]}]}',
      ),
    )
    expect(response.status).toBe(200)
    expect(header(response, 'X-Cpa-Trace-Id')).toMatch(/^\d{14}-\d+-[0-9a-f]{8}$/)
    expect(transport.calls.length).toBe(1)
    expect(transport.calls[0]?.url).toBe('http://127.0.0.1:18999/v1/chat/completions')
    const body = JSON.parse(await text(response)) as {
      candidates: Array<{ content: { parts: Array<{ text: string }> } }>
    }
    expect(body.candidates[0]?.content.parts[0]?.text).toBe('Hello from mock openai upstream more')
  })

  it('normalizes query-param auth for the facades internal gates (?key=)', async () => {
    const transport = scriptedFetch(() => ({
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: OPENAI_CHAT_JSON,
    }))
    const gateway = createNodeGateway({ config: BASE_CONFIG, fetch: transport.fetch })
    // gem2oai/gem2cla gates only accept header presentations; without
    // the runtime-side normalization this request 401s inside the facade.
    const response = await gateway.handle(
      request(
        'POST',
        `/v1beta/models/mock-model:generateContent?key=${API_KEY}`,
        [],
        '{"contents":[{"parts":[{"text":"hi"}]}]}',
      ),
    )
    expect(response.status).toBe(200)
    const upstreamAuth = transport.calls[0]?.headers.find(([name]) => name.toLowerCase() === 'authorization')
    expect(upstreamAuth?.[1]).toBe('Bearer mock-upstream-key')
  })

  it('routes a claude-alias v1beta request through gem2cla with the narrowest gate covered', async () => {
    const transport = scriptedFetch(() => ({
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
      body: CLAUDE_SSE,
    }))
    const gateway = createNodeGateway({ config: BASE_CONFIG, fetch: transport.fetch })
    const response = await gateway.handle(
      request(
        'POST',
        `/v1beta/models/claude-mock-model:generateContent?auth_token=${API_KEY}`,
        [],
        '{"contents":[{"parts":[{"text":"hi"}]}]}',
      ),
    )
    expect(response.status).toBe(200)
    expect(transport.calls[0]?.url).toBe('http://127.0.0.1:20002/v1/messages?beta=true')
  })

  it('countTokens is synthesized locally (no upstream dispatch)', async () => {
    const transport = scriptedFetch(() => ({
      status: 200,
      headers: {},
      body: OPENAI_CHAT_JSON,
    }))
    const gateway = createNodeGateway({ config: BASE_CONFIG, fetch: transport.fetch })
    const response = await gateway.handle(
      request(
        'POST',
        '/v1beta/models/mock-model:countTokens',
        bearer(API_KEY),
        '{"contents":[{"parts":[{"text":"Say hello"}]}]}',
      ),
    )
    expect(response.status).toBe(200)
    expect(transport.calls.length).toBe(0)
    const parsed = JSON.parse(await text(response)) as {
      totalTokens: number
      promptTokensDetails: Array<{ modality: string; tokenCount: number }>
    }
    expect(typeof parsed.totalTokens).toBe('number')
    expect(parsed.promptTokensDetails[0]?.modality).toBe('TEXT')
    expect(parsed.promptTokensDetails[0]?.tokenCount).toBe(parsed.totalTokens)
  })
})


// ---------------------------------------------------------------------------
// S7 F4: /v1/ws route gates (recorded S7-01..04 transcripts)
// ---------------------------------------------------------------------------

describe('S7 /v1/ws route gates', () => {
  it('S7-01: plain GET with ws-auth unset (required) is the 401', async () => {
    const gateway = gatewayWith()
    const response = await gateway.handle(request('GET', '/v1/ws'))
    expect(response.status).toBe(401)
    expect(header(response, 'Content-Type')).toBe('application/json; charset=utf-8')
    expect(await text(response)).toBe('{"error":"Missing API key"}')
  })

  it('S7-02 observables: auth precedes the gorilla 400; toggle-off re-opens', async () => {
    // Steps 2-4 of the recorded sequence (ws-auth enabled).
    const gateway = gatewayWith()
    const wrongKey = await gateway.handle(request('GET', '/v1/ws', bearer('wrong-key')))
    expect(wrongKey.status).toBe(401)
    expect(await text(wrongKey)).toBe('{"error":"Invalid API key"}')
    const validKey = await gateway.handle(request('GET', '/v1/ws', bearer(API_KEY)))
    expect(validKey.status).toBe(400)
    expect(header(validKey, 'Content-Type')).toBe('text/plain; charset=utf-8')
    expect(header(validKey, 'Sec-Websocket-Version')).toBe('13')
    expect(header(validKey, 'X-Content-Type-Options')).toBe('nosniff')
    expect(await text(validKey)).toBe('Bad Request\n')
    // Step 6 observable (ws-auth disabled): no auth required, the
    // handshake check still rejects a plain GET.
    const open = createNodeGateway({ config: { ...BASE_CONFIG, 'ws-auth': false } })
    const response = await open.handle(request('GET', '/v1/ws'))
    expect(response.status).toBe(400)
    expect(await text(response)).toBe('Bad Request\n')
  })

  it('S7-03: POST is the R-404 empty; OPTIONS is auto-answered 204', async () => {
    const gateway = gatewayWith()
    const post = await gateway.handle(request('POST', '/v1/ws', bearer(API_KEY)))
    expect(post.status).toBe(404)
    expect(post.body).toBe('')
    const options = await gateway.handle(request('OPTIONS', '/v1/ws'))
    expect(options.status).toBe(204)
  })

  it('S7-04: a genuine upgrade answers 101 (session protocol is the seam)', async () => {
    const gateway = gatewayWith()
    const response = await gateway.handle(
      makeGatewayRequest('GET', '/v1/ws', [
        ['Upgrade', 'websocket'],
        ['Connection', 'Upgrade'],
        ['Sec-WebSocket-Key', 'T2Try7F8BIaZbRok24njlg=='],
        ['Sec-WebSocket-Version', '13'],
      ]),
    )
    expect(response.status).toBe(101)
    expect(response.body).toBe('')
  })
})

// ---------------------------------------------------------------------------
// Direction flips wired at merge (Phase B)
// ---------------------------------------------------------------------------

/** Canned codex upstream SSE (the s2d5 mock "happy" script, transcribed). */
const CODEX_EVENTS: ReadonlyArray<readonly [string, unknown]> = [
  [
    'response.created',
    {
      type: 'response.created',
      response: {
        id: 'resp_mock_01',
        object: 'response',
        created_at: 1770000000,
        status: 'in_progress',
        model: 'gpt-mock-codex',
        output: [],
        usage: { input_tokens: 9, output_tokens: 6, total_tokens: 15 },
        parallel: false,
        tool_choice: 'auto',
        tools: [],
      },
    },
  ],
  [
    'response.output_item.added',
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'message', id: 'msg_mock_01', role: 'assistant', status: 'in_progress', content: [] },
    },
  ],
  [
    'response.content_part.added',
    {
      type: 'response.content_part.added',
      item_id: 'msg_mock_01',
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    },
  ],
  [
    'response.output_text.delta',
    {
      type: 'response.output_text.delta',
      item_id: 'msg_mock_01',
      output_index: 0,
      content_index: 0,
      delta: 'Hello from mock codex upstream',
    },
  ],
  [
    'response.output_text.delta',
    {
      type: 'response.output_text.delta',
      item_id: 'msg_mock_01',
      output_index: 0,
      content_index: 0,
      delta: ' more',
    },
  ],
  [
    'response.output_text.done',
    {
      type: 'response.output_text.done',
      item_id: 'msg_mock_01',
      output_index: 0,
      content_index: 0,
      text: 'Hello from mock codex upstream more',
    },
  ],
  [
    'response.content_part.done',
    {
      type: 'response.content_part.done',
      item_id: 'msg_mock_01',
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: 'Hello from mock codex upstream more', annotations: [] },
    },
  ],
  [
    'response.output_item.done',
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'message',
        id: 'msg_mock_01',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'Hello from mock codex upstream more', annotations: [] }],
      },
    },
  ],
  [
    'response.completed',
    {
      type: 'response.completed',
      response: {
        id: 'resp_mock_01',
        object: 'response',
        created_at: 1770000000,
        status: 'completed',
        model: 'gpt-mock-codex',
        output: [
          {
            type: 'message',
            id: 'msg_mock_01',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'Hello from mock codex upstream more', annotations: [] }],
          },
        ],
        usage: { input_tokens: 9, output_tokens: 6, total_tokens: 15 },
        parallel: false,
        tool_choice: 'auto',
        tools: [],
      },
    },
  ],
]

const CODEX_SSE = CODEX_EVENTS.map(([name, payload]) => `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`).join(
  '',
)

describe('direction flips wired at merge (Phase B)', () => {
  it('chat:codex-api-key dispatches through oai2codex with trace', async () => {
    const transport = scriptedFetch(() => ({
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
      body: CODEX_SSE,
    }))
    const gateway = createNodeGateway({
      config: {
        ...BASE_CONFIG,
        'codex-api-key': [
          {
            'api-key': 'codex-upstream-key',
            'base-url': 'http://127.0.0.1:21003',
            models: [{ name: 'gpt-mock-codex', alias: 'codex-mock-model' }],
          },
        ],
      },
      fetch: transport.fetch,
    })
    const response = await gateway.handle(
      request(
        'POST',
        '/v1/chat/completions',
        bearer(API_KEY),
        '{"model": "codex-mock-model", "messages": [{"role": "user", "content": "hi"}]}',
      ),
    )
    expect(response.status).toBe(200)
    expect(transport.calls[0]?.url).toBe('http://127.0.0.1:21003/responses')
    expect(header(response, 'X-Cpa-Trace-Id')).toMatch(/^\d{14}-\d+-[0-9a-f]{8}$/)
    const body = JSON.parse(await text(response)) as { choices: Array<{ message: { content: string } }> }
    expect(body.choices[0]?.message.content).toBe('Hello from mock codex upstream more')
  })

  it('responses:openai-compatibility dispatches through res2oai', async () => {
    const transport = scriptedFetch(() => ({
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: OPENAI_CHAT_JSON,
    }))
    const gateway = createNodeGateway({ config: BASE_CONFIG, fetch: transport.fetch })
    const response = await gateway.handle(
      request('POST', '/v1/responses', bearer(API_KEY), '{"model": "mock-model", "input": "Say hello"}'),
    )
    expect(response.status).toBe(200)
    expect(transport.calls[0]?.url).toBe('http://127.0.0.1:18999/v1/chat/completions')
    expect(header(response, 'X-Cpa-Trace-Id')).toMatch(/^\d{14}-\d+-[0-9a-f]{8}$/)
    const body = JSON.parse(await text(response)) as { object: string; status: string }
    expect(body.object).toBe('response')
    expect(body.status).toBe('completed')
  })

  it('messages:gemini-api-key dispatches through cla2gem (count_tokens upstream)', async () => {
    const transport = scriptedFetch(() => ({
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: '{"totalTokens": 9}',
    }))
    const gateway = createNodeGateway({
      config: {
        ...BASE_CONFIG,
        'gemini-api-key': [
          {
            'api-key': 'gemini-upstream-key',
            'base-url': 'http://127.0.0.1:22000',
            models: [{ name: 'gemini-mock-model' }],
          },
        ],
      },
      fetch: transport.fetch,
    })
    const response = await gateway.handle(
      request(
        'POST',
        '/v1/messages/count_tokens',
        bearer(API_KEY),
        '{"model": "gemini-mock-model", "messages": [{"role": "user", "content": "hi"}]}',
      ),
    )
    expect(response.status).toBe(200)
    expect(transport.calls[0]?.url).toBe('http://127.0.0.1:22000/v1beta/models/gemini-mock-model:countTokens')
    const body = JSON.parse(await text(response)) as { input_tokens: number }
    expect(body.input_tokens).toBe(9)
  })

  it('composes the merged management API over configYaml', async () => {
    const gateway = createNodeGateway({
      config: BASE_CONFIG,
      configYaml: [
        'port: 18317',
        'api-keys:',
        '  - oracle-local-key-1',
        'remote-management:',
        '  allow-remote: true',
        '  secret-key: oracle-mgmt-key-1',
        '',
      ].join('\n'),
    })
    const response = await gateway.handle(request('GET', '/v0/management/config', bearer(MGMT_KEY)))
    expect(response.status).toBe(200)
    expect(header(response, 'X-Cpa-Version')).toBe('v7.3.4')
    expect(header(response, 'X-Cpa-Commit')).toBe('8335eac')
    CORS_BLOCK_PRESENT(response)
  })
})

// ---------------------------------------------------------------------------
// Trace scoping on selector envelopes (T4 finding F1)
// ---------------------------------------------------------------------------

describe('trace scoping - selector envelopes stay untraced', () => {
  const RATE_LIMIT_BODY =
    '{"error":{"message":"mock rate limit","type":"rate_limit_exceeded","code":"rate_limit_exceeded"}}'

  it('a cooldown R2 envelope carries no trace header; the executor-routed R1 429 keeps it', async () => {
    let clock = 1_789_490_000_000
    const transport = scriptedFetch(() => ({
      status: 429,
      headers: { 'Content-Type': 'application/json' },
      body: RATE_LIMIT_BODY,
    }))
    const gateway = createNodeGateway({ config: BASE_CONFIG, fetch: transport.fetch, now: () => clock })
    const path = '/v1beta/models/mock-model:generateContent'
    const body = '{"contents":[{"parts":[{"text":"hi"}]}]}'

    // R1: the upstream 429 reaches the executor and passes through.
    const r1 = await gateway.handle(request('POST', path, bearer(API_KEY), body))
    expect(r1.status).toBe(429)
    expect(await text(r1)).toBe(RATE_LIMIT_BODY)
    expect(header(r1, 'Retry-After')).toBeUndefined()
    expect(header(r1, 'X-Cpa-Trace-Id')).toMatch(/^\d{14}-\d+-[0-9a-f]{8}$/)

    // R2: inside the fresh window the facade renders the model_cooldown
    // envelope with no upstream call; the recorded golden has no trace.
    clock += 100
    const r2 = await gateway.handle(request('POST', path, bearer(API_KEY), body))
    expect(r2.status).toBe(429)
    expect(header(r2, 'Retry-After')).toBe('1')
    expect(header(r2, 'X-Cpa-Trace-Id')).toBeUndefined()
    const envelope = JSON.parse(await text(r2)) as { error: { code: string; reset_seconds: number } }
    expect(envelope.error.code).toBe('model_cooldown')
    expect(envelope.error.reset_seconds).toBe(1)
    expect(transport.calls.length).toBe(1)

    // After the window a normal executor-routed response is traced again.
    clock += 1_000
    const ok = scriptedFetch(() => ({
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: OPENAI_CHAT_JSON,
    }))
    const traced = createNodeGateway({ config: BASE_CONFIG, fetch: ok.fetch, now: () => clock })
    const r3 = await traced.handle(request('POST', path, bearer(API_KEY), body))
    expect(r3.status).toBe(200)
    expect(header(r3, 'X-Cpa-Trace-Id')).toMatch(/^\d{14}-\d+-[0-9a-f]{8}$/)
  })

  it('the codex auth-unavailable window response carries no trace header (S2d9-18 shape)', async () => {
    const transport = scriptedFetch(() => ({
      status: 404,
      headers: { 'Content-Type': 'application/json' },
      body: '{"error":{"code":"model_not_found","message":"model not found: mock-codex-upstream"}}',
    }))
    const gateway = createNodeGateway({
      config: {
        ...BASE_CONFIG,
        'codex-api-key': [
          {
            'api-key': 'codex-upstream-key',
            'base-url': 'http://127.0.0.1:21003',
            models: [{ name: 'gpt-mock-codex', alias: 'codex-mock-model' }],
          },
        ],
      },
      fetch: transport.fetch,
    })
    const call = () =>
      gateway.handle(request('POST', '/v1/responses', bearer(API_KEY), '{"model": "codex-mock-model", "input": "hi"}'))

    // R1: the upstream 404 passes through the executor with a trace.
    const r1 = await call()
    expect(r1.status).toBe(404)
    expect(header(r1, 'X-Cpa-Trace-Id')).toMatch(/^\d{14}-\d+-[0-9a-f]{8}$/)

    // R2: inside the not-found window the facade renders the 503
    // auth_unavailable selection error; the recorded golden has no trace.
    const r2 = await call()
    expect(r2.status).toBe(503)
    expect(await text(r2)).toContain('"auth_unavailable: no auth available')
    expect(header(r2, 'X-Cpa-Trace-Id')).toBeUndefined()
    expect(transport.calls.length).toBe(1)
  })
})
