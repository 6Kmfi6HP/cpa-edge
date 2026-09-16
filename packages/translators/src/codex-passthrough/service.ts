
/**
 * Composed facade for the S2d9 direction: the full Responses client ->
 * Codex Responses upstream -> Responses client pipeline over an injected
 * transport.
 *
 * `createCodexPassthroughService` wires the passthrough rewrites, the
 * always-SSE upstream wire with cloaked headers and session identity, the
 * stream bootstrap gate (no SSE header before the first frame), non-stream
 * aggregation, compact passthrough, the 5.1 error re-serialization, the
 * synthesized in-stream failures, and the two recorded cooldown families -
 * an upstream 429 arms a rate-limit window driven by the body's reset
 * fields (429 + `model_cooldown` + `Retry-After` on the next request), an
 * upstream 404 model_not_found arms a not-found window (503 enriched
 * `auth_unavailable` on the next request); `transient-error-cooldown-
 * seconds: -1` disables neither. Cooldown state flows exclusively through
 * the injected Store; the client-facing response always renders before
 * any bookkeeping. No transport happens here: the caller supplies `send`,
 * so the same facade runs on every runtime.
 */
import type { JsonValue, Store } from '@cpa-edge/core'
import {
  buildAuthUnavailableResponse,
  buildModelCooldownResponse,
  classifyUpstreamStatusError,
  invalidApiKeyBody,
  invalidRequestBody,
  compactStreamRejectedBody,
  incompleteStreamBody,
  isCodexClient,
  missingApiKeyBody,
  modelNotFoundBody,
  serverErrorEnvelope,
  STREAM_DISCONNECTED_MESSAGE,
} from './errors'
import {
  buildPassthroughUpstreamHeaders,
  canonicalHeaderName,
  headerListToRecord,
  orderPassthroughUpstreamHeaders,
  readHeaderValue,
} from './headers'
import type { HeaderList } from './headers'
import { ensureUsageDetails } from './response'
import { isPlainObject, parseStrictJson, rawValueAt, tryParseJson } from './json'
import { translateCompactPassthrough, translateResponsesPassthrough } from './request'
import type { ImageGenerationMode, PassthroughRequestContext } from './request'
import { aggregatePassthroughStream, bootstrapPassthroughStream } from './stream'

/** Default upstream base URL of a `codex-api-key` entry without `base-url`. */
export const CODEX_DEFAULT_BASE_URL = 'https://chatgpt.com/backend-api/codex'

/** Upstream paths appended to the configured base URL. */
export const RESPONSES_PATH = '/responses'
export const RESPONSES_COMPACT_PATH = '/responses/compact'

/** One `models[]` entry of a codex-api-key credential. */
export interface CodexPassthroughModelEntry {
  /** Upstream model name (alias target) stamped onto the wire. */
  readonly name: string
  /** Client-facing alias; defaults to `name`. */
  readonly alias?: string
  /** Rewrite every model field of streamed payloads back to the alias. */
  readonly forceMapping?: boolean
  /** Thinking capability; absent strips the top-level `reasoning` object. */
  readonly thinking?: boolean
}

/** One `codex-api-key` credential entry. */
export interface CodexPassthroughCredential {
  readonly apiKey: string
  /** Upstream base URL; absent falls back to the chatgpt.com backend. */
  readonly baseUrl?: string
  /** Credential-level static header map (applied after the whitelist). */
  readonly headers?: Readonly<Record<string, string>>
  /** `codex.disable-cloaking: true` keeps the caller UA/Originator. */
  readonly disableCodexCloaking?: boolean
  readonly models: readonly CodexPassthroughModelEntry[]
}

export interface CodexPassthroughServiceOptions {
  /**
   * Gateway keys accepted downstream (`Authorization: Bearer` /
   * `X-Api-Key`). OPTIONAL: client authn is route middleware territory
   * (S1); when absent the facade enforces no key of its own.
   */
  readonly apiKeys?: readonly string[]
  /** codex-api-key entries, config order. */
  readonly credentials: readonly CodexPassthroughCredential[]
  /** All persistent state (cooldown windows) flows through the Store. */
  readonly store: Store
  /** Epoch-milliseconds clock; drives every timing decision. */
  readonly now?: () => number
  /** Upstream attempts per request beyond the first (0 in every fixture). */
  readonly requestRetry?: number
  /**
   * Transient-error cooldown window in seconds; -1 disables it. The S2d9
   * slice pins the 429 and 404 cooldown families, which this switch does
   * NOT disable (recorded hard pin), so the option is recorded but not
   * consulted here.
   */
  readonly transientErrorCooldownSeconds?: number
  /** Gateway version for the User-Agent fallback when cloaking is off. */
  readonly gatewayVersion?: string
  /** `disable-image-generation` mode; `off` is the default. */
  readonly disableImageGeneration?: ImageGenerationMode
  /** `codex.disable-cloaking: true` keeps the caller UA/Originator (service level). */
  readonly disableCodexCloaking?: boolean
}

/** Downstream (client-facing) request as received by the route. */
export interface CodexPassthroughRequest {
  readonly method: string
  /** `/v1/responses`, `/backend-api/codex/responses`, or a `/compact` form. */
  readonly path: string
  readonly headers: HeaderList
  readonly body: string
}

/** Upstream request the executor would transmit. */
export interface CodexPassthroughUpstreamRequest {
  readonly method: string
  /** Absolute URL: `<base-url without trailing slash>/responses[...]`. */
  readonly url: string
  readonly headers: HeaderList
  readonly body: string
}

/** Upstream response as produced by the injected transport. */
export interface CodexPassthroughUpstreamResponse {
  readonly status: number
  readonly headers: HeaderList
  /**
   * 2xx bodies on /responses are SSE bytes; everything else is raw bytes.
   * A read that rejects mid-body models an upstream disconnect.
   */
  readonly body: ReadableStream<Uint8Array>
}

/** Transport callback owned by the runtime/executor layer. */
export type CodexPassthroughUpstreamSender = (
  request: CodexPassthroughUpstreamRequest,
) => Promise<CodexPassthroughUpstreamResponse>

/** Downstream response: plain bytes for JSON, a pull-driven stream for SSE. */
export interface CodexPassthroughResponse {
  readonly status: number
  readonly headers: HeaderList
  readonly body: string | ReadableStream<Uint8Array>
}

export interface CodexPassthroughService {
  handleResponses(
    request: CodexPassthroughRequest,
    send: CodexPassthroughUpstreamSender,
  ): Promise<CodexPassthroughResponse>
}

const COOLDOWN_NAMESPACE = 'codex-passthrough'
const COOLDOWN_KEY_PREFIX = 'credential-cooldown:'
const PROVIDER = 'codex'

/** Rate-limit cooldown when the body carries no reset fields (~4s recorded). */
const RATE_LIMIT_DEFAULT_COOLDOWN_MS = 4_000

/** Not-found cooldown window (duration policy is S4 scope; observation only). */
const NOT_FOUND_COOLDOWN_MS = 12 * 60 * 60 * 1_000

/** CORS block the OPTIONS preflight answers with (route-owned family). */
const CORS_BLOCK: HeaderList = [
  ['Access-Control-Allow-Headers', '*'],
  ['Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS'],
  ['Access-Control-Allow-Origin', '*'],
  [
    'Access-Control-Expose-Headers',
    'X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id',
  ],
]

/**
 * Direction-owned SSE headers, committed together with the first frame.
 * Emission order is the recorded one (T4 F2): Cache-Control, then
 * Connection, then Content-Type.
 */
const SSE_HEADERS: HeaderList = [
  ['Cache-Control', 'no-cache'],
  ['Connection', 'keep-alive'],
  ['Content-Type', 'text/event-stream'],
  ['Access-Control-Allow-Origin', '*'],
]

/** Headers never copied from an upstream response (4.5). */
const HOP_BY_HOP: ReadonlySet<string> = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'set-cookie',
  'content-length',
  'content-encoding',
])

/** Gateway-proxy header prefixes never copied downstream (4.5). */
const PROXY_PREFIXES: readonly string[] = ['x-litellm-', 'helicone-', 'x-portkey-', 'cf-aig-', 'x-kong-', 'x-bt-']

/** Gateway-reserved CORS names the route layer owns (4.5). */
const RESERVED_CORS: ReadonlySet<string> = new Set([
  'access-control-allow-origin',
  'access-control-allow-methods',
  'access-control-allow-headers',
  'access-control-expose-headers',
  'access-control-allow-credentials',
  'access-control-max-age',
])

type RouteKind = 'responses' | 'compact'

const ROUTES: Readonly<Record<string, RouteKind>> = Object.freeze({
  '/v1/responses': 'responses',
  '/backend-api/codex/responses': 'responses',
  '/v1/responses/compact': 'compact',
  '/backend-api/codex/responses/compact': 'compact',
})

/** Which cooldown family a credential sits in. */
type CooldownFamily = 'rate-limit' | 'not-found'

/** Stored cooldown record (persisted as a JSON document). */
interface CooldownRecord {
  readonly untilMs: number
  readonly family: CooldownFamily
  readonly lastUpstreamError: string
}

interface Candidate {
  readonly credentialIndex: number
  readonly credential: CodexPassthroughCredential
  readonly entry: CodexPassthroughModelEntry
  readonly upstreamModel: string
}

interface AttemptOutcome {
  readonly retryable: boolean
  readonly response: CodexPassthroughResponse
}

/** Builds the facade. The service holds no state; cooldowns live in the Store. */
export function createCodexPassthroughService(options: CodexPassthroughServiceOptions): CodexPassthroughService {
  const credentials = options.credentials
  const now = options.now ?? (() => Date.now())
  const maxAttempts = Math.max(0, Math.floor(options.requestRetry ?? 0)) + 1

  return {
    async handleResponses(request, send): Promise<CodexPassthroughResponse> {
      const route = parseRoute(request.path)
      if (route === undefined) return { status: 404, headers: [], body: '' }
      if (request.method === 'OPTIONS') return { status: 204, headers: [...CORS_BLOCK], body: '' }
      if (request.method !== 'POST') return { status: 404, headers: [], body: '' }

      const gate = checkGatewayKey(request, options.apiKeys ?? [])
      if (gate !== undefined) return gate

      // Strict request boundary (NE-LENIENT): malformed JSON rejects with
      // 400 BEFORE model resolution.
      let parsed: unknown
      try {
        parsed = parseStrictJson(request.body)
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'malformed JSON body'
        return jsonBody(400, invalidRequestBody(reason), 'application/json; charset=utf-8')
      }
      const record = isPlainObject(parsed) ? parsed : {}
      const requestedModel = modelOf(record, request.body)

      const candidates: Candidate[] = []
      for (let index = 0; index < credentials.length; index++) {
        const credential = credentials[index]
        if (credential === undefined) continue
        for (const entry of credential.models) {
          const resolution = resolveModel(entry, requestedModel)
          if (resolution === undefined) continue
          candidates.push({
            credentialIndex: index,
            credential,
            entry,
            upstreamModel: resolution.upstreamModel,
          })
          break
        }
      }
      if (candidates.length === 0) {
        return jsonBody(400, modelNotFoundBody(requestedModel), 'application/json')
      }

      if (route === 'compact' && record['stream'] === true) {
        return jsonBody(400, compactStreamRejectedBody(), 'application/json; charset=utf-8')
      }

      let lastCooldown: CooldownRecord | undefined
      let attempts = 0
      for (const candidate of candidates) {
        const cooldown = await readCooldown(options.store, candidate.credentialIndex, candidate.upstreamModel)
        if (cooldown !== undefined && now() < cooldown.untilMs) {
          lastCooldown = cooldown
          continue
        }
        attempts += 1
        const outcome =
          route === 'compact'
            ? await compactAttempt(candidate, request, record, requestedModel, send)
            : await responsesAttempt(candidate, request, record, requestedModel, send)
        if (!outcome.retryable || attempts >= maxAttempts) return outcome.response
        // request-retry: fall through to the next credential for retryable
        // upstream failures (429 / transport failures).
      }
      if (lastCooldown !== undefined) {
        const requested = requestedModel
        if (lastCooldown.family === 'not-found') {
          const rendered = buildAuthUnavailableResponse({
            providers: [PROVIDER],
            model: requested,
            lastUpstreamError: lastCooldown.lastUpstreamError,
          })
          return jsonBody(rendered.status, rendered.body, 'application/json')
        }
        const remainingSeconds = Math.max(1, Math.ceil((lastCooldown.untilMs - now()) / 1000))
        const rendered = buildModelCooldownResponse({
          model: requested,
          provider: PROVIDER,
          lastUpstreamError: lastCooldown.lastUpstreamError,
          resetSeconds: remainingSeconds,
        })
        return jsonBody(429, rendered.body, 'application/json', [['Retry-After', rendered.retryAfter]])
      }
      return jsonBody(500, serverErrorEnvelope('no credential available for the requested model'), 'application/json')
    },
  }

  // -----------------------------------------------------------------------

  /** One /responses attempt: translate, dispatch, stream or aggregate. */
  async function responsesAttempt(
    candidate: Candidate,
    request: CodexPassthroughRequest,
    record: Record<string, unknown>,
    requestedModel: string,
    send: CodexPassthroughUpstreamSender,
  ): Promise<AttemptOutcome> {
    const clientHeaders = headerListToRecord(request.headers)
    const ctx: PassthroughRequestContext = {
      upstreamModel: candidate.upstreamModel,
      lite: isLiteRequest(record, clientHeaders),
      imageMode: options.disableImageGeneration ?? 'off',
      thinking: candidate.entry.thinking === true || thinkingSuffixOf(requestedModel) !== undefined,
      session: {
        apiKey: clientApiKey(clientHeaders),
        clientSessionId: clientSessionSignal(clientHeaders),
      },
    }
    const translated = await translateResponsesPassthrough(request.body, record, ctx)

    const baseUrl =
      candidate.credential.baseUrl !== undefined && candidate.credential.baseUrl.length > 0
        ? candidate.credential.baseUrl
        : CODEX_DEFAULT_BASE_URL
    const url = joinUrl(baseUrl, RESPONSES_PATH)
    const headers = orderPassthroughUpstreamHeaders(
      buildPassthroughUpstreamHeaders({
        clientHeaders,
        apiKey: candidate.credential.apiKey,
        sessionId: translated.sessionHeaderValue,
        accept: 'text/event-stream',
        disableCodexCloaking: candidate.credential.disableCodexCloaking ?? options.disableCodexCloaking,
        gatewayVersion: options.gatewayVersion,
        credentialHeaders: candidate.credential.headers,
      }),
      url,
      translated.body,
    )

    let upstream: CodexPassthroughUpstreamResponse
    try {
      upstream = await send({ method: 'POST', url, headers, body: translated.body })
    } catch {
      // Pre-HTTP transport failure: the incomplete-stream shape.
      return { retryable: true, response: jsonBody(408, incompleteStreamBody(), 'application/json') }
    }

    if (upstream.status >= 200 && upstream.status < 300) {
      if (record['stream'] === true) {
        return streamOutcome(upstream, candidate, requestedModel, request, ctx.lite)
      }
      return aggregateOutcome(upstream, ctx.lite)
    }

    return await upstreamFailure(candidate, upstream)
  }

  /** One /responses/compact attempt: near-verbatim call, JSON reply. */
  async function compactAttempt(
    candidate: Candidate,
    request: CodexPassthroughRequest,
    record: Record<string, unknown>,
    requestedModel: string,
    send: CodexPassthroughUpstreamSender,
  ): Promise<AttemptOutcome> {
    const clientHeaders = headerListToRecord(request.headers)
    const ctx: PassthroughRequestContext = {
      upstreamModel: candidate.upstreamModel,
      lite: isLiteRequest(record, clientHeaders),
      imageMode: options.disableImageGeneration ?? 'off',
      thinking: candidate.entry.thinking === true || thinkingSuffixOf(requestedModel) !== undefined,
      session: {
        apiKey: clientApiKey(clientHeaders),
        clientSessionId: clientSessionSignal(clientHeaders),
      },
    }
    const translated = await translateCompactPassthrough(request.body, record, ctx)

    const baseUrl =
      candidate.credential.baseUrl !== undefined && candidate.credential.baseUrl.length > 0
        ? candidate.credential.baseUrl
        : CODEX_DEFAULT_BASE_URL
    const url = joinUrl(baseUrl, RESPONSES_COMPACT_PATH)
    const headers = orderPassthroughUpstreamHeaders(
      buildPassthroughUpstreamHeaders({
        clientHeaders,
        apiKey: candidate.credential.apiKey,
        sessionId: translated.sessionHeaderValue,
        accept: 'application/json',
        disableCodexCloaking: candidate.credential.disableCodexCloaking ?? options.disableCodexCloaking,
        gatewayVersion: options.gatewayVersion,
        credentialHeaders: candidate.credential.headers,
      }),
      url,
      translated.body,
    )

    let upstream: CodexPassthroughUpstreamResponse
    try {
      upstream = await send({ method: 'POST', url, headers, body: translated.body })
    } catch {
      return { retryable: true, response: jsonBody(408, incompleteStreamBody(), 'application/json') }
    }

    if (upstream.status >= 200 && upstream.status < 300) {
      let buffer: string
      try {
        buffer = await readAll(upstream.body)
      } catch {
        return { retryable: true, response: jsonBody(408, incompleteStreamBody(), 'application/json') }
      }
      // Upstream body verbatim; usage-detail defaulting skips compaction.
      const parsedBody = tryParseJson(buffer)
      const body = isPlainObject(parsedBody) ? ensureUsageDetails(buffer, parsedBody) : buffer
      return { retryable: false, response: jsonBody(200, body, 'application/json') }
    }
    return await upstreamFailure(candidate, upstream)
  }

  /** Stream clients: commit SSE headers only after the first frame is held. */
  async function streamOutcome(
    upstream: CodexPassthroughUpstreamResponse,
    candidate: Candidate,
    requestedModel: string,
    request: CodexPassthroughRequest,
    lite: boolean,
  ): Promise<AttemptOutcome> {
    const failureEvent = isCodexClient(headerListToRecord(request.headers)) ? 'response.failed' : 'error'
    let bootstrap: Awaited<ReturnType<typeof bootstrapPassthroughStream>>
    try {
      bootstrap = await bootstrapPassthroughStream(readableToAsyncIterable(upstream.body), {
        clientModel: requestedModel,
        forceMappingAlias: candidate.entry.forceMapping === true ? (candidate.entry.alias ?? candidate.entry.name) : undefined,
        lite,
        failureEvent,
      })
    } catch {
      return { retryable: true, response: jsonBody(408, incompleteStreamBody(), 'application/json') }
    }
    if (bootstrap.kind === 'pre-commit') {
      const retryable = bootstrap.status === 408
      return { retryable, response: jsonBody(bootstrap.status, bootstrap.body, 'application/json') }
    }
    return {
      retryable: false,
      response: {
        status: 200,
        headers: [...SSE_HEADERS, ...filterUpstreamHeaders(upstream.headers, SSE_HEADERS)],
        body: framesToReadable(bootstrap.firstFrame, bootstrap.rest),
      },
    }
  }

  /** Non-stream clients: aggregate the upstream SSE into one JSON body. */
  async function aggregateOutcome(
    upstream: CodexPassthroughUpstreamResponse,
    lite: boolean,
  ): Promise<AttemptOutcome> {
    let buffer: string
    try {
      buffer = await readAll(upstream.body)
    } catch {
      return { retryable: true, response: jsonBody(408, incompleteStreamBody(), 'application/json') }
    }
    const result = aggregatePassthroughStream(buffer, lite)
    if (result.kind === 'ok') {
      return { retryable: false, response: jsonBody(200, result.body, 'application/json') }
    }
    return {
      retryable: result.kind === 'incomplete',
      response: jsonBody(result.status, result.body, 'application/json'),
    }
  }

  /**
   * Non-2xx upstream: render the classified response FIRST, then arm the
   * cooldown family the status belongs to (a Store failure must never
   * reject the rendered response).
   */
  async function upstreamFailure(
    candidate: Candidate,
    upstream: CodexPassthroughUpstreamResponse,
  ): Promise<AttemptOutcome> {
    let bodyText: string
    try {
      bodyText = await readAll(upstream.body)
    } catch {
      return { retryable: true, response: jsonBody(408, incompleteStreamBody(), 'application/json') }
    }
    const failure = classifyUpstreamStatusError(upstream.status, bodyText)
    const retryable = failure.status === 429
    const response = jsonBody(failure.status, failure.body, 'application/json')

    if (failure.status === 429) {
      const record = rateLimitCooldown(bodyText, now())
      await persistCooldownBestEffort(options.store, candidate, record)
      return { retryable, response }
    }
    if (upstream.status === 404 && isModelNotFoundBody(bodyText)) {
      const record: CooldownRecord = {
        untilMs: now() + NOT_FOUND_COOLDOWN_MS,
        family: 'not-found',
        lastUpstreamError: upstreamErrorSummary(bodyText),
      }
      await persistCooldownBestEffort(options.store, candidate, record)
    }
    return { retryable, response }
  }

}

// ---------------------------------------------------------------------------
// Model resolution + Lite detection
// ---------------------------------------------------------------------------

/** Splits a `model(effort)` thinking suffix off a requested model, if any. */
function thinkingSuffixOf(model: string): { readonly base: string; readonly suffix: string } | undefined {
  const match = /^(.*)\(([^()]+)\)$/.exec(model)
  if (match === null) return undefined
  return { base: match[1] ?? '', suffix: match[2] ?? '' }
}

function resolveModel(
  entry: CodexPassthroughModelEntry,
  requestedModel: string,
): { readonly upstreamModel: string } | undefined {
  const clientFacing = entry.alias ?? entry.name
  if (clientFacing === requestedModel) return { upstreamModel: entry.name }
  const suffix = thinkingSuffixOf(requestedModel)
  if (suffix === undefined) return undefined
  if (clientFacing !== suffix.base) return undefined
  return { upstreamModel: `${entry.name}(${suffix.suffix})` }
}

/**
 * True for native Responses-Lite requests: the
 * `X-OpenAI-Internal-Codex-Responses-Lite` header (case-insensitive
 * `true` after trimming) or the body `client_metadata` flag (JSON `true`
 * or the case-insensitive string `"true"`).
 */
function isLiteRequest(record: Record<string, unknown>, clientHeaders: Readonly<Record<string, string>>): boolean {
  const header = readHeaderValue(clientHeaders, 'x-openai-internal-codex-responses-lite')
  if (header !== undefined && header.trim().toLowerCase() === 'true') return true
  const metadata = record['client_metadata']
  if (isPlainObject(metadata)) {
    const flag = metadata['ws_request_header_x_openai_internal_codex_responses_lite']
    if (flag === true) return true
    if (typeof flag === 'string' && flag.trim().toLowerCase() === 'true') return true
  }
  return false
}

/** Raw model string of the body: strings as-is, other values raw JSON text. */
function modelOf(record: Record<string, unknown>, body: string): string {
  const raw = record['model']
  if (typeof raw === 'string') return raw
  if (raw === undefined) return ''
  return rawValueAt(body, ['model']) ?? ''
}

// ---------------------------------------------------------------------------
// Gateway-key gate (S1 family shapes)
// ---------------------------------------------------------------------------

function checkGatewayKey(
  request: CodexPassthroughRequest,
  apiKeys: readonly string[],
): CodexPassthroughResponse | undefined {
  if (apiKeys.length === 0) return undefined
  const headers = headerListToRecord(request.headers)
  const authorization = readHeaderValue(headers, 'authorization')
  const xApiKey = readHeaderValue(headers, 'x-api-key')
  const candidates: string[] = []
  if (authorization !== undefined && authorization.length > 0) {
    const schemeSplit = /^([A-Za-z]+)\s+(.*)$/.exec(authorization)
    if (schemeSplit !== null && (schemeSplit[1] ?? '').toLowerCase() === 'bearer') {
      candidates.push(schemeSplit[2] ?? '')
    } else {
      // A non-Bearer presentation keeps the whole value as the candidate.
      candidates.push(authorization)
    }
  }
  if (xApiKey !== undefined && xApiKey.length > 0) candidates.push(xApiKey)
  if (candidates.length === 0) {
    return jsonBody(401, missingApiKeyBody(), 'application/json; charset=utf-8')
  }
  for (const candidate of candidates) {
    if (apiKeys.includes(candidate)) return undefined
  }
  return jsonBody(401, invalidApiKeyBody(), 'application/json; charset=utf-8')
}

function clientApiKey(headers: Readonly<Record<string, string>>): string {
  const authorization = readHeaderValue(headers, 'authorization')
  if (authorization === undefined) return ''
  return authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : authorization
}

function clientSessionSignal(headers: Readonly<Record<string, string>>): string | undefined {
  for (const wanted of ['session-id', 'x-session-id', 'x-claude-code-session-id']) {
    const value = readHeaderValue(headers, wanted)
    if (value !== undefined && value.length > 0) return value
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Cooldown persistence (Store-backed; no other mutable state exists)
// ---------------------------------------------------------------------------

function cooldownKey(credentialIndex: number, model: string): string {
  return `${COOLDOWN_KEY_PREFIX}${credentialIndex}:${model}`
}

async function readCooldown(
  store: Store,
  credentialIndex: number,
  model: string,
): Promise<CooldownRecord | undefined> {
  return cooldownFromDocument(await store.get(COOLDOWN_NAMESPACE, cooldownKey(credentialIndex, model)))
}

/**
 * Best-effort cooldown persistence: by the time this runs the
 * client-facing response is already rendered, so a failing Store must not
 * reject it. The Store error is still surfaced - reported to the
 * runtime's global error channel where that API exists - rather than
 * swallowed.
 */
async function persistCooldownBestEffort(
  store: Store,
  candidate: { readonly credentialIndex: number; readonly upstreamModel: string },
  record: CooldownRecord,
): Promise<void> {
  try {
    await store.update(COOLDOWN_NAMESPACE, cooldownKey(candidate.credentialIndex, candidate.upstreamModel), (current) => {
      const previous = cooldownFromDocument(current)
      // A still-longer window already stored is never shortened.
      if (previous !== undefined && previous.untilMs > record.untilMs) return cooldownDocument(previous)
      return cooldownDocument(record)
    })
  } catch (error) {
    if (typeof reportError === 'function') reportError(error)
    else console.error(error)
  }
}

/** Rate-limit window from the upstream error body's reset fields. */
function rateLimitCooldown(bodyText: string, nowMs: number): CooldownRecord {
  const error = errorObjectOf(bodyText)
  const resetsInSeconds = numberAt(error, 'resets_in_seconds')
  if (resetsInSeconds !== undefined) {
    return {
      untilMs: nowMs + resetsInSeconds * 1000,
      family: 'rate-limit',
      lastUpstreamError: upstreamErrorSummary(bodyText),
    }
  }
  const resetsAt = numberAt(error, 'resets_at')
  if (resetsAt !== undefined) {
    const resetsAtMs = resetsAt > 1e12 ? resetsAt : resetsAt * 1000
    const until = Math.max(nowMs + RATE_LIMIT_DEFAULT_COOLDOWN_MS, resetsAtMs)
    return {
      untilMs: until,
      family: 'rate-limit',
      lastUpstreamError: upstreamErrorSummary(bodyText),
    }
  }
  return {
    untilMs: nowMs + RATE_LIMIT_DEFAULT_COOLDOWN_MS,
    family: 'rate-limit',
    lastUpstreamError: upstreamErrorSummary(bodyText),
  }
}

function errorObjectOf(bodyText: string): Record<string, unknown> {
  const parsed = tryParseJson(bodyText)
  if (!isPlainObject(parsed)) return {}
  const error = parsed['error']
  return isPlainObject(error) ? error : {}
}

function numberAt(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** `<code-or-type>: <message>` summary of an upstream error body. */
function upstreamErrorSummary(bodyText: string): string {
  const parsed = tryParseJson(bodyText)
  if (isPlainObject(parsed)) {
    const error = parsed['error']
    if (isPlainObject(error)) {
      const code = typeof error['code'] === 'string' ? (error['code'] as string) : ''
      const type = typeof error['type'] === 'string' ? (error['type'] as string) : ''
      const message = typeof error['message'] === 'string' ? (error['message'] as string) : ''
      const label = code.length > 0 ? code : type
      if (label.length > 0 && message.length > 0) return `${label}: ${message}`
      if (message.length > 0) return message
    }
  }
  const trimmed = bodyText.trim()
  return trimmed.length > 0 ? trimmed : STREAM_DISCONNECTED_MESSAGE
}

function isModelNotFoundBody(bodyText: string): boolean {
  const parsed = tryParseJson(bodyText)
  if (!isPlainObject(parsed)) return false
  const error = parsed['error']
  if (!isPlainObject(error)) return false
  if (error['code'] === 'model_not_found') return true
  return typeof error['message'] === 'string' && (error['message'] as string).includes('model not found')
}

function cooldownDocument(record: CooldownRecord): JsonValue {
  return {
    until_ms: record.untilMs,
    family: record.family,
    last_upstream_error: record.lastUpstreamError,
  }
}

function cooldownFromDocument(value: JsonValue | undefined): CooldownRecord | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as { until_ms?: unknown; family?: unknown; last_upstream_error?: unknown }
  if (typeof record.until_ms !== 'number' || typeof record.last_upstream_error !== 'string') return undefined
  const family = record.family === 'not-found' ? 'not-found' : 'rate-limit'
  return {
    untilMs: record.until_ms,
    family,
    lastUpstreamError: record.last_upstream_error,
  }
}

// ---------------------------------------------------------------------------
// Upstream-header filtering (4.5) and byte plumbing
// ---------------------------------------------------------------------------

/**
 * Copies upstream response headers downstream minus hop-by-hop pairs,
 * `Set-Cookie`, length/encoding, the gateway-reserved CORS names, the
 * gateway-proxy prefixes, every header the upstream `Connection` names,
 * and - case-insensitively - the names the gateway itself already set on
 * the commit (the recorded wire carries one Content-Type, the one the
 * gateway wrote).
 */
function filterUpstreamHeaders(upstreamHeaders: HeaderList, gatewaySet: HeaderList): HeaderList {
  const owned = new Set(gatewaySet.map(([name]) => name.toLowerCase()))
  const connection = headerListToRecord(upstreamHeaders)['Connection'] ?? ''
  const named = new Set(
    connection
      .split(',')
      .map((name) => name.trim().toLowerCase())
      .filter((name) => name.length > 0),
  )
  const out: Array<[string, string]> = []
  for (const [rawName, value] of upstreamHeaders) {
    const lower = rawName.toLowerCase()
    if (owned.has(lower)) continue
    if (HOP_BY_HOP.has(lower)) continue
    if (RESERVED_CORS.has(lower)) continue
    if (named.has(lower)) continue
    if (PROXY_PREFIXES.some((prefix) => lower.startsWith(prefix))) continue
    out.push([rawName, value])
  }
  return out
}

function jsonBody(
  status: number,
  body: string,
  contentType: string,
  extraHeaders: HeaderList = [],
): CodexPassthroughResponse {
  const headers: Array<[string, string]> = [['Content-Type', contentType]]
  for (const [name, value] of extraHeaders) headers.push([canonicalHeaderName(name), value])
  return { status, headers, body }
}

function parseRoute(path: string): RouteKind | undefined {
  const queryStart = path.indexOf('?')
  const clean = queryStart >= 0 ? path.slice(0, queryStart) : path
  return ROUTES[clean]
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let out = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value !== undefined) out += decoder.decode(value, { stream: true })
  }
  return out + decoder.decode()
}

async function* readableToAsyncIterable(stream: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  const reader = stream.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      if (value !== undefined) yield value
    }
  } finally {
    reader.releaseLock()
  }
}

function framesToReadable(firstFrame: string, rest: AsyncIterable<string>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const iterator = rest[Symbol.asyncIterator]()
  let firstServed = false
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!firstServed) {
        firstServed = true
        controller.enqueue(encoder.encode(firstFrame))
        return
      }
      const next = await iterator.next()
      if (next.done === true) {
        controller.close()
        return
      }
      controller.enqueue(encoder.encode(next.value))
    },
    async cancel() {
      await iterator.return?.()
    },
  })
}
