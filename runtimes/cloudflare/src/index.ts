/**
 * @cpa-edge/runtime-cloudflare - the Cloudflare Workers runtime
 * (mission T2).
 *
 * One Durable Object is this platform's process: it hosts the
 * @cpa-edge/core Store contract (documents, queues, rings - all under
 * compare-and-swap), composes the same package facades as the node
 * runtime behind the shared S1 routing contract, drives token refresh
 * and RFC-8628 device polls from DO alarms, and holds WebSocket
 * sessions in hibernation. The S7 degradation matrix rows for this
 * runtime are wired here: no proxy egress (F1 501s), no loopback
 * callback servers (F5a 501s), no RESP side-band (F8), no plugin
 * loading (F2, project-wide), management-writes-only config (F6),
 * platform-terminated TLS (F7), DO-backed log ring (F3).
 */
export { CLOUDFLARE_RUNTIME_CAPABILITIES, type RuntimeCapabilities } from '@cpa-edge/core'

export { CpaEdgeDurableObject } from './durable-object'
export { DurableObjectRuntime, type DurableObjectRuntimeOptions } from './runtime'
export { createDurableObjectStore, DurableObjectStore, type DurableObjectStoreOptions } from './do-store'
export {
  createCloudflareGateway,
  directionNotMerged,
  DIRECTIONS,
  type CloudflareGateway,
  type CloudflareGatewayOptions,
  type DirectionSeam,
} from './gateway'
export {
  DEVICE_POLL_PREFIX,
  ensureAlarmBefore,
  IDLE_HEARTBEAT_MS,
  MAINTENANCE_KEY,
  REFRESH_QUEUE_KEY,
  registerDevicePoll,
  runAlarmPass,
  SCHEDULER_NAMESPACE,
  type AlarmPassResult,
  type DevicePollDocument,
  type RefreshQueueDocument,
} from './alarm'
export {
  classifyProxyUrl,
  CONFIG_NAMESPACE,
  CONFIG_TEXT_KEY,
  familyModelEligible,
  normalizeRuntimeConfig,
  resolveConfigText,
  resolveProxyMode,
  type ConfigSource,
  type ImageGenerationMode,
  type NormalizedConfig,
  type ProviderEntry,
  type ProviderFamily,
  type ProxyMode,
  type ResolvedConfigText,
  type RuntimeConfigInput,
} from './config'
export { parseConfigText, ConfigTextError } from './yaml-config'
export { matchRoute, routeExists, ROUTES, type RouteEntry, type RouteMatch } from './router'
export { ModelRegistry, IMAGE_ONLY_MODELS, type RegistryModel, type ResolvedModel } from './registry'
export type {
  CloudflareEnv,
  DoAlarmLike,
  DoStorageLike,
  GatewayBody,
  GatewayRequest,
  GatewayResponse,
  HeaderList,
  RuntimeEnvSources,
  WebSocketHost,
} from './types'
