/**
 * Public surface of @cpa-edge/management: the `/v0/management` API and the
 * S6 state layer, mounted on the @cpa-edge/core Store and the composed
 * management auth plane from @cpa-edge/auth.
 */

export { createManagementApi } from './api'
export type {
  ApiCallReply,
  ApiCallRequest,
  ApiCallSender,
  BuildInfo,
  CooldownRecord,
  CooldownSidecar,
  HeaderList,
  LogLineEntry,
  ManagementApi,
  ManagementApiDeps,
  ResponsePlan,
  WireResponse,
} from './api'
export type { ErrorEventInput, UsageCompletion } from './usage'
export type { UsageWireConnection } from './resp'
export { AUTH_FILES_NAMESPACE } from './authfiles'
export { COOLDOWN_NAMESPACE, sidecarName } from './cooldown'
export { LOGS_RING, LOG_RING_CAPACITY } from './logs'
export { USAGE_QUEUE } from './usage'
