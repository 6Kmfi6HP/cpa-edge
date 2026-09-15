/**
 * Failover and retry-round semantics.
 *
 * Round 0 always exists and sweeps the whole eligible pool (same-request
 * failover). Additional rounds exist only while `request-retry` admits
 * them, the last failure is retry-round eligible, and the cooldown wait
 * between rounds is allowed and bounded.
 */
import type { FailureClassification } from './classification'
import { QUOTA_RETRY_AFTER_FLOOR_MS } from './cooldown'

/** Global retry configuration (already normalized numbers). */
export interface RetryConfig {
  /** `request-retry`: additional credential retry rounds after round 0. */
  readonly requestRetry: number
  /**
   * `max-retry-credentials`: distinct credentials tried per retry round;
   * `<= 0` means unlimited. Round 0 is never capped - it is the same-request
   * failover sweep.
   */
  readonly maxRetryCredentials: number
  /**
   * `max-retry-interval` in milliseconds: the largest cooldown wait a
   * retry round may take. `<= 0` forbids waits entirely (immediate rounds
   * are still allowed).
   */
  readonly maxRetryIntervalMs: number
}

/**
 * Effective retry limit of one credential: `undefined`/`null`/negative
 * inherits the global value; `0` opts the credential out of every
 * additional round.
 */
export function effectiveRequestRetryLimit(
  credentialOverride: number | null | undefined,
  globalRetry: number,
): number {
  if (credentialOverride === undefined || credentialOverride === null || credentialOverride < 0) {
    return globalRetry
  }
  return credentialOverride
}

/** Whether a credential may serve round `round` (round 0 admits everyone). */
export function credentialAdmitsRound(effectiveLimit: number, round: number): boolean {
  if (round <= 0) return true
  return effectiveLimit >= round
}

/**
 * Distinct-credential cap of one round: unlimited for round 0, else
 * `maxRetryCredentials` when positive, else unlimited.
 */
export function maxCredentialsForRound(round: number, maxRetryCredentials: number): number {
  if (round <= 0) return Number.POSITIVE_INFINITY
  return maxRetryCredentials > 0 ? maxRetryCredentials : Number.POSITIVE_INFINITY
}

/** Whether a failure may start an additional retry round. */
export function isRetryRoundEligible(classification: FailureClassification): boolean {
  return classification.retryRoundEligible && classification.rotation === 'continue'
}

/** One credential as seen by the retry planner. */
export interface RetryCandidate {
  readonly authId: string
  /** Effective retry limit of the credential. */
  readonly effectiveLimit: number
  /** Epoch milliseconds at which the credential becomes schedulable. */
  readonly readyAt: number | undefined
  /**
   * Whether this credential was attempted in the failed round and recorded
   * a quota (429) cooldown with cooling enabled - its contribution to the
   * next-round wait is floored so it can never trigger a zero-wait round.
   */
  readonly attemptedQuotaCooldown: boolean
}

/** Input of the retry-round planner. */
export interface RetryPlanInput {
  /** The round that just ended (0-based). */
  readonly finishedRound: number
  /** Classification of the failure that ended the round. */
  readonly classification: FailureClassification
  readonly config: RetryConfig
  /** All credentials registered for the model, with their retry facts. */
  readonly candidates: readonly RetryCandidate[]
  /** Current time in epoch milliseconds. */
  readonly now: number
  /** Uniform random source in `[0, 1)` used for the wait jitter. */
  readonly random: () => number
}

/** Retry decision for the next round. */
export type RetryPlan =
  | { readonly action: 'stop' }
  | { readonly action: 'retry'; readonly round: number; readonly waitMs: number }

/**
 * Plans the next retry round. A new round happens only when the failure is
 * retry-round eligible, at least one credential admits the round, and the
 * earliest cooldown wait is allowed: waits are forbidden when
 * `max-retry-interval <= 0`, and a wait longer than `max-retry-interval`
 * stops retrying instead of waiting. The wait is jittered by
 * `0..min(wait/4, 2 s)` and never exceeds `max-retry-interval`.
 */
export function planRetryRound(input: RetryPlanInput): RetryPlan {
  const { config, now } = input
  const nextRound = input.finishedRound + 1
  if (nextRound > config.requestRetry) return { action: 'stop' }
  if (!isRetryRoundEligible(input.classification)) return { action: 'stop' }
  const admitted = input.candidates.filter((candidate) => credentialAdmitsRound(candidate.effectiveLimit, nextRound))
  if (admitted.length === 0) return { action: 'stop' }

  const contributions = admitted.map((candidate) => {
    const remaining = candidate.readyAt === undefined ? 0 : Math.max(candidate.readyAt - now, 0)
    // 429 zero-wait prevention: an attempted credential cooling on quota
    // never contributes a zero wait - its contribution is floored at 10 s.
    if (candidate.attemptedQuotaCooldown) return Math.max(remaining, QUOTA_RETRY_AFTER_FLOOR_MS)
    return remaining
  })
  const base = Math.min(...contributions)
  if (base <= 0) return { action: 'retry', round: nextRound, waitMs: 0 }
  if (config.maxRetryIntervalMs <= 0) return { action: 'stop' }
  if (base > config.maxRetryIntervalMs) return { action: 'stop' }
  const jitterMax = Math.min(base / 4, 2_000)
  const jitter = Math.floor(input.random() * jitterMax)
  const waitMs = Math.min(base + jitter, config.maxRetryIntervalMs)
  return { action: 'retry', round: nextRound, waitMs }
}
