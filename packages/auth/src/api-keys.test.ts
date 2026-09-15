import { describe, expect, it } from 'vitest'
import {
  authenticateClientRequest,
  detectSafeMode,
  extractBearerToken,
  extractCredentialCandidates,
  INVALID_API_KEY_BODY,
  MISSING_API_KEY_BODY,
  normalizeApiKeys,
  SAFE_MODE_PROXY_BODY,
  safeModePageHtml,
  TEMPLATE_API_KEYS,
} from './api-keys'

const URL_V1 = 'http://127.0.0.1:8387/v1/models'

describe('extractBearerToken', () => {
  it('splits on the first space with a case-insensitive Bearer', () => {
    expect(extractBearerToken('Bearer tok-1')).toBe('tok-1')
    expect(extractBearerToken('bearer tok-1')).toBe('tok-1')
    expect(extractBearerToken('BEARER  tok-1')).toBe('tok-1')
  })

  it('returns the whole value when it is not Bearer-form', () => {
    expect(extractBearerToken('raw-key-1')).toBe('raw-key-1')
    expect(extractBearerToken('Basic abc')).toBe('Basic abc')
  })
})

describe('credential candidate extraction order', () => {
  it('collects the five sources in precedence order', () => {
    const candidates = extractCredentialCandidates(
      {
        authorization: 'Bearer k1',
        'x-goog-api-key': 'k2',
        'x-api-key': 'k3',
      },
      'http://h/v1/models?key=k4&auth_token=k5',
    )
    expect(candidates).toEqual([
      { source: 'authorization', value: 'k1' },
      { source: 'x-goog-api-key', value: 'k2' },
      { source: 'x-api-key', value: 'k3' },
      { source: 'query-key', value: 'k4' },
      { source: 'query-auth_token', value: 'k5' },
    ])
  })

  it('treats a non-Bearer Authorization value as the raw candidate', () => {
    const candidates = extractCredentialCandidates({ authorization: 'raw-key-1' }, URL_V1)
    expect(candidates).toEqual([{ source: 'authorization', value: 'raw-key-1' }])
  })
})

describe('normalizeApiKeys', () => {
  it('trims, drops empties and dedupes', () => {
    expect(normalizeApiKeys([' a ', '', 'a', 'b'])).toEqual(['a', 'b'])
  })
})

describe('authenticateClientRequest (S3 §2.1 accept matrix)', () => {
  const keys = ['oracle-local-key-1']

  it('answers Missing API key when no credential is present anywhere', () => {
    const result = authenticateClientRequest({ apiKeys: keys, headers: {}, url: URL_V1 })
    expect(result).toEqual({ ok: false, status: 401, body: MISSING_API_KEY_BODY })
    expect(MISSING_API_KEY_BODY).toBe('{"error":"Missing API key"}')
  })

  it('answers Invalid API key when a candidate matches nothing', () => {
    const result = authenticateClientRequest({
      apiKeys: keys,
      headers: { authorization: 'Bearer wrong-key-000' },
      url: URL_V1,
    })
    expect(result).toEqual({ ok: false, status: 401, body: INVALID_API_KEY_BODY })
    expect(INVALID_API_KEY_BODY).toBe('{"error":"Invalid API key"}')
  })

  it('accepts each of the five sources', () => {
    const cases: ReadonlyArray<readonly [{ authorization?: string; 'x-goog-api-key'?: string; 'x-api-key'?: string }, string]> = [
      [{ authorization: 'Bearer oracle-local-key-1' }, URL_V1],
      [{ authorization: 'oracle-local-key-1' }, URL_V1],
      [{ 'x-goog-api-key': 'oracle-local-key-1' }, URL_V1],
      [{ 'x-api-key': 'oracle-local-key-1' }, URL_V1],
      [{}, 'http://h/v1/models?key=oracle-local-key-1'],
      [{}, 'http://h/v1/models?auth_token=oracle-local-key-1'],
    ]
    for (const [headers, url] of cases) {
      const result = authenticateClientRequest({ apiKeys: keys, headers, url })
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.open).toBe(false)
    }
  })

  it('falls through an invalid Bearer to a matching X-Api-Key', () => {
    const result = authenticateClientRequest({
      apiKeys: keys,
      headers: { authorization: 'Bearer wrong', 'x-api-key': 'oracle-local-key-1' },
      url: URL_V1,
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.source).toBe('x-api-key')
  })

  it('allows every request when the normalized key set is empty (open mode)', () => {
    const result = authenticateClientRequest({ apiKeys: ['  ', ''], headers: {}, url: URL_V1 })
    expect(result).toEqual({ ok: true, open: true, apiKey: '', source: '' })
  })
})

describe('example-key safe mode (§2.1)', () => {
  it('activates on any configured template value', () => {
    expect(detectSafeMode(['your-api-key-1']).active).toBe(true)
    expect(detectSafeMode(['real', 'your-api-key-2']).keys).toEqual(['your-api-key-2'])
    expect(detectSafeMode(['real']).active).toBe(false)
    expect(TEMPLATE_API_KEYS).toContain('your-api-key-3')
  })

  it('answers the recorded 403 body with the safe-mode header', () => {
    const result = authenticateClientRequest({
      apiKeys: ['your-api-key-1'],
      headers: { authorization: 'Bearer your-api-key-1' },
      url: URL_V1,
    })
    expect(result).toEqual({
      ok: false,
      status: 403,
      body: SAFE_MODE_PROXY_BODY,
      headers: { 'X-Cpa-Safe-Mode': 'example-api-key' },
    })
    expect(new TextEncoder().encode(SAFE_MODE_PROXY_BODY).length).toBe(208)
    expect(SAFE_MODE_PROXY_BODY).toBe(
      '{"error":"unsafe_example_api_key","message":"Proxy API endpoints are disabled because api-keys contains template values. Open /management.html?safe-mode=configure, update api-keys in Management, then retry."}',
    )
  })

  it('builds the warning page with one list item per offending key', () => {
    const html = safeModePageHtml(['your-api-key-1'])
    expect(html).toContain('<ul class="keys"><li><code>your-api-key-1</code></li></ul>')
    expect(html).toContain('href="/management.html?safe-mode=configure"')
    expect(html.startsWith('<!doctype html>')).toBe(true)
  })
})


describe('safe-mode detection against normalized keys (§2.1 regression)', () => {
  it('trips on padded template values, matching credential normalization', () => {
    expect(detectSafeMode([' your-api-key-1 ']).active).toBe(true)
    expect(detectSafeMode([' your-api-key-1 ']).keys).toEqual(['your-api-key-1'])
    expect(detectSafeMode(['your-api-key-2  ', 'real']).keys).toEqual(['your-api-key-2'])
    expect(detectSafeMode([' real-key ']).active).toBe(false)
  })

  it('seals the proxy surface through the full request path for padded keys', () => {
    const result = authenticateClientRequest({
      apiKeys: [' your-api-key-1 '],
      headers: { authorization: 'Bearer your-api-key-1' },
      url: URL_V1,
    })
    expect(result).toEqual({
      ok: false,
      status: 403,
      body: SAFE_MODE_PROXY_BODY,
      headers: { 'X-Cpa-Safe-Mode': 'example-api-key' },
    })
  })
})
