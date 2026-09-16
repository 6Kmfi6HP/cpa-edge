/**
 * Composed facade for the S2d7 direction: the full /v1beta generation
 * surface over an injected transport.
 *
 * `createGem2ClaService` wires the pure translation core together with
 * the stages the recorded wire pins: the gateway-key gate (S2d7-00),
 * alias-only model resolution (S2d7-22), `:generateContent` /
 * `:streamGenerateContent` / `:countTokens` dispatch with `alt`
 * normalization, the always-streamed upstream call (`?beta=true`,
 * `stream:true`, caller-owned headers), the stream bootstrap gate
 * (pre-commit 500 `empty_stream`), aggregation validation (502 family),
 * the raw-args splice cascade, verbatim upstream error pass-through, and
 * the 429 -> credential rate-limit cooldown slice (state flows exclusively
 * through the injected Store; `transient-error-cooldown-seconds: -1` does
 * not disable it). No transport happens here: the caller supplies `send`,
 * so the same facade runs on every runtime.
 */
import type { JsonValue, Store } from '@cpa-edge/core'
import {
  buildModelCooldownResponse,
  classifyClaudeUpstreamError,
  parseClaudeRateLimitResetWithFuzz,
  renderEmptyStreamFailure,
  renderUnexpectedEofFailure,
  renderUpstreamFailure,
  renderValidationFailure,
} from './errors'
import {
  buildClaudeUpstreamHeaders,
  headerListToRecord,
  orderUpstreamHeaders,
} from './headers'
import { CpaError } from '@cpa-edge/core'
import { isPlainObject } from './json'
import { assembleClaudeContent } from './request'
import { translateGeminiToClaude } from './request'
import { translateClaudeBufferToGemini } from './response'
import { frameForMode } from './sse'
import { bootstrapGeminiStream } from './stream'
import {
  estimateClaudeInputTokens,
  geminiTokenCountBody,
  serializeTokenCountRequest,
  TOKEN_COUNT_INVALID_JSON,
  TOKEN_COUNT_NOT_OBJECT,
  validateClaudeTokenCountRequest,
} from './tokens'
import type { DownstreamFraming } from './types'
import type { ModelThinkingCapability } from './types'

/** Ordered header list: `[name, value]` pairs, original casing. */
export type HeaderList = ReadonlyArray<readonly [string, string]>

/** One `models[]` entry of a claude-api-key credential. */
export interface Gem2ClaModelEntry {
  /** Upstream model name (alias target) stamped onto the wire. */
  readonly name: string
  /** Client-facing alias; ONLY the alias routes (recorded: S2d7-22). */
  readonly alias?: string
  /** Thinking capability block (`min`/`max` budget window or `levels`). */
  readonly thinking?: { readonly min?: number; readonly max?: number; readonly levels?: readonly string[] }
}

/** One `claude-api-key` credential entry. */
export interface Gem2ClaCredential {
  readonly apiKey: string
  readonly baseUrl: string
  readonly models: readonly Gem2ClaModelEntry[]
}

export interface Gem2ClaServiceOptions {
  /** Gateway keys accepted via `x-goog-api-key` or `Authorization: Bearer`. */
  readonly apiKeys: readonly string[]
  /** claude-api-key entries, config order. */
  readonly credentials: readonly Gem2ClaCredential[]
  /** Gateway version for the `CLIProxyAPI/<version>` user-agent fallback. */
  readonly gatewayVersion: string
  /** All persistent state (credential cooldowns) flows through the Store. */
  readonly store: Store
  /** Epoch-milliseconds clock; drives every timing decision. */
  readonly now?: () => number
  /** Upstream attempts per request beyond the first (0 in every S2d7 fixture). */
  readonly requestRetry?: number
  /**
   * Transient-error cooldown window in seconds; -1 disables it. The S2d7
   * slice pins only the 429 rate-limit cooldown, which this switch does NOT
   * disable (recorded hard pin), so the option is recorded but not
   * consulted here.
   */
  readonly transientErrorCooldownSeconds?: number
}

/** Downstream (client-facing) request as received by the /v1beta route. */
export interface Gem2ClaRequest {
  readonly method: string
  /** `/v1beta/models/{model}:{action}[?alt=…]` */
  readonly path: string
  readonly headers: HeaderList
  readonly body: string
}

/** Upstream request the executor would transmit. */
export interface Gem2ClaUpstreamRequest {
  readonly method: string
  /** Absolute URL; the path always carries `?beta=true` (S2d7 2.2). */
  readonly url: string
  readonly headers: HeaderList
  readonly body: string
}

/** Upstream response as produced by the injected transport. */
export interface Gem2ClaUpstreamResponse {
  readonly status: number
  readonly headers: HeaderList
  /**
   * 2xx bodies are SSE bytes; anything else is raw bytes. A read that
   * rejects mid-body models an upstream disconnect.
   */
  readonly body: ReadableStream<Uint8Array>
}

/** Transport callback owned by the runtime/executor layer. */
export type Gem2ClaUpstreamSender = (request: Gem2ClaUpstreamRequest) => Promise<Gem2ClaUpstreamResponse>

/** Downstream response: plain bytes for JSON, a pull-driven stream for SSE. */
export interface Gem2ClaResponse {
  readonly status: number
  readonly headers: HeaderList
  readonly body: string | ReadableStream<Uint8Array>
}

export interface Gem2ClaService {
  handleV1beta(request: Gem2ClaRequest, send: Gem2ClaUpstreamSender): Promise<Gem2ClaResponse>
}

const COOLDOWN_NAMESPACE = 'gem2cla'
const COOLDOWN_KEY_PREFIX = 'credential-cooldown:'
const PROVIDER = 'claude'

const V1BETA_ACTION_RE = /^\/v1beta\/models\/([^:/?]+):(generateContent|streamGenerateContent|countTokens)(?:\?.*)?$/

/** Stored cooldown record (persisted as a JSON document). */
interface CooldownRecord {
  readonly untilMs: number
  readonly resetSeconds: number
  readonly lastError: string
}

interface AttemptOutcome {
  readonly retryable: boolean
  readonly response: Gem2ClaResponse
}

type V1betaAction = 'generateContent' | 'streamGenerateContent' | 'countTokens'

interface ParsedV1betaPath {
  readonly model: string
  readonly action: V1betaAction
  readonly framing: DownstreamFraming
}

/** Builds the facade. The service holds no state; cooldowns live in the Store. */
export function createGem2ClaService(options: Gem2ClaServiceOptions): Gem2ClaService {
  const credentials = options.credentials
  const now = options.now ?? (() => Date.now())
  const maxAttempts = Math.max(0, Math.floor(options.requestRetry ?? 0)) + 1

  return {
    async handleV1beta(request, send): Promise<Gem2ClaResponse> {
      const parsed = parseV1betaPath(request.path)
      if (parsed === undefined || request.method !== 'POST') {
        return { status: 404, headers: [], body: '' }
      }

      const gate = checkGatewayKey(request, options.apiKeys)
      if (gate !== undefined) return gate

      const candidates: Array<{
        credentialIndex: number
        credential: Gem2ClaCredential
        entry: Gem2ClaModelEntry
      }> = []
      for (let index = 0; index < credentials.length; index++) {
        const credential = credentials[index]
        if (credential === undefined) continue
        for (const entry of credential.models) {
          if ((entry.alias ?? entry.name) === parsed.model) {
            candidates.push({ credentialIndex: index, credential, entry })
            break
          }
        }
      }
      if (candidates.length === 0) {
        return jsonBody(400, unknownProviderEnvelope(parsed.model))
      }

      if (parsed.action === 'countTokens') {
        // An ACTIVE credential window gates the local count too: no
        // tokens are computed and the upstream is never contacted
        // (recorded: S2d7-31).
        const cooling = await countTokensCooldown(candidates)
        if (cooling !== undefined) return cooldownResponse(parsed.model, cooling)
        return countTokensOutcome(request.body)
      }

      try {
        if (!isPlainObject(JSON.parse(request.body))) return jsonBody(400, invalidRequestEnvelope())
      } catch {
        return jsonBody(400, invalidRequestEnvelope())
      }

      let lastCooldown: CooldownRecord | undefined
      let attempts = 0
      for (const candidate of candidates) {
        const record = await readCooldown(options.store, candidate.credentialIndex)
        if (record !== undefined && now() < record.untilMs) {
          lastCooldown = record
          continue
        }
        attempts += 1
        const outcome = await attemptWithCandidate(candidate, request, parsed, send)
        if (!outcome.retryable || attempts >= maxAttempts) return outcome.response
        // request-retry: fall through to the next credential for retryable
        // upstream failures (429 / empty stream / pre-commit transport).
      }
      if (lastCooldown !== undefined) return cooldownResponse(parsed.model, lastCooldown)
      return jsonBody(500, serverErrorEnvelope('no credential available for the requested model'))
    },
  }

  async function attemptWithCandidate(
    candidate: { credentialIndex: number; credential: Gem2ClaCredential; entry: Gem2ClaModelEntry },
    request: Gem2ClaRequest,
    parsed: ParsedV1betaPath,
    send: Gem2ClaUpstreamSender,
  ): Promise<AttemptOutcome> {
    const translated = await translateGeminiToClaude(request.body, {
      upstreamModel: candidate.entry.name,
      thinking: thinkingCapability(candidate.entry.thinking),
    })
    const url = joinUrl(candidate.credential.baseUrl)
    const headerMap = buildClaudeUpstreamHeaders({
      clientHeaders: headerListToRecord(request.headers),
      apiKey: candidate.credential.apiKey,
      baseUrl: candidate.credential.baseUrl,
      gatewayVersion: options.gatewayVersion,
    })
    let upstream: Gem2ClaUpstreamResponse
    try {
      upstream = await send({
        method: 'POST',
        url,
        headers: orderUpstreamHeaders(headerMap, url, translated.body),
        body: translated.body,
      })
    } catch {
      return unexpectedEof()
    }

    if (upstream.status >= 200 && upstream.status < 300) {
      return parsed.action === 'streamGenerateContent'
        ? await streamOutcome(upstream, parsed.framing)
        : await aggregateOutcome(upstream, candidate.entry.name)
    }

    let bodyText: string
    try {
      bodyText = await readAll(upstream.body)
    } catch {
      return unexpectedEof()
    }
    // The downstream surface is rendered before any cooldown bookkeeping:
    // the verbatim-429 pass-through above must survive a Store failure, so
    // the write below can never reject this response.
    const rendered = renderUpstreamFailure(classifyClaudeUpstreamError(upstream.status, bodyText))
    const outcome: AttemptOutcome = {
      retryable: upstream.status === 429,
      response: jsonBody(rendered.status, rendered.body),
    }
    if (upstream.status === 429) {
      // Rate-limit cooldown: headerless 429s cool for a flat second (the
      // recorded literal), reset-carrying headers for the parsed reset
      // plus a bounded random grace. transient-error-cooldown-seconds
      // does not disable this.
      const resetSeconds = parseClaudeRateLimitResetWithFuzz(headerListToRecord(upstream.headers))
      await persistCooldownBestEffort(options.store, candidate.credentialIndex, {
        untilMs: now() + resetSeconds * 1000,
        resetSeconds,
        lastError: bodyText,
      })
    }
    return outcome
  }

  /**
   * Stream clients: the bootstrap gate commits SSE (or raw) headers only
   * after the first translated chunk; a chunk-less upstream becomes the
   * pre-commit 500 `empty_stream` gate (S2d7-30).
   */
  async function streamOutcome(
    upstream: Gem2ClaUpstreamResponse,
    framing: DownstreamFraming,
  ): Promise<AttemptOutcome> {
    try {
      const bootstrap = await bootstrapGeminiStream(readableToAsyncIterable(upstream.body), {
        // Stream chunks stamp `modelVersion` from the upstream
        // message_start echo, so the non-stream model name the context
        // type requires is never read on this path.
        resolvedModel: '',
        now,
      })
      if (bootstrap.kind === 'empty-stream') {
        const failure = renderEmptyStreamFailure()
        return { retryable: true, response: jsonBody(failure.status, failure.body) }
      }
      return {
        retryable: false,
        response: {
          status: 200,
          // The SSE commit set in the recorded emission order (T4 F2):
          // Cache-Control, then Connection, then Content-Type.
          headers:
            framing === 'sse'
              ? [
                  ['Cache-Control', 'no-cache'],
                  ['Connection', 'keep-alive'],
                  ['Content-Type', 'text/event-stream'],
                ]
              : [['Content-Type', 'text/plain; charset=utf-8']],
          body: framesToReadable(bootstrap.firstFrame, bootstrap.rest, framing),
        },
      }
    } catch {
      return unexpectedEof()
    }
  }

  /** Non-stream clients: aggregate, validate, render one Gemini body. */
  async function aggregateOutcome(
    upstream: Gem2ClaUpstreamResponse,
    resolvedModel: string,
  ): Promise<AttemptOutcome> {
    let buffer: string
    try {
      buffer = await readAll(upstream.body)
    } catch {
      return unexpectedEof()
    }
    const result = translateClaudeBufferToGemini(buffer, { resolvedModel, now })
    if (result.kind === 'ok') return { retryable: false, response: jsonBody(200, result.body) }
    const rendered = renderValidationFailure(result.message)
    return { retryable: false, response: jsonBody(rendered.status, rendered.body) }
  }

  /**
   * `:countTokens` never touches the transport: the client body is
   * translated, validated against the shared Claude token-count contract,
   * counted locally with the O200k tokenizer and answered with the
   * Gemini-shaped body (R-TOK; recorded N=4 in S2d7-12).
   */
  function countTokensOutcome(body: string): Gem2ClaResponse {
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      return jsonBody(400, tokenCountEnvelope(TOKEN_COUNT_INVALID_JSON))
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return jsonBody(400, tokenCountEnvelope(TOKEN_COUNT_NOT_OBJECT))
    }
    let assembly
    try {
      assembly = assembleClaudeContent(body)
    } catch (error) {
      if (error instanceof CpaError && error.code === 'invalid-input') {
        return jsonBody(400, invalidRequestEnvelope())
      }
      throw error
    }
    const validation = validateClaudeTokenCountRequest(serializeTokenCountRequest(assembly))
    if (!validation.ok) return jsonBody(400, tokenCountEnvelope(validation.message))
    const total = estimateClaudeInputTokens(assembly)
    return jsonBody(200, geminiTokenCountBody(total))
  }

  /**
   * The cooldown record gating a `:countTokens` request, or undefined when
   * at least one candidate credential sits outside a live window. The count
   * never contacts the upstream, so the window is its only gate (recorded:
   * S2d7-31 — an all-cooling model returns the model_cooldown surface and
   * computes nothing).
   */
  async function countTokensCooldown(
    candidates: readonly { readonly credentialIndex: number }[],
  ): Promise<CooldownRecord | undefined> {
    let last: CooldownRecord | undefined
    for (const candidate of candidates) {
      const record = await readCooldown(options.store, candidate.credentialIndex)
      if (record === undefined || now() >= record.untilMs) return undefined
      last = record
    }
    return last
  }

  /** 429 model_cooldown surface shared by the generation and count paths. */
  function cooldownResponse(model: string, record: CooldownRecord): Gem2ClaResponse {
    const cooldown = buildModelCooldownResponse({
      model,
      provider: PROVIDER,
      lastUpstreamError: record.lastError,
      resetSeconds: record.resetSeconds,
    })
    return jsonBody(cooldown.status, cooldown.body, [['Retry-After', cooldown.retryAfter]])
  }

  /** Pre-commit transport failure: plain 500 envelope. */
  function unexpectedEof(): AttemptOutcome {
    const failure = renderUnexpectedEofFailure()
    return { retryable: true, response: jsonBody(failure.status, failure.body) }
  }
}

// ---------------------------------------------------------------------------
// Gateway-key gate (S2d7-00; envelopes per the recorded 401 family)
// ---------------------------------------------------------------------------

function checkGatewayKey(request: Gem2ClaRequest, apiKeys: readonly string[]): Gem2ClaResponse | undefined {
  // An empty configured key list leaves the surface open: the auth layer
  // is not registered at all, so no presentation is required or checked
  // (recorded: S1-25 config variant V1; gem2oai runs the same branch).
  if (apiKeys.length === 0) return undefined
  const headers = headerListToRecord(request.headers)
  const googKey = readHeaderValue(headers, 'x-goog-api-key')
  const authorization = readHeaderValue(headers, 'authorization')
  let presented: string | undefined
  if (googKey !== undefined && googKey.length > 0) presented = googKey
  else if (authorization !== undefined && authorization.startsWith('Bearer ')) {
    presented = authorization.slice('Bearer '.length)
  }
  if (presented === undefined) {
    return {
      status: 401,
      headers: [['Content-Type', 'application/json; charset=utf-8']],
      body: serializePlain({ error: 'Missing API key' }),
    }
  }
  if (!apiKeys.includes(presented)) {
    return {
      status: 401,
      headers: [['Content-Type', 'application/json; charset=utf-8']],
      body: serializePlain({ error: 'Invalid API key' }),
    }
  }
  return undefined
}

function readHeaderValue(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  const lower = name.toLowerCase()
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key]
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Path and alt parsing
// ---------------------------------------------------------------------------

function parseV1betaPath(path: string): ParsedV1betaPath | undefined {
  const match = V1BETA_ACTION_RE.exec(path)
  if (match === null) return undefined
  const model = match[1]
  const action = match[2] as V1betaAction
  if (model === undefined || action === undefined) return undefined
  const queryStart = path.indexOf('?')
  const framing: DownstreamFraming = altFraming(queryStart >= 0 ? path.slice(queryStart + 1) : '')
  return { model, action, framing }
}

/**
 * `alt` normalization (GetAlt): absent, empty or `sse` yield SSE framing;
 * any other value (e.g. `json`) yields raw chunk concatenation. `$alt` is
 * an alias of `alt`.
 */
function altFraming(query: string): DownstreamFraming {
  const params = new URLSearchParams(query)
  const alt = params.get('alt') ?? params.get('$alt') ?? ''
  return alt === '' || alt === 'sse' ? 'sse' : 'raw'
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
 * channel (falling back to the console where that API is absent) - rather
 * than swallowed.
 */
async function persistCooldownBestEffort(store: Store, credentialIndex: number, record: CooldownRecord): Promise<void> {
  try {
    await writeCooldown(store, credentialIndex, record)
  } catch (error) {
    if (typeof reportError === 'function') reportError(error)
    else console.error(error)
  }
}

/**
 * Persists a rate-limit cooldown through the Store's atomic
 * read-modify-write: the callback derives the replacement from the current
 * record alone and may re-run when a competing writer commits first. A
 * still-longer window already stored for the credential is never shortened,
 * so concurrent 429s cannot overwrite each other's cooldown; a sequential
 * write (no live window) always lands exactly as given.
 */
async function writeCooldown(store: Store, credentialIndex: number, record: CooldownRecord): Promise<void> {
  await store.update(COOLDOWN_NAMESPACE, `${COOLDOWN_KEY_PREFIX}${credentialIndex}`, (current) => {
    const previous = cooldownFromDocument(current)
    if (previous !== undefined && previous.untilMs > record.untilMs) return cooldownDocument(previous)
    return cooldownDocument(record)
  })
}

function cooldownDocument(record: CooldownRecord): JsonValue {
  return {
    until_ms: record.untilMs,
    reset_seconds: record.resetSeconds,
    last_upstream_error: record.lastError,
  }
}

function cooldownFromDocument(value: JsonValue | undefined): CooldownRecord | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as { until_ms?: unknown; reset_seconds?: unknown; last_upstream_error?: unknown }
  if (typeof record.until_ms !== 'number' || typeof record.reset_seconds !== 'number') return undefined
  if (typeof record.last_upstream_error !== 'string') return undefined
  return { untilMs: record.until_ms, resetSeconds: record.reset_seconds, lastError: record.last_upstream_error }
}

// ---------------------------------------------------------------------------
// Downstream envelopes (this direction owns its error shapes)
// ---------------------------------------------------------------------------

function serializePlain(value: Record<string, unknown>): string {
  return JSON.stringify(value)
}

function tokenCountEnvelope(message: string): string {
  return JSON.stringify({ error: { message, type: 'invalid_request_error' } })
}

function invalidRequestEnvelope(): string {
  return JSON.stringify({ error: { message: 'Invalid request: malformed JSON body', type: 'invalid_request_error' } })
}

function unknownProviderEnvelope(model: string): string {
  return JSON.stringify({
    error: {
      message: `unknown provider for model ${model}`,
      type: 'invalid_request_error',
      code: 'model_not_found',
      param: 'model',
    },
  })
}

function serverErrorEnvelope(message: string): string {
  return JSON.stringify({ error: { message, type: 'server_error', code: 'internal_server_error' } })
}

function jsonBody(status: number, body: string, extraHeaders: HeaderList = []): Gem2ClaResponse {
  const headers: Array<[string, string]> = [['Content-Type', 'application/json']]
  for (const [name, value] of extraHeaders) headers.push([name, value])
  return { status, headers, body }
}

// ---------------------------------------------------------------------------
// Byte plumbing (Web Standard APIs only)
// ---------------------------------------------------------------------------

function joinUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, '')}/v1/messages?beta=true`
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
  firstFrame: { readonly kind: 'chunk'; readonly payload: string } | { readonly kind: 'terminal-error' },
  rest: AsyncIterable<{ readonly kind: 'chunk'; readonly payload: string } | { readonly kind: 'terminal-error' }>,
  framing: DownstreamFraming,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const iterator = rest[Symbol.asyncIterator]()
  let firstServed = false
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!firstServed) {
        firstServed = true
        controller.enqueue(encoder.encode(frameForMode(firstFrame, framing)))
        return
      }
      const next = await iterator.next()
      if (next.done === true) {
        controller.close()
        return
      }
      controller.enqueue(encoder.encode(frameForMode(next.value, framing)))
    },
    async cancel() {
      await iterator.return?.()
    },
  })
}

/** `models[].thinking` config -> translator capability descriptor. */
function thinkingCapability(
  config: { readonly min?: number; readonly max?: number; readonly levels?: readonly string[] } | undefined,
): ModelThinkingCapability | undefined {
  if (config === undefined) return undefined
  if (config.levels !== undefined && config.levels.length > 0) {
    return { kind: 'levels', levels: config.levels }
  }
  if (typeof config.min === 'number' || typeof config.max === 'number') {
    return { kind: 'budget', min: config.min ?? 0, max: config.max ?? 0 }
  }
  return undefined
}
