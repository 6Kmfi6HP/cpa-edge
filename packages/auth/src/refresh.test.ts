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
    const futureBackoff = new Date(now + 60_000).toISOString().slice(0, 19) + 'Z'
    expect(
      shouldRefresh(
        { kind: 'oauth', provider: 'claude', expiresAtMs: now + 1 },
        { next_refresh_after: futureBackoff },
        now,
      ),
    ).toBe(false)
    const expiredBackoff = new Date(now - 1).toISOString().slice(0, 19) + 'Z'
    expect(
      shouldRefresh(
        { kind: 'oauth', provider: 'claude', expiresAtMs: now + 1 },
        { next_refresh_after: expiredBackoff },
        now,
      ),
    ).toBe(true)
    // Without a lead (meta), a preferred interval takes over.
    expect(
      shouldRefresh({ kind: 'oauth', provider: 'meta', preferredIntervalMs: 60_000, expiresAtMs: now + 59_000 }, {}, now),
    ).toBe(true)
    // No expiry known: interval since last refresh.
    expect(
      shouldRefresh(
        { kind: 'oauth', provider: 'kimi' },
        { last_refreshed_at: '1970-01-01T00:10:00Z' },
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
    const expectedIneffective = new Date(1_760_000_000_000 + 30_000).toISOString().slice(0, 19) + 'Z'
    expect(doc.next_refresh_after).toBe(expectedIneffective)
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


describe('registry backoff clearing (§2.7 regressions)', () => {
  it('drops the failure backoff and error note on an effective success', async () => {
    const store = new MemoryStore()
    const registry = new RefreshRegistry(store, { now: () => 1_760_000_000_000 })
    await registry.recordFailure('claude-b.json', 'upstream unavailable')
    const failed = await registry.get('claude-b.json')
    expect(failed.next_refresh_after).toBeDefined()
    expect(failed.status_message).toBe('upstream unavailable')
    await registry.recordSuccess('claude-b.json', true)
    expect(await registry.get('claude-b.json')).toEqual({
      last_refreshed_at: new Date(1_760_000_000_000).toISOString().slice(0, 19) + 'Z',
      status: 'active',
    })
  })

  it('keeps the ineffective backoff but still clears the error note on success', async () => {
    const store = new MemoryStore()
    const registry = new RefreshRegistry(store, { now: () => 1_760_000_000_000 })
    await registry.recordFailure('claude-c.json', 'upstream unavailable')
    await registry.recordSuccess('claude-c.json', false)
    expect(await registry.get('claude-c.json')).toEqual({
      last_refreshed_at: new Date(1_760_000_000_000).toISOString().slice(0, 19) + 'Z',
      status: 'active',
      next_refresh_after: new Date(1_760_000_000_000 + 30_000).toISOString().slice(0, 19) + 'Z',
    })
  })

  it('drops the failure backoff when the credential becomes unauthorized', async () => {
    const store = new MemoryStore()
    const registry = new RefreshRegistry(store, { now: () => 1_760_000_000_000 })
    await registry.recordSuccess('claude-d.json', true)
    await registry.recordFailure('claude-d.json', 'upstream unavailable')
    const failed = await registry.get('claude-d.json')
    expect(failed.next_refresh_after).toBeDefined()
    await registry.recordUnauthorized('claude-d.json', 'unauthorized')
    expect(await registry.get('claude-d.json')).toEqual({
      last_refreshed_at: new Date(1_760_000_000_000).toISOString().slice(0, 19) + 'Z',
      status: 'error',
      status_message: 'unauthorized',
    })
  })
})

describe('429 block consumption (claude §2.3.1 regression)', () => {
  const BASE = 1_760_000_000_000

  it('threads the vendor block into the registry and fails fast without a vendor call', async () => {
    const store = new MemoryStore()
    await store.put('auth', 'claude-a.json', { ...CLAUDE_DOC })
    const now = { value: BASE }
    const refresher = new UnauthorizedRefresher(store, { now: () => now.value })
    let vendorCalls = 0
    const rateLimited: FetchLike = async () => {
      vendorCalls += 1
      return new Response('rate limited', { status: 429, headers: { 'Retry-After': '5' } })
    }
    const attempt = (fetchFn: FetchLike) =>
      refresher.refreshAfterUnauthorized({
        fileName: 'claude-a.json',
        provider: 'claude',
        document: { ...CLAUDE_DOC },
        failedAccessToken: 'old-access',
        deps: { fetch: fetchFn, now: () => now.value, sleep: async () => undefined },
      })

    const first = await attempt(rateLimited)
    expect(first.refreshed).toBe(false)
    if (!first.refreshed) {
      expect(first.outcome).toEqual({
        ok: false,
        retryable: false,
        message: 'refresh rate limited',
        blockedUntilMs: BASE + 5_000,
        unauthorized: false,
      })
    }
    // The registry consumed the exact vendor deadline as its backoff.
    const afterFirst = (await store.get(
      REFRESH_REGISTRY_NAMESPACE,
      'claude-a.json',
    )) as Record<string, unknown>
    const expectedBlocked = new Date(BASE + 5_000).toISOString().slice(0, 19) + 'Z'
    expect(afterFirst['next_refresh_after']).toBe(expectedBlocked)
    expect(vendorCalls).toBe(1)

    // Within the window a second refresh fails fast, without a vendor call.
    now.value += 1_000
    const second = await attempt(rateLimited)
    expect(second.refreshed).toBe(false)
    if (!second.refreshed) {
      const outcome = second.outcome
      if (outcome !== undefined && !outcome.ok) {
        expect(outcome.retryable).toBe(false)
        expect(outcome.message).toBe('refresh blocked')
        expect(outcome.unauthorized).toBe(false)
      } else {
        throw new Error('expected a blocked refresh outcome')
      }
    }
    expect(vendorCalls).toBe(1)
    const afterSecond = (await store.get(
      REFRESH_REGISTRY_NAMESPACE,
      'claude-a.json',
    )) as Record<string, unknown>
    expect(afterSecond['next_refresh_after']).toBe(expectedBlocked)

    // After the window the refresh proceeds to the vendor and succeeds.
    now.value += 5_000
    const success: FetchLike = async () => {
      vendorCalls += 1
      return jsonResponse({ access_token: 'ok-access', refresh_token: 'r-2', expires_in: 3600 })
    }
    const third = await attempt(success)
    expect(third.refreshed).toBe(true)
    expect(vendorCalls).toBe(2)
    const stored = (await store.get('auth', 'claude-a.json')) as Record<string, unknown>
    expect(stored['access_token']).toBe('ok-access')
    const registryAfter = (await store.get(
      REFRESH_REGISTRY_NAMESPACE,
      'claude-a.json',
    )) as Record<string, unknown>
    expect(registryAfter['next_refresh_after']).toBeUndefined()
    expect(registryAfter['status_message']).toBeUndefined()
  })
})

describe('refreshed-credential persistence (atomic merge)', () => {
  it('keeps concurrent writes to the stored document while the refresh is in flight', async () => {
    const store = new MemoryStore()
    await store.put('auth', 'claude-a.json', { ...CLAUDE_DOC })
    const refresher = new UnauthorizedRefresher(store, { now: () => 0 })
    const vendoring: FetchLike = async () => {
      // A concurrent writer commits a change while the refresh is running.
      await store.update<Record<string, JsonValue>>('auth', 'claude-a.json', (current) => ({
        ...(current ?? {}),
        label: 'touched-while-refreshing',
      }))
      return jsonResponse({ access_token: 'new-access', refresh_token: 'r-2', expires_in: 3600 })
    }
    const outcome = await refresher.refreshAfterUnauthorized({
      fileName: 'claude-a.json',
      provider: 'claude',
      document: { ...CLAUDE_DOC },
      failedAccessToken: 'old-access',
      deps: { fetch: vendoring, now: () => 0, sleep: async () => undefined },
    })
    expect(outcome.refreshed).toBe(true)
    const stored = (await store.get('auth', 'claude-a.json')) as Record<string, unknown>
    expect(stored['access_token']).toBe('new-access')
    expect(stored['refresh_token']).toBe('r-2')
    expect(stored['label']).toBe('touched-while-refreshing')
  })
})
