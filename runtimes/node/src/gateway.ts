/**
 * The node gateway: full S1 request pipeline over the merged package
 * facades.
 *
 * Layering contract (mission T1):
 * - routing, CORS, R-404, redirects, OPTIONS, safe-mode + client auth,
 *   trace emission and platform transport live HERE;
 * - every translation/protocol decision lives in the workspace
 *   packages and is reached through their exported facades;
 * - directions without a merged facade are dispatch seams: the table
 *   in `DIRECTIONS` records the facade import path each surface/family
 *   pair will wire to; until then the gateway answers with a clearly
 *   non-upstream 503 body.
 */
import {
  MemoryStore,
  NODE_RUNTIME_CAPABILITIES,
  type RuntimeCapabilities,
  type Store,
} from '@cpa-edge/core'
import {
  authenticateClientRequest,
  createAuthPlane,
  formatRfc3339,
  type AuthPlane,
  type AuthPlaneConfig,
  type FetchLike,
} from '@cpa-edge/auth'
import type { ManagementApi } from '@cpa-edge/management'
import { gem2cla, gem2oai, oai2cla } from '@cpa-edge/translators'
import {
  claudeCredentialsForChat,
  claudeCredentialsForGemini,
  normalizeRuntimeConfig,
  openAiCompatCredentials,
  type NormalizedConfig,
  type ProviderFamily,
} from './config'
import { ModelRegistry, type ResolvedModel } from './registry'
import { withCors } from './cors'
import { TRACE_HEADER, newTraceId } from './trace'
import {
  CODEX_AUTH_UNAVAILABLE_BODY,
  INTERACTIONS_EXACTLY_ONE_BODY,
  INTERACTIONS_INVALID_JSON_BODY,
  INTERACTIONS_STREAM_BOOLEAN_BODY,
  JSON_CHARSET,
  KEEPALIVE_INVALID_BODY,
  MAX_DEPTH_MESSAGE,
  ROOT_BODY,
  STATUS_OK_BODY,
  ZSTD_MAGIC_MISMATCH,
  charsetJson,
  claudeInvalidRequestBody,
  claudeModelNotFoundBody,
  compactStreamRejectionBody,
  directionNotMergedBody,
  emptyNotFound,
  html,
  imageOnlyModelBody,
  imagesUnsupportedModelBody,
  invalidRequestBody,
  modelNotFoundBody,
  openAiError,
  plainErrorBody,
  plainJson,
  plainText,
  realtimeEnvelope,
} from './envelopes'
import {
  evaluateRedirect,
  headerValue,
  matchRoute,
  optionsResponse,
  redirectResponse,
  type RouteMatch,
} from './router'
import type { GatewayRequest, GatewayResponse, HeaderList } from './types'

/** Upstream transport request the facades produce. */
export interface UpstreamWireRequest {
  readonly method: string
  readonly url: string
  readonly headers: HeaderList
  readonly body: string
}

/** Upstream transport response fed back into the facades. */
export interface UpstreamWireResponse {
  readonly status: number
  readonly headers: HeaderList
  readonly body: ReadableStream<Uint8Array>
}

/** Constructor options of the node gateway. */
export interface NodeGatewayOptions {
  /** YAML-shaped config document (S6 §3.1 key names). */
  readonly config: Readonly<Record<string, unknown>>
  /** Platform Store; defaults to a process-local MemoryStore. */
  readonly store?: Store
  /** Epoch-milliseconds clock; defaults to Date.now. */
  readonly now?: () => number
  /** Upstream transport; defaults to the platform fetch. */
  readonly fetch?: FetchLike
  /** Client address for the management auth gate (default loopback). */
  readonly remoteAddress?: string
  /** Platform capability profile; defaults to the node constant (S7 3.1). */
  readonly capabilities?: RuntimeCapabilities
  /**
   * Dispatch seam for the management surface: the composed
   * `createManagementApi` instance once I-mgmt merges. Until injected
   * the auth-plane subset answers and every payload route 404-empties.
   */
  readonly managementApi?: ManagementApi
  /** zstd request-body decoder (dep requested from the orchestrator). */
  readonly zstdDecode?: (input: Uint8Array) => Uint8Array
  /** Served control-panel HTML asset (downloaded upstream on first use). */
  readonly managementPanelHtml?: string
  /** TUI-mode local password; also registers `/keep-alive` and management. */
  readonly keepAlivePassword?: string
}

/** The composed node gateway. */
export interface NodeGateway {
  handle(request: GatewayRequest): Promise<GatewayResponse>
  readonly capabilities: RuntimeCapabilities
  readonly store: Store
  readonly plane: AuthPlane
  readonly config: NormalizedConfig
}

/** Gateway version stamped into upstream user-agents (build identity). */
const GATEWAY_VERSION = 'v7.3.4'

/** Build date mirrored by the management build headers (S1 §2). */
const GATEWAY_BUILD_DATE = '2026-09-15T14:07:06Z'

// ---------------------------------------------------------------------------
// Dispatch table - surfaces x provider families -> direction facade
// ---------------------------------------------------------------------------

/** Where a (surface, family) pair dispatches once its module merges. */
interface DirectionSeam {
  /** Stable direction id (matches the STATUS step names). */
  readonly id: string
  /** Facade import path the integrator wires at merge time. */
  readonly importPath: string
  /** True when the runtime imports and dispatches this facade today. */
  readonly merged: boolean
}

const OAI2CLA_PATH = '@cpa-edge/translators/oai2cla'
const GEM2OAI_PATH = '@cpa-edge/translators/gem2oai'
const GEM2CLA_PATH = '@cpa-edge/translators/gem2cla'

/**
 * The full direction matrix. Merged entries are dispatched below; the
 * rest are recorded seams - the integrator replaces each `merged: false`
 * entry with the facade call at its merge step and nothing else moves.
 */
export const DIRECTIONS: Readonly<Record<string, DirectionSeam>> = {
  // OpenAI chat-completions client surface
  'chat:claude-api-key': { id: 'oai2cla', importPath: OAI2CLA_PATH, merged: true },
  'chat:openai-compatibility': {
    id: 'oai2oai (openai-compat executor)',
    importPath: 'packages/executors (I-exec-custom-openai / I-exec-openai)',
    merged: false,
  },
  'chat:gemini-api-key': { id: 'oai2gem', importPath: '@cpa-edge/translators/oai2gem', merged: false },
  'chat:codex-api-key': { id: 'oai2codex', importPath: '@cpa-edge/translators/oai2codex', merged: false },
  'chat:xai-api-key': { id: 'xai executor', importPath: 'packages/executors (I-exec-grok)', merged: false },
  'chat:meta-api-key': { id: 'meta executor', importPath: 'packages/executors', merged: false },
  'chat:interactions-api-key': { id: 'interactions executor', importPath: 'packages/executors', merged: false },
  'chat:vertex-api-key': { id: 'vertex executor', importPath: 'packages/executors', merged: false },
  // Claude messages client surface
  'messages:claude-api-key': {
    id: 'claude passthrough',
    importPath: 'packages/executors (I-exec-claude)',
    merged: false,
  },
  'messages:openai-compatibility': { id: 'cla2oai', importPath: '@cpa-edge/translators/cla2oai', merged: false },
  'messages:gemini-api-key': { id: 'cla2gem', importPath: '@cpa-edge/translators/cla2gem', merged: false },
  // Responses client surface
  'responses:codex-api-key': {
    id: 'codex-passthrough',
    importPath: '@cpa-edge/translators/codex-passthrough',
    merged: false,
  },
  'responses:openai-compatibility': { id: 'res2oai', importPath: '@cpa-edge/translators/res2oai', merged: false },
  // Gemini v1beta client surface
  'v1beta:openai-compatibility': { id: 'gem2oai', importPath: GEM2OAI_PATH, merged: true },
  'v1beta:claude-api-key': { id: 'gem2cla', importPath: GEM2CLA_PATH, merged: true },
  'v1beta:gemini-api-key': {
    id: 'gemini passthrough',
    importPath: 'packages/executors (I-exec-gemini)',
    merged: false,
  },
}

/** The seam answer for a not-yet-merged direction (never a pinned body). */
export function directionNotMerged(): GatewayResponse {
  return plainJson(503, directionNotMergedBody())
}

// ---------------------------------------------------------------------------
// Request context
// ---------------------------------------------------------------------------

/** Result of the transport-level request-body decode (S1 §5). */
type BodyDecode =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly message: string }

/** Per-request context handed to the handlers. */
interface RequestContext {
  readonly request: GatewayRequest
  readonly url: URL
  readonly match: RouteMatch
  readonly now: () => number
  /** Lazily decoded request body (content-encoding handling). */
  decodeBody(): BodyDecode
  /** Headers for facade dispatch (normalized after auth, see below). */
  facadeHeaders: HeaderList
}

/** Applies the content-encoding chain last-to-first (recorded order). */
function decodeBodyBytes(
  body: Uint8Array,
  contentEncoding: string | undefined,
  zstdDecode: ((input: Uint8Array) => Uint8Array) | undefined,
): BodyDecode {
  const chain = (contentEncoding ?? '')
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.length > 0 && token.toLowerCase() !== 'identity')
  const decoder = new TextDecoder()
  let bytes = body
  for (let index = chain.length - 1; index >= 0; index--) {
    const token = chain[index]
    if (token === undefined) continue
    if (token.toLowerCase() !== 'zstd') {
      return { ok: false, message: `unsupported content encoding: ${token}` }
    }
    if (zstdDecode === undefined) {
      // No decoder linked yet (dependency requested): every zstd body
      // fails decode and surfaces the pinned magic-mismatch wording.
      return { ok: false, message: ZSTD_MAGIC_MISMATCH }
    }
    try {
      bytes = zstdDecode(bytes)
    } catch {
      return { ok: false, message: ZSTD_MAGIC_MISMATCH }
    }
  }
  return { ok: true, text: decoder.decode(bytes) }
}

/** Builds a Web `Request` for plane / management delegation. */
function toWebRequest(context: RequestContext): Request {
  return new Request(context.url.toString(), {
    method: context.request.method,
    headers: new Headers(context.request.headers as Array<[string, string]>),
    body: context.request.body.length === 0 && context.request.method === 'GET'
      ? undefined
      : new Uint8Array(context.request.body),
  })
}

/** Converts a plane/management `Response` into the gateway shape. */
async function fromWebResponse(response: Response): Promise<GatewayResponse> {
  const headers: Array<[string, string]> = []
  response.headers.forEach((value, name) => {
    headers.push([name, value])
  })
  const body = await response.text()
  return { status: response.status, headers, body }
}

/**
 * Auth normalization seam (binding instruction, S1 cross-check):
 *
 * The route layer owns the full five-transport client-auth gate via
 * `createAuthPlane.authenticateProxy` (Authorization bearer-or-verbatim,
 * X-Goog-Api-Key, X-Api-Key, `?key=`, `?auth_token=`). The merged
 * direction facades re-run a narrower internal gate as a contract-harness
 * convenience, so after a SUCCESSFUL route-level authentication the
 * request is normalized before facade dispatch: the `Authorization`
 * header is rewritten to `Bearer <the accepted key>` (or injected when
 * the accepted credential came from a query parameter). Open mode (no
 * configured api-keys) passes an unchanged header list - the facade gates
 * are open there too.
 */
function normalizeFacadeHeaders(headers: HeaderList, acceptedKey: string): HeaderList {
  if (acceptedKey.length === 0) return headers
  const out: Array<[string, string]> = []
  let replaced = false
  for (const [name, value] of headers) {
    if (name.toLowerCase() === 'authorization') {
      out.push(['Authorization', `Bearer ${acceptedKey}`])
      replaced = true
      continue
    }
    out.push([name, value])
  }
  if (!replaced) out.unshift(['Authorization', `Bearer ${acceptedKey}`])
  return out
}

/** One accepted client-credential verdict after the route-level gate. */
interface ClientPrincipal {
  readonly open: boolean
  readonly apiKey: string
}

/** Evaluates the shared gate result again to learn the accepted key. */
function clientPrincipal(config: NormalizedConfig, context: RequestContext): ClientPrincipal {
  const result = authenticateClientRequest({
    apiKeys: config.apiKeys,
    headers: {
      ...(headerValue(context.request.headers, 'authorization') === undefined
        ? {}
        : { authorization: headerValue(context.request.headers, 'authorization') as string }),
      ...(headerValue(context.request.headers, 'x-goog-api-key') === undefined
        ? {}
        : { 'x-goog-api-key': headerValue(context.request.headers, 'x-goog-api-key') as string }),
      ...(headerValue(context.request.headers, 'x-api-key') === undefined
        ? {}
        : { 'x-api-key': headerValue(context.request.headers, 'x-api-key') as string }),
    },
    url: context.url.toString(),
  })
  if (result.ok) return { open: result.open, apiKey: result.apiKey }
  // authenticateProxy already rejected the request; this is unreachable
  // in the pipeline and exists only to keep the type narrow.
  return { open: false, apiKey: '' }
}

// ---------------------------------------------------------------------------
// Facade dispatch helpers
// ---------------------------------------------------------------------------

/** Outcome of one direction dispatch. */
interface DispatchOutcome {
  readonly response: GatewayResponse
  /** Set when an upstream credential was selected (trace emission). */
  readonly credentialIndex?: number
}

/** Node transport: forwards one facade wire request via fetch. */
function makeSender(fetchLike: FetchLike): (request: UpstreamWireRequest) => Promise<UpstreamWireResponse> {
  const STRIPPED = new Set(['host', 'content-length', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade'])
  return async (request) => {
    const headers = new Headers()
    for (const [name, value] of request.headers) {
      if (STRIPPED.has(name.toLowerCase())) continue
      headers.append(name, value)
    }
    const response = await fetchLike(request.url, {
      method: request.method,
      headers,
      body: request.body,
      redirect: 'manual',
    })
    const responseHeaders: Array<[string, string]> = []
    response.headers.forEach((value, name) => {
      responseHeaders.push([name, value])
    })
    const body =
      response.body ??
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close()
        },
      })
    return { status: response.status, headers: responseHeaders, body }
  }
}

/**
 * Hostile-input guard (hardening instruction): deeply nested bodies make
 * JSON parsing inside a facade throw RangeError. Go's encoding/json
 * rejects >10000 nesting depth with a decode error; the runtime mirrors
 * that at the route layer so every direction facade is covered uniformly
 * without re-gating the merged modules.
 */
async function guardedDispatch(
  run: () => Promise<DispatchOutcome>,
  renderDepthFailure: () => GatewayResponse,
): Promise<DispatchOutcome> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof RangeError) {
      return { response: renderDepthFailure() }
    }
    throw error
  }
}

/** Chat-surface dispatch into the merged oai2cla facade. */
async function dispatchOai2Cla(
  context: RequestContext,
  bodyText: string,
  service: oai2cla.Oai2ClaChatService,
  send: (request: UpstreamWireRequest) => Promise<UpstreamWireResponse>,
): Promise<DispatchOutcome> {
  const outcome = await guardedDispatch(async () => {
    const response = await service.handleChatCompletions(
      {
        method: context.request.method,
        path: `${context.url.pathname}${context.url.search}`,
        headers: context.facadeHeaders,
        body: bodyText,
      },
      send,
    )
    return { response }
  }, () => plainJson(400, invalidRequestBody(MAX_DEPTH_MESSAGE.slice('Invalid request: '.length))))
  return outcome
}

// ---------------------------------------------------------------------------
// Model lists (S1 §6.2)
// ---------------------------------------------------------------------------

/** RFC3339 seconds-precision timestamp of the list `created_at` fields. */
function rfc3339Seconds(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 19) + 'Z'
}

/** Cloaks a model id for the Claude list shape (S1-09/S1-10). */
function cloakModelId(id: string): string {
  if (id.startsWith('claude-')) return id
  return `claude-fable-5-dd-${[...id].reverse().join('')}`
}

/** `GET /v1/models` in the default (OpenAI) shape. */
function openAiModelsListBody(registry: ModelRegistry, nowMs: number): string {
  const epochSeconds = Math.floor(nowMs / 1000)
  const data = registry.list().map((model) => ({
    created: epochSeconds,
    id: model.id,
    object: 'model',
    owned_by: model.ownedBy,
  }))
  return JSON.stringify({ data, object: 'list' })
}

/** `GET /v1/models` in the Claude shape (header/UA switch, cloaking). */
function claudeModelsListBody(registry: ModelRegistry, nowMs: number, cloak: boolean): string {
  const createdAt = rfc3339Seconds(nowMs)
  const data = registry.list().map((model) => ({
    created_at: createdAt,
    display_name: model.id,
    id: cloak ? cloakModelId(model.id) : model.id,
    max_input_tokens: 200000,
    max_tokens: 64000,
    object: 'model',
    owned_by: model.ownedBy,
    type: 'model',
  }))
  const ids = data.map((entry) => entry.id)
  return JSON.stringify({
    data,
    first_id: ids[0] ?? '',
    has_more: false,
    last_id: ids[ids.length - 1] ?? '',
  })
}

// ---------------------------------------------------------------------------
// Gateway construction
// ---------------------------------------------------------------------------

/** Builds the composed node gateway. */
export function createNodeGateway(options: NodeGatewayOptions): NodeGateway {
  const config = normalizeRuntimeConfig(options.config)
  const now = options.now ?? (() => Date.now())
  const store = options.store ?? new MemoryStore()
  const capabilities = options.capabilities ?? NODE_RUNTIME_CAPABILITIES
  const fetchLike: FetchLike = options.fetch ?? ((input, init) => fetch(input, init))
  const send = makeSender(fetchLike)

  const envManagementPassword = typeof process !== 'undefined'
    ? (process.env['MANAGEMENT_PASSWORD'] ?? '')
    : ''
  const managementSecret = config.remoteManagement.secretKey.length > 0
    ? config.remoteManagement.secretKey
    : envManagementPassword
  const planeConfig: AuthPlaneConfig = {
    port: config.port,
    apiKeys: config.apiKeys,
    remoteManagement: {
      allowRemote: config.remoteManagement.allowRemote,
      ...(managementSecret.length > 0 ? { secretKey: managementSecret } : {}),
    },
  }
  const plane = createAuthPlane(planeConfig, {
    store,
    now,
    ...(options.remoteAddress === undefined ? {} : { remoteAddress: options.remoteAddress }),
  })

  const registry = new ModelRegistry(config.providers)
  const gatewayVersion = GATEWAY_VERSION

  const claudeChatService = oai2cla.createOai2ClaChatService({
    credentials: claudeCredentialsForChat(config),
    gatewayVersion,
    store,
    now,
    requestRetry: config.requestRetry,
    transientErrorCooldownSeconds: config.transientErrorCooldownSeconds,
  })
  const gem2OaiService = gem2oai.createGem2OaiService({
    credentials: openAiCompatCredentials(config),
    registry: registry.list().map((model) => ({
      id: model.id,
      ...(model.displayName === undefined ? {} : { displayName: model.displayName }),
    })),
    apiKeys: config.apiKeys,
    store,
    now,
    requestRetry: config.requestRetry,
    transientErrorCooldownSeconds: config.transientErrorCooldownSeconds,
  })
  const gem2ClaService = gem2cla.createGem2ClaService({
    apiKeys: config.apiKeys,
    credentials: claudeCredentialsForGemini(config),
    gatewayVersion,
    store,
    now,
    requestRetry: config.requestRetry,
    transientErrorCooldownSeconds: config.transientErrorCooldownSeconds,
  })

  const codexConfigured = config.providers.some((provider) => provider.family === 'codex-api-key')

  const hasKeepAlive = (options.keepAlivePassword ?? '').length > 0

  /** Applies trace + CORS to a facade-dispatched response. */
  const finalize = (
    response: GatewayResponse,
    traceIndex: number | undefined,
  ): GatewayResponse => {
    let headers = response.headers
    if (traceIndex !== undefined) {
      const traceId = newTraceId(traceIndex, new Date(now()))
      const kept = headers.filter(([name]) => name.toLowerCase() !== TRACE_HEADER.toLowerCase())
      headers = [...kept, [TRACE_HEADER, traceId]]
    }
    return { status: response.status, headers: withCors(headers), body: response.body }
  }

  /** Renders a body-decode failure in the OpenAI-family envelope. */
  const openAiDecodeFailure = (message: string): GatewayResponse =>
    plainJson(400, invalidRequestBody(message))

  /** Renders a body-decode failure in the Claude envelope. */
  const claudeDecodeFailure = (message: string): GatewayResponse =>
    plainJson(400, claudeInvalidRequestBody(`Invalid request: ${message}`))

  /** Reads + decodes the request body per surface. */
  const decodeOrFail = (
    context: RequestContext,
    render: (message: string) => GatewayResponse,
  ): { readonly text: string } | { readonly response: GatewayResponse } => {
    const decoded = context.decodeBody()
    if (!decoded.ok) return { response: render(decoded.message) }
    return { text: decoded.text }
  }

  /** Parses JSON guarded against hostile nesting depth. */
  const parseJsonGuarded = (
    text: string,
    renderDepthFailure: () => GatewayResponse,
  ): { readonly value: unknown } | { readonly response: GatewayResponse } => {
    try {
      return { value: JSON.parse(text) }
    } catch (error) {
      if (error instanceof RangeError) return { response: renderDepthFailure() }
      return { value: undefined }
    }
  }

  const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)

  /** Chat-family model resolution -> facade dispatch (S1 §3.2). */
  const dispatchChat = async (context: RequestContext, surfacePath: string): Promise<GatewayResponse> => {
    const decoded = decodeOrFail(context, openAiDecodeFailure)
    if ('response' in decoded) return decoded.response
    const parsed = parseJsonGuarded(decoded.text, () => plainJson(400, invalidRequestBody(MAX_DEPTH_MESSAGE.slice('Invalid request: '.length))))
    if ('response' in parsed) return parsed.response
    const body = isPlainObject(parsed.value) ? parsed.value : {}
    const model = typeof body['model'] === 'string' ? body['model'] : ''
    if (registry.isImageModel(model)) {
      return plainJson(503, imageOnlyModelBody(model))
    }
    const resolved = registry.resolve(model)
    if (resolved === undefined || resolved.family === 'claude-api-key') {
      // The merged chat-surface facade owns both the `model_not_found`
      // rendering and the claude translation (empty candidate lists
      // render the same 400 as upstream).
      const outcome = await dispatchOai2Cla(context, decoded.text, claudeChatService, send)
      return finalize(outcome.response, resolved === undefined ? undefined : resolved.familyIndex)
    }
    const seam = DIRECTIONS[`chat:${resolved.family}`]
    return directionNotMerged()
  }

  /** Claude-messages surface (S1 §3.3): seams until cla2* merge. */
  const dispatchMessages = (context: RequestContext): GatewayResponse => {
    const decoded = decodeOrFail(context, claudeDecodeFailure)
    if ('response' in decoded) return decoded.response
    const parsed = parseJsonGuarded(decoded.text, () => plainJson(400, claudeInvalidRequestBody(MAX_DEPTH_MESSAGE)))
    if ('response' in parsed) return parsed.response
    const body = isPlainObject(parsed.value) ? parsed.value : {}
    const model = typeof body['model'] === 'string' ? body['model'] : ''
    if (registry.isImageModel(model)) {
      return plainJson(503, imageOnlyModelBody(model))
    }
    const resolved = registry.resolve(model)
    if (resolved === undefined) {
      return plainJson(400, claudeModelNotFoundBody(model))
    }
    return directionNotMerged()
  }

  /** Responses surface (S1 §3.2/§3.5). */
  const dispatchResponses = (context: RequestContext): GatewayResponse => {
    const decoded = decodeOrFail(context, openAiDecodeFailure)
    if ('response' in decoded) return decoded.response
    const parsed = parseJsonGuarded(decoded.text, () => plainJson(400, invalidRequestBody(MAX_DEPTH_MESSAGE.slice('Invalid request: '.length))))
    if ('response' in parsed) return parsed.response
    const body = isPlainObject(parsed.value) ? parsed.value : {}
    const model = typeof body['model'] === 'string' ? body['model'] : ''
    if (registry.isImageModel(model)) {
      return plainJson(503, imageOnlyModelBody(model))
    }
    const resolved = registry.resolve(model)
    if (resolved === undefined) {
      return plainJson(400, modelNotFoundBody(model))
    }
    return directionNotMerged()
  }

  /** POST /v1/responses/compact (S1-18). */
  const dispatchResponsesCompact = (context: RequestContext): GatewayResponse => {
    const decoded = decodeOrFail(context, openAiDecodeFailure)
    if ('response' in decoded) return decoded.response
    const parsed = parseJsonGuarded(decoded.text, () => plainJson(400, invalidRequestBody(MAX_DEPTH_MESSAGE.slice('Invalid request: '.length))))
    if ('response' in parsed) return parsed.response
    const body = isPlainObject(parsed.value) ? parsed.value : {}
    if (body['stream'] === true) {
      return charsetJson(400, compactStreamRejectionBody())
    }
    const model = typeof body['model'] === 'string' ? body['model'] : ''
    const resolved = registry.resolve(model)
    if (resolved === undefined) {
      return plainJson(400, modelNotFoundBody(model))
    }
    return directionNotMerged()
  }

  /** Images surface gates (S1 §3.2 + S1-25). */
  const dispatchImages = (context: RequestContext): GatewayResponse => {
    if (config.imageGenerationMode === true) {
      // Bool `true`: the all-disabled state - both images routes are
      // absent (404 empty) before the body is even read.
      return emptyNotFound()
    }
    const decoded = decodeOrFail(context, (message) => charsetJson(400, invalidRequestBody(message)))
    if ('response' in decoded) return decoded.response
    const parsed = parseJsonGuarded(decoded.text, () => charsetJson(400, invalidRequestBody(MAX_DEPTH_MESSAGE.slice('Invalid request: '.length))))
    if ('response' in parsed) return parsed.response
    const body = isPlainObject(parsed.value) ? parsed.value : {}
    const prompt = body['prompt']
    if (typeof prompt !== 'string' || prompt.length === 0) {
      return charsetJson(400, invalidRequestBody('prompt is required'))
    }
    const model = typeof body['model'] === 'string' ? body['model'] : ''
    if (!registry.isImageModel(model)) {
      return charsetJson(400, imagesUnsupportedModelBody(model))
    }
    return directionNotMerged()
  }

  /** v1beta structural dispatch (S1 §3.4). */
  const dispatchV1BetaAction = async (
    context: RequestContext,
    principal: ClientPrincipal,
  ): Promise<GatewayResponse> => {
    const pathname = context.url.pathname
    const actionPrefix = '/v1beta/models/'
    const action = pathname.length > actionPrefix.length ? pathname.slice(actionPrefix.length) : ''
    const parsed = gem2oai.parseModelMethod(action)
    if (parsed === undefined) {
      return finalize(charsetJson(404, gem2oai.actionNotFoundBody(pathname)), undefined)
    }
    const method = parsed.method
    if (method !== 'generateContent' && method !== 'streamGenerateContent' && method !== 'countTokens') {
      // Silent fall-through (recorded S1-13): the action parses, nothing
      // is written, no headers, no upstream dispatch, no trace.
      return { status: 200, headers: [], body: '' }
    }
    const wire = {
      method: context.request.method,
      path: `${pathname}${context.url.search}`,
      headers: context.facadeHeaders,
      body: '',
    }
    const resolved = registry.resolve(parsed.model)
    const decoded = decodeOrFail(context, openAiDecodeFailure)
    if ('response' in decoded) return decoded.response
    wire.body = decoded.text

    const dispatchTo = async (
      run: () => Promise<Gem2OaiWireOutcome>,
    ): Promise<Gem2OaiWireOutcome> => {
      try {
        return await run()
      } catch (error) {
        if (error instanceof RangeError) {
          return { response: plainJson(400, invalidRequestBody(MAX_DEPTH_MESSAGE.slice('Invalid request: '.length))), trace: undefined }
        }
        throw error
      }
    }

    if (resolved === undefined) {
      // Unresolved model: the surface-level OpenAI-shaped 400 (the
      // gemini surface uses the OpenAI shape, S1 §8).
      return finalize(plainJson(400, gem2oai.modelNotFoundBody(parsed.model)), undefined)
    }
    if (resolved.family === 'openai-compatibility') {
      const outcome = await dispatchTo(async () => ({
        response: await gem2OaiService.handleV1Beta(
          { method: wire.method, path: wire.path, headers: wire.headers, body: wire.body },
          send,
        ),
        trace: resolved.familyIndex,
      }))
      return finalize(outcome.response, outcome.trace)
    }
    if (resolved.family === 'claude-api-key') {
      const outcome = await dispatchTo(async () => ({
        response: await gem2ClaService.handleV1beta(
          { method: wire.method, path: wire.path, headers: wire.headers, body: wire.body },
          send,
        ),
        trace: resolved.familyIndex,
      }))
      return finalize(outcome.response, outcome.trace)
    }
    return directionNotMerged()
  }

  /** v1beta GET delegation (model discovery, registry-generic, S1 §6.2). */
  const dispatchV1BetaDiscovery = async (context: RequestContext): Promise<GatewayResponse> => {
    try {
      const response = await gem2OaiService.handleV1Beta(
        {
          method: context.request.method,
          path: `${context.url.pathname}${context.url.search}`,
          headers: context.facadeHeaders,
          body: '',
        },
        send,
      )
      return finalize(response, undefined)
    } catch (error) {
      if (error instanceof RangeError) {
        return plainJson(400, invalidRequestBody(MAX_DEPTH_MESSAGE.slice('Invalid request: '.length)))
      }
      throw error
    }
  }

  /** POST /v1beta/interactions validation gates (S1-25). */
  const dispatchInteractions = (context: RequestContext): GatewayResponse => {
    const decoded = decodeOrFail(context, (message) => charsetJson(400, invalidRequestBody(message)))
    if ('response' in decoded) return decoded.response
    const parsed = parseJsonGuarded(decoded.text, () => charsetJson(400, invalidRequestBody(MAX_DEPTH_MESSAGE.slice('Invalid request: '.length))))
    if ('response' in parsed) return parsed.response
    const body = isPlainObject(parsed.value) ? parsed.value : {}
    const hasModel = typeof body['model'] === 'string' && (body['model'] as string).length > 0
    const hasAgent = typeof body['agent'] === 'string' && (body['agent'] as string).length > 0
    if (hasModel === hasAgent) {
      return charsetJson(400, INTERACTIONS_EXACTLY_ONE_BODY)
    }
    if (body['stream'] !== undefined && typeof body['stream'] !== 'boolean') {
      return charsetJson(400, INTERACTIONS_STREAM_BOOLEAN_BODY)
    }
    return directionNotMerged()
  }

  /** Codex-only routes without codex credentials (S1-23). */
  const codexUnavailable = (): GatewayResponse => charsetJson(503, CODEX_AUTH_UNAVAILABLE_BODY)

  /** Realtime/live call-id pattern (recorded). */
  const CALL_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

  const isWebSocketUpgrade = (context: RequestContext): boolean => {
    const connection = (headerValue(context.request.headers, 'connection') ?? '').toLowerCase()
    const upgrade = (headerValue(context.request.headers, 'upgrade') ?? '').toLowerCase()
    return connection.split(',').map((part) => part.trim()).includes('upgrade') && upgrade === 'websocket'
  }

  /** Handler table. Each returns the pre-CORS response. */
  const handleById = async (
    context: RequestContext,
    principal: ClientPrincipal,
  ): Promise<{ readonly response: GatewayResponse; readonly noCors?: boolean; readonly trace?: number }> => {
    const id = context.match.entry.id
    const nowMs = now()
    switch (id) {
      case 'root': {
        const safePage = plane.serveSafeModePage(toWebRequest(context))
        if (safePage !== null) return { response: await fromWebResponse(safePage) }
        return { response: charsetJson(200, ROOT_BODY) }
      }
      case 'healthz': {
        if (context.request.method === 'HEAD') return { response: { status: 200, headers: [], body: '' } }
        return { response: charsetJson(200, STATUS_OK_BODY) }
      }
      case 'management-panel': {
        const safePage = plane.serveSafeModePage(toWebRequest(context))
        if (safePage !== null) return { response: await fromWebResponse(safePage) }
        if (config.remoteManagement.disableControlPanel) return { response: emptyNotFound() }
        if (options.managementPanelHtml === undefined) {
          // No panel asset bundled/downloaded: the recorded `asset
          // missing` behavior is the empty 404.
          return { response: emptyNotFound() }
        }
        return { response: html(200, options.managementPanelHtml) }
      }
      case 'keep-alive': {
        if (!hasKeepAlive) return { response: emptyNotFound() }
        const password = options.keepAlivePassword ?? ''
        const authorization = headerValue(context.request.headers, 'authorization')
        const bearer = authorization !== undefined && authorization.startsWith('Bearer ')
          ? authorization.slice('Bearer '.length)
          : ''
        const local = headerValue(context.request.headers, 'x-local-password') ?? ''
        if (bearer === password || (local.length > 0 && local === password)) {
          return { response: charsetJson(200, STATUS_OK_BODY) }
        }
        return { response: charsetJson(401, KEEPALIVE_INVALID_BODY) }
      }
      case 'callback-anthropic':
      case 'callback-codex':
      case 'callback-antigravity': {
        const provider = id === 'callback-anthropic' ? 'anthropic' : id === 'callback-codex' ? 'codex' : 'antigravity'
        return { response: await fromWebResponse(await plane.handlePlainCallback(toWebRequest(context), provider)) }
      }
      case 'callback-devin': {
        return { response: await fromWebResponse(await plane.handleDevinCallback(toWebRequest(context))) }
      }
      case 'mgmt-oauth-callback': {
        if (!plane.managementAvailable()) return { response: emptyNotFound() }
        return { response: await fromWebResponse(await plane.handleManagementOauthCallback(toWebRequest(context))) }
      }
      case 'mgmt-auth-url': {
        const provider = context.url.pathname.slice('/v0/management/'.length).replace(/-auth-url$/, '')
        if (provider !== 'anthropic' && provider !== 'codex' && provider !== 'antigravity' &&
          provider !== 'kimi' && provider !== 'xai' && provider !== 'devin' && provider !== 'meta') {
          return { response: emptyNotFound() }
        }
        return { response: await fromWebResponse(await plane.handleAuthUrl(toWebRequest(context), provider)) }
      }
      case 'mgmt-get-auth-status': {
        return { response: await fromWebResponse(await plane.handleGetAuthStatus(toWebRequest(context))) }
      }
      case 'mgmt-oauth-session': {
        return { response: await fromWebResponse(await plane.handleOauthSession(toWebRequest(context))) }
      }
      case 'mgmt-rest': {
        if (options.managementApi !== undefined) {
          const wire = await options.managementApi.handle(toWebRequest(context))
          return { response: { status: wire.status, headers: wire.rawHeaders, body: await readWireBody(wire) } }
        }
        // Payload routes wait for the I-mgmt merge (dispatch seam): the
        // auth matrix above answers; everything else is the recorded
        // unknown-subroute 404.
        return { response: emptyNotFound() }
      }
      case 'models-list': {
        const anthropicVersion = headerValue(context.request.headers, 'anthropic-version')
        const userAgent = headerValue(context.request.headers, 'user-agent') ?? ''
        if (
          (anthropicVersion !== undefined && anthropicVersion.length > 0) ||
          userAgent.startsWith('claude-cli')
        ) {
          return {
            response: charsetJson(200, claudeModelsListBody(registry, nowMs, !config.disableCloakingModelList)),
          }
        }
        return { response: charsetJson(200, openAiModelsListBody(registry, nowMs)) }
      }
      case 'chat-completions':
      case 'completions': {
        return { response: await dispatchChat(context, context.url.pathname) }
      }
      case 'messages':
      case 'messages-count-tokens': {
        return { response: dispatchMessages(context) }
      }
      case 'responses': {
        return { response: dispatchResponses(context) }
      }
      case 'responses-compact': {
        return { response: dispatchResponsesCompact(context) }
      }
      case 'responses-ws': {
        if (!isWebSocketUpgrade(context)) {
          // gorilla handshake failure: plain text + handshake headers.
          return {
            response: plainText(400, 'Bad Request', [
              ['Sec-Websocket-Version', '13'],
              ['X-Content-Type-Options', 'nosniff'],
            ]),
          }
        }
        return { response: directionNotMerged() }
      }
      case 'images-generations':
      case 'images-edits': {
        return { response: dispatchImages(context) }
      }
      case 'videos-create':
      case 'videos-retrieve':
      case 'openai-videos-create':
      case 'openai-videos-retrieve':
      case 'openai-videos-content': {
        return { response: directionNotMerged() }
      }
      case 'alpha-search': {
        if (!codexConfigured) return { response: codexUnavailable() }
        return { response: directionNotMerged() }
      }
      case 'live-call': {
        if (!codexConfigured) return { response: codexUnavailable() }
        return { response: directionNotMerged() }
      }
      case 'live-sideband': {
        const callId = context.match.params['call_id'] ?? ''
        if (!isWebSocketUpgrade(context)) {
          return { response: charsetJson(426, plainErrorBody('WebSocket upgrade required'), [['Upgrade', 'websocket']]) }
        }
        if (!CALL_ID_PATTERN.test(callId)) {
          return { response: charsetJson(400, plainErrorBody('Invalid Codex live call ID')) }
        }
        // No live-session registry merged yet: every well-formed id is
        // the recorded unknown-call 404.
        return { response: charsetJson(404, plainErrorBody('Codex live session not found')) }
      }
      case 'realtime-ws': {
        const callId = context.url.searchParams.get('call_id')
        if (!isWebSocketUpgrade(context)) {
          const code = callId !== null ? 'realtime_request_failed' : 'websocket_upgrade_required'
          return {
            response: charsetJson(426, realtimeEnvelope(code, 'WebSocket upgrade required', 'invalid_request_error'), [
              ['Upgrade', 'websocket'],
            ]),
          }
        }
        return { response: directionNotMerged() }
      }
      case 'realtime-call': {
        if (!codexConfigured) {
          // Nested envelope on /v1/realtime* paths (recorded prefix rule).
          return {
            response: charsetJson(503, realtimeEnvelope('realtime_request_failed', CODEX_AUTH_UNAVAILABLE_BODY.slice(12, -2), 'api_error')),
          }
        }
        return { response: directionNotMerged() }
      }
      case 'realtime-calls-sideband': {
        const callId = context.match.params['call_id'] ?? ''
        if (!isWebSocketUpgrade(context)) {
          return {
            response: charsetJson(426, realtimeEnvelope('realtime_request_failed', 'WebSocket upgrade required', 'invalid_request_error'), [
              ['Upgrade', 'websocket'],
            ]),
          }
        }
        if (!CALL_ID_PATTERN.test(callId)) {
          return { response: charsetJson(400, realtimeEnvelope('realtime_request_failed', 'Invalid Codex live call ID', 'invalid_request_error')) }
        }
        return { response: charsetJson(404, realtimeEnvelope('realtime_request_failed', 'Codex live session not found', 'invalid_request_error')) }
      }
      case 'realtime-hangup': {
        const callId = context.match.params['call_id'] ?? ''
        if (!CALL_ID_PATTERN.test(callId)) {
          return { response: charsetJson(400, realtimeEnvelope('invalid_call_id', 'Invalid Realtime call ID', 'invalid_request_error')) }
        }
        // No live-session registry merged: the recorded not-found body.
        return { response: charsetJson(404, realtimeEnvelope('realtime_call_not_found', 'Realtime call not found', 'invalid_request_error')) }
      }
      case 'realtime-sip-accept':
      case 'realtime-sip-reject':
      case 'realtime-sip-refer': {
        const verb = id === 'realtime-sip-accept' ? 'accept' : id === 'realtime-sip-reject' ? 'reject' : 'refer'
        return {
          response: charsetJson(
            501,
            realtimeEnvelope(
              'realtime_capability_not_supported',
              `Realtime SIP ${verb} are not supported by the ChatGPT/Codex OAuth upstream`,
              'not_supported_error',
            ),
          ),
        }
      }
      case 'realtime-client-secrets': {
        const decoded = decodeOrFail(context, (message) => charsetJson(400, invalidRequestBody(message)))
        if ('response' in decoded) return { response: decoded.response }
        const parsed = parseJsonGuarded(decoded.text, () => charsetJson(400, realtimeInvalidSecretBody()))
        if ('response' in parsed) return { response: parsed.response }
        if (!isPlainObject(parsed.value)) {
          return { response: charsetJson(400, realtimeInvalidSecretBody()) }
        }
        return { response: await mintRealtimeSecret(plane, nowMs, isPlainObject(parsed.value) ? parsed.value : {}) }
      }
      case 'realtime-sessions': {
        return { response: await mintRealtimeSecret(plane, nowMs, {}) }
      }
      case 'realtime-transcription-sessions': {
        return {
          response: charsetJson(
            501,
            realtimeEnvelope(
              'realtime_capability_not_supported',
              'Realtime transcription-only sessions are not supported by the ChatGPT/Codex OAuth upstream',
              'not_supported_error',
            ),
          ),
        }
      }
      case 'realtime-translations-stub': {
        return {
          response: charsetJson(
            501,
            realtimeEnvelope(
              'realtime_capability_not_supported',
              'Realtime translation sessions are not supported by the ChatGPT/Codex OAuth upstream',
              'not_supported_error',
            ),
          ),
        }
      }
      case 'v1beta-models-list':
      case 'v1beta-models-action': {
        if (context.request.method === 'GET') {
          return { response: await dispatchV1BetaDiscovery(context) }
        }
        return { response: await dispatchV1BetaAction(context, principal) }
      }
      case 'v1beta-interactions': {
        return { response: dispatchInteractions(context) }
      }
      default: {
        // Exhaustiveness guard: a new route id without a handler.
        return { response: emptyNotFound() }
      }
    }
  }

  /** The main pipeline (S1 §2 order: OPTIONS -> redirect -> route -> auth). */
  const handle = async (request: GatewayRequest): Promise<GatewayResponse> => {
    const url = new URL(request.url)
    const pathname = url.pathname
    const method = request.method.toUpperCase()

    if (method === 'OPTIONS') {
      return { status: 204, headers: withCors([]), body: '' }
    }

    const redirect = evaluateRedirect(method, pathname, url.search.length > 0 ? url.search.slice(1) : '')
    if (redirect.redirect) {
      // Router layer, before middleware: NO CORS block (recorded).
      return redirectResponse(redirect.status, redirect.location, method)
    }

    const match = matchRoute(method, pathname)
    if (match === undefined) {
      return { status: 404, headers: withCors([]), body: '' }
    }

    let bodyDecoded: BodyDecode | undefined
    const context: RequestContext = {
      request,
      url,
      match,
      now,
      facadeHeaders: request.headers,
      decodeBody: () => {
        if (bodyDecoded === undefined) {
          bodyDecoded = decodeBodyBytes(request.body, headerValue(request.headers, 'content-encoding'), options.zstdDecode)
        }
        return bodyDecoded
      },
    }

    // Group gates (S1 §4).
    const group = match.entry.group
    if (group === 'client') {
      const rejected = await plane.authenticateProxy(toWebRequest(context))
      if (rejected !== null) {
        const response = await fromWebResponse(rejected)
        return { status: response.status, headers: withCors(response.headers), body: response.body }
      }
      const principal = clientPrincipal(config, context)
      context.facadeHeaders = normalizeFacadeHeaders(request.headers, principal.apiKey)
    } else if (group === 'realtime' || group === 'realtime-standard') {
      const sealed = plane.safeModeProxyResponse(toWebRequest(context))
      if (sealed !== null) {
        const response = await fromWebResponse(sealed)
        return { status: response.status, headers: withCors(response.headers), body: response.body }
      }
      const gate =
        group === 'realtime'
          ? await plane.authenticateRealtime(toWebRequest(context))
          : await plane.authenticateRealtimeStandard(toWebRequest(context))
      if (gate !== null) {
        const response = await fromWebResponse(gate)
        return { status: response.status, headers: withCors(response.headers), body: response.body }
      }
    } else if (group === 'management') {
      if (!plane.managementAvailable()) {
        // Availability middleware: the whole surface is absent.
        return { status: 404, headers: withCors([]), body: '' }
      }
      if (options.managementApi === undefined) {
        const verdict = await plane.authenticateManagement(toWebRequest(context))
        if (!verdict.ok) {
          const response = await fromWebResponse(verdict.response)
          return { status: response.status, headers: withCors(response.headers), body: response.body }
        }
      }
    }

    const outcome = await handleById(context, clientPrincipal(config, context))
    if (outcome.noCors === true) return outcome.response
    const trace = outcome.trace
    const finalized = finalize(outcome.response, trace)
    return finalized
  }

  return {
    handle,
    capabilities,
    store,
    plane,
    config,
  }
}

/** Reads a `WireResponse` body once for the management delegation seam. */
async function readWireBody(response: Response & { readonly rawHeaders: HeaderList }): Promise<string> {
  return await response.text()
}

/** Nested 400 body of a bad client-secrets request (recorded S1-25). */
function realtimeInvalidSecretBody(): string {
  return realtimeEnvelope('invalid_request', 'Invalid Realtime client secret request', 'invalid_request_error')
}

/**
 * Mints one realtime client secret. The success body shape is not
 * golden-pinned (S1-25 records only the bad-JSON 400); this emits the
 * OpenAI-style `client_secret` envelope until a recording pins it.
 */
async function mintRealtimeSecret(
  plane: AuthPlane,
  nowMs: number,
  body: Record<string, unknown>,
): Promise<GatewayResponse> {
  const requested = typeof body['lifetime_ms'] === 'number' ? (body['lifetime_ms'] as number) : undefined
  const secret = await plane.realtimeSecrets.issue(requested)
  const payload = JSON.stringify({
    client_secret: {
      value: secret.token,
      expires_at: formatRfc3339(secret.expiresAtMs),
    },
  })
  return charsetJson(200, payload)
}

/** Outcome of a v1beta facade wire call. */
interface Gem2OaiWireOutcome {
  readonly response: GatewayResponse
  readonly trace?: number
}
