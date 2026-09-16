/**
 * Composed facade for the S2d3 direction: the full client -> upstream ->
 * client pipeline over an injected transport.
 *
 * `createOai2ClaChatService` wires the pure translation core together with
 * the executor post-processing the recorded wire pins: model/credential
 * resolution, thinking capability, the upstream header policy (including the
 * `claude-code-cli` fingerprint profile), the stream bootstrap gate, error
 * wraps, aggregation validation, and the 429 -> credential-cooldown slice of
 * S2d3 5.4 (cooldown state flows exclusively through the injected Store).
 * No transport happens here: the caller supplies `send`, so the same facade
 * runs on every runtime.
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
import { serializeOrdered } from './json'
import { buildClaudeUpstreamHeaders } from './headers'
import { parseModelSuffix, translateChatToClaude } from './request'
import { translateClaudeBufferToChatCompletion } from './response'
import { bootstrapChatChunkStream } from './stream'
import { sha256Hex } from './userid'
import type { ClaudeCodeCliIdentity } from './types'

/** Ordered header list: `[name, value]` pairs, original casing. */
export type HeaderList = ReadonlyArray<readonly [string, string]>

/** One `models[]` entry of a claude-api-key credential. */
export interface Oai2ClaModelEntry {
  /** Upstream model name (alias target) stamped onto the wire. */
  readonly name: string
  /** Client-facing alias; a `(4096)` suffix is parsed and stripped. */
  readonly alias?: string
  /** `is-compat` models replay assistant reasoning as unsigned thinking blocks. */
  readonly isCompat?: boolean
  /** Thinking capability block (`min`/`max` budget window or `levels`). */
  readonly thinking?: { readonly min?: number; readonly max?: number; readonly levels?: readonly string[] }
}

/** One `claude-api-key` credential entry. */
export interface Oai2ClaCredential {
  readonly apiKey: string
  readonly baseUrl: string
  /** Credential-level static header map (subject to the streaming claw-back). */
  readonly headers?: Readonly<Record<string, string>>
  /** `fingerprint-profile: claude-code-cli` switches to the CLI wire identity. */
  readonly fingerprintProfile?: 'claude-code-cli'
  readonly models: readonly Oai2ClaModelEntry[]
}

export interface Oai2ClaServiceOptions {
  /** claude-api-key entries, config order. */
  readonly credentials: readonly Oai2ClaCredential[]
  /** Gateway version for the `CLIProxyAPI/<version>` user-agent fallback. */
  readonly gatewayVersion: string
  /** All persistent state (credential cooldowns) flows through the Store. */
  readonly store: Store
  /** Epoch-milliseconds clock; drives every timing decision. */
  readonly now?: () => number
  /** Upstream attempts per request beyond the first (0 in every S2d3 fixture). */
  readonly requestRetry?: number
  /**
   * Transient-error cooldown window in seconds; -1 disables it. The S2d3
   * slice pins only the 429 rate-limit cooldown, which this switch does NOT
   * disable (wire-note hard pin), so the option is recorded but not
   * consulted here.
   */
  readonly transientErrorCooldownSeconds?: number
}

/** Downstream (client-facing) request as received by the route. */
export interface Oai2ClaChatRequest {
  readonly method: string
  readonly path: string
  readonly headers: HeaderList
  readonly body: string
}

/** Upstream request the executor would transmit. */
export interface Oai2ClaUpstreamRequest {
  readonly method: string
  /** Absolute URL; the path always carries `?beta=true` (S2d3 2.2). */
  readonly url: string
  readonly headers: HeaderList
  readonly body: string
}

/** Upstream response as produced by the injected transport. */
export interface Oai2ClaUpstreamResponse {
  readonly status: number
  readonly headers: HeaderList
  /**
   * 2xx bodies are SSE bytes; anything else is raw bytes. A read that
   * rejects mid-body models an upstream disconnect.
   */
  readonly body: ReadableStream<Uint8Array>
}

/** Transport callback owned by the runtime/executor layer. */
export type Oai2ClaUpstreamSender = (request: Oai2ClaUpstreamRequest) => Promise<Oai2ClaUpstreamResponse>

/** Downstream response: plain bytes for JSON, a pull-driven stream for SSE. */
export interface Oai2ClaChatResponse {
  readonly status: number
  readonly headers: HeaderList
  readonly body: string | ReadableStream<Uint8Array>
}

export interface Oai2ClaChatService {
  handleChatCompletions(request: Oai2ClaChatRequest, send: Oai2ClaUpstreamSender): Promise<Oai2ClaChatResponse>
}

const COOLDOWN_NAMESPACE = 'oai2cla'
const COOLDOWN_KEY_PREFIX = 'credential-cooldown:'
const PROVIDER = 'claude'

/** Stored cooldown record (persisted as a JSON document). */
interface CooldownRecord {
  readonly untilMs: number
  readonly resetSeconds: number
  readonly lastError: string
}

interface AttemptOutcome {
  readonly retryable: boolean
  readonly response: Oai2ClaChatResponse
}

/** Builds the facade. The service holds no state; cooldowns live in the Store. */
export function createOai2ClaChatService(options: Oai2ClaServiceOptions): Oai2ClaChatService {
  const credentials = options.credentials
  const now = options.now ?? (() => Date.now())
  const maxAttempts = Math.max(0, Math.floor(options.requestRetry ?? 0)) + 1
  const nowSeconds = (): number => Math.floor(now() / 1000)

  return {
    async handleChatCompletions(request, send): Promise<Oai2ClaChatResponse> {
      const requestObject = parseClientBody(request.body)
      if (requestObject === undefined) return jsonBody(400, invalidRequestEnvelope())

      const rawModel = typeof requestObject['model'] === 'string' ? requestObject['model'] : ''
      const suffix = parseModelSuffix(rawModel)
      const requestedModel = suffix !== undefined ? suffix.base : rawModel
      const clientStream = requestObject['stream'] === true

      const candidates: Array<{
        credentialIndex: number
        credential: Oai2ClaCredential
        entry: Oai2ClaModelEntry
      }> = []
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
      if (candidates.length === 0) return jsonBody(400, unknownProviderEnvelope(rawModel))

      let lastCooldown: CooldownRecord | undefined
      let attempts = 0
      for (const candidate of candidates) {
        const record = await readCooldown(options.store, candidate.credentialIndex)
        if (record !== undefined && now() < record.untilMs) {
          lastCooldown = record
          continue
        }
        attempts += 1
        const outcome = await attemptWithCandidate(candidate, request, clientStream, send)
        if (!outcome.retryable || attempts >= maxAttempts) return outcome.response
        // request-retry: fall through to the next credential for retryable
        // upstream failures (429 / empty stream / transport failure).
      }
      if (lastCooldown !== undefined) {
        const cooldown = buildModelCooldownResponse({
          model: rawModel,
          provider: PROVIDER,
          lastUpstreamError: lastCooldown.lastError,
          resetSeconds: lastCooldown.resetSeconds,
        })
        return jsonBody(cooldown.status, cooldown.body, [['Retry-After', cooldown.retryAfter]])
      }
      return jsonBody(500, serverErrorEnvelope('no credential available for the requested model'))
    },
  }

  async function attemptWithCandidate(
    candidate: { credentialIndex: number; credential: Oai2ClaCredential; entry: Oai2ClaModelEntry },
    request: Oai2ClaChatRequest,
    clientStream: boolean,
    send: Oai2ClaUpstreamSender,
  ): Promise<AttemptOutcome> {
    const identity =
      candidate.credential.fingerprintProfile === 'claude-code-cli' ? await newCliIdentity() : undefined
    const translated = await translateChatToClaude(request.body, {
      upstreamModel: candidate.entry.name,
      thinking: thinkingCapability(candidate.entry.thinking),
      compat: candidate.entry.isCompat === true,
      fingerprintProfile: candidate.credential.fingerprintProfile,
      cliIdentity: identity,
    })
    const headers = buildClaudeUpstreamHeaders({
      clientHeaders: headerListToRecord(request.headers),
      apiKey: candidate.credential.apiKey,
      baseUrl: candidate.credential.baseUrl,
      gatewayVersion: options.gatewayVersion,
      credentialHeaders: candidate.credential.headers,
      fingerprintProfile: candidate.credential.fingerprintProfile,
      cliIdentity: identity,
      body: translated.value,
    })
    const url = joinUrl(candidate.credential.baseUrl)
    let upstream: Oai2ClaUpstreamResponse
    try {
      upstream = await send({
        method: 'POST',
        url,
        headers: orderUpstreamHeaders(headers, url, translated.body),
        body: translated.body,
      })
    } catch {
      return unexpectedEof()
    }

    if (upstream.status >= 200 && upstream.status < 300) {
      return clientStream
        ? await streamOutcome(upstream, candidate.entry.name)
        : await aggregateOutcome(upstream, candidate.entry.name)
    }

    let bodyText: string
    try {
      bodyText = await readAll(upstream.body)
    } catch {
      return unexpectedEof()
    }
    // The downstream surface is rendered before any cooldown bookkeeping:
    // the verbatim-429 pass-through above all must survive a Store failure,
    // so the write below can never reject this response.
    const rendered = renderUpstreamFailure(classifyClaudeUpstreamError(upstream.status, bodyText))
    const outcome: AttemptOutcome = {
      retryable: upstream.status === 429,
      response: jsonBody(rendered.status, rendered.body),
    }
    if (upstream.status === 429) {
      // Rate-limit cooldown (S2d3 5.4): headerless 429s cool for a flat
      // second, reset-carrying headers for the parsed reset plus a bounded
      // random grace. transient-error-cooldown-seconds does not disable this.
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
   * Stream clients: the bootstrap gate commits SSE headers only after the
   * first translated chunk; an empty upstream becomes the pre-commit 500.
   */
  async function streamOutcome(upstream: Oai2ClaUpstreamResponse, streamModel: string): Promise<AttemptOutcome> {
    try {
      const bootstrap = await bootstrapChatChunkStream(readableToAsyncIterable(upstream.body), {
        streamModel,
        nowSeconds,
      })
      if (bootstrap.kind === 'empty-stream') {
        const failure = renderEmptyStreamFailure()
        return {
          retryable: true,
          response: jsonBody(failure.status, failure.body),
        }
      }
      return {
        retryable: false,
        response: {
          status: 200,
          // The SSE commit set in the recorded emission order (T4 F2):
          // Cache-Control, then Connection, then Content-Type.
          headers: [
            ['Cache-Control', 'no-cache'],
            ['Connection', 'keep-alive'],
            ['Content-Type', 'text/event-stream'],
          ],
          body: framesToReadable(bootstrap.firstFrame, bootstrap.rest),
        },
      }
    } catch {
      return unexpectedEof()
    }
  }

  /** Non-stream clients: aggregate, validate, render one chat.completion. */
  async function aggregateOutcome(upstream: Oai2ClaUpstreamResponse, streamModel: string): Promise<AttemptOutcome> {
    let buffer: string
    try {
      buffer = await readAll(upstream.body)
    } catch {
      return unexpectedEof()
    }
    const result = translateClaudeBufferToChatCompletion(buffer, { streamModel, nowSeconds })
    if (result.kind === 'ok') return { retryable: false, response: jsonBody(200, result.body) }
    const rendered = renderValidationFailure(result.message)
    return { retryable: false, response: jsonBody(rendered.status, rendered.body) }
  }

  /** Pre-commit transport failure: plain 500 envelope (S2d3 5.2). */
  function unexpectedEof(): AttemptOutcome {
    const failure = renderUnexpectedEofFailure()
    return { retryable: true, response: jsonBody(failure.status, failure.body) }
  }

  async function newCliIdentity(): Promise<ClaudeCodeCliIdentity> {
    const sessionId = crypto.randomUUID()
    const accountUuid = crypto.randomUUID()
    const date = new Date(now()).toISOString().slice(0, 10)
    return { sessionId, accountUuid, deviceId: await sha256Hex(sessionId), date }
  }
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
 * Persists a rate-limit cooldown through the Store's atomic read-modify-
 * write: the callback derives the replacement from the current record
 * alone and may re-run when a competing writer commits first. A still-
 * longer window already stored for the credential is never shortened, so
 * concurrent 429s cannot overwrite each other's cooldown; a sequential
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
// Header list assembly (pinned emission order)
// ---------------------------------------------------------------------------

/** Go-style MIME canonicalization: `x-stainless-lang` -> `X-Stainless-Lang`. */
function canonicalHeaderName(name: string): string {
  return name
    .split('-')
    .map((part) => (part.length === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join('-')
}

function headerListToRecord(list: HeaderList): Record<string, string> {
  const record: Record<string, string> = {}
  for (const [name, value] of list) record[name] = value
  return record
}

function joinUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, '')}/v1/messages?beta=true`
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

/**
 * Emission order pinned by the recorded wire log: Host, User-Agent and
 * Content-Length first, the remaining names in ASCII order.
 */
function orderUpstreamHeaders(map: Readonly<Record<string, string>>, url: string, body: string): HeaderList {
  const merged: Record<string, string> = {}
  for (const [name, value] of Object.entries(map)) merged[canonicalHeaderName(name)] = value
  delete merged['Host']
  const rest = Object.keys(merged)
    .filter((name) => name !== 'User-Agent' && name !== 'Content-Length')
    .sort()
    .map((name) => [name, merged[name] ?? ''] as [string, string])
  return [
    ['Host', hostOf(url)],
    ['User-Agent', merged['User-Agent'] ?? ''],
    ['Content-Length', String(new TextEncoder().encode(body).length)],
    ...rest,
  ]
}

// ---------------------------------------------------------------------------
// Byte plumbing (Web Standard APIs only)
// ---------------------------------------------------------------------------

function parseClientBody(body: string): Record<string, unknown> | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  return parsed as Record<string, unknown>
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

// ---------------------------------------------------------------------------
// Downstream envelopes (this direction owns its error shapes)
// ---------------------------------------------------------------------------

function serializeError(message: string, type: string, code?: string, param?: string): string {
  const error: Record<string, string> = { message, type }
  if (code !== undefined) error['code'] = code
  if (param !== undefined) error['param'] = param
  return serializeOrdered({ error })
}

function jsonBody(status: number, body: string, extraHeaders: HeaderList = []): Oai2ClaChatResponse {
  const headers: Array<[string, string]> = [['Content-Type', 'application/json']]
  for (const [name, value] of extraHeaders) headers.push([name, value])
  return { status, headers, body }
}

function invalidRequestEnvelope(): string {
  return serializeError('Invalid request: malformed JSON body', 'invalid_request_error')
}

function unknownProviderEnvelope(model: string): string {
  return serializeError(`unknown provider for model ${model}`, 'invalid_request_error', 'model_not_found', 'model')
}

function serverErrorEnvelope(message: string): string {
  return serializeError(message, 'server_error', 'internal_server_error')
}

/** `models[].thinking` config -> translator capability descriptor. */
function thinkingCapability(
  config: { readonly min?: number; readonly max?: number; readonly levels?: readonly string[] } | undefined,
):
  | { readonly kind: 'budget'; readonly min: number; readonly max: number }
  | { readonly kind: 'levels'; readonly levels: readonly string[] }
  | undefined {
  if (config === undefined) return undefined
  if (config.levels !== undefined && config.levels.length > 0) {
    return { kind: 'levels', levels: config.levels }
  }
  if (typeof config.min === 'number' || typeof config.max === 'number') {
    return { kind: 'budget', min: config.min ?? 0, max: config.max ?? 0 }
  }
  return undefined
}
