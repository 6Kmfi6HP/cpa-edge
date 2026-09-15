/**
 * Error semantics for the OpenAI-chat -> Claude direction (S2d3 section 5).
 *
 * - Upstream non-2xx responses pass through VERBATIM when their body is
 *   valid JSON, and are wrapped into per-status OpenAI-shaped envelopes
 *   otherwise.
 * - In-stream failures have three shapes: an SSE `error` event (translated
 *   into a chunk, translation continues), a transport failure after commit
 *   (one in-stream error frame, no `[DONE]`), and a transport failure
 *   before commit (a plain HTTP error).
 * - An empty upstream stream fails the stream bootstrap before any header
 *   is committed: HTTP 500 `empty_stream`, retryable.
 * - The 429 -> cooldown interaction pins the `model_cooldown` envelope and
 *   the header-driven `Retry-After` fuzz.
 */
import { serializeOrdered } from './json'
import type { WireObject } from './types'

/** OpenAI-shaped error envelope body, key order message/type/code. */
export function buildErrorEnvelopeBody(message: string, type: string, code?: string): string {
  const error: WireObject = { message, type }
  if (code !== undefined) error['code'] = code
  return serializeOrdered({ error })
}

const STATUS_TEXTS: Readonly<Record<number, string>> = Object.freeze({
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
})

function statusText(status: number): string {
  return STATUS_TEXTS[status] ?? `HTTP ${status}`
}

/** Downstream mapping of a wrapped upstream status (S2d3 section 5.1). */
export function wrapTypeForStatus(status: number): { readonly type: string; readonly code?: string } {
  if (status === 401) return { type: 'authentication_error', code: 'invalid_api_key' }
  if (status === 403) return { type: 'permission_error', code: 'insufficient_quota' }
  if (status === 429) return { type: 'rate_limit_error', code: 'rate_limit_exceeded' }
  if (status === 404) return { type: 'invalid_request_error', code: 'model_not_found' }
  if (status >= 500) return { type: 'server_error', code: 'internal_server_error' }
  return { type: 'invalid_request_error' }
}

/** Classified failure of an upstream non-2xx response. */
export type ClaudeUpstreamFailure =
  | { readonly kind: 'verbatim'; readonly status: number; readonly body: string }
  | { readonly kind: 'wrapped'; readonly status: number; readonly message: string; readonly type: string; readonly code?: string }

/**
 * Classifies an upstream non-2xx response: valid-JSON bodies pass through
 * with their status verbatim; anything else is wrapped per status.
 */
export function classifyClaudeUpstreamError(status: number, body: string): ClaudeUpstreamFailure {
  const trimmed = body.trim()
  if (trimmed.length > 0) {
    try {
      JSON.parse(trimmed)
      return { kind: 'verbatim', status, body }
    } catch {
      // fall through to the wrapped shape
    }
  }
  const wrap = wrapTypeForStatus(status)
  const message = trimmed.length > 0 ? trimmed : statusText(status)
  return { kind: 'wrapped', status, message, type: wrap.type, code: wrap.code }
}

/** Renders a classified failure as the downstream status + body bytes. */
export function renderUpstreamFailure(failure: ClaudeUpstreamFailure): {
  readonly status: number
  readonly body: string
} {
  if (failure.kind === 'verbatim') return { status: failure.status, body: failure.body }
  return { status: failure.status, body: buildErrorEnvelopeBody(failure.message, failure.type, failure.code) }
}

/** 502 envelope for aggregation-validation failures. */
export function renderValidationFailure(message: string): { readonly status: number; readonly body: string } {
  return { status: 502, body: buildErrorEnvelopeBody(message, 'server_error', 'internal_server_error') }
}

/** 500 envelope for a mid-aggregation transport failure (non-stream). */
export function renderUnexpectedEofFailure(): { readonly status: number; readonly body: string } {
  return { status: 500, body: buildErrorEnvelopeBody(UNEXPECTED_EOF_MESSAGE, 'server_error', 'internal_server_error') }
}

/** Pinned message for upstream transport failures (recorded: hard close). */
export const UNEXPECTED_EOF_MESSAGE = 'unexpected EOF'

/** In-stream terminal error frame (transport failure after commit). */
export function formatInStreamErrorFrame(message: string): string {
  const payload = buildErrorEnvelopeBody(message, 'server_error', 'internal_server_error')
  return `data: ${payload}\n\n`
}

/** Exact message of the pre-commit empty-stream bootstrap gate. */
export const EMPTY_STREAM_MESSAGE = 'empty_stream: upstream stream closed before first payload'

/** Rendered pre-commit failure of an upstream that produced no chunk. */
export function renderEmptyStreamFailure(): {
  readonly status: number
  readonly body: string
  readonly retryable: true
} {
  return {
    status: 500,
    body: buildErrorEnvelopeBody(EMPTY_STREAM_MESSAGE, 'server_error', 'internal_server_error'),
    retryable: true,
  }
}

// ---------------------------------------------------------------------------
// 429 -> credential cooldown (scheduling boundary pinned by S2d3 5.4)
// ---------------------------------------------------------------------------

function readHeader(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  const lower = name.toLowerCase()
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key]
  }
  return undefined
}

/**
 * Parses the upstream reset hint: an integer `Retry-After` (seconds) or the
 * unified Anthropic rate-limit reset header. No header means no hint.
 */
export function parseClaudeRateLimitReset(headers: Readonly<Record<string, string>>): number | undefined {
  for (const name of ['retry-after', 'anthropic-ratelimit-unified-reset']) {
    const raw = readHeader(headers, name)
    if (raw === undefined) continue
    const parsed = Number(raw)
    if (Number.isFinite(parsed) && parsed >= 0) return Math.ceil(parsed)
  }
  return undefined
}

const FUZZ_GRACE_MAX = 30

/**
 * Cooldown seconds: the parsed reset plus a bounded random grace (1..30s);
 * headerless 429s cool down for a flat second.
 */
export function parseClaudeRateLimitResetWithFuzz(
  headers: Readonly<Record<string, string>>,
  random: () => number = Math.random,
): number {
  const reset = parseClaudeRateLimitReset(headers)
  if (reset === undefined) return 1
  const grace = 1 + Math.floor(random() * FUZZ_GRACE_MAX)
  return reset + grace
}

/** Rendered cooldown response for the next request (model_cooldown envelope). */
export interface ModelCooldownResponse {
  readonly status: 429
  readonly retryAfter: string
  readonly body: string
}

/**
 * Builds the cooldown surface (S2d3 section 5.4): status 429, a
 * `Retry-After` header and the alphabetical `model_cooldown` envelope.
 */
export function buildModelCooldownResponse(input: {
  readonly model: string
  readonly provider: string
  readonly lastUpstreamError: string
  readonly resetSeconds: number
}): ModelCooldownResponse {
  const envelope: WireObject = {
    code: 'model_cooldown',
    last_upstream_error: input.lastUpstreamError,
    message: `All credentials for model ${input.model} are cooling down via provider ${input.provider} (last error: ${input.lastUpstreamError})`,
    model: input.model,
    provider: input.provider,
    reset_seconds: input.resetSeconds,
    reset_time: `${input.resetSeconds}s`,
  }
  return { status: 429, retryAfter: String(input.resetSeconds), body: serializeOrdered({ error: envelope }) }
}
