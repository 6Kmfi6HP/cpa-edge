import { MemoryStore, type Store } from '@cpa-edge/core'
import {
  authenticateClientRequest,
  detectSafeMode,
  type ClientAuthFailure,
  INVALID_API_KEY_BODY,
  MISSING_API_KEY_BODY,
  safeModePageHtml,
  SAFE_MODE_HEADER,
  SAFE_MODE_PROXY_BODY,
  type ClientAuthResult,
} from './api-keys'
import {
  authenticateRealtimeRequest,
  InMemoryRealtimeSecretRegistry,
  realtimeApiKeyErrorBody,
  type RealtimeSecretRegistry,
} from './realtime'
import {
  MANAGEMENT_BUILD_HEADER_NAMES,
  ManagementAuthService,
  prepareManagementSecretSync,
  type ManagementAuthConfig,
  type ManagementRequestHeaders,
} from './mgmt-auth'
import { isValidOauthState, OAuthSessionRegistry } from './oauth-sessions'
import {
  OAuthCallbackService,
  storePublishCallback,
  type OAuthCallbackFile,
  type PublishCallbackFn,
} from './oauth-callback'
import { OAuthLoginService } from './oauth-login'
import type { Clock, FetchLike } from './types'
import { goJsonStringify } from './wire'

/**
 * Composed facade over the auth surfaces (the S3 contract shape). Runtimes
 * and the contract suite mount this plane; it owns no HTTP routing, only
 * the per-request decisions and responses.
 *
 * The plane is built from closures on purpose: consumers may call its
 * methods detached from the object, so nothing may depend on `this`.
 *
 * State: with no `deps.store`, the plane keeps everything in a private
 * `MemoryStore` instance - process-lifetime parity with the reference
 * (ban counters, OAuth sessions). Production runtimes pass the platform
 * Store so the same state is shared across instances.
 */

/** Build-info header values emitted on every management response (§2.2). */
const BUILD_HEADER_VALUES: Readonly<Record<string, string>> = {
  'X-Cpa-Version': 'v7.3.4',
  'X-Cpa-Commit': '8335eac',
  'X-Cpa-Build-Date': '2026-09-15T14:07:06Z',
  'X-Cpa-Support-Plugin': '1',
}

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8'
const HTML_CONTENT_TYPE = 'text/html; charset=utf-8'

/** Parsed subset of the runtime config the auth plane consumes. */
export interface AuthPlaneConfig {
  /** Main server port; feeds the Devin management redirect URI (§2.3.4). */
  readonly port: number
  /** Top-level api-keys; empty list = open mode (§2.1). */
  readonly apiKeys: readonly string[]
  /** Absent when no remote-management block exists at all. */
  readonly remoteManagement?: {
    readonly allowRemote: boolean
    /** Plaintext or bcrypt form; plaintext is hashed at plane creation (R-BCRYPT). */
    readonly secretKey?: string
  }
  /** Logical auth directory; informational for runtimes. */
  readonly authDir?: string
}

/** Injectable capabilities the plane respects. */
export interface AuthPlaneDeps {
  /** Vendor egress for the device-code login endpoints (§2.5/§2.6). */
  readonly fetch?: FetchLike
  /** Clock for ban countdowns and session TTLs; epoch milliseconds. */
  readonly now?: () => number
  /** Remote transport address before X-Forwarded-For resolution (§2.2 step 2). */
  readonly remoteAddress?: string
  /**
   * Publishes one callback handshake record for a pending session (§2.5).
   * Rejection produces the 500 "failed to persist oauth callback" response
   * (§2.4 step 12). Runtimes bind this to the Store-backed publisher.
   */
  readonly publishOauthCallback?: (
    provider: string,
    state: string,
    payload: { code?: string; error?: string; state: string },
  ) => Promise<void>
  /** Platform Store; defaults to a private in-memory store. */
  readonly store?: Store
}

/** Verdict of the management key middleware (§2.2 pipeline). */
export type AuthManagementVerdict =
  | { readonly ok: true; readonly headers: ReadonlyArray<readonly [string, string]> }
  | { readonly ok: false; readonly response: Response }

export type AuthUrlProvider =
  | 'anthropic'
  | 'codex'
  | 'antigravity'
  | 'devin'
  | 'kimi'
  | 'xai'
  | 'meta'

/** The auth-plane surface the S3 contract drives. */
export interface AuthPlane {
  authenticateProxy(request: Request): Promise<Response | null>
  authenticateRealtime(request: Request): Promise<Response | null>
  authenticateRealtimeStandard(request: Request): Promise<Response | null>
  safeModeProxyResponse(request: Request): Response | null
  serveSafeModePage(request: Request): Response | null
  managementAvailable(): boolean
  authenticateManagement(request: Request): Promise<AuthManagementVerdict>
  handlePlainCallback(
    request: Request,
    provider: 'anthropic' | 'codex' | 'antigravity',
  ): Promise<Response>
  handleDevinCallback(request: Request): Promise<Response>
  handleManagementOauthCallback(request: Request): Promise<Response>
  handleAuthUrl(request: Request, provider: AuthUrlProvider): Promise<Response>
  handleGetAuthStatus(request: Request): Promise<Response>
  handleOauthSession(request: Request): Promise<Response>
  /** Issued-secret registry, for the realtime client-secrets endpoint. */
  readonly realtimeSecrets: RealtimeSecretRegistry
  /** Store the plane keeps its state in (injected or private in-memory). */
  readonly store: Store
}

function buildHeaders(): Array<readonly [string, string]> {
  return MANAGEMENT_BUILD_HEADER_NAMES.map(
    (name) => [name, BUILD_HEADER_VALUES[name] ?? ''] as const,
  )
}

function jsonResponse(status: number, body: string, extra?: Record<string, string>): Response {
  const headers: Record<string, string> = { 'Content-Type': JSON_CONTENT_TYPE }
  if (extra !== undefined) {
    for (const [name, value] of Object.entries(extra)) headers[name] = value
  }
  return new Response(body, { status, headers })
}

function htmlResponse(body: string, noStore: boolean): Response {
  const headers: Record<string, string> = { 'Content-Type': HTML_CONTENT_TYPE }
  if (noStore) headers['Cache-Control'] = 'no-store'
  return new Response(body, { status: 200, headers })
}

function clientHeadersOf(request: Request): {
  authorization?: string
  'x-goog-api-key'?: string
  'x-api-key'?: string
} {
  const authorization = request.headers.get('authorization')
  const goog = request.headers.get('x-goog-api-key')
  const apiKey = request.headers.get('x-api-key')
  return {
    ...(authorization === null ? {} : { authorization }),
    ...(goog === null ? {} : { 'x-goog-api-key': goog }),
    ...(apiKey === null ? {} : { 'x-api-key': apiKey }),
  }
}

/** Creates the composed auth plane (S3 contract facade). */
export function createAuthPlane(config: AuthPlaneConfig, deps: AuthPlaneDeps = {}): AuthPlane {
  const apiKeys = config.apiKeys
  const safeMode = detectSafeMode(apiKeys)
  const safeModeKeys = safeMode.active ? safeMode.keys : []
  const now: Clock = deps.now ?? (() => Date.now())
  const remoteAddress = deps.remoteAddress ?? '127.0.0.1'
  const store: Store = deps.store ?? new MemoryStore()
  const registry = new OAuthSessionRegistry(store, { now })
  const loginService = new OAuthLoginService(registry, {
    now,
    fetch: deps.fetch,
    serverPort: config.port,
  })
  const publish: PublishCallbackFn =
    deps.publishOauthCallback === undefined
      ? storePublishCallback(store)
      : (provider, state, file: OAuthCallbackFile) =>
          Promise.resolve(
            deps.publishOauthCallback?.(provider, state, {
              code: file.code.length > 0 ? file.code : undefined,
              error: file.error.length > 0 ? file.error : undefined,
              state: file.state,
            }),
          )
  const callbackService = new OAuthCallbackService(registry, { publish })
  const prepared = prepareManagementSecretSync(config.remoteManagement?.secretKey ?? '')
  const managementConfig: ManagementAuthConfig = {
    configSecret: prepared.stored,
    allowRemote: config.remoteManagement?.allowRemote ?? false,
  }
  const managementService = new ManagementAuthService(store, {
    getConfig: () => managementConfig,
    now,
  })
  const realtimeSecrets: RealtimeSecretRegistry = new InMemoryRealtimeSecretRegistry({ now })

  const safeModeActive = (): boolean => safeModeKeys.length > 0

  const safeModeProxyBlock = (): Response | null => {
    if (!safeModeActive()) return null
    return jsonResponse(403, SAFE_MODE_PROXY_BODY, { [SAFE_MODE_HEADER]: 'example-api-key' })
  }

  const serveSafeModePageFor = (request: Request): Response | null => {
    if (!safeModeActive()) return null
    const url = new URL(request.url)
    if (url.pathname !== '/' && url.pathname !== '/management.html') return null
    if (url.searchParams.get('safe-mode') === 'configure') return null
    if (request.method === 'HEAD') {
      return new Response(null, {
        status: 200,
        headers: { 'Content-Type': HTML_CONTENT_TYPE, 'Cache-Control': 'no-store' },
      })
    }
    if (request.method !== 'GET') return null
    return htmlResponse(safeModePageHtml(safeModeKeys), true)
  }

  const toResponse = (result: ClientAuthResult): Response | null => {
    if (result.ok) return null
    return jsonResponse(result.status, result.body, { ...result.headers })
  }

  const realtimeBodyOf = (result: ClientAuthFailure): string => {
    if (result.body === MISSING_API_KEY_BODY) return realtimeApiKeyErrorBody('Missing API key')
    if (result.body === INVALID_API_KEY_BODY) return realtimeApiKeyErrorBody('Invalid API key')
    return result.body
  }

  const callbackParams = (request: Request) => {
    const url = new URL(request.url)
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    const error = url.searchParams.get('error')
    const errorDescription = url.searchParams.get('error_description')
    const provider = url.searchParams.get('provider')
    return {
      ...(code === null ? {} : { code }),
      ...(state === null ? {} : { state }),
      ...(error === null ? {} : { error }),
      ...(errorDescription === null ? {} : { errorDescription }),
      ...(provider === null ? {} : { provider }),
    }
  }

  return {
    store,
    realtimeSecrets,

    async authenticateProxy(request: Request): Promise<Response | null> {
      const blocked = safeModeProxyBlock()
      if (blocked !== null) return blocked
      return toResponse(
        authenticateClientRequest({
          apiKeys,
          headers: clientHeadersOf(request),
          url: request.url,
        }),
      )
    },

    async authenticateRealtime(request: Request): Promise<Response | null> {
      return toResponse(
        await authenticateRealtimeRequest({
          apiKeys,
          headers: clientHeadersOf(request),
          url: request.url,
          secrets: realtimeSecrets,
          now,
        }),
      )
    },

    async authenticateRealtimeStandard(request: Request): Promise<Response | null> {
      const result = authenticateClientRequest({
        apiKeys,
        headers: clientHeadersOf(request),
        url: request.url,
      })
      if (result.ok) return null
      return jsonResponse(result.status, realtimeBodyOf(result), { ...result.headers })
    },

    safeModeProxyResponse(request: Request): Response | null {
      return safeModeProxyBlock()
    },

    serveSafeModePage(request: Request): Response | null {
      return serveSafeModePageFor(request)
    },

    managementAvailable(): boolean {
      return managementService.isManagementEnabled()
    },

    async authenticateManagement(request: Request): Promise<AuthManagementVerdict> {
      const authorization = request.headers.get('authorization')
      const managementKey = request.headers.get('x-management-key')
      const forwardedFor = request.headers.get('x-forwarded-for')
      const realIp = request.headers.get('x-real-ip')
      const headers: ManagementRequestHeaders = {
        remoteAddr: remoteAddress,
        ...(authorization === null ? {} : { authorization }),
        ...(managementKey === null ? {} : { 'x-management-key': managementKey }),
        ...(forwardedFor === null ? {} : { 'x-forwarded-for': forwardedFor }),
        ...(realIp === null ? {} : { 'x-real-ip': realIp }),
      }
      const verdict = await managementService.authenticate({ headers })
      if (verdict.ok) return { ok: true, headers: buildHeaders() }
      return {
        ok: false,
        response: jsonResponse(
          verdict.status,
          verdict.body,
          Object.fromEntries(buildHeaders()) as Record<string, string>,
        ),
      }
    },

    async handlePlainCallback(
      request: Request,
      provider: 'anthropic' | 'codex' | 'antigravity',
    ): Promise<Response> {
      const decision = await callbackService.handlePlainCallback(provider, callbackParams(request))
      return htmlResponse(decision.body, false)
    },

    async handleDevinCallback(request: Request): Promise<Response> {
      const decision = await callbackService.handleStrictCallback(callbackParams(request))
      if (decision.status === 200) return htmlResponse(decision.body, true)
      return jsonResponse(decision.status, decision.body, { ...decision.headers })
    },

    async handleManagementOauthCallback(request: Request): Promise<Response> {
      if (request.method === 'POST') {
        const text = await request.text()
        let parsed: unknown
        try {
          parsed = JSON.parse(text)
        } catch {
          parsed = undefined
        }
        const decision = await callbackService.handleManagementCallbackPost(parsed)
        return jsonResponse(decision.status, decision.body, { ...decision.headers })
      }
      const decision = await callbackService.handleManagementCallbackGet(callbackParams(request))
      return jsonResponse(decision.status, decision.body, { ...decision.headers })
    },

    async handleAuthUrl(_request: Request, provider: AuthUrlProvider): Promise<Response> {
      const result =
        provider === 'anthropic'
          ? await loginService.anthropicLoginUrl()
          : provider === 'codex'
            ? await loginService.codexLoginUrl()
            : provider === 'antigravity'
              ? await loginService.antigravityLoginUrl()
              : provider === 'devin'
                ? await loginService.devinLoginUrl()
                : provider === 'kimi'
                  ? await loginService.kimiLoginUrl()
                  : provider === 'xai'
                    ? await loginService.xaiLoginUrl()
                    : await loginService.metaLoginUrl()
      if (result.ok) return jsonResponse(200, result.body)
      return jsonResponse(result.response.status, result.response.body)
    },

    async handleGetAuthStatus(request: Request): Promise<Response> {
      const state = new URL(request.url).searchParams.get('state') ?? ''
      if (state.length === 0) return jsonResponse(200, goJsonStringify({ status: 'ok' }))
      if (!isValidOauthState(state)) {
        return jsonResponse(400, goJsonStringify({ status: 'error', error: 'invalid state' }))
      }
      const session = await registry.get(state)
      if (session === undefined) {
        return jsonResponse(
          200,
          goJsonStringify({ status: 'error', error: 'unknown or expired state' }),
        )
      }
      if (session.completed) return jsonResponse(200, goJsonStringify({ status: 'ok' }))
      if (session.status !== 'pending') {
        return jsonResponse(200, goJsonStringify({ status: 'error', error: session.status }))
      }
      return jsonResponse(200, goJsonStringify({ status: 'wait' }))
    },

    async handleOauthSession(request: Request): Promise<Response> {
      const state = new URL(request.url).searchParams.get('state') ?? ''
      if (state.length === 0) {
        return jsonResponse(400, goJsonStringify({ status: 'error', error: 'missing state' }))
      }
      if (!isValidOauthState(state)) {
        return jsonResponse(400, goJsonStringify({ status: 'error', error: 'invalid state' }))
      }
      const cancelled = await registry.cancel(state)
      return jsonResponse(200, goJsonStringify({ cancelled, status: 'ok' }))
    },
  }
}
