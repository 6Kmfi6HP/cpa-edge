
/**
 * Error semantics of the Codex passthrough (S2d9 sections 5.1-5.4).
 *
 * Upstream HTTP-level failures keep their status but re-serialize their
 * JSON content with alphabetical keys and compact separators - every
 * observed field of the upstream `error` object survives (numbers keep
 * their literal text), modulo the redaction/truncation sanitizers. A few
 * shapes are REWRITTEN instead (401 -> auth_unavailable, context-length
 * overflows, thinking-signature failures, previous_response_not_found),
 * and usage-limit/capacity bodies remap to 429. In-stream failures (an
 * upstream `error`/`response.failed` data frame, or a stream that ends
 * before a terminal event) synthesize ONE terminal frame after the
 * forwarded frames: `event: error` for plain clients,
 * `event: response.failed` for Codex-flavored clients.
 */
import { RawJson, isPlainObject, marshalSorted, scanObjectMembers, serializeOrdered, tryParseJson } from './json'
import type { RawMember, RawSpan, WireObject } from './json'

/** Message of an upstream stream that ended before a terminal event. */
export const STREAM_DISCONNECTED_MESSAGE =
  'stream error: stream disconnected before completion: stream closed before response.completed'

/** Redaction marker the error sanitizers write. */
const REDACTED = '[REDACTED]'

/** String values of sanitized error details truncate at this many runes. */
const DETAIL_STRING_RUNES = 2048

/** Summary truncation bound of the last-upstream-error text. */
const SUMMARY_MAX_RUNES = 256

/** Header names whose values never survive an error detail. */
const SENSITIVE_KEY_NAMES: ReadonlySet<string> = new Set([
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

// ---------------------------------------------------------------------------
// Sanitizers
// ---------------------------------------------------------------------------

/** First `limit` Unicode code points of a text. */
export function truncateRunes(text: string, limit: number): string {
  const runes = Array.from(text)
  return runes.length <= limit ? text : runes.slice(0, limit).join('')
}

/** Truncates one serialized string token at the detail rune bound. */
function truncatedStringToken(token: string): string {
  const parsed = tryParseJson(token)
  if (typeof parsed !== 'string') return token
  if (Array.from(parsed).length <= DETAIL_STRING_RUNES) return token
  return JSON.stringify(truncateRunes(parsed, DETAIL_STRING_RUNES))
}

/** Members of one raw JSON object text (`undefined` when not an object). */
function membersOf(objectText: string): readonly RawMember[] | undefined {
  return scanObjectMembers(objectText, { start: 0, end: objectText.length } satisfies RawSpan)
}

/**
 * Re-marshals one raw JSON object with alphabetically sorted keys while
 * splicing every VALUE token verbatim (numbers keep their literal text),
 * redacting secret-ish members and truncating overlong strings.
 */
function remarshalErrorObject(objectText: string): string | undefined {
  if (!isPlainObject(tryParseJson(objectText))) return undefined
  const members = membersOf(objectText)
  if (members === undefined) return undefined
  const sorted = [...members].sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
  let out = '{'
  for (let i = 0; i < sorted.length; i++) {
    const member = sorted[i]
    if (member === undefined) continue
    if (i > 0) out += ','
    const valueText = objectText.slice(member.valueSpan.start, member.valueSpan.end)
    if (SENSITIVE_KEY_NAMES.has(member.key.toLowerCase())) {
      out += `${JSON.stringify(member.key)}:"${REDACTED}"`
      continue
    }
    if (valueText.startsWith('"')) {
      out += `${JSON.stringify(member.key)}:${truncatedStringToken(valueText)}`
      continue
    }
    if (valueText.startsWith('{') || valueText.startsWith('[')) {
      out += `${JSON.stringify(member.key)}:${remarshalErrorObject(valueText) ?? valueText}`
      continue
    }
    out += `${JSON.stringify(member.key)}:${valueText}`
  }
  return out + '}'
}

/**
 * Sanitizes a parsed error detail: sensitive keys redact, strings
 * truncate at the rune bound, keys re-sort on marshal.
 */
export function sanitizeErrorDetail(value: unknown): unknown {
  if (typeof value === 'string') {
    return Array.from(value).length > DETAIL_STRING_RUNES ? truncateRunes(value, DETAIL_STRING_RUNES) : value
  }
  if (Array.isArray(value)) return value.map((element) => sanitizeErrorDetail(element))
  if (!isPlainObject(value)) return value
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) {
    if (SENSITIVE_KEY_NAMES.has(key.toLowerCase())) {
      out[key] = REDACTED
      continue
    }
    const member = value[key]
    if (member === undefined) continue
    out[key] = sanitizeErrorDetail(member)
  }
  return out
}

/** Last-upstream-error summary: cut to 253 runes plus `...`. */
export function sanitizeUpstreamErrorSummary(summary: string): string {
  const runes = Array.from(summary)
  if (runes.length <= SUMMARY_MAX_RUNES) return summary
  return `${runes.slice(0, SUMMARY_MAX_RUNES - 3).join('')}...`
}

// ---------------------------------------------------------------------------
// Upstream HTTP-level classification (5.1)
// ---------------------------------------------------------------------------

/** Classified HTTP-level upstream failure, ready to render. */
export interface UpstreamStatusFailure {
  readonly status: number
  readonly body: string
}

function upstreamErrorObject(bodyText: string): Record<string, unknown> | undefined {
  const parsed = tryParseJson(bodyText)
  if (!isPlainObject(parsed)) return undefined
  const error = parsed['error']
  return isPlainObject(error) ? error : undefined
}

/** Raw text of the body's `error` object value, when present. */
function rawErrorText(bodyText: string): string | undefined {
  const trimmed = bodyText.trim()
  const members = membersOf(trimmed)
  const member = members?.find((entry) => entry.key === 'error')
  if (member === undefined) return undefined
  return trimmed.slice(member.valueSpan.start, member.valueSpan.end)
}

function upstreamErrorMessage(bodyText: string, error: Record<string, unknown> | undefined): string {
  if (error !== undefined && typeof error['message'] === 'string') return error['message'] as string
  const trimmed = bodyText.trim()
  return trimmed
}

/** Content-verbatim re-serialization of the upstream error object. */
function contentVerbatimBody(bodyText: string): string | undefined {
  const source = rawErrorText(bodyText)
  if (source === undefined) return undefined
  const remarshaled = remarshalErrorObject(source)
  if (remarshaled === undefined) return undefined
  return `{"error":${remarshaled}}`
}

/**
 * Classifies an upstream non-2xx response per the 5.1 table: 401 rewrites
 * to the auth_unavailable shape; context-length, thinking-signature and
 * previous_response_not_found bodies rewrite to their fixed codes;
 * usage-limit/capacity bodies remap to 429; everything else keeps the
 * upstream status with the error content re-serialized (alphabetical
 * keys, raw number tokens, sanitized). Non-JSON bodies wrap into the
 * OpenAI envelope.
 */
export function classifyUpstreamStatusError(status: number, bodyText: string): UpstreamStatusFailure {
  const error = upstreamErrorObject(bodyText)
  if (status === 401) {
    const message = upstreamErrorMessage(bodyText, error)
    return {
      status: 401,
      body: serializeOrdered({
        error: { code: 'auth_unavailable', message, type: 'authentication_error' },
      } as WireObject),
    }
  }

  if (isPlainObject(tryParseJson(bodyText))) {
    const parsedError = error ?? {}
    const code = typeof parsedError['code'] === 'string' ? (parsedError['code'] as string) : ''
    const type = typeof parsedError['type'] === 'string' ? (parsedError['type'] as string) : ''
    const message = upstreamErrorMessage(bodyText, error)
    const lowerMessage = message.toLowerCase()

    if (
      code === 'context_length_exceeded' ||
      code === 'context_too_large' ||
      lowerMessage.includes('context_length_exceeded') ||
      lowerMessage.includes('context too large') ||
      status === 413
    ) {
      return {
        status,
        body: serializeOrdered({
          error: { message, type: 'invalid_request_error', code: 'context_too_large' },
        } as WireObject),
      }
    }
    if (lowerMessage.includes('invalid signature in thinking block') || lowerMessage.includes('invalid_encrypted_content')) {
      return {
        status,
        body: serializeOrdered({
          error: { message, type: 'invalid_request_error', code: 'thinking_signature_invalid' },
        } as WireObject),
      }
    }
    if (code === 'previous_response_not_found' || lowerMessage.includes('previous_response_not_found')) {
      return {
        status,
        body: serializeOrdered({
          error: { message, type: 'invalid_request_error', code: 'previous_response_not_found' },
        } as WireObject),
      }
    }
    if (type === 'usage_limit_reached' || lowerMessage.includes('at capacity')) {
      const body = contentVerbatimBody(bodyText)
      return {
        status: 429,
        body:
          body ??
          serializeOrdered({ error: { message, type: 'usage_limit_reached' } } as WireObject),
      }
    }
    const body = contentVerbatimBody(bodyText)
    if (body !== undefined) return { status, body }
  }

  // Non-JSON (or error-less) body: wrap the raw text.
  const trimmed = bodyText.trim()
  const wrapType = status >= 500 ? 'server_error' : 'invalid_request_error'
  const detail: WireObject = { message: trimmed.length > 0 ? trimmed : statusText(status), type: wrapType }
  const code = wrapCodeForStatus(status)
  if (code !== undefined) detail['code'] = code
  return { status, body: serializeOrdered({ error: detail } as WireObject) }
}

function statusText(status: number): string {
  const known: Readonly<Record<number, string>> = {
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    408: 'Request Timeout',
    413: 'Request Entity Too Large',
    429: 'Too Many Requests',
    500: 'Internal Server Error',
    502: 'Bad Gateway',
    503: 'Service Unavailable',
  }
  return known[status] ?? `HTTP ${status}`
}

function wrapCodeForStatus(status: number): string | undefined {
  if (status === 401) return 'invalid_api_key'
  if (status === 403) return 'insufficient_quota'
  if (status === 429) return 'rate_limit_exceeded'
  if (status === 404) return 'model_not_found'
  if (status === 408) return 'request_timeout'
  if (status >= 500) return 'internal_server_error'
  return undefined
}

// ---------------------------------------------------------------------------
// In-stream terminal failures (5.2 / 5.3)
// ---------------------------------------------------------------------------

function stringAt(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  return typeof value === 'string' ? value : ''
}

/**
 * Status an in-stream failure maps to (auth -> 401, not-found -> 404,
 * permission -> 403, rate/usage limit -> 429, invalid request -> 400,
 * everything else -> 502).
 */
export function codexTerminalFailureStatus(payload: Record<string, unknown>): number {
  const haystack =
    `${stringAt(payload, 'type')} ${stringAt(payload, 'code')} ${stringAt(payload, 'message')}`.toLowerCase()
  if (
    haystack.includes('authentication_error') ||
    haystack.includes('invalid_api_key') ||
    haystack.includes('unauthorized')
  ) {
    return 401
  }
  if (haystack.includes('model_not_found') || haystack.includes('not_found')) return 404
  if (haystack.includes('permission') || haystack.includes('insufficient_quota') || haystack.includes('forbidden')) return 403
  if (haystack.includes('rate_limit') || haystack.includes('usage_limit') || haystack.includes('at capacity')) return 429
  if (haystack.includes('invalid_request')) return 400
  return 502
}

/**
 * Detail of an upstream in-stream failure frame: the payload's `error`
 * object when it carries one, else its `response.error` object, else the
 * payload's own fields minus the transport wrappers (`type`,
 * `sequence_number`), sanitized and re-marshaled with sorted keys.
 * `undefined` when nothing usable remains.
 */
export function terminalFailureDetail(payload: Record<string, unknown>): string | undefined {
  const nested = payload['error']
  if (isPlainObject(nested)) return marshalSorted(sanitizeErrorDetail(nested))
  const response = payload['response']
  if (isPlainObject(response)) {
    const responseError = response['error']
    if (isPlainObject(responseError)) return marshalSorted(sanitizeErrorDetail(responseError))
  }
  const rest: Record<string, unknown> = {}
  for (const key of Object.keys(payload)) {
    if (key === 'type' || key === 'sequence_number') continue
    rest[key] = payload[key]
  }
  if (Object.keys(rest).length > 0) return marshalSorted(sanitizeErrorDetail(rest))
  return undefined
}

/**
 * Synthesized detail for failures without upstream error content
 * (disconnects): the status-mapped code/type pair with the message and a
 * null `param`.
 */
export function synthesizedDetailForStatus(status: number, message: string): string {
  const type = status >= 500 ? 'server_error' : 'invalid_request_error'
  const code = wrapCodeForStatus(status) ?? 'invalid_request_error'
  return marshalSorted({ type, code, message, param: null })
}

/**
 * Terminal wire frame written after a post-commit failure: one leading
 * `\n` (a blank line after the last forwarded frame), then
 * `event: <event>\ndata: <chunk>\n\n`. Codex-flavored clients receive
 * `response.failed`; plain clients receive `error`.
 */
export function formatTerminalFailureFrame(
  failureEvent: 'error' | 'response.failed',
  detail: string,
  sequenceNumber: number,
): string {
  if (failureEvent === 'response.failed') {
    const chunk = serializeOrdered({
      type: 'response.failed',
      sequence_number: sequenceNumber,
      response: { status: 'failed', error: new RawJson(detail) },
    } as WireObject)
    return `\nevent: response.failed\ndata: ${chunk}\n\n`
  }
  const chunk = serializeOrdered({
    type: 'error',
    error: new RawJson(detail),
    sequence_number: sequenceNumber,
  } as WireObject)
  return `\nevent: error\ndata: ${chunk}\n\n`
}

/** Plain JSON body of a pre-commit in-stream failure (no SSE headers). */
export function preCommitFailureBody(detail: string): string {
  return `{"error":${detail}}`
}

/** Body of a stream that ended before any forwarded frame (408). */
export function incompleteStreamBody(): string {
  return serializeOrdered({
    error: { message: STREAM_DISCONNECTED_MESSAGE, type: 'invalid_request_error' },
  } as WireObject)
}

// ---------------------------------------------------------------------------
// Gateway-local envelopes (5.4 and the route-owned families)
// ---------------------------------------------------------------------------

/** `model_not_found` body of an unroutable model (fixed literal order). */
export function modelNotFoundBody(model: string): string {
  return serializeOrdered({
    error: {
      message: `unknown provider for model ${model}`,
      type: 'invalid_request_error',
      code: 'model_not_found',
      param: 'model',
    },
  } as WireObject)
}

/** Compact-route `stream: true` rejection body. */
export function compactStreamRejectedBody(): string {
  return serializeOrdered({
    error: { message: 'Streaming not supported for compact responses', type: 'invalid_request_error' },
  } as WireObject)
}

/** Strict-boundary malformed-body envelope (NE-LENIENT). */
export function invalidRequestBody(reason: string): string {
  return serializeOrdered({ error: { message: `Invalid request: ${reason}`, type: 'invalid_request_error' } } as WireObject)
}

/** Auth-gate bodies (S1 family: the error member is a plain string). */
export function missingApiKeyBody(): string {
  return serializeOrdered({ error: 'Missing API key' } as WireObject)
}

export function invalidApiKeyBody(): string {
  return serializeOrdered({ error: 'Invalid API key' } as WireObject)
}

/** Internal fallback when no credential is usable. */
export function serverErrorEnvelope(message: string): string {
  return serializeOrdered({ error: { message, type: 'server_error', code: 'internal_server_error' } } as WireObject)
}

// ---------------------------------------------------------------------------
// Cooldown-window responses (5.1 recorded facts / 9.3)
// ---------------------------------------------------------------------------

/** Renders whole milliseconds the way Go prints a duration. */
export function formatGoDurationMs(ms: number): string {
  if (ms < 1000) {
    const value = Math.max(Math.round(ms), 0)
    return `${value}ms`
  }
  const totalSeconds = Math.round(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h${minutes}m${seconds}s`
  if (minutes > 0) return `${minutes}m${seconds}s`
  return `${seconds}s`
}

/** Rendered cooldown response for the rate-limit family (429 + Retry-After). */
export interface ModelCooldownResponse {
  readonly status: 429
  readonly retryAfter: string
  readonly body: string
}

/**
 * Builds the `model_cooldown` response: HTTP 429 with a `Retry-After` of
 * the remaining seconds and the alphabetical body recorded in S2d9-12.
 */
export function buildModelCooldownResponse(input: {
  readonly model: string
  readonly provider: string
  readonly lastUpstreamError: string
  readonly resetSeconds: number
}): ModelCooldownResponse {
  const resetSeconds = Math.max(1, Math.ceil(input.resetSeconds))
  const summary = sanitizeUpstreamErrorSummary(input.lastUpstreamError)
  const message = `All credentials for model ${input.model} are cooling down via provider ${input.provider} (last error: ${summary})`
  const error: WireObject = {
    code: 'model_cooldown',
    last_upstream_error: input.lastUpstreamError,
    message,
    model: input.model,
    provider: input.provider,
    reset_seconds: resetSeconds,
    reset_time: formatGoDurationMs(resetSeconds * 1000),
  }
  return { status: 429, retryAfter: String(resetSeconds), body: serializeOrdered({ error } as WireObject) }
}

/** Rendered selection-error response for the model-not-found family (503). */
export interface AuthUnavailableResponse {
  readonly status: 503
  readonly body: string
}

/**
 * Builds the enriched `auth_unavailable` selection error of the 404
 * cooldown window (S2d9-18): fixed struct order message/type/code.
 */
export function buildAuthUnavailableResponse(input: {
  readonly providers: readonly string[]
  readonly model: string
  readonly lastUpstreamError: string
}): AuthUnavailableResponse {
  const providers = input.providers.length > 0 ? input.providers.join(',') : 'unknown'
  const model = input.model !== '' ? input.model : 'unknown'
  const summary = sanitizeUpstreamErrorSummary(input.lastUpstreamError)
  const message = `auth_unavailable: no auth available (providers=${providers}, model=${model}; last upstream error: ${summary})`
  return {
    status: 503,
    body: serializeOrdered({ error: { message, type: 'server_error', code: 'internal_server_error' } } as WireObject),
  }
}

// ---------------------------------------------------------------------------
// Codex-client detection (5.2)
// ---------------------------------------------------------------------------

/** Originator values that mark a Codex client (prefix match). */
const CODEX_ORIGINATORS: readonly string[] = Object.freeze(['codex desktop', 'codex-tui', 'codex_cli_rs'])

/**
 * True when the downstream request looks like a Codex client: the
 * User-Agent matches a Codex pattern, or `Originator` prefix-matches one
 * of the known values (case-insensitive, versioned prefixes included).
 */
export function isCodexClient(headers: Readonly<Record<string, string>>): boolean {
  const userAgent = headerValue(headers, 'user-agent')
  if (userAgent !== undefined && /codex/i.test(userAgent)) return true
  const originator = headerValue(headers, 'originator')
  if (originator !== undefined) {
    const lower = originator.toLowerCase()
    for (const candidate of CODEX_ORIGINATORS) {
      if (lower.startsWith(candidate)) return true
    }
  }
  return false
}

function headerValue(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  const lower = name.toLowerCase()
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key]
  }
  return undefined
}
