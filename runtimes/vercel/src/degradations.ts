/**
 * S7 vercel-column degradations, made concrete at the request layer.
 *
 * Two enforcement points exist, both shaped so the shared gateway and
 * the management facade keep doing every precedence-relevant decision
 * they already own (R-404, auth gates, config-state checks), and this
 * module only replaces outcomes the platform cannot honor:
 *
 * 1. the request overlay runs before the shared gateway and owns the
 *    client-surface seams: `GET /v1/ws` (NE-S7-07) and the fail-closed
 *    proxy-credential gate (NE-S7-01). Both re-run the shared auth
 *    plane first, because S7 §5 puts authentication before capability
 *    checks.
 * 2. the management wrapper runs around the composed management facade
 *    and rewrites only SUCCESSFUL (auth-passed, gate-passed) responses
 *    of routes whose substrate is absent on serverless: redirect-flow
 *    auth-URLs (NE-S7-05 / R-S7-B), file logging (NE-S7-03), the
 *    per-request error dumps (OQ-S7-02) and plugin installation
 *    (NE-S7-02). Device flows (xai/meta/kimi) pass through untouched:
 *    their envelope-only degradation (NE-S7-11) needs no interception -
 *    the poll loop that would complete them simply never runs here.
 *
 * All 501 bodies are byte-exact S7 §3.2 shapes: compact JSON, no
 * trailing newline, `application/json; charset=utf-8`, and the standard
 * CORS block the response middleware adds everywhere else.
 */

import { parseBlockYaml, resolveProxyMode } from './config'
import type { GatewayRequest, GatewayResponse } from '@cpa-edge/runtime-node'
import type { HeaderList, ManagementApi } from '@cpa-edge/management'

/** The management facade's wire response (a Response plus raw headers). */
type WireResponse = Awaited<ReturnType<ManagementApi['handle']>>

// ---------------------------------------------------------------------------
// Pinned bodies (S7 §3.2)
// ---------------------------------------------------------------------------

/** F4 client body: `GET /v1/ws` after the auth gate on a no-WS runtime. */
export const WEBSOCKET_UNAVAILABLE_BODY =
  '{"error":{"message":"inbound WebSocket is not available on this runtime","type":"not_implemented","code":"websocket_unavailable"}}'

/** F1 client body: every eligible credential for the model is proxied. */
export const PROXY_UNAVAILABLE_BODY =
  '{"error":{"message":"outbound proxy transport (proxy-url) is not available on this runtime","type":"not_implemented","code":"proxy_unavailable"}}'

/** F5 management body: redirect-flow auth-URLs without a callback server. */
export const LOCAL_CALLBACK_UNAVAILABLE_BODY =
  '{"error":"local callback server is not available on this runtime"}'

/** F1 management body: api-call resolved to proxy mode. */
export const PROXY_TRANSPORT_UNAVAILABLE_BODY =
  '{"error":"proxy transport is not available on this runtime"}'

/** F3 management body: logs surface with no file substrate. */
export const FILE_LOGGING_UNAVAILABLE_BODY =
  '{"error":"file logging is not available on this runtime"}'

/** F2 management body: plugin installation (absent project-wide). */
export const PLUGIN_INSTALL_UNAVAILABLE_BODY =
  '{"error":"plugin installation is not available on this runtime"}'

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8'

/** Standard CORS block (the response middleware's header set, wire order). */
export const CORS_BLOCK: readonly (readonly [string, string])[] = Object.freeze([
  ['Access-Control-Allow-Headers', '*'],
  ['Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS'],
  ['Access-Control-Allow-Origin', '*'],
  [
    'Access-Control-Expose-Headers',
    'X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id',
  ],
] as ReadonlyArray<readonly [string, string]>)

/** A 501 GatewayResponse with the CORS block and no extra headers. */
export function capabilityResponse(body: string): GatewayResponse {
  return {
    status: 501,
    headers: [...CORS_BLOCK, ['Content-Type', JSON_CONTENT_TYPE] as const],
    body,
  }
}

/** Reads a Web `Response` into the gateway shape, CORS block first. */
export async function fromWebResponseText(response: Response): Promise<GatewayResponse> {
  const headers: Array<readonly [string, string]> = [...CORS_BLOCK]
  response.headers.forEach((value, name) => {
    headers.push([name, value] as const)
  })
  return { status: response.status, headers, body: await response.text() }
}

// ---------------------------------------------------------------------------
// Management facade wrapper
// ---------------------------------------------------------------------------

/** Options of {@link wrapManagementApi}. */
export interface ManagementWrapperOptions {
  /** Global `proxy-url` scalar of the mounted config (api-call resolution). */
  readonly globalProxyUrl: string
  /**
   * Live view of the effective `ws-auth` flag. The wrapper keeps it in
   * sync with successful management writes/reads; the request overlay
   * consults it for the `/v1/ws` gate.
   */
  readonly wsAuthView: { value: boolean }
  /** Best-effort config persistence (KV write of the facade's YAML). */
  readonly persistConfig?: (yaml: string) => Promise<void>
}

/** Route classification helper over `/v0/management/<relative>`. */
function managementSegments(pathname: string): readonly string[] {
  const relative = pathname.startsWith('/v0/management/')
    ? pathname.slice('/v0/management/'.length)
    : ''
  return relative.split('/').filter((segment) => segment.length > 0)
}

const REDIRECT_AUTH_URL_PROVIDERS = new Set(['anthropic', 'codex', 'antigravity', 'devin'])

/**
 * Wraps the composed management facade with the S7 vercel replacements.
 * The facade keeps full ownership of auth, availability, R-404 and
 * config-state ladders; only auth-passed successes of absent-substrate
 * routes are rewritten.
 */
export function wrapManagementApi(api: ManagementApi, options: ManagementWrapperOptions): ManagementApi {
  const wrapped: ManagementApi = {
    handle: (request: Request) => handleWrapped(api, options, request),
    recordUsage: (completion) => api.recordUsage(completion),
    publishError: (event) => api.publishError(event),
    openUsageWire: () => api.openUsageWire(),
    recordCooldown: (record) => api.recordCooldown(record),
    listCooldownSidecars: () => api.listCooldownSidecars(),
    isCooling: (authId, model) => api.isCooling(authId, model),
    appendLogLine: (entry) => api.appendLogLine(entry),
    readLogRing: () => api.readLogRing(),
    buildModelList: () => api.buildModelList(),
    readConfigFile: () => api.readConfigFile(),
    replaceConfigFile: (yaml) => api.replaceConfigFile(yaml),
  }
  return wrapped
}

async function handleWrapped(
  api: ManagementApi,
  options: ManagementWrapperOptions,
  request: Request,
): Promise<WireResponse> {
  const url = new URL(request.url)
  const segments = managementSegments(url.pathname)
  const method = request.method.toUpperCase()

  // api-call: resolve the proxy mode BEFORE the facade dials anything,
  // but only after the facade's own 400 validations would pass - the
  // cheapest way to keep that precedence is to mirror the validations
  // as a delegation guard, never as a re-implementation.
  if (method === 'POST' && segments.length === 1 && segments[0] === 'api-call') {
    const intercepted = await interceptApiCall(options, request)
    if (intercepted !== undefined) return intercepted
  }

  // Clone the request BEFORE the facade consumes its body: the
  // post-success bookkeeping re-reads the request text.
  const requestCopy = request.clone()
  const wire = await api.handle(request)
  const replaced = await replaceManagementResponse(method, segments, wire)
  if (replaced !== undefined) return replaced
  await afterManagementResponse(api, options, method, segments, wire, requestCopy)
  return wire
}

/** Builds a 501 wire response in the facade's response shape. */
function management501(body: string): WireResponse {
  const rawHeaders: HeaderList = [
    ...CORS_BLOCK,
    ['Content-Type', JSON_CONTENT_TYPE] as const,
  ]
  const response = new Response(body, {
    status: 501,
    headers: Object.fromEntries(rawHeaders),
  })
  return Object.assign(response, { rawHeaders }) as WireResponse
}

/**
 * api-call interception (S7 §2.3-F1-7). Mirrors the facade's validation
 * ladder as a delegation guard: anything the facade would answer with a
 * 400 goes to the facade unchanged; a request that would dial through a
 * proxy gets the management 501 instead.
 */
async function interceptApiCall(
  options: ManagementWrapperOptions,
  request: Request,
): Promise<WireResponse | undefined> {
  let parsed: unknown
  try {
    parsed = await request.clone().text()
    parsed = JSON.parse(String(parsed))
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const body = parsed as Record<string, unknown>
  const method = typeof body['method'] === 'string' ? (body['method'] as string) : ''
  if (method === '') return undefined
  const target = typeof body['url'] === 'string' ? (body['url'] as string) : ''
  if (target === '') return undefined
  try {
    new URL(target)
  } catch {
    return undefined
  }
  const proxyUrl = body['proxy_url']
  if (proxyUrl !== undefined && typeof proxyUrl !== 'string') return undefined
  if (typeof proxyUrl === 'string' && proxyUrl !== '') {
    try {
      new URL(proxyUrl)
    } catch {
      return undefined
    }
  }
  const effective =
    typeof proxyUrl === 'string' && proxyUrl !== '' ? proxyUrl : options.globalProxyUrl
  if (resolveProxyMode(effective) === 'proxy') {
    return management501(PROXY_TRANSPORT_UNAVAILABLE_BODY)
  }
  return undefined
}

/**
 * Post-hoc rewrites of successful facade responses on absent substrates.
 * Every branch fires only for auth-passed, gate-passed successes, which
 * is exactly the S7 §5 precedence the facade already enforced.
 */
async function replaceManagementResponse(
  method: string,
  segments: readonly string[],
  wire: WireResponse,
): Promise<WireResponse | undefined> {
  const [first] = segments
  const rest = segments.slice(1)
  if (first === undefined) return undefined

  // F3: the logs surface exists only on file-capable runtimes.
  if (first === 'logs' && rest.length === 0 && (method === 'GET' || method === 'DELETE')) {
    if (wire.status === 200) return management501(FILE_LOGGING_UNAVAILABLE_BODY)
    return undefined
  }
  // OQ-S7-02: per-request error dumps have no substrate on vercel.
  if (first === 'request-error-logs' && method === 'GET') {
    if (rest.length === 0 && wire.status === 200) {
      return management501(FILE_LOGGING_UNAVAILABLE_BODY)
    }
    if (rest.length === 1 && wire.status === 404) {
      const error = await errorFieldOf(wire)
      if (error === 'log file not found') return management501(FILE_LOGGING_UNAVAILABLE_BODY)
    }
    return undefined
  }
  if (first === 'request-log-by-id' && rest.length === 1 && method === 'GET' && wire.status === 404) {
    const error = await errorFieldOf(wire)
    if (error === 'log file not found for the given request ID') {
      return management501(FILE_LOGGING_UNAVAILABLE_BODY)
    }
    return undefined
  }
  // NE-S7-05: redirect-flow auth-URLs cannot exist without the local
  // callback server. Device-flow auth-URLs (xai/meta/kimi) stay as the
  // facade answered them (NE-S7-11 envelope-only degradation).
  if (rest.length === 0 && method === 'GET' && wire.status === 200) {
    const provider = first.endsWith('-auth-url') ? first.slice(0, -'-auth-url'.length) : ''
    if (REDIRECT_AUTH_URL_PROVIDERS.has(provider)) {
      return management501(LOCAL_CALLBACK_UNAVAILABLE_BODY)
    }
  }
  // NE-S7-02: plugin installation has no substrate anywhere in the
  // project; S7 pins the 501 for the install route on every runtime.
  if (
    first === 'plugin-store' &&
    method === 'POST' &&
    rest.length === 2 &&
    rest[1] === 'install' &&
    wire.status >= 500
  ) {
    return management501(PLUGIN_INSTALL_UNAVAILABLE_BODY)
  }
  return undefined
}

/** Reads the `error` field out of a JSON error response, if present. */
async function errorFieldOf(wire: WireResponse): Promise<string | undefined> {
  try {
    const parsed: unknown = JSON.parse(await wire.clone().text())
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const error = (parsed as Record<string, unknown>)['error']
      if (typeof error === 'string') return error
    }
  } catch {
    return undefined
  }
  return undefined
}

/**
 * Post-success bookkeeping: keeps the ws-auth view in sync and persists
 * management config mutations so the next invocation observes them
 * (the serverless replacement for the config-file watcher, S7 F6).
 */
async function afterManagementResponse(
  api: ManagementApi,
  options: ManagementWrapperOptions,
  method: string,
  segments: readonly string[],
  wire: WireResponse,
  request: Request,
): Promise<void> {
  if (wire.status >= 400) return
  const [first] = segments
  const rest = segments.slice(1)
  if (first === undefined) return

  // Keep the ws-auth view in sync with successful scalar writes/reads
  // so the /v1/ws gate always consults the live flag.
  if (first === 'ws-auth' && rest.length === 0) {
    if (method === 'PUT' || method === 'PATCH') {
      try {
        const parsed: unknown = JSON.parse(await request.clone().text())
        if (typeof parsed === 'object' && parsed !== null) {
          const value = (parsed as Record<string, unknown>)['value']
          if (typeof value === 'boolean') options.wsAuthView.value = value
        }
      } catch {
        // The facade already validated the body; a failed re-read here
        // only skips the view update, never the response.
      }
    } else if (method === 'GET') {
      try {
        const parsed: unknown = JSON.parse(await wire.clone().text())
        if (typeof parsed === 'object' && parsed !== null) {
          const value = (parsed as Record<string, unknown>)['ws-auth']
          if (typeof value === 'boolean') options.wsAuthView.value = value
        }
      } catch {
        // The view simply stays at its previous value.
      }
    }
  }
  if (first === 'config.yaml' && rest.length === 0 && method === 'PUT') {
    try {
      const record = parseBlockYaml(await request.clone().text())
      options.wsAuthView.value = record['ws-auth'] !== false
    } catch {
      // The facade validated the YAML before accepting it; a parse
      // failure here only skips the view update.
    }
  }

  // Persist management config mutations so the next invocation observes
  // them - the serverless replacement for the config-file watcher
  // (S7 F6, management-writes-only).
  if (options.persistConfig === undefined) return
  if (method !== 'PUT' && method !== 'PATCH' && method !== 'DELETE') return
  if (first === 'api-call' || first === 'oauth-session') return
  try {
    await options.persistConfig(await api.readConfigFile())
  } catch (error) {
    // Persistence is best-effort, mirroring the facade's own Store
    // writes: the client response stands; the failure surfaces on the
    // platform error channel instead of being swallowed silently.
    if (typeof reportError === 'function') reportError(error)
    else console.error(error)
  }
}

// ---------------------------------------------------------------------------
// Client-surface request overlay
// ---------------------------------------------------------------------------

/** Client-route ids whose completion carries a model resolution (S1 §3). */
const MODEL_ROUTES: ReadonlySet<string> = new Set([
  'chat-completions',
  'completions',
  'messages',
  'messages-count-tokens',
  'responses',
  'responses-compact',
  'v1beta-models-action',
])

/** Redirect-flow auth-URL routes: no loopback callback server exists (S7 2.3-F5a). */
const REDIRECT_AUTH_URL_PATTERN = /^\/v0\/management\/(?:anthropic|codex|antigravity|devin)-auth-url$/

/** Auth-session routes the shared gateway serves through its own plane (S1 3.9). */
const AUTH_SESSION_ROUTES: ReadonlySet<string> = new Set([
  'mgmt-auth-url',
  'mgmt-get-auth-status',
  'mgmt-oauth-session',
])

/** One family candidate: a provider entry plus its proxied flag. */
export interface FamilyCandidate {
  readonly proxied: boolean
  /** Client-facing aliases registered under the provider. */
  readonly aliases: ReadonlySet<string>
}

/** Verdict shape of the management auth middleware (the plane's union). */
export type ManagementAuthOutcome =
  | { readonly ok: true; readonly headers: ReadonlyArray<readonly [string, string]> }
  | { readonly ok: false; readonly response: Response }

/** Options of {@link createRequestOverlay}. */
export interface RequestOverlayOptions {
  /** Gateway-exposed auth plane (re-running the shared client gate). */
  readonly authenticateProxy: (request: Request) => Promise<Response | null>
  /** Gateway-exposed management gate (401/403 shapes and ban counting). */
  readonly authenticateManagement: (
    request: Request,
    options?: { readonly remoteAddress?: string },
  ) => Promise<ManagementAuthOutcome>
  /** Whether the management surface exists at all (availability gate). */
  readonly managementAvailable: () => boolean
  /**
   * Whether the composed management facade is injected. When it is, the
   * shared gateway skips its own management gate on the auth-session
   * routes, so this overlay must run it; when it is not, the shared
   * gateway runs the gate itself and the overlay delegates.
   */
  readonly facadeComposed: boolean
  /** Route matcher of the shared gateway. */
  readonly matchRoute: (method: string, pathname: string) =>
    | { readonly entry: { readonly id: string; readonly group: string } }
    | undefined
  /** All candidates per provider family (proxied flags included). */
  readonly candidatesByFamily: ReadonlyMap<string, readonly FamilyCandidate[]>
  /** Model registry queries of the shared gateway (image-model gate). */
  readonly isImageModel: (model: string) => boolean
  /** Live ws-auth view (`false` only when the operator disabled it). */
  readonly wsAuthView: { readonly value: boolean }
  /** v1beta action parser (translators facade export). */
  readonly parseModelMethod: (action: string) => { readonly model: string } | undefined
}

/**
 * The request-level degradation gate. Returns a GatewayResponse when a
 * vercel capability seizes the request; `undefined` delegates to the
 * shared gateway unchanged.
 */
export function createRequestOverlay(options: RequestOverlayOptions) {
  return async function overlay(request: GatewayRequest): Promise<GatewayResponse | undefined> {
    const url = new URL(request.url)
    const method = request.method.toUpperCase()

    // GET /v1/ws: auth contract preserved, then the 501 seam
    // (NE-S7-07). Wrong methods stay with the gateway (R-404), OPTIONS
    // likewise.
    if (method === 'GET' && url.pathname === '/v1/ws') {
      if (options.wsAuthView.value) {
        const rejected = await options.authenticateProxy(toWebRequest(request))
        if (rejected !== null) return await fromWebResponseText(rejected)
      }
      return capabilityResponse(WEBSOCKET_UNAVAILABLE_BODY)
    }

    const match = options.matchRoute(method, url.pathname)
    if (match === undefined) return undefined
    const id = match.entry.id

    // Auth-session routes the shared gateway serves through its own
    // plane (S1 3.9). Two things are vercel-specific here: the
    // redirect-flow auth-URLs degrade to 501 (NE-S7-05), and the
    // management key gate must run in front of them - the shared
    // composition skips its own gate on these ids when a facade is
    // injected, so this overlay restores the recorded 401/403 ladder
    // (S7-12) for every deployment of THIS runtime.
    if (match.entry.group === 'management' && AUTH_SESSION_ROUTES.has(id)) {
      if (!options.managementAvailable()) return undefined
      if (!options.facadeComposed && id !== 'mgmt-auth-url') return undefined
      const verdict = await options.authenticateManagement(toWebRequest(request), {
        ...(request.remoteAddress === undefined ? {} : { remoteAddress: request.remoteAddress }),
      })
      if (!verdict.ok) return await fromWebResponseText(verdict.response)
      if (id === 'mgmt-auth-url' && REDIRECT_AUTH_URL_PATTERN.test(url.pathname)) {
        return capabilityResponse(LOCAL_CALLBACK_UNAVAILABLE_BODY)
      }
      return undefined
    }

    // Fail-closed proxy gate (NE-S7-01): runs only on registered
    // completion routes, after the same client auth gate, and only when
    // the model resolves (unknown models keep their family 400s).
    // Fail-closed proxy gate (NE-S7-01): runs only on registered
    // completion routes, after the same client auth gate, and only when
    // the model resolves (unknown models keep their family 400s).
    if (!MODEL_ROUTES.has(id)) return undefined
    if (match.entry.group !== 'client') return undefined
    const model = modelOf(options, id, request, url)
    if (model === undefined) return undefined
    if (options.isImageModel(model)) return undefined
    const candidates = candidatesForModel(options, model)
    if (candidates === undefined) return undefined
    if (candidates.length > 0 && candidates.every((candidate) => candidate.proxied)) {
      const rejected = await options.authenticateProxy(toWebRequest(request))
      if (rejected !== null) return await fromWebResponseText(rejected)
      return capabilityResponse(PROXY_UNAVAILABLE_BODY)
    }
    return undefined
  }
}

/** Extracts the requested model for one completion route, best-effort. */
function modelOf(
  options: RequestOverlayOptions,
  id: string,
  request: GatewayRequest,
  url: URL,
): string | undefined {
  if (id === 'v1beta-models-action') {
    const prefix = '/v1beta/models/'
    const action = url.pathname.length > prefix.length ? url.pathname.slice(prefix.length) : ''
    const parsed = options.parseModelMethod(action)
    return parsed === undefined ? undefined : parsed.model
  }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(request.body))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    const model = (parsed as Record<string, unknown>)['model']
    return typeof model === 'string' ? model : undefined
  } catch {
    // Malformed bodies keep the gateway's own 400 ladder.
    return undefined
  }
}

/** Every family candidate that registers the alias, when any exists. */
function candidatesForModel(
  options: RequestOverlayOptions,
  model: string,
): readonly FamilyCandidate[] | undefined {
  for (const candidates of options.candidatesByFamily.values()) {
    const matching = candidates.filter((candidate) => candidate.aliases.has(model))
    if (matching.length > 0) return matching
  }
  return undefined
}

/** Builds a Web Request for the shared auth plane. */
function toWebRequest(request: GatewayRequest): Request {
  const headers = new Headers()
  for (const [name, value] of request.headers) headers.append(name, value)
  const hasBody = request.body.length > 0
  return new Request(request.url, {
    method: request.method,
    headers,
    ...(hasBody ? { body: new Uint8Array(request.body) } : {}),
  })
}
