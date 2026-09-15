
import { describe, expect, it } from 'vitest'
import { goJson, ordered, goJsonIndent, parseJsonGo, escapeGoString } from './gojson'
import { parseYamlDoc, blockToValue, YamlFileEditor, renderScalar, YamlError } from './yaml'
import { loadEffectiveConfig, configViewWire, normalizeStrategy, ConfigValidationError } from './config'
import { reEncodePrivateKey } from './vertex'
import { openUsageWireConnection } from './resp'
import { sidecarName, CooldownSidecars } from './cooldown'
import { MemoryStore } from '@cpa-edge/core'

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
      verifyKey: async () => true,
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
      verifyKey: async () => false,
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
      verifyKey: async (key) => key === 'k',
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
      verifyKey: async () => true,
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
