/**
 * Store-backed credential scheduler: the composition of strategies,
 * cooldowns, session affinity and retry admission over one credential
 * snapshot.
 *
 * The registry itself is caller-owned: every call passes the CURRENT
 * credential snapshot (a hot-reload swaps it), so the scheduler holds no
 * registry state. What it does keep in the Store - rotation cursors, WRR
 * currents, cooldown documents, affinity bindings, model-pool offsets -
 * survives hot-reloads. Routing changes reset cursors through
 * {@link CredentialScheduler.resetRotationCursors}.
 *
 * The execution loop (prepare, upstream calls, retry rounds) lives with the
 * executors and runtimes; this module answers WHO is next, WHO is blocked,
 * and WHAT a result means.
 */
import type { JsonValue, Store } from '../store'
import { classifyFailure } from './classification'
import type { FailureClassification, FailureInput, RouteKind } from './classification'
import { CooldownTracker } from './cooldown'
import type { Availability, CooldownPolicy } from './cooldown'
import {
  credentialAdmitsRound,
  effectiveRequestRetryLimit,
  maxCredentialsForRound,
} from './retry'
import type { RetryConfig } from './retry'
import {
  highestReadyPriority,
  legacyWebsocketTierView,
  mixedSegmentAt,
  orderMixedProviders,
  pickFirst,
  pickRoundRobinSuccessor,
  pickSmoothWeighted,
  rotateCandidateList,
  shardWebsocketView,
  tierView,
} from './strategy'
import type { MixedProviderSegment, SchedulingCandidate, SelectionStrategyName } from './strategy'
import { normalizeSelectionStrategy } from './strategy'
import { SessionAffinityRegistry, sessionCacheKey } from './session'
import { deriveAuthIndex } from './identity'
import type { AuthIndexSeedInput } from './identity'

/** Store namespace of rotation cursor documents. */
export const ROTATION_NAMESPACE = 'cpa-scheduling-rotation'

/** Store namespace of intra-credential model-pool offsets. */
export const MODEL_POOL_NAMESPACE = 'cpa-scheduling-model-pool'

/** One credential as registered for scheduling. */
export interface ScheduledCredential {
  /** Full credential ID (`<kind>:<12hex>`). */
  readonly id: string
  /** Provider display name (`gemini`, `codex`, `openai-compatible-<name>`). */
  readonly provider: string
  /** Selection models the credential serves. */
  readonly models: readonly string[]
  readonly priority: number
  readonly weight: number
  readonly websocketEnabled: boolean
  readonly disabled: boolean
  /** Per-credential `request-retry` override (undefined/null inherits). */
  readonly requestRetryOverride?: number | null | undefined
}

/** Normalized scheduling configuration. */
export interface SchedulerConfig extends CooldownPolicy, RetryConfig {
  /** Raw `routing.strategy` value; normalized internally. */
  readonly strategy: string
  /** `routing.session-affinity`. */
  readonly sessionAffinity: boolean
  /** `routing.session-affinity-ttl` in milliseconds (already normalized). */
  readonly sessionAffinityTtlMs: number
  /** `routing.session-affinity-subagents` (default true). */
  readonly sessionAffinitySubagents: boolean
}

/** One credential pick request. */
export interface PickRequest {
  /** Resolved selection model. */
  readonly model: string
  /** Credential IDs already tried in the current round. */
  readonly tried: readonly string[]
  /** Retry round this pick belongs to (0 = the same-request sweep). */
  readonly round?: number | undefined
  /** Session identity, when affinity is on (from `extractSessionIdentity`). */
  readonly sessionIdentity?: string | undefined
  /** Parent session identity for subagent inheritance. */
  readonly parentSessionIdentity?: string | undefined
  /** Provider scope of the affinity cache key; defaults to the surface provider. */
  readonly affinityScope?: string | undefined
  /** True when the downstream request arrived over a WebSocket upgrade. */
  readonly downstreamWebSocket?: boolean
  /** Pinned credential ID; empty string means no pin. */
  readonly pinnedAuthId?: string | undefined
  /** Provider of the request surface (WebSocket preference scope). */
  readonly surfaceProvider?: string | undefined
}

/** The chosen credential plus affinity bookkeeping facts. */
export interface PickResult {
  readonly credential: ScheduledCredential
  /** Whether the pick came from a live session binding (no cursor advance). */
  readonly fromAffinity: boolean
  /** The affinity cache key that was bound, when a fresh binding was made. */
  readonly boundCacheKey: string | undefined
}

/** A request result to record. */
export interface ResultReport {
  readonly authId: string
  readonly provider: string
  /** Model key of the cooldown state (the credential's selection model). */
  readonly model: string | undefined
  readonly success: boolean
  /** Classification inputs; required when `success` is false. */
  readonly failure?: FailureInput | undefined
  /** `Retry-After` in milliseconds, when the upstream sent one. */
  readonly retryAfterMs?: number | undefined
  /** Last upstream error text, recorded verbatim (truncated on output). */
  readonly lastErrorMessage?: string | undefined
  readonly lastErrorHttpStatus?: number | undefined
  readonly route?: RouteKind | undefined
  /** Session identity of the request, when affinity is on. */
  readonly sessionIdentity?: string | undefined
  readonly affinityScope?: string | undefined
}

/** What recording a result produced. */
export interface RecordedResult {
  readonly classification: FailureClassification | undefined
}

interface RotationDocument {
  readonly lastId?: string | undefined
  readonly currents: Readonly<Record<string, number>>
  readonly mixedCursor: number
}

const EMPTY_ROTATION: RotationDocument = Object.freeze({ currents: {}, mixedCursor: 0 })

function toRotation(value: JsonValue | undefined): RotationDocument {
  if (value === undefined || typeof value !== 'object' || Array.isArray(value)) return EMPTY_ROTATION
  const record = value as Record<string, unknown>
  const currents = record['currents']
  const lastId = record['lastId']
  const mixedCursor = record['mixedCursor']
  return {
    lastId: typeof lastId === 'string' ? lastId : undefined,
    currents:
      typeof currents === 'object' && currents !== null && !Array.isArray(currents)
        ? (currents as Record<string, number>)
        : {},
    mixedCursor: typeof mixedCursor === 'number' ? mixedCursor : 0,
  }
}

function encodeRotation(document: RotationDocument): JsonValue {
  return JSON.parse(JSON.stringify(document)) as JsonValue
}

/**
 * The scheduling facade. Construct one per gateway; pass a `MemoryStore`
 * only in tests or ephemeral deployments - cooldowns and cursors then vanish
 * on restart, exactly like an unsaved upstream state.
 */
export class CredentialScheduler {
  private readonly store: Store
  private readonly now: () => number
  private readonly config: SchedulerConfig
  private readonly cooldowns: CooldownTracker
  private readonly affinity: SessionAffinityRegistry
  private readonly strategy: SelectionStrategyName

  constructor(store: Store, now: () => number, config: SchedulerConfig) {
    this.store = store
    this.now = now
    this.config = config
    this.strategy = normalizeSelectionStrategy(config.strategy)
    this.cooldowns = new CooldownTracker(store, now, config)
    this.affinity = new SessionAffinityRegistry(store, now)
  }

  /** The cooldown tracker, for management surfaces and reset-quota. */
  get cooldownTracker(): CooldownTracker {
    return this.cooldowns
  }

  /** The affinity registry, for tests and management surfaces. */
  get affinityRegistry(): SessionAffinityRegistry {
    return this.affinity
  }

  /**
   * Whether the WebSocket preference runs on the shard path (built-in
   * strategies) or the legacy path (session affinity active): with affinity
   * ON the preference covers codex only and never crosses priority tiers.
   */
  private get websocketPreferencePath(): 'shard' | 'legacy' {
    return this.config.sessionAffinity ? 'legacy' : 'shard'
  }

  private rotationKey(providersKey: string, model: string, priority: number): string {
    return `rotation|${providersKey}|${model}|${priority}`
  }

  private mixedKey(providersKey: string, model: string): string {
    return `mixed|${providersKey}|${model}`
  }

  private providersKey(providers: readonly string[]): string {
    return [...providers].sort().join(',')
  }

  /**
   * Picks the next credential for a request. `credentials` is the current
   * snapshot of the registry. Resolves `undefined` when no credential is
   * eligible.
   */
  async pick(credentials: readonly ScheduledCredential[], request: PickRequest): Promise<PickResult | undefined> {
    const round = request.round ?? 0
    const model = request.model
    const blocked = new Map<string, Availability>()
    const eligible: ScheduledCredential[] = []
    for (const credential of credentials) {
      if (credential.disabled) continue
      if (!credential.models.includes(model)) continue
      if (request.tried.includes(credential.id)) continue
      const effectiveLimit = effectiveRequestRetryLimit(credential.requestRetryOverride, this.config.requestRetry)
      if (!credentialAdmitsRound(effectiveLimit, round)) continue
      const availability = await this.cooldowns.availability(credential.id, model)
      if (availability !== undefined) {
        blocked.set(credential.id, availability)
        continue
      }
      eligible.push(credential)
    }
    const roundCap = maxCredentialsForRound(round, this.config.maxRetryCredentials)
    if (round > 0 && request.tried.length >= roundCap) {
      // The distinct-credential cap of a retry round is exhausted.
      return undefined
    }
    if (eligible.length === 0) return undefined

    // Pinned credentials bypass every other rule.
    const pinned = request.pinnedAuthId ?? ''
    if (pinned !== '') {
      const pinnedCredential = eligible.find((credential) => credential.id === pinned)
      if (pinnedCredential !== undefined) {
        return { credential: pinnedCredential, fromAffinity: false, boundCacheKey: undefined }
      }
    }

    // Session affinity: a live binding outranks priority and strategy and
    // does not advance any cursor.
    const scope = request.affinityScope ?? request.surfaceProvider ?? ''
    if (this.config.sessionAffinity) {
      const key = this.affinityCacheKey(scope, model, request)
      if (key !== undefined) {
        const binding = await this.affinity.get(key)
        if (binding !== undefined) {
          const bound = eligible.find((credential) => credential.id === binding.authId)
          if (bound !== undefined) {
            return { credential: bound, fromAffinity: true, boundCacheKey: undefined }
          }
        }
      }
    }

    const picked = await this.pickWithStrategy(eligible, credentials, request, model)
    if (picked === undefined) return undefined

    let boundCacheKey: string | undefined
    if (this.config.sessionAffinity) {
      const key = this.affinityCacheKey(scope, model, request)
      if (key !== undefined) {
        await this.affinity.bind(key, picked.id, this.config.sessionAffinityTtlMs)
        boundCacheKey = key
      }
    }
    return { credential: picked, fromAffinity: false, boundCacheKey }
  }

  private affinityCacheKey(scope: string, model: string, request: PickRequest): string | undefined {
    if (this.config.sessionAffinitySubagents && request.parentSessionIdentity !== undefined) {
      return sessionCacheKey(scope, request.parentSessionIdentity, model)
    }
    if (request.sessionIdentity !== undefined) {
      return sessionCacheKey(scope, request.sessionIdentity, model)
    }
    return undefined
  }

  private async pickWithStrategy(
    eligible: readonly ScheduledCredential[],
    all: readonly ScheduledCredential[],
    request: PickRequest,
    model: string,
  ): Promise<ScheduledCredential | undefined> {
    const surfaceProvider = request.surfaceProvider ?? ''
    const candidates: SchedulingCandidate[] = eligible.map((credential) => ({
      id: credential.id,
      priority: credential.priority,
      websocketEnabled: credential.websocketEnabled,
      ready: true,
      weight: credential.weight,
    }))
    const context = {
      downstreamWebSocket: request.downstreamWebSocket === true,
      pinnedAuthId: request.pinnedAuthId ?? '',
      provider: surfaceProvider,
    }

    // Collapse to the participating view: the shard path searches the
    // ws-enabled sub-view across ALL priority tiers first; the legacy path
    // (session affinity active) filters codex-only inside the already
    // collapsed highest tier and never crosses tiers.
    let view: readonly SchedulingCandidate[]
    if (this.websocketPreferencePath === 'shard') {
      view = shardWebsocketView(candidates, context).view
    } else {
      const priority = highestReadyPriority(candidates)
      if (priority === undefined) return undefined
      view = legacyWebsocketTierView(tierView(candidates, priority), context)
    }
    if (view.length === 0) return undefined

    const byId = new Map(eligible.map((credential) => [credential.id, credential]))
    const orderedView = credentials0(view, byId)
    const providers = uniqueProviders(view, eligible)
    const providersKey = this.providersKey(providers)

    if (providers.length <= 1) {
      // Single provider: the strategy runs inside the tiered view.
      return this.pickWithin(orderedView, providersKey, model)
    }

    // Mixed pools: weighted runs over the merged, ID-sorted view; the
    // cursor state of a mixed pool lives in one document per
    // (provider-list, model).
    const segments = orderMixedProviders(registeredSegments(providers, all, model, view))
    if (this.strategy === 'weighted-round-robin') {
      return this.pickSmooth(orderedView, this.mixedKey(providersKey, model))
    }
    if (this.strategy === 'fill-first') {
      // Walk the provider list in segment order; take the first provider
      // with a ready credential, then its smallest-ID candidate.
      for (const segment of segments) {
        const segmentCandidates = orderedView.filter(
          (credential) => byId.get(credential.id)?.provider === segment.name,
        )
        if (segmentCandidates.length > 0) return segmentCandidates[0]
      }
      return undefined
    }
    // round-robin across segments: the cursor advances per pick; the
    // chosen segment contributes its ready candidates, and the successor
    // rule applies within the segment.
    const key = this.mixedKey(providersKey, model)
    const updated = await this.store.update<JsonValue>(ROTATION_NAMESPACE, key, (current) => {
      const rotation = toRotation(current)
      const segment = mixedSegmentAt(segments, rotation.mixedCursor)
      if (segment === undefined) return encodeRotation(rotation)
      const segmentCandidates = orderedView.filter(
        (credential) => byId.get(credential.id)?.provider === segment.name,
      )
      const winnerId =
        this.strategy === 'round-robin'
          ? pickRoundRobinSuccessor(segmentCandidates.map((c) => c.id), rotation.lastId)
          : segmentCandidates[0]?.id
      if (winnerId === undefined) {
        return encodeRotation({ ...rotation, mixedCursor: rotation.mixedCursor + 1 })
      }
      return encodeRotation({
        lastId: winnerId,
        currents: rotation.currents,
        mixedCursor: rotation.mixedCursor + 1,
      })
    })
    const rotation = toRotation(updated)
    const winnerId = rotation.lastId
    if (winnerId === undefined) return undefined
    return byId.get(winnerId) ?? orderedView[0]
  }

  private async pickWithin(
    ordered: readonly ScheduledCredential[],
    providersKey: string,
    model: string,
  ): Promise<ScheduledCredential | undefined> {
    if (ordered.length === 0) return undefined
    // The bucket key uses the highest priority in the view: tier views are
    // uniform, and a WebSocket shard view that spans tiers shares one
    // bucket.
    const priority = Math.max(...ordered.map((credential) => credential.priority))
    const key = this.rotationKey(providersKey, model, priority)
    const updated = await this.store.update<JsonValue>(ROTATION_NAMESPACE, key, (current) => {
      const rotation = toRotation(current)
      const ids = ordered.map((credential) => credential.id)
      let winnerId: string | undefined
      let currents = rotation.currents
      if (this.strategy === 'fill-first') {
        winnerId = pickFirst(ids)
      } else if (this.strategy === 'weighted-round-robin') {
        const pick = pickSmoothWeighted(
          ordered.map((credential) => ({ id: credential.id, weight: credential.weight })),
          rotation.currents,
        )
        winnerId = pick.winner
        currents = pick.currents
      } else {
        winnerId = pickRoundRobinSuccessor(ids, rotation.lastId)
      }
      return encodeRotation({
        lastId: winnerId ?? rotation.lastId,
        currents,
        mixedCursor: rotation.mixedCursor,
      })
    })
    const rotation = toRotation(updated)
    const winnerId = rotation.lastId
    const winner = winnerId === undefined ? undefined : ordered.find((credential) => credential.id === winnerId)
    return winner ?? ordered[0]
  }

  /** Smooth WRR over an ordered view with its own cursor document. */
  private async pickSmooth(
    ordered: readonly ScheduledCredential[],
    key: string,
  ): Promise<ScheduledCredential | undefined> {
    const updated = await this.store.update<JsonValue>(ROTATION_NAMESPACE, key, (current) => {
      const rotation = toRotation(current)
      const pick = pickSmoothWeighted(
        ordered.map((credential) => ({ id: credential.id, weight: credential.weight })),
        rotation.currents,
      )
      return encodeRotation({
        lastId: pick.winner ?? rotation.lastId,
        currents: pick.currents,
        mixedCursor: rotation.mixedCursor,
      })
    })
    const rotation = toRotation(updated)
    const winnerId = rotation.lastId
    const winner = winnerId === undefined ? undefined : ordered.find((credential) => credential.id === winnerId)
    return winner ?? ordered[0]
  }

  /**
   * Records a request result: classifies failures, applies cooldowns,
   * refreshes or drops affinity bindings. Request-scoped, lifecycle and
   * neutral failures preserve bindings; everything credential-attributed
   * unbinds.
   */
  async recordResult(report: ResultReport): Promise<RecordedResult> {
    let classification: FailureClassification | undefined
    if (report.success) {
      await this.cooldowns.markSuccess(report.authId, report.model)
    } else if (report.failure !== undefined) {
      classification = classifyFailure(report.failure)
      await this.cooldowns.markFailure(report.authId, report.provider, report.model, classification, {
        retryAfterMs: report.retryAfterMs,
        lastErrorMessage: report.lastErrorMessage,
        lastErrorHttpStatus: report.lastErrorHttpStatus,
      })
    }
    if (this.config.sessionAffinity && report.sessionIdentity !== undefined) {
      const scope = report.affinityScope ?? report.provider
      const key = sessionCacheKey(scope, report.sessionIdentity, report.model ?? '')
      if (report.success) {
        await this.affinity.refresh(key, report.authId, this.config.sessionAffinityTtlMs)
      } else if (
        classification !== undefined &&
        !preservesBinding(classification)
      ) {
        await this.affinity.unbind(key, report.authId)
      }
    }
    return { classification }
  }

  /**
   * Availability of one credential for one model, when the caller needs it
   * outside a pick (for example to build the 503 shape).
   */
  async availability(authId: string, model: string): Promise<Availability | undefined> {
    return this.cooldowns.availability(authId, model)
  }

  /**
   * Intra-credential model-pool candidates: rotates the pool by the
   * per-(credential, provider, model) offset, which increments once per
   * request; the first entry is tried first and a failure continues with
   * the next entry on the same credential.
   */
  async modelPoolCandidates(
    authId: string,
    provider: string,
    model: string,
    pool: readonly string[],
  ): Promise<readonly string[]> {
    if (pool.length <= 1) return pool
    const key = `${authId}|${provider}|${model}`
    const updated = await this.store.update<JsonValue>(MODEL_POOL_NAMESPACE, key, (current) => {
      const offset = typeof current === 'number' ? current + 1 : 0
      return offset
    })
    const offset = typeof updated === 'number' ? updated : 0
    return rotateCandidateList(pool, offset)
  }

  /**
   * Resets every rotation cursor and WRR current. Upstream replaces the
   * selector object on any `routing.*` change, which resets cursors.
   */
  async resetRotationCursors(): Promise<void> {
    const keys = await this.store.list(ROTATION_NAMESPACE)
    for (const key of keys) {
      await this.store.delete(ROTATION_NAMESPACE, key)
    }
  }

  /**
   * Derives the `auth_index` of a registered credential (convenience
   * passthrough so callers need one import).
   */
  static async authIndex(seedInput: AuthIndexSeedInput): Promise<string> {
    return deriveAuthIndex(seedInput)
  }
}

function preservesBinding(classification: FailureClassification): boolean {
  return (
    classification.neutral ||
    classification.kind === 'request_scoped' ||
    classification.kind === 'connection_lifecycle' ||
    classification.kind === 'transient_transport'
  )
}

function uniqueProviders(
  view: readonly SchedulingCandidate[],
  eligible: readonly ScheduledCredential[],
): string[] {
  const byId = new Map(eligible.map((credential) => [credential.id, credential]))
  const providers: string[] = []
  for (const candidate of view) {
    const provider = byId.get(candidate.id)?.provider
    if (provider !== undefined && !providers.includes(provider)) providers.push(provider)
  }
  return providers
}

function credentials0(
  view: readonly SchedulingCandidate[],
  byId: Map<string, ScheduledCredential>,
): ScheduledCredential[] {
  return view
    .map((candidate) => byId.get(candidate.id))
    .filter((credential): credential is ScheduledCredential => credential !== undefined)
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
}

function registeredSegments(
  providers: readonly string[],
  all: readonly ScheduledCredential[],
  model: string,
  view: readonly SchedulingCandidate[],
): MixedProviderSegment[] {
  const byId = new Map(all.map((credential) => [credential.id, credential]))
  const readyCounts = new Map<string, number>()
  for (const candidate of view) {
    const provider = byId.get(candidate.id)?.provider ?? ''
    readyCounts.set(provider, (readyCounts.get(provider) ?? 0) + 1)
  }
  return providers.map((name) => ({
    name,
    registeredCount: all.filter(
      (credential) => credential.provider === name && credential.models.includes(model),
    ).length,
    readyCount: readyCounts.get(name) ?? 0,
  }))
}
