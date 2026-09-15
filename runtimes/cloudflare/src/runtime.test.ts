/**
 * Durable Object runtime tests (mission T2): the object's own lifecycle
 * - config bootstrap from a KV binding (R5), the fetch handler over Web
 * requests, management write-back with immediate hot reload (S7 F6),
 * the alarm pass wired through the runtime (R3), and the end-to-end
 * direction-facade smoke through the object's fetch (R6).
 */
import { describe, expect, it } from 'vitest'
import { AUTH_FILES_NAMESPACE, formatRfc3339, type FetchLike } from '@cpa-edge/auth'
import { DurableObjectRuntime } from './runtime'
import { SimulatedAlarm, SimulatedDoStorage, SimulatedWebSocketHost, makeFakeKv, makeFakeSocket } from './harness'
import { CONFIG_NAMESPACE, CONFIG_TEXT_KEY } from './config'

const API_KEY = 'oracle-local-key-1'
const MGMT_KEY = 'oracle-mgmt-key-1'

const CONFIG_YAML_TEXT = `port: 8317
api-keys:
  - "${API_KEY}"
remote-management:
  allow-remote: true
  secret-key: "${MGMT_KEY}"
  disable-control-panel: true
request-retry: 0
transient-error-cooldown-seconds: -1
ws-auth: true
claude-api-key:
  - api-key: "claude-upstream-key"
    base-url: "http://127.0.0.1:20002"
    models:
      - name: claude-mock-model
        alias: claude-mock-model
`

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

function newRuntime(options: {
  readonly configKv?: { get(key: string): Promise<string | null> }
  readonly fetch?: FetchLike
}): { runtime: DurableObjectRuntime; storage: SimulatedDoStorage; alarm: SimulatedAlarm; sockets: SimulatedWebSocketHost } {
  const storage = new SimulatedDoStorage()
  const alarm = new SimulatedAlarm()
  const sockets = new SimulatedWebSocketHost()
  const runtime = new DurableObjectRuntime({
    storage,
    alarm,
    sockets,
    env: { ...(options.configKv === undefined ? {} : { configKv: options.configKv }) },
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  })
  return { runtime, storage, alarm, sockets }
}

function webRequest(
  method: string,
  pathAndQuery: string,
  headers: ReadonlyArray<readonly [string, string]> = [],
  body = '',
): Request {
  return new Request(`https://workers.example${pathAndQuery}`, {
    method,
    headers,
    ...(body === '' && method !== 'POST' ? {} : { body }),
  })
}

async function bodyText(response: Response): Promise<string> {
  return response.text()
}

describe('durable object runtime: bootstrap and serving', () => {
  it('boots from the KV binding and answers meta routes', async () => {
    const { runtime } = newRuntime({ configKv: makeFakeKv({ 'config.yaml': CONFIG_YAML_TEXT }) })
    const health = await runtime.fetch(webRequest('GET', '/healthz'))
    expect(health.status).toBe(200)
    expect(await bodyText(health)).toBe('{"status":"ok"}')
    const root = await runtime.fetch(webRequest('GET', '/'))
    expect(root.status).toBe(200)
    expect(root.headers.get('Access-Control-Allow-Origin')).toBe('*')
  })

  it('persists the bootstrap config text into the object store on first boot', async () => {
    const { runtime, storage } = newRuntime({ configKv: makeFakeKv({ 'config.yaml': CONFIG_YAML_TEXT }) })
    await runtime.fetch(webRequest('GET', '/healthz'))
    const stored = await runtime.getStore().get(CONFIG_NAMESPACE, CONFIG_TEXT_KEY)
    expect(String(stored)).toContain('secret-key')
    // The stored copy wins over the binding afterwards; the KV source
    // is only a bootstrap.
    expect(storage.size).toBeGreaterThan(0)
  })

  it('management writes hot-reload the composite: the ws-auth flip is observable', async () => {
    const { runtime } = newRuntime({ configKv: makeFakeKv({ 'config.yaml': CONFIG_YAML_TEXT }) })
    // Before: ws-auth required -> plain GET 401.
    const before = await runtime.fetch(webRequest('GET', '/v1/ws'))
    expect(before.status).toBe(401)
    expect(await bodyText(before)).toBe('{"error":"Missing API key"}')
    // Flip ws-auth off through the management API.
    const flip = await runtime.fetch(
      webRequest(
        'PUT',
        '/v0/management/ws-auth',
        [['Authorization', `Bearer ${MGMT_KEY}`]],
        JSON.stringify({ value: false }),
      ),
    )
    expect(flip.status).toBe(200)
    expect(await bodyText(flip)).toBe('{"status":"ok"}')
    // After: the route is open - the gorilla 400 for non-upgrades.
    const after = await runtime.fetch(webRequest('GET', '/v1/ws'))
    expect(after.status).toBe(400)
    expect(await bodyText(after)).toBe('Bad Request\n')
    expect(after.headers.get('Sec-Websocket-Version')).toBe('13')
    // The write-back persisted the mutated text.
    const stored = String(await runtime.getStore().get(CONFIG_NAMESPACE, CONFIG_TEXT_KEY))
    expect(stored).toContain('ws-auth: false')
  })

  it('enabling ws-auth terminates live relay sockets with the owned close code', async () => {
    const { runtime, sockets } = newRuntime({ configKv: makeFakeKv({ 'config.yaml': CONFIG_YAML_TEXT }) })
    await runtime.fetch(webRequest('GET', '/healthz'))
    // Simulate one live hibernated relay session.
    const socket = makeFakeSocket()
    sockets.accept(socket as unknown as WebSocket, ['ws-relay'])
    // Disable, then re-enable ws-auth through the management API.
    await runtime.fetch(
      webRequest(
        'PUT',
        '/v0/management/ws-auth',
        [['Authorization', `Bearer ${MGMT_KEY}`]],
        JSON.stringify({ value: false }),
      ),
    )
    expect(socket.closedWith).toBeUndefined()
    await runtime.fetch(
      webRequest(
        'PUT',
        '/v0/management/ws-auth',
        [['Authorization', `Bearer ${MGMT_KEY}`]],
        JSON.stringify({ value: true }),
      ),
    )
    expect(socket.closedWith).toEqual({ code: 1008, reason: 'websocket auth required' })
  })

  it('serves the streaming direction smoke end-to-end through the object fetch', async () => {
    const { runtime } = newRuntime({
      configKv: makeFakeKv({ 'config.yaml': CONFIG_YAML_TEXT }),
      fetch: (() => {
        const fake: FetchLike = () =>
          Promise.resolve(
            new Response(CLAUDE_SSE, {
              status: 200,
              headers: { 'Content-Type': 'text/event-stream' },
            }),
          )
        return fake
      })(),
    })
    const response = await runtime.fetch(
      webRequest(
        'POST',
        '/v1/chat/completions',
        [['Authorization', `Bearer ${API_KEY}`]],
        JSON.stringify({
          model: 'claude-mock-model',
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
        }),
      ),
    )
    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain('"object":"chat.completion.chunk"')
    expect(body).toContain('Hello from mock claude upstream more')
    expect(response.headers.get('X-Cpa-Trace-Id')).toMatch(/^\d{14}-0-[0-9a-f]{8}$/)
  })
})

describe('durable object runtime: alarm pass', () => {
  it('runs the refresh pass against the stored credentials and re-arms', async () => {
    const { runtime, alarm } = newRuntime({
      configKv: makeFakeKv({ 'config.yaml': CONFIG_YAML_TEXT }),
      fetch: (() => {
        const fake: FetchLike = () =>
          Promise.resolve(
            new Response(
              JSON.stringify({ access_token: 'new-access', refresh_token: 'rt-2', expires_in: 3600 }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
          )
        return fake
      })(),
    })
    await runtime.fetch(webRequest('GET', '/healthz'))
    await runtime.getStore().put(AUTH_FILES_NAMESPACE, 'claude-a@ex.com.json', {
      type: 'claude',
      access_token: 'old-access',
      refresh_token: 'rt-1',
      expired: formatRfc3339(Date.now() + 60_000),
    })
    await runtime.alarm()
    const refreshed = (await runtime.getStore().get(AUTH_FILES_NAMESPACE, 'claude-a@ex.com.json')) as Record<
      string,
      unknown
    >
    expect(refreshed['access_token']).toBe('new-access')
    expect(alarm.armedAt.length).toBeGreaterThan(0)
  })
})
