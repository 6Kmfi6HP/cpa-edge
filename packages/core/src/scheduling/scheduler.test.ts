import { describe, expect, it } from 'vitest'
import { MemoryStore } from '../store-memory'
import { deriveCredentialIdentity } from './identity'
import { CredentialScheduler } from './scheduler'
import { extractSessionIdentity } from './session'
import type { PickRequest, ScheduledCredential, SchedulerConfig } from './scheduler'

const T0 = 1_700_000_000_000
const BASE = 'http://host.docker.internal:18999/v1'
const COMPAT = 'openai-compatible-mock-openai'

const BASE_CONFIG: SchedulerConfig = {
  strategy: 'round-robin',
  sessionAffinity: false,
  sessionAffinityTtlMs: 3_600_000,
  sessionAffinitySubagents: true,
  requestRetry: 0,
  maxRetryCredentials: 0,
  maxRetryIntervalMs: 10_000,
  transientCooldownSeconds: 2,
  globalDisableCooling: false,
}

function clock(start = T0): { now: number } {
  return { now: start }
}

/** The recorded S4-01 pool: identities derived exactly like the gateway. */
async function s4Pool(): Promise<ScheduledCredential[]> {
  const identities = await Promise.all(
    ['s4-oai-key-1', 's4-oai-key-2', 's4-oai-key-3'].map((apiKey) =>
      deriveCredentialIdentity('openai-compatibility', { apiKey, baseUrl: BASE }, 'mock-openai'),
    ),
  )
  return identities.map((identity) => ({
    id: identity.id,
    provider: COMPAT,
    models: ['mock-model', 'iso-model-1', 'iso-model-2', 'all-blocked'],
    priority: 0,
    weight: 1,
    websocketEnabled: false,
    disabled: false,
  }))
}

/** Ascending-ID view of a pool. */
function ascending(pool: readonly ScheduledCredential[]): ScheduledCredential[] {
  return [...pool].sort((a, b) => (a.id < b.id ? -1 : 1))
}

function simpleCredential(id: string, overrides: Partial<ScheduledCredential> = {}): ScheduledCredential {
  return {
    id,
    provider: COMPAT,
    models: ['mock-model'],
    priority: 0,
    weight: 1,
    websocketEnabled: false,
    disabled: false,
    ...overrides,
  }
}

function scheduler(
  config: Partial<SchedulerConfig> = {},
  store: MemoryStore = new MemoryStore(),
  now: () => number = () => T0,
) {
  return new CredentialScheduler(store, now, { ...BASE_CONFIG, ...config })
}

function request(overrides: Partial<PickRequest> = {}): PickRequest {
  return { model: 'mock-model', tried: [], ...overrides }
}

describe('round-robin scheduling (S4-01)', () => {
  it('cycles the pool in ascending auth-ID order', async () => {
    const pool = await s4Pool()
    const sched = scheduler()
    const order: string[] = []
    for (let i = 0; i < 6; i += 1) {
      const pick = await sched.pick(pool, request())
      order.push(pick?.credential.id ?? '')
      await sched.recordResult({
        authId: pick?.credential.id ?? '',
        provider: COMPAT,
        model: 'mock-model',
        success: true,
      })
    }
    const ids = ascending(pool).map((credential) => credential.id)
    expect(order).toEqual([ids[0], ids[1], ids[2], ids[0], ids[1], ids[2]])
    // The ascending order matches the recorded digest order:
    // key-1 < key-3 < key-2.
    expect(order[0]?.endsWith('2add2ed9fa51')).toBe(true)
    expect(order[1]?.endsWith('922ad5b89d42')).toBe(true)
    expect(order[2]?.endsWith('9d9fdb184163')).toBe(true)
  })
})

describe('fill-first scheduling (S4-02)', () => {
  it('pins the smallest-ID credential until it is unavailable', async () => {
    const pool = await s4Pool()
    const sched = scheduler({ strategy: 'fill-first' })
    const ids = ascending(pool).map((credential) => credential.id)
    for (let i = 0; i < 3; i += 1) {
      const pick = await sched.pick(pool, request())
      expect(pick?.credential.id).toBe(ids[0])
    }
  })
})

describe('weighted round-robin scheduling (S4-03)', () => {
  it('serves the 3:1 ratio and never picks the zero-weight credential', async () => {
    const pool = await s4Pool()
    const ids = ascending(pool).map((credential) => credential.id)
    // ids[0] = key-1 (weight 3), ids[1] = key-3 (weight 0), ids[2] = key-2 (weight 1).
    const weighted = [
      simpleCredential(ids[0] ?? '', { weight: 3 }),
      simpleCredential(ids[1] ?? '', { weight: 0 }),
      simpleCredential(ids[2] ?? '', { weight: 1 }),
    ]
    const sched = scheduler({ strategy: 'weighted-round-robin' })
    const picks: (string | undefined)[] = []
    for (let i = 0; i < 8; i += 1) {
      const pick = await sched.pick(weighted, request())
      picks.push(pick?.credential.id)
    }
    expect(picks).toEqual([
      ids[0], ids[0], ids[2], ids[0], ids[0], ids[0], ids[2], ids[0],
    ])
  })
})

describe('cooldown integration', () => {
  it('fails over inside one request and skips cooled credentials (S4-04/S4-05/S4-16)', async () => {
    const pool = await s4Pool()
    const ids = ascending(pool).map((credential) => credential.id)
    const sched = scheduler()
    const first = await sched.pick(pool, request())
    expect(first?.credential.id).toBe(ids[0])
    // Same-request failover with the first credential excluded.
    const second = await sched.pick(pool, request({ tried: [first?.credential.id ?? ''] }))
    expect(second?.credential.id).toBe(ids[1])
    // A transient failure cools the credential for the configured 2 s.
    await sched.recordResult({
      authId: ids[0] ?? '',
      provider: COMPAT,
      model: 'mock-model',
      success: false,
      failure: { httpStatus: 500, bodyText: '{"error": "boom"}' },
      lastErrorMessage: '{"error": "boom"}',
      lastErrorHttpStatus: 500,
    })
    const blocked = await sched.pick(pool, request())
    expect(blocked?.credential.id).not.toBe(ids[0])
    // A 404 cools only that model: another model stays schedulable.
    await sched.recordResult({
      authId: ids[2] ?? '',
      provider: COMPAT,
      model: 'iso-model-1',
      success: false,
      failure: { httpStatus: 404, bodyText: '{"error": {"code": 404, "message": "x", "status": "NOT_FOUND"}}' },
      lastErrorMessage: 'not found',
      lastErrorHttpStatus: 404,
    })
    expect((await sched.pick(pool, request({ model: 'iso-model-1' })))?.credential.id).toBe(ids[0])
    // All credentials cooling -> no pick.
    for (const id of ids) {
      await sched.recordResult({
        authId: id,
        provider: COMPAT,
        model: 'all-blocked',
        success: false,
        failure: { httpStatus: 500, bodyText: 'x' },
        lastErrorMessage: 'x',
        lastErrorHttpStatus: 500,
      })
    }
    expect(await sched.pick(pool, request({ model: 'all-blocked' }))).toBeUndefined()
  })

  it('keeps request-fault failures cooldown-free (S4-08)', async () => {
    const pool = await s4Pool()
    const sched = scheduler()
    const first = await sched.pick(pool, request())
    await sched.recordResult({
      authId: first?.credential.id ?? '',
      provider: COMPAT,
      model: 'mock-model',
      success: false,
      failure: { httpStatus: 400, bodyText: '{"error": {"type": "invalid_request_error"}}' },
      lastErrorMessage: 'bad request',
      lastErrorHttpStatus: 400,
    })
    expect(await sched.availability(first?.credential.id ?? '', 'mock-model')).toBeUndefined()
  })
})

describe('retry round admission', () => {
  it('excludes credentials whose effective limit does not admit the round', async () => {
    const pool = [
      simpleCredential('a', { requestRetryOverride: 0 }),
      simpleCredential('b'),
    ]
    const sched = scheduler({ requestRetry: 2 })
    const round0 = await sched.pick(pool, request({ tried: ['x'] }))
    expect(round0?.credential.id).toBe('a')
    const round1 = await sched.pick(pool, request({ tried: ['x'], round: 1 }))
    expect(round1?.credential.id).toBe('b')
    // Global request-retry is 2, so b (limit 2) still admits round 2;
    // a (override 0) never does. With b already tried, round 2 finds
    // nobody.
    const round2 = await sched.pick(pool, request({ tried: ['b'], round: 2 }))
    expect(round2).toBeUndefined()
    const round2Again = await sched.pick(pool, request({ tried: [], round: 2 }))
    expect(round2Again?.credential.id).toBe('b')
  })

  it('caps retry rounds at max-retry-credentials distinct credentials', async () => {
    const pool = [simpleCredential('a'), simpleCredential('b'), simpleCredential('c')]
    const sched = scheduler({ requestRetry: 1, maxRetryCredentials: 2 })
    const round1 = await sched.pick(pool, request({ round: 1, tried: ['a', 'b'] }))
    expect(round1).toBeUndefined()
    const round1Fresh = await sched.pick(pool, request({ round: 1, tried: ['a'] }))
    expect(round1Fresh?.credential.id).toBe('b')
  })
})

describe('session affinity scheduling (S4-11)', () => {
  it('sticks sessions and does not advance the cursor on sticky picks', async () => {
    const pool = await s4Pool()
    const ids = ascending(pool).map((credential) => credential.id)
    const sched = scheduler({ sessionAffinity: true })
    const scope = COMPAT

    // Request 1: no session header -> round-robin head.
    expect((await sched.pick(pool, request()))?.credential.id).toBe(ids[0])
    // Request 2: session A misses and binds the successor.
    expect(
      (await sched.pick(pool, request({ sessionIdentity: 's4-affinity-A', affinityScope: scope })))?.credential.id,
    ).toBe(ids[1])
    // Request 3: session A sticks to the bound credential.
    const sticky = await sched.pick(pool, request({ sessionIdentity: 's4-affinity-A', affinityScope: scope }))
    expect(sticky?.credential.id).toBe(ids[1])
    expect(sticky?.fromAffinity).toBe(true)
    // Request 4: session B binds the next successor - the sticky pick did
    // not advance the cursor.
    expect(
      (await sched.pick(pool, request({ sessionIdentity: 's4-affinity-B', affinityScope: scope })))?.credential.id,
    ).toBe(ids[2])
    // Request 5: no session -> successor of the last strategy pick.
    expect((await sched.pick(pool, request()))?.credential.id).toBe(ids[0])
  })

  it('unbinds on credential-attributed failures and preserves bindings on scoped failures', async () => {
    const pool = [simpleCredential('a'), simpleCredential('b')]
    const wall = clock()
    const sched = scheduler({ sessionAffinity: true }, new MemoryStore({ now: () => wall.now }), () => wall.now)
    const key = { sessionIdentity: 'sess', affinityScope: COMPAT }
    const first = await sched.pick(pool, request(key))
    expect(first?.credential.id).toBe('a')
    // A request-scoped failure keeps the binding.
    await sched.recordResult({
      authId: 'a',
      provider: COMPAT,
      model: 'mock-model',
      success: false,
      failure: { httpStatus: 400, bodyText: '{"error": {"type": "invalid_request_error"}}' },
      sessionIdentity: 'sess',
      affinityScope: COMPAT,
    })
    expect((await sched.pick(pool, request(key)))?.credential.id).toBe('a')
    // A quota failure drops the binding and cools the credential for 1 s.
    await sched.recordResult({
      authId: 'a',
      provider: COMPAT,
      model: 'mock-model',
      success: false,
      failure: { httpStatus: 429, bodyText: 'slow down' },
      sessionIdentity: 'sess',
      affinityScope: COMPAT,
    })
    const next = await sched.pick(pool, request(key))
    expect(next?.credential.id).toBe('b')
    // Past the quota window a is schedulable again, and the session has
    // rebound to b (the failover pick), so the session sticks to b - the
    // stale binding to the failed credential is gone.
    wall.now = T0 + 2_000
    expect(await sched.availability('a', 'mock-model')).toBeUndefined()
    const after = await sched.pick(pool, request(key))
    expect(after?.credential.id).toBe('b')
    expect(after?.fromAffinity).toBe(true)
  })

  it('inherits the parent session for subagents when enabled', async () => {
    const pool = [simpleCredential('a'), simpleCredential('b')]
    const sched = scheduler({ sessionAffinity: true })
    const parent = await sched.pick(pool, request({ sessionIdentity: 'parent', affinityScope: COMPAT }))
    expect(parent?.credential.id).toBe('a')
    const child = await sched.pick(
      pool,
      request({ sessionIdentity: 'child-1', parentSessionIdentity: 'parent', affinityScope: COMPAT }),
    )
    expect(child?.credential.id).toBe('a')
    expect(child?.fromAffinity).toBe(true)
    // Disabled: subagents distribute via the fallback strategy.
    const off = scheduler({ sessionAffinity: true, sessionAffinitySubagents: false })
    await off.pick(pool, request({ sessionIdentity: 'parent', affinityScope: COMPAT }))
    const childOff = await off.pick(
      pool,
      request({ sessionIdentity: 'child-1', parentSessionIdentity: 'parent', affinityScope: COMPAT }),
    )
    expect(childOff?.credential.id).toBe('b')
  })
})

describe('websocket transport preference scheduling (S4-21)', () => {
  const wsPool = [
    simpleCredential('ws-low', { priority: -5, websocketEnabled: true, provider: 'codex' }),
    simpleCredential('plain-high', { priority: 0, provider: 'codex' }),
  ]

  it('picks the ws-enabled lower-priority credential on the WS leg', async () => {
    const sched = scheduler()
    const wsPick = await sched.pick(
      wsPool,
      request({ downstreamWebSocket: true, surfaceProvider: 'codex' }),
    )
    expect(wsPick?.credential.id).toBe('ws-low')
  })

  it('respects priority on the HTTP leg', async () => {
    const sched = scheduler()
    const httpPick = await sched.pick(wsPool, request({ surfaceProvider: 'codex' }))
    expect(httpPick?.credential.id).toBe('plain-high')
  })

  it('legacy path (affinity on) filters codex only inside the highest tier', async () => {
    const sched = scheduler({ sessionAffinity: true })
    // Highest tier has no ws credential: fall back to the tier.
    const pick = await sched.pick(wsPool, request({ downstreamWebSocket: true, surfaceProvider: 'codex' }))
    expect(pick?.credential.id).toBe('plain-high')
    // xai never gets the legacy preference.
    const xaiPool = [
      simpleCredential('ws-low', { priority: -5, websocketEnabled: true, provider: 'xai' }),
      simpleCredential('plain-high', { priority: 0, provider: 'xai' }),
    ]
    const xaiPick = await sched.pick(xaiPool, request({ downstreamWebSocket: true, surfaceProvider: 'xai' }))
    expect(xaiPick?.credential.id).toBe('plain-high')
  })

  it('pins bypass the preference entirely', async () => {
    const sched = scheduler()
    const pinned = await sched.pick(
      wsPool,
      request({ downstreamWebSocket: true, surfaceProvider: 'codex', pinnedAuthId: 'plain-high' }),
    )
    expect(pinned?.credential.id).toBe('plain-high')
  })
})

describe('mixed provider rotation (S4-18)', () => {
  const mixedPool = [
    simpleCredential('gemini-key', { provider: 'gemini', models: ['mx'] }),
    simpleCredential('openai-mx-key', { provider: 'openai-compatible-mock-openai-mx', models: ['mx'] }),
  ]

  it('alternates across provider segments and fails over cross-provider', async () => {
    const sched = scheduler()
    const pick1 = await sched.pick(mixedPool, request({ model: 'mx' }))
    expect(pick1?.credential.id).toBe('gemini-key')
    await sched.recordResult({ authId: 'gemini-key', provider: 'gemini', model: 'mx', success: true })
    const pick2 = await sched.pick(mixedPool, request({ model: 'mx' }))
    expect(pick2?.credential.id).toBe('openai-mx-key')
    await sched.recordResult({ authId: 'openai-mx-key', provider: 'openai-compatible-mock-openai-mx', model: 'mx', success: true })
    const pick3 = await sched.pick(mixedPool, request({ model: 'mx' }))
    expect(pick3?.credential.id).toBe('gemini-key')
    // The gemini leg fails with a transient error and the request fails
    // over to the other provider within the same request.
    await sched.recordResult({
      authId: 'gemini-key',
      provider: 'gemini',
      model: 'mx',
      success: false,
      failure: { httpStatus: 500, bodyText: 'x' },
      lastErrorMessage: 'x',
      lastErrorHttpStatus: 500,
    })
    const pick4 = await sched.pick(mixedPool, request({ model: 'mx', tried: ['gemini-key'] }))
    expect(pick4?.credential.id).toBe('openai-mx-key')
    // While gemini cools, the next request is served by the other provider.
    const pick5 = await sched.pick(mixedPool, request({ model: 'mx' }))
    expect(pick5?.credential.id).toBe('openai-mx-key')
  })

  it('fill-first walks the provider list in segment order', async () => {
    const sched = scheduler({ strategy: 'fill-first' })
    for (let i = 0; i < 3; i += 1) {
      const pick = await sched.pick(mixedPool, request({ model: 'mx' }))
      expect(pick?.credential.id).toBe('gemini-key')
    }
  })
})

describe('model pools (S4-13)', () => {
  it('rotates the pool per request on the same credential', async () => {
    const sched = scheduler()
    const pool = ['mock-pool-1', 'mock-pool-2']
    expect(await sched.modelPoolCandidates('auth-1', COMPAT, 'pool-model', pool)).toEqual(pool)
    expect(await sched.modelPoolCandidates('auth-1', COMPAT, 'pool-model', pool)).toEqual([
      'mock-pool-2',
      'mock-pool-1',
    ])
    expect(await sched.modelPoolCandidates('auth-1', COMPAT, 'pool-model', pool)).toEqual(pool)
    // Pools of one do not rotate.
    expect(await sched.modelPoolCandidates('auth-1', COMPAT, 'other', ['solo'])).toEqual(['solo'])
  })
})

describe('cursor lifecycle', () => {
  it('resets cursors on routing changes (hot reload)', async () => {
    const pool = [simpleCredential('a'), simpleCredential('b'), simpleCredential('c')]
    const sched = scheduler()
    expect((await sched.pick(pool, request()))?.credential.id).toBe('a')
    expect((await sched.pick(pool, request()))?.credential.id).toBe('b')
    await sched.resetRotationCursors()
    expect((await sched.pick(pool, request()))?.credential.id).toBe('a')
  })

  it('uses the session identity extraction end to end', async () => {
    const pool = [simpleCredential('a'), simpleCredential('b')]
    const sched = scheduler({ sessionAffinity: true })
    const identity = await extractSessionIdentity({
      headers: { 'X-Session-ID': 'http-session-1' },
      body: { model: 'mock-model' },
    })
    expect(identity).toBe('http-session-1')
    const first = await sched.pick(pool, request({ sessionIdentity: identity, affinityScope: COMPAT }))
    expect(first?.credential.id).toBe('a')
    const second = await sched.pick(pool, request({ sessionIdentity: identity, affinityScope: COMPAT }))
    expect(second?.credential.id).toBe('a')
  })
})
