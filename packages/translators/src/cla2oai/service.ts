/**
 * Composed facade for the S2d4 direction: the Claude Messages surface
 * over an injected transport.
 *
 * `createCla2OaiService` wires the pure translation core together with
 * the stages the recorded wire pins: the five-transport gateway-key gate
 * (the middleware 401s keep their plain string shape and
 * `charset=utf-8` content type), strict request parsing (NE-LENIENT - a
 * body that is not a JSON object reads as an empty model and falls into
 * the unknown-provider path), cloaked-model decode, alias-only model
 * resolution, the client `stream` truthiness rule (`null` and any
 * non-false value stream), the two-stage thinking pipeline whose 400s
 * fire before dispatch (empty wire log), the 429 -> credential
 * rate-limit cooldown slice (state flows exclusively through the
 * injected Store; `transient-error-cooldown-seconds: -1` does not
 * disable it), local count_tokens synthesis (no upstream request), the
 * openai-compat upstream wire (recorded header set, alias rewrite,
 * `stream_options.include_usage` as the last body key), the SSE commit
 * rule (an upstream that ends before any data still commits SSE
 * headers), and the Claude error ladder. No transport happens here:
 * the caller supplies `send`, so the same facade runs on every runtime.
 */
import { CpaError } from '@cpa-edge/core'
import type { JsonValue, Store } from '@cpa-edge/core'
import { serializeOrdered } from './json'
import type { WireObject } from './json'
import {
  INVALID_API_KEY_BODY,
  MISSING_API_KEY_BODY,
  UNEXPECTED_EOF_MESSAGE,
  buildModelCooldownResponse,
  isTpmRateLimitBody,
  openAICompatProviderKey,
  parseRetryAfterSeconds,
  renderUpstreamFailure,
  summarizeUpstreamError,
} from './errors'
import { buildToolNameIndex } from './schema'
import type { ToolNameIndex } from './schema'
import { translateClaudeToOpenAI } from './request'
import { applyRequestThinking } from './thinking'
import { translateOpenAIResponseToClaude } from './response'
import { countTranslatedBodyTokens, estimateClaudeInputTokens, renderCountTokensResponse } from './tokens'
import { StreamFailureError, bootstrapCla2OaiStream } from './stream'
import type { DownstreamFrame } from './stream'
import { streamErrorEvent } from './response'
import { DEFAULT_OPENAI_COMPAT_THINKING } from './types'
import { decodeCloakedModelId } from './types'
import type {
  Cla2OaiContext,
  HeaderList,
  ThinkingCapability,
} from './types'
import {
  extractClientCredentials,
} from './auth'

/** User-Agent of the openai-compat executor (recorded). */
export const OPENAI_COMPAT_USER_AGENT = 'cli-proxy-openai-compat'

const COOLDOWN_NAMESPACE = 'cla2oai'
const COOLDOWN_KEY_PREFIX = 'model-cooldown:'

// ---------------------------------------------------------------------------
// Public facade types
// ---------------------------------------------------------------------------

/** One `models[]` entry of an openai-compatibility credential. */
export interface Cla2OaiModelEntry {
  /** Upstream model name (the alias-rewrite target). */
  readonly name: string
  /** Client-facing alias; ONLY the alias routes when set (recorded). */
  readonly alias?: string
  /** `is-compat: true` keeps unsigned assistant thinking as reasoning_content. */
  readonly isCompat?: boolean
  /** Capability override; absent -> the openai-compat default (low/medium/high). */
  readonly thinking?: { readonly levels?: readonly string[] }
}

/** One openai-compatibility provider entry. */
export interface Cla2OaiCredential {
  /** Provider name; the cooldown `provider` is `openai-compatible-<name>`. */
  readonly name: string
  /** Upstream key -> `Authorization: Bearer <apiKey>`. */
  readonly apiKey: string
  /** Configured base URL; ONE trailing `/` is trimmed (section 2.2). */
  readonly baseUrl: string
  /** Provider-level custom headers (optional; no golden exercises it). */
  readonly headers?: Readonly<Record<string, string>>
  readonly models: readonly Cla2OaiModelEntry[]
}

export interface Cla2OaiServiceOptions {
  /** Gateway keys accepted via the five client-auth transports. */
  readonly apiKeys: readonly string[]
  /** openai-compatibility entries, config order. */
  readonly credentials: readonly Cla2OaiCredential[]
  /** All persistent state (429 cooldown windows) flows through it. */
  readonly store: Store
  /** Epoch-milliseconds clock; drives every timing decision. */
  readonly now?: () => number
  /** Upstream attempts per request beyond the first (0 in every fixture). */
  readonly requestRetry?: number
  /**
   * Transient-error cooldown window in seconds; -1 disables it. The 429
   * rate-limit cooldown is NOT disabled by -1 (recorded), so the switch
   * is recorded but not consulted here.
   */
  readonly transientErrorCooldownSeconds?: number
}

/** One downstream request on the /v1/messages routes. */
export interface Cla2OaiRequest {
  readonly method: string
  /** `/v1/messages` or `/v1/messages/count_tokens` (query allowed). */
  readonly path: string
  readonly headers: HeaderList
  /** Exact request-body bytes. */
  readonly body: string
}

/** Upstream request the executor would transmit. */
export interface Cla2OaiUpstreamRequest {
  readonly method: string
  /** Absolute URL: `<base-url with one trailing "/" removed>/chat/completions`. */
  readonly url: string
  /** Emission order is pinned (see the golden suite header). */
  readonly headers: HeaderList
  readonly body: string
}

/** Upstream response as produced by the injected transport. */
export interface Cla2OaiUpstreamResponse {
  readonly status: number
  readonly headers: HeaderList
  /**
   * 2xx stream bodies are SSE bytes; 2xx non-stream bodies are JSON
   * (gzip magic bytes are gunzipped before translation); non-2xx bodies
   * are raw error bytes. A rejected read mid-body models an upstream
   * disconnect.
   */
  readonly body: ReadableStream<Uint8Array>
}

/** Transport callback owned by the runtime/executor layer. */
export type Cla2OaiUpstreamSender = (request: Cla2OaiUpstreamRequest) => Promise<Cla2OaiUpstreamResponse>

/** Downstream response: plain bytes for JSON, a pull-driven stream for SSE. */
export interface Cla2OaiResponse {
  readonly status: number
  readonly headers: HeaderList
  readonly body: string | ReadableStream<Uint8Array>
}

export interface Cla2OaiService {
  handleV1Messages(request: Cla2OaiRequest, send: Cla2OaiUpstreamSender): Promise<Cla2OaiResponse>
}

// ---------------------------------------------------------------------------
// Facade
// ---------------------------------------------------------------------------

interface ResolvedCandidate {
  readonly credential: Cla2OaiCredential
  readonly entry: Cla2OaiModelEntry
}

interface AttemptOutcome {
  readonly retryable: boolean
  readonly response: Cla2OaiResponse
}

/**
 * Downstream SSE success headers (the route layer adds the CORS block).
 * Emission order is the recorded one (T4 F2): Cache-Control, then
 * Connection, then Content-Type.
 */
const SSE_HEADERS: HeaderList = [
  ['Cache-Control', 'no-cache'],
  ['Connection', 'keep-alive'],
  ['Content-Type', 'text/event-stream'],
  ['Access-Control-Allow-Origin', '*'],
]

/** Builds the facade. The service holds no state; cooldowns live in the Store. */
export function createCla2OaiService(options: Cla2OaiServiceOptions): Cla2OaiService {
  const now = options.now ?? (() => Date.now())
  const maxAttempts = Math.max(0, Math.floor(options.requestRetry ?? 0)) + 1

  return {
    async handleV1Messages(request, send): Promise<Cla2OaiResponse> {
      const route = parseMessagesRoute(request.path)
      if (route === undefined || request.method !== 'POST') {
        // Ruling R-404: wrong method on a known route and unknown paths
        // answer with an empty 404.
        return { status: 404, headers: [], body: '' }
      }

      const auth = authenticateClient(request, options.apiKeys)
      if (auth === 'missing') return middlewareJsonBody(401, MISSING_API_KEY_BODY)
      if (auth === 'invalid') return middlewareJsonBody(401, INVALID_API_KEY_BODY)

      // Strict request boundary (NE-LENIENT): a body that does not parse
      // as a JSON object reads as an empty model and falls into the
      // unknown-provider path (mirrors the recorded sibling behavior).
      let parsedBody: Record<string, unknown> | undefined
      try {
        const parsed: unknown = JSON.parse(request.body)
        if (isRecord(parsed)) parsedBody = parsed
      } catch {
        parsedBody = undefined
      }

      const requestedModel =
        parsedBody !== undefined && typeof parsedBody['model'] === 'string'
          ? (parsedBody['model'] as string)
          : ''
      const clientModel = decodeCloakedModelId(requestedModel)

      const candidates = resolveCandidates(clientModel)
      if (candidates.length === 0) {
        return jsonBody(400, unknownProviderBody(clientModel))
      }
      const primary = candidates[0]
      if (primary === undefined) return jsonBody(400, unknownProviderBody(clientModel))

      // The client `stream` truthiness rule (section 2.1): non-stream iff
      // the field is absent or JSON `false`; anything else streams.
      const streamField = parsedBody?.['stream']
      const streaming = route === 'messages' && streamField !== undefined && streamField !== false

      // Request translation + thinking pipeline: the handler stage runs
      // before execution, so its 400s win over the cooldown gate and the
      // wire log stays empty.
      const translated = translateFor(primary, request.body, streaming)
      if (translated.error !== undefined) {
        return jsonBody(400, translated.error)
      }

      // Cooldown gate (section 5.2): a request for a model inside the
      // window fails with the triggering upstream status and never
      // dispatches (recorded: empty wire log).
      const cooldown = await readCooldown(clientModel)
      if (cooldown !== undefined && now() < cooldown.untilMs) {
        const remainingSeconds = Math.max(1, Math.ceil((cooldown.untilMs - now()) / 1000))
        const rendered = buildModelCooldownResponse({
          model: clientModel,
          provider: cooldown.provider,
          lastUpstreamError: cooldown.lastError,
          resetSeconds: remainingSeconds,
          status: cooldown.lastStatus,
        })
        return jsonBody(rendered.status, rendered.body, [['Retry-After', rendered.retryAfter]])
      }

      if (route === 'count_tokens') {
        // Local synthesis (section 3.6): the same translator ran above
        // (stream forced to false); no upstream request is made.
        const total = countTranslatedBodyTokens(
          translated.value as WireObject,
          translated.body,
          primary.entry.name,
        )
        return jsonBody(200, renderCountTokensResponse(total))
      }

      const toolNames = buildToolNameIndex(translated.requestTools)
      let attempts = 0
      let outcome: AttemptOutcome | undefined
      for (const candidate of candidates) {
        if (attempts >= maxAttempts) break
        attempts += 1
        const candidateOutcome = await attemptWithCandidate(
          candidate,
          clientModel,
          request,
          streaming,
          parsedBody,
          toolNames,
          send,
        )
        outcome = candidateOutcome
        if (!candidateOutcome.retryable) break
      }
      if (outcome === undefined) {
        return jsonBody(500, renderUpstreamFailure(500, '').body)
      }
      return outcome.response
    },
  }

  /** One upstream attempt through a resolved credential. */
  async function attemptWithCandidate(
    candidate: ResolvedCandidate,
    clientModel: string,
    request: Cla2OaiRequest,
    streaming: boolean,
    parsedBody: Record<string, unknown> | undefined,
    toolNames: ToolNameIndex,
    send: Cla2OaiUpstreamSender,
  ): Promise<AttemptOutcome> {
    const translated = translateFor(candidate, request.body, streaming)
    if (translated.error !== undefined) {
      return { retryable: false, response: jsonBody(400, translated.error) }
    }
    const bodyValue = translated.value
    if (streaming) {
      // The executor injects stream_options last (recorded).
      bodyValue['stream_options'] = { include_usage: true }
    }
    const bodyText = serializeOrdered(bodyValue)
    const upstreamRequest = buildUpstreamRequest(candidate.credential, bodyText, streaming)

    let upstream: Cla2OaiUpstreamResponse
    try {
      upstream = await send(upstreamRequest)
    } catch {
      return transportFailure()
    }

    if (upstream.status < 200 || upstream.status >= 300) {
      let bodyText2: string
      try {
        bodyText2 = await readBodyText(upstream.body)
      } catch {
        return transportFailure()
      }
      // Render-first: the client-facing response is built before any
      // cooldown bookkeeping, so a failing Store can never reject it.
      const rendered = renderUpstreamFailure(upstream.status, bodyText2)
      const outcome: AttemptOutcome = {
        retryable: upstream.status === 429,
        response: jsonBody(rendered.status, rendered.body),
      }
      if (upstream.status === 429) {
        await recordRateLimitFailure(clientModel, candidate, bodyText2, upstream.headers)
      }
      return outcome
    }

    await resetCooldownBestEffort(clientModel)
    if (streaming) {
      return streamOutcome(upstream, parsedBody, toolNames)
    }
    return nonStreamOutcome(upstream, toolNames)
  }

  /** Non-stream 2xx: aggregate, translate, render the Claude message. */
  async function nonStreamOutcome(
    upstream: Cla2OaiUpstreamResponse,
    toolNames: ToolNameIndex,
  ): Promise<AttemptOutcome> {
    let bodyText: string
    try {
      bodyText = await readBodyText(upstream.body)
    } catch {
      return transportFailure()
    }
    let body: string
    try {
      body = translateOpenAIResponseToClaude(bodyText, { toolNames })
    } catch {
      // A 2xx body that is not JSON: an upstream failure (502).
      const rendered = renderUpstreamFailure(502, bodyText)
      return { retryable: false, response: jsonBody(rendered.status, rendered.body) }
    }
    return { retryable: false, response: jsonBody(200, body) }
  }

  /**
   * Stream 2xx: the stream commits once the first translated event is
   * held - before that, failures render as plain HTTP errors; after it,
   * they render as one terminal `event: error` frame and the flushed
   * frames survive (section 4.4). An upstream that ends cleanly without
   * any data still commits the SSE headers over an empty body (section
   * 4.2 rule 8).
   */
  async function streamOutcome(
    upstream: Cla2OaiUpstreamResponse,
    parsedBody: Record<string, unknown> | undefined,
    toolNames: ToolNameIndex,
  ): Promise<AttemptOutcome> {
    const inputTokens = parsedBody === undefined ? 0 : estimateClaudeInputTokens(parsedBody)
    let bootstrap: Awaited<ReturnType<typeof bootstrapCla2OaiStream>>
    try {
      bootstrap = await bootstrapCla2OaiStream(readableToAsyncIterable(upstream.body), {
        inputTokens,
        toolNames,
      })
    } catch (error) {
      if (error instanceof StreamFailureError) {
        const rendered = renderUpstreamFailure(error.status, error.text)
        const isTransport = error.status === 500 && error.text === UNEXPECTED_EOF_MESSAGE
        return {
          retryable: isTransport,
          response: jsonBody(rendered.status, rendered.body),
        }
      }
      return transportFailure()
    }
    if (bootstrap.kind === 'committed-empty') {
      return { retryable: false, response: { status: 200, headers: SSE_HEADERS, body: '' } }
    }
    return {
      retryable: false,
      response: {
        status: 200,
        headers: SSE_HEADERS,
        body: framesToReadable(bootstrap.firstFrame, bootstrap.rest),
      },
    }
  }

  /** Pre-commit transport failure: plain 500 `unexpected EOF`, retryable. */
  function transportFailure(): AttemptOutcome {
    const rendered = renderUpstreamFailure(500, UNEXPECTED_EOF_MESSAGE)
    return { retryable: true, response: jsonBody(rendered.status, rendered.body) }
  }

  // -------------------------------------------------------------------------
  // Translation helpers
  // -------------------------------------------------------------------------

  /** Translates for one candidate; thinking-pipeline 400s come back rendered. */
  function translateFor(
    candidate: ResolvedCandidate,
    rawBody: string,
    streaming: boolean,
  ):
    | { readonly body: string; readonly value: WireObject; readonly requestTools: readonly WireObject[]; readonly error?: undefined }
    | { readonly error: string } {
    const ctx: Cla2OaiContext = {
      upstreamModel: candidate.entry.name,
      stream: streaming,
      isCompat: candidate.entry.isCompat === true,
      thinking: capabilityOf(candidate.entry),
    }
    try {
      const translated = translateClaudeToOpenAI(rawBody, ctx)
      applyRequestThinking(translated.value, safeParseObject(rawBody), ctx.thinking ?? DEFAULT_OPENAI_COMPAT_THINKING)
      // Re-serialize after the stage-2 rewrite (key position preserved).
      const body = serializeOrdered(translated.value)
      return { body, value: translated.value, requestTools: translated.requestTools }
    } catch (error) {
      if (error instanceof CpaError) {
        return { error: claudeInvalidRequestEnvelope(error.message) }
      }
      throw error
    }
  }

  /** Alias-only resolution: only the alias routes when an entry sets one. */
  function resolveCandidates(model: string): readonly ResolvedCandidate[] {
    const out: ResolvedCandidate[] = []
    for (const credential of options.credentials) {
      for (const entry of credential.models) {
        if (routableId(entry) === model) {
          out.push({ credential, entry })
          break
        }
      }
    }
    return out
  }

  function capabilityOf(entry: Cla2OaiModelEntry): ThinkingCapability {
    const levels = entry.thinking?.levels
    if (levels !== undefined && levels.length > 0) return { levels }
    return DEFAULT_OPENAI_COMPAT_THINKING
  }

  // -------------------------------------------------------------------------
  // Cooldown persistence (Store-backed; no other mutable state exists)
  // -------------------------------------------------------------------------

  interface CooldownRecord {
    readonly untilMs: number
    readonly lastError: string
    readonly lastStatus: number
    readonly provider: string
    readonly failureCount: number
  }

  async function readCooldown(model: string): Promise<CooldownRecord | undefined> {
    try {
      return cooldownFromDocument(await options.store.get(COOLDOWN_NAMESPACE, cooldownKey(model)))
    } catch (error) {
      // Fail open: a Store outage must not invent a cooldown.
      surfaceStoreError(error)
      return undefined
    }
  }

  /**
   * Records a rate-limit failure after the client response is rendered.
   * Window: the upstream `Retry-After` hint, the 60s tokens-per-minute
   * fallback, or the escalating default (first failure 1s, doubling per
   * post-window failure) - `transient-error-cooldown-seconds: -1` does
   * NOT disable it (recorded hard pin).
   */
  async function recordRateLimitFailure(
    model: string,
    candidate: ResolvedCandidate,
    bodyText: string,
    upstreamHeaders: HeaderList,
  ): Promise<void> {
    const hint = parseRetryAfterSeconds(upstreamHeaders)
    const tpm = isTpmRateLimitBody(bodyText)
    const summary = summarizeUpstreamError(bodyText)
    const provider = openAICompatProviderKey(candidate.credential.name)
    let previous: CooldownRecord | undefined
    try {
      previous = cooldownFromDocument(
        await options.store.get(COOLDOWN_NAMESPACE, cooldownKey(model)),
      )
    } catch (error) {
      surfaceStoreError(error)
      return
    }
    const failureCount = (previous?.failureCount ?? 0) + 1
    const window = hint ?? (tpm ? 60 : 2 ** (failureCount - 1))
    const record: CooldownRecord = {
      untilMs: now() + window * 1000,
      lastError: summary,
      lastStatus: 429,
      provider,
      failureCount,
    }
    try {
      await options.store.update(COOLDOWN_NAMESPACE, cooldownKey(model), (current) => {
        const existing = cooldownFromDocument(current)
        // Never shorten a still-longer window a concurrent writer opened.
        if (existing !== undefined && existing.untilMs > record.untilMs) return cooldownDocument(existing)
        return cooldownDocument(record)
      })
    } catch (error) {
      surfaceStoreError(error)
    }
  }

  /** A successful upstream exchange clears the escalation streak. */
  async function resetCooldownBestEffort(model: string): Promise<void> {
    try {
      await options.store.delete(COOLDOWN_NAMESPACE, cooldownKey(model))
    } catch (error) {
      surfaceStoreError(error)
    }
  }

  function cooldownKey(model: string): string {
    return `${COOLDOWN_KEY_PREFIX}${model}`
  }

  function cooldownDocument(record: CooldownRecord): JsonValue {
    return {
      until_ms: record.untilMs,
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
      last_error?: unknown
      last_status?: unknown
      provider?: unknown
      failure_count?: unknown
    }
    if (
      typeof record.until_ms !== 'number' ||
      typeof record.last_error !== 'string' ||
      typeof record.last_status !== 'number' ||
      typeof record.provider !== 'string' ||
      typeof record.failure_count !== 'number'
    ) {
      return undefined
    }
    return {
      untilMs: record.until_ms,
      lastError: record.last_error,
      lastStatus: record.last_status,
      provider: record.provider,
      failureCount: record.failure_count,
    }
  }

  function surfaceStoreError(error: unknown): void {
    if (typeof reportError === 'function') reportError(error)
    else console.error(error)
  }
}

// ---------------------------------------------------------------------------
// Route, auth gate and response assembly
// ---------------------------------------------------------------------------

function parseMessagesRoute(path: string): 'messages' | 'count_tokens' | undefined {
  const queryless = path.split('?')[0] ?? path
  if (queryless === '/v1/messages') return 'messages'
  if (queryless === '/v1/messages/count_tokens') return 'count_tokens'
  return undefined
}

/** Client-addressable id of a model entry: the alias, else the name. */
function routableId(entry: Cla2OaiModelEntry): string {
  return entry.alias !== undefined ? entry.alias : entry.name
}

/** Runs the five-transport gateway-key gate. */
function authenticateClient(request: Cla2OaiRequest, apiKeys: readonly string[]): 'ok' | 'missing' | 'invalid' {
  if (apiKeys.length === 0) return 'ok'
  const queryStart = request.path.indexOf('?')
  const query = new URLSearchParams(queryStart >= 0 ? request.path.slice(queryStart + 1) : '')
  const credentials = extractClientCredentials(request.headers, query)
  if (credentials.length === 0) return 'missing'
  for (const credential of credentials) {
    if (apiKeys.includes(credential)) return 'ok'
  }
  return 'invalid'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Re-parse of the raw body for the stage-2 thinking re-read. */
function safeParseObject(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody)
  } catch {
    return undefined
  }
}

function unknownProviderBody(model: string): string {
  // The rendered message is trimmed (an empty model yields no trailing
  // space).
  return serializeOrdered({
    type: 'error',
    error: { type: 'invalid_request_error', message: `unknown provider for model ${model}`.trim() },
  })
}

function claudeInvalidRequestEnvelope(message: string): string {
  return serializeOrdered({
    type: 'error',
    error: { type: 'invalid_request_error', message },
  })
}

/**
 * Middleware-level JSON response (the 401s): gin's renderer appends
 * `; charset=utf-8` to the content type (recorded distinction - every
 * handler-produced surface uses the bare form).
 */
function middlewareJsonBody(status: number, body: string): Cla2OaiResponse {
  return { status, headers: [['Content-Type', 'application/json; charset=utf-8']], body }
}

function jsonBody(
  status: number,
  body: string,
  extra: HeaderList = [],
): Cla2OaiResponse {
  const headers: Array<[string, string]> = [['Content-Type', 'application/json']]
  for (const [name, value] of extra) headers.push([name, value])
  return { status, headers, body }
}

// ---------------------------------------------------------------------------
// Upstream wire assembly (section 2.2)
// ---------------------------------------------------------------------------

function buildUpstreamRequest(
  credential: Cla2OaiCredential,
  bodyText: string,
  stream: boolean,
): Cla2OaiUpstreamRequest {
  const base = credential.baseUrl.replace(/\/$/, '')
  const url = `${base}/chat/completions`
  const headers: Record<string, string> = {
    'User-Agent': OPENAI_COMPAT_USER_AGENT,
    Authorization: `Bearer ${credential.apiKey}`,
    'Content-Type': 'application/json',
    'Accept-Encoding': 'gzip',
  }
  if (stream) {
    headers['Accept'] = 'text/event-stream'
    headers['Cache-Control'] = 'no-cache'
  }
  for (const [name, value] of Object.entries(credential.headers ?? {})) {
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
    ['User-Agent', OPENAI_COMPAT_USER_AGENT],
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

async function readAllBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value !== undefined) chunks.push(value)
  }
  let length = 0
  for (const chunk of chunks) length += chunk.length
  const out = new Uint8Array(length)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}

function isGzipMagic(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b
}

/** Reads a full body as text, gunzipping gzip magic bytes (section 2.2). */
async function readBodyText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const bytes = await readAllBytes(stream)
  const payload = isGzipMagic(bytes) ? await gunzip(bytes) : bytes
  return new TextDecoder().decode(payload)
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
  const pair = new DecompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>
  return readAllBytes(source.pipeThrough(pair))
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

function framesToReadable(
  firstFrame: DownstreamFrame,
  rest: AsyncIterable<DownstreamFrame>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const iterator = rest[Symbol.asyncIterator]()
  let firstServed = false
  let finished = false
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (finished) return
      let frame: DownstreamFrame
      if (!firstServed) {
        firstServed = true
        frame = firstFrame
      } else {
        const next = await iterator.next()
        if (next.done === true) {
          finished = true
          controller.close()
          return
        }
        frame = next.value
      }
      controller.enqueue(encoder.encode(frameDownstream(frame)))
      if (frame.kind === 'terminal-error') {
        finished = true
        controller.close()
      }
    },
    async cancel() {
      await iterator.return?.()
    },
  })
}

function frameDownstream(frame: DownstreamFrame): string {
  if (frame.kind === 'terminal-error') return streamErrorEvent(frame.message)
  return frame.payload
}
