import { describe, expect, it } from 'vitest'
import { classifyFailure } from './classification'
import { credentialAdmitsRound, effectiveRequestRetryLimit, maxCredentialsForRound, planRetryRound } from './retry'
import type { RetryCandidate } from './retry'

const T0 = 1_700_000_000_000

function candidate(overrides: Partial<RetryCandidate> = {}): RetryCandidate {
  return {
    authId: 'auth-1',
    effectiveLimit: 1,
    readyAt: undefined,
    attemptedQuotaCooldown: false,
    ...overrides,
  }
}

const CONFIG = { requestRetry: 1, maxRetryCredentials: 0, maxRetryIntervalMs: 10_000 }

describe('effective retry limits', () => {
  it('inherits the global value unless the credential overrides', () => {
    expect(effectiveRequestRetryLimit(undefined, 3)).toBe(3)
    expect(effectiveRequestRetryLimit(null, 3)).toBe(3)
    expect(effectiveRequestRetryLimit(-1, 3)).toBe(3)
    expect(effectiveRequestRetryLimit(0, 3)).toBe(0)
    expect(effectiveRequestRetryLimit(5, 3)).toBe(5)
  })

  it('admits everyone to round 0 and limit-gated credentials to later rounds', () => {
    expect(credentialAdmitsRound(0, 0)).toBe(true)
    expect(credentialAdmitsRound(0, 1)).toBe(false)
    expect(credentialAdmitsRound(1, 1)).toBe(true)
    expect(credentialAdmitsRound(1, 2)).toBe(false)
    expect(credentialAdmitsRound(3, 2)).toBe(true)
  })

  it('caps only retry rounds; round 0 sweeps the whole pool', () => {
    expect(maxCredentialsForRound(0, 2)).toBe(Number.POSITIVE_INFINITY)
    expect(maxCredentialsForRound(1, 2)).toBe(2)
    expect(maxCredentialsForRound(1, 0)).toBe(Number.POSITIVE_INFINITY)
    expect(maxCredentialsForRound(1, -3)).toBe(Number.POSITIVE_INFINITY)
  })
})

describe('retry round planning', () => {
  it('starts an immediate round when a credential is already ready', () => {
    const plan = planRetryRound({
      finishedRound: 0,
      classification: classifyFailure({ httpStatus: 500, bodyText: 'x' }),
      config: CONFIG,
      candidates: [candidate()],
      now: T0,
      random: () => 0,
    })
    expect(plan).toEqual({ action: 'retry', round: 1, waitMs: 0 })
  })

  it('waits for the earliest cooldown with jitter bounded by min(wait/4, 2s) (S4-10)', () => {
    const plan = planRetryRound({
      finishedRound: 0,
      classification: classifyFailure({ httpStatus: 500, bodyText: 'x' }),
      config: CONFIG,
      candidates: [candidate({ authId: 'a', readyAt: T0 + 2_000 }), candidate({ authId: 'b', readyAt: T0 + 60_000 })],
      now: T0,
      random: () => 0,
    })
    expect(plan).toEqual({ action: 'retry', round: 1, waitMs: 2_000 })
    const jittered = planRetryRound({
      finishedRound: 0,
      classification: classifyFailure({ httpStatus: 500, bodyText: 'x' }),
      config: CONFIG,
      candidates: [candidate({ readyAt: T0 + 2_000 })],
      now: T0,
      random: () => 0.5,
    })
    expect(jittered.action).toBe('retry')
    if (jittered.action === 'retry') {
      // floor(0.5 * min(2000/4, 2000)) = 250 ms of jitter.
      expect(jittered.waitMs).toBe(2_250)
    }
    // Jitter never exceeds 2 seconds: a 30 s wait jitters by at most 2 s.
    const bigWait = planRetryRound({
      finishedRound: 0,
      classification: classifyFailure({ httpStatus: 500, bodyText: 'x' }),
      config: { ...CONFIG, maxRetryIntervalMs: 60_000 },
      candidates: [candidate({ readyAt: T0 + 30_000 })],
      now: T0,
      random: () => 0.5,
    })
    if (bigWait.action === 'retry') {
      expect(bigWait.waitMs).toBe(30_000 + 1_000)
    }
  })

  it('floors the contribution of an attempted quota-cooling credential at 10s', () => {
    const plan = planRetryRound({
      finishedRound: 0,
      classification: classifyFailure({ httpStatus: 429, bodyText: 'x' }),
      config: { ...CONFIG, requestRetry: 1 },
      candidates: [candidate({ authId: 'a', readyAt: T0 + 1_000, attemptedQuotaCooldown: true })],
      now: T0,
      random: () => 0,
    })
    expect(plan).toEqual({ action: 'retry', round: 1, waitMs: 10_000 })
    // A different ready candidate may still start the round immediately.
    const immediate = planRetryRound({
      finishedRound: 0,
      classification: classifyFailure({ httpStatus: 429, bodyText: 'x' }),
      config: CONFIG,
      candidates: [
        candidate({ authId: 'a', readyAt: T0 + 1_000, attemptedQuotaCooldown: true }),
        candidate({ authId: 'b', readyAt: undefined }),
      ],
      now: T0,
      random: () => 0,
    })
    expect(immediate).toEqual({ action: 'retry', round: 1, waitMs: 0 })
  })

  it('stops instead of waiting past max-retry-interval', () => {
    const plan = planRetryRound({
      finishedRound: 0,
      classification: classifyFailure({ httpStatus: 500, bodyText: 'x' }),
      config: CONFIG,
      candidates: [candidate({ readyAt: T0 + 11_000 })],
      now: T0,
      random: () => 0,
    })
    expect(plan).toEqual({ action: 'stop' })
  })

  it('never waits when max-retry-interval is non-positive', () => {
    const plan = planRetryRound({
      finishedRound: 0,
      classification: classifyFailure({ httpStatus: 500, bodyText: 'x' }),
      config: { ...CONFIG, maxRetryIntervalMs: 0 },
      candidates: [candidate({ readyAt: T0 + 2_000 })],
      now: T0,
      random: () => 0,
    })
    expect(plan).toEqual({ action: 'stop' })
    // An immediate round is still allowed.
    const immediate = planRetryRound({
      finishedRound: 0,
      classification: classifyFailure({ httpStatus: 500, bodyText: 'x' }),
      config: { ...CONFIG, maxRetryIntervalMs: 0 },
      candidates: [candidate()],
      now: T0,
      random: () => 0,
    })
    expect(immediate).toEqual({ action: 'retry', round: 1, waitMs: 0 })
  })

  it('stops without request-retry rounds or on non-eligible failures', () => {
    expect(
      planRetryRound({
        finishedRound: 0,
        classification: classifyFailure({ httpStatus: 500, bodyText: 'x' }),
        config: { ...CONFIG, requestRetry: 0 },
        candidates: [candidate()],
        now: T0,
        random: () => 0,
      }),
    ).toEqual({ action: 'stop' })
    expect(
      planRetryRound({
        finishedRound: 0,
        classification: classifyFailure({ httpStatus: 401, bodyText: 'x' }),
        config: CONFIG,
        candidates: [candidate()],
        now: T0,
        random: () => 0,
      }),
    ).toEqual({ action: 'stop' })
    expect(
      planRetryRound({
        finishedRound: 0,
        classification: classifyFailure({ httpStatus: 400, bodyText: '{"error": {"type": "invalid_request_error"}}' }),
        config: CONFIG,
        candidates: [candidate()],
        now: T0,
        random: () => 0,
      }),
    ).toEqual({ action: 'stop' })
    expect(
      planRetryRound({
        finishedRound: 0,
        classification: classifyFailure({ httpStatus: 520, bodyText: 'x' }),
        config: CONFIG,
        candidates: [candidate()],
        now: T0,
        random: () => 0,
      }),
    ).toEqual({ action: 'stop' })
  })

  it('excludes credentials whose effective limit does not admit the round', () => {
    const plan = planRetryRound({
      finishedRound: 0,
      classification: classifyFailure({ httpStatus: 500, bodyText: 'x' }),
      config: { ...CONFIG, requestRetry: 2 },
      candidates: [candidate({ authId: 'capped', effectiveLimit: 0 })],
      now: T0,
      random: () => 0,
    })
    expect(plan).toEqual({ action: 'stop' })
  })
})
