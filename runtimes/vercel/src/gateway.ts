/**
 * The Vercel gateway composition (mission T3, R2).
 *
 * This runtime does not fork the routing logic: it composes the SAME
 * package facades through the shared gateway composition that
 * `runtimes/node` exports, pinned to the vercel capability profile
 * (S7 §3.1: the descriptor is passed in, never a module singleton).
 * That is the architecture S7 itself records - contract suites drive
 * degraded paths by running the shared composition under a modified
 * descriptor - so the platform adapter stays thin and behavior stays in
 * one place. Everything vercel-specific lives around it:
 *
 * - the external-KV `Store` (no Durable Objects on this platform);
 * - env/KV config ingestion with no filesystem watcher (F6);
 * - the streaming-duration boundary on the upstream transport (R3);
 * - the S7 vercel degradation overlay (501 seams, fail-closed proxy
 *   exclusion, management persistence of config mutations);
 * - `allow-remote` reality: every management client is remote here, so
 *   management only works with `remote-management.allow-remote: true`
 *   (R-S7-A / S7 note N7 - a deployment-topology fact, enforced by the
 *   shared management auth, not re-implemented here).
 *
 * TLS is platform-terminated (F7), the RESP usage side-band has no
 * listener and no substitute wire (F8), plugins are absent project-wide
 * (F2) - none of these need code beyond what the composition already
 * carries; the DEPLOY notes record them.
 */

import { VERCEL_RUNTIME_CAPABILITIES, type Store } from '@cpa-edge/core'
import { createManagementApi, type ApiCallSender, type BuildInfo } from '@cpa-edge/management'
import { gem2oai } from '@cpa-edge/translators'
import {
  createNodeGateway,
  matchRoute,
  normalizeRuntimeConfig,
  ModelRegistry,
  DEFAULT_CLAUDE_BASE_URL,
  type GatewayRequest,
  type GatewayResponse,
  type NodeGateway,
} from '@cpa-edge/runtime-node'
import { createBoundaryFetch, startRequestDeadline, type BoundaryConfig, type BoundaryFetchLike } from './boundary'
import {
  effectiveEntryMode,
  globalProxyUrl,
  PROVIDER_FAMILIES,
  stripProxiedProviders,
  type VercelConfigSource,
} from './config'
import {
  createRequestOverlay,
  wrapManagementApi,
  type FamilyCandidate,
} from './degradations'

/** Build identity stamped into management responses (the anchor build). */
const ANCHOR_BUILD_INFO: BuildInfo = {
  version: 'v7.3.4',
  commit: '8335eac',
  buildDate: '2026-09-15T14:07:06Z',
  supportPlugin: true,
}

/** Options of {@link createVercelGateway}. */
export interface VercelGatewayOptions {
  /** The invocation's config source (record + YAML text). */
  readonly configSource: VercelConfigSource
  /** Platform Store (the KV-backed one in production). */
  readonly store: Store
  /** Epoch-milliseconds clock; defaults to `Date.now`. */
  readonly now?: () => number
  /** Upstream transport; defaults to the global `fetch`. */
  readonly fetch?: BoundaryFetchLike
  /** Client address hint for the management loopback gate. */
  readonly remoteAddress?: string
  /**
   * Streaming budget for the whole invocation (R3). `undefined` keeps
   * the default; `null` disables the boundary entirely.
   */
  readonly maxStreamingDurationMs?: number | null
  /** Test-only byte budget for the boundary guard. */
  readonly boundaryMaxBytes?: number
  /** Test-only timer seam for the boundary guard. */
  readonly boundaryTimers?: BoundaryConfig['timers']
  /** MANAGEMENT_PASSWORD-style env fallback for the management key. */
  readonly envManagementPassword?: string
  /** Best-effort config persistence hook (management mutations). */
  readonly persistConfig?: (yaml: string) => Promise<void>
}

/** The composed vercel gateway. */
export interface VercelGateway {
  handle(request: GatewayRequest): Promise<GatewayResponse>
  readonly capabilities: typeof VERCEL_RUNTIME_CAPABILITIES
  readonly store: Store
  /** The shared composition underneath (diagnostics, contract seams). */
  readonly inner: NodeGateway
}

/** Default streaming budget: 300 s plan ceiling minus a safety margin. */
export const DEFAULT_MAX_STREAMING_DURATION_MS = 240_000

/**
 * Builds the vercel gateway for one invocation: shared composition with
 * the vercel descriptor, KV-backed Store, boundary-guarded transport
 * and the degradation overlay in front.
 */
export function createVercelGateway(options: VercelGatewayOptions): VercelGateway {
  const now = options.now ?? (() => Date.now())
  const fullRecord = options.configSource.record
  const globalProxy = globalProxyUrl(fullRecord)

  // Fail-closed proxy exclusion (NE-S7-01): proxied providers never
  // reach the shared composition's schedulers.
  const gatewayRecord = stripProxiedProviders(
    fullRecord,
    proxiedIndexes(fullRecord, globalProxy),
  )

  // Boundary-guarded transport (R3): one deadline per invocation, every
  // upstream call spends what remains.
  const maxDurationMs =
    options.maxStreamingDurationMs === null
      ? undefined
      : options.maxStreamingDurationMs ?? DEFAULT_MAX_STREAMING_DURATION_MS
  const boundaryConfig: BoundaryConfig = {
    maxDurationMs,
    ...(options.boundaryMaxBytes === undefined ? {} : { maxBytes: options.boundaryMaxBytes }),
    ...(options.boundaryTimers === undefined ? {} : { timers: options.boundaryTimers }),
  }
  const deadline = startRequestDeadline({ ...boundaryConfig, now })
  const upstreamFetch: BoundaryFetchLike =
    options.fetch ?? ((url, init) => fetch(url, init))
  const send = createBoundaryFetch(upstreamFetch, deadline, boundaryConfig)

  // Model resolution runs over the FULL record (proxied providers
  // included) so the overlay can 501 their models instead of letting
  // them fall into the unknown-model ladder (S7 §2.3-F1-3/4).
  const fullNormalized = normalizeRuntimeConfig(fullRecord)
  const fullRegistry = new ModelRegistry(fullNormalized.providers)
  const candidatesByFamily = buildCandidatesByFamily(fullRecord, fullNormalized.providers, globalProxy)

  // Management composition: same rule as the shared gateway - a facade
  // exists only when a management key is configured. The wrapper adds
  // the S7 vercel replacements and the config-persistence hook.
  const managementSecret =
    fullNormalized.remoteManagement.secretKey.length > 0
      ? fullNormalized.remoteManagement.secretKey
      : options.envManagementPassword ?? ''
  const wsAuthView = { value: fullRecord['ws-auth'] !== false }
  const persist = options.persistConfig
  const wrappedManagement =
    managementSecret.length > 0 && options.configSource.yaml.length > 0
      ? wrapManagementApi(
          createManagementApi({
            configYaml: options.configSource.yaml,
            managementKey: managementSecret,
            store: options.store,
            buildInfo: ANCHOR_BUILD_INFO,
            ...(options.remoteAddress === undefined ? {} : { clientIp: options.remoteAddress }),
            now,
            sendUpstream: createApiCallSender(send),
          }),
          {
            globalProxyUrl: globalProxy,
            wsAuthView,
            ...(persist === undefined ? {} : { persistConfig: persist }),
          },
        )
      : undefined

  const inner = createNodeGateway({
    config: gatewayRecord,
    store: options.store,
    now,
    fetch: send,
    capabilities: VERCEL_RUNTIME_CAPABILITIES,
    ...(options.remoteAddress === undefined ? {} : { remoteAddress: options.remoteAddress }),
    ...(options.configSource.yaml.length > 0 ? { configYaml: options.configSource.yaml } : {}),
    ...(wrappedManagement === undefined ? {} : { managementApi: wrappedManagement }),
  })

  const overlay = createRequestOverlay({
    authenticateProxy: (request) => inner.plane.authenticateProxy(request),
    matchRoute,
    candidatesByFamily,
    isImageModel: (model) => fullRegistry.isImageModel(model),
    wsAuthView,
    parseModelMethod: (action) => gem2oai.parseModelMethod(action),
  })

  return {
    async handle(request) {
      const seized = await overlay(request)
      if (seized !== undefined) return seized
      return await inner.handle(request)
    },
    capabilities: VERCEL_RUNTIME_CAPABILITIES,
    store: options.store,
    inner,
  }
}

/** The api-call transport (direct egress, boundary-guarded). */
function createApiCallSender(send: BoundaryFetchLike): ApiCallSender {
  return async (request) => {
    const headers: Record<string, string> = {}
    for (const [name, value] of request.headers) headers[name] = value
    const response = await send(request.url, {
      method: request.method,
      headers,
      ...(request.body.length === 0 ? {} : { body: request.body }),
    })
    const responseHeaders: Array<[string, string]> = []
    response.headers.forEach((value, name) => {
      responseHeaders.push([name, value])
    })
    return {
      status: response.status,
      headers: responseHeaders,
      body: await response.text(),
    }
  }
}

// ---------------------------------------------------------------------------
// Provider pairing (raw record -> normalized entries)
// ---------------------------------------------------------------------------

/** Indexes (over the raw section arrays) of proxy-mode provider entries. */
function proxiedIndexes(
  record: Readonly<Record<string, unknown>>,
  global: string,
): ReadonlyMap<string, ReadonlySet<number>> {
  const out = new Map<string, ReadonlySet<number>>()
  for (const family of PROVIDER_FAMILIES) {
    const entries = rawSectionEntries(record, family)
    const proxied = new Set<number>()
    entries.forEach((entry, index) => {
      if (isKeptProvider(family, entry) && effectiveEntryMode(entry, global) === 'proxy') {
        proxied.add(index)
      }
    })
    if (proxied.size > 0) out.set(family, proxied)
  }
  return out
}

/** Raw provider entries of one family section, document order. */
function rawSectionEntries(
  record: Readonly<Record<string, unknown>>,
  family: string,
): readonly Readonly<Record<string, unknown>>[] {
  const section = record[family]
  if (!Array.isArray(section)) return []
  const out: Array<Readonly<Record<string, unknown>>> = []
  for (const item of section) {
    if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
      out.push(item as Readonly<Record<string, unknown>>)
    }
  }
  return out
}

/**
 * Mirror of the shared config normalizer's keep predicate. The pairing
 * below depends on it staying in step: the k-th kept raw entry of a
 * family is the k-th normalized provider of that family.
 */
function isKeptProvider(family: string, entry: Readonly<Record<string, unknown>>): boolean {
  const apiKey = typeof entry['api-key'] === 'string' ? (entry['api-key'] as string) : ''
  const configuredBase = typeof entry['base-url'] === 'string' ? (entry['base-url'] as string) : ''
  const baseUrl = configuredBase.length > 0 ? configuredBase : family === 'claude-api-key' ? DEFAULT_CLAUDE_BASE_URL : ''
  if (apiKey.length === 0 && baseUrl.length === 0) return false
  const requiresBaseUrl =
    family === 'codex-api-key' ||
    family === 'xai-api-key' ||
    family === 'meta-api-key' ||
    family === 'openai-compatibility'
  if (requiresBaseUrl && baseUrl.length === 0) return false
  return true
}

/**
 * Pairs every normalized provider with its proxied flag and aliases.
 * On a pairing count mismatch (a normalizer drift), the whole family
 * fails CLOSED - every candidate reads as proxied - because sending
 * direct traffic for a proxy-credentialed credential is the one
 * outcome NE-S7-01 exists to prevent.
 */
function buildCandidatesByFamily(
  record: Readonly<Record<string, unknown>>,
  providers: readonly { readonly family: string; readonly models: readonly { readonly alias: string }[] }[],
  global: string,
): ReadonlyMap<string, readonly FamilyCandidate[]> {
  const out = new Map<string, FamilyCandidate[]>()
  for (const family of PROVIDER_FAMILIES) {
    const normalized = providers.filter((provider) => provider.family === family)
    const rawKept = rawSectionEntries(record, family).filter((entry) => isKeptProvider(family, entry))
    const candidates: FamilyCandidate[] = normalized.map((provider) => ({
      family,
      proxied: false,
      aliases: new Set(provider.models.map((model) => model.alias)),
    }))
    if (rawKept.length === normalized.length) {
      rawKept.forEach((entry, index) => {
        const candidate = candidates[index]
        if (candidate === undefined) return
        candidates[index] = { ...candidate, proxied: effectiveEntryMode(entry, global) === 'proxy' }
      })
    } else {
      for (let index = 0; index < candidates.length; index += 1) {
        const candidate = candidates[index]
        if (candidate === undefined) continue
        candidates[index] = { ...candidate, proxied: true }
      }
    }
    if (candidates.length > 0) out.set(family, candidates)
  }
  return out
}
