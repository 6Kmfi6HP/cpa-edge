/**
 * Composed facade for the OpenAI chat seam over OpenAI-compatibility
 * upstreams: the whole pinned pipeline over an injected transport.
 *
 * `createOai2OaiService` wires the passthrough core together with the
 * executor stages the recorded wire pins: the Bearer gateway-key gate,
 * the strict request boundary (NE-LENIENT: malformed JSON bodies reject
 * with 400 before model resolution), alias-only model resolution, the
 * alias rewrite and `stream_options.include_usage` injection on the
 * way out, the pinned upstream header set and order, VERBATIM
 * non-stream replies (byte-exact passthrough, spacing included), the
 * data-only SSE re-framing for stream clients, the stream commit rule,
 * upstream-error pass-through, and the 429 model-cooldown slice -
 * escalation state flows exclusively through the injected Store, and
 * every cooldown write is best-effort after the client response is
 * rendered (failures surface through `reportError`, never through the
 * response). The facade never emits a trace id: the runtime route layer
 * owns it (ruling R-TRACE). No transport happens here: the caller
 * supplies `send`, so the same facade runs on every runtime.
 */
import type { JsonValue, Store } from '@cpa-edge/core'
import {
  buildModelCooldownResponse,
  classifyUpstreamError,
  invalidRequestBody,
  isTpmRateLimitBody,
  modelNotFoundBody,
  parseRetryAfterSeconds,
  plainErrorBody,
  renderUpstreamFailure,
  serverErrorBody,
  transportFailureBody,
  upstreamErrorSummary,
} from './errors'
import { buildUpstreamHeaders, orderUpstreamHeaders, readHeaderValue, headerListToRecord } from './headers'
import { parseStrictJson } from './json'
import { translateChatPassthrough } from './request'
import { DONE_TERMINATOR, dataFrame } from './sse'
import { reframeUpstreamSse, rewriteResponseModel } from './stream'
import type { ChatResponseContext, DownstreamStreamEvent, HeaderList } from './types'

/** Path the executor appends to the credential base-url (recorded). */
const CHAT_COMPLETIONS_PATH = '/chat/completions'

const COOLDOWN_NAMESPACE = 'oai2oai'
const COOLDOWN_KEY_PREFIX = 'model-cooldown:'

// ---------------------------------------------------------------------------
// Public facade types
// ---------------------------------------------------------------------------

/** One `models[]` entry of an openai-compatibility credential. */
export interface Oai2OaiModelEntry {
  /** Upstream model name (the alias-rewrite target). */
  readonly name: string
  /** Client-facing alias; defaults to `name`. */
  readonly alias?: string
  /** `force-mapping: true` rewrites response models back to the alias. */
  readonly forceMapping?: boolean
}

/** One openai-compatibility provider entry. */
export interface Oai2OaiCredential {
  /** Provider name; the cooldown `provider` field is `openai-compatible-<name>`. */
  readonly name: string
  /** Upstream key -> `Authorization: Bearer <apiKey>`. */
  readonly apiKey: string
  /** Configured base-url INCLUDING the `/v1` suffix; trailing `/` trimmed. */
  readonly baseUrl: string
  /** Provider-level custom headers (optional; no golden exercises it). */
  readonly headers?: Readonly<Record<string, string>>
  readonly models: readonly Oai2OaiModelEntry[]
}

export interface Oai2OaiServiceOptions {
  /** Gateway api-keys accepted via `Authorization: Bearer`; empty = open. */
  readonly apiKeys: readonly string[]
  /** openai-compatibility entries, config order. */
  readonly credentials: readonly Oai2OaiCredential[]
  /** All persistent state (the 429 model-cooldown window) flows through it. */
  readonly store: Store
  /** Epoch-milliseconds clock; drives every timing decision. */
  readonly now?: () => number
  /** Upstream attempts per request beyond the first (0 in every recording). */
  readonly requestRetry?: number
  /**
   * Transient-error cooldown window in seconds; -1 disables it. The 429
   * model cooldown is NOT disabled by -1 (recorded hard pin), so the
   * option is recorded but not consulted here.
   */
  readonly transientErrorCooldownSeconds?: number
}

/** Downstream (client-facing) request as received by the route. */
export interface Oai2OaiRequest {
  readonly method: string
  readonly path: string
  readonly headers: HeaderList
  readonly body: string
}

/** Upstream request the executor would transmit. */
export interface Oai2OaiUpstreamRequest {
  readonly method: string
  /** Absolute URL: `<baseUrl-trimmed>/chat/completions`. */
  readonly url: string
  /** Emission order is pinned (see orderUpstreamHeaders). */
  readonly headers: HeaderList
  readonly body: string
}

/** Upstream response as produced by the injected transport. */
export interface Oai2OaiUpstreamResponse {
  readonly status: number
  readonly headers: HeaderList
  /**
   * 2xx stream: SSE bytes; 2xx non-stream: raw reply bytes; non-2xx: raw
   * error bytes. A rejected read mid-body models an upstream disconnect.
   */
  readonly body: ReadableStream<Uint8Array>
}

/** Transport callback owned by the runtime/executor layer. */
export type Oai2OaiUpstreamSender = (request: Oai2OaiUpstreamRequest) => Promise<Oai2OaiUpstreamResponse>

/** Downstream response: plain bytes for JSON, a pull-driven stream for SSE. */
export interface Oai2OaiResponse {
  readonly status: number
  readonly headers: HeaderList
  readonly body: string | ReadableStream<Uint8Array>
}

export interface Oai2OaiService {
  handleChatCompletions(request: Oai2OaiRequest, send: Oai2OaiUpstreamSender): Promise<Oai2OaiResponse>
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Direction-owned SSE headers, committed together with the first frame. */
const SSE_HEADERS: HeaderList = [
  ['Content-Type', 'text/event-stream'],
  ['Cache-Control', 'no-cache'],
  ['Connection', 'keep-alive'],
]

const JSON_CONTENT_TYPE = 'application/json'
const JSON_CHARSET_CONTENT_TYPE = 'application/json; charset=utf-8'

/** Stored cooldown record (persisted as a JSON document). */
interface CooldownRecord {
  readonly untilMs: number
  readonly resetSeconds: number
  readonly lastError: string
  readonly lastStatus: number
  readonly provider: string
  readonly failureCount: number
}

interface ResolvedCandidate {
  readonly credential: Oai2OaiCredential
  readonly entry: Oai2OaiModelEntry
}

interface AttemptOutcome {
  readonly retryable: boolean
  readonly response: Oai2OaiResponse
}

/** Builds the facade. The service holds no state; the cooldown lives in the Store. */
export function createOai2OaiService(options: Oai2OaiServiceOptions): Oai2OaiService {
  const now = options.now ?? (() => Date.now())
  const maxAttempts = Math.max(0, Math.floor(options.requestRetry ?? 0)) + 1

  return {
    async handleChatCompletions(request, send): Promise<Oai2OaiResponse> {
      const gate = checkGatewayKey(request, options.apiKeys)
      if (gate !== undefined) return gate

      // Strict request boundary (NE-LENIENT): malformed JSON rejects
      // with 400 BEFORE model resolution.
      let parsed: unknown
      try {
        parsed = parseStrictJson(request.body)
      } catch {
        return jsonBody(400, invalidRequestBody(), JSON_CONTENT_TYPE)
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return jsonBody(400, invalidRequestBody(), JSON_CONTENT_TYPE)
      }
      const record = parsed as Record<string, unknown>
      const requestedModel = typeof record['model'] === 'string' ? record['model'] : ''
      const stream = record['stream'] === true

      const candidates = resolveCandidates(requestedModel)
      if (candidates.length === 0) {
        return jsonBody(400, modelNotFoundBody(requestedModel), JSON_CONTENT_TYPE)
      }

      // Model cooldown gate: a request inside the window fails with the
      // triggering status and never dispatches (the recorded in-window
      // golden has an empty wire log).
      const cooldown = await readCooldown(requestedModel)
      if (cooldown !== undefined && now() < cooldown.untilMs) {
        const rendered = buildModelCooldownResponse({
          model: requestedModel,
          provider: cooldown.provider,
          lastUpstreamError: cooldown.lastError,
          resetSeconds: cooldown.resetSeconds,
          status: cooldown.lastStatus,
        })
        return jsonBody(rendered.status, rendered.body, JSON_CONTENT_TYPE, [
          ['Retry-After', rendered.retryAfter],
        ])
      }

      let attempts = 0
      let outcome: AttemptOutcome | undefined
      for (const candidate of candidates) {
        if (attempts >= maxAttempts) break
        attempts += 1
        outcome = await attemptWithCandidate(candidate, request, requestedModel, stream, send)
        if (!outcome.retryable) break
        // request-retry: fall through to the next credential for retryable
        // upstream failures (429 / transport).
      }
      if (outcome === undefined) {
        return jsonBody(500, serverErrorBody('no credential available for the requested model'), JSON_CONTENT_TYPE)
      }
      return outcome.response
    },
  }

  // -------------------------------------------------------------------------

  async function attemptWithCandidate(
    candidate: ResolvedCandidate,
    request: Oai2OaiRequest,
    requestedModel: string,
    stream: boolean,
    send: Oai2OaiUpstreamSender,
  ): Promise<AttemptOutcome> {
    const translated = translateChatPassthrough(request.body, {
      upstreamModel: candidate.entry.name,
      stream,
    })
    const url = `${candidate.credential.baseUrl.replace(/\/+$/, '')}${CHAT_COMPLETIONS_PATH}`
    const headers = orderUpstreamHeaders(
      withCredentialHeaders(buildUpstreamHeaders({ apiKey: candidate.credential.apiKey, stream }), candidate),
      url,
      translated.body,
    )
    const upstreamRequest: Oai2OaiUpstreamRequest = {
      method: 'POST',
      url,
      headers,
      body: translated.body,
    }

    let upstream: Oai2OaiUpstreamResponse
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
      // The client-facing surface is rendered before any cooldown
      // bookkeeping: a failing Store can never reject the response.
      const rendered = renderUpstreamFailure(classifyUpstreamError(upstream.status, bodyText))
      const outcome: AttemptOutcome = {
        retryable: upstream.status === 429,
        response: jsonBody(rendered.status, rendered.body, JSON_CONTENT_TYPE),
      }
      if (upstream.status === 429) {
        await recordRateLimitFailure(requestedModel, candidate, upstream.status, bodyText, upstream.headers)
      }
      return outcome
    }

    if (stream) return streamOutcome(upstream, candidate, requestedModel)
    return nonStreamOutcome(upstream, candidate, requestedModel)
  }

  /** Non-stream 2xx: the upstream reply crosses VERBATIM (recorded S1-14). */
  async function nonStreamOutcome(
    upstream: Oai2OaiUpstreamResponse,
    candidate: ResolvedCandidate,
    requestedModel: string,
  ): Promise<AttemptOutcome> {
    let buffer: string
    try {
      buffer = await readAll(upstream.body)
    } catch (error) {
      return transportFailure(error)
    }
    const alias = forceMappingModelOf(candidate.entry)
    const body = alias === undefined ? buffer : rewriteResponseModel(buffer, alias)
    await resetCooldownBestEffort(requestedModel)
    return { retryable: false, response: jsonBody(200, body, JSON_CONTENT_TYPE) }
  }

  /**
   * Stream 2xx: the SSE headers commit once the first re-framed event is
   * held - before that, upstream failures render as plain HTTP errors;
   * after it, they render as ONE terminal `data:` frame and the frames
   * already flushed survive. A stream that ends cleanly without any
   * data still commits: headers plus the `[DONE]` terminator alone.
   */
  async function streamOutcome(
    upstream: Oai2OaiUpstreamResponse,
    candidate: ResolvedCandidate,
    requestedModel: string,
  ): Promise<AttemptOutcome> {
    const forceMappingModel = forceMappingModelOf(candidate.entry)
    const ctx: ChatResponseContext = forceMappingModel === undefined ? {} : { forceMappingModel }
    const events = reframeUpstreamSse(readableToAsyncIterable(upstream.body), ctx)[Symbol.asyncIterator]()
    let first: IteratorResult<DownstreamStreamEvent>
    try {
      first = await events.next()
    } catch (error) {
      return transportFailure(error)
    }
    if (first.done === true) {
      // The composed generator always yields at least one event (a clean
      // close yields the synthesized terminator), so an exhausted iterator
      // here means an empty source; it still commits - headers plus the
      // terminator alone - and clears the cooldown window.
      await resetCooldownBestEffort(requestedModel)
      return { retryable: false, response: { status: 200, headers: [...SSE_HEADERS], body: DONE_TERMINATOR } }
    }
    return {
      retryable: false,
      response: {
        status: 200,
        headers: [...SSE_HEADERS],
        body: eventsToReadable(first.value, events, requestedModel),
      },
    }
  }

  /**
   * Pull-driven downstream body: one `data:` block per re-framed chunk,
   * the shared `[DONE]` terminator on the done event, and exactly one
   * terminal `data:` frame (no `[DONE]`) on a post-commit failure.
   */
  function eventsToReadable(
    first: DownstreamStreamEvent,
    rest: AsyncIterator<DownstreamStreamEvent>,
    requestedModel: string,
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
              return
            }
            event = next.value
          } catch (error) {
            // Post-commit transport failure: the terminal frame carries
            // the transport's own text (the same-surface disconnect
            // golden pins `unexpected EOF`).
            finished = true
            controller.enqueue(encoder.encode(dataFrame(transportFailureBody(error))))
            controller.close()
            return
          }
        }
        if (event.kind === 'done') {
          finished = true
          controller.enqueue(encoder.encode(DONE_TERMINATOR))
          controller.close()
          await resetCooldownBestEffort(requestedModel)
          return
        }
        controller.enqueue(encoder.encode(dataFrame(event.body)))
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

  /** Pre-commit transport failure: the wrapped 500 envelope, retryable. */
  function transportFailure(error: unknown): AttemptOutcome {
    return {
      retryable: true,
      response: jsonBody(500, transportFailureBody(error), JSON_CONTENT_TYPE),
    }
  }

  // -------------------------------------------------------------------------
  // Alias resolution
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

  function forceMappingModelOf(entry: Oai2OaiModelEntry): string | undefined {
    return entry.forceMapping === true ? (entry.alias ?? entry.name) : undefined
  }

  // -------------------------------------------------------------------------
  // Cooldown persistence (Store-backed; the only mutable state)
  // -------------------------------------------------------------------------

  function cooldownKey(model: string): string {
    return `${COOLDOWN_KEY_PREFIX}${model}`
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
   * consecutive failure - the recorded escalation golden).
   */
  async function recordRateLimitFailure(
    model: string,
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
      previous = cooldownFromDocument(await options.store.get(COOLDOWN_NAMESPACE, cooldownKey(model)))
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

  /** A successful upstream exchange clears the window. */
  async function resetCooldownBestEffort(model: string): Promise<void> {
    try {
      await options.store.delete(COOLDOWN_NAMESPACE, cooldownKey(model))
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
// Gateway-key gate
// ---------------------------------------------------------------------------

/**
 * The facade's own key gate: `Authorization: Bearer <key>` against the
 * configured gateway keys, with the recorded plain-string 401 bodies.
 * The route layer owns the full five-transport gate and normalizes the
 * header before dispatch; an empty key set leaves the facade open (open
 * mode).
 */
function checkGatewayKey(request: Oai2OaiRequest, apiKeys: readonly string[]): Oai2OaiResponse | undefined {
  if (apiKeys.length === 0) return undefined
  const authorization = readHeaderValue(headerListToRecord(request.headers), 'authorization')
  const presented =
    authorization !== undefined && authorization.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length)
      : undefined
  if (presented === undefined || presented.length === 0) {
    return jsonBody(401, plainErrorBody('Missing API key'), JSON_CHARSET_CONTENT_TYPE)
  }
  if (!apiKeys.includes(presented)) {
    return jsonBody(401, plainErrorBody('Invalid API key'), JSON_CHARSET_CONTENT_TYPE)
  }
  return undefined
}

/** Applies a credential's optional fixed headers after the gateway set. */
function withCredentialHeaders(
  base: Record<string, string>,
  candidate: { readonly credential: Oai2OaiCredential },
): Record<string, string> {
  const merged: Record<string, string> = { ...base }
  for (const [name, value] of Object.entries(candidate.credential.headers ?? {})) {
    merged[name] = value
  }
  return merged
}

// ---------------------------------------------------------------------------
// Byte plumbing (Web Standard APIs only)
// ---------------------------------------------------------------------------

function jsonBody(
  status: number,
  body: string,
  contentType: string,
  extra: HeaderList = [],
): Oai2OaiResponse {
  const headers: Array<[string, string]> = [['Content-Type', contentType]]
  for (const [name, value] of extra) headers.push([name, value])
  return { status, headers, body }
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
