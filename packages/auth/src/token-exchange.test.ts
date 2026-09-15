import { describe, expect, it } from 'vitest'
import { MemoryStore } from '@cpa-edge/core'
import {
  buildKimiCredential,
  buildMetaCredential,
  buildXaiCredential,
  exchangeAntigravityCode,
  exchangeClaudeCode,
  exchangeCodexCode,
  exchangeDevinCode,
  runCodeLoginWaiter,
  splitCodeState,
} from './token-exchange'
import { OAuthSessionRegistry } from './oauth-sessions'
import type { FetchLike } from './types'

function b64urlJson(payload: Record<string, unknown>): string {
  const text = JSON.stringify(payload)
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function jwt(payload: Record<string, unknown>): string {
  const header = b64urlJson({ alg: 'HS256', typ: 'JWT' })
  return `${header}.${b64urlJson(payload)}.signature`
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status })
}

describe('splitCodeState', () => {
  it('overrides the state with the #suffix', () => {
    expect(splitCodeState('abc#mystate')).toEqual({ code: 'abc', state: 'mystate' })
    expect(splitCodeState('plain')).toEqual({ code: 'plain' })
  })
})

describe('claude code exchange (§2.3.1 wire format)', () => {
  it('posts the fixed-order JSON body with the recorded headers', async () => {
    const wires: string[] = []
    const fetchFn: FetchLike = async (_url, init) => {
      wires.push(`${init?.method}|${JSON.stringify(init?.headers)}|${init?.body}`)
      return jsonResponse({
        access_token: 'at',
        refresh_token: 'rt',
        token_type: 'Bearer',
        expires_in: 3600,
        organization: { uuid: 'org-1', name: 'Org' },
        account: { uuid: 'acct-1', email_address: 'a@x.com' },
      })
    }
    const result = await exchangeClaudeCode(
      { code: 'c#over', codeVerifier: 'v', state: 'orig' },
      { fetch: fetchFn, now: () => 0 },
    )
    const [method, headers, body] = (wires[0] ?? '').split('|')
    expect(method).toBe('POST')
    const headerRecord = JSON.parse(headers ?? '{}') as Record<string, string>
    expect(headerRecord['Content-Type']).toBe('application/json')
    expect(headerRecord['User-Agent']).toBe('axios/1.15.2')
    expect(body).toBe(
      '{"grant_type":"authorization_code","code":"c","redirect_uri":"http://localhost:54545/callback","client_id":"9d1c250a-e61b-44d9-88ed-5944d1962f5e","code_verifier":"v","state":"over"}',
    )
    expect(result.document['access_token']).toBe('at')
    expect(result.document['organization_uuid']).toBe('org-1')
    expect(result.document['email']).toBe('a@x.com')
    expect(result.document['expired']).toBe('1970-01-01T01:00:00Z')
    expect(result.fileName).toMatch(/^claude-[0-9a-f]{8}-a@x\.com\.json$/)
  })

  it('lets profile values override the identity fields, tolerating advisory failures', async () => {
    const fetchFn: FetchLike = async (url) => {
      if (url.includes('oauth/profile')) {
        return jsonResponse({ account_uuid: 'profile-acct', email: 'profile@x.com' })
      }
      if (url.includes('claude_cli/roles')) {
        throw new Error('roles endpoint down')
      }
      return jsonResponse({
        access_token: 'at',
        refresh_token: 'rt',
        expires_in: 60,
        account: { uuid: 'acct-1', email_address: 'a@x.com' },
      })
    }
    const failures: string[] = []
    const result = await exchangeClaudeCode(
      { code: 'c', codeVerifier: 'v' },
      {
        fetch: fetchFn,
        now: () => 0,
        onAdvisoryFailure: (endpoint) => {
          failures.push(endpoint)
        },
      },
    )
    expect(result.document['email']).toBe('profile@x.com')
    expect(failures.length).toBe(1)
  })

  it('fails the exchange on a rejected token endpoint', async () => {
    await expect(
      exchangeClaudeCode(
        { code: 'c', codeVerifier: 'v' },
        { fetch: async () => new Response(null, { status: 400 }) },
      ),
    ).rejects.toThrow('Failed to exchange authorization code for tokens')
  })
})

describe('codex code exchange (§2.3.2)', () => {
  it('decodes the id_token claims into the credential and file name', async () => {
    const idToken = jwt({
      email: 'dev@x.com',
      'https://api.openai.com/auth.chatgpt_account_id': 'acct-9',
      'https://api.openai.com/auth.chatgpt_plan_type': 'Pro',
    })
    const fetchFn: FetchLike = async () =>
      jsonResponse({
        access_token: 'at',
        refresh_token: 'rt',
        id_token: idToken,
        token_type: 'Bearer',
        expires_in: 3600,
      })
    const result = await exchangeCodexCode(
      { code: 'c', codeVerifier: 'v' },
      { fetch: fetchFn, now: () => 0 },
    )
    expect(result.document['account_id']).toBe('acct-9')
    expect(result.document['plan_type']).toBe('Pro')
    expect(result.document['email']).toBe('dev@x.com')
    expect(result.fileName).toMatch(/^codex-[0-9a-f]{8}-dev@x\.com-pro\.json$/)
  })
})

describe('antigravity code exchange (§2.3.3)', () => {
  it('exchanges and enriches mandatorily', async () => {
    const fetchFn: FetchLike = async (url) => {
      if (url.includes('userinfo')) return jsonResponse({ email: 'g@x.com' })
      if (url.includes('loadCodeAssist')) {
        return jsonResponse({ cloudaicompanionProject: { id: 'proj-1' } })
      }
      return jsonResponse({
        access_token: 'at',
        refresh_token: 'rt',
        expires_in: 3600,
        token_type: 'Bearer',
      })
    }
    const result = await exchangeAntigravityCode({ code: 'c' }, { fetch: fetchFn, now: () => 42 })
    expect(result.document['email']).toBe('g@x.com')
    expect(result.document['project_id']).toBe('proj-1')
    expect(result.document['timestamp']).toBe(42)
    expect(result.fileName).toBe('antigravity-g@x.com.json')
  })

  it('fails fatally when the enrichment fails', async () => {
    const fetchFn: FetchLike = async (url) => {
      if (url.includes('userinfo')) return new Response(null, { status: 500 })
      return jsonResponse({ access_token: 'at', refresh_token: 'rt', expires_in: 60 })
    }
    await expect(
      exchangeAntigravityCode({ code: 'c' }, { fetch: fetchFn, now: () => 0 }),
    ).rejects.toThrow('Failed to exchange authorization code for tokens')
  })
})

describe('devin code exchange (§2.3.4)', () => {
  it('wraps eyJ tokens with the session-token prefix', async () => {
    const fetchFn: FetchLike = async (url) => {
      if (url.endsWith('/v3/self')) {
        return jsonResponse({ user_name: 'dev-user', user_id: 'u-1', org_id: 'o-1' })
      }
      return jsonResponse({ token: `${jwt({ sub: 'x' })}` })
    }
    const result = await exchangeDevinCode(
      { code: 'c', codeVerifier: 'v' },
      { fetch: fetchFn, now: () => 0 },
    )
    expect(result.document['api_key']).toBe(`devin-session-token$${jwt({ sub: 'x' })}`)
    expect(result.document['session_token']).toBe(result.document['api_key'])
    expect(result.document['user_name']).toBe('dev-user')
    expect(result.document['base_url']).toBe('https://server.codeium.com')
    expect(result.fileName).toBe('devin-dev-user.json')
  })

  it('keeps non-JWT tokens unwrapped', async () => {
    const fetchFn: FetchLike = async () => jsonResponse({ token: 'plain-session-token' })
    const result = await exchangeDevinCode(
      { code: 'c', codeVerifier: 'v' },
      { fetch: fetchFn, now: () => 0 },
    )
    expect(result.document['api_key']).toBe('plain-session-token')
  })
})

describe('device credential builders (§2.6)', () => {
  it('builds the kimi document with the login timestamp', async () => {
    const result = await buildKimiCredential(
      { access_token: 'a', refresh_token: 'r', token_type: 'Bearer', expires_in: 600, scope: 's' },
      1_760_000_000_000,
    )
    expect(result.fileName).toBe('kimi-1760000000000.json')
    expect(result.document['type']).toBe('kimi')
    const expectedExpiry = new Date(1_760_000_000_000 + 600_000).toISOString().slice(0, 19) + 'Z'
    expect(result.document['expired']).toBe(expectedExpiry)
  })

  it('builds the xai document from the id_token claims', async () => {
    const result = await buildXaiCredential(
      { access_token: 'a', refresh_token: 'r', id_token: jwt({ email: 'x@x.com', sub: 'sub-1' }), token_type: 'Bearer', expires_in: 600 },
      'https://auth.x.ai/oauth/token',
      0,
    )
    expect(result.document['email']).toBe('x@x.com')
    expect(result.fileName).toBe('xai-x@x.com.json')
    expect(result.document['token_endpoint']).toBe('https://auth.x.ai/oauth/token')
  })

  it('builds the meta document with the minted api key and empty expiry', async () => {
    const minted = await buildMetaCredential(
      {
        access_token: 'dca-1',
        token_type: 'Bearer',
        expires_in: 900,
        minted: { api_key: 'mk', user_email: 'm@x.com', base_url: 'https://api.meta.ai/v1', user_full_name: 'M' },
      },
      0,
    )
    expect(minted.document['access_token']).toBe('mk')
    expect(minted.document['api_key']).toBe('mk')
    expect(minted.document['dca_token']).toBe('dca-1')
    expect(minted.document['expired']).toBeUndefined()
    expect(minted.document['email']).toBe('m@x.com')
    const unminted = await buildMetaCredential(
      { access_token: 'dca-2', token_type: 'Bearer', expires_in: 900 },
      0,
    )
    expect(unminted.document['access_token']).toBe('dca-2')
    expect(unminted.document['expired']).toBe('1970-01-01T00:15:00Z')
  })
})

describe('code login waiter (§2.5)', () => {
  function fixture() {
    const store = new MemoryStore()
    const registry = new OAuthSessionRegistry(store, { now: () => 0 })
    return { store, registry }
  }

  it('times out with the recorded status message and marks the session', async () => {
    const { store, registry } = fixture()
    await registry.register('state-1', 'anthropic', { metadata: { code_verifier: 'v' } })
    let clock = 0
    const outcome = await runCodeLoginWaiter(store, registry, 'anthropic', 'state-1', {
      now: () => clock,
      timeoutMs: 100,
      pollIntervalMs: 50,
      sleep: async (ms: number) => {
        clock += ms
      },
      fetch: async () => {
        throw new Error('must not be called')
      },
    })
    expect(outcome).toEqual({
      ok: false,
      aborted: false,
      statusMessage: 'Timeout waiting for OAuth callback',
    })
    expect((await registry.get('state-1'))?.status).toBe('Timeout waiting for OAuth callback')
  })

  it('aborts silently when the session was cancelled meanwhile', async () => {
    const { store, registry } = fixture()
    await registry.register('state-1', 'anthropic', { metadata: { code_verifier: 'v' } })
    await registry.cancel('state-1')
    const outcome = await runCodeLoginWaiter(store, registry, 'anthropic', 'state-1', {
      now: () => 0,
      timeoutMs: 100,
      pollIntervalMs: 50,
      sleep: async () => undefined,
    })
    expect(outcome).toEqual({ ok: false, aborted: true })
  })

  it('exchanges, saves and completes on a published callback', async () => {
    const { store, registry } = fixture()
    await registry.register('state-1', 'codex', { metadata: { code_verifier: 'v' } })
    await store.put('oauth-callbacks', `.oauth-codex-state-1.oauth`, {
      code: 'auth-code',
      state: 'state-1',
      error: '',
    })
    const fetchFn: FetchLike = async () =>
      jsonResponse({
        access_token: 'at',
        refresh_token: 'rt',
        id_token: jwt({
          email: 'dev@x.com',
          'https://api.openai.com/auth.chatgpt_account_id': 'acct-1',
        }),
        token_type: 'Bearer',
        expires_in: 3600,
      })
    const outcome = await runCodeLoginWaiter(store, registry, 'codex', 'state-1', {
      now: () => 0,
      fetch: fetchFn,
    })
    expect(outcome.ok).toBe(true)
    const names = await store.list('auth')
    expect(names.length).toBe(1)
    expect(names[0]).toMatch(/^codex-[0-9a-f]{8}-dev@x\.com\.json$/)
    expect((await registry.get('state-1'))?.completed).toBe(true)
    // The handshake document is consumed.
    expect(await store.list('oauth-callbacks')).toEqual([])
  })

  it('marks a callback error on the session', async () => {
    const { store, registry } = fixture()
    await registry.register('state-1', 'anthropic', { metadata: { code_verifier: 'v' } })
    await store.put('oauth-callbacks', `.oauth-anthropic-state-1.oauth`, {
      code: '',
      state: 'state-1',
      error: 'access_denied',
    })
    const outcome = await runCodeLoginWaiter(store, registry, 'anthropic', 'state-1', {
      now: () => 0,
      fetch: async () => {
        throw new Error('must not be called')
      },
    })
    expect(outcome).toEqual({ ok: false, aborted: false, statusMessage: 'access_denied' })
    expect((await registry.get('state-1'))?.status).toBe('access_denied')
  })
})
