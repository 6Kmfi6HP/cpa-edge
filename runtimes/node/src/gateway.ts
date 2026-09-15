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
} from './config'
import { ModelRegistry } from './registry'
import { withCors } from './cors'
import { TRACE_HEADER, newTraceId } from './trace'
import {
  CODEX_AUTH_UNAVAILABLE_BODY,
  INTERACTIONS_EXACTLY_ONE_BODY,
  INTERACTIONS_INVALID_JSON_BODY,
  INTERACTIONS_STREAM_BOOLEAN_BODY,
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
  plainErrorBody,
  plainJson,
  plainText,
  realtimeEnvelope,
} from './envelopes'
import {
  evaluateRedirect,
  headerValue,
  matchRoute,
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
  /** zstd request-body decoder (dependency requested from the orchestrator). */
  readonly zstdDecode?: (input: Uint8Array) => Uint8Array
  /** Served control-panel HTML asset (upstream downloads it on first use). */
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

// ---------------------------------------------------------------------------
// Dispatch table - surfaces x provider families -> direction facade
// ---------------------------------------------------------------------------

/** Where a (surface, family) pair dispatches once its module merges. */
export interface DirectionSeam {
  /** Stable direction id (matches the STATUS step names). */
  readonly id: string
  /** Facade import path the integrator wires at merge time. */
  readonly importPath: string
  /** True when the runtime imports and dispatches this facade today. */
  readonly merged: boolean
}

/**
 * The full direction matrix. Merged entries are dispatched below; the
 * rest are recorded seams - the integrator replaces each `merged: false`
 * entry with the facade call at its merge step and nothing else moves.
 */
export const DIRECTIONS: Readonly<Record<string, DirectionSeam>> = {
  // OpenAI chat-completions client surface
  'chat:claude-api-key': { id: 'oai2cla', importPath: '@cpa-edge/translators/oai2cla', merged: true },
  'chat:openai-compatibility': {
    id: 'oai2oai (openai-compat executor)',
    importPath: 'packages/executors (I-exec-custom-openai / I-exec-openai)',
    merged: false,
  },
  'chat:gemini-api-key': {
    id: 'oai2gem',
    importPath: '@cpa-edge/translators/oai2gem',
    merged: false,
  },
  'chat:codex-api-key': {
    id: 'oai2codex',
    importPath: '@cpa-edge/translators/oai2codex',
    merged: false,
  },
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
  'messages:openai-compatibility': {
    id: 'cla2oai',
    importPath: '@cpa-edge/translators/cla2oai',
    merged: false,
  },
  'messages:gemini-api-key': {
    id: 'cla2gem',
    importPath: '@cpa-edge/translators/cla2gem',
    merged: false,
  },
  // Responses client surface
  'responses:codex-api-key': {
    id: 'codex-passthrough',
    importPath: '@cpa-edge/translators/codex-passthrough',
    merged: false,
  },
  'responses:openai-compatibility': {
    id: 'res2oai',
    importPath: '@cpa-edge/translators/res2oai',
    merged: false,
  },
  // Gemini v1beta client surface
  'v1beta:openai-compatibility': {
    id: 'gem2oai',
    importPath: '@cpa-edge/translators/gem2oai',
    merged: true,
  },
  'v1beta:claude-api-key': {
    id: 'gem2cla',
    importPath: '@cpa-edge/translators/gem2cla',
    merged: true,
  },
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
// Request context and shared helpers
// ---------------------------------------------------------------------------

/** Result of the transport-level request-body decode (S1 §5). */
interface BodyDecode {
  readonly ok: boolean
  readonly text: string
  readonly message: string
}

/** Per-request context handed to the handlers. */
interface RequestContext {
  readonly request: GatewayRequest
  readonly url: URL
  readonly match: RouteMatch
  readonly config: NormalizedConfig
  /** Headers for facade dispatch (normalized after the auth gate). */
  facadeHeaders: HeaderList
  /** Lazily decoded request body (content-encoding handling). */
  decodeBody(): BodyDecode
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
      return { ok: false, text: '', message: `unsupported content encoding: ${token}` }
    }
    if (zstdDecode === undefined) {
      // No decoder linked yet (dependency requested): every zstd body
      // fails decode and surfaces the pinned magic-mismatch wording.
      return { ok: false, text: '', message: ZSTD_MAGIC_MISMATCH }
    }
    try {
      bytes = zstdDecode(bytes)
    } catch {
      return { ok: false, text: '', message: ZSTD_MAGIC_MISMATCH }
    }
  }
  return { ok: true, text: decoder.decode(bytes), message: '' }
}

/** Builds a Web `Request` for plane / management delegation. */
function toWebRequest(context: RequestContext): Request {
  const hasBody = context.request.body.length > 0
  return new Request(context.url.toString(), {
    method: context.request.method,
    headers: new Headers(context.request.headers as Array<[string, string]>),
    ...(hasBody || context.request.method === 'POST' || context.request.method === 'PUT'
      ? { body: new Uint8Array(context.request.body) }
      : {}),
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
 * The route layer owns the FULL five-transport client-auth gate via
 * `createAuthPlane.authenticateProxy` (Authorization bearer-or-verbatim,
 * X-Goog-Api-Key, X-Api-Key, `?key=`, `?auth_token=`; non-Bearer schemes
 * rejected whole). The merged direction facades re-run a narrower
 * internal apiKeys gate as a contract-harness convenience, so after a
 * SUCCESSFUL route-level authentication the request is normalized before
 * facade dispatch: the `Authorization` header is rewritten to
 * `Bearer <the accepted key>` (or injected when the accepted credential
 * came from a query parameter or a non-Bearer presentation). Open mode
 * (no configured api-keys) passes an unchanged header list - the facade
 * gates are open there too.
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

/** Re-evaluates the shared gate to learn WHICH key was accepted. */
function acceptedApiKey(config: NormalizedConfig, context: RequestContext): string {
  const authorization = headerValue(context.request.headers, 'authorization')
  const goog = headerValue(context.request.headers, 'x-goog-api-key')
  const apiKeyHeader = headerValue(context.request.headers, 'x-api-key')
  const result = authenticateClientRequest({
    apiKeys: config.apiKeys,
    headers: {
      ...(authorization === undefined ? {} : { authorization }),
      ...(goog === undefined ? {} : { 'x-goog-api-key': goog }),
      ...(apiKeyHeader === undefined ? {} : { 'x-api-key': apiKeyHeader }),
    },
    url: context.url.toString(),
  })
  return result.ok ? result.apiKey : ''
}

/** JSON-parse outcome with the malformed flag surfaced. */
interface ParseOutcome {
  readonly value: unknown
  readonly malformed: boolean
}

/** Parses JSON guarded against hostile nesting (see guardedDispatch). */
function parseJsonGuarded(text: string): ParseOutcome | undefined {
  try {
    return { value: JSON.parse(text), malformed: false }
  } catch (error) {
    if (error instanceof RangeError) return undefined
    return { value: undefined, malformed: true }
  }
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Node transport: forwards one facade wire request via fetch. */
function makeSender(fetchLike: FetchLike): (request: UpstreamWireRequest) => Promise<UpstreamWireResponse> {
  const STRIPPED = new Set([
    'host',
    'content-length',
    'connection',
    'keep-alive',
    'transfer-encoding',
    'upgrade',
  ])
  return async (request) => {
    const headers: Record<string, string> = {}
    for (const [name, value] of request.headers) {
      if (STRIPPED.has(name.toLowerCase())) continue
      headers[name] = value
    }
    const response = await fetchLike(request.url, {
      method: request.method,
      headers,
      body: request.body,
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
 * the JSON parsers inside a facade throw RangeError (V8 stack overflow).
 * Go's encoding/json rejects >10000 nesting depth with a decode error;
 * the runtime mirrors that uniformly at the route layer so every
 * direction facade is covered without re-gating the merged modules.
 * The wording is route-owned (unpinned by any fixture).
 */
const depthFailureBody = (): string =>
  invalidRequestBody(MAX_DEPTH_MESSAGE.slice('Invalid request: '.length))

// ---------------------------------------------------------------------------
// Model lists (S1 §6.2)
// ---------------------------------------------------------------------------

/** RFC3339 seconds-precision timestamp of the list `created_at` fields. */
function rfc3339Seconds(nowMs: number): string {
  return `${new Date(nowMs).toISOString().slice(0, 19)}Z`
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
  const first = ids[0] ?? ''
  const last = ids.length > 0 ? (ids[ids.length - 1] ?? '') : ''
  return JSON.stringify({ data, first_id: first, has_more: false, last_id: last })
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

  const envManagementPassword =
    typeof process !== 'undefined' ? (process.env['MANAGEMENT_PASSWORD'] ?? '') : ''
  const managementSecret =
    config.remoteManagement.secretKey.length > 0 ? config.remoteManagement.secretKey : envManagementPassword
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

  const claudeChatService = oai2cla.createOai2ClaChatService({
    credentials: claudeCredentialsForChat(config),
    gatewayVersion: GATEWAY_VERSION,
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
    gatewayVersion: GATEWAY_VERSION,
    store,
    now,
    requestRetry: config.requestRetry,
    transientErrorCooldownSeconds: config.transientErrorCooldownSeconds,
  })

  const codexConfigured = config.providers.some((provider) => provider.family === 'codex-api-key')
  const hasKeepAlive = (options.keepAlivePassword ?? '').length > 0
  const CALL_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

  /** Handler outcome: response + the trace-eligible credential index. */
  interface Handled {
    readonly response: GatewayResponse
    readonly trace?: number
  }

  /** Applies the trace header + CORS block (every non-redirect response). */
  const finalizeResponse = (handled: Handled): GatewayResponse => {
    let headers = handled.response.headers
    if (handled.trace !== undefined) {
      const kept = headers.filter(([name]) => name.toLowerCase() !== TRACE_HEADER.toLowerCase())
      headers = [...kept, [TRACE_HEADER, newTraceId(handled.trace, new Date(now()))]]
    }
    return {
      status: handled.response.status,
      headers: withCors(headers),
      body: handled.response.body,
    }
  }

  const planeRejected = async (rejected: Response): Promise<GatewayResponse> => {
    const response = await fromWebResponse(rejected)
    return { status: response.status, headers: withCors(response.headers), body: response.body }
  }

  /** Reads + decodes the request body, rendering failures per surface. */
  const decodeOrFail = (
    context: RequestContext,
    render: (message: string) => GatewayResponse,
  ): { readonly text: string } | { readonly handled: Handled } => {
    const decoded = context.decodeBody()
    if (!decoded.ok) return { handled: { response: render(decoded.message) } }
    return { text: decoded.text }
  }

  /** Chat-family model resolution -> facade dispatch (S1 §3.2). */
  const dispatchChat = async (context: RequestContext): Promise<Handled> => {
    const decoded = decodeOrFail(context, (message) => plainJson(400, invalidRequestBody(message)))
    if ('handled' in decoded) return decoded.handled
    const parsed = parseJsonGuarded(decoded.text)
    if (parsed === undefined) return { response: plainJson(400, depthFailureBody()) }
    const model =
      parsed !== undefined && !parsed.malformed && isPlainObject(parsed.value) && typeof parsed.value['model'] === 'string'
        ? (parsed.value['model'] as string)
        : ''
    if (registry.isImageModel(model)) {
      return { response: plainJson(503, imageOnlyModelBody(model)) }
    }
    const resolved = registry.resolve(model)
    if (resolved === undefined || resolved.family === 'claude-api-key') {
      // The merged chat-surface facade owns both the `model_not_found`
      // rendering and the claude translation (an empty candidate list
      // renders the same 400 as upstream).
      try {
        const response = await claudeChatService.handleChatCompletions(
          {
            method: context.request.method,
            path: `${context.url.pathname}${context.url.search}`,
            headers: context.facadeHeaders,
            body: decoded.text,
          },
          send,
        )
        return { response, ...(resolved === undefined ? {} : { trace: resolved.familyIndex }) }
      } catch (error) {
        if (error instanceof RangeError) return { response: plainJson(400, depthFailureBody()) }
        throw error
      }
    }
    return { response: directionNotMerged() }
  }

  /** Claude-messages surface (S1 §3.3): seams until the cla2* merge. */
  const dispatchMessages = (context: RequestContext): Handled => {
    const decoded = decodeOrFail(context, (message) =>
      plainJson(400, claudeInvalidRequestBody(`Invalid request: ${message}`)),
    )
    if ('handled' in decoded) return decoded.handled
    const parsed = parseJsonGuarded(decoded.text)
    if (parsed === undefined) {
      return { response: plainJson(400, claudeInvalidRequestBody(MAX_DEPTH_MESSAGE)) }
    }
    if (parsed.malformed) {
      return { response: plainJson(400, claudeInvalidRequestBody('Invalid request: malformed JSON body')) }
    }
    const body = isPlainObject(parsed.value) ? parsed.value : {}
    const model = typeof body['model'] === 'string' ? body['model'] : ''
    const resolved = registry.resolve(model)
    if (resolved === undefined) {
      return { response: plainJson(400, claudeModelNotFoundBody(model)) }
    }
    return { response: directionNotMerged() }
  }

  /** Responses surface (S1 §3.2/§3.5). */
  const dispatchResponses = (context: RequestContext): Handled => {
    const decoded = decodeOrFail(context, (message) => plainJson(400, invalidRequestBody(message)))
    if ('handled' in decoded) return decoded.handled
    const parsed = parseJsonGuarded(decoded.text)
    if (parsed === undefined) return { response: plainJson(400, depthFailureBody()) }
    const body = !parsed.malformed && isPlainObject(parsed.value) ? parsed.value : {}
    if (parsed.malformed) {
      return { response: plainJson(400, invalidRequestBody('malformed JSON body')) }
    }
    const model = typeof body['model'] === 'string' ? body['model'] : ''
    if (registry.isImageModel(model)) {
      return { response: plainJson(503, imageOnlyModelBody(model)) }
    }
    const resolved = registry.resolve(model)
    if (resolved === undefined) {
      return { response: plainJson(400, modelNotFoundBody(model)) }
    }
    return { response: directionNotMerged() }
  }

  /** POST /v1/responses/compact (S1-18). */
  const dispatchResponsesCompact = (context: RequestContext): Handled => {
    const decoded = decodeOrFail(context, (message) => plainJson(400, invalidRequestBody(message)))
    if ('handled' in decoded) return decoded.handled
    const parsed = parseJsonGuarded(decoded.text)
    if (parsed === undefined) return { response: plainJson(400, depthFailureBody()) }
    if (parsed.malformed) {
      return { response: plainJson(400, invalidRequestBody('malformed JSON body')) }
    }
    const body = isPlainObject(parsed.value) ? parsed.value : {}
    if (body['stream'] === true) {
      return { response: charsetJson(400, compactStreamRejectionBody()) }
    }
    const model = typeof body['model'] === 'string' ? body['model'] : ''
    const resolved = registry.resolve(model)
    if (resolved === undefined) {
      return { response: plainJson(400, modelNotFoundBody(model)) }
    }
    return { response: directionNotMerged() }
  }

  /** Images surface gates (S1 §3.2 + S1-25). */
  const dispatchImages = (context: RequestContext): Handled => {
    if (config.imageGenerationMode === true) {
      // Bool `true`: the all-disabled state - both images routes are
      // absent (404 empty) before the body is read.
      return { response: emptyNotFound() }
    }
    const decoded = decodeOrFail(context, (message) => charsetJson(400, invalidRequestBody(message)))
    if ('handled' in decoded) return decoded.handled
    const parsed = parseJsonGuarded(decoded.text)
    if (parsed === undefined) {
      return { response: charsetJson(400, invalidRequestBody(MAX_DEPTH_MESSAGE.slice('Invalid request: '.length))) }
    }
    if (parsed.malformed) {
      return { response: charsetJson(400, invalidRequestBody('body must be valid JSON')) }
    }
    const body = isPlainObject(parsed.value) ? parsed.value : {}
    const prompt = body['prompt']
    if (typeof prompt !== 'string' || prompt.length === 0) {
      return { response: charsetJson(400, invalidRequestBody('prompt is required')) }
    }
    const model = typeof body['model'] === 'string' ? body['model'] : ''
    if (!registry.isImageModel(model)) {
      return { response: charsetJson(400, imagesUnsupportedModelBody(model)) }
    }
    return { response: directionNotMerged() }
  }

  /** v1beta action dispatch (S1 §3.4). */
  const dispatchV1BetaAction = async (context: RequestContext): Promise<Handled> => {
    const pathname = context.url.pathname
    const actionPrefix = '/v1beta/models/'
    const action = pathname.length > actionPrefix.length ? pathname.slice(actionPrefix.length) : ''
    const parsed = gem2oai.parseModelMethod(action)
    if (parsed === undefined) {
      return { response: charsetJson(404, gem2oai.actionNotFoundBody(pathname)) }
    }
    const method = parsed.method
    if (method !== 'generateContent' && method !== 'streamGenerateContent' && method !== 'countTokens') {
      // Silent fall-through (recorded S1-13): the action parses, no
      // switch case matches - nothing written, no headers, no trace.
      return { response: { status: 200, headers: [], body: '' } }
    }
    const decoded = decodeOrFail(context, (message) => plainJson(400, invalidRequestBody(message)))
    if ('handled' in decoded) return decoded.handled
    const resolved = registry.resolve(parsed.model)
    if (resolved === undefined) {
      // The gemini surface renders the OpenAI-shaped 400 (S1 §8).
      return { response: plainJson(400, gem2oai.modelNotFoundBody(parsed.model)) }
    }
    const facadeRequest = {
      method: context.request.method,
      path: `${pathname}${context.url.search}`,
      headers: context.facadeHeaders,
      body: decoded.text,
    }
    const dispatch = async (
      run: () => Promise<GatewayResponse>,
    ): Promise<GatewayResponse> => {
      try {
        return await run()
      } catch (error) {
        if (error instanceof RangeError) return plainJson(400, depthFailureBody())
        throw error
      }
    }
    if (resolved.family === 'openai-compatibility') {
      const response = await dispatch(() => gem2OaiService.handleV1Beta(facadeRequest, send))
      return { response, trace: resolved.familyIndex }
    }
    if (resolved.family === 'claude-api-key') {
      const response = await dispatch(() => gem2ClaService.handleV1beta(facadeRequest, send))
      return { response, trace: resolved.familyIndex }
    }
    return { response: directionNotMerged() }
  }

  /** v1beta model discovery (registry-generic, S1 §6.2). */
  const dispatchV1BetaDiscovery = async (context: RequestContext): Promise<Handled> => {
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
      return { response }
    } catch (error) {
      if (error instanceof RangeError) return { response: plainJson(400, depthFailureBody()) }
      throw error
    }
  }

  /** POST /v1beta/interactions validation gates (S1-25). */
  const dispatchInteractions = (context: RequestContext): Handled => {
    const decoded = decodeOrFail(context, (message) => charsetJson(400, invalidRequestBody(message)))
    if ('handled' in decoded) return decoded.handled
    const parsed = parseJsonGuarded(decoded.text)
    if (parsed === undefined) {
      return { response: charsetJson(400, invalidRequestBody(MAX_DEPTH_MESSAGE.slice('Invalid request: '.length))) }
    }
    if (parsed.malformed) {
      return { response: charsetJson(400, INTERACTIONS_INVALID_JSON_BODY) }
    }
    const body = isPlainObject(parsed.value) ? parsed.value : {}
    const hasModel = typeof body['model'] === 'string' && (body['model'] as string).length > 0
    const hasAgent = typeof body['agent'] === 'string' && (body['agent'] as string).length > 0
    if (hasModel === hasAgent) {
      return { response: charsetJson(400, INTERACTIONS_EXACTLY_ONE_BODY) }
    }
    if (body['stream'] !== undefined && typeof body['stream'] !== 'boolean') {
      return { response: charsetJson(400, INTERACTIONS_STREAM_BOOLEAN_BODY) }
    }
    return { response: directionNotMerged() }
  }

  /** Codex-only routes without codex credentials (S1-23). */
  const codexUnavailable = (): GatewayResponse => charsetJson(503, CODEX_AUTH_UNAVAILABLE_BODY)

  const isWebSocketUpgrade = (context: RequestContext): boolean => {
    const connection = (headerValue(context.request.headers, 'connection') ?? '').toLowerCase()
    const upgrade = (headerValue(context.request.headers, 'upgrade') ?? '').toLowerCase()
    return (
      connection
        .split(',')
        .map((part) => part.trim())
        .includes('upgrade') && upgrade === 'websocket'
    )
  }

  /** Nested 400 body of a bad client-secrets request (recorded S1-25). */
  const realtimeInvalidSecretBody = (): string =>
    realtimeEnvelope('invalid_request', 'Invalid Realtime client secret request', 'invalid_request_error')

  /**
   * Mints one realtime client secret. The success body shape is not
   * golden-pinned (S1-25 records only the bad-JSON 400); this emits the
   * OpenAI-style `client_secret` envelope until a recording pins it.
   */
  const mintRealtimeSecret = async (
    body: Record<string, unknown>,
  ): Promise<Handled> => {
    const requested = typeof body['lifetime_ms'] === 'number' ? (body['lifetime_ms'] as number) : undefined
    const secret = await plane.realtimeSecrets.issue(requested)
    const payload = JSON.stringify({
      client_secret: {
        value: secret.token,
        expires_at: formatRfc3339(secret.expiresAtMs),
      },
    })
    return { response: charsetJson(200, payload) }
  }

  /** Handler table; each returns the pre-CORS/trace response. */
  const handleById = async (context: RequestContext): Promise<Handled> => {
    const id = context.match.entry.id
    const nowMs = now()
    switch (id) {
      case 'root': {
        const safePage = plane.serveSafeModePage(toWebRequest(context))
        if (safePage !== null) return { response: await fromWebResponse(safePage) }
        return { response: charsetJson(200, ROOT_BODY) }
      }
      case 'healthz': {
        if (context.request.method === 'HEAD') {
          return { response: { status: 200, headers: [], body: '' } }
        }
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
        const bearer =
          authorization !== undefined && authorization.startsWith('Bearer ')
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
        const provider =
          id === 'callback-anthropic' ? 'anthropic' : id === 'callback-codex' ? 'codex' : 'antigravity'
        return {
          response: await fromWebResponse(
            await plane.handlePlainCallback(toWebRequest(context), provider),
          ),
        }
      }
      case 'callback-devin': {
        return { response: await fromWebResponse(await plane.handleDevinCallback(toWebRequest(context))) }
      }
      case 'mgmt-oauth-callback': {
        if (!plane.managementAvailable()) return { response: emptyNotFound() }
        return {
          response: await fromWebResponse(await plane.handleManagementOauthCallback(toWebRequest(context))),
        }
      }
      case 'mgmt-auth-url': {
        const provider = context.url.pathname
          .slice('/v0/management/'.length)
          .replace(/-auth-url$/, '')
        if (
          provider !== 'anthropic' &&
          provider !== 'codex' &&
          provider !== 'antigravity' &&
          provider !== 'kimi' &&
          provider !== 'xai' &&
          provider !== 'devin' &&
          provider !== 'meta'
        ) {
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
          return { response: { status: wire.status, headers: wire.rawHeaders, body: await wire.text() } }
        }
        // Payload routes wait for the I-mgmt merge (dispatch seam): the
        // auth-plane subset answers; everything else is the recorded
        // unknown-subroute 404.
        return { response: emptyNotFound() }
      }
      case 'models-list': {
        const anthropicVersion = headerValue(context.request.headers, 'anthropic-version')
        const userAgent = headerValue(context.request.headers, 'user-agent') ?? ''
        // Optional catalog switches (?client_version=, grok-shell UA,
        // Home mode) are OQ-2/OQ-4 and intentionally unimplemented.
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
        // /v1/completions rides the chat machinery; the legacy
        // text-completions adaptation is a recorded seam upstream of
        // the direction dispatch (S1 §3.2 note).
        return dispatchChat(context)
      }
      case 'messages':
      case 'messages-count-tokens': {
        return dispatchMessages(context)
      }
      case 'responses': {
        return dispatchResponses(context)
      }
      case 'responses-compact': {
        return dispatchResponsesCompact(context)
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
        return dispatchImages(context)
      }
      case 'videos-create':
      case 'videos-retrieve':
      case 'openai-videos-create':
      case 'openai-videos-retrieve':
      case 'openai-videos-content': {
        // Video executors are unmerged: routes registered, dispatch is
        // the direction seam.
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
          return {
            response: charsetJson(426, plainErrorBody('WebSocket upgrade required'), [['Upgrade', 'websocket']]),
          }
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
            response: charsetJson(
              426,
              realtimeEnvelope(code, 'WebSocket upgrade required', 'invalid_request_error'),
              [['Upgrade', 'websocket']],
            ),
          }
        }
        return { response: directionNotMerged() }
      }
      case 'realtime-call': {
        if (!codexConfigured) {
          // /v1/realtime* paths switch to the nested envelope with
          // type api_error for >=500 (recorded prefix rule).
          return {
            response: charsetJson(
              503,
              realtimeEnvelope('realtime_request_failed', 'auth_not_found: no auth available', 'api_error'),
            ),
          }
        }
        return { response: directionNotMerged() }
      }
      case 'realtime-calls-sideband': {
        const callId = context.match.params['call_id'] ?? ''
        if (!isWebSocketUpgrade(context)) {
          return {
            response: charsetJson(
              426,
              realtimeEnvelope('realtime_request_failed', 'WebSocket upgrade required', 'invalid_request_error'),
              [['Upgrade', 'websocket']],
            ),
          }
        }
        if (!CALL_ID_PATTERN.test(callId)) {
          return {
            response: charsetJson(
              400,
              realtimeEnvelope('realtime_request_failed', 'Invalid Codex live call ID', 'invalid_request_error'),
            ),
          }
        }
        return {
          response: charsetJson(
            404,
            realtimeEnvelope('realtime_request_failed', 'Codex live session not found', 'invalid_request_error'),
          ),
        }
      }
      case 'realtime-hangup': {
        const callId = context.match.params['call_id'] ?? ''
        if (!CALL_ID_PATTERN.test(callId)) {
          return {
            response: charsetJson(
              400,
              realtimeEnvelope('invalid_call_id', 'Invalid Realtime call ID', 'invalid_request_error'),
            ),
          }
        }
        // No live-session registry merged: the recorded not-found body.
        return {
          response: charsetJson(
            404,
            realtimeEnvelope('realtime_call_not_found', 'Realtime call not found', 'invalid_request_error'),
          ),
        }
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
        const decoded = decodeOrFail(context, (message) =>
          charsetJson(400, realtimeEnvelope('invalid_request', message, 'invalid_request_error')),
        )
        if ('handled' in decoded) return decoded.handled
        const parsed = parseJsonGuarded(decoded.text)
        if (parsed === undefined) return { response: charsetJson(400, realtimeInvalidSecretBody()) }
        if (parsed.malformed || !isPlainObject(parsed.value)) {
          return { response: charsetJson(400, realtimeInvalidSecretBody()) }
        }
        return mintRealtimeSecret(parsed.value)
      }
      case 'realtime-sessions': {
        // Legacy minting path: no JSON validation of the raw body.
        return mintRealtimeSecret({})
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
      case 'realtime-translations-stub':
      case 'realtime-translations-client-secrets': {
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
          return dispatchV1BetaDiscovery(context)
        }
        return dispatchV1BetaAction(context)
      }
      case 'v1beta-interactions': {
        return dispatchInteractions(context)
      }
      default: {
        throw new Error(`no handler for route id ${id}`)
      }
    }
  }

  /** The main pipeline (S1 §2 order: OPTIONS -> redirect -> route -> auth). */
  const handle = async (request: GatewayRequest): Promise<GatewayResponse> => {
    const url = new URL(request.url)
    const pathname = url.pathname
    const method = request.method.toUpperCase()

    // OPTIONS anywhere: 204 + CORS, never authenticated or routed.
    if (method === 'OPTIONS') {
      return { status: 204, headers: withCors([]), body: '' }
    }

    // Route first; the router-emitted trailing-slash redirect fires only
    // when NO route matches the request path, and it is emitted before
    // the middleware chain: NO CORS block, no auth (recorded S1-08/S1-25).
    const match = matchRoute(method, pathname)
    if (match === undefined) {
      const redirect = evaluateRedirect(method, pathname, url.search.length > 0 ? url.search.slice(1) : '')
      if (redirect.redirect) {
        return redirectResponse(redirect.status, redirect.location, method)
      }
      // Framework 404: empty body, CORS present (ruling R-404).
      return { status: 404, headers: withCors([]), body: '' }
    }

    let bodyDecoded: BodyDecode | undefined
    const context: RequestContext = {
      request,
      url,
      match,
      config,
      facadeHeaders: request.headers,
      decodeBody: () => {
        if (bodyDecoded === undefined) {
          bodyDecoded = decodeBodyBytes(
            request.body,
            headerValue(request.headers, 'content-encoding'),
            options.zstdDecode,
          )
        }
        return bodyDecoded
      },
    }

    // Group gates (S1 §4).
    const group = match.entry.group
    if (group === 'client') {
      const rejected = await plane.authenticateProxy(toWebRequest(context))
      if (rejected !== null) return planeRejected(rejected)
      context.facadeHeaders = normalizeFacadeHeaders(request.headers, acceptedApiKey(config, context))
    } else if (group === 'realtime' || group === 'realtime-standard') {
      const sealed = plane.safeModeProxyResponse(toWebRequest(context))
      if (sealed !== null) return planeRejected(sealed)
      const gate =
        group === 'realtime'
          ? await plane.authenticateRealtime(toWebRequest(context))
          : await plane.authenticateRealtimeStandard(toWebRequest(context))
      if (gate !== null) return planeRejected(gate)
    } else if (group === 'management') {
      if (!plane.managementAvailable()) {
        // Availability middleware: the whole surface is absent (S1 §3.9).
        return { status: 404, headers: withCors([]), body: '' }
      }
      if (options.managementApi === undefined) {
        const verdict = await plane.authenticateManagement(toWebRequest(context))
        if (!verdict.ok) return planeRejected(verdict.response)
      }
    }

    return finalizeResponse(await handleById(context))
  }

  return { handle, capabilities, store, plane, config }
}
