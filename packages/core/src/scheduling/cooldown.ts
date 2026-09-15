/**
 * Cooldown state machine: which failure puts a credential (or one of its
 * models) on ice, for how long, and when the ice melts.
 *
 * All state lives in the Store as one JSON document per credential, so it
 * survives hot-reload with whatever backing store the runtime provides. A
 * memory-backed store clears cooldowns on process restart - the same
 * semantics upstream has without `save-cooldown-status`.
 *
 * Every duration decision is a pure function; the tracker only sequences
 * reads and writes. All timing flows through the injected clock.
 */
import type { Store, JsonValue } from '../store'
import type { FailureClassification } from './classification'

/** 401 / 402 / 403 / invalid_grant cool down for 30 minutes. */
export const UNAUTHORIZED_COOLDOWN_MS = 30 * 60 * 1000
/** A 404 cools the model down for 12 hours. */
export const NOT_FOUND_COOLDOWN_MS = 12 * 60 * 60 * 1000
/** Quota backoff ladder: `1s * 2^level`, capped at 30 minutes. */
export const QUOTA_BACKOFF_BASE_MS = 1_000
export const QUOTA_BACKOFF_MAX_MS = 30 * 60 * 1000
/** A quota `Retry-After` shorter than 10 seconds is raised to 10 seconds. */
export const QUOTA_RETRY_AFTER_FLOOR_MS = 10_000
/** Transient errors cool for 60 seconds when the config value is 0 (legacy). */
export const TRANSIENT_DEFAULT_COOLDOWN_MS = 60_000
/** Each Cloudflare step floors the quota ladder at 10 seconds. */
export const CLOUDFLARE_STEP_FLOOR_MS = 10_000
/** Force-cooldown (rule actions) is 60 seconds and ignores disable-cooling. */
export const FORCE_COOLDOWN_MS = 60_000

/** Why a credential or model is blocked. */
export type BlockReason =
  | 'quota'
  | 'credential_quota'
  | 'cloudflare_challenge'
  | 'invalid_grant'
  | 'unauthorized'
  | 'payment_required'
  | 'not_found'
  | 'model_not_supported'
  | 'transient_error'
  | 'unknown'

/** Quota state of one scope (model or credential-wide). */
export interface QuotaBlock {
  readonly exceeded: boolean
  readonly reason: 'quota' | 'credential_quota' | 'cloudflare challenge'
  /** Epoch milliseconds after which the scope is schedulable again. */
  readonly nextRecoverAt: number
  readonly backoffLevel: number
  readonly observedAt: number
  /** Whether the level already stepped up inside the still-open window. */
  readonly steppedInWindow: boolean
}

/** Last upstream error recorded for one scope. */
export interface LastErrorBlock {
  readonly message: string
  readonly httpStatus?: number | undefined
}

/** State of one (credential, model) pair. */
export interface ModelBlock {
  readonly unavailable: boolean
  readonly statusMessage: string
  readonly lastError?: LastErrorBlock | undefined
  readonly nextRetryAfter?: number | undefined
  readonly quota?: QuotaBlock | undefined
}

/** Whole cooldown state of one credential. */
export interface CooldownDocument {
  readonly unauthorized: boolean
  readonly credentialQuota?: QuotaBlock | undefined
  /** Ladder block applying to the whole credential (no model key). */
  readonly credentialWide?: ModelBlock | undefined
  readonly models: Readonly<Record<string, ModelBlock>>
}

/** How the cooldown policy is configured. */
export interface CooldownPolicy {
  /**
   * `transient-error-cooldown-seconds`: 0 = legacy 60 s, negative disables
   * transient cooldowns only (quota cooldowns are unaffected), positive is
   * the cooldown in seconds.
   */
  readonly transientCooldownSeconds: number
  /** Global `disable-cooling`. */
  readonly globalDisableCooling: boolean
  /** Per-provider explicit override (true disables, false enables). */
  readonly providerCoolingOverride?: ((provider: string) => boolean | undefined) | undefined
  /** Per-credential explicit override; wins over the provider override. */
  readonly credentialCoolingOverride?: ((authId: string) => boolean | undefined) | undefined
}

const EMPTY_DOCUMENT: CooldownDocument = Object.freeze({
  unauthorized: false,
  models: Object.freeze({}) as Readonly<Record<string, ModelBlock>>,
})

function isQuotaBlock(value: unknown): value is QuotaBlock {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record['exceeded'] === 'boolean' &&
    typeof record['reason'] === 'string' &&
    typeof record['nextRecoverAt'] === 'number' &&
    typeof record['backoffLevel'] === 'number' &&
    typeof record['observedAt'] === 'number' &&
    typeof record['steppedInWindow'] === 'boolean'
  )
}

function isModelBlock(value: unknown): value is ModelBlock {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record['unavailable'] === 'boolean' && typeof record['statusMessage'] === 'string'
}

function isDocument(value: unknown): value is CooldownDocument {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (typeof record['unauthorized'] !== 'boolean') return false
  if (record['credentialQuota'] !== undefined && !isQuotaBlock(record['credentialQuota'])) return false
  if (record['credentialWide'] !== undefined && !isModelBlock(record['credentialWide'])) return false
  const models = record['models']
  if (typeof models !== 'object' || models === null || Array.isArray(models)) return false
  for (const block of Object.values(models as Record<string, unknown>)) {
    if (!isModelBlock(block)) return false
  }
  return true
}

function toDocument(value: JsonValue | undefined): CooldownDocument {
  if (value !== undefined && isDocument(value)) return value
  return EMPTY_DOCUMENT
}

/**
 * Next quota cooldown from the ladder. The level steps up at most once per
 * still-open window and resets once the window has lapsed; a live window is
 * never shortened. `retryAfterMs`, when present, overrides the ladder
 * duration and is floored at 10 seconds.
 */
export function nextQuotaCooldown(
  existing: QuotaBlock | undefined,
  retryAfterMs: number | undefined,
  now: number,
  reason: 'quota' | 'credential_quota' = 'quota',
): QuotaBlock {
  const live = existing !== undefined && existing.nextRecoverAt > now
  const level = live ? (existing!.steppedInWindow ? existing!.backoffLevel : existing!.backoffLevel + 1) : 0
  const stepped = live
  const ladderMs = Math.min(QUOTA_BACKOFF_BASE_MS * 2 ** level, QUOTA_BACKOFF_MAX_MS)
  const duration = retryAfterMs !== undefined ? Math.max(retryAfterMs, QUOTA_RETRY_AFTER_FLOOR_MS) : ladderMs
  const candidate = now + duration
  const nextRecoverAt =
    live && existing !== undefined && existing.nextRecoverAt > candidate ? existing.nextRecoverAt : candidate
  return {
    exceeded: true,
    reason,
    nextRecoverAt,
    backoffLevel: level,
    observedAt: now,
    steppedInWindow: stepped,
  }
}

/**
 * Cloudflare cooldown: the quota ladder with a 10 second floor per step,
 * reason `cloudflare challenge`.
 */
export function nextCloudflareCooldown(existing: QuotaBlock | undefined, now: number): QuotaBlock {
  const stepped = nextQuotaCooldown(existing, undefined, now, 'cloudflare challenge')
  const duration = Math.max(stepped.nextRecoverAt - now, CLOUDFLARE_STEP_FLOOR_MS)
  const candidate = now + duration
  const nextRecoverAt =
    existing !== undefined && existing.nextRecoverAt > now && existing.nextRecoverAt > candidate
      ? existing.nextRecoverAt
      : candidate
  return { ...stepped, nextRecoverAt }
}

/**
 * Transient cooldown in milliseconds: a positive `Retry-After` wins, else
 * the configured value (0 = legacy 60 s, negative = no cooldown).
 */
export function transientCooldownMs(
  transientCooldownSeconds: number,
  retryAfterMs: number | undefined,
): number | undefined {
  if (retryAfterMs !== undefined && retryAfterMs > 0) return retryAfterMs
  if (transientCooldownSeconds < 0) return undefined
  if (transientCooldownSeconds === 0) return TRANSIENT_DEFAULT_COOLDOWN_MS
  return transientCooldownSeconds * 1_000
}

/** Availability of one credential for one model. */
export interface Availability {
  readonly blocked: boolean
  /** `cooldown` for quota blocks, `unavailable` for everything else. */
  readonly blockedAs: 'cooldown' | 'unavailable'
  readonly reason: BlockReason
  readonly until: number
  readonly remainingMs: number
}

/** Failure facts the tracker needs beyond the classification. */
export interface CooldownFailureDetail {
  /** `Retry-After` in milliseconds when the upstream sent one. */
  readonly retryAfterMs?: number | undefined
  /** Last upstream error text, surfaced verbatim in error envelopes. */
  readonly lastErrorMessage?: string | undefined
  readonly lastErrorHttpStatus?: number | undefined
}

/**
 * Store-backed cooldown tracker. One instance per gateway; the constructor
 * arguments are the only state it touches.
 */
export class CooldownTracker {
  private readonly store: Store
  private readonly now: () => number
  private readonly policy: CooldownPolicy

  constructor(store: Store, now: () => number, policy: CooldownPolicy) {
    this.store = store
    this.now = now
    this.policy = policy
  }

  /** Store namespace holding one cooldown document per credential ID. */
  static readonly NAMESPACE = 'cpa-scheduling-cooldown'

  /**
   * Whether cooldowns are disabled for a credential:
   * per-credential override > per-provider override > global flag.
   * Force-cooldowns bypass this decision.
   */
  coolingEnabledFor(authId: string, provider: string): boolean {
    const credentialOverride = this.policy.credentialCoolingOverride?.(authId)
    if (credentialOverride !== undefined) return !credentialOverride
    const providerOverride = this.policy.providerCoolingOverride?.(provider)
    if (providerOverride !== undefined) return !providerOverride
    return !this.policy.globalDisableCooling
  }

  /**
   * Records one failure. Neutral failures change nothing. Failures whose
   * classification says `none` record the error text but set no block.
   * Ladder failures set the model-scoped (or, without a model,
   * credential-wide) block; force failures set a 60 s block that survives
   * disabled cooling. A credential-scoped quota failure also propagates
   * `credential_quota` to every sibling model state.
   */
  async markFailure(
    authId: string,
    provider: string,
    model: string | undefined,
    classification: FailureClassification,
    detail: CooldownFailureDetail = {},
  ): Promise<void> {
    if (classification.neutral) return
    const now = this.now()
    const coolingEnabled = this.coolingEnabledFor(authId, provider)
    await this.store.update<CooldownDocument>(CooldownTracker.NAMESPACE, authId, (current) => {
      const document = toDocument(current)
      const next: CooldownDocument = applyFailure(document, {
        model,
        classification,
        detail,
        now,
        coolingEnabled,
        transientCooldownSeconds: this.policy.transientCooldownSeconds,
      })
      return next as unknown as CooldownDocument & JsonValue
    })
  }

  /** Records a success: the model state clears, and the credential-wide
   * state clears once no other model is blocked and no live credential
   * quota window remains. */
  async markSuccess(authId: string, model: string | undefined): Promise<void> {
    const now = this.now()
    await this.store.update<CooldownDocument>(CooldownTracker.NAMESPACE, authId, (current) => {
      const document = toDocument(current)
      return applySuccess(document, model, now) as unknown as CooldownDocument & JsonValue
    })
  }

  /** Availability of one credential for one model at the current time. */
  async availability(authId: string, model: string): Promise<Availability | undefined> {
    const raw = await this.store.get(CooldownTracker.NAMESPACE, authId)
    const document = toDocument(raw)
    return availabilityOf(document, model, this.now())
  }

  /** Quota reset (`POST /v0/management/reset-quota`): clears every
   * per-model state and the credential-wide fields; resolves with the
   * model keys that were cleared. */
  async resetCredential(authId: string): Promise<string[]> {
    const result = await this.store.update<CooldownDocument>(CooldownTracker.NAMESPACE, authId, (current) => {
      const document = toDocument(current)
      return (EMPTY_DOCUMENT as unknown) as CooldownDocument & JsonValue
    })
    return Object.keys(toDocument(result as unknown as JsonValue | undefined).models)
  }

  /** The stored document of one credential (detached copy via the store). */
  async document(authId: string): Promise<CooldownDocument> {
    return toDocument(await this.store.get(CooldownTracker.NAMESPACE, authId))
  }

  /**
   * Cooldown projection for management surfaces: one entry per live block.
   */
  async snapshot(authId: string): Promise<CooldownViewEntry[]> {
    const document = toDocument(await this.store.get(CooldownTracker.NAMESPACE, authId))
    const now = this.now()
    const entries: CooldownViewEntry[] = []
    const quota = document.credentialQuota
    if (quota !== undefined && quota.nextRecoverAt > now) {
      entries.push({
        scope: 'credential',
        modelKey: '',
        reason: quota.reason === 'cloudflare challenge' ? 'cloudflare_challenge' : quota.reason,
        retryAt: quota.nextRecoverAt,
        remainingSeconds: Math.ceil((quota.nextRecoverAt - now) / 1000),
        backoffLevel: quota.backoffLevel,
      })
    }
    for (const [modelKey, block] of Object.entries(document.models)) {
      const blockedUntil = block.nextRetryAfter ?? (block.quota !== undefined ? block.quota.nextRecoverAt : 0)
      if (blockedUntil <= now) continue
      entries.push({
        scope: 'model',
        modelKey,
        reason: reasonOf(block),
        retryAt: blockedUntil,
        remainingSeconds: Math.ceil((blockedUntil - now) / 1000),
      })
    }
    return entries
  }
}

/** One projected cooldown entry (the `cooldowns` field of /auth-files). */
export interface CooldownViewEntry {
  readonly scope: 'credential' | 'model'
  readonly modelKey: string
  readonly reason: BlockReason
  readonly retryAt: number
  readonly remainingSeconds: number
  readonly backoffLevel?: number | undefined
}

function reasonOf(block: ModelBlock): BlockReason {
  if (block.quota !== undefined && block.quota.exceeded) {
    if (block.quota.reason === 'cloudflare challenge') return 'cloudflare_challenge'
    if (block.quota.reason === 'credential_quota') return 'credential_quota'
    return 'quota'
  }
  switch (block.statusMessage) {
    case 'unauthorized':
      return 'unauthorized'
    case 'invalid_grant':
      return 'invalid_grant'
    case 'payment_required':
      return 'payment_required'
    case 'not_found':
      return 'not_found'
    case 'model_not_supported':
      return 'model_not_supported'
    case 'quota exhausted':
      return 'quota'
    case 'cloudflare challenge':
      return 'cloudflare_challenge'
    case 'transient upstream error':
      return 'transient_error'
    default:
      return 'unknown'
  }
}

interface FailureApplication {
  readonly model: string | undefined
  readonly classification: FailureClassification
  readonly detail: CooldownFailureDetail
  readonly now: number
  readonly coolingEnabled: boolean
  readonly transientCooldownSeconds: number
}

function lastErrorOf(application: FailureApplication): LastErrorBlock | undefined {
  const message = application.detail.lastErrorMessage
  if (message === undefined || message === '') return undefined
  const block: LastErrorBlock = { message, httpStatus: application.detail.lastErrorHttpStatus }
  return block
}

function applyFailure(document: CooldownDocument, application: FailureApplication): CooldownDocument {
  const { classification, now, detail } = application
  const lastError = lastErrorOf(application)
  const withError = (block: ModelBlock | undefined): ModelBlock => {
    const base: ModelBlock = block ?? {
      unavailable: false,
      statusMessage: classification.statusMessage,
    }
    return { ...base, statusMessage: classification.statusMessage, lastError }
  }

  // Credential-scoped quota: credential-wide window plus propagation to
  // every model state.
  if (classification.credentialScoped && classification.kind === 'quota') {
    const credentialQuota = nextQuotaCooldown(
      document.credentialQuota,
      detail.retryAfterMs,
      now,
      'credential_quota',
    )
    const models: Record<string, ModelBlock> = {}
    const propagated: QuotaBlock = { ...credentialQuota, reason: 'credential_quota' }
    for (const [key, block] of Object.entries(document.models)) {
      models[key] = {
        ...block,
        quota: mergeQuota(block.quota, propagated, now),
      }
    }
    if (application.model !== undefined && models[application.model] === undefined) {
      models[application.model] = withError(undefined)
    }
    if (application.model !== undefined) {
      const existing = models[application.model]
      if (existing !== undefined) {
        models[application.model] = {
          ...existing,
          quota: mergeQuota(existing.quota, propagated, now),
        }
      }
    }
    return { ...document, credentialQuota, models }
  }

  const target: ModelBlock | undefined =
    application.model === undefined ? document.credentialWide : document.models[application.model]

  let next: ModelBlock
  if (classification.cooldown === 'force') {
    const base = withError(target)
    next = { ...base, unavailable: true, nextRetryAfter: now + FORCE_COOLDOWN_MS }
  } else if (classification.cooldown === 'none') {
    next = withError(target)
  } else {
    // Ladder cooldowns; disabled cooling records the error without a block.
    if (!application.coolingEnabled) {
      next = withError(target)
    } else {
      const duration = ladderDurationMs(classification, application)
      if (duration === undefined) {
        next = withError(target)
      } else {
        const base = withError(target)
        const quota =
          classification.kind === 'quota'
            ? nextQuotaCooldown(target?.quota, detail.retryAfterMs, now)
            : classification.kind === 'cloudflare'
              ? nextCloudflareCooldown(target?.quota, now)
              : undefined
        next = {
          ...base,
          unavailable: true,
          nextRetryAfter: now + duration,
          quota: quota !== undefined ? { ...quota, exceeded: true } : base.quota,
        }
      }
    }
  }

  if (classification.kind === 'unauthorized' || classification.kind === 'invalid_grant') {
    const unauthorized = true
    if (application.model === undefined) {
      return { ...document, unauthorized, credentialWide: next }
    }
    return {
      ...document,
      unauthorized,
      models: { ...document.models, [application.model]: next },
    }
  }
  if (application.model === undefined) {
    return { ...document, credentialWide: next }
  }
  return { ...document, models: { ...document.models, [application.model]: next } }
}

function mergeQuota(existing: QuotaBlock | undefined, propagated: QuotaBlock, _now: number): QuotaBlock {
  if (existing === undefined) return propagated
  const nextRecoverAt = Math.max(existing.nextRecoverAt, propagated.nextRecoverAt)
  return { ...propagated, nextRecoverAt }
}

function ladderDurationMs(
  classification: FailureClassification,
  application: FailureApplication,
): number | undefined {
  switch (classification.kind) {
    case 'unauthorized':
    case 'invalid_grant':
    case 'payment_required':
      return UNAUTHORIZED_COOLDOWN_MS
    case 'not_found':
    case 'model_not_found':
      return NOT_FOUND_COOLDOWN_MS
    case 'quota':
    case 'cloudflare': {
      const block = nextQuotaCooldown(
        undefined,
        application.detail.retryAfterMs,
        application.now,
        classification.kind === 'cloudflare' ? 'cloudflare challenge' : 'quota',
      )
      if (classification.kind === 'cloudflare') {
        return Math.max(block.nextRecoverAt - application.now, CLOUDFLARE_STEP_FLOOR_MS)
      }
      return block.nextRecoverAt - application.now
    }
    case 'transient':
    case 'request_failed':
      return transientCooldownMs(application.transientCooldownSeconds, application.detail.retryAfterMs)
    case 'force_cooldown':
      return FORCE_COOLDOWN_MS
    default:
      return undefined
  }
}

function applySuccess(document: CooldownDocument, model: string | undefined, now: number): CooldownDocument {
  let models = document.models
  if (model !== undefined) {
    const rest: Record<string, ModelBlock> = { ...models }
    delete rest[model]
    models = rest
  }
  const liveCredentialQuota =
    document.credentialQuota !== undefined && document.credentialQuota.nextRecoverAt > now
  const remainingBlocks = Object.values(models).some(
    (block) => (block.nextRetryAfter ?? 0) > now || (block.quota !== undefined && block.quota.nextRecoverAt > now),
  )
  const credentialWideLive =
    document.credentialWide !== undefined && (document.credentialWide.nextRetryAfter ?? 0) > now
  if (Object.keys(models).length === 0 && !liveCredentialQuota && !remainingBlocks && !credentialWideLive) {
    return { unauthorized: false, models: {} }
  }
  return { ...document, models, credentialWide: liveCredentialQuota ? document.credentialWide : undefined }
}

function availabilityOf(document: CooldownDocument, model: string, now: number): Availability | undefined {
  const credentialQuota = document.credentialQuota
  if (credentialQuota !== undefined && credentialQuota.nextRecoverAt > now) {
    return {
      blocked: true,
      blockedAs: 'cooldown',
      reason: 'credential_quota',
      until: credentialQuota.nextRecoverAt,
      remainingMs: credentialQuota.nextRecoverAt - now,
    }
  }
  const wide = document.credentialWide
  if (wide !== undefined && (wide.nextRetryAfter ?? 0) > now) {
    return {
      blocked: true,
      blockedAs: 'unavailable',
      reason: reasonOf(wide),
      until: wide.nextRetryAfter ?? now,
      remainingMs: (wide.nextRetryAfter ?? now) - now,
    }
  }
  const block = document.models[model]
  if (block === undefined) return undefined
  const quotaUntil = block.quota !== undefined && block.quota.exceeded ? block.quota.nextRecoverAt : 0
  const until = Math.max(block.nextRetryAfter ?? 0, quotaUntil)
  if (until <= now) return undefined
  const quotaBlock = quotaUntil >= (block.nextRetryAfter ?? 0)
  return {
    blocked: true,
    blockedAs: quotaBlock ? 'cooldown' : 'unavailable',
    reason: reasonOf(block),
    until,
    remainingMs: until - now,
  }
}
