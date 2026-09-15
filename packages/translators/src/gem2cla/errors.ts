/**
 * Error semantics for the gem2cla direction (S2d7 section 5).
 *
 * - Upstream non-2xx responses pass downstream with their status VERBATIM
 *   and their body untouched when it is valid JSON (recorded: S2d7-10 -
 *   the Claude 429 body arrives byte-identical). Non-JSON bodies keep the
 *   status and wrap into the gateway server-error envelope.
 * - The aggregation validator's failures render as 502 envelopes; the
 *   pre-first-chunk empty upstream renders as the retryable 500
 *   `empty_stream` gate BEFORE any SSE header is committed (S2d7-30).
 * - A mid-stream transport failure after commit emits ONE terminal
 *   `event: error` frame with the pinned "unexpected EOF" message; the
 *   same failure before commit renders as a plain 500 envelope.
 * - The 429 -> credential rate-limit cooldown pins the `model_cooldown`
 *   envelope (alphabetical fields) plus `Retry-After: 1` for headerless
 *   429s; `transient-error-cooldown-seconds: -1` does not disable it.
 */
import { isValidJson, serializeOrdered } from './json'
import type { WireObject } from './types'

/** Pinned message for upstream transport failures (recorded: hard close). */
export const UNEXPECTED_EOF_MESSAGE = 'unexpected EOF'

/** Exact message of the pre-commit empty-stream conductor gate. */
export const EMPTY_STREAM_MESSAGE = 'empty_stream: upstream stream closed before first payload'

/** Ordered error envelope body: message, type, then optional code/param. */
export function buildErrorEnvelopeBody(message: string, type: string, code?: string, param?: string): string {
  const error: WireObject = { message, type }
  if (code !== undefined) error['code'] = code
  if (param !== undefined) error['param'] = param
  return serializeOrdered({ error })
}

/** Plain-string error body used by the gateway-key gate (recorded S2d7-00). */
export function buildPlainErrorBody(message: string): string {
  return serializeOrdered({ error: message })
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

/** Classified failure of an upstream non-2xx response. */
export type ClaudeUpstreamFailure =
  | { readonly kind: 'verbatim'; readonly status: number; readonly body: string }
  | {
      readonly kind: 'wrapped'
      readonly status: number
      readonly message: string
      readonly type: string
      readonly code?: string
    }

/**
 * Classifies an upstream non-2xx response: valid-JSON bodies pass through
 * with their status and bytes verbatim (recorded: S2d7-10); anything else
 * keeps the status and wraps into the gateway server-error envelope.
 */
export function classifyClaudeUpstreamError(status: number, body: string): ClaudeUpstreamFailure {
  const trimmed = body.trim()
  if (trimmed.length > 0 && isValidJson(trimmed)) {
    return { kind: 'verbatim', status, body }
  }
  const message = trimmed.length > 0 ? trimmed : statusText(status)
  return { kind: 'wrapped', status, message, type: 'server_error', code: 'internal_server_error' }
}

/** Renders a classified failure as the downstream status + body bytes. */
export function renderUpstreamFailure(failure: ClaudeUpstreamFailure): {
  readonly status: number
  readonly body: string
} {
  if (failure.kind === 'verbatim') return { status: failure.status, body: failure.body }
  return { status: failure.status, body: buildErrorEnvelopeBody(failure.message, failure.type, failure.code) }
}

/** 502 envelope for aggregation-validation failures (S2d7 5.2). */
export function renderValidationFailure(message: string): { readonly status: number; readonly body: string } {
  return { status: 502, body: buildErrorEnvelopeBody(message, 'server_error', 'internal_server_error') }
}

/** 500 envelope for transport failures that never reached a chunk. */
export function renderUnexpectedEofFailure(): { readonly status: number; readonly body: string } {
  return {
    status: 500,
    body: buildErrorEnvelopeBody(UNEXPECTED_EOF_MESSAGE, 'server_error', 'internal_server_error'),
  }
}

/** Rendered pre-commit failure of an upstream that produced no chunk (S2d7-30). */
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

/**
 * Terminal wire frame written after a post-commit transport failure: an
 * `event: error` block with the Gemini-shaped server-error payload. The
 * stream ends after it (HTTP stays 200).
 */
export function formatTerminalErrorFrame(message: string): string {
  const payload = buildErrorEnvelopeBody(message, 'server_error', 'internal_server_error')
  return `event: error\ndata: ${payload}\n\n`
}

// ---------------------------------------------------------------------------
// 429 -> credential cooldown (rate-limit slice of S2d7 5.1)
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
 * Only plain decimal digits count; an unusable value in the first header
 * still lets the second one speak.
 */
export function parseClaudeRateLimitReset(headers: Readonly<Record<string, string>>): number | undefined {
  for (const name of ['retry-after', 'anthropic-ratelimit-unified-reset']) {
    const raw = readHeader(headers, name)
    if (raw === undefined) continue
    const parsed = parseResetSeconds(raw)
    if (parsed !== undefined) return parsed
  }
  return undefined
}

/** Strict unsigned-integer parse of one header value; rejects every other form. */
function parseResetSeconds(raw: string): number | undefined {
  if (!/^[0-9]+$/.test(raw)) return undefined
  const value = Number(raw)
  return Number.isSafeInteger(value) ? value : undefined
}

const FUZZ_GRACE_MAX = 30

/**
 * Cooldown seconds: the parsed reset plus a bounded random grace (1..30s);
 * headerless 429s cool down for a flat second (recorded: S2d7-19).
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
 * Builds the cooldown surface: status 429, a `Retry-After` header and the
 * alphabetical `model_cooldown` envelope with the verbatim last upstream
 * error (recorded: S2d7-19).
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
