import { describe, expect, it } from 'vitest'
import { MemoryStore } from '../store-memory'
import { classifyFailure } from './classification'
import {
  CLOUDFLARE_STEP_FLOOR_MS,
  FORCE_COOLDOWN_MS,
  NOT_FOUND_COOLDOWN_MS,
  QUOTA_BACKOFF_MAX_MS,
  QUOTA_RETRY_AFTER_FLOOR_MS,
  TRANSIENT_DEFAULT_COOLDOWN_MS,
  UNAUTHORIZED_COOLDOWN_MS,
  CooldownTracker,
  nextCloudflareCooldown,
  nextQuotaCooldown,
  transientCooldownMs,
} from './cooldown'
import type { CooldownPolicy } from './cooldown'

const T0 = 1_700_000_000_000
const DEFAULT_POLICY: CooldownPolicy = {
  transientCooldownSeconds: 2,
  globalDisableCooling: false,
}

function tracker(clock: { now: number }, policy: CooldownPolicy = DEFAULT_POLICY): CooldownTracker {
  return new CooldownTracker(new MemoryStore(), () => clock.now, policy)
}

function mark(
  t: CooldownTracker,
  clock: { now: number },
  input: Parameters<typeof classifyFailure>[0],
  model = 'mock-model',
  authId = 'auth-1',
  provider = 'openai-compatible-mock-openai',
) {
  return t.markFailure(authId, provider, model, classifyFailure(input), {
    lastErrorMessage: input.bodyText ?? input.errorMessage,
  }).then(() => clock)
}

describe('quota ladder', () => {
  it('starts at 1s and doubles per post-window failure, once per open window', () => {
    const first = nextQuotaCooldown(undefined, undefined, T0)
    expect(first.backoffLevel).toBe(0)
    expect(first.nextRecoverAt - T0).toBe(1_000)
    // A second failure inside the same window steps up once.
    const second = nextQuotaCooldown(first, undefined, T0 + 100)
    expect(second.backoffLevel).toBe(1)
    expect(second.nextRecoverAt - (T0 + 100)).toBe(2_000)
    // Further failures inside the still-open window do not step again, and
    // the re-armed window never shortens a live one (it may extend).
    const third = nextQuotaCooldown(second, undefined, T0 + 200)
    expect(third.backoffLevel).toBe(1)
    expect(third.nextRecoverAt).toBe(T0 + 200 + 2_000)
    const shorter = nextQuotaCooldown(
      { ...second, nextRecoverAt: T0 + 60_000 },
      undefined,
      T0 + 200,
    )
    expect(shorter.nextRecoverAt).toBe(T0 + 60_000)
    // A post-window failure doubles the window again (recorded: the third
    // consecutive 429 cools for 4 s).
    const postWindow = nextQuotaCooldown(third, undefined, third.nextRecoverAt + 1)
    expect(postWindow.backoffLevel).toBe(2)
    expect(postWindow.nextRecoverAt - (third.nextRecoverAt + 1)).toBe(4_000)
  })

  it('caps the ladder at 30 minutes', () => {
    let block = nextQuotaCooldown(undefined, undefined, T0)
    let failures = 1
    while (block.nextRecoverAt - block.observedAt < QUOTA_BACKOFF_MAX_MS) {
      // Post-window failures double the window until the cap.
      const now = block.nextRecoverAt + 1
      block = nextQuotaCooldown(block, undefined, now)
      failures += 1
      expect(failures).toBeLessThan(40)
    }
    expect(block.backoffLevel).toBe(11)
    expect(block.nextRecoverAt - block.observedAt).toBe(QUOTA_BACKOFF_MAX_MS)
  })

  it('floors a Retry-After at 10 seconds and keeps the window monotone', () => {
    const block = nextQuotaCooldown(undefined, 2_000, T0)
    expect(block.nextRecoverAt - T0).toBe(QUOTA_RETRY_AFTER_FLOOR_MS)
    const live = nextQuotaCooldown({ ...block, nextRecoverAt: T0 + 60_000 }, 5_000, T0)
    expect(live.nextRecoverAt).toBe(T0 + 60_000)
  })

  it('cloudflare steps use the quota ladder with a 10s floor', () => {
    const first = nextCloudflareCooldown(undefined, T0)
    expect(first.reason).toBe('cloudflare challenge')
    expect(first.nextRecoverAt - T0).toBe(CLOUDFLARE_STEP_FLOOR_MS)
    const second = nextCloudflareCooldown(first, T0 + 1)
    expect(second.nextRecoverAt - (T0 + 1)).toBe(CLOUDFLARE_STEP_FLOOR_MS)
    expect(second.backoffLevel).toBe(1)
  })
})

describe('transient ladder', () => {
  it('maps the config value: 0 = legacy 60s, negative = off, positive = seconds', () => {
    expect(transientCooldownMs(0, undefined)).toBe(TRANSIENT_DEFAULT_COOLDOWN_MS)
    expect(transientCooldownMs(-1, undefined)).toBeUndefined()
    expect(transientCooldownMs(2, undefined)).toBe(2_000)
    expect(transientCooldownMs(2, 250)).toBe(250)
    expect(transientCooldownMs(2, -5)).toBe(2_000)
  })
})

describe('cooldown tracker', () => {
  it('blocks a model for 12h on a 404 and isolates other models (S4-16)', async () => {
    const clock = { now: T0 }
    const t = tracker(clock)
    await mark(t, clock, { httpStatus: 404, bodyText: '{"error": {"code": 404, "message": "x", "status": "NOT_FOUND"}}' }, 'iso-model-1')
    const blocked = await t.availability('auth-1', 'iso-model-1')
    expect(blocked?.blocked).toBe(true)
    expect(blocked?.reason).toBe('not_found')
    expect(blocked?.remainingMs).toBe(NOT_FOUND_COOLDOWN_MS)
    const free = await t.availability('auth-1', 'iso-model-2')
    expect(free).toBeUndefined()
  })

  it('marks 401 as a credential-wide 30-minute unauthorized gate', async () => {
    const clock = { now: T0 }
    const t = tracker(clock)
    await mark(t, clock, { httpStatus: 401, bodyText: '{"error": "invalid"}' }, 'model-a')
    for (const model of ['model-a', 'model-b']) {
      const blocked = await t.availability('auth-1', model)
      expect(blocked?.reason).toBe('unauthorized')
      expect(blocked?.remainingMs).toBe(UNAUTHORIZED_COOLDOWN_MS)
    }
  })

  it('cools quota at the ladder and recovers after the window (S4-06)', async () => {
    const clock = { now: T0 }
    const t = tracker(clock)
    await mark(t, clock, { httpStatus: 429, bodyText: '{"error": "slow down"}' })
    let blocked = await t.availability('auth-1', 'mock-model')
    expect(blocked?.blockedAs).toBe('cooldown')
    expect(blocked?.reason).toBe('quota')
    expect(blocked?.remainingMs).toBe(1_000)
    clock.now = T0 + 1_000
    expect(await t.availability('auth-1', 'mock-model')).toBeUndefined()
  })

  it('propagates a credential-scoped 429 to sibling model states', async () => {
    const clock = { now: T0 }
    const t = tracker(clock)
    await mark(t, clock, { httpStatus: 500, bodyText: 'x' }, 'model-a')
    await mark(t, clock, { httpStatus: 429, bodyText: 'x', credentialScoped: true }, 'model-b')
    const document = await t.document('auth-1')
    expect(document.credentialQuota?.reason).toBe('credential_quota')
    expect(document.credentialQuota?.nextRecoverAt).toBeGreaterThan(T0)
    for (const model of ['model-a', 'model-b', 'model-c']) {
      const blocked = await t.availability('auth-1', model)
      expect(blocked?.reason).toBe('credential_quota')
    }
  })

  it('applies the transient config and disables transient-only cooldowns when negative (S4-17)', async () => {
    const clock = { now: T0 }
    const off = tracker(clock, { transientCooldownSeconds: -1, globalDisableCooling: false })
    await mark(off, clock, { httpStatus: 500, bodyText: 'x' })
    expect(await off.availability('auth-1', 'mock-model')).toBeUndefined()
    await mark(off, clock, { httpStatus: 429, bodyText: 'x' })
    expect((await off.availability('auth-1', 'mock-model'))?.blocked).toBe(true)
  })

  it('never blocks while cooling is disabled, but force-cooldowns still apply', async () => {
    const clock = { now: T0 }
    const t = tracker(clock, {
      transientCooldownSeconds: 2,
      globalDisableCooling: false,
      credentialCoolingOverride: () => true,
    })
    await mark(t, clock, { httpStatus: 500, bodyText: 'x' })
    expect(await t.availability('auth-1', 'mock-model')).toBeUndefined()
    await mark(t, clock, {
      httpStatus: 500,
      bodyText: 'x',
      requestScopedRules: [{ match: ['x'], action: 'continue-and-cooldown' }],
    })
    const forced = await t.availability('auth-1', 'mock-model')
    expect(forced?.remainingMs).toBe(FORCE_COOLDOWN_MS)
  })

  it('prefers the credential override over the provider override over the global flag', () => {
    const t = tracker({ now: T0 }, {
      transientCooldownSeconds: 2,
      globalDisableCooling: true,
      providerCoolingOverride: (provider) => (provider === 'openai-compatible-x' ? false : undefined),
      credentialCoolingOverride: (authId) => (authId === 'auth-1' ? false : undefined),
    })
    expect(t.coolingEnabledFor('auth-1', 'openai-compatible-x')).toBe(true)
    expect(t.coolingEnabledFor('auth-2', 'openai-compatible-x')).toBe(true)
    expect(t.coolingEnabledFor('auth-2', 'other')).toBe(false)
  })

  it('skips neutral failures entirely (S4-22)', async () => {
    const clock = { now: T0 }
    const t = tracker(clock)
    const classification = classifyFailure({
      route: 'count-tokens',
      httpStatus: 404,
      bodyText: '{"error": {"code": 404, "message": "x", "status": "NOT_FOUND"}}',
    })
    expect(classification.neutral).toBe(true)
    await t.markFailure('auth-1', 'gemini', 'ctm', classification, {})
    expect(await t.document('auth-1')).toEqual({ models: {} })
    expect(await t.availability('auth-1', 'ctm')).toBeUndefined()
  })

  it('clears the model state on success and the credential state once clean', async () => {
    const clock = { now: T0 }
    const t = tracker(clock)
    await mark(t, clock, { httpStatus: 500, bodyText: 'x' }, 'model-a')
    await mark(t, clock, { httpStatus: 500, bodyText: 'x' }, 'model-b')
    await t.markSuccess('auth-1', 'model-a')
    expect(await t.availability('auth-1', 'model-a')).toBeUndefined()
    expect((await t.availability('auth-1', 'model-b'))?.blocked).toBe(true)
    await t.markSuccess('auth-1', 'model-b')
    expect(await t.document('auth-1')).toEqual({ models: {} })
  })

  it('keeps a live credential_quota window on success', async () => {
    const clock = { now: T0 }
    const t = tracker(clock)
    await mark(t, clock, { httpStatus: 429, bodyText: 'x', credentialScoped: true }, 'model-a')
    await t.markSuccess('auth-1', 'model-a')
    const blocked = await t.availability('auth-1', 'model-b')
    expect(blocked?.reason).toBe('credential_quota')
  })

  it('reset-quota clears every state and makes the credential schedulable immediately (S4-07)', async () => {
    const clock = { now: T0 }
    const t = tracker(clock)
    await mark(t, clock, { httpStatus: 429, bodyText: 'x' }, 'mock-model')
    expect((await t.availability('auth-1', 'mock-model'))?.blocked).toBe(true)
    const cleared = await t.resetCredential('auth-1')
    expect(cleared).toEqual(['mock-model'])
    expect(await t.availability('auth-1', 'mock-model')).toBeUndefined()
  })

  it('survives a hot-reload by living in the store (S4-14)', async () => {
    const clock = { now: T0 }
    const store = new MemoryStore({ now: () => clock.now })
    const first = new CooldownTracker(store, () => clock.now, DEFAULT_POLICY)
    await mark(first, clock, { httpStatus: 401, bodyText: '{"error": "x"}' }, 'mock-model')
    // A reload swaps the tracker object but keeps the same store.
    const second = new CooldownTracker(store, () => clock.now, DEFAULT_POLICY)
    const blocked = await second.availability('auth-1', 'mock-model')
    expect(blocked?.reason).toBe('unauthorized')
    expect(blocked?.remainingMs).toBe(UNAUTHORIZED_COOLDOWN_MS)
  })

  it('projects live blocks for management surfaces', async () => {
    const clock = { now: T0 }
    const t = tracker(clock)
    await mark(t, clock, { httpStatus: 429, bodyText: 'x' }, 'mock-model')
    await mark(t, clock, { httpStatus: 500, bodyText: 'y' }, 'other-model')
    const entries = await t.snapshot('auth-1')
    expect(entries).toHaveLength(2)
    expect(entries.map((entry) => [entry.scope, entry.modelKey, entry.reason])).toContainEqual([
      'model',
      'mock-model',
      'quota',
    ])
    expect(entries.map((entry) => [entry.scope, entry.modelKey, entry.reason])).toContainEqual([
      'model',
      'other-model',
      'transient_error',
    ])
    for (const entry of entries) {
      expect(entry.remainingSeconds).toBeGreaterThan(0)
    }
  })
})
