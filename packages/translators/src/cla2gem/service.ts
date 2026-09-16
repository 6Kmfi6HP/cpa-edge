/**
 * Composed facade for the S2d8 direction: the Claude Messages surface over
 * an injected transport.
 *
 * `createCla2GemService` wires the pure translation core together with the
 * stages the recorded wire pins: the gateway-key gate (S1 shapes), strict
 * request parsing (NE-LENIENT), alias-only model resolution (a request for
 * the upstream name is rejected with 400 `unknown provider for model <m>`
 * and zero upstream dispatch), `:generateContent` / `:streamGenerateContent`
 * / `:countTokens` dispatch with the recorded URL and header contract, the
 * input-token estimate injection into streamed `message_start` events
 * (R-TOK), the SSE commit rule (no headers before the first translated
 * event), the disconnect terminal frame, the Claude error ladder, the 400
 * Claude envelope for translation-stage invalid input (over-deep request
 * JSON included; zero upstream dispatch), and the
 * 429 -> credential rate-limit cooldown slice (state flows exclusively
 * through the injected Store; `transient-error-cooldown-seconds: -1` does
 * not disable it). No transport happens here: the caller supplies `send`,
 * so the same facade runs on every runtime.
 */
import type { JsonValue, Store } from '@cpa-edge/core'
import { CpaError } from '@cpa-edge/core'
import { isPlainObject } from './json'
import {
  buildClaudeErrorEnvelope,
  buildModelCooldownResponse,
  renderUpstreamFailure,
  UNEXPECTED_EOF_MESSAGE,
} from './errors'
import { buildGeminiUpstreamHeaders } from './headers'
import type { HeaderList } from './headers'
import { translateClaudeToGemini } from './request'
import { translateGeminiResponseToClaude } from './response'
import type { GeminiToClaudeContext } from './response'
import { buildToolNameIndex } from './schema'
import type { ToolNameIndex } from './schema'
import { bootstrapCla2GemStream } from './stream'
import { frameDownstream } from './sse'
import { estimateClaudeInputTokens } from './tokens'
import type { Cla2GemContext, Cla2GemThinkingCapability } from './types'

/** Default upstream base when a credential carries none (recorded). */
export const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com'

/** Flat rate-limit cooldown window after an upstream 429 (recorded: ~1s). */
const RATE_LIMIT_COOLDOWN_SECONDS = 1
const COOLDOWN_NAMESPACE = 'cla2gem'
const COOLDOWN_KEY_PREFIX = 'credential-cooldown:'

/** One `models[]` entry of a gemini-api-key credential. */
export interface Cla2GemModelEntry {
  /** Upstream model name (alias target) stamped onto the wire. */
  readonly name: string
  /** Client-facing alias; ONLY the alias routes (recorded routing fact). */
  readonly alias?: string
  /**
   * Thinking capability of the entry. Absent (the recorded config shape)
   * marks a capability-resolved model WITHOUT thinking support: the
   * Stage-2 pass deletes `generationConfig.thinkingConfig` (leaving
   * `"generationConfig":{}` - golden-pinned by S2d8-07/10). `false` says
   * the same thing explicitly. Budget/levels objects mark
   * thinking-capable models (the budget max backs the adaptive-without-
   * effort mapping).
   */
  readonly thinking?: false | { readonly min?: number; readonly max?: number; readonly levels?: readonly string[] }
  /**
   * Marks the entry as user-defined/unresolved: the Stage-1
   * thinkingConfig is kept verbatim and the upstream validates it
   * (section 3.1 thinking row). No golden exercises this path.
   */
  readonly userDefined?: boolean
}

/** One `gemini-api-key` credential entry. */
export interface Cla2GemCredential {
  readonly apiKey: string
  /** Upstream base URL; trailing `/` trimmed, recorded default when absent. */
  readonly baseUrl?: string
  readonly models: readonly Cla2GemModelEntry[]
}

export interface Cla2GemServiceOptions {
  /** Gateway keys accepted via `Authorization: Bearer` or `X-Api-Key`. */
  readonly apiKeys: readonly string[]
  /** gemini-api-key entries, config order. */
  readonly credentials: readonly Cla2GemCredential[]
  /** All persistent state (credential cooldowns) flows through the Store. */
  readonly store: Store
  /** Epoch-milliseconds clock; drives every timing decision. */
  readonly now?: () => number
  /** Upstream attempts per request beyond the first (0 in every fixture). */
  readonly requestRetry?: number
  /**
   * Transient-error cooldown window in seconds; -1 disables it. The S2d8
   * slice pins only the 429 rate-limit cooldown, which this switch does NOT
   * disable (recorded hard pin), so the option is recorded but not
   * consulted here.
   */
  readonly transientErrorCooldownSeconds?: number
}

/** Downstream (client-facing) request as received by the /v1/messages route. */
export interface Cla2GemRequest {
  readonly method: string
  /** `/v1/messages` or `/v1/messages/count_tokens` (query allowed). */
  readonly path: string
  readonly headers: HeaderList
  readonly body: string
}

/** Upstream request the executor would transmit. */
export interface Cla2GemUpstreamRequest {
  readonly method: string
  /** Absolute URL of the recorded scheme (§2.2). */
  readonly url: string
  readonly headers: HeaderList
  readonly body: string
}

/** Upstream response as produced by the injected transport. */
export interface Cla2GemUpstreamResponse {
  readonly status: number
  readonly headers: HeaderList
  /**
   * 2xx stream bodies are SSE bytes; 2xx non-stream bodies are JSON; a
   * read that rejects mid-body models an upstream disconnect.
   */
  readonly body: ReadableStream<Uint8Array>
}

/** Transport callback owned by the runtime/executor layer. */
export type Cla2GemUpstreamSender = (request: Cla2GemUpstreamRequest) => Promise<Cla2GemUpstreamResponse>

/** Downstream response: plain bytes for JSON, a pull-driven stream for SSE. */
export interface Cla2GemResponse {
  readonly status: number
  readonly headers: HeaderList
  readonly body: string | ReadableStream<Uint8Array>
}

export interface Cla2GemService {
  handleV1Messages(request: Cla2GemRequest, send: Cla2GemUpstreamSender): Promise<Cla2GemResponse>
}

/** Stored cooldown record (persisted as a JSON document). */
interface CooldownRecord {
  readonly untilMs: number
  readonly lastError: string
}

interface AttemptOutcome {
  readonly retryable: boolean
  readonly response: Cla2GemResponse
}

/** Normalizes a credential's base URL (trailing `/` trimmed, default). */
function resolveBaseUrl(baseUrl: string | undefined): string {
  const raw = baseUrl !== undefined && baseUrl.length > 0 ? baseUrl : DEFAULT_GEMINI_BASE_URL
  return raw.replace(/\/+$/, '')
}

/** Client-addressable id of a model entry: the alias, else the name. */
function routableId(entry: Cla2GemModelEntry): string {
  return entry.alias !== undefined ? entry.alias : entry.name
}

/** Model-entry capability -> translator descriptor (absent = strip). */
function thinkingCapability(
  entry: Cla2GemModelEntry,
): Cla2GemThinkingCapability | undefined {
  if (entry.userDefined === true) return undefined
  const config = entry.thinking
  if (config === undefined || config === false) return { kind: 'unsupported' }
  if (config.levels !== undefined && config.levels.length > 0) {
    return { kind: 'levels', levels: config.levels }
  }
  if (typeof config.min === 'number' || typeof config.max === 'number') {
    return { kind: 'budget', min: config.min ?? 0, max: config.max ?? 0 }
  }
  return { kind: 'unsupported' }
}

/** Builds the facade. The service holds no state; cooldowns live in the Store. */
export function createCla2GemService(options: Cla2GemServiceOptions): Cla2GemService {
  const credentials = options.credentials
  const now = options.now ?? (() => Date.now())
  const maxAttempts = Math.max(0, Math.floor(options.requestRetry ?? 0)) + 1

  return {
    async handleV1Messages(request, send): Promise<Cla2GemResponse> {
      const route = parseMessagesPath(request.path)
      if (route === undefined || request.method !== 'POST') {
        return { status: 404, headers: [], body: '' }
      }

      const gate = checkGatewayKey(request, options.apiKeys)
      if (gate !== undefined) return gate

      // Recorded S2d8-20: a body that does not parse as a JSON object
      // reads as an empty model and falls into the unknown-provider path
      // (the strict-JSON boundary surfaces as the Claude 400 envelope, not
      // a generic error shape).
      let parsedBody: Record<string, unknown> | undefined
      try {
        const parsed: unknown = JSON.parse(request.body)
        if (isPlainObject(parsed)) parsedBody = parsed
      } catch {
        parsedBody = undefined
      }

      const clientModel =
        parsedBody !== undefined && typeof parsedBody['model'] === 'string'
          ? (parsedBody['model'] as string)
          : ''
      const candidates: Array<{
        readonly credentialIndex: number
        readonly credential: Cla2GemCredential
        readonly entry: Cla2GemModelEntry
      }> = []
      for (let index = 0; index < credentials.length; index++) {
        const credential = credentials[index]
        if (credential === undefined) continue
        for (const entry of credential.models) {
          if (routableId(entry) === clientModel) {
            candidates.push({ credentialIndex: index, credential, entry })
            break
          }
        }
      }
      if (candidates.length === 0) {
        return jsonBody(400, unknownProviderEnvelope(clientModel))
      }

      const streaming = route === 'messages' && parsedBody?.['stream'] === true
      let lastCooldown: CooldownRecord | undefined
      let attempts = 0
      try {
        for (const candidate of candidates) {
          const record = await readCooldown(options.store, candidate.credentialIndex)
          if (record !== undefined && now() < record.untilMs) {
            lastCooldown = record
            continue
          }
          attempts += 1
          const outcome = await attempt(candidate, parsedBody, request, route, streaming, send)
          if (!outcome.retryable || attempts >= maxAttempts) return outcome.response
          // request-retry: fall through to the next credential for retryable
          // upstream failures (429 / pre-commit transport failures).
        }
      } catch (error) {
        // Translation-stage invalid input (malformed JSON, over-deep
        // nesting) renders the Claude 400 envelope; nothing else is
        // masked here.
        if (error instanceof CpaError && error.code === 'invalid-input') {
          return jsonBody(400, buildClaudeErrorEnvelope('invalid_request_error', error.message))
        }
        throw error
      }
      if (lastCooldown !== undefined) {
        const cooldown = buildModelCooldownResponse({
          model: clientModel,
          lastUpstreamError: lastCooldown.lastError,
        })
        return jsonBody(cooldown.status, cooldown.body)
      }
      return jsonBody(500, unexpectedEofEnvelope())
    },
  }

  /** One upstream attempt through a resolved credential. */
  async function attempt(
    candidate: { readonly credentialIndex: number; readonly credential: Cla2GemCredential; readonly entry: Cla2GemModelEntry },
    parsedBody: Record<string, unknown> | undefined,
    request: Cla2GemRequest,
    route: 'messages' | 'count_tokens',
    streaming: boolean,
    send: Cla2GemUpstreamSender,
  ): Promise<AttemptOutcome> {
    const ctx: Cla2GemContext = {
      upstreamModel: candidate.entry.name,
      thinking: thinkingCapability(candidate.entry),
    }
    const translated = translateClaudeToGemini(request.body, ctx, {
      forCountTokens: route === 'count_tokens',
    })
    const toolNames = buildToolNameIndex(translated.requestTools)
    const base = resolveBaseUrl(candidate.credential.baseUrl)
    const action =
      route === 'count_tokens'
        ? 'countTokens'
        : streaming
          ? 'streamGenerateContent?alt=sse'
          : appendAltQuery('generateContent', request.path)
    const url = `${base}/v1beta/models/${candidate.entry.name}:${action}`

    let upstream: Cla2GemUpstreamResponse
    try {
      upstream = await send({
        method: 'POST',
        url,
        headers: buildGeminiUpstreamHeaders({
          apiKey: candidate.credential.apiKey,
          url,
          body: translated.body,
        }),
        body: translated.body,
      })
    } catch {
      return unexpectedEofOutcome()
    }

    if (upstream.status >= 200 && upstream.status < 300) {
      return route === 'count_tokens'
        ? await countTokensOutcome(upstream)
        : streaming
          ? await streamOutcome(upstream, parsedBody, toolNames)
          : await aggregateOutcome(upstream, toolNames)
    }

    let bodyText: string
    try {
      bodyText = await readAll(upstream.body)
    } catch {
      return unexpectedEofOutcome()
    }
    // Render-first: the client-facing response is built before any
    // cooldown bookkeeping, so a failing Store can never reject it.
    const rendered = renderUpstreamFailure(upstream.status, bodyText)
    const outcome: AttemptOutcome = {
      retryable: upstream.status === 429,
      response: jsonBody(rendered.status, rendered.body),
    }
    if (upstream.status === 429) {
      // Rate-limit cooldown: a flat ~1s window (recorded), never disabled
      // by transient-error-cooldown-seconds.
      await persistCooldownBestEffort(options.store, candidate.credentialIndex, {
        untilMs: now() + RATE_LIMIT_COOLDOWN_SECONDS * 1000,
        lastError: bodyText,
      })
    }
    return outcome
  }

  /** Stream clients: commit SSE only after the first translated event. */
  async function streamOutcome(
    upstream: Cla2GemUpstreamResponse,
    parsedBody: Record<string, unknown> | undefined,
    toolNames: ToolNameIndex,
  ): Promise<AttemptOutcome> {
    const inputTokens = parsedBody === undefined ? 0 : estimateClaudeInputTokens(parsedBody)
    try {
      const bootstrap = await bootstrapCla2GemStream(readableToAsyncIterable(upstream.body), {
        inputTokens,
        toolNames,
      })
      if (bootstrap.kind === 'dead') {
        // The upstream ended before any translated event: nothing is
        // committed, so the pinned transport-error surface renders.
        return { retryable: true, response: jsonBody(500, unexpectedEofEnvelope()) }
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
            ['Access-Control-Allow-Origin', '*'],
          ],
          body: framesToReadable(bootstrap.firstFrame, bootstrap.rest),
        },
      }
    } catch {
      return unexpectedEofOutcome()
    }
  }

  /** Non-stream clients: aggregate the body and render one Claude message. */
  async function aggregateOutcome(
    upstream: Cla2GemUpstreamResponse,
    toolNames: ToolNameIndex,
  ): Promise<AttemptOutcome> {
    let bodyText: string
    try {
      bodyText = await readAll(upstream.body)
    } catch {
      return unexpectedEofOutcome()
    }
    const ctx: GeminiToClaudeContext = { upstreamBody: bodyText, toolNames }
    return { retryable: false, response: jsonBody(200, translateGeminiResponseToClaude(ctx)) }
  }

  /**
   * count_tokens: consume the upstream totalTokens (a REAL upstream call).
   * A 2xx body that is not JSON is consumed leniently - the rendered
   * `{"input_tokens":0}` fallback is the spec'd surface - but the parse
   * failure is surfaced on the runtime's global error channel (console
   * fallback) rather than swallowed.
   */
  async function countTokensOutcome(upstream: Cla2GemUpstreamResponse): Promise<AttemptOutcome> {
    let bodyText: string
    try {
      bodyText = await readAll(upstream.body)
    } catch {
      return unexpectedEofOutcome()
    }
    let totalTokens = 0
    try {
      const parsed: unknown = JSON.parse(bodyText)
      if (isPlainObject(parsed) && typeof parsed['totalTokens'] === 'number' && Number.isFinite(parsed['totalTokens'])) {
        totalTokens = parsed['totalTokens'] as number
      }
    } catch (error) {
      if (typeof reportError === 'function') reportError(error)
      else console.error(error)
    }
    const body = JSON.stringify({ input_tokens: totalTokens })
    return { retryable: false, response: jsonBody(200, body) }
  }

  /** Pre-commit transport failure: plain 500 envelope, retryable. */
  function unexpectedEofOutcome(): AttemptOutcome {
    return { retryable: true, response: jsonBody(500, unexpectedEofEnvelope()) }
  }
}

// ---------------------------------------------------------------------------
// Route, key gate and envelopes
// ---------------------------------------------------------------------------

function parseMessagesPath(path: string): 'messages' | 'count_tokens' | undefined {
  const queryless = path.split('?')[0] ?? path
  if (queryless === '/v1/messages') return 'messages'
  if (queryless === '/v1/messages/count_tokens') return 'count_tokens'
  return undefined
}

/**
 * `?$alt=` passthrough (S2d8 2.2): a non-empty `alt`/`$alt` query on the
 * client request is appended to the non-stream URL; `alt=sse` normalizes
 * to empty and never appears.
 */
function appendAltQuery(action: string, clientPath: string): string {
  const queryStart = clientPath.indexOf('?')
  if (queryStart < 0) return action
  const params = new URLSearchParams(clientPath.slice(queryStart + 1))
  const alt = params.get('$alt') ?? params.get('alt') ?? ''
  if (alt.length === 0 || alt === 'sse') return action
  return `${action}?$alt=${alt}`
}

function checkGatewayKey(request: Cla2GemRequest, apiKeys: readonly string[]): Cla2GemResponse | undefined {
  const headers = headerList(request.headers)
  const apiKey = headers('x-api-key')
  const authorization = headers('authorization')
  let presented: string | undefined
  if (apiKey !== undefined && apiKey.length > 0) presented = apiKey
  else if (authorization !== undefined && authorization.startsWith('Bearer ')) {
    presented = authorization.slice('Bearer '.length)
  }
  if (presented === undefined) {
    return jsonBody(401, JSON.stringify({ error: 'Missing API key' }))
  }
  if (!apiKeys.includes(presented)) {
    return jsonBody(401, JSON.stringify({ error: 'Invalid API key' }))
  }
  return undefined
}

function headerList(list: HeaderList): (name: string) => string | undefined {
  return (name: string) => {
    const lower = name.toLowerCase()
    for (const [headerName, value] of list) {
      if (headerName.toLowerCase() === lower) return value
    }
    return undefined
  }
}

function unknownProviderEnvelope(model: string): string {
  // The reference trims the rendered message (recorded: an empty model
  // yields `unknown provider for model` with NO trailing space).
  return buildClaudeErrorEnvelope('invalid_request_error', `unknown provider for model ${model}`.trim())
}

function unexpectedEofEnvelope(): string {
  return buildClaudeErrorEnvelope('api_error', UNEXPECTED_EOF_MESSAGE)
}

function jsonBody(status: number, body: string): Cla2GemResponse {
  return { status, headers: [['Content-Type', 'application/json']], body }
}

// ---------------------------------------------------------------------------
// Cooldown persistence (Store-backed; no other mutable state exists)
// ---------------------------------------------------------------------------

/**
 * Reads the cooldown record. FAIL-OPEN: the gate mirrors the write path's
 * guard class - a Store outage must not invent a cooldown (or reject the
 * request), so a failing read surfaces on the runtime's global error
 * channel (console fallback) and reads as "not cooling".
 */
async function readCooldown(store: Store, credentialIndex: number): Promise<CooldownRecord | undefined> {
  let document: JsonValue | undefined
  try {
    document = await store.get(COOLDOWN_NAMESPACE, `${COOLDOWN_KEY_PREFIX}${credentialIndex}`)
  } catch (error) {
    if (typeof reportError === 'function') reportError(error)
    else console.error(error)
    return undefined
  }
  return cooldownFromDocument(document)
}

/**
 * Best-effort cooldown persistence: by the time this runs the
 * client-facing response is already rendered, so a failing Store must not
 * reject it. The Store error is still surfaced - reported to the
 * runtime's global error channel (falling back to the console where that
 * API is absent) - rather than swallowed.
 */
async function persistCooldownBestEffort(store: Store, credentialIndex: number, record: CooldownRecord): Promise<void> {
  try {
    await store.update(COOLDOWN_NAMESPACE, `${COOLDOWN_KEY_PREFIX}${credentialIndex}`, (current) => {
      const previous = cooldownFromDocument(current)
      // A still-longer window already stored for the credential is never
      // shortened; a sequential write always lands exactly as given.
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

function framesToReadable(
  firstFrame: { readonly kind: 'chunk'; readonly payload: string } | { readonly kind: 'terminal-error'; readonly message: string },
  rest: AsyncIterable<{ readonly kind: 'chunk'; readonly payload: string } | { readonly kind: 'terminal-error'; readonly message: string }>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const iterator = rest[Symbol.asyncIterator]()
  let firstServed = false
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!firstServed) {
        firstServed = true
        controller.enqueue(encoder.encode(frameDownstream(firstFrame)))
        return
      }
      const next = await iterator.next()
      if (next.done === true) {
        controller.close()
        return
      }
      controller.enqueue(encoder.encode(frameDownstream(next.value)))
    },
    async cancel() {
      await iterator.return?.()
    },
  })
}
