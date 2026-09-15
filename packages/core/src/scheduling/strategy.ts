/**
 * Selection strategies: rotation orders, weighted fairness, priority tiers,
 * WebSocket transport preference and cross-provider rotation.
 *
 * Everything here is pure. Callers (the scheduler facade or a runtime) own
 * the cursor state and pass it in; the functions decide WHO is next, never
 * WHEN. Rotation order is defined over ascending credential ID byte order.
 */
import { CpaError } from '../errors'

/** The three selection strategies, after alias normalization. */
export type SelectionStrategyName = 'round-robin' | 'weighted-round-robin' | 'fill-first'

/**
 * Normalizes the configured strategy name. Accepted aliases:
 * `weighted-round-robin`/`weightedroundrobin`/`wrr` and
 * `fill-first`/`fillfirst`/`ff`; any other value falls back to round-robin.
 */
export function normalizeSelectionStrategy(raw: string | undefined): SelectionStrategyName {
  const value = (raw ?? '').trim().toLowerCase()
  if (value === 'weighted-round-robin' || value === 'weightedroundrobin' || value === 'wrr') {
    return 'weighted-round-robin'
  }
  if (value === 'fill-first' || value === 'fillfirst' || value === 'ff') {
    return 'fill-first'
  }
  return 'round-robin'
}

/**
 * Upper bound for a credential weight; larger values are a config-load
 * error (the server refuses to start, a reload is dropped).
 */
export const MAX_CREDENTIAL_WEIGHT = 1_000_000

/**
 * Validates one credential weight at load time. `configPath` is the full
 * dotted config path of the weight field, e.g.
 * `openai-compatibility[0].api-key-entries[0].weight`; the recorded startup
 * failure message is `<path>: weight must not exceed 1000000`.
 * Non-integer weights are rejected the same way (message not recorded; the
 * integer wording is ours).
 */
export function validateCredentialWeight(configPath: string, weight: number): void {
  if (!Number.isInteger(weight) || weight > MAX_CREDENTIAL_WEIGHT) {
    throw new CpaError(
      'invalid-input',
      Number.isInteger(weight)
        ? `${configPath}: weight must not exceed ${MAX_CREDENTIAL_WEIGHT}`
        : `${configPath}: weight must be an integer`,
    )
  }
}

/**
 * Round-robin pick: the first credential ID strictly greater than the
 * last-picked ID in ascending order, wrapping to the smallest. `undefined`
 * when no candidate exists; `lastPickedId === undefined` picks the smallest.
 */
export function pickRoundRobinSuccessor(
  orderedIds: readonly string[],
  lastPickedId: string | undefined,
): string | undefined {
  const first = orderedIds[0]
  if (first === undefined) return undefined
  if (lastPickedId === undefined) return first
  for (const id of orderedIds) {
    if (id > lastPickedId) return id
  }
  return first
}

/** Fill-first pick: the smallest-ID candidate, no cursor. */
export function pickFirst(orderedIds: readonly string[]): string | undefined {
  return orderedIds[0]
}

/** One weighted candidate: its ID and its configured weight. */
export interface WeightedCandidate {
  readonly id: string
  readonly weight: number
}

/** Result of one smooth weighted round-robin step. */
export interface SmoothWeightedPick {
  readonly winner: string | undefined
  readonly currents: Readonly<Record<string, number>>
}

/**
 * Smooth weighted round-robin step (nginx-style): every participating
 * candidate gains its weight, the candidate with the largest current wins
 * (ties go to the earlier ID), and the winner pays back the total weight.
 * Candidates with a non-positive weight are excluded while a weighted
 * strategy is active. With weights 3:1 this yields `A A B A A A B A`.
 */
export function pickSmoothWeighted(
  candidates: readonly WeightedCandidate[],
  currents: Readonly<Record<string, number>>,
): SmoothWeightedPick {
  const active = candidates.filter((candidate) => candidate.weight > 0)
  if (active.length === 0) return { winner: undefined, currents }
  const ordered = [...active].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
  const next: Record<string, number> = {}
  for (const candidate of ordered) {
    next[candidate.id] = (currents[candidate.id] ?? 0) + candidate.weight
  }
  const totalWeight = ordered.reduce((sum, candidate) => sum + candidate.weight, 0)
  let winner: string | undefined
  let winnerCurrent = Number.NEGATIVE_INFINITY
  for (const candidate of ordered) {
    const current = next[candidate.id] ?? 0
    if (current > winnerCurrent) {
      winner = candidate.id
      winnerCurrent = current
    }
  }
  if (winner === undefined) return { winner: undefined, currents }
  next[winner] = winnerCurrent - totalWeight
  return { winner, currents: next }
}

/** A candidate credential as seen by the pick pipeline. */
export interface SchedulingCandidate {
  readonly id: string
  /** Higher tiers are exhausted before lower ones. */
  readonly priority: number
  /** Whether the entry opted into WebSocket transport (`websockets: true`). */
  readonly websocketEnabled: boolean
  readonly ready: boolean
  readonly weight: number
}

/**
 * The highest priority tier that still has a ready candidate;
 * `undefined` when no candidate is ready.
 */
export function highestReadyPriority(candidates: readonly SchedulingCandidate[]): number | undefined {
  let best: number | undefined
  for (const candidate of candidates) {
    if (!candidate.ready) continue
    if (best === undefined || candidate.priority > best) best = candidate.priority
  }
  return best
}

/** Candidates of one tier, ascending by ID. */
export function tierView(candidates: readonly SchedulingCandidate[], priority: number): SchedulingCandidate[] {
  return candidates
    .filter((candidate) => candidate.priority === priority && candidate.ready)
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
}

/** Whether the WebSocket shard preference covers a provider family. */
export function shardPrefersWebsocket(provider: string): boolean {
  return provider === 'codex' || provider === 'xai'
}

/** Whether the legacy selector preference covers a provider family. */
export function legacyPrefersWebsocket(provider: string): boolean {
  return provider === 'codex'
}

/** Context that decides whether a transport preference applies at all. */
export interface TransportPreferenceContext {
  /** True when the downstream request arrived over a WebSocket upgrade. */
  readonly downstreamWebSocket: boolean
  /** Pinned credential ID; an empty string means no pin. */
  readonly pinnedAuthId: string
  /** Provider family of the request surface. */
  readonly provider: string
}

function preferenceApplies(
  context: TransportPreferenceContext,
  family: (provider: string) => boolean,
): boolean {
  return context.downstreamWebSocket && context.pinnedAuthId === '' && family(context.provider)
}

/**
 * Shard-path WebSocket preference: when the downstream request is a
 * WebSocket and nothing is pinned, the ws-enabled sub-view is searched
 * across ALL priority tiers first - a ws-enabled credential in a lower
 * tier beats a non-ws credential in the highest tier. The preference
 * changes the PICK only. An empty ws view falls back to the
 * all-credentials view.
 */
export function shardWebsocketView(
  candidates: readonly SchedulingCandidate[],
  context: TransportPreferenceContext,
): { readonly view: readonly SchedulingCandidate[]; readonly preferred: boolean } {
  if (!preferenceApplies(context, shardPrefersWebsocket)) {
    return { view: candidates, preferred: false }
  }
  const wsView = candidates.filter((candidate) => candidate.websocketEnabled && candidate.ready)
  if (wsView.length === 0) return { view: candidates, preferred: false }
  return { view: wsView, preferred: true }
}

/**
 * Legacy-path WebSocket preference: codex ONLY, applied INSIDE the already
 * collapsed highest priority tier (it never crosses tiers), falling back to
 * the unfiltered tier when no ws-enabled credential exists there.
 */
export function legacyWebsocketTierView(
  tierCandidates: readonly SchedulingCandidate[],
  context: TransportPreferenceContext,
): readonly SchedulingCandidate[] {
  if (!preferenceApplies(context, legacyPrefersWebsocket)) return tierCandidates
  const wsView = tierCandidates.filter((candidate) => candidate.websocketEnabled)
  return wsView.length === 0 ? tierCandidates : wsView
}

/** One provider segment of a cross-provider pool. */
export interface MixedProviderSegment {
  readonly name: string
  /** Credentials of the provider REGISTERED for the model (not ready count). */
  readonly registeredCount: number
  /** Credentials of the provider currently ready. */
  readonly readyCount: number
}

/**
 * Orders provider segments of a mixed pool: registered credential count
 * descending, then provider name ascending.
 */
export function orderMixedProviders(segments: readonly MixedProviderSegment[]): MixedProviderSegment[] {
  return [...segments].sort((left, right) => {
    if (left.registeredCount !== right.registeredCount) {
      return right.registeredCount - left.registeredCount
    }
    return left.name < right.name ? -1 : left.name > right.name ? 1 : 0
  })
}

/**
 * Maps a rotation cursor onto one provider segment: the offset is
 * `cursor % totalReadyWeight` and segments are walked in order, each
 * contributing its ready count. `undefined` when nothing is ready.
 */
export function mixedSegmentAt(
  orderedSegments: readonly MixedProviderSegment[],
  cursor: number,
): MixedProviderSegment | undefined {
  const total = orderedSegments.reduce((sum, segment) => sum + Math.max(segment.readyCount, 0), 0)
  if (total === 0) return undefined
  let offset = cursor % total
  for (const segment of orderedSegments) {
    const size = Math.max(segment.readyCount, 0)
    if (offset < size) return segment
    offset -= size
  }
  return orderedSegments[orderedSegments.length - 1]
}

/**
 * Rotates a candidate list by `offset`: the element at
 * `offset mod length` moves to the front, relative order preserved. The
 * intra-credential model pool uses this so the first upstream model
 * alternates and a failure continues with the next pool model.
 */
export function rotateCandidateList<T>(pool: readonly T[], offset: number): T[] {
  if (pool.length === 0) return []
  const start = ((offset % pool.length) + pool.length) % pool.length
  return [...pool.slice(start), ...pool.slice(0, start)]
}
