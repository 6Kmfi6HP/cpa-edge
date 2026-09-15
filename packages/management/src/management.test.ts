
import { describe, expect, it } from 'vitest'
import { goJson, ordered, goJsonIndent, parseJsonGo, escapeGoString } from './gojson'
import { parseYamlDoc, blockToValue, YamlFileEditor, renderScalar, YamlError } from './yaml'
import { loadEffectiveConfig, configViewWire, normalizeStrategy, ConfigValidationError } from './config'
import { reEncodePrivateKey } from './vertex'
import { createManagementApi } from './api'
import { openUsageWireConnection, type UsageWireConnection } from './resp'
import { sidecarName, CooldownSidecars, COOLDOWN_NAMESPACE } from './cooldown'
import { popUsageRecords, USAGE_QUEUE, type UsageCompletion } from './usage'
import { AUTH_FILES_NAMESPACE } from './authfiles'
import { MemoryStore, type Store } from '@cpa-edge/core'

const SEED = `# comment line
host: ""
port: 8407
remote-management:
  allow-remote: true
  secret-key: "$2a$10$22ixgJLGCPJD6mqcT8In8uLtq7nvCHnP.I279ahVk.67DruCKA2Yy"
auth-dir: "/root/.cli-proxy-api"
api-keys:
  - "oracle-local-key-1"
debug: false
request-retry: 0
usage-statistics-enabled: false
`

describe('gojson marshal regimes', () => {
  it('sorts map keys and keeps struct order', () => {
    expect(goJson({ error: 'x', ok: true })).toBe('{"error":"x","ok":true}')
    expect(goJson(ordered([['b', 1], ['a', 2]]))).toBe('{"b":1,"a":2}')
  })

  it('escapes HTML characters like Go', () => {
    expect(escapeGoString('a<b>&c')).toBe('"a\\u003cb\\u003e\\u0026c"')
  })

  it('indents two spaces with sorted map keys', () => {
    expect(goJsonIndent({ b: 1, a: { c: 2 } })).toBe('{\n  "a": {\n    "c": 2\n  },\n  "b": 1\n}')
  })

  it('maps the recorded literal-null error', () => {
    const parsed = parseJsonGo('not json')
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.message).toBe("invalid character 'o' in literal null (expecting 'u')")
  })
})

describe('yaml subset', () => {
  it('parses the fleet config shape', () => {
    const value = blockToValue(parseYamlDoc(SEED)) as { [key: string]: unknown }
    expect(value['port']).toBe(8407)
    expect(value['api-keys']).toEqual(['oracle-local-key-1'])
    const remote = value['remote-management'] as { [key: string]: unknown }
    expect(remote['allow-remote']).toBe(true)
  })

  it('pins the recorded invalid_yaml message', () => {
    expect(() => parseYamlDoc(': :\n{{{not yaml')).toThrowError('yaml: did not find expected key')
    expect(() => parseYamlDoc('port: 8387\nbogus-open: {[}\n')).toThrowError(YamlError)
  })

  it('surgically updates scalars and preserves every untouched byte', () => {
    const editor = new YamlFileEditor(SEED)
    editor.setScalar([], 'usage-statistics-enabled', true)
    const text = editor.getText()
    expect(text).toContain('usage-statistics-enabled: true')
    expect(text.startsWith('# comment line\n')).toBe(true)
    expect(text).toContain('secret-key: "$2a$10$22ixgJLGCPJD6mqcT8In8uLtq7nvCHnP.I279ahVk.67DruCKA2Yy"')
  })

  it('appends missing keys at the end', () => {
    const editor = new YamlFileEditor(SEED)
    editor.setScalar([], 'logs-max-total-size-mb', 5)
    const text = editor.getText()
    expect(text.trimEnd().endsWith('logs-max-total-size-mb: 5')).toBe(true)
  })

  it('renders scalars bare when safe and quoted otherwise', () => {
    expect(renderScalar(true)).toBe('true')
    expect(renderScalar(5)).toBe('5')
    expect(renderScalar('us-central1')).toBe('us-central1')
    expect(renderScalar('')).toBe('""')
    expect(renderScalar('has: colon')).toBe('"has: colon"')
  })

  it('drops blank lines like the yaml round-trip', () => {
    const editor = new YamlFileEditor('a: 1\n\nb: 2\n')
    editor.dropBlankLines()
    editor.ensureTrailingNewline()
    expect(editor.getText()).toBe('a: 1\nb: 2\n')
  })
})

describe('config model', () => {
  it('validates weights with the index-scoped message', () => {
    expect(() =>
      loadEffectiveConfig('gemini-api-key:\n  - api-key: bad-weight\n    weight: 2000000\n'),
    ).toThrowError(ConfigValidationError)
    try {
      loadEffectiveConfig('gemini-api-key:\n  - api-key: bad-weight\n    weight: 2000000\n')
    } catch (error) {
      expect((error as ConfigValidationError).message).toBe('gemini-api-key[0].weight: weight must not exceed 1000000')
    }
  })

  it('rejects short stale-after windows (invalid_config family)', () => {
    expect(() =>
      loadEffectiveConfig('credential-in-flight:\n  snapshot-interval: 2s\n  stale-after: 1s\n'),
    ).toThrowError('credential-in-flight.stale-after must be at least three snapshot intervals')
  })

  it('normalizes routing strategies', () => {
    expect(normalizeStrategy('roundrobin')).toBe('round-robin')
    expect(normalizeStrategy('FF')).toBe('fill-first')
    expect(normalizeStrategy('wrr')).toBe('weighted-round-robin')
    expect(normalizeStrategy('bogus')).toBeUndefined()
  })

  it('emits the 47-key view in the recorded order', () => {
    const config = loadEffectiveConfig(SEED)
    const view = configViewWire(config)
    expect(view.members.map(([key]) => key)).toHaveLength(47)
    expect(view.members[0]?.[0]).toBe('proxy-url')
    expect(view.members[46]?.[0]).toBe('payload')
    const text = goJson(view)
    expect(text).not.toContain('"host"')
    expect(text).not.toContain('"remote-management"')
  })
})

describe('vertex pem normalization', () => {
  it('rejects non-pem keys with the recorded message', () => {
    expect(() => reEncodePrivateKey('fake')).toThrowError(
      'private_key is not valid pem: missing pem markers',
    )
  })

  it('round-trips a PKCS#8 key to PKCS#1', async () => {
    // Throwaway 512-bit RSA key generated for this test.
    const pem = await generateTestPem()
    const encoded = reEncodePrivateKey(pem)
    expect(encoded.startsWith('-----BEGIN RSA PRIVATE KEY-----')).toBe(true)
    expect(encoded.endsWith('-----END RSA PRIVATE KEY-----\n')).toBe(true)
  })
})

/** Generates a throwaway PKCS#8 RSA PEM via WebCrypto (runtime-neutral). */
async function generateTestPem(): Promise<string> {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 1024, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )
  const exported = await crypto.subtle.exportKey('pkcs8', pair.privateKey)
  const bytes = new Uint8Array(exported)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  const base64 = btoa(binary)
  const lines: string[] = []
  for (let i = 0; i < base64.length; i += 64) lines.push(base64.slice(i, i + 64))
  return `-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----\n`
}

describe('resp wire', () => {
  const encoder = new TextEncoder()

  async function drain(connection: ReturnType<typeof openUsageWireConnection>): Promise<string> {
    return new TextDecoder().decode(connection.takeOutput())
  }

  it('answers NOAUTH before authentication', async () => {
    const connection = openUsageWireConnection({
      verifyKey: async () => ({ ok: true as const }),
      popRecords: async () => [],
      popRecord: async () => undefined,
      subscribe: () => {},
      unsubscribe: () => {},
    })
    await connection.send(encoder.encode('*2\r\n$4\r\nLPOP\r\n$5\r\nusage\r\n'))
    expect(await drain(connection)).toBe('-NOAUTH Authentication required.\r\n')
    expect(connection.serverClosed()).toBe(false)
    connection.close()
  })

  it('answers protocol errors on declared-length mismatches', async () => {
    const connection = openUsageWireConnection({
      verifyKey: async () => ({ ok: false as const, message: 'invalid management key' }),
      popRecords: async () => [],
      popRecord: async () => undefined,
      subscribe: () => {},
      unsubscribe: () => {},
    })
    await connection.send(encoder.encode('*2\r\n$4\r\nAUTH\r\n$12\r\nwrong-key-123\r\n'))
    expect(await drain(connection)).toBe('-ERR protocol error\r\n')
    connection.close()
  })

  it('runs the recorded AUTH/LPOP/QUIT state machine', async () => {
    const connection = openUsageWireConnection({
      verifyKey: async (key) => key === 'k' ? { ok: true as const } : { ok: false as const, message: 'invalid management key' },
      popRecords: async () => ['{"a":1}'],
      popRecord: async () => '{"a":1}',
      subscribe: () => {},
      unsubscribe: () => {},
    })
    await connection.send(encoder.encode('*2\r\n$4\r\nAUTH\r\n$1\r\nk\r\n'))
    expect(await drain(connection)).toBe('+OK\r\n')
    await connection.send(encoder.encode('*3\r\n$4\r\nLPOP\r\n$5\r\nusage\r\n$2\r\n10\r\n'))
    expect(await drain(connection)).toBe('*1\r\n$7\r\n{"a":1}\r\n')
    await connection.send(encoder.encode('*1\r\n$4\r\nQUIT\r\n'))
    expect(await drain(connection)).toBe("-ERR unknown command 'quit'\r\n")
    expect(connection.serverClosed()).toBe(false)
    connection.close()
  })

  it('delivers the support_refresh payload on SUBSCRIBE usage', async () => {
    let delivered: ((payload: string) => void) | undefined
    const connection = openUsageWireConnection({
      verifyKey: async () => ({ ok: true as const }),
      popRecords: async () => [],
      popRecord: async () => undefined,
      subscribe: (_channel, deliver) => {
        delivered = deliver
      },
      unsubscribe: () => {},
    })
    await connection.send(encoder.encode('*2\r\n$4\r\nAUTH\r\n$1\r\nk\r\n'))
    void (await drain(connection))
    await connection.send(encoder.encode('*2\r\n$9\r\nSUBSCRIBE\r\n$5\r\nusage\r\n'))
    expect(await drain(connection)).toBe(
      '*3\r\n$9\r\nsubscribe\r\n$5\r\nusage\r\n:1\r\n*3\r\n$7\r\nmessage\r\n$5\r\nusage\r\n$24\r\n{"support_refresh":true}\r\n',
    )
    delivered?.('{"record":1}')
    expect(await drain(connection)).toBe('*3\r\n$7\r\nmessage\r\n$5\r\nusage\r\n$12\r\n{"record":1}\r\n')
    connection.close()
  })
})

describe('cooldown sidecars', () => {
  it('names sidecars with separators replaced', () => {
    expect(sidecarName('openai-compatibility:mock:abc')).toBe('openai-compatibility_mock_abc.cds')
  })

  it('merges records sorted by model and survives restart over one store', async () => {
    const now = { value: 1_000_000 }
    const store = new MemoryStore({ now: () => now.value })
    const sidecars = new CooldownSidecars(store, () => now.value)
    await sidecars.record({
      authId: 'openai-compatibility:mock-openai:484455246a84',
      provider: 'openai-compatible-mock-openai',
      status: 'cooling',
      nextRetryAfter: '2030-01-01T00:00:00Z',
      reason: 'rate limited',
      lastError: { message: 'rate limited', retryable: false, httpStatus: 500 },
    })
    await sidecars.record({
      authId: 'openai-compatibility:mock-openai:484455246a84',
      provider: 'openai-compatible-mock-openai',
      model: 'mock-model',
      status: 'cooling',
      nextRetryAfter: '2030-01-01T00:00:00Z',
      reason: 'rate limited',
      lastError: { message: 'rate limited', retryable: false, httpStatus: 500 },
    })
    const listed = await sidecars.list()
    expect(listed).toHaveLength(1)
    const parsed = JSON.parse(listed[0]?.content ?? '{}') as { records?: unknown[] }
    expect(parsed.records).toHaveLength(2)
    expect(listed[0]?.content.endsWith('\n')).toBe(true)
    const restarted = new CooldownSidecars(store, () => now.value)
    expect(await restarted.isCooling('openai-compatibility:mock-openai:484455246a84')).toBe(true)
    expect(await restarted.isCooling('openai-compatibility:mock-openai:484455246a84', 'mock-model')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Shared fixtures for the adapter-level regression tests
// ---------------------------------------------------------------------------

const MANAGEMENT_TEST_YAML = `host: ""
port: 8407
remote-management:
  allow-remote: true
  secret-key: "test-mgmt-key"
auth-dir: "/root/.cli-proxy-api"
api-keys:
  - "oracle-local-key-1"
debug: false
request-retry: 0
usage-statistics-enabled: false
redis-usage-queue-retention-seconds: 60
gemini-api-key:
  - api-key: "gem-key-1"
    base-url: "http://one.test"
  - api-key: "gem-key-2"
    base-url: "http://two.test"
openai-compatibility:
  - name: "mock-openai"
    base-url: "http://mock.test/v1"
    api-key-entries:
      - api-key: "mock-upstream-key"
    models:
      - name: "mock-gpt-model"
        alias: "mock-model"
`

const TEST_BUILD_INFO = { version: 'test', commit: 'test', buildDate: 'test', supportPlugin: false }
const MANAGEMENT_KEY = 'test-mgmt-key'

/** Frozen clock + fresh adapter + the Store it writes to. */
function createTestHarness(options: { configYaml?: string } = {}): {
  api: ReturnType<typeof createManagementApi>
  store: Store
  clock: { value: number }
} {
  const clock = { value: 1_770_000_000_000 }
  const store = new MemoryStore({ now: () => clock.value })
  const api = createManagementApi({
    configYaml: options.configYaml ?? MANAGEMENT_TEST_YAML,
    managementKey: MANAGEMENT_KEY,
    store,
    buildInfo: TEST_BUILD_INFO,
    now: () => clock.value,
    clientIp: '127.0.0.1',
  })
  return { api, store, clock }
}

function managementUrl(path: string, query = ''): string {
  return `http://management.test/v0/management${path}${query}`
}

/** One authenticated management call with a fully buffered body. */
function callApi(
  api: ReturnType<typeof createManagementApi>,
  method: string,
  path: string,
  options: { body?: string; query?: string } = {},
): Promise<Response> {
  const hasBody = options.body !== undefined
  return api.handle(new Request(managementUrl(path, options.query ?? ''), {
    method,
    headers: {
      authorization: `Bearer ${MANAGEMENT_KEY}`,
      ...(hasBody ? { 'content-type': 'application/json' } : {}),
    },
    body: options.body,
  }))
}

/** A request whose body parks mid-stream until `release()` fires. */
function gatedRequest(
  method: string,
  path: string,
  chunks: readonly string[],
): { request: Request; release: () => void } {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      void gate.then(() => controller.close())
    },
  })
  const request = new Request(managementUrl(path), {
    method,
    headers: { authorization: `Bearer ${MANAGEMENT_KEY}`, 'content-type': 'application/json' },
    body: stream,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' })
  return { request, release }
}

async function jsonOf(response: Response): Promise<Record<string, unknown>> {
  return JSON.parse(await response.text()) as Record<string, unknown>
}

/** Lets parked handlers reach their first await before the test continues. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/** Minimal completion record; every field the serializer requires is present. */
function usageCompletion(overrides: Partial<UsageCompletion> = {}): UsageCompletion {
  const base: UsageCompletion = {
    source: 'openai',
    authIndex: 'auth-index-1',
    clientIp: '127.0.0.1',
    xForwardedFor: '',
    userAgent: 'test-agent',
    requestId: 'req-1',
    sessionId: '0123456789abcdef0123456789abcdef',
    latencyMs: 5,
    ttftMs: 3,
    tokens: {
      inputTokens: 1,
      outputTokens: 1,
      reasoningTokens: 0,
      cachedTokens: 0,
      cacheReadTokens: 0,
      cacheReadTokensPresent: false,
      cacheCreationTokens: 0,
      totalTokens: 2,
    },
    accounting: {
      quality: 'standard',
      totalTokens: 2,
      inputTokens: { totalTokens: 1, uncachedTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      outputTokens: { totalTokens: 1, nonReasoningTokens: 1, reasoningTokens: 0 },
      unclassifiedTokens: 0,
    },
    generate: true,
    stream: false,
    downstreamStatus: 200,
    responseHeaders: [['content-type', 'application/json']],
    provider: 'test-provider',
    executorType: 'test-executor',
    model: 'test-model',
    alias: 'test-model',
    endpoint: '/v1/chat/completions',
    authType: 'api_key',
    apiKey: 'sk-test',
    reasoningEffort: 'none',
  }
  return { ...base, ...overrides }
}

/** RESP command frame with correct bulk lengths. */
function respCommand(...args: readonly string[]): Uint8Array {
  const encoder = new TextEncoder()
  let text = `*${args.length}\r\n`
  for (const arg of args) text += `$${encoder.encode(arg).length}\r\n${arg}\r\n`
  return encoder.encode(text)
}

async function drainWire(connection: UsageWireConnection): Promise<string> {
  return new TextDecoder().decode(connection.takeOutput())
}

/** Opens one authenticated management wire connection. */
async function openAuthedWire(api: ReturnType<typeof createManagementApi>): Promise<UsageWireConnection> {
  const connection = api.openUsageWire()
  await connection.send(respCommand('AUTH', MANAGEMENT_KEY))
  expect(await drainWire(connection)).toBe('+OK\r\n')
  return connection
}

/** A recordCooldown payload shaped like the S6-16 recording. */
function cooldownInput(overrides: { authId?: string; model?: string } = {}): {
  authId: string
  provider: string
  model?: string
  status: string
  nextRetryAfter: string
  reason: string
  lastError: { message: string; retryable: boolean; httpStatus: number }
} {
  return {
    authId: overrides.authId ?? 'test:auth:1',
    provider: 'test-provider',
    model: overrides.model,
    status: 'cooling',
    nextRetryAfter: '2030-01-01T00:00:00Z',
    reason: 'rate limited',
    lastError: { message: 'rate limited', retryable: false, httpStatus: 500 },
  }
}

/** One multipart body with the curl-style CRLF framing the parser expects. */
function multipartBody(
  boundary: string,
  parts: ReadonlyArray<{ name?: string; filename?: string; value: string }>,
): string {
  const chunks: string[] = []
  for (const part of parts) {
    const name = part.name ?? 'file'
    chunks.push(`--${boundary}\r\n`)
    chunks.push(
      part.filename === undefined
        ? `Content-Disposition: form-data; name="${name}"\r\n`
        : `Content-Disposition: form-data; name="${name}"; filename="${part.filename}"\r\n`,
    )
    chunks.push('\r\n')
    chunks.push(part.value)
    chunks.push('\r\n')
  }
  chunks.push(`--${boundary}--\r\n`)
  return chunks.join('')
}

function multipartRequest(boundary: string, parts: ReadonlyArray<{ name?: string; filename?: string; value: string }>): Request {
  return new Request(managementUrl('/auth-files'), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${MANAGEMENT_KEY}`,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    body: multipartBody(boundary, parts),
  })
}

// ---------------------------------------------------------------------------
// B1: provider-list mutations must not race a stale entry snapshot
// ---------------------------------------------------------------------------

describe('provider list mutation races', () => {
  it('keeps both changes when a slow-body PATCH races a fast PATCH', async () => {
    const { api } = createTestHarness()
    const slow = gatedRequest('PATCH', '/gemini-api-key', [
      '{"index":1,"val',
      'ue":{"base-url":"http://slow.test"}}',
    ])
    const slowCall = api.handle(slow.request)
    await settle()
    const fast = await callApi(api, 'PATCH', '/gemini-api-key', {
      body: '{"index":0,"value":{"base-url":"http://fast.test"}}',
    })
    expect(fast.status).toBe(200)
    slow.release()
    const slowResponse = await slowCall
    expect(slowResponse.status).toBe(200)

    const list = (await jsonOf(await callApi(api, 'GET', '/gemini-api-key'))) as {
      'gemini-api-key'?: ReadonlyArray<{ 'api-key'?: string; 'base-url'?: string }>
    }
    const entries = list['gemini-api-key'] ?? []
    expect(entries).toHaveLength(2)
    expect(entries[0]?.['base-url']).toBe('http://fast.test')
    expect(entries[1]?.['base-url']).toBe('http://slow.test')
    const yaml = await api.readConfigFile()
    expect(yaml).toContain('http://fast.test')
    expect(yaml).toContain('http://slow.test')
  })

  it('does not resurrect a deleted entry when a slow PATCH races a DELETE of another entry', async () => {
    const { api } = createTestHarness()
    const slow = gatedRequest('PATCH', '/gemini-api-key', [
      '{"match":"gem-key-1","value":{"base-url":"http://slow.test"}}',
    ])
    const slowCall = api.handle(slow.request)
    await settle()
    const removed = await callApi(api, 'DELETE', '/gemini-api-key', { query: '?api-key=gem-key-2' })
    expect(removed.status).toBe(200)
    slow.release()
    const slowResponse = await slowCall
    expect(slowResponse.status).toBe(200)

    const list = (await jsonOf(await callApi(api, 'GET', '/gemini-api-key'))) as {
      'gemini-api-key'?: ReadonlyArray<{ 'api-key'?: string; 'base-url'?: string }>
    }
    const entries = list['gemini-api-key'] ?? []
    expect(entries).toHaveLength(1)
    expect(entries[0]?.['api-key']).toBe('gem-key-1')
    expect(entries[0]?.['base-url']).toBe('http://slow.test')
  })

  it('answers 404 when a slow PATCH targets an entry a racing DELETE removed', async () => {
    const { api } = createTestHarness()
    const slow = gatedRequest('PATCH', '/gemini-api-key', [
      '{"match":"gem-key-1","value":{"base-url":"http://slow.test"}}',
    ])
    const slowCall = api.handle(slow.request)
    await settle()
    const removed = await callApi(api, 'DELETE', '/gemini-api-key', { query: '?api-key=gem-key-1' })
    expect(removed.status).toBe(200)
    slow.release()
    const slowResponse = await slowCall
    expect(slowResponse.status).toBe(404)
    expect(await jsonOf(slowResponse)).toEqual({ error: 'item not found' })

    const list = (await jsonOf(await callApi(api, 'GET', '/gemini-api-key'))) as {
      'gemini-api-key'?: ReadonlyArray<{ 'api-key'?: string }>
    }
    expect((list['gemini-api-key'] ?? []).map((entry) => entry['api-key'])).toEqual(['gem-key-2'])
  })

  it('does not resurrect an openai-compatibility entry deleted while a slow name PATCH pended', async () => {
    const { api } = createTestHarness()
    const slow = gatedRequest('PATCH', '/openai-compatibility', [
      '{"name":"mock-openai","value":{"disabled":true}}',
    ])
    const slowCall = api.handle(slow.request)
    await settle()
    const removed = await callApi(api, 'DELETE', '/openai-compatibility', { query: '?name=mock-openai' })
    expect(removed.status).toBe(200)
    slow.release()
    const slowResponse = await slowCall
    expect(slowResponse.status).toBe(404)

    const list = (await jsonOf(await callApi(api, 'GET', '/openai-compatibility'))) as {
      'openai-compatibility'?: ReadonlyArray<{ name?: string }>
    }
    expect(list['openai-compatibility'] ?? []).toHaveLength(0)
  })

  it('keeps an authoritative PUT list when a slow PATCH races it', async () => {
    const { api } = createTestHarness()
    const slow = gatedRequest('PATCH', '/gemini-api-key', [
      '{"match":"gem-key-1","value":{"base-url":"http://slow.test"}}',
    ])
    const slowCall = api.handle(slow.request)
    await settle()
    const replaced = await callApi(api, 'PUT', '/gemini-api-key', {
      body: '[{"api-key":"gem-key-9","base-url":"http://put.test"}]',
    })
    expect(replaced.status).toBe(200)
    slow.release()
    const slowResponse = await slowCall
    expect(slowResponse.status).toBe(404)

    const list = (await jsonOf(await callApi(api, 'GET', '/gemini-api-key'))) as {
      'gemini-api-key'?: ReadonlyArray<{ 'api-key'?: string; 'base-url'?: string }>
    }
    const entries = list['gemini-api-key'] ?? []
    expect(entries).toHaveLength(1)
    expect(entries[0]?.['api-key']).toBe('gem-key-9')
    expect(entries[0]?.['base-url']).toBe('http://put.test')
  })
})

// ---------------------------------------------------------------------------
// B2: the consumer loop must enforce the queue retention window
// ---------------------------------------------------------------------------

describe('usage queue retention', () => {
  const clock = 1_770_000_000_000

  it('drops a 2h-old record at retention 60s, delivers the fresh one, and drains the queue', async () => {
    const store = new MemoryStore({ now: () => clock })
    const stale = JSON.stringify({ timestamp: new Date(clock - 2 * 60 * 60 * 1000).toISOString(), model: 'stale' })
    const fresh = JSON.stringify({ timestamp: new Date(clock - 1_000).toISOString(), model: 'fresh' })
    await store.enqueue(USAGE_QUEUE, stale)
    await store.enqueue(USAGE_QUEUE, fresh)
    const popped = await popUsageRecords(store, 5, { seconds: 60, now: () => clock })
    expect(popped).toEqual([fresh])
    expect(await popUsageRecords(store, 5, { seconds: 60, now: () => clock })).toEqual([])
  })

  it('keeps delivering every record when no retention window is given', async () => {
    const store = new MemoryStore({ now: () => clock })
    const stale = JSON.stringify({ timestamp: new Date(clock - 2 * 60 * 60 * 1000).toISOString(), model: 'stale' })
    const fresh = JSON.stringify({ timestamp: new Date(clock - 1_000).toISOString(), model: 'fresh' })
    await store.enqueue(USAGE_QUEUE, stale)
    await store.enqueue(USAGE_QUEUE, fresh)
    const popped = await popUsageRecords(store, 5)
    expect(popped).toEqual([stale, fresh])
  })

  it('treats missing or unparsable stamps as fresh and keeps the window boundary inclusive', async () => {
    const store = new MemoryStore({ now: () => clock })
    const noStamp = JSON.stringify({ model: 'no-stamp' })
    const badStamp = JSON.stringify({ timestamp: 'not-a-date', model: 'bad-stamp' })
    const boundary = JSON.stringify({ timestamp: new Date(clock - 60_000).toISOString(), model: 'boundary' })
    await store.enqueue(USAGE_QUEUE, noStamp)
    await store.enqueue(USAGE_QUEUE, badStamp)
    await store.enqueue(USAGE_QUEUE, boundary)
    const popped = await popUsageRecords(store, 10, { seconds: 60, now: () => clock })
    expect(popped).toEqual([noStamp, badStamp, boundary])
  })

  it('serves only fresh records through the HTTP usage-queue endpoint', async () => {
    const { api, store, clock: harnessClock } = createTestHarness()
    await store.enqueue(USAGE_QUEUE, JSON.stringify({
      timestamp: new Date(harnessClock.value - 2 * 60 * 60 * 1000).toISOString(),
      model: 'stale',
    }))
    const empty = await callApi(api, 'GET', '/usage-queue')
    expect(empty.status).toBe(200)
    expect(JSON.parse(await empty.text())).toEqual([])

    await api.recordUsage(usageCompletion({ model: 'fresh-model' }))
    const served = await callApi(api, 'GET', '/usage-queue', { query: '?count=5' })
    expect(served.status).toBe(200)
    const records = JSON.parse(await served.text()) as unknown[]
    expect(records).toHaveLength(1)
    expect((records[0] as { model?: string }).model).toBe('fresh-model')
  })

  it('skips stale records on the RESP LPOP path too', async () => {
    const { api, store, clock: harnessClock } = createTestHarness()
    await store.enqueue(USAGE_QUEUE, JSON.stringify({
      timestamp: new Date(harnessClock.value - 2 * 60 * 60 * 1000).toISOString(),
      model: 'stale',
    }))
    const connection = await openAuthedWire(api)
    await connection.send(respCommand('LPOP', 'usage'))
    expect(await drainWire(connection)).toBe('$-1\r\n')
    connection.close()
  })
})

// ---------------------------------------------------------------------------
// B3: unsubscribe must remove only the closing connection's subscription
// ---------------------------------------------------------------------------

describe('usage wire subscription identity', () => {
  it('keeps one subscriber live after the other connection closes', async () => {
    const { api, store } = createTestHarness()
    const first = await openAuthedWire(api)
    const second = await openAuthedWire(api)
    await first.send(respCommand('SUBSCRIBE', 'usage'))
    void (await drainWire(first))
    await second.send(respCommand('SUBSCRIBE', 'usage'))
    void (await drainWire(second))

    await api.recordUsage(usageCompletion({ model: 'm-one' }))
    expect(await drainWire(first)).toContain('"model":"m-one"')
    expect(await drainWire(second)).toContain('"model":"m-one"')

    first.close()
    await api.recordUsage(usageCompletion({ model: 'm-two' }))
    expect(await drainWire(second)).toContain('"model":"m-two"')
    expect(await store.claim(USAGE_QUEUE, 30_000)).toBeUndefined()
    second.close()
  })

  it('keeps the other subscriber after an explicit UNSUBSCRIBE on one connection', async () => {
    const { api } = createTestHarness()
    const first = await openAuthedWire(api)
    const second = await openAuthedWire(api)
    await first.send(respCommand('SUBSCRIBE', 'usage'))
    void (await drainWire(first))
    await second.send(respCommand('SUBSCRIBE', 'usage'))
    void (await drainWire(second))

    await first.send(respCommand('UNSUBSCRIBE', 'usage'))
    expect(await drainWire(first)).toBe('*3\r\n$11\r\nunsubscribe\r\n$5\r\nusage\r\n:0\r\n')
    expect(first.serverClosed()).toBe(true)

    await api.recordUsage(usageCompletion({ model: 'm-still-live' }))
    expect(await drainWire(second)).toContain('"model":"m-still-live"')
    second.close()
  })

  it('keeps the other errors subscriber live after one closes', async () => {
    const { api } = createTestHarness()
    const first = await openAuthedWire(api)
    const second = await openAuthedWire(api)
    await first.send(respCommand('SUBSCRIBE', 'errors'))
    void (await drainWire(first))
    await second.send(respCommand('SUBSCRIBE', 'errors'))
    void (await drainWire(second))

    await api.publishError({
      provider: 'test-provider',
      model: 'test-model',
      authId: 'test:auth:1',
      authIndex: 'auth-index-1',
      statusCode: 500,
      body: 'boom',
    })
    expect(await drainWire(first)).toContain('"provider":"test-provider"')
    expect(await drainWire(second)).toContain('"provider":"test-provider"')

    first.close()
    await api.publishError({
      provider: 'test-provider',
      model: 'test-model',
      authId: 'test:auth:1',
      authIndex: 'auth-index-1',
      statusCode: 500,
      body: 'boom-again',
    })
    expect(await drainWire(second)).toContain('"body":"boom-again"')
    second.close()
  })

  it('returns records to the queue once the last subscriber is gone', async () => {
    const { api, store } = createTestHarness()
    const only = await openAuthedWire(api)
    await only.send(respCommand('SUBSCRIBE', 'usage'))
    void (await drainWire(only))
    only.close()

    await api.recordUsage(usageCompletion({ model: 'm-queued' }))
    const claim = await store.claim(USAGE_QUEUE, 30_000)
    expect(claim).toBeDefined()
    expect(String(claim?.payload)).toContain('"model":"m-queued"')
  })
})

// ---------------------------------------------------------------------------
// B4: concurrent cooldown recordings must merge, not clobber
// ---------------------------------------------------------------------------

describe('cooldown sidecar concurrency', () => {
  it('keeps all three records from concurrent record calls for one auth', async () => {
    const stamp = 1_000_000
    const store = new MemoryStore({ now: () => stamp })
    const sidecars = new CooldownSidecars(store, () => stamp)
    await Promise.all([
      sidecars.record(cooldownInput({ model: 'model-b' })),
      sidecars.record(cooldownInput({ model: 'model-a' })),
      sidecars.record(cooldownInput({ model: 'model-c' })),
    ])
    const listed = await sidecars.list()
    expect(listed).toHaveLength(1)
    const parsed = JSON.parse(listed[0]?.content ?? '{}') as { records?: ReadonlyArray<{ model?: string }> }
    expect(parsed.records?.map((record) => record.model)).toEqual(['model-a', 'model-b', 'model-c'])
    for (const model of ['model-a', 'model-b', 'model-c']) {
      expect(await sidecars.isCooling('test:auth:1', model)).toBe(true)
    }
  })

  it('keeps one sidecar per auth for concurrent recordings of different auths', async () => {
    const stamp = 1_000_000
    const store = new MemoryStore({ now: () => stamp })
    const sidecars = new CooldownSidecars(store, () => stamp)
    await Promise.all([
      sidecars.record(cooldownInput({ authId: 'test:auth:1', model: 'model-a' })),
      sidecars.record(cooldownInput({ authId: 'test:auth:2', model: 'model-b' })),
    ])
    const listed = await sidecars.list()
    expect(listed.map((entry) => entry.authId).sort()).toEqual(['test:auth:1', 'test:auth:2'])
  })
})

// ---------------------------------------------------------------------------
// B5: a slow subscriber is dropped at 256 buffered records, queue untouched
// ---------------------------------------------------------------------------

describe('slow-subscriber cap', () => {
  function subscribedConnection(): {
    connection: ReturnType<typeof openUsageWireConnection>
    sink: () => ((payload: string) => void) | undefined
    unsubscribed: Array<'usage' | 'errors'>
  } {
    let sink: ((payload: string) => void) | undefined
    const unsubscribed: Array<'usage' | 'errors'> = []
    const connection = openUsageWireConnection({
      verifyKey: async () => ({ ok: true as const }),
      popRecords: async () => [],
      popRecord: async () => undefined,
      subscribe: (_channel, deliver) => {
        sink = deliver
      },
      unsubscribe: (channel, deliver) => {
        expect(deliver === sink).toBe(true)
        unsubscribed.push(channel)
      },
    })
    return { connection, sink: () => sink, unsubscribed }
  }

  async function subscribeUnit(connection: ReturnType<typeof openUsageWireConnection>): Promise<void> {
    await connection.send(respCommand('AUTH', 'unit-key'))
    void connection.takeOutput()
    await connection.send(respCommand('SUBSCRIBE', 'usage'))
    void connection.takeOutput()
  }

  it('drops and closes the connection on the 257th undrained record', async () => {
    const { connection, sink, unsubscribed } = subscribedConnection()
    await subscribeUnit(connection)
    for (let i = 0; i < 256; i += 1) sink()?.(`{"i":${i}}`)
    expect(connection.serverClosed()).toBe(false)
    sink()?.('{"i":256}')
    expect(connection.serverClosed()).toBe(true)
    expect(unsubscribed).toEqual(['usage'])
    connection.close()
  })

  it('resets the buffered-record count when the subscriber drains', async () => {
    const { connection, sink } = subscribedConnection()
    await subscribeUnit(connection)
    for (let i = 0; i < 256; i += 1) sink()?.(`{"batch":1,"i":${i}}`)
    void connection.takeOutput()
    for (let i = 0; i < 256; i += 1) sink()?.(`{"batch":2,"i":${i}}`)
    expect(connection.serverClosed()).toBe(false)
    sink()?.('{"batch":2,"i":256}')
    expect(connection.serverClosed()).toBe(true)
    connection.close()
  })

  it('caps errors-channel subscribers the same way', async () => {
    let sink: ((payload: string) => void) | undefined
    const unsubscribed: string[] = []
    const connection = openUsageWireConnection({
      verifyKey: async () => ({ ok: true as const }),
      popRecords: async () => [],
      popRecord: async () => undefined,
      subscribe: (_channel, deliver) => {
        sink = deliver
      },
      unsubscribe: (channel) => {
        unsubscribed.push(channel)
      },
    })
    await connection.send(respCommand('AUTH', 'unit-key'))
    void connection.takeOutput()
    await connection.send(respCommand('SUBSCRIBE', 'errors'))
    void connection.takeOutput()
    for (let i = 0; i < 256; i += 1) sink?.(`{"i":${i}}`)
    expect(connection.serverClosed()).toBe(false)
    sink?.('{"i":256}')
    expect(connection.serverClosed()).toBe(true)
    expect(unsubscribed).toEqual(['errors'])
    connection.close()
  })

  it('leaves the queue untouched by the flood and queues records after the drop', async () => {
    const { api, store, clock } = createTestHarness()
    await store.enqueue(USAGE_QUEUE, JSON.stringify({
      timestamp: new Date(clock.value).toISOString(),
      marker: 'pre-seeded',
    }))
    const slowSubscriber = await openAuthedWire(api)
    await slowSubscriber.send(respCommand('SUBSCRIBE', 'usage'))
    void (await drainWire(slowSubscriber))

    for (let i = 0; i < 256; i += 1) {
      await api.recordUsage(usageCompletion({ model: `m${i}` }))
    }
    expect(slowSubscriber.serverClosed()).toBe(false)
    await api.recordUsage(usageCompletion({ model: 'm256' }))
    expect(slowSubscriber.serverClosed()).toBe(true)
    for (let i = 257; i < 300; i += 1) {
      await api.recordUsage(usageCompletion({ model: `m${i}` }))
    }
    await api.recordUsage(usageCompletion({ model: 'after-drop' }))

    const first = await store.claim(USAGE_QUEUE, 30_000)
    if (first === undefined) throw new Error('pre-seeded record vanished from the queue')
    expect(String(first.payload)).toContain('pre-seeded')
    await store.ack(USAGE_QUEUE, first)
    let drained = 0
    for (;;) {
      const claim = await store.claim(USAGE_QUEUE, 30_000)
      if (claim === undefined) break
      await store.ack(USAGE_QUEUE, claim)
      drained += 1
    }
    // 43 post-drop flood records plus the record recorded after the drop.
    expect(drained).toBe(44)
  })
})

// ---------------------------------------------------------------------------
// N1: multipart upload filenames face the same validity rule as ?name=
// ---------------------------------------------------------------------------

describe('multipart upload filename validation', () => {
  it('rejects a traversal filename with 400 invalid name and stores nothing', async () => {
    const { api, store } = createTestHarness()
    const response = await api.handle(multipartRequest('test-boundary', [
      { filename: '../traversal.json', value: '{"type":"gemini"}' },
    ]))
    expect(response.status).toBe(400)
    expect(await jsonOf(response)).toEqual({ error: 'invalid name' })
    expect(await store.list(AUTH_FILES_NAMESPACE)).toEqual([])
  })

  it('rejects a backslash traversal filename', async () => {
    const { api } = createTestHarness()
    const response = await api.handle(multipartRequest('test-boundary', [
      { filename: '..\\evil.json', value: '{"type":"gemini"}' },
    ]))
    expect(response.status).toBe(400)
    expect(await jsonOf(response)).toEqual({ error: 'invalid name' })
  })

  it('reports the invalid name per-file in a partial multi-file upload', async () => {
    const { api, store } = createTestHarness()
    const response = await api.handle(multipartRequest('test-boundary', [
      { filename: 'good.json', value: '{"type":"gemini"}' },
      { filename: '../bad.json', value: '{}' },
    ]))
    expect(response.status).toBe(207)
    const body = (await jsonOf(response)) as {
      status?: string
      uploaded?: number
      files?: string[]
      failed?: ReadonlyArray<{ name?: string; error?: string }>
    }
    expect(body.status).toBe('partial')
    expect(body.uploaded).toBe(1)
    expect(body.files).toEqual(['good.json'])
    expect(body.failed).toEqual([{ name: '../bad.json', error: 'invalid name' }])
    expect(await store.list(AUTH_FILES_NAMESPACE)).toEqual(['good.json'])
  })

  it('still rejects non-json filenames with the recorded message', async () => {
    const { api } = createTestHarness()
    const response = await api.handle(multipartRequest('test-boundary', [
      { filename: 'notes.txt', value: 'plain text' },
    ]))
    expect(response.status).toBe(400)
    expect(await jsonOf(response)).toEqual({ error: 'file must be .json' })
  })

  it('keeps rejecting traversal names on the query-string upload path', async () => {
    const { api } = createTestHarness()
    const response = await callApi(api, 'POST', '/auth-files', {
      query: '?name=../traversal.json',
      body: '{"type":"gemini"}',
    })
    expect(response.status).toBe(400)
    expect(await jsonOf(response)).toEqual({ error: 'invalid name' })
  })
})

// ---------------------------------------------------------------------------
// N2: stale .cds sidecars of vanished auths are removed on save
// ---------------------------------------------------------------------------

describe('cooldown sidecar pruning', () => {
  it('deletes the sidecar of a vanished auth on the next save', async () => {
    const stamp = 1_000_000
    const store = new MemoryStore({ now: () => stamp })
    const sidecars = new CooldownSidecars(store, () => stamp, {
      liveAuthIds: async () => new Set(['live:auth:1']),
    })
    await sidecars.record(cooldownInput({ authId: 'ghost:auth:gone' }))
    expect(await sidecars.list()).toHaveLength(1)

    await sidecars.record(cooldownInput({ authId: 'live:auth:1' }))
    const listed = await sidecars.list()
    expect(listed).toHaveLength(1)
    expect(listed[0]?.authId).toBe('live:auth:1')
    expect(await store.list(COOLDOWN_NAMESPACE)).toEqual([sidecarName('live:auth:1')])
    expect(await sidecars.isCooling('ghost:auth:gone')).toBe(false)
  })

  it('prunes nothing when no live-auth view is wired', async () => {
    const stamp = 1_000_000
    const store = new MemoryStore({ now: () => stamp })
    const sidecars = new CooldownSidecars(store, () => stamp)
    await sidecars.record(cooldownInput({ authId: 'ghost:auth:gone' }))
    await sidecars.record(cooldownInput({ authId: 'live:auth:1' }))
    expect(await sidecars.list()).toHaveLength(2)
  })

  it('prunes vanished-auth sidecars through the adapter wiring', async () => {
    const { api, store } = createTestHarness()
    const list = (await jsonOf(await callApi(api, 'GET', '/gemini-api-key'))) as {
      'gemini-api-key'?: ReadonlyArray<{ 'auth-index'?: unknown }>
    }
    const liveId = list['gemini-api-key']?.[0]?.['auth-index']
    if (typeof liveId !== 'string') throw new Error('gemini list must carry an auth-index')

    await api.recordCooldown(cooldownInput({ authId: 'vanished:auth:dead' }))
    expect(await store.list(COOLDOWN_NAMESPACE)).toEqual([sidecarName('vanished:auth:dead')])

    await api.recordCooldown(cooldownInput({ authId: liveId }))
    const sidecars = await api.listCooldownSidecars()
    expect(sidecars).toHaveLength(1)
    expect(sidecars[0]?.authId).toBe(liveId)
    expect(await api.isCooling('vanished:auth:dead')).toBe(false)
  })
})
