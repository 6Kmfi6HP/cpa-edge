/**
 * @cpa-edge/runtime-node - the reference runtime (mission T1).
 *
 * Composes the merged package facades behind the full S1 route surface
 * and serves it over node:http. Re-exports the node capability profile
 * as this platform's single source of truth (S7 §3.1); contract suites
 * may build the gateway with a modified descriptor to exercise
 * degraded paths.
 */
export { NODE_RUNTIME_CAPABILITIES, type RuntimeCapabilities } from '@cpa-edge/core'

export {
  createNodeGateway,
  directionNotMerged,
  DIRECTIONS,
  type DirectionSeam,
  type NodeGateway,
  type NodeGatewayOptions,
  type UpstreamWireRequest,
  type UpstreamWireResponse,
} from './gateway'
export { listenGateway, type GatewayServer, type ListenOptions } from './server'
export {
  FAMILY_ORDER,
  normalizeRuntimeConfig,
  DEFAULT_CLAUDE_BASE_URL,
  type ImageGenerationMode,
  type NormalizedConfig,
  type ProviderEntry,
  type ProviderFamily,
  type ProviderModelEntry,
  type RuntimeConfigInput,
} from './config'
export { ModelRegistry, IMAGE_ONLY_MODELS, type RegistryModel, type ResolvedModel } from './registry'
export {
  matchRoute,
  ROUTES,
  routeExists,
  type RouteEntry,
  type RouteGroup,
  type RouteMatch,
} from './router'
export type { GatewayBody, GatewayBuildInfo, GatewayRequest, GatewayResponse, HeaderList } from './types'

/** Convenience constructor for direct `gateway.handle` calls in tests. */
export function makeGatewayRequest(
  method: string,
  pathAndQuery: string,
  headers: ReadonlyArray<readonly [string, string]> = [],
  body: string | Uint8Array = '',
  host = '127.0.0.1',
): import('./types').GatewayRequest {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body
  return {
    method,
    url: `http://${host}${pathAndQuery}`,
    headers,
    body: bytes,
  }
}
