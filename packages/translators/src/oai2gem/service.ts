/**
 * Composed facade for the S2d1 direction: the pinned /v1/chat/completions
 * client surface over an injected gemini-api-key transport (spec 2-5).
 *
 * `createOai2GemService` wires the pure translation core together with the
 * executor stages the recorded wire pins: the Bearer gateway-key gate
 * (S1 401 shapes), strict request parsing (NE-LENIENT), alias-only model
 * resolution incl. the thinking-suffix parse/strip (spec 2.2), the
 * request translation and thinking capability pass (3.1/3.2), the gemini
 * upstream wire (URL templates incl. the `?alt`/`?$alt` normalization,
 * the x-goog-api-key-only header set, the Go transport default UA),
 * non-stream response mapping (3.3), stream chunk mapping with the usage
 * filter and finish timing rules (3.4/4), downstream SSE framing with the
 * clean-EOF `[DONE]` and the mid-stream terminal error frame, error
 * semantics (5: verbatim non-2xx pass-through, the pre-commit JSON error
 * response, the scanner-error terminal frame), and the 429 -> model
 * cooldown slice (the verbatim 429 renders first, the window persists
 * through the injected Store, and a request landing inside it gets the
 * `model_cooldown` envelope with `Retry-After` and zero upstream
 * dispatch - fixture C16; `transient-error-cooldown-seconds: -1` does
 * NOT disable this window). No transport happens here: the caller
 * supplies `send`, so the same facade runs on every runtime. Gateway-local
 * responses (auth failures, malformed bodies, unknown models, the
 * cooldown envelope) carry NO trace header; every executor-routed
 * response carries one (presence pinned by every recording but C16).
 */
import { CpaError } from '@cpa-edge/core'
import type { JsonValue, Store } from '@cpa-edge/core'
import {
  INVALID_API_KEY_BODY,
  MISSING_API_KEY_BODY,
  buildModelCooldownResponse,
  classifyUpstreamError,
  headerValue,
  modelNotFoundBody,
  openAIErrorBody,
  parseRetryAfterSeconds,
  renderUpstreamFailure,
  terminalErrorFrame,
  transportErrorMessage,
} from './errors'
import { buildGeminiUpstreamHeaders } from './headers'
import { isPlainObject, parseStrictJson } from './json'
import { parseModelSuffix, stripModelSuffix, translateChatToGemini } from './request'
import { translateGeminiResponseToChatCompletion } from './response'
import { DONE_FRAME, frameChunk } from './sse'
import { translateGeminiStreamToChatChunks } from './stream'
import type { DownstreamStreamEvent, HeaderList, ThinkingCapability } from './types'
import type { GeminiUpstreamRequest } from './types'

/** Default upstream base when a credential carries none (recorded). */
export const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com'

/** Provider label of the cooldown envelope (fixture C16). */
const PROVIDER = 'gemini'

/** Quota ladder of the 429 cooldown window (S4: 1s * 2^level, cap 30min). */
const QUOTA_BACKOFF_BASE_SECONDS = 1
const QUOTA_BACKOFF_MAX_SECONDS = 30 * 60
/** An upstream `Retry-After` shorter than this is raised to it (S4). */
const QUOTA_RETRY_AFTER_FLOOR_SECONDS = 10

const COOLDOWN_NAMESPACE = 'oai2gem'
const COOLDOWN_KEY_PREFIX = 'model-cooldown:'

/** One `models[]` entry of a gemini-api-key credential. */
export interface Oai2GemModelEntry {
  /** Upstream model name; the alias target (any suffix is stripped on it). */
  readonly name: string
  /** Client-facing alias; defaults to `name`. */
  readonly alias?: string
  /** `force-mapping: true` rewrites the response/chunk model to the alias. */
  readonly forceMapping?: boolean
  /** Thinking capability override; absent = capability-known thinking-less. */
  readonly thinking?: { readonly levels?: readonly string[] }
}

/** One `gemini-api-key` credential entry. */
export interface Oai2GemCredential {
  /** Upstream key sent as the whole `x-goog-api-key` value. */
  readonly apiKey: string
  /** Upstream base URL; a trailing `/` is trimmed. */
  readonly baseUrl: string
  /** Credential-level static headers (spec 2.3; not exercised by goldens). */
  readonly headers?: Readonly<Record<string, string>>
  readonly models: readonly Oai2GemModelEntry[]
}

export interface Oai2GemServiceOptions {
  /** Gateway api-keys; the client gate is `Authorization: Bearer <key>`. */
  readonly apiKeys: readonly string[]
  /** gemini-api-key entries, config order. */
  readonly credentials: readonly Oai2GemCredential[]
  /** All persistent state (the 429 model cooldown) flows through it. */
  readonly store: Store
  /** Epoch-milliseconds clock; drives every timing decision. */
  readonly now?: () => number
  /** Upstream attempts per request beyond the first (0 in every fixture). */
  readonly requestRetry?: number
  /**
   * Transient-error cooldown window in seconds; -1 disables it. The S2d1
   * slice pins only the 429 rate-limit cooldown, which this switch does
   * NOT disable (recorded), so the option is recorded but not consulted.
   */
  readonly transientErrorCooldownSeconds?: number
}

/** Downstream (client-facing) request as received by the route. */
export interface Oai2GemChatRequest {
  readonly method: string
  /** `/v1/chat/completions` (a query string may ride along). */
  readonly path: string
  readonly headers: HeaderList
  readonly body: string
}

/** Upstream request the executor would transmit. */
export interface Oai2GemUpstreamRequest {
  readonly method: string
  readonly url: string
  readonly headers: HeaderList
  readonly body: string
}

/** Upstream response as produced by the injected transport. */
export interface Oai2GemUpstreamResponse {
  readonly status: number
  readonly headers: HeaderList
  /**
   * 2xx stream: SSE bytes; 2xx non-stream: JSON bytes; non-2xx: raw error
   * bytes. A rejected read mid-body models an upstream disconnect.
   */
  readonly body: ReadableStream<Uint8Array>
}

/** Transport callback owned by the runtime/executor layer. */
export type Oai2GemUpstreamSender = (request: Oai2GemUpstreamRequest) => Promise<Oai2GemUpstreamResponse>

/** Downstream response: plain bytes for JSON, a pull-driven stream for SSE. */
export interface Oai2GemChatResponse {
  readonly status: number
  readonly headers: HeaderList
  readonly body: string | ReadableStream<Uint8Array>
}

export interface Oai2GemChatService {
  handleChatCompletions(request: Oai2GemChatRequest, send: Oai2GemUpstreamSender): Promise<Oai2GemChatResponse>
}

/** Stored cooldown record (persisted as a JSON document). */
interface CooldownRecord {
  readonly untilMs: number
  readonly lastError: string
  readonly lastStatus: number
  readonly level: number
}

interface ResolvedCandidate {
  readonly credentialIndex: number
  readonly credential: Oai2GemCredential
  readonly entry: Oai2GemModelEntry
}

interface AttemptOutcome {
  readonly retryable: boolean
  readonly response: Oai2GemChatResponse
}

/** Builds the facade. The instance owns only the tool-call id counter. */
export function createOai2GemService(options: Oai2GemServiceOptions): Oai2GemChatService {
  const credentials = options.credentials
  const now = options.now ?? (() => Date.now())
  const maxAttempts = Math.max(0, Math.floor(options.requestRetry ?? 0)) + 1
  let toolCallSeq = 0
  const nextToolCallSeq = (): number => {
    toolCallSeq += 1
    return toolCallSeq
  }

  return {
    async handleChatCompletions(request, send): Promise<Oai2GemChatResponse> {
      const auth = authenticateBearer(request.headers, options.apiKeys)
      if (auth === 'missing') return jsonBody(401, MISSING_API_KEY_BODY, { trace: false })
      if (auth === 'invalid') return jsonBody(401, INVALID_API_KEY_BODY, { trace: false })

      let parsed: unknown
      try {
        parsed = parseStrictJson(request.body)
      } catch (error) {
        if (error instanceof CpaError) {
          return jsonBody(400, openAIErrorBody(error.message, 'invalid_request_error'), { trace: false })
        }
        throw error
      }
      const body: Record<string, unknown> = isPlainObject(parsed) ? parsed : {}

      const rawModel = typeof body['model'] === 'string' ? (body['model'] as string) : ''
      const suffix = parseModelSuffix(rawModel)
      const aliasBase = suffix !== undefined ? suffix.base : rawModel
      const stream = body['stream'] === true

      const candidates = resolveCandidates(aliasBase)
      if (candidates.length === 0) {
        return jsonBody(400, modelNotFoundBody(rawModel), { trace: false })
      }

      let lastCooldown: CooldownRecord | undefined
      let attempts = 0
      for (const candidate of candidates) {
        const record = await readCooldown(candidate.credentialIndex, aliasBase)
        if (record !== undefined && now() < record.untilMs) {
          lastCooldown = record
          continue
        }
        attempts += 1
        const outcome = await attemptWithCandidate(candidate, request, aliasBase, stream, suffix, send)
        if (!outcome.retryable || attempts >= maxAttempts) return outcome.response
        // request-retry: fall through to the next credential for retryable
        // upstream failures (429 / pre-commit transport failures).
      }
      if (lastCooldown !== undefined) {
        const rendered = buildModelCooldownResponse({
          model: rawModel,
          provider: PROVIDER,
          lastUpstreamError: lastCooldown.lastError,
          resetSeconds: Math.max(1, Math.ceil((lastCooldown.untilMs - now()) / 1000)),
          status: lastCooldown.lastStatus,
        })
        return jsonBody(rendered.status, rendered.body, { trace: false, extra: [['Retry-After', rendered.retryAfter]] })
      }
      return jsonBody(
        500,
        openAIErrorBody('no credential available for the requested model', 'server_error', 'internal_server_error'),
        { trace: false },
      )
    },
  }

  // -------------------------------------------------------------------------
  // One upstream attempt through a resolved credential
  // -------------------------------------------------------------------------

  async function attemptWithCandidate(
    candidate: ResolvedCandidate,
    request: Oai2GemChatRequest,
    aliasBase: string,
    stream: boolean,
    suffix: ReturnType<typeof parseModelSuffix>,
    send: Oai2GemUpstreamSender,
  ): Promise<AttemptOutcome> {
    const upstreamModel = stripModelSuffix(candidate.entry.name)
    const suffixLevel = suffix !== undefined ? suffix.suffix.trim().toLowerCase() : ''
    let translated: GeminiUpstreamRequest
    try {
      translated = translateChatToGemini(request.body, {
        upstreamModel,
        suffixLevel: suffixLevel.length > 0 ? suffixLevel : undefined,
        thinking: thinkingCapability(candidate.entry),
      })
    } catch (error) {
      if (error instanceof CpaError) {
        return {
          retryable: false,
          response: jsonBody(400, openAIErrorBody(error.message, 'invalid_request_error'), { trace: false }),
        }
      }
      throw error
    }

    const alt = queryAlt(request.path)
    const url = buildUpstreamUrl(candidate.credential.baseUrl, upstreamModel, stream, alt)
    const upstreamRequest: Oai2GemUpstreamRequest = {
      method: 'POST',
      url,
      headers: buildGeminiUpstreamHeaders({
        apiKey: candidate.credential.apiKey,
        url,
        body: translated.body,
        credentialHeaders: candidate.credential.headers,
      }),
      body: translated.body,
    }

    let upstream: Oai2GemUpstreamResponse
    try {
      upstream = await send(upstreamRequest)
    } catch (error) {
      return transportFailure(error)
    }

    if (upstream.status < 200 || upstream.status >= 300) {
      let bodyText: string
      try {
        bodyText = await readAll(upstream.body)
      } catch (error) {
        return transportFailure(error)
      }
      // Render-first: the client-facing surface is decided before any
      // cooldown bookkeeping, so a failing Store can never reject it.
      const rendered = renderUpstreamFailure(classifyUpstreamError(upstream.status, bodyText))
      const outcome: AttemptOutcome = {
        retryable: upstream.status === 429,
        response: jsonBody(rendered.status, rendered.body, { trace: true }),
      }
      if (upstream.status === 429) {
        await recordRateLimitFailure(candidate, aliasBase, bodyText, upstream.status, upstream.headers)
      }
      return outcome
    }

    if (stream) return streamOutcome(candidate, upstream, aliasBase)
    return nonStreamOutcome(candidate, upstream, aliasBase)
  }

  /** Non-stream 2xx: aggregate, translate, render the chat.completion. */
  async function nonStreamOutcome(
    candidate: ResolvedCandidate,
    upstream: Oai2GemUpstreamResponse,
    aliasBase: string,
  ): Promise<AttemptOutcome> {
    let buffer: string
    try {
      buffer = await readAll(upstream.body)
    } catch (error) {
      return transportFailure(error)
    }
    const bodyText = translateGeminiResponseToChatCompletion(buffer, responseContext(candidate.entry))
    await resetCooldownBestEffort(candidate.credentialIndex, aliasBase)
    return { retryable: false, response: jsonBody(200, bodyText, { trace: true }) }
  }

  /**
   * Stream 2xx: the SSE headers commit once the first translated chunk is
   * held - before that, upstream failures render as plain HTTP errors. A
   * stream that ends cleanly without any chunk still commits and sends
   * the `[DONE]` marker alone (spec 4.1).
   */
  async function streamOutcome(
    candidate: ResolvedCandidate,
    upstream: Oai2GemUpstreamResponse,
    aliasBase: string,
  ): Promise<AttemptOutcome> {
    const events = translateGeminiStreamToChatChunks(
      readableToAsyncIterable(upstream.body),
      responseContext(candidate.entry),
    )[Symbol.asyncIterator]()
    let first: IteratorResult<DownstreamStreamEvent>
    try {
      first = await events.next()
    } catch (error) {
      return transportFailure(error)
    }
    // The SSE commit set in the recorded emission order (T4 F2):
    // Cache-Control, then Connection, then Content-Type.
    const headers: HeaderList = [
      ['Cache-Control', 'no-cache'],
      ['Connection', 'keep-alive'],
      ['Content-Type', 'text/event-stream'],
      ['X-Cpa-Trace-Id', newTraceId()],
    ]
    if (first.done === true) {
      await resetCooldownBestEffort(candidate.credentialIndex, aliasBase)
      return { retryable: false, response: { status: 200, headers, body: DONE_FRAME } }
    }
    return {
      retryable: false,
      response: {
        status: 200,
        headers,
        body: eventsToReadable(first.value, events, candidate, aliasBase),
      },
    }
  }

  /**
   * Pull-driven downstream body: one `data:` block per translated chunk,
   * the `[DONE]` terminator on a clean upstream EOF, and exactly one
   * terminal error frame (NO `[DONE]`) on a post-commit failure.
   */
  function eventsToReadable(
    first: DownstreamStreamEvent,
    rest: AsyncIterator<DownstreamStreamEvent>,
    candidate: ResolvedCandidate,
    aliasBase: string,
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
              controller.enqueue(encoder.encode(DONE_FRAME))
              controller.close()
              await resetCooldownBestEffort(candidate.credentialIndex, aliasBase)
              return
            }
            event = next.value
          } catch (error) {
            // Post-commit transport failure: the terminal frame carries the
            // transport's own text (fixture C19 pins `unexpected EOF`).
            finished = true
            controller.enqueue(encoder.encode(terminalErrorFrame(transportErrorMessage(error))))
            controller.close()
            return
          }
        }
        controller.enqueue(encoder.encode(frameChunk(event.body)))
      },
      async cancel() {
        await rest.return?.()
      },
    })
  }

  /** Pre-commit transport failure: plain 500 envelope, retryable. */
  function transportFailure(error: unknown): AttemptOutcome {
    const body = openAIErrorBody(transportErrorMessage(error), 'server_error', 'internal_server_error')
    return { retryable: true, response: jsonBody(500, body, { trace: true }) }
  }

  function responseContext(entry: Oai2GemModelEntry): {
    forceMappingModel?: string
    nowMs: () => number
    nextToolCallSeq: () => number
  } {
    return {
      forceMappingModel: entry.forceMapping === true ? (entry.alias ?? entry.name) : undefined,
      nowMs: () => now(),
      nextToolCallSeq,
    }
  }

  // -------------------------------------------------------------------------
  // Alias resolution + capability
  // -------------------------------------------------------------------------

  function resolveCandidates(aliasBase: string): readonly ResolvedCandidate[] {
    const wanted = aliasBase.toLowerCase()
    const out: ResolvedCandidate[] = []
    for (let index = 0; index < credentials.length; index++) {
      const credential = credentials[index]
      if (credential === undefined) continue
      for (const entry of credential.models) {
        const routable = entry.alias ?? entry.name
        if (routable.toLowerCase() === wanted) {
          out.push({ credentialIndex: index, credential, entry })
          break
        }
      }
    }
    return out
  }

  /** `models[].thinking.levels` -> capability descriptor; absent = none. */
  function thinkingCapability(entry: Oai2GemModelEntry): ThinkingCapability | undefined {
    const levels = entry.thinking?.levels
    if (levels !== undefined && levels.length > 0) return { levels }
    return undefined
  }

  // -------------------------------------------------------------------------
  // Upstream URL (spec 2.3, GetAlt normalization)
  // -------------------------------------------------------------------------

  /**
   * The client `?alt=` value of the request path, if present. A client
   * `?$alt=` is an alias the reference's GetAlt also honors; the plain
   * `alt` param wins when both ride along.
   */
  function queryAlt(path: string): string | undefined {
    const question = path.indexOf('?')
    if (question < 0) return undefined
    let aliasValue: string | undefined
    for (const pair of path.slice(question + 1).split('&')) {
      const equals = pair.indexOf('=')
      const key = equals >= 0 ? pair.slice(0, equals) : pair
      const value = equals >= 0 ? pair.slice(equals + 1) : ''
      if (key === 'alt') return value
      if (key === '$alt' && aliasValue === undefined) aliasValue = value
    }
    return aliasValue
  }

  /**
   * Absolute upstream URL: `<base>/v1beta/models/<model>:generateContent`
   * (non-stream) or `:streamGenerateContent?alt=sse` (stream). A client
   * `?alt=sse` (or its `?$alt` alias) changes nothing; any other alt
   * value becomes `?$alt=X` on the upstream query.
   */
  function buildUpstreamUrl(baseUrl: string, upstreamModel: string, stream: boolean, alt: string | undefined): string {
    const base = baseUrl.length > 0 ? baseUrl.replace(/\/+$/, '') : DEFAULT_GEMINI_BASE_URL
    const path = `/v1beta/models/${upstreamModel}:${stream ? 'streamGenerateContent' : 'generateContent'}`
    if (alt !== undefined && alt.length > 0 && alt !== 'sse') {
      return `${base}${path}?$alt=${alt}`
    }
    return stream ? `${base}${path}?alt=sse` : `${base}${path}`
  }

  // -------------------------------------------------------------------------
  // Cooldown persistence (Store-backed; render-first, reportError)
  // -------------------------------------------------------------------------

  function cooldownKey(credentialIndex: number, aliasBase: string): string {
    return `${COOLDOWN_KEY_PREFIX}${credentialIndex}:${aliasBase}`
  }

  async function readCooldown(credentialIndex: number, aliasBase: string): Promise<CooldownRecord | undefined> {
    try {
      return cooldownFromDocument(await options.store.get(COOLDOWN_NAMESPACE, cooldownKey(credentialIndex, aliasBase)))
    } catch (error) {
      // Fail open: a Store outage must not invent a cooldown.
      surfaceStoreError(error)
      return undefined
    }
  }

  /**
   * Records a rate-limit window after the client response is rendered.
   * Window: the upstream `Retry-After` hint (floored at 10s), else the S4
   * quota ladder `1s * 2^level` capped at 30 minutes - the level increments
   * at most once per still-open window. A still-longer live window is
   * never shortened.
   */
  async function recordRateLimitFailure(
    candidate: ResolvedCandidate,
    aliasBase: string,
    bodyText: string,
    status: number,
    upstreamHeaders: HeaderList,
  ): Promise<void> {
    const hint = parseRetryAfterSeconds(upstreamHeaders)
    const lastError = bodyText.trim()
    let previous: CooldownRecord | undefined
    try {
      previous = cooldownFromDocument(
        await options.store.get(COOLDOWN_NAMESPACE, cooldownKey(candidate.credentialIndex, aliasBase)),
      )
    } catch (error) {
      surfaceStoreError(error)
      return
    }
    const level = previous !== undefined && now() < previous.untilMs ? previous.level + 1 : 0
    const windowSeconds =
      hint !== undefined
        ? Math.max(QUOTA_RETRY_AFTER_FLOOR_SECONDS, hint)
        : Math.min(QUOTA_BACKOFF_BASE_SECONDS * 2 ** level, QUOTA_BACKOFF_MAX_SECONDS)
    const record: CooldownRecord = {
      untilMs: now() + windowSeconds * 1000,
      lastError,
      lastStatus: status,
      level,
    }
    try {
      await options.store.update(COOLDOWN_NAMESPACE, cooldownKey(candidate.credentialIndex, aliasBase), (current) => {
        const existing = cooldownFromDocument(current)
        if (existing !== undefined && existing.untilMs > record.untilMs) return cooldownDocument(existing)
        return cooldownDocument(record)
      })
    } catch (error) {
      surfaceStoreError(error)
    }
  }

  /** A successful exchange clears the credential's window for the model. */
  async function resetCooldownBestEffort(credentialIndex: number, aliasBase: string): Promise<void> {
    try {
      await options.store.delete(COOLDOWN_NAMESPACE, cooldownKey(credentialIndex, aliasBase))
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
      last_error: record.lastError,
      last_status: record.lastStatus,
      level: record.level,
    }
  }

  function cooldownFromDocument(value: JsonValue | undefined): CooldownRecord | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
    const record = value as { until_ms?: unknown; last_error?: unknown; last_status?: unknown; level?: unknown }
    if (
      typeof record.until_ms !== 'number' ||
      typeof record.last_error !== 'string' ||
      typeof record.last_status !== 'number' ||
      typeof record.level !== 'number'
    ) {
      return undefined
    }
    return {
      untilMs: record.until_ms,
      lastError: record.last_error,
      lastStatus: record.last_status,
      level: record.level,
    }
  }
}

// ---------------------------------------------------------------------------
// Client auth gate (S1 shapes: Bearer only)
// ---------------------------------------------------------------------------

function authenticateBearer(headers: HeaderList, apiKeys: readonly string[]): 'ok' | 'missing' | 'invalid' {
  if (apiKeys.length === 0) return 'ok'
  const raw = headerValue(headers, 'authorization')
  if (raw === undefined) return 'missing'
  const space = raw.indexOf(' ')
  const credential = space < 0 ? raw : raw.slice(0, space).toLowerCase() === 'bearer' ? raw.slice(space + 1).trim() : raw
  if (credential.length === 0) return 'missing'
  return apiKeys.includes(credential) ? 'ok' : 'invalid'
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
  flags: { readonly trace: boolean; readonly extra?: HeaderList },
): Oai2GemChatResponse {
  const headers: Array<[string, string]> = [['Content-Type', 'application/json']]
  for (const [name, value] of flags.extra ?? []) headers.push([name, value])
  if (flags.trace) headers.push(['X-Cpa-Trace-Id', newTraceId()])
  return { status, headers, body }
}
