import { describe, expect, it } from 'vitest'
import { MemoryStore } from '@cpa-edge/core'
import {
  isRefreshCredential,
  isUnauthorizedUpstreamError,
  parseRetryAfterMs,
  REFRESH_FAILURE_BACKOFF_MS,
  REFRESH_INEFFECTIVE_BACKOFF_MS,
  REFRESH_LEADS_MS,
  REFRESH_PENDING_BACKOFF_MS,
  refreshClaudeToken,
  refreshCodexToken,
  refreshCredential,
  RefreshRegistry,
  REFRESH_REGISTRY_NAMESPACE,
  shouldRefresh,
  UnauthorizedRefresher,
} from './refresh'
import type { JsonValue } from '@cpa-edge/core'
import type { FetchLike } from './types'

function jsonResponse(payload: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), { status, headers })
}

const CLAUDE_DOC = {
  type: 'claude',
  access_token: 'old-access',
  refresh_token: 'r-1',
  expired: '2026-01-01T00:00:00Z',
} as const

describe('refresh scheduling rule (§2.7)', () => {
  it('pins the per-provider leads and backoffs', () => {
    expect(REFRESH_LEADS_MS['claude']).toBe(4 * 60 * 60_000)
    expect(REFRESH_LEADS_MS['codex']).toBe(24 * 60 * 60_000)
    expect(REFRESH_LEADS_MS['antigravity']).toBe(30 * 60_000)
    expect(REFRESH_LEADS_MS['kimi']).toBe(5 * 60_000)
    expect(REFRESH_LEADS_MS['xai']).toBe(5 * 60_000)
    expect(REFRESH_LEADS_MS['meta']).toBeUndefined()
    expect(REFRESH_LEADS_MS['devin']).toBeUndefined()
    expect(REFRESH_PENDING_BACKOFF_MS).toBe(60_000)
    expect(REFRESH_FAILURE_BACKOFF_MS).toBe(5 * 60_000)
    expect(REFRESH_INEFFECTIVE_BACKOFF_MS).toBe(30_000)
  })

  it('never schedules API-key credentials', () => {
    expect(
      shouldRefresh(
        { kind: 'api-key', provider: 'openai-compatibility', expiresAtMs: 0 },
        {},
        1_000_000,
      ),
    ).toBe(false)
  })

  it('refreshes inside the lead and respects backoffs and intervals', () => {
    const now = 1_000_000
    const claudeLead = 4 * 60 * 60_000
    expect(
      shouldRefresh({ kind: 'oauth', provider: 'claude', expiresAtMs: now + claudeLead - 1 }, {}, now),
    ).toBe(true)
    expect(
      shouldRefresh({ kind: 'oauth', provider: 'claude', expiresAtMs: now + claudeLead + 1 }, {}, now),
    ).toBe(false)
    expect(
      shouldRefresh(
        { kind: 'oauth', provider: 'claude', expiresAtMs: now + 1 },
        { next_refresh_after: '1970-01-01T00:00:00Z' },
        now,
      ),
    ).toBe(false)
    // Without a lead (meta), a preferred interval takes over.
    expect(
      shouldRefresh({ kind: 'oauth', provider: 'meta', preferredIntervalMs: 60_000, expiresAtMs: now + 59_000 }, {}, now),
    ).toBe(true)
    // No expiry known: interval since last refresh.
    expect(
      shouldRefresh(
        { kind: 'oauth', provider: 'kimi' },
        { last_refreshed_at: '1970-01-01T00:16:30Z' },
        1_000_000,
      ),
    ).toBe(true)
    expect(
      shouldRefresh(
        { kind: 'oauth', provider: 'kimi' },
        { last_refreshed_at: '1970-01-01T00:16:40Z' },
        1_000_000,
      ),
    ).toBe(false)
  })

  it('classifies unauthorized upstream errors', () => {
    expect(isUnauthorizedUpstreamError({ status: 401 })).toBe(true)
    expect(isUnauthorizedUpstreamError({ message: 'request failed with status 401' })).toBe(true)
    expect(isUnauthorizedUpstreamError({ message: '401 Unauthorized' })).toBe(true)
    expect(isUnauthorizedUpstreamError({ status: 500 })).toBe(false)
    expect(isUnauthorizedUpstreamError({})).toBe(false)
  })

  it('reads the camelCase refreshToken spelling for refresh credentials', () => {
    expect(isRefreshCredential('claude', { refreshToken: 'r' } as Record<string, JsonValue>)).toBe(true)
  })
})

describe('Retry-After parsing (claude §2.3.1)', () => {
  it('accepts seconds, HTTP-dates and Retry-After-Ms with clamping', () => {
    const headers = (value: string): Headers => new Headers({ 'Retry-After': value })
    expect(parseRetryAfterMs(headers('120'), 0)).toBe(120_000)
    expect(parseRetryAfterMs(headers('1'), 0)).toBe(5_000)
    expect(parseRetryAfterMs(headers('99999'), 0)).toBe(5 * 60_000)
    expect(parseRetryAfterMs(new Headers({ 'Retry-After-Ms': '7000' }), 0)).toBe(7_000)
    const date = new Date(60_000).toUTCString()
    expect(parseRetryAfterMs(headers(date), 0)).toBe(60_000)
  })
})

describe('claude refresh', () => {
  const deps = (fetchFn: FetchLike) => ({
    fetch: fetchFn,
    now: () => 1_760_000_000_000,
    sleep: async () => undefined,
  })

  it('patches the document and retains an empty refresh token', async () => {
    const fetchFn: FetchLike = async () =>
      jsonResponse({ access_token: 'new-access', refresh_token: '', expires_in: 3600 })
    const outcome = await refreshClaudeToken({ ...CLAUDE_DOC }, deps(fetchFn))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('expected success')
    expect(outcome.documentPatch['access_token']).toBe('new-access')
    expect(outcome.documentPatch['refresh_token']).toBe('r-1')
    expect(outcome.effective).toBe(true)
  })

  it('blocks the token after a 429 and marks the failure non-retryable', async () => {
    const fetchFn: FetchLike = async () =>
      new Response('rate limited', { status: 429, headers: { 'Retry-After': '60' } })
    const outcome = await refreshClaudeToken({ ...CLAUDE_DOC }, deps(fetchFn))
    expect(outcome).toEqual({
      ok: false,
      retryable: false,
      message: 'refresh rate limited',
      blockedUntilMs: 1_760_000_000_000 + 60_000,
      unauthorized: false,
    })
  })

  it('retries 5xx responses and fails non-retryable on other 4xx', async () => {
    let call = 0
    const flaky: FetchLike = async () => {
      call += 1
      if (call === 1) return new Response(null, { status: 503 })
      return jsonResponse({ access_token: 'a', refresh_token: 'r', expires_in: 60 })
    }
    const outcome = await refreshClaudeToken({ ...CLAUDE_DOC }, deps(flaky))
    expect(outcome.ok).toBe(true)
    expect(call).toBe(2)
    const rejected = await refreshClaudeToken(
      { ...CLAUDE_DOC },
      deps(async () => new Response(null, { status: 400 })),
    )
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) {
      expect(rejected.retryable).toBe(false)
      expect(rejected.unauthorized).toBe(false)
    }
    const unauthorized = await refreshClaudeToken(
      { ...CLAUDE_DOC },
      deps(async () => new Response(null, { status: 401 })),
    )
    expect(unauthorized.ok).toBe(false)
    if (!unauthorized.ok) expect(unauthorized.unauthorized).toBe(true)
  })
})

describe('codex refresh', () => {
  it('fails non-retryable on refresh_token_reused', async () => {
    const outcome = await refreshCodexToken(
      { type: 'codex', refresh_token: 'r' } as Record<string, JsonValue>,
      {
        fetch: async () =>
          new Response('{"error":"refresh_token_reused"}', { status: 400 }),
        now: () => 0,
      },
    )
    expect(outcome).toEqual({
      ok: false,
      retryable: false,
      message: 'refresh token reused',
      unauthorized: false,
    })
  })
})

describe('refresh dispatch and meta re-mint', () => {
  it('re-mints the meta api key from the dca token', async () => {
    let body = ''
    const fetchFn: FetchLike = async (_url, init) => {
      body = init?.body ?? ''
      return jsonResponse({ api_key: 'minted', user_email: 'a@x.com' })
    }
    const outcome = await refreshCredential(
      'meta',
      { type: 'meta', dca_token: 'dca-1', access_token: 'old' } as Record<string, JsonValue>,
      { fetch: fetchFn, now: () => 0 },
    )
    expect(body).toBe('{"dca_token":"dca-1"}')
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('expected success')
    expect(outcome.documentPatch['access_token']).toBe('minted')
    expect(outcome.documentPatch['api_key']).toBe('minted')
  })

  it('answers unsupported for providers without a refresh implementation', async () => {
    const outcome = await refreshCredential('devin', {} as Record<string, JsonValue>, {})
    expect(outcome).toEqual({
      ok: false,
      retryable: false,
      message: 'unsupported provider',
      unauthorized: false,
    })
  })
})

describe('refresh registry bookkeeping (Store)', () => {
  it('records success, backoffs and unauthorized state', async () => {
    const store = new MemoryStore()
    const registry = new RefreshRegistry(store, { now: () => 1_760_000_000_000 })
    await registry.recordSuccess('claude-a.json', true)
    let doc = await registry.get('claude-a.json')
    expect(doc.status).toBe('active')
    expect(doc.next_refresh_after).toBeUndefined()
    await registry.recordSuccess('claude-a.json', false)
    doc = await registry.get('claude-a.json')
    expect(doc.next_refresh_after).toBe('2026-10-09T11:33:22Z')
    await registry.recordFailure('claude-a.json', 'upstream unavailable')
    doc = await registry.get('claude-a.json')
    expect(doc.status).toBe('error')
    expect(doc.status_message).toBe('upstream unavailable')
    await registry.recordUnauthorized('claude-a.json', 'unauthorized')
    doc = await registry.get('claude-a.json')
    expect(doc.status_message).toBe('unauthorized')
    const namespaces = await store.list(REFRESH_REGISTRY_NAMESPACE)
    expect(namespaces).toEqual(['claude-a.json'])
  })
})

describe('refresh-on-401 coordinator', () => {
  it('refreshes once and persists the new token set', async () => {
    const store = new MemoryStore()
    await store.put('auth', 'claude-a.json', { ...CLAUDE_DOC })
    const refresher = new UnauthorizedRefresher(store, { now: () => 0 })
    const fetchFn: FetchLike = async () =>
      jsonResponse({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 })
    const outcome = await refresher.refreshAfterUnauthorized({
      fileName: 'claude-a.json',
      provider: 'claude',
      document: { ...CLAUDE_DOC },
      failedAccessToken: 'old-access',
      deps: { fetch: fetchFn, now: () => 0, sleep: async () => undefined },
    })
    expect(outcome.refreshed).toBe(true)
    if (!outcome.refreshed) throw new Error('expected refresh')
    expect(outcome.document['access_token']).toBe('new-access')
    const stored = (await store.get('auth', 'claude-a.json')) as Record<string, unknown>
    expect(stored['refresh_token']).toBe('new-refresh')
  })

  it('reuses a newer token without refreshing when the failed one is stale', async () => {
    const store = new MemoryStore()
    await store.put('auth', 'claude-a.json', { ...CLAUDE_DOC, access_token: 'newer-token' })
    const refresher = new UnauthorizedRefresher(store, { now: () => 0 })
    let called = 0
    const outcome = await refresher.refreshAfterUnauthorized({
      fileName: 'claude-a.json',
      provider: 'claude',
      document: { ...CLAUDE_DOC, access_token: 'newer-token' },
      failedAccessToken: 'old-access',
      deps: {
        fetch: async () => {
          called += 1
          throw new Error('must not be called')
        },
        now: () => 0,
      },
    })
    expect(outcome.refreshed).toBe(true)
    expect(called).toBe(0)
  })

  it('marks the credential unauthorized after a 401 refresh failure', async () => {
    const store = new MemoryStore()
    await store.put('auth', 'claude-a.json', { ...CLAUDE_DOC })
    const refresher = new UnauthorizedRefresher(store, { now: () => 0 })
    const outcome = await refresher.refreshAfterUnauthorized({
      fileName: 'claude-a.json',
      provider: 'claude',
      document: { ...CLAUDE_DOC },
      failedAccessToken: 'old-access',
      deps: {
        fetch: async () => new Response(null, { status: 401 }),
        now: () => 0,
        sleep: async () => undefined,
      },
    })
    expect(outcome.refreshed).toBe(false)
    const bookkeeping = (await store.get(
      REFRESH_REGISTRY_NAMESPACE,
      'claude-a.json',
    )) as Record<string, unknown>
    expect(bookkeeping['status']).toBe('error')
    expect(bookkeeping['status_message']).toBe('unauthorized')
  })
})
