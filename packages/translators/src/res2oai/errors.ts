/**
 * Error semantics for the res2oai direction (S2d6 section 5).
 *
 * - Non-stream upstream HTTP errors pass downstream with their status and
 *   body VERBATIM when the body is valid JSON (recorded: the 429 body
 *   arrives byte-identical, spacing included); non-JSON bodies keep the
 *   status and wrap into the OpenAI-shaped envelope.
 * - Stream requests whose upstream fails BEFORE the first translated frame
 *   answer with a JSON error (never SSE): the upstream error object is
 *   re-marshaled compact with alphabetically sorted keys (recorded key-sort
 *   pin); statuses outside 400..599 normalize to 500.
 * - In-stream failures (after >= 1 data frame) append ONE terminal frame
 *   after a leading `\n`: `event: error` for normal clients,
 *   `event: response.failed` for Codex-looking clients (User-Agent /
 *   Originator detection). The error detail marshals with sorted keys.
 * - A clean upstream close without `data: [DONE]` fails Responses clients
 *   in-stream ("upstream stream closed before [DONE]").
 * - An upstream stream that produced ZERO translatable frames fails
 *   pre-commit through the conductor `empty_stream` gate (500 JSON).
 * - A 429 puts the credential into a ~1s rate-limit cooldown that
 *   `transient-error-cooldown-seconds: -1` does NOT disable; the next
 *   request inside the window answers with the 500 `model_cooldown` shape.
 */
import { sanitizeUpstreamErrorSummary } from '@cpa-edge/core'
import { isPlainObject, isValidJson, marshalSorted, parseLeadingJson, serializeOrdered, wireValueOf } from './json'
import type { WireObject } from './json'
import { RawJson } from './json'

/** Pinned transport-failure message (recorded: hard close mid-stream). */
export const UNEXPECTED_EOF_MESSAGE = 'unexpected EOF'

/** Exact message of the pre-commit empty-stream conductor gate. */
export const EMPTY_STREAM_MESSAGE = 'empty_stream: upstream stream closed before first payload'

/** In-stream failure message for a clean close that never sent `[DONE]`. */
export const CLOSED_BEFORE_DONE_MESSAGE = 'upstream stream closed before [DONE]'

/** In-stream failure message template when no terminal event was seen. */
export function closeErrorText(lastEvent: string): string {
  return `upstream stream closed before a terminal event (last event: ${lastEvent})`
}

// ---------------------------------------------------------------------------
// OpenAI-shaped envelopes (this surface's error bodies)
// ---------------------------------------------------------------------------

/** Ordered error envelope: message, type, then optional code/param. */
export function buildErrorEnvelopeBody(message: string, type: string, code?: string, param?: string): string {
  const error: WireObject = { message, type }
  if (code !== undefined) error['code'] = code
  if (param !== undefined) error['param'] = param
  return serializeOrdered({ error })
}

/** Plain-string error body of the gateway-key gate (recorded 401 family). */
export function buildPlainErrorBody(message: string): string {
  return serializeOrdered({ error: message })
}

/** Malformed-body rejection (NE-LENIENT strict boundary). */
export function buildMalformedBodyEnvelope(): string {
  return buildErrorEnvelopeBody('Invalid request: malformed JSON body', 'invalid_request_error')
}

/** Compact + stream rejection (recorded shape, no code field). */
export function buildCompactStreamRejectedEnvelope(): string {
  return buildErrorEnvelopeBody('Streaming not supported for compact responses', 'invalid_request_error')
}

/** Model-not-found rejection; the model string embeds JSON-escaped. */
export function buildModelNotFoundEnvelope(model: string): string {
  return buildErrorEnvelopeBody(
    `unknown provider for model ${model}`,
    'invalid_request_error',
    'model_not_found',
    'model',
  )
}

const STATUS_TEXTS: Readonly<Record<number, string>> = Object.freeze({
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  408: 'Request Timeout',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
})

function statusText(status: number): string {
  return STATUS_TEXTS[status] ?? `HTTP ${status}`
}

/** Status -> (type, code) mapping of the wrapped non-stream envelope. */
export function wrapTypeForStatus(status: number): { readonly type: string; readonly code?: string } {
  if (status === 401) return { type: 'authentication_error', code: 'invalid_api_key' }
  if (status === 403) return { type: 'permission_error', code: 'insufficient_quota' }
  if (status === 429) return { type: 'rate_limit_error', code: 'rate_limit_exceeded' }
  if (status === 404) return { type: 'invalid_request_error', code: 'model_not_found' }
  if (status >= 500) return { type: 'server_error', code: 'internal_server_error' }
  return { type: 'invalid_request_error' }
}

/** Classified failure of an upstream non-2xx response. */
export type UpstreamFailure =
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
 * with their status and bytes VERBATIM (recorded 429 pin); anything else
 * keeps the status and wraps into the OpenAI-shaped envelope.
 */
export function classifyUpstreamError(status: number, body: string): UpstreamFailure {
  const trimmed = body.trim()
  if (trimmed.length > 0 && isValidJson(trimmed)) {
    return { kind: 'verbatim', status, body }
  }
  const wrap = wrapTypeForStatus(status)
  const message = trimmed.length > 0 ? trimmed : statusText(status)
  return { kind: 'wrapped', status, message, type: wrap.type, code: wrap.code }
}

/** Renders a classified failure as the downstream status + body bytes. */
export function renderUpstreamFailure(failure: UpstreamFailure): { readonly status: number; readonly body: string } {
  if (failure.kind === 'verbatim') return { status: failure.status, body: failure.body }
  return { status: failure.status, body: buildErrorEnvelopeBody(failure.message, failure.type, failure.code) }
}

/** Pre-commit transport failure of a stream request (plain 500 envelope). */
export function renderUnexpectedEofFailure(): { readonly status: number; readonly body: string } {
  return {
    status: 500,
    body: buildErrorEnvelopeBody(UNEXPECTED_EOF_MESSAGE, 'server_error', 'internal_server_error'),
  }
}

/** Pre-commit conductor gate for an upstream that produced no frame (500 JSON). */
export function renderEmptyStreamFailure(): { readonly status: number; readonly body: string } {
  return {
    status: 500,
    body: buildErrorEnvelopeBody(EMPTY_STREAM_MESSAGE, 'server_error', 'internal_server_error'),
  }
}

// ---------------------------------------------------------------------------
// Stream pre-frame sanitizer (S2d6 5.1)
// ---------------------------------------------------------------------------

/** Header names whose values never survive the stream-error sanitizer. */
const SENSITIVE_KEY_SUFFIXES: readonly string[] = Object.freeze([
  'api_key',
  'apikey',
  'authorization',
  'credential',
  'credentials',
  'key',
  'password',
  'secret',
  'token',
])

const REDACTED = '[REDACTED]'
const VALUE_TRUNCATION = 2048

function isSensitiveKey(name: string): boolean {
  const lower = name.toLowerCase()
  return SENSITIVE_KEY_SUFFIXES.includes(lower)
}

/**
 * Sanitizes one error detail: sensitive keys redact, string values truncate
 * at 2048 characters, and the whole object re-marshals with sorted keys.
 */
export function sanitizeErrorDetail(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length > VALUE_TRUNCATION ? value.slice(0, VALUE_TRUNCATION) : value
  }
  if (Array.isArray(value)) return value.map((element) => sanitizeErrorDetail(element))
  if (!isPlainObject(value)) return value
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) {
    if (isSensitiveKey(key)) {
      out[key] = REDACTED
      continue
    }
    const member = value[key]
    if (member === undefined) continue
    out[key] = sanitizeErrorDetail(member)
  }
  return out
}

/**
 * Body of a pre-frame stream upstream failure: the `error` (or
 * `response.error`) object of a JSON body is extracted and re-marshaled
 * compact with sorted keys; every other body becomes `{"error":{"message":...}}`.
 */
export function sanitizeInitialStreamError(body: string): string {
  const parsed = parseLeadingJson(body)
  if (isPlainObject(parsed)) {
    const error = parsed['error'] ?? (isPlainObject(parsed['response']) ? parsed['response']['error'] : undefined)
    if (error !== undefined && error !== null) {
      return serializeOrdered({ error: wireValueOf(sanitizeErrorDetail(error)) })
    }
  }
  const trimmed = body.trim()
  const message = trimmed.length > 0 ? trimmed : statusText(500)
  return serializeOrdered({ error: { message: truncated(message) } })
}

function truncated(text: string): string {
  return text.length > VALUE_TRUNCATION ? text.slice(0, VALUE_TRUNCATION) : text
}

/** Status normalization of the pre-frame branch: outside 400..599 becomes 500. */
export function normalizeErrorStatus(status: number): number {
  if (status < 400 || status > 599) return 500
  return status
}

// ---------------------------------------------------------------------------
// In-stream terminal frames (S2d6 5.2)
// ---------------------------------------------------------------------------

/** Status -> (type, code) mapping of the in-stream error detail. */
export function streamErrorTypeForStatus(status: number): { readonly type: string; readonly code: string } {
  if (status === 401) return { type: 'invalid_request_error', code: 'invalid_api_key' }
  if (status === 403) return { type: 'invalid_request_error', code: 'insufficient_quota' }
  if (status === 429) return { type: 'invalid_request_error', code: 'rate_limit_exceeded' }
  if (status === 404) return { type: 'invalid_request_error', code: 'model_not_found' }
  if (status === 408) return { type: 'invalid_request_error', code: 'request_timeout' }
  if (status >= 500) return { type: 'server_error', code: 'internal_server_error' }
  return { type: 'invalid_request_error', code: 'invalid_request_error' }
}

/** Failure description of an in-stream error frame. */
export interface StreamFailure {
  /** Serialized error detail (already sorted-key marshaled). */
  readonly detail: string
  /** Transport-facing status classification (502 for the no-[DONE] rule). */
  readonly status: number
}

/** Builds the failure of a status-classified in-stream error (sorted keys). */
export function statusStreamFailure(message: string, status: number): StreamFailure {
  const mapped = streamErrorTypeForStatus(status)
  const detail: WireObject = {
    type: mapped.type,
    code: mapped.code,
    message,
    param: null,
  }
  return { detail: marshalSorted(detail), status }
}

/** Builds the failure of an upstream error payload (detail embeds it). */
export function upstreamStreamFailure(errorObject: unknown): StreamFailure {
  return { detail: marshalSorted(sanitizeErrorDetail(errorObject)), status: 502 }
}

/**
 * Terminal wire frame written after a post-commit failure: one leading
 * `\n`, then `event: <failureEvent>\ndata: <chunk>\n\n`. HTTP stays 200.
 * The failure event is `error` for normal clients and `response.failed`
 * for Codex-looking clients.
 */
export function formatTerminalErrorFrame(failureEvent: 'error' | 'response.failed', failure: StreamFailure, sequenceNumber: number): string {
  if (failureEvent === 'response.failed') {
    const chunk = serializeOrdered({
      type: 'response.failed',
      sequence_number: sequenceNumber,
      response: { status: 'failed', error: new RawJson(failure.detail) },
    })
    return `\nevent: response.failed\ndata: ${chunk}\n\n`
  }
  const chunk = serializeOrdered({
    type: 'error',
    error: new RawJson(failure.detail),
    sequence_number: sequenceNumber,
  })
  return `\nevent: error\ndata: ${chunk}\n\n`
}

// ---------------------------------------------------------------------------
// Codex client detection (S2d6 5.2)
// ---------------------------------------------------------------------------

/** Originator values that mark a Codex client (prefix match, case-insensitive). */
const CODEX_ORIGINATORS: readonly string[] = Object.freeze(['codex desktop', 'codex-tui', 'codex_cli_rs'])

/**
 * True when the downstream request looks like a Codex client: the
 * User-Agent matches the Codex patterns, or `Originator` prefix-matches
 * one of the known values (case-insensitive).
 */
export function isCodexClient(headers: Readonly<Record<string, string>>): boolean {
  const userAgent = readHeader(headers, 'user-agent')
  if (userAgent !== undefined && /codex/i.test(userAgent)) return true
  const originator = readHeader(headers, 'originator')
  if (originator !== undefined) {
    const lower = originator.toLowerCase()
    for (const candidate of CODEX_ORIGINATORS) {
      if (lower.startsWith(candidate)) return true
    }
  }
  return false
}

function readHeader(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  const lower = name.toLowerCase()
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key]
  }
  return undefined
}

// ---------------------------------------------------------------------------
// 429 -> credential rate-limit cooldown (S2d6 5.1)
// ---------------------------------------------------------------------------

/** Flat rate-limit cooldown window of a 429 (recorded ~1s, headerless). */
export const RATE_LIMIT_COOLDOWN_MS = 1000

/** Rendered cooldown response for the next request inside the window. */
export function buildModelCooldownResponse(input: {
  readonly model: string
  readonly provider: string
  readonly lastUpstreamError: string
}): { readonly status: 500; readonly body: string } {
  const summary = sanitizeUpstreamErrorSummary(input.lastUpstreamError)
  const error: WireObject = {
    code: 'model_cooldown',
    last_upstream_error: input.lastUpstreamError,
    message: `All credentials for model ${input.model} are cooling down via provider ${input.provider} (last error: ${summary})`,
  }
  return { status: 500, body: serializeOrdered({ error }) }
}
