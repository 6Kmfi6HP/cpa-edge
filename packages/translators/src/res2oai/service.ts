/**
 * Composed facade for the S2d6 direction: the full Responses client
 * surface (`POST /v1/responses`, its Codex alias and the `/responses/
 * compact` pair) over an injected transport.
 *
 * `createRes2OaiService` wires the pure translation core together with
 * the stages the recorded wire pins: the gateway-key gate (401 family),
 * the strict request boundary (NE-LENIENT: malformed JSON bodies reject
 * with 400 before model resolution), alias-only model resolution (the
 * upstream body always carries the resolved name), chat vs compact
 * upstream dispatch, the stream commit rule (SSE headers only once the
 * first translated frame exists; a frame-less upstream becomes the
 * pre-commit 500 `empty_stream` gate), verbatim non-stream upstream error
 * pass-through, the sorted-key stream pre-frame sanitizer, in-stream
 * terminal frames (`event: error` vs `event: response.failed` for
 * Codex-looking clients), the no-`[DONE]` in-stream failure, and the
 * 429 -> credential rate-limit cooldown slice (state flows exclusively
 * through the injected Store; `transient-error-cooldown-seconds: -1`
 * does not disable it). No transport happens here: the caller supplies
 * `send`, so the same facade runs on every runtime.
 */
import type { JsonValue, Store } from '@cpa-edge/core'
import { isPlainObject, parseStrictJson, rawValueAt, remarshalJson, serializeOrdered } from './json'
import type { WireObject } from './json'
import { RawJson } from './json'
import { translateCompactPassthrough } from './compact'
import {
  buildCompactStreamRejectedEnvelope,
  buildMalformedBodyEnvelope,
  buildModelCooldownResponse,
  buildModelNotFoundEnvelope,
  buildPlainErrorBody,
  classifyUpstreamError,
  isCodexClient,
  normalizeErrorStatus,
  RATE_LIMIT_COOLDOWN_MS,
  renderEmptyStreamFailure,
  renderUnexpectedEofFailure,
  renderUpstreamFailure,
  sanitizeInitialStreamError,
} from './errors'
import { buildUpstreamHeaders, headerListToRecord, orderUpstreamHeaders, readHeaderValue } from './headers'
import type { HeaderList } from './headers'
import type { ChatUpstreamRequest } from './types'
import { translateResponsesToChat } from './request'
import { ensureResponsesUsageDetails, translateChatToResponses } from './response'
import { bootstrapResponsesStream } from './stream'
import type { ResponsesStreamBootstrap } from './stream'
import { PreCommitStreamError } from './stream'
import { frameBytes } from './sse'
import type { ResponsesStreamFrame } from './sse'
import type { ChatToResponsesStreamContext } from './types'
import { CHAT_COMPLETIONS_PATH, RESPONSES_COMPACT_PATH } from './types'

export type { HeaderList }

/** One `models[]` entry of an openai-compatibility credential. */
export interface Res2OaiModelEntry {
  /** Upstream model name (alias target) stamped onto the wire. */
  readonly name: string
  /** Client-facing alias; ONLY the alias routes (recorded wire rule). */
  readonly alias?: string
}

/** One `openai-compatibility` credential entry. */
export interface Res2OaiCredential {
  readonly apiKey: string
  readonly baseUrl: string
  /** Provider name rendered into the `model_cooldown` message. */
  readonly provider?: string
  readonly models: readonly Res2OaiModelEntry[]
}

export interface Res2OaiServiceOptions {
  /** Gateway keys accepted via `Authorization: Bearer`. */
  readonly apiKeys: readonly string[]
  /** openai-compatibility entries, config order. */
  readonly credentials: readonly Res2OaiCredential[]
  /** All persistent state (credential cooldowns) flows through the Store. */
  readonly store: Store
  /** Epoch-milliseconds clock; drives every timing decision. */
  readonly now?: () => number
  /** Upstream attempts per request beyond the first (0 in every S2d6 fixture). */
  readonly requestRetry?: number
  /**
   * Transient-error cooldown window in seconds; -1 disables it. The S2d6
   * slice pins only the 429 rate-limit cooldown, which this switch does
   * NOT disable (recorded hard pin), so the option is recorded but not
   * consulted here.
   */
  readonly transientErrorCooldownSeconds?: number
}

/** Downstream (client-facing) request as received by the route. */
export interface Res2OaiRequest {
  readonly method: string
  /** `/v1/responses`, `/backend-api/codex/responses`, or their `/compact` forms. */
  readonly path: string
  readonly headers: HeaderList
  readonly body: string
}

/** Upstream request the executor would transmit. */
export interface Res2OaiUpstreamRequest {
  readonly method: string
  /** Absolute URL; the path is `/chat/completions` (compact: `/responses/compact`). */
  readonly url: string
  readonly headers: HeaderList
  readonly body: string
}

/** Upstream response as produced by the injected transport. */
export interface Res2OaiUpstreamResponse {
  readonly status: number
  readonly headers: HeaderList
  /**
   * 2xx stream bodies are SSE bytes; everything else is raw bytes. A
   * read that rejects mid-body models an upstream disconnect.
   */
  readonly body: ReadableStream<Uint8Array>
}

/** Transport callback owned by the runtime/executor layer. */
export type Res2OaiUpstreamSender = (request: Res2OaiUpstreamRequest) => Promise<Res2OaiUpstreamResponse>

/** Downstream response: plain bytes for JSON, a pull-driven stream for SSE. */
export interface Res2OaiResponse {
  readonly status: number
  readonly headers: HeaderList
  readonly body: string | ReadableStream<Uint8Array>
}

export interface Res2OaiService {
  handleResponses(request: Res2OaiRequest, send: Res2OaiUpstreamSender): Promise<Res2OaiResponse>
}

const COOLDOWN_NAMESPACE = 'res2oai'
const COOLDOWN_KEY_PREFIX = 'credential-cooldown:'
const DEFAULT_PROVIDER = 'openai-compatibility'

/** CORS block the OPTIONS preflight answers with (recorded probe 04; R-404 family). */
const CORS_BLOCK: HeaderList = [
  ['Access-Control-Allow-Headers', '*'],
  ['Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS'],
  ['Access-Control-Allow-Origin', '*'],
  [
    'Access-Control-Expose-Headers',
    'X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id',
  ],
]

/** Direction-owned SSE headers, committed together with the first frame. */
const SSE_HEADERS: HeaderList = [
  ['Content-Type', 'text/event-stream'],
  ['Cache-Control', 'no-cache'],
  ['Connection', 'keep-alive'],
  ['Access-Control-Allow-Origin', '*'],
]

/** Stored cooldown record (persisted as a JSON document). */
interface CooldownRecord {
  readonly untilMs: number
  readonly lastError: string
}

interface AttemptOutcome {
  readonly retryable: boolean
  readonly response: Res2OaiResponse
}

type RouteKind = 'responses' | 'compact'

interface Candidate {
  readonly credentialIndex: number
  readonly credential: Res2OaiCredential
  readonly entry: Res2OaiModelEntry
}

const ROUTES: Readonly<Record<string, RouteKind>> = Object.freeze({
  '/v1/responses': 'responses',
  '/backend-api/codex/responses': 'responses',
  '/v1/responses/compact': 'compact',
  '/backend-api/codex/responses/compact': 'compact',
})

/** Builds the facade. The service holds no state; cooldowns live in the Store. */
export function createRes2OaiService(options: Res2OaiServiceOptions): Res2OaiService {
  const credentials = options.credentials
  const now = options.now ?? (() => Date.now())
  const maxAttempts = Math.max(0, Math.floor(options.requestRetry ?? 0)) + 1

  return {
    async handleResponses(request, send): Promise<Res2OaiResponse> {
      const route = parseRoute(request.path)
      if (route === undefined) return { status: 404, headers: [], body: '' }
      if (request.method === 'OPTIONS') return { status: 204, headers: [...CORS_BLOCK], body: '' }
      if (request.method !== 'POST') return { status: 404, headers: [], body: '' }

      const gate = checkGatewayKey(request, options.apiKeys)
      if (gate !== undefined) return gate

      // Strict request boundary (NE-LENIENT): malformed JSON rejects with
      // 400 BEFORE model resolution.
      let parsed: unknown
      try {
        parsed = parseStrictJson(request.body)
      } catch {
        return jsonBody(400, buildMalformedBodyEnvelope(), 'application/json; charset=utf-8')
      }
      const record = isPlainObject(parsed) ? parsed : {}
      const requestedModel = modelOf(record, request.body)

      const candidates: Candidate[] = []
      for (let index = 0; index < credentials.length; index++) {
        const credential = credentials[index]
        if (credential === undefined) continue
        for (const entry of credential.models) {
          if ((entry.alias ?? entry.name) === requestedModel) {
            candidates.push({ credentialIndex: index, credential, entry })
            break
          }
        }
      }
      if (candidates.length === 0) {
        return jsonBody(400, buildModelNotFoundEnvelope(requestedModel), 'application/json')
      }

      if (route === 'compact' && record['stream'] === true) {
        return jsonBody(400, buildCompactStreamRejectedEnvelope(), 'application/json; charset=utf-8')
      }

      let lastCooldown: CooldownRecord | undefined
      let attempts = 0
      for (const candidate of candidates) {
        const cooldown = await readCooldown(options.store, candidate.credentialIndex)
        if (cooldown !== undefined && now() < cooldown.untilMs) {
          lastCooldown = cooldown
          continue
        }
        attempts += 1
        const outcome =
          route === 'compact'
            ? await compactAttempt(candidate, request, send)
            : await responsesAttempt(candidate, request, record, requestedModel, send)
        if (!outcome.retryable || attempts >= maxAttempts) return outcome.response
        // request-retry: fall through to the next credential for retryable
        // upstream failures (429 / empty stream / pre-commit transport).
      }
      if (lastCooldown !== undefined) {
        const rendered = buildModelCooldownResponse({
          model: requestedModel,
          provider: candidates[0]?.credential.provider ?? DEFAULT_PROVIDER,
          lastUpstreamError: lastCooldown.lastError,
        })
        return jsonBody(rendered.status, rendered.body, 'application/json')
      }
      return jsonBody(500, serverErrorEnvelope('no credential available for the requested model'), 'application/json')
    },
  }

  // -------------------------------------------------------------------------

  function rateLimitCooldown(candidate: Candidate, bodyText: string): CooldownRecord {
    void candidate
    return { untilMs: now() + RATE_LIMIT_COOLDOWN_MS, lastError: bodyText }
  }

  async function responsesAttempt(
    candidate: Candidate,
    request: Res2OaiRequest,
    record: Record<string, unknown>,
    requestedModel: string,
    send: Res2OaiUpstreamSender,
  ): Promise<AttemptOutcome> {
    const translated = translateResponsesToChat(request.body, { upstreamModel: candidate.entry.name })
    const stream = record['stream'] === true
    const body = stream ? withStreamOptions(translated.body) : translated.body
    const url = joinUrl(candidate.credential.baseUrl, CHAT_COMPLETIONS_PATH)
    const headers = orderUpstreamHeaders(buildUpstreamHeaders({ apiKey: candidate.credential.apiKey, stream }), url, body)
    let upstream: Res2OaiUpstreamResponse
    try {
      upstream = await send({ method: 'POST', url, headers, body })
    } catch {
      return unexpectedEof()
    }

    if (upstream.status >= 200 && upstream.status < 300) {
      return stream
        ? await streamOutcome(upstream, candidate, translated, requestedModel, request)
        : await nonStreamOutcome(upstream, candidate, translated)
    }

    let bodyText: string
    try {
      bodyText = await readAll(upstream.body)
    } catch {
      return unexpectedEof()
    }
    // The downstream surface is rendered before any cooldown bookkeeping:
    // the verbatim-429 pass-through must survive a Store failure, so the
    // write below can never reject this response.
    const retryable = upstream.status === 429
    if (stream) {
      const response = jsonBody(normalizeErrorStatus(upstream.status), sanitizeInitialStreamError(bodyText), 'application/json')
      if (retryable) {
        await persistCooldownBestEffort(options.store, candidate.credentialIndex, rateLimitCooldown(candidate, bodyText))
      }
      return { retryable, response }
    }
    const rendered = renderUpstreamFailure(classifyUpstreamError(upstream.status, bodyText))
    if (retryable) {
      await persistCooldownBestEffort(options.store, candidate.credentialIndex, rateLimitCooldown(candidate, bodyText))
    }
    return { retryable, response: jsonBody(rendered.status, rendered.body, 'application/json') }
  }

  async function nonStreamOutcome(
    upstream: Res2OaiUpstreamResponse,
    candidate: Candidate,
    translated: ChatUpstreamRequest,
  ): Promise<AttemptOutcome> {
    let buffer: string
    try {
      buffer = await readAll(upstream.body)
    } catch {
      return unexpectedEof()
    }
    const body = translateChatToResponses(buffer, {
      resolvedModel: candidate.entry.name,
      tools: translated.tools,
      chatTools: translated.chatTools,
      toolChoice: translated.toolChoice,
      maxTokens: translated.maxTokens,
      now,
    })
    return { retryable: false, response: jsonBody(200, body, 'application/json') }
  }

  /**
   * Stream clients: the commit rule holds SSE headers back until the
   * first translated frame; a frame-less upstream becomes the pre-commit
   * 500 `empty_stream` gate (S2d6 5.3). Codex-looking clients receive
   * `response.failed` terminal frames instead of `error` (S2d6 5.2).
   */
  async function streamOutcome(
    upstream: Res2OaiUpstreamResponse,
    candidate: Candidate,
    translated: ChatUpstreamRequest,
    requestedModel: string,
    request: Res2OaiRequest,
  ): Promise<AttemptOutcome> {
    const ctx: ChatToResponsesStreamContext = {
      requestedModel,
      resolvedModel: candidate.entry.name,
      tools: translated.tools,
      originalBody: request.body,
    }
    const failureEvent = isCodexClient(headerListToRecord(request.headers)) ? 'response.failed' : 'error'
    let bootstrap: ResponsesStreamBootstrap
    try {
      bootstrap = await bootstrapResponsesStream(readableToAsyncIterable(upstream.body), { ctx, failureEvent })
    } catch (error) {
      if (error instanceof PreCommitStreamError) {
        return {
          retryable: false,
          response: jsonBody(
            normalizeErrorStatus(error.failure.status),
            serializeOrdered({ error: new RawJson(error.failure.detail) }),
            'application/json',
          ),
        }
      }
      return unexpectedEof()
    }
    if (bootstrap.kind === 'empty-stream') {
      const failure = renderEmptyStreamFailure()
      return { retryable: true, response: jsonBody(failure.status, failure.body, 'application/json') }
    }
    return {
      retryable: false,
      response: {
        status: 200,
        headers: [...SSE_HEADERS],
        body: framesToReadable(bootstrap.firstFrame, bootstrap.rest),
      },
    }
  }

  /** Compact route: near-passthrough upstream call + usage-detail ensuring. */
  async function compactAttempt(candidate: Candidate, request: Res2OaiRequest, send: Res2OaiUpstreamSender): Promise<AttemptOutcome> {
    const body = translateCompactPassthrough(request.body, candidate.entry.name)
    const url = joinUrl(candidate.credential.baseUrl, RESPONSES_COMPACT_PATH)
    const headers = orderUpstreamHeaders(buildUpstreamHeaders({ apiKey: candidate.credential.apiKey, stream: false }), url, body)
    let upstream: Res2OaiUpstreamResponse
    try {
      upstream = await send({ method: 'POST', url, headers, body })
    } catch {
      return unexpectedEof()
    }
    if (upstream.status >= 200 && upstream.status < 300) {
      let buffer: string
      try {
        buffer = await readAll(upstream.body)
      } catch {
        return unexpectedEof()
      }
      // The recorded compact downstream is the re-marshalled compact form of
      // the upstream reply (field order preserved, spacing normalized), with
      // the usage-detail members appended by the ensure post-step.
      const body = ensureResponsesUsageDetails(remarshalJson(buffer))
      return { retryable: false, response: jsonBody(200, body, 'application/json') }
    }
    let bodyText: string
    try {
      bodyText = await readAll(upstream.body)
    } catch {
      return unexpectedEof()
    }
    const rendered = renderUpstreamFailure(classifyUpstreamError(upstream.status, bodyText))
    const retryable = upstream.status === 429
    if (retryable) {
      await persistCooldownBestEffort(options.store, candidate.credentialIndex, rateLimitCooldown(candidate, bodyText))
    }
    return { retryable, response: jsonBody(rendered.status, rendered.body, 'application/json') }
  }

  /** Pre-commit transport failure: plain 500 envelope, retryable. */
  function unexpectedEof(): AttemptOutcome {
    const failure = renderUnexpectedEofFailure()
    return { retryable: true, response: jsonBody(failure.status, failure.body, 'application/json') }
  }
}

// ---------------------------------------------------------------------------
// Route parsing and the gateway-key gate
// ---------------------------------------------------------------------------

function parseRoute(path: string): RouteKind | undefined {
  const queryStart = path.indexOf('?')
  const clean = queryStart >= 0 ? path.slice(0, queryStart) : path
  return ROUTES[clean]
}

/** Raw model string of the body: strings as-is, other values raw JSON text. */
function modelOf(record: Record<string, unknown>, body: string): string {
  const raw = record['model']
  if (typeof raw === 'string') return raw
  if (raw === undefined) return ''
  const rawText = rawValueAt(body, ['model'])
  return rawText ?? ''
}

function checkGatewayKey(request: Res2OaiRequest, apiKeys: readonly string[]): Res2OaiResponse | undefined {
  const headers = headerListToRecord(request.headers)
  const authorization = readHeaderValue(headers, 'authorization')
  const presented =
    authorization !== undefined && authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : undefined
  if (presented === undefined || presented.length === 0) {
    return jsonBody(401, buildPlainErrorBody('Missing API key'), 'application/json; charset=utf-8')
  }
  if (!apiKeys.includes(presented)) {
    return jsonBody(401, buildPlainErrorBody('Invalid API key'), 'application/json; charset=utf-8')
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Cooldown persistence (Store-backed; no other mutable state exists)
// ---------------------------------------------------------------------------

async function readCooldown(store: Store, credentialIndex: number): Promise<CooldownRecord | undefined> {
  return cooldownFromDocument(await store.get(COOLDOWN_NAMESPACE, `${COOLDOWN_KEY_PREFIX}${credentialIndex}`))
}

/**
 * Best-effort cooldown persistence: by the time this runs the client-facing
 * response is already rendered, so a failing Store must not reject it. The
 * Store error is still surfaced - reported to the runtime's global error
 * channel where that API exists - rather than swallowed.
 */
async function persistCooldownBestEffort(store: Store, credentialIndex: number, record: CooldownRecord): Promise<void> {
  try {
    await store.update(COOLDOWN_NAMESPACE, `${COOLDOWN_KEY_PREFIX}${credentialIndex}`, (current) => {
      const previous = cooldownFromDocument(current)
      if (previous !== undefined && previous.untilMs > record.untilMs) return cooldownDocument(previous)
      return cooldownDocument(record)
    })
  } catch (error) {
    if (typeof reportError === 'function') reportError(error)
    else console.error(error)
  }
}

function cooldownDocument(record: CooldownRecord): JsonValue {
  return { until_ms: record.untilMs, last_upstream_error: record.lastError }
}

function cooldownFromDocument(value: JsonValue | undefined): CooldownRecord | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as { until_ms?: unknown; last_upstream_error?: unknown }
  if (typeof record.until_ms !== 'number' || typeof record.last_upstream_error !== 'string') return undefined
  return { untilMs: record.until_ms, lastError: record.last_upstream_error }
}

// ---------------------------------------------------------------------------
// Downstream envelopes and byte plumbing (Web Standard APIs only)
// ---------------------------------------------------------------------------

function serverErrorEnvelope(message: string): string {
  return serializeOrdered({ error: { message, type: 'server_error', code: 'internal_server_error' } })
}

function jsonBody(status: number, body: string, contentType: string): Res2OaiResponse {
  return { status, headers: [['Content-Type', contentType]], body }
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`
}

/**
 * Appends the executor-owned `stream_options` member to a translated
 * streaming body (S2d6 3.2): `"stream_options":{"include_usage":true}`
 * lands after the last translator-produced field.
 */
export function withStreamOptions(body: string): string {
  if (!body.endsWith('}')) return body
  const inner = body.slice(0, -1)
  const separator = inner.endsWith('{') ? '' : ','
  return `${inner}${separator}"stream_options":{"include_usage":true}}`
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

function framesToReadable(
  firstFrame: ResponsesStreamFrame,
  rest: AsyncIterable<ResponsesStreamFrame>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const iterator = rest[Symbol.asyncIterator]()
  let firstServed = false
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!firstServed) {
        firstServed = true
        controller.enqueue(encoder.encode(frameBytes(firstFrame)))
        return
      }
      const next = await iterator.next()
      if (next.done === true) {
        controller.close()
        return
      }
      controller.enqueue(encoder.encode(frameBytes(next.value)))
    },
    async cancel() {
      await iterator.return?.()
    },
  })
}
