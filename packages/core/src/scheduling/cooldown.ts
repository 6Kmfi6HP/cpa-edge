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
import type { JsonValue, Store } from '../store'
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

/** Credential-wide 401-class gate: the credential is unauthorized until `until`. */
export interface UnauthorizedBlock {
  readonly until: number
}

/** Whole cooldown state of one credential. */
export interface CooldownDocument {
  /** Set while a 401-class failure makes the whole credential unschedulable. */
  readonly unauthorized?: UnauthorizedBlock | undefined
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

function isLastError(value: unknown): value is LastErrorBlock {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (typeof record['message'] !== 'string') return false
  const status = record['httpStatus']
  return status === undefined || typeof status === 'number'
}

function isModelBlock(value: unknown): value is ModelBlock {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (typeof record['unavailable'] !== 'boolean') return false
  if (typeof record['statusMessage'] !== 'string') return false
  if (record['lastError'] !== undefined && !isLastError(record['lastError'])) return false
  const nextRetryAfter = record['nextRetryAfter']
  if (nextRetryAfter !== undefined && typeof nextRetryAfter !== 'number') return false
  if (record['quota'] !== undefined && !isQuotaBlock(record['quota'])) return false
  return true
}

function toQuotaBlock(value: unknown): QuotaBlock | undefined {
  return isQuotaBlock(value) ? value : undefined
}

function toModelBlock(value: unknown): ModelBlock | undefined {
  return isModelBlock(value) ? value : undefined
}

function toUnauthorizedBlock(value: unknown): UnauthorizedBlock | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const until = (value as Record<string, unknown>)['until']
  return typeof until === 'number' ? { until } : undefined
}

function toDocument(value: JsonValue | undefined): CooldownDocument {
  if (value === undefined || typeof value !== 'object' || Array.isArray(value)) return EMPTY_DOCUMENT
  const record = value as Record<string, unknown>
  const models = record['models']
  if (typeof models !== 'object' || models === null || Array.isArray(models)) {
    return EMPTY_DOCUMENT
  }
  const parsedModels: Record<string, ModelBlock> = {}
  for (const [key, block] of Object.entries(models)) {
    const modelBlock = toModelBlock(block)
    if (modelBlock !== undefined) parsedModels[key] = modelBlock
  }
  return {
    unauthorized: toUnauthorizedBlock(record['unauthorized']),
    credentialQuota: toQuotaBlock(record['credentialQuota']),
    credentialWide: toModelBlock(record['credentialWide']),
    models: parsedModels,
  }
}

/**
 * Encodes a document for the Store. Documents are plain JSON data by
 * construction; the round-trip both detaches the value and guarantees the
 * stored shape is assignable to `JsonValue`.
 */
function encodeDocument(document: CooldownDocument): JsonValue {
  return JSON.parse(JSON.stringify(document)) as JsonValue
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
  reason: 'quota' | 'credential_quota' | 'cloudflare challenge' = 'quota',
): QuotaBlock {
  const live = existing !== undefined && existing.nextRecoverAt > now
  const level =
    existing !== undefined && live ? (existing.steppedInWindow ? existing.backoffLevel : existing.backoffLevel + 1) : 0
  const ladderMs = Math.min(QUOTA_BACKOFF_BASE_MS * 2 ** level, QUOTA_BACKOFF_MAX_MS)
  const duration = retryAfterMs !== undefined ? Math.max(retryAfterMs, QUOTA_RETRY_AFTER_FLOOR_MS) : ladderMs
  const candidate = now + duration
  const nextRecoverAt =
    existing !== undefined && existing.nextRecoverAt > candidate ? existing.nextRecoverAt : candidate
  return {
    exceeded: true,
    reason,
    nextRecoverAt,
    backoffLevel: level,
    observedAt: now,
    steppedInWindow: live,
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

/** Store namespace holding one cooldown document per credential ID. */
export const COOLDOWN_NAMESPACE = 'cpa-scheduling-cooldown'

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

  /**
   * Whether cooldowns are enabled for a credential:
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
   * disabled cooling; 401-class failures additionally mark the credential
   * unauthorized. A credential-scoped quota failure also propagates
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
    await this.store.update<JsonValue>(COOLDOWN_NAMESPACE, authId, (current) =>
      encodeDocument(
        applyFailure(toDocument(current), {
          model,
          classification,
          detail,
          now,
          coolingEnabled,
          transientCooldownSeconds: this.policy.transientCooldownSeconds,
        }),
      ),
    )
  }

  /**
   * Records a success: the model state clears, and the credential-wide
   * state clears once no other model state remains and no live credential
   * quota window is open.
   */
  async markSuccess(authId: string, model: string | undefined): Promise<void> {
    const now = this.now()
    await this.store.update<JsonValue>(COOLDOWN_NAMESPACE, authId, (current) =>
      encodeDocument(applySuccess(toDocument(current), model, now)),
    )
  }

  /** Availability of one credential for one model at the current time. */
  async availability(authId: string, model: string): Promise<Availability | undefined> {
    return availabilityOf(toDocument(await this.store.get(COOLDOWN_NAMESPACE, authId)), model, this.now())
  }

  /**
   * Quota reset (`POST /v0/management/reset-quota`): clears every per-model
   * state and the credential-wide fields; resolves with the model keys that
   * were cleared before the reset.
   */
  async resetCredential(authId: string): Promise<string[]> {
    const cleared: string[] = []
    await this.store.update<JsonValue>(COOLDOWN_NAMESPACE, authId, (current) => {
      const document = toDocument(current)
      cleared.push(...Object.keys(document.models))
      return encodeDocument(EMPTY_DOCUMENT)
    })
    return cleared
  }

  /** The stored document of one credential (detached copy via the store). */
  async document(authId: string): Promise<CooldownDocument> {
    return toDocument(await this.store.get(COOLDOWN_NAMESPACE, authId))
  }

  /** Cooldown projection for management surfaces: one entry per live block. */
  async snapshot(authId: string): Promise<CooldownViewEntry[]> {
    const document = toDocument(await this.store.get(COOLDOWN_NAMESPACE, authId))
    const now = this.now()
    const entries: CooldownViewEntry[] = []
    const unauthorized = document.unauthorized
    if (unauthorized !== undefined && unauthorized.until > now) {
      entries.push({
        scope: 'credential',
        modelKey: '',
        reason: 'unauthorized',
        retryAt: unauthorized.until,
        remainingSeconds: Math.ceil((unauthorized.until - now) / 1000),
      })
    }
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
      const blockedUntil = Math.max(
        block.nextRetryAfter ?? 0,
        block.quota !== undefined && block.quota.exceeded ? block.quota.nextRecoverAt : 0,
      )
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

function applyFailure(document: CooldownDocument, application: FailureApplication): CooldownDocument {
  const { classification, now, detail } = application
  const lastError: LastErrorBlock | undefined =
    detail.lastErrorMessage !== undefined && detail.lastErrorMessage !== ''
      ? { message: detail.lastErrorMessage, httpStatus: detail.lastErrorHttpStatus }
      : undefined
  const withError = (block: ModelBlock | undefined): ModelBlock => ({
    ...(block ?? { unavailable: false, statusMessage: classification.statusMessage }),
    statusMessage: classification.statusMessage,
    lastError,
  })

  // Credential-scoped quota: one credential-wide window, propagated to
  // every model state (including the failing one).
  if (classification.credentialScoped && classification.kind === 'quota') {
    const credentialQuota = nextQuotaCooldown(
      document.credentialQuota,
      detail.retryAfterMs,
      now,
      'credential_quota',
    )
    const models: Record<string, ModelBlock> = {}
    for (const [key, block] of Object.entries(document.models)) {
      models[key] = { ...block, quota: mergeQuota(block.quota, credentialQuota) }
    }
    if (application.model !== undefined) {
      const base = models[application.model] ?? withError(undefined)
      models[application.model] = {
        ...base,
        statusMessage: classification.statusMessage,
        lastError,
        quota: mergeQuota(base.quota, credentialQuota),
      }
    }
    return { ...document, credentialQuota, models }
  }

  const target: ModelBlock | undefined =
    application.model === undefined ? document.credentialWide : document.models[application.model]

  let next: ModelBlock
  if (classification.cooldown === 'force') {
    next = { ...withError(target), unavailable: true, nextRetryAfter: now + FORCE_COOLDOWN_MS }
  } else if (classification.cooldown === 'none') {
    next = withError(target)
  } else if (!application.coolingEnabled) {
    // Disabled cooling: the error text is recorded, but no block is set.
    next = withError(target)
  } else {
    const ladder = ladderBlock(classification.kind, target, application)
    if (ladder === undefined) {
      next = withError(target)
    } else {
      next = { ...withError(target), unavailable: true, nextRetryAfter: ladder.nextRetryAfter, quota: ladder.quota }
    }
  }

  const unauthorizedKind = classification.kind === 'unauthorized' || classification.kind === 'invalid_grant'
  // A 401-class failure gates the WHOLE credential for 30 minutes (cleared
  // by a refresh, a success on a clean credential, or a quota reset); the
  // ladder block additionally lands on the failing scope. The gate applies
  // regardless of `disable-cooling`: it is an authorization fact, not a
  // cooldown timestamp.
  const unauthorized = unauthorizedKind
    ? { until: now + UNAUTHORIZED_COOLDOWN_MS }
    : document.unauthorized
  if (application.model === undefined) {
    return { ...document, unauthorized, credentialWide: next }
  }
  return {
    ...document,
    unauthorized,
    models: { ...document.models, [application.model]: next },
  }
}

function mergeQuota(existing: QuotaBlock | undefined, propagated: QuotaBlock): QuotaBlock {
  if (existing === undefined) return propagated
  return { ...propagated, nextRecoverAt: Math.max(existing.nextRecoverAt, propagated.nextRecoverAt) }
}

/**
 * Ladder decision: the resolved `nextRetryAfter` (epoch ms) plus, for the
 * quota and Cloudflare kinds, the quota block that carries the window.
 * `undefined` means "no cooldown" (transient cooldowns disabled).
 */
function ladderBlock(
  kind: FailureClassification['kind'],
  target: ModelBlock | undefined,
  application: FailureApplication,
): { nextRetryAfter: number; quota: QuotaBlock | undefined } | undefined {
  const { now, detail } = application
  switch (kind) {
    case 'unauthorized':
    case 'invalid_grant':
    case 'payment_required':
      return { nextRetryAfter: now + UNAUTHORIZED_COOLDOWN_MS, quota: undefined }
    case 'not_found':
    case 'model_not_found':
      return { nextRetryAfter: now + NOT_FOUND_COOLDOWN_MS, quota: undefined }
    case 'quota': {
      const quota = nextQuotaCooldown(target?.quota, detail.retryAfterMs, now)
      return { nextRetryAfter: quota.nextRecoverAt, quota }
    }
    case 'cloudflare': {
      const quota = nextCloudflareCooldown(target?.quota, now)
      return { nextRetryAfter: quota.nextRecoverAt, quota }
    }
    case 'transient':
    case 'request_failed': {
      const duration = transientCooldownMs(application.transientCooldownSeconds, detail.retryAfterMs)
      if (duration === undefined) return undefined
      return { nextRetryAfter: now + duration, quota: undefined }
    }
    default:
      return undefined
  }
}

function applySuccess(document: CooldownDocument, model: string | undefined, now: number): CooldownDocument {
  const models: Record<string, ModelBlock> = { ...document.models }
  if (model !== undefined) delete models[model]
  const liveCredentialQuota =
    document.credentialQuota !== undefined && document.credentialQuota.nextRecoverAt > now
  if (Object.keys(models).length === 0 && !liveCredentialQuota) {
    return { models: {} }
  }
  return { ...document, models }
}

function availabilityOf(document: CooldownDocument, model: string, now: number): Availability | undefined {
  const unauthorized = document.unauthorized
  if (unauthorized !== undefined && unauthorized.until > now) {
    return {
      blocked: true,
      blockedAs: 'unavailable',
      reason: 'unauthorized',
      until: unauthorized.until,
      remainingMs: unauthorized.until - now,
    }
  }
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
  const quotaDominates = quotaUntil >= (block.nextRetryAfter ?? 0)
  return {
    blocked: true,
    blockedAs: quotaDominates ? 'cooldown' : 'unavailable',
    reason: reasonOf(block),
    until,
    remainingMs: until - now,
  }
}
