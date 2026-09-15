/**
 * The Vercel function entry (mission T3, R2/R3).
 *
 * Vercel invokes this handler once per HTTP request on the Node.js
 * serverless runtime; the process may serve several invocations
 * sequentially but MUST NOT keep per-request state in module globals
 * (Iron Rule 4). The handler therefore composes the gateway PER
 * INVOCATION:
 *
 * - every invocation reads the config source fresh (env, or the
 *   KV-persisted document when `CPA_CONFIG_FROM_KV=1`), so management
 *   config mutations apply on the next request without any watcher;
 * - the streaming budget deadline is scoped to the request, so
 *   concurrent invocations in one isolate cannot abort each other;
 * - the KV client itself is stateless (URL + token), so creating the
 *   store per invocation costs nothing.
 *
 * Streaming responses pass through: a facade-produced `ReadableStream`
 * body is handed to the platform `Response` untouched.
 */

import type { Store } from '@cpa-edge/core'
import { createInMemoryKvStore, KvStore } from './kv-store'
import { RestKvDriver } from './kv-driver'
import { configKvAddress, loadConfigSource } from './config'
import { createVercelGateway, DEFAULT_MAX_STREAMING_DURATION_MS } from './gateway'
import type { GatewayRequest, GatewayResponse } from '@cpa-edge/runtime-node'

/** Options of {@link createVercelHandler}. */
export interface VercelHandlerOptions {
  /** Environment; defaults to `process.env` where present. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Store override (tests inject the in-memory KV driver here). */
  readonly store?: Store
  /** Clock override (tests). */
  readonly now?: () => number
  /** Upstream transport override (tests). */
  readonly fetch?: (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<Response>
  /** Boundary overrides (tests). */
  readonly maxStreamingDurationMs?: number | null
  readonly boundaryMaxBytes?: number
}

const KV_URL_ENV = 'KV_REST_API_URL'
const KV_TOKEN_ENV = 'KV_REST_API_TOKEN'

/** Reads the ambient environment without importing node:* modules. */
function ambientEnv(): Readonly<Record<string, string | undefined>> {
  const scope: unknown = (globalThis as { process?: unknown }).process
  if (typeof scope === 'object' && scope !== null) {
    const env = (scope as { env?: unknown }).env
    if (typeof env === 'object' && env !== null) {
      return env as Record<string, string | undefined>
    }
  }
  return {}
}

/** Builds the production KV store from the REST binding env vars. */
function kvStoreFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): Store | undefined {
  const url = env[KV_URL_ENV]
  const token = env[KV_TOKEN_ENV]
  if (url === undefined || token === undefined || url.length === 0 || token.length === 0) {
    return undefined
  }
  return new KvStore({ driver: new RestKvDriver({ url, token }) })
}

/** Converts a platform `Request` into the gateway shape. */
async function toGatewayRequest(request: Request): Promise<GatewayRequest> {
  const body = new Uint8Array(await request.arrayBuffer())
  const headers: Array<[string, string]> = []
  request.headers.forEach((value, name) => {
    headers.push([name, value])
  })
  return { method: request.method, url: request.url, headers, body }
}

const NULL_BODY_STATUSES = new Set([101, 204, 304])

/** Converts a gateway response into the platform `Response`. */
function toPlatformResponse(response: GatewayResponse): Response {
  const headers = new Headers()
  for (const [name, value] of response.headers) headers.append(name, value)
  if (NULL_BODY_STATUSES.has(response.status)) {
    return new Response(null, { status: response.status, headers })
  }
  return new Response(response.body, { status: response.status, headers })
}

/**
 * Creates the request handler for one deployment. The returned function
 * is what `api/index.ts` exports as the Vercel function default.
 */
export function createVercelHandler(options: VercelHandlerOptions = {}) {
  return async function vercelHandler(request: Request): Promise<Response> {
    const env = options.env ?? ambientEnv()
    const configured = options.store ?? kvStoreFromEnv(env)
    let store: Store
    if (configured !== undefined) {
      store = configured
    } else {
      // No KV binding configured: fall back to a per-invocation
      // in-memory store so the deployment still serves, but say so
      // loudly - state will not survive the invocation.
      console.error(
        'cpa-edge vercel runtime: KV_REST_API_URL/KV_REST_API_TOKEN are not set; using a per-invocation in-memory store - no state will persist',
      )
      store = createInMemoryKvStore()
    }
    const { namespace, key } = configKvAddress()
    const persistEnabled = env['CPA_CONFIG_PERSIST'] === '1'
    const configSource = await loadConfigSource({
      env,
      readKvConfig: async () => {
        const stored = await store.get(namespace, key)
        return typeof stored === 'string' ? stored : undefined
      },
    })
    const budgetRaw = env['CPA_MAX_STREAMING_DURATION_MS']
    let budget: number | null | undefined
    if (budgetRaw !== undefined && Number.isFinite(Number(budgetRaw))) {
      budget = Number(budgetRaw)
    } else {
      budget = options.maxStreamingDurationMs ?? DEFAULT_MAX_STREAMING_DURATION_MS
    }
    const gateway = createVercelGateway({
      configSource,
      store,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      maxStreamingDurationMs: budget,
      ...(options.boundaryMaxBytes === undefined ? {} : { boundaryMaxBytes: options.boundaryMaxBytes }),
      envManagementPassword: env['MANAGEMENT_PASSWORD'],
      ...(persistEnabled
        ? {
            persistConfig: async (yaml: string) => {
              await store.put(namespace, key, yaml)
            },
          }
        : {}),
    })
    const gatewayResponse = await gateway.handle(await toGatewayRequest(request))
    return toPlatformResponse(gatewayResponse)
  }
}
