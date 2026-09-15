/**
 * Public surface of @cpa-edge/core. Everything else in this package is an
 * implementation detail; import through this module only.
 */
export type {
  ClaimHandle,
  JsonPrimitive,
  JsonValue,
  QueueClaim,
  Store,
  UpdateCallback,
} from './store'
export { DEFAULT_RING_CAPACITY, isJsonValue } from './store'
export type { MemoryStoreOptions } from './store-memory'
export { MemoryStore } from './store-memory'
export type { ErrorCode, ErrorDetails, ErrorEnvelope } from './errors'
export { ERROR_CODES, CpaError, createErrorEnvelope, isErrorCode, isErrorEnvelope } from './errors'

// ---------------------------------------------------------------------------
// Scheduling (S4) and runtime capabilities (S7 3.1) - appended by I-core.
// ---------------------------------------------------------------------------

export type { RuntimeCapabilities } from './capabilities'
export {
  CLOUDFLARE_RUNTIME_CAPABILITIES,
  NODE_RUNTIME_CAPABILITIES,
  VERCEL_RUNTIME_CAPABILITIES,
} from './capabilities'

export type {
  ApiKeyCredentialFamily,
  AuthIndexSeedInput,
  CredentialEntryParts,
  CredentialIdentity,
} from './scheduling/identity'
export {
  AUTH_INDEX_FAMILIES,
  StableIdGenerator,
  ascendingCredentialOrder,
  authIndexFromSeed,
  authIndexSeed,
  deriveAuthIndex,
  deriveCredentialIdentity,
  deriveEntrylessCompatibilityIdentity,
  formatSortedHeaders,
  openAiCompatibilityKind,
  stableCredentialDigest,
} from './scheduling/identity'

export type {
  MixedProviderSegment,
  SchedulingCandidate,
  SelectionStrategyName,
  SmoothWeightedPick,
  TransportPreferenceContext,
  WeightedCandidate,
} from './scheduling/strategy'
export {
  MAX_CREDENTIAL_WEIGHT,
  highestReadyPriority,
  legacyPrefersWebsocket,
  legacyWebsocketTierView,
  mixedSegmentAt,
  normalizeSelectionStrategy,
  orderMixedProviders,
  pickFirst,
  pickRoundRobinSuccessor,
  pickSmoothWeighted,
  rotateCandidateList,
  shardPrefersWebsocket,
  shardWebsocketView,
  tierView,
  validateCredentialWeight,
} from './scheduling/strategy'

export type {
  FailureClassification,
  FailureInput,
  FailureKind,
  RequestScopedRule,
  RequestScopedRuleAction,
  RouteKind,
} from './scheduling/classification'
export {
  COMPACT_COOLDOWN_STATUSES,
  COMPACT_FAULT_STOP_STATUSES,
  REQUEST_FAULT_CODES,
  REQUEST_FAULT_TYPES,
  RETRY_ROUND_STATUSES,
  classifyFailure,
  isItemNotPersistedShape,
  isModelNotFoundShape,
  isRequestFaultBody,
  looksLikeCloudflareChallenge,
  matchRequestScopedRule,
  tryParseJson,
} from './scheduling/classification'

export type {
  Availability,
  BlockReason,
  CooldownDocument,
  CooldownFailureDetail,
  CooldownPolicy,
  CooldownViewEntry,
  LastErrorBlock,
  ModelBlock,
  QuotaBlock,
  UnauthorizedBlock,
} from './scheduling/cooldown'
export {
  CLOUDFLARE_STEP_FLOOR_MS,
  COOLDOWN_NAMESPACE,
  FORCE_COOLDOWN_MS,
  NOT_FOUND_COOLDOWN_MS,
  QUOTA_BACKOFF_BASE_MS,
  QUOTA_BACKOFF_MAX_MS,
  QUOTA_RETRY_AFTER_FLOOR_MS,
  TRANSIENT_DEFAULT_COOLDOWN_MS,
  UNAUTHORIZED_COOLDOWN_MS,
  CooldownTracker,
  nextCloudflareCooldown,
  nextQuotaCooldown,
  transientCooldownMs,
} from './scheduling/cooldown'

export type { RetryCandidate, RetryConfig, RetryPlan, RetryPlanInput } from './scheduling/retry'
export {
  credentialAdmitsRound,
  effectiveRequestRetryLimit,
  isRetryRoundEligible,
  maxCredentialsForRound,
  planRetryRound,
} from './scheduling/retry'

export type { SessionBinding, SessionRequestInput } from './scheduling/session'
export {
  DEFAULT_SESSION_AFFINITY_TTL_MS,
  MIN_SESSION_AFFINITY_TTL_MS,
  SESSION_AFFINITY_NAMESPACE,
  SessionAffinityRegistry,
  baseModelKey,
  extractSessionIdentity,
  firstMessageHash,
  normalizeSessionAffinityTtlMs,
  parseGoDurationMs,
  sessionCacheKey,
} from './scheduling/session'

export type {
  AuthSelectionFacts,
  AuthSelectionReason,
  ModelCooldownFacts,
  SchedulingErrorResponse,
} from './scheduling/client-errors'
export {
  UPSTREAM_ERROR_SUMMARY_MAX_RUNES,
  authSelectionMessage,
  bareAuthSelectionMessage,
  buildAuthUnavailableResponse,
  buildModelCooldownResponse,
  buildTerminalAuthResponse,
  formatGoDurationMs,
  sanitizeUpstreamErrorSummary,
} from './scheduling/client-errors'

export type {
  PickRequest,
  PickResult,
  RecordedResult,
  ResultReport,
  ScheduledCredential,
  SchedulerConfig,
} from './scheduling/scheduler'
export { CredentialScheduler, MODEL_POOL_NAMESPACE, ROTATION_NAMESPACE } from './scheduling/scheduler'
