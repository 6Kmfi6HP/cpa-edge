/**
 * @cpa-edge/runtime-vercel - the serverless-functions runtime (mission
 * T3), degraded per spec/sections/S7-platform-degradation.md (the
 * `runtimes/vercel` column of the F1-F8 matrix).
 *
 * Composition model: the SAME package facades (@cpa-edge/{core, auth,
 * management, translators}) through the shared gateway composition that
 * runtimes/node exports, pinned to {@link VERCEL_RUNTIME_CAPABILITIES}.
 * This package owns what the platform actually changes: the external-KV
 * Store, env/KV config ingestion, the streaming-duration boundary, the
 * S7 degradation overlay, and the function entry.
 *
 * S7 vercel classifications implemented here:
 * - F1 proxy transport: OFF - proxy-credentialed providers are excluded
 *   fail-closed; all-proxied models answer 501 `proxy_unavailable`;
 *   api-call in proxy mode answers the management 501.
 * - F2 plugins: absent project-wide; install answers the F2 501.
 * - F3 file logging: OFF - the logs surface answers 501 when enabled;
 *   the ring substrate persists through the KV Store.
 * - F4 inbound WebSocket: OFF - `GET /v1/ws` keeps the upstream auth
 *   gate, then answers 501 `websocket_unavailable` (OQ-S7-01 seam).
 * - F5a redirect auth-URLs: 501 (no loopback callback server); F5b/F5c
 *   device flows: envelope-only, sessions never complete (NE-S7-11) -
 *   the poll loop that would complete them cannot exist here; the
 *   session registry stays Store-backed with the upstream error ladder.
 * - F6 config: env/KV ingestion, management-writes-only; mutations
 *   persist to KV and apply on the next invocation.
 * - F7 TLS: platform-terminated; the config block is accepted, no-op.
 * - F8 RESP usage output: no listener, no substitute wire; the usage
 *   queue keeps S6 semantics through the KV Store.
 * - Management requires `allow-remote: true` (R-S7-A / note N7): every
 *   management client is remote on this platform.
 *
 * See DEPLOY.md for the deployment recipe, the streaming-budget
 * documentation and the security warnings D1 carries.
 */

export { VERCEL_RUNTIME_CAPABILITIES, type RuntimeCapabilities } from '@cpa-edge/core'

export { KvStore, createInMemoryKvStore, type KvStoreOptions } from './kv-store'
export {
  InMemoryKvDriver,
  RestKvDriver,
  type DriverHook,
  type KvClaimedItem,
  type KvDocument,
  type KvDriver,
  type DocumentExpectation,
  type RestKvDriverOptions,
} from './kv-driver'

export {
  configKvAddress,
  emitBlockYaml,
  effectiveEntryMode,
  globalProxyUrl,
  loadConfigSource,
  parseBlockYaml,
  PROVIDER_FAMILIES,
  resolveProxyMode,
  stripProxiedProviders,
  type LoadConfigSourceOptions,
  type ProxyMode,
  type VercelConfigSource,
} from './config'

export {
  createBoundaryFetch,
  startRequestDeadline,
  type BoundaryConfig,
  type BoundaryFetchLike,
  type RequestDeadline,
  type TimerSeam,
} from './boundary'

export {
  capabilityResponse,
  CORS_BLOCK,
  createRequestOverlay,
  wrapManagementApi,
  FILE_LOGGING_UNAVAILABLE_BODY,
  LOCAL_CALLBACK_UNAVAILABLE_BODY,
  PLUGIN_INSTALL_UNAVAILABLE_BODY,
  PROXY_TRANSPORT_UNAVAILABLE_BODY,
  PROXY_UNAVAILABLE_BODY,
  WEBSOCKET_UNAVAILABLE_BODY,
  type FamilyCandidate,
  type ManagementWrapperOptions,
} from './degradations'

export {
  createVercelGateway,
  DEFAULT_MAX_STREAMING_DURATION_MS,
  type VercelGateway,
  type VercelGatewayOptions,
} from './gateway'

export { createVercelHandler, type VercelHandlerOptions } from './handler'
