/**
 * Composed facade for the S2d2 direction: the whole pinned /v1beta client
 * surface over an injected upstream transport (S2d2 sections 2-5).
 *
 * `createGem2OaiService` wires the pure translation core together with the
 * executor stages the recorded wire pins: the five-transport client auth
 * gate, route dispatch and `*action` path parsing, alias resolution, the
 * two-stage thinking pipeline, the openai-compat upstream wire (header
 * set and order, alias rewrite, stream_options injection), both alt
 * framings, local countTokens synthesis, verbatim upstream-error
 * pass-through, in-stream terminal errors, and the 429 model-cooldown
 * slice of section 5.3 - escalation state flows exclusively through the
 * injected Store (atomic update), and every cooldown write is best-effort
 * after the client response is rendered (failures surface through
 * `reportError`, never through the response). No transport happens here:
 * the caller supplies `send`, so the same facade runs on every runtime.
 */
import { CpaError } from '@cpa-edge/core'
import type { JsonValue, Store } from '@cpa-edge/core'
import { authenticateV1Beta } from './auth'
import { countTranslatedBodyTokens, renderCountTokensResponse } from './count'
import {
  INVALID_API_KEY_BODY,
  MISSING_API_KEY_BODY,
  MODEL_GET_NOT_FOUND_BODY,
  actionNotFoundBody,
  buildModelCooldownResponse,
  classifyUpstreamError,
  isTpmRateLimitBody,
  modelNotFoundBody,
  openAIErrorBody,
  parseRetryAfterSeconds,
  renderGatewayError,
  renderUpstreamFailure,
  transportErrorMessage,
  upstreamErrorSummary,
} from './errors'
import { serializeOrdered } from './json'
import {
  parseModelMethod,
  rawModelRecord,
  registryEntryById,
  renderModelsList,
  splitV1BetaPath,
} from './models'
import type { Gem2OaiRegistryEntry, V1BetaTarget } from './models'
import { translateGeminiRequest, withStreamOptions } from './request'
import { translateOpenAIResponseToGeminiNonStream } from './response'
import { frameDownstreamEvent, framingForAlt, translateOpenAIStreamToGemini } from './stream'
import { DEFAULT_OPENAI_COMPAT_THINKING } from './types'
import type {
  DownstreamFraming,
  DownstreamStreamEvent,
  HeaderList,
  OpenAIToGeminiContext,
  ThinkingCapability,
  WireObject,
} from './types'

// ---------------------------------------------------------------------------
// Public facade types
// ---------------------------------------------------------------------------

/** One `models[]` entry of an openai-compatibility credential. */
export interface Gem2OaiModelEntry {
  /** Upstream model name (the alias-rewrite target). */
  readonly name: string
  /** Client-facing alias; defaults to `name`. */
  readonly alias?: string
  /** Capability override; absent -> the openai-compat default (low/medium/high). */
  readonly thinking?: { readonly levels?: readonly string[] }
  /** `force-mapping: true` rewrites response models back to the alias (section 3.2). */
  readonly forceMapping?: boolean
}

/** One openai-compatibility provider entry. */
export interface Gem2OaiCredential {
  /** Provider name; the cooldown `provider` field is `openai-compatible-<name>`. */
  readonly name: string
  /** Upstream key -> `Authorization: Bearer <apiKey>`. */
  readonly apiKey: string
  /** Configured base-url INCLUDING the `/v1` suffix; a trailing `/` is trimmed. */
  readonly baseUrl: string
  /** Provider-level custom headers (optional; no golden exercises it). */
  readonly headers?: Readonly<Record<string, string>>
  readonly models: readonly Gem2OaiModelEntry[]
}

export interface Gem2OaiServiceOptions {
  /** openai-compat entries, config order. */
  readonly credentials: readonly Gem2OaiCredential[]
  /** Global model registry, registration order = models-list order. */
  readonly registry: readonly Gem2OaiRegistryEntry[]
  /** Gateway api-keys accepted on /v1beta (the five client-auth transports). */
  readonly apiKeys: readonly string[]
  /** All persistent state (429 cooldown windows + escalation) flows through it. */
  readonly store: Store
  /** Epoch-milliseconds clock; drives every timing decision. */
  readonly now?: () => number
  /** Upstream attempts per request beyond the first (0 in every S2d2 fixture). */
  readonly requestRetry?: number
  /**
   * Transient-error cooldown window in seconds; -1 disables it. The 429
   * model cooldown is NOT disabled by -1 (recorded) and this switch is
   * therefore recorded but not consulted here.
   */
  readonly transientErrorCooldownSeconds?: number
}

/** One downstream request on the /v1beta group. */
export interface Gem2OaiRequest {
  readonly method: string
  /** Full path + query, e.g. `/v1beta/models/mock-model:generateContent`. */
  readonly path: string
  /** Client headers, recorded order + casing. */
  readonly headers: HeaderList
  /** Exact request-body bytes ('' for GET). */
  readonly body: string
}

/** Upstream request the executor would transmit. */
export interface Gem2OaiUpstreamRequest {
  readonly method: string
  /** Absolute URL: `<baseUrl-trimmed>/chat/completions`. */
  readonly url: string
  /** Emission order is pinned (see the contract suite header). */
  readonly headers: HeaderList
  readonly body: string
}

/** Upstream response as produced by the injected transport. */
export interface Gem2OaiUpstreamResponse {
  readonly status: number
  readonly headers: HeaderList
  /**
   * 2xx stream: SSE bytes; 2xx non-stream: JSON bytes; non-2xx: raw error
   * bytes. A rejected read mid-body models an upstream disconnect.
   */
  readonly body: ReadableStream<Uint8Array>
}

/** Transport callback owned by the runtime/executor layer. */
export type Gem2OaiUpstreamSender = (request: Gem2OaiUpstreamRequest) => Promise<Gem2OaiUpstreamResponse>

/** Downstream response: plain bytes for JSON, a pull-driven stream for SSE/raw. */
export interface Gem2OaiResponse {
  readonly status: number
  readonly headers: HeaderList
  readonly body: string | ReadableStream<Uint8Array>
}

export interface Gem2OaiService {
  handleV1Beta(request: Gem2OaiRequest, send: Gem2OaiUpstreamSender): Promise<Gem2OaiResponse>
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const UPSTREAM_USER_AGENT = 'cli-proxy-openai-compat'
const COOLDOWN_NAMESPACE = 'gem2oai'
const COOLDOWN_KEY_PREFIX = 'model-cooldown:'

/** User-Agent of the openai-compat executor (recorded). */
export function openAICompatUserAgent(): string {
  return UPSTREAM_USER_AGENT
}

// ---------------------------------------------------------------------------
// Facade
// ---------------------------------------------------------------------------

interface ResolvedCandidate {
  readonly credential: Gem2OaiCredential
  readonly entry: Gem2OaiModelEntry
}

interface AttemptOutcome {
  readonly retryable: boolean
  readonly response: Gem2OaiResponse
}

/** Builds the facade. The service holds no mutable state; cooldowns live in the Store. */
export function createGem2OaiService(options: Gem2OaiServiceOptions): Gem2OaiService {
  const now = options.now ?? (() => Date.now())
  const maxAttempts = Math.max(0, Math.floor(options.requestRetry ?? 0)) + 1

  return {
    async handleV1Beta(request, send): Promise<Gem2OaiResponse> {
      const target = splitV1BetaPath(request.path)

      const auth = authenticateV1Beta(request.headers, target.query, options.apiKeys)
      if (auth.kind === 'missing') return jsonBody(401, MISSING_API_KEY_BODY, { charset: true, trace: false })
      if (auth.kind === 'invalid') return jsonBody(401, INVALID_API_KEY_BODY, { charset: true, trace: false })

      const actionPrefix = '/v1beta/models/'
      if (target.pathname === '/v1beta/models') {
        if (request.method === 'GET') {
          return jsonBody(200, renderModelsList(options.registry), { charset: true, trace: false })
        }
        return emptyNotFound()
      }
      if (target.pathname.startsWith(actionPrefix)) {
        const action = target.pathname.slice(actionPrefix.length)
        if (request.method === 'GET') return handleModelGet(action)
        if (request.method === 'POST') return handleModelAction(action, target, request, send)
        return emptyNotFound()
      }
      return emptyNotFound()
    },
  }

  // -------------------------------------------------------------------------
  // Model discovery (section 2.4)
  // -------------------------------------------------------------------------

  function handleModelGet(action: string): Gem2OaiResponse {
    const entry = registryEntryById(options.registry, action)
    if (entry === undefined) {
      return jsonBody(404, MODEL_GET_NOT_FOUND_BODY, { charset: true, trace: false })
    }
    return jsonBody(200, serializeOrdered(rawModelRecord(entry)), { charset: true, trace: false })
  }

  // -------------------------------------------------------------------------
  // *action dispatch (sections 2.1, 3, 4, 5)
  // -------------------------------------------------------------------------

  async function handleModelAction(
    action: string,
    target: V1BetaTarget,
    request: Gem2OaiRequest,
    send: Gem2OaiUpstreamSender,
  ): Promise<Gem2OaiResponse> {
    const parsed = parseModelMethod(action)
    if (parsed === undefined) {
      return jsonBody(404, actionNotFoundBody(target.pathname), { charset: true, trace: false })
    }
    const method = parsed.method
    if (method !== 'generateContent' && method !== 'streamGenerateContent' && method !== 'countTokens') {
      // Recorded: the body is consumed but nothing is written for an
      // unknown method - a bare 200 with no content type and no trace.
      return { status: 200, headers: [], body: '' }
    }

    const candidates = resolveCandidates(parsed.model)
    if (candidates.length === 0) {
      return jsonBody(400, modelNotFoundBody(parsed.model), { charset: false, trace: false })
    }
    const primary = candidates[0]
    if (primary === undefined) return jsonBody(400, modelNotFoundBody(parsed.model), { charset: false, trace: false })

    const stream = method === 'streamGenerateContent'
    const framing = framingForAlt(target.query.get('alt') ?? target.query.get('$alt') ?? undefined)

    // Request translation + thinking pipeline: the handler stage runs
    // before execution, so its 400s win over the cooldown gate.
    let translated: { readonly body: string; readonly value: WireObject }
    try {
      translated = await translateGeminiRequest(request.body, {
        upstreamModel: primary.entry.name,
        stream,
        thinking: capabilityOf(primary.entry),
      })
    } catch (error) {
      if (error instanceof CpaError) {
        return jsonBody(400, openAIErrorBody(error.message, 'invalid_request_error'), { charset: false, trace: true })
      }
      throw error
    }

    // Cooldown gate (section 5.3): a request for a model inside the window
    // fails with the triggering upstream status and never dispatches.
    const cooldown = await readCooldown(parsed.model)
    if (cooldown !== undefined && now() < cooldown.untilMs) {
      const rendered = buildModelCooldownResponse({
        model: parsed.model,
        provider: cooldown.provider,
        lastUpstreamError: cooldown.lastError,
        resetSeconds: cooldown.resetSeconds,
        status: cooldown.lastStatus,
      })
      return jsonBody(rendered.status, rendered.body, {
        charset: false,
        trace: false,
        extra: [['Retry-After', rendered.retryAfter]],
      })
    }

    if (method === 'countTokens') {
      const total = countTranslatedBodyTokens(translated.value, translated.body, primary.entry.name)
      return jsonBody(200, renderCountTokensResponse(total), { charset: false, trace: true })
    }

    let attempts = 0
    let outcome: AttemptOutcome | undefined
    for (const candidate of candidates) {
      if (attempts >= maxAttempts) break
      attempts += 1
      outcome = await attemptWithCandidate(candidate, request, stream, framing, parsed.model, send)
      if (!outcome.retryable) break
    }
    if (outcome === undefined) {
      return jsonBody(500, openAIErrorBody('no credential available for the requested model', 'server_error', 'internal_server_error'), {
        charset: false,
        trace: true,
      })
    }
    return outcome.response
  }

  async function attemptWithCandidate(
    candidate: ResolvedCandidate,
    request: Gem2OaiRequest,
    stream: boolean,
    framing: DownstreamFraming,
    alias: string,
    send: Gem2OaiUpstreamSender,
  ): Promise<AttemptOutcome> {
    let translated: { readonly body: string; readonly value: WireObject }
    try {
      translated = await translateGeminiRequest(request.body, {
        upstreamModel: candidate.entry.name,
        stream,
        thinking: capabilityOf(candidate.entry),
      })
    } catch (error) {
      if (error instanceof CpaError) {
        return {
          retryable: false,
          response: jsonBody(400, openAIErrorBody(error.message, 'invalid_request_error'), { charset: false, trace: true }),
        }
      }
      throw error
    }
    if (stream) withStreamOptions(translated.value)
    const bodyText = serializeOrdered(translated.value)
    const upstreamRequest = buildUpstreamRequest(candidate, bodyText, stream)

    let upstream: Gem2OaiUpstreamResponse
    try {
      upstream = await send(upstreamRequest)
    } catch (error) {
      return transportFailure(alias, error)
    }

    if (upstream.status < 200 || upstream.status >= 300) {
      let bodyText2: string
      try {
        bodyText2 = await readAll(upstream.body)
      } catch (error) {
        return transportFailure(alias, error)
      }
      // The client-facing surface is rendered before any cooldown
      // bookkeeping: a failing Store can never reject the response.
      const rendered = renderUpstreamFailure(classifyUpstreamError(upstream.status, bodyText2))
      const outcome: AttemptOutcome = {
        retryable: upstream.status === 429,
        response: jsonBody(rendered.status, rendered.body, { charset: false, trace: true }),
      }
      if (upstream.status === 429) {
        await recordRateLimitFailure(alias, candidate, upstream.status, bodyText2, upstream.headers)
      }
      return outcome
    }

    if (stream) return streamOutcome(alias, upstream, candidate, framing)
    return nonStreamOutcome(alias, upstream, candidate)
  }

  /** Pre-commit transport failure: a plain wrapped 500, retryable. */
  function transportFailure(alias: string, error: unknown): AttemptOutcome {
    return {
      retryable: true,
      response: jsonBody(500, renderGatewayError(transportErrorMessage(error), 500), { charset: false, trace: true }),
    }
  }

  /** Non-stream 2xx: aggregate, translate, render the Gemini envelope. */
  async function nonStreamOutcome(
    alias: string,
    upstream: Gem2OaiUpstreamResponse,
    candidate: ResolvedCandidate,
  ): Promise<AttemptOutcome> {
    let buffer: string
    try {
      buffer = await readAll(upstream.body)
    } catch (error) {
      return transportFailure(alias, error)
    }
    const ctx: OpenAIToGeminiContext = {
      streamModel: candidate.entry.name,
      forceMappingModel: forceMappingModelOf(candidate.entry),
    }
    let body: string
    try {
      body = translateOpenAIResponseToGeminiNonStream(buffer, ctx)
    } catch {
      // A 2xx body that is not JSON: treated as an upstream failure (502).
      return { retryable: false, response: jsonBody(502, renderGatewayError(buffer, 502), { charset: false, trace: true }) }
    }
    await resetCooldownBestEffort(alias)
    return { retryable: false, response: jsonBody(200, body, { charset: false, trace: true }) }
  }

  /**
   * Stream 2xx: the stream commits once the first translated event is
   * held - before that, transport failures render as plain HTTP errors;
   * after it, they render as terminal `event: error` frames and the
   * already-flushed frames survive (section 5.4). A stream that closes
   * cleanly without any event still commits: headers + empty body.
   */
  async function streamOutcome(
    alias: string,
    upstream: Gem2OaiUpstreamResponse,
    candidate: ResolvedCandidate,
    framing: DownstreamFraming,
  ): Promise<AttemptOutcome> {
    const ctx: OpenAIToGeminiContext = {
      streamModel: candidate.entry.name,
      forceMappingModel: forceMappingModelOf(candidate.entry),
    }
    const events = translateOpenAIStreamToGemini(readableToAsyncIterable(upstream.body), ctx)
    const iterator = events[Symbol.asyncIterator]()
    let first: IteratorResult<DownstreamStreamEvent>
    try {
      first = await iterator.next()
    } catch (error) {
      return transportFailure(alias, error)
    }
    const headers = framing === 'sse'
      ? ([
          ['Content-Type', 'text/event-stream'],
          ['Cache-Control', 'no-cache'],
          ['Connection', 'keep-alive'],
          ['Access-Control-Allow-Origin', '*'],
        ] as HeaderList)
      : ([['Content-Type', 'text/plain; charset=utf-8']] as HeaderList)
    if (first.done === true) {
      await resetCooldownBestEffort(alias)
      return { retryable: false, response: { status: 200, headers, body: '' } }
    }
    return {
      retryable: false,
      response: {
        status: 200,
        headers,
        body: eventsToReadable(first.value, iterator, framing, alias),
      },
    }
  }

  function eventsToReadable(
    first: DownstreamStreamEvent,
    rest: AsyncIterator<DownstreamStreamEvent>,
    framing: DownstreamFraming,
    alias: string,
  ): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder()
    let firstServed = false
    let finished = false
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (finished) return
        let event: DownstreamStreamEvent
        if (!firstServed) {
          firstServed = true
          event = first
        } else {
          try {
            const next = await rest.next()
            if (next.done === true) {
              finished = true
              controller.close()
              await resetCooldownBestEffort(alias)
              return
            }
            event = next.value
          } catch (error) {
            // Post-commit transport failure: the terminal frame carries
            // the transport's own text; flushed frames stay (section 5.4).
            event = { kind: 'terminal-error', body: renderGatewayError(transportErrorMessage(error), 500), status: 500 }
          }
        }
        controller.enqueue(encoder.encode(frameDownstreamEvent(framing, event)))
        if (event.kind === 'terminal-error') {
          finished = true
          controller.close()
        }
      },
      async cancel() {
        await rest.return?.()
      },
    })
  }

  // -------------------------------------------------------------------------
  // Alias resolution + capability
  // -------------------------------------------------------------------------

  function resolveCandidates(model: string): readonly ResolvedCandidate[] {
    const out: ResolvedCandidate[] = []
    for (const credential of options.credentials) {
      for (const entry of credential.models) {
        if ((entry.alias ?? entry.name) === model) {
          out.push({ credential, entry })
          break
        }
      }
    }
    return out
  }

  function capabilityOf(entry: Gem2OaiModelEntry): ThinkingCapability {
    const levels = entry.thinking?.levels
    if (levels !== undefined && levels.length > 0) {
      return { levels }
    }
    return DEFAULT_OPENAI_COMPAT_THINKING
  }

  function forceMappingModelOf(entry: Gem2OaiModelEntry): string | undefined {
    return entry.forceMapping === true ? (entry.alias ?? entry.name) : undefined
  }

  // -------------------------------------------------------------------------
  // Cooldown persistence (Store-backed; section 5.3)
  // -------------------------------------------------------------------------

  interface CooldownRecord {
    readonly untilMs: number
    readonly resetSeconds: number
    readonly lastError: string
    readonly lastStatus: number
    readonly provider: string
    readonly failureCount: number
  }

  function cooldownKey(alias: string): string {
    return `${COOLDOWN_KEY_PREFIX}${alias}`
  }

  async function readCooldown(alias: string): Promise<CooldownRecord | undefined> {
    try {
      return cooldownFromDocument(await options.store.get(COOLDOWN_NAMESPACE, cooldownKey(alias)))
    } catch (error) {
      // Fail open: a Store outage must not invent a cooldown.
      if (typeof reportError === 'function') reportError(error)
      else console.error(error)
      return undefined
    }
  }

  /**
   * Records a rate-limit failure after the client response is rendered.
   * Window: the upstream `Retry-After` hint, the 60s tokens-per-minute
   * fallback, or the escalating default (first failure 1s, doubling per
   * post-window failure - the recorded third consecutive 429 opens 4s).
   */
  async function recordRateLimitFailure(
    alias: string,
    candidate: ResolvedCandidate,
    status: number,
    bodyText: string,
    upstreamHeaders: HeaderList,
  ): Promise<void> {
    const hint = parseRetryAfterSeconds(upstreamHeaders)
    const tpm = isTpmRateLimitBody(bodyText)
    const summary = upstreamErrorSummary(bodyText)
    const provider = `openai-compatible-${candidate.credential.name}`
    let previous: CooldownRecord | undefined
    try {
      previous = cooldownFromDocument(await options.store.get(COOLDOWN_NAMESPACE, cooldownKey(alias)))
    } catch (error) {
      surfaceStoreError(error)
      return
    }
    const failureCount = (previous?.failureCount ?? 0) + 1
    const window = hint ?? (tpm ? 60 : 2 ** (failureCount - 1))
    const record: CooldownRecord = {
      untilMs: now() + window * 1000,
      resetSeconds: window,
      lastError: summary,
      lastStatus: status,
      provider,
      failureCount,
    }
    try {
      await options.store.update(COOLDOWN_NAMESPACE, cooldownKey(alias), (current) => {
        const existing = cooldownFromDocument(current)
        // Never shorten a still-longer window a concurrent writer opened.
        if (existing !== undefined && existing.untilMs > record.untilMs) return cooldownDocument(existing)
        return cooldownDocument(record)
      })
    } catch (error) {
      surfaceStoreError(error)
    }
  }

  /** A successful upstream exchange resets the escalation streak. */
  async function resetCooldownBestEffort(alias: string): Promise<void> {
    try {
      await options.store.delete(COOLDOWN_NAMESPACE, cooldownKey(alias))
    } catch (error) {
      surfaceStoreError(error)
    }
  }

  function surfaceStoreError(error: unknown): void {
    if (typeof reportError === 'function') reportError(error)
    else console.error(error)
  }

  function cooldownDocument(record: CooldownRecord): JsonValue {
    return {
      until_ms: record.untilMs,
      reset_seconds: record.resetSeconds,
      last_error: record.lastError,
      last_status: record.lastStatus,
      provider: record.provider,
      failure_count: record.failureCount,
    }
  }

  function cooldownFromDocument(value: JsonValue | undefined): CooldownRecord | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
    const record = value as {
      until_ms?: unknown
      reset_seconds?: unknown
      last_error?: unknown
      last_status?: unknown
      provider?: unknown
      failure_count?: unknown
    }
    if (
      typeof record.until_ms !== 'number' ||
      typeof record.reset_seconds !== 'number' ||
      typeof record.last_error !== 'string' ||
      typeof record.last_status !== 'number' ||
      typeof record.provider !== 'string' ||
      typeof record.failure_count !== 'number'
    ) {
      return undefined
    }
    return {
      untilMs: record.until_ms,
      resetSeconds: record.reset_seconds,
      lastError: record.last_error,
      lastStatus: record.last_status,
      provider: record.provider,
      failureCount: record.failure_count,
    }
  }
}

// ---------------------------------------------------------------------------
// Upstream wire assembly (section 2.3)
// ---------------------------------------------------------------------------

function buildUpstreamRequest(
  candidate: { readonly credential: Gem2OaiCredential },
  bodyText: string,
  stream: boolean,
): Gem2OaiUpstreamRequest {
  const url = `${candidate.credential.baseUrl.replace(/\/+$/, '')}/chat/completions`
  const headers: Record<string, string> = {
    'User-Agent': UPSTREAM_USER_AGENT,
    Authorization: `Bearer ${candidate.credential.apiKey}`,
    'Content-Type': 'application/json',
    'Accept-Encoding': 'gzip',
  }
  if (stream) {
    headers['Accept'] = 'text/event-stream'
    headers['Cache-Control'] = 'no-cache'
  }
  for (const [name, value] of Object.entries(candidate.credential.headers ?? {})) {
    headers[name] = value
  }
  // Emission order pinned by the recorded wire: Host, User-Agent and
  // Content-Length first, the remaining names in ASCII order, the
  // transport-managed Accept-Encoding last.
  const rest = Object.keys(headers)
    .filter((name) => name !== 'User-Agent' && name !== 'Accept-Encoding')
    .sort()
  const ordered: Array<[string, string]> = [
    ['Host', hostOf(url)],
    ['User-Agent', UPSTREAM_USER_AGENT],
    ['Content-Length', String(new TextEncoder().encode(bodyText).length)],
  ]
  for (const name of rest) ordered.push([name, headers[name] ?? ''])
  ordered.push(['Accept-Encoding', headers['Accept-Encoding'] ?? 'gzip'])
  return { method: 'POST', url, headers: ordered, body: bodyText }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
// Byte plumbing (Web Standard APIs only)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Downstream response assembly
// ---------------------------------------------------------------------------

function newTraceId(): string {
  return crypto.randomUUID()
}

function jsonBody(
  status: number,
  body: string,
  flags: { readonly charset: boolean; readonly trace: boolean; readonly extra?: HeaderList },
): Gem2OaiResponse {
  const headers: Array<[string, string]> = [
    ['Content-Type', flags.charset ? 'application/json; charset=utf-8' : 'application/json'],
  ]
  for (const [name, value] of flags.extra ?? []) headers.push([name, value])
  if (flags.trace) headers.push(['X-Cpa-Trace-Id', newTraceId()])
  return { status, headers, body }
}

function emptyNotFound(): Gem2OaiResponse {
  // Route-level 404: empty body, no headers (ruling R-404).
  return { status: 404, headers: [], body: '' }
}
