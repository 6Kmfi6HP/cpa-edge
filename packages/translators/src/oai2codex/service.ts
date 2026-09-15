/**
 * Composed facade for the S2d5 direction: the full client -> upstream ->
 * client pipeline over an injected transport.
 *
 * `createOai2CodexService` wires the pure translation core together with the
 * executor behavior the recorded wire pins: model resolution (E7 on
 * failure), the always-SSE upstream request with cloaked headers and
 * session identity, the stream bootstrap gate (no SSE header before the
 * first frame), aggregation for non-stream clients, error classification
 * (E1/E8) and the 429 -> rate-limit-cooldown slice of E2 - the ladder arms
 * 1s x 2^level windows (a `Retry-After` hint floors at 10s, capped at 30
 * minutes) and cooldown state flows exclusively through the injected Store.
 * No transport happens here: the caller supplies `send`, so the same facade
 * runs on every runtime.
 */
import type { JsonValue, Store } from '@cpa-edge/core'
import {
  buildErrorEnvelopeBody,
  buildModelCooldownResponse,
  classifyCodexUpstreamError,
  incompleteStreamBody,
  invalidRequestBody,
  renderUpstreamFailure,
  unknownProviderEnvelope,
} from './errors'
import { buildCodexUpstreamHeaders, orderCodexUpstreamHeaders } from './headers'
import type { HeaderList } from './headers'
import { translateChatToCodex } from './request'
import { translateCodexBufferToChatCompletion } from './response'
import { bootstrapCodexChunkStream } from './stream'
import { CODEX_DEFAULT_BASE_URL, CODEX_RESPONSES_PATH } from './types'

/** One `models[]` entry of a codex-api-key credential. */
export interface Oai2CodexModelEntry {
  /** Upstream model name (alias target) stamped onto the wire. */
  readonly name: string
  /** Client-facing alias. */
  readonly alias?: string
  /** Thinking capability of the entry; absent strips the reasoning object. */
  readonly thinking?: boolean
}

/** One `codex-api-key` credential entry. */
export interface Oai2CodexCredential {
  readonly apiKey: string
  /** Upstream base URL; empty/absent falls back to the chatgpt.com backend. */
  readonly baseUrl?: string
  /** Credential-level static header map (applied after the client whitelist). */
  readonly headers?: Readonly<Record<string, string>>
  /** `codex.disable-codex-cloaking: true` keeps caller UA/Originator. */
  readonly disableCodexCloaking?: boolean
  readonly models: readonly Oai2CodexModelEntry[]
}

export interface Oai2CodexServiceOptions {
  /** codex-api-key entries, config order. */
  readonly credentials: readonly Oai2CodexCredential[]
  /** Gateway version for the User-Agent fallback when cloaking is off. */
  readonly gatewayVersion: string
  /** All persistent state (rate-limit cooldowns) flows through the Store. */
  readonly store: Store
  /** Epoch-milliseconds clock; drives every timing decision. */
  readonly now?: () => number
  /** Upstream attempts per request beyond the first (0 in every S2d5 fixture). */
  readonly requestRetry?: number
  /**
   * Transient-error cooldown window in seconds; -1 disables it. The S2d5
   * slice pins only the 429 rate-limit cooldown, which this switch does NOT
   * disable, so the option is recorded but not consulted here.
   */
  readonly transientErrorCooldownSeconds?: number
  /** `codex.disable-image-generation` - suppresses the injected image tool. */
  readonly disableImageGeneration?: boolean
}

/** Downstream (client-facing) request as received by the route. */
export interface Oai2CodexChatRequest {
  readonly method: string
  readonly path: string
  readonly headers: HeaderList
  readonly body: string
}

/** Upstream request the executor would transmit. */
export interface Oai2CodexUpstreamRequest {
  readonly method: string
  /** Absolute URL: `<base-url without trailing slash>/responses`. */
  readonly url: string
  readonly headers: HeaderList
  readonly body: string
}

/** Upstream response as produced by the injected transport. */
export interface Oai2CodexUpstreamResponse {
  readonly status: number
  readonly headers: HeaderList
  /**
   * 2xx bodies are SSE bytes; anything else is raw bytes. A read that
   * rejects mid-body models an upstream disconnect.
   */
  readonly body: ReadableStream<Uint8Array>
}

/** Transport callback owned by the runtime/executor layer. */
export type Oai2CodexUpstreamSender = (request: Oai2CodexUpstreamRequest) => Promise<Oai2CodexUpstreamResponse>

/** Downstream response: plain bytes for JSON, a pull-driven stream for SSE. */
export interface Oai2CodexChatResponse {
  readonly status: number
  readonly headers: HeaderList
  readonly body: string | ReadableStream<Uint8Array>
}

export interface Oai2CodexChatService {
  handleChatCompletions(request: Oai2CodexChatRequest, send: Oai2CodexUpstreamSender): Promise<Oai2CodexChatResponse>
}

const COOLDOWN_NAMESPACE = 'oai2codex'
const COOLDOWN_KEY_PREFIX = 'credential-cooldown:'
const PROVIDER = 'codex'

/** Quota-ladder base window (seconds) and cap. */
const QUOTA_LADDER_BASE_SECONDS = 1
const QUOTA_LADDER_MAX_SECONDS = 30 * 60
/** Floor applied to an upstream `Retry-After` hint. */
const RETRY_AFTER_FLOOR_SECONDS = 10

/** Stored cooldown record (persisted as a JSON document). */
interface CooldownRecord {
  readonly untilMs: number
  readonly resetSeconds: number
  readonly lastError: string
  readonly level: number
}

interface AttemptOutcome {
  readonly retryable: boolean
  readonly response: Oai2CodexChatResponse
}

/** Builds the facade. The service holds no state; cooldowns live in the Store. */
export function createOai2CodexService(options: Oai2CodexServiceOptions): Oai2CodexChatService {
  const credentials = options.credentials
  const now = options.now ?? (() => Date.now())
  const maxAttempts = Math.max(0, Math.floor(options.requestRetry ?? 0)) + 1

  return {
    async handleChatCompletions(request, send): Promise<Oai2CodexChatResponse> {
      let requestObject: Record<string, unknown> | undefined
      try {
        const parsed: unknown = JSON.parse(request.body)
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          requestObject = parsed as Record<string, unknown>
        }
      } catch {
        requestObject = undefined
      }
      if (requestObject === undefined) return jsonBody(400, invalidRequestBody())

      const rawModel = typeof requestObject['model'] === 'string' ? requestObject['model'] : ''
      const clientStream = requestObject['stream'] === true
      const clientHeaders = headerListToRecord(request.headers)

      const candidates: Array<{
        credentialIndex: number
        credential: Oai2CodexCredential
        entry: Oai2CodexModelEntry
      }> = []
      for (let index = 0; index < credentials.length; index++) {
        const credential = credentials[index]
        if (credential === undefined) continue
        for (const entry of credential.models) {
          if ((entry.alias ?? entry.name) === rawModel) {
            candidates.push({ credentialIndex: index, credential, entry })
            break
          }
        }
      }
      if (candidates.length === 0) return jsonBody(400, unknownProviderEnvelope(rawModel))

      let lastCooldown: CooldownRecord | undefined
      let attempts = 0
      for (const candidate of candidates) {
        const record = await readCooldown(options.store, cooldownKey(candidate.credentialIndex, candidate.entry.name))
        if (record !== undefined && now() < record.untilMs) {
          lastCooldown = record
          continue
        }
        attempts += 1
        const outcome = await attemptWithCandidate(candidate, request.body, clientHeaders, clientStream, rawModel, send)
        if (!outcome.retryable || attempts >= maxAttempts) return outcome.response
        // request-retry: fall through to the next credential for retryable
        // upstream failures (429 / transport failures).
      }
      if (lastCooldown !== undefined) {
        const remainingSeconds = remainingWindowSeconds(lastCooldown.untilMs, now())
        const cooldown = buildModelCooldownResponse({
          model: rawModel,
          provider: PROVIDER,
          lastUpstreamError: lastCooldown.lastError,
          resetSeconds: remainingSeconds,
        })
        return jsonBody(cooldown.status, cooldown.body, [['Retry-After', cooldown.retryAfter]])
      }
      return jsonBody(500, serverErrorEnvelope('no credential available for the requested model'))
    },
  }

  async function attemptWithCandidate(
    candidate: { credentialIndex: number; credential: Oai2CodexCredential; entry: Oai2CodexModelEntry },
    rawBody: string,
    clientHeaders: Readonly<Record<string, string>>,
    clientStream: boolean,
    _rawModel: string,
    send: Oai2CodexUpstreamSender,
  ): Promise<AttemptOutcome> {
    const credential = candidate.credential
    const translated = await translateChatToCodex(rawBody, {
      upstreamModel: candidate.entry.name,
      thinking: candidate.entry.thinking === true,
      session: {
        apiKey: clientApiKey(clientHeaders),
        clientSessionId: clientSessionSignal(clientHeaders),
      },
      disableImageGeneration: options.disableImageGeneration === true,
    })
    const baseUrl = credential.baseUrl !== undefined && credential.baseUrl.length > 0 ? credential.baseUrl : CODEX_DEFAULT_BASE_URL
    const url = joinUrl(baseUrl)
    const headers = buildCodexUpstreamHeaders({
      clientHeaders,
      apiKey: credential.apiKey,
      sessionId: translated.sessionHeaderValue,
      disableCodexCloaking: credential.disableCodexCloaking,
      gatewayVersion: options.gatewayVersion,
      credentialHeaders: credential.headers,
    })
    let upstream: Oai2CodexUpstreamResponse
    try {
      upstream = await send({
        method: 'POST',
        url,
        headers: orderCodexUpstreamHeaders(headers, url, translated.body),
        body: translated.body,
      })
    } catch {
      // Pre-HTTP transport failure: the incomplete-stream pre-commit shape.
      return { retryable: true, response: jsonBody(408, incompleteStreamBody()) }
    }

    if (upstream.status >= 200 && upstream.status < 300) {
      return clientStream
        ? await streamOutcome(upstream, candidate.entry.name, translated.nameMap)
        : await aggregateOutcome(upstream, candidate.entry.name, translated.nameMap)
    }

    let bodyText: string
    try {
      bodyText = await readAll(upstream.body)
    } catch {
      return { retryable: true, response: jsonBody(408, incompleteStreamBody()) }
    }
    // Render-first: the client-facing response is built before any cooldown
    // bookkeeping, so a Store failure can never reject it.
    const failure = classifyCodexUpstreamError(upstream.status, bodyText)
    const rendered = renderUpstreamFailure(failure)
    const outcome: AttemptOutcome = {
      retryable: rendered.status === 429,
      response: jsonBody(rendered.status, rendered.body),
    }
    if (rendered.status === 429) {
      await persistCooldownBestEffort(
        options.store,
        cooldownKey(candidate.credentialIndex, candidate.entry.name),
        bodyText,
        parseRetryAfterHint(upstream.headers),
        now(),
      )
    }
    return outcome
  }

  /** Stream clients: commit SSE headers only after the first frame is held. */
  async function streamOutcome(
    upstream: Oai2CodexUpstreamResponse,
    streamModel: string,
    nameMap: Readonly<Record<string, string>>,
  ): Promise<AttemptOutcome> {
    try {
      const bootstrap = await bootstrapCodexChunkStream(readableToAsyncIterable(upstream.body), {
        streamModel,
        nameMap,
      })
      if (bootstrap.kind === 'pre-commit') {
        return { retryable: false, response: jsonBody(bootstrap.status, bootstrap.body) }
      }
      return {
        retryable: false,
        response: {
          status: 200,
          headers: [
            ['Content-Type', 'text/event-stream'],
            ['Cache-Control', 'no-cache'],
          ],
          body: framesToReadable(bootstrap.firstFrame, bootstrap.rest),
        },
      }
    } catch {
      // A rejected read before any frame models an upstream disconnect.
      return { retryable: true, response: jsonBody(408, incompleteStreamBody()) }
    }
  }

  /** Non-stream clients: aggregate, patch, render one chat.completion. */
  async function aggregateOutcome(
    upstream: Oai2CodexUpstreamResponse,
    streamModel: string,
    nameMap: Readonly<Record<string, string>>,
  ): Promise<AttemptOutcome> {
    let buffer: string
    try {
      buffer = await readAll(upstream.body)
    } catch {
      return { retryable: true, response: jsonBody(408, incompleteStreamBody()) }
    }
    const result = translateCodexBufferToChatCompletion(buffer, { streamModel, nameMap })
    if (result.kind === 'ok') return { retryable: false, response: jsonBody(200, result.body) }
    return { retryable: false, response: jsonBody(result.status, result.body) }
  }
}

// ---------------------------------------------------------------------------
// Cooldown persistence (Store-backed; no other mutable state exists)
// ---------------------------------------------------------------------------

function cooldownKey(credentialIndex: number, model: string): string {
  return `${COOLDOWN_KEY_PREFIX}${credentialIndex}:${model}`
}

async function readCooldown(store: Store, key: string): Promise<CooldownRecord | undefined> {
  return cooldownFromDocument(await store.get(COOLDOWN_NAMESPACE, key))
}

/**
 * Best-effort cooldown persistence: by the time this runs the client-facing
 * response is already rendered, so a failing Store must not reject it. The
 * Store error is still surfaced - reported to the runtime's global error
 * channel (falling back to the console where that API is absent) - rather
 * than swallowed.
 */
async function persistCooldownBestEffort(
  store: Store,
  key: string,
  lastError: string,
  retryAfterHint: number | undefined,
  nowMs: number,
): Promise<void> {
  try {
    await writeCooldown(store, key, lastError, retryAfterHint, nowMs)
  } catch (error) {
    if (typeof reportError === 'function') reportError(error)
    else console.error(error)
  }
}

/**
 * Persists a rate-limit cooldown through the Store's atomic read-modify-
 * write: the callback derives the replacement from the current record alone
 * and may re-run when a competing writer commits first. A still-longer
 * window already stored for the credential is never shortened, so
 * concurrent 429s cannot overwrite each other's cooldown; the escalation
 * level still advances.
 */
async function writeCooldown(
  store: Store,
  key: string,
  lastError: string,
  retryAfterHint: number | undefined,
  nowMs: number,
): Promise<void> {
  await store.update(COOLDOWN_NAMESPACE, key, (current) => {
    const previous = cooldownFromDocument(current)
    const level = (previous?.level ?? -1) + 1
    const windowSeconds =
      retryAfterHint !== undefined
        ? Math.max(retryAfterHint, RETRY_AFTER_FLOOR_SECONDS)
        : Math.min(QUOTA_LADDER_BASE_SECONDS * 2 ** level, QUOTA_LADDER_MAX_SECONDS)
    const untilMs = nowMs + windowSeconds * 1000
    if (previous !== undefined && previous.untilMs > untilMs) {
      return cooldownDocument({ untilMs: previous.untilMs, resetSeconds: previous.resetSeconds, lastError, level })
    }
    return cooldownDocument({ untilMs, resetSeconds: windowSeconds, lastError, level })
  })
}

function parseRetryAfterHint(headers: HeaderList): number | undefined {
  for (const [name, value] of headers) {
    if (name.toLowerCase() !== 'retry-after') continue
    if (!/^[0-9]+$/.test(value)) return undefined
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) ? parsed : undefined
  }
  return undefined
}

/** Remaining cooldown seconds, rounded up, floored at 1. */
function remainingWindowSeconds(untilMs: number, nowMs: number): number {
  return Math.max(1, Math.ceil((untilMs - nowMs) / 1000))
}

function cooldownDocument(record: CooldownRecord): JsonValue {
  return {
    until_ms: record.untilMs,
    reset_seconds: record.resetSeconds,
    last_upstream_error: record.lastError,
    level: record.level,
  }
}

function cooldownFromDocument(value: JsonValue | undefined): CooldownRecord | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as { until_ms?: unknown; reset_seconds?: unknown; last_upstream_error?: unknown; level?: unknown }
  if (typeof record.until_ms !== 'number' || typeof record.reset_seconds !== 'number') return undefined
  if (typeof record.last_upstream_error !== 'string') return undefined
  return {
    untilMs: record.until_ms,
    resetSeconds: record.reset_seconds,
    lastError: record.last_upstream_error,
    level: typeof record.level === 'number' ? record.level : 0,
  }
}

// ---------------------------------------------------------------------------
// Header helpers
// ---------------------------------------------------------------------------

function headerListToRecord(list: HeaderList): Record<string, string> {
  const record: Record<string, string> = {}
  for (const [name, value] of list) record[name] = value
  return record
}

/** Downstream api key (Bearer token) of the client request. */
function clientApiKey(headers: Readonly<Record<string, string>>): string {
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() !== 'authorization') continue
    const value = headers[name] ?? ''
    return value.startsWith('Bearer ') ? value.slice('Bearer '.length) : value
  }
  return ''
}

/** Client session-header value, first present signal wins. */
function clientSessionSignal(headers: Readonly<Record<string, string>>): string | undefined {
  for (const wanted of ['session-id', 'x-session-id', 'x-claude-code-session-id']) {
    for (const name of Object.keys(headers)) {
      if (name.toLowerCase() !== wanted) continue
      const value = headers[name] ?? ''
      if (value.length > 0) return value
    }
  }
  return undefined
}

function joinUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${CODEX_RESPONSES_PATH}`
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

// ---------------------------------------------------------------------------
// Downstream envelopes (this direction owns its error shapes)
// ---------------------------------------------------------------------------

function jsonBody(status: number, body: string, extraHeaders: HeaderList = []): Oai2CodexChatResponse {
  const headers: Array<[string, string]> = [['Content-Type', 'application/json']]
  for (const [name, value] of extraHeaders) headers.push([name, value])
  return { status, headers, body }
}

function serverErrorEnvelope(message: string): string {
  return buildErrorEnvelopeBody(message, 'server_error', 'internal_server_error')
}
