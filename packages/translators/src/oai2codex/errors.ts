/**
 * Error semantics for the OpenAI-chat -> Codex direction (S2d5 section 5).
 *
 * - Upstream non-2xx responses are classified first (E8): context-length
 *   failures, auth failures and usage-limit bodies are rewritten before the
 *   passthrough decision; everything else passes through VERBATIM when the
 *   body is valid JSON and is wrapped per status otherwise (E1).
 * - In-stream terminal failures carry the extracted `error` object
 *   verbatim (E3), or surface pre-commit with a derived status (E4).
 * - A stream that ends without a terminal event is the pinned
 *   incomplete-stream error (E5, HTTP 408, no `code`), and an `incomplete`
 *   terminal with zero output is the empty-incomplete error (E6, 502).
 * - An upstream 429 arms the rate-limit cooldown; the next request inside
 *   the window gets the `model_cooldown` envelope (E2) - alphabetical keys,
 *   verbatim `last_upstream_error` truncated at 256 runes, `Retry-After`.
 */
import { serializeOrdered } from './json'
import type { WireObject } from './types'

/** OpenAI-shaped error envelope body, key order message/type/code/param. */
export function buildErrorEnvelopeBody(message: string, type: string, code?: string, param?: string): string {
  const error: WireObject = { message, type }
  if (code !== undefined) error['code'] = code
  if (param !== undefined) error['param'] = param
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

/** Downstream mapping of a wrapped upstream status (E1 wrap table). */
export function wrapTypeForStatus(status: number): { readonly type: string; readonly code?: string } {
  if (status === 401) return { type: 'authentication_error', code: 'invalid_api_key' }
  if (status === 403) return { type: 'permission_error', code: 'insufficient_quota' }
  if (status === 429) return { type: 'rate_limit_error', code: 'rate_limit_exceeded' }
  if (status === 404) return { type: 'invalid_request_error', code: 'model_not_found' }
  if (status >= 500) return { type: 'server_error', code: 'internal_server_error' }
  return { type: 'invalid_request_error' }
}

// ---------------------------------------------------------------------------
// Upstream non-2xx classification (E8 + E1)
// ---------------------------------------------------------------------------

/** Classified failure of an upstream non-2xx response. */
export type CodexUpstreamFailure =
  | { readonly kind: 'verbatim'; readonly status: number; readonly body: string }
  | { readonly kind: 'rewritten'; readonly status: number; readonly body: string }
  | { readonly kind: 'wrapped'; readonly status: number; readonly message: string; readonly type: string; readonly code?: string }

const CONTEXT_LENGTH_CODES: ReadonlySet<string> = new Set(['context_length_exceeded', 'context_too_large'])
const CONTEXT_LENGTH_MARKERS: readonly string[] = ['context length', 'context_length', 'maximum context length']
const AUTH_MARKERS: readonly string[] = ['invalid_api_key', 'authentication_error', 'unauthorized', 'incorrect api key']
const CAPACITY_MARKER = 'at capacity'

function bodyTextLowerCase(body: string): string {
  return body.toLowerCase()
}

/** Parsed error object of a JSON body, when present. */
function parseErrorObject(body: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(body)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const error = (parsed as Record<string, unknown>)['error']
    if (typeof error === 'object' && error !== null && !Array.isArray(error)) return error as Record<string, unknown>
    return undefined
  } catch {
    return undefined
  }
}

/** `<upstream error.message or body text>` for classified rewrites. */
function classifiedMessage(body: string, status: number): string {
  const error = parseErrorObject(body)
  const message = error !== undefined ? error['message'] : undefined
  if (typeof message === 'string' && message.length > 0) return message
  const trimmed = body.trim()
  return trimmed.length > 0 ? trimmed : statusText(status)
}

/**
 * Classifies an upstream non-2xx response (E8 first, then the E1
 * verbatim-or-wrap decision). The three rewrites:
 *
 * - context-length failures (HTTP 413, `error.code` in the pinned set, or a
 *   context-length message) -> `context_too_large`;
 * - auth failures (HTTP 401 or auth markers) -> `auth_unavailable`;
 * - `usage_limit_reached` types and model-capacity messages -> re-stated as
 *   429 with the body VERBATIM.
 */
export function classifyCodexUpstreamError(status: number, body: string): CodexUpstreamFailure {
  const lower = bodyTextLowerCase(body)
  const error = parseErrorObject(body)
  const errorCode = error !== undefined && typeof error['code'] === 'string' ? (error['code'] as string) : undefined
  const errorType = error !== undefined && typeof error['type'] === 'string' ? (error['type'] as string) : undefined

  const contextMarker =
    CONTEXT_LENGTH_CODES.has(errorCode ?? '') ||
    status === 413 ||
    CONTEXT_LENGTH_MARKERS.some((marker) => lower.includes(marker))
  if (contextMarker) {
    return {
      kind: 'rewritten',
      status,
      body: buildErrorEnvelopeBody(classifiedMessage(body, status), 'invalid_request_error', 'context_too_large'),
    }
  }

  const authMarker =
    status === 401 ||
    AUTH_MARKERS.some((marker) => lower.includes(marker)) ||
    (errorType ?? '').toLowerCase().includes('authentication')
  if (authMarker) {
    return {
      kind: 'rewritten',
      status: status === 401 ? 401 : status,
      body: buildErrorEnvelopeBody(classifiedMessage(body, status), 'authentication_error', 'auth_unavailable'),
    }
  }

  if (errorType === 'usage_limit_reached' || lower.includes(CAPACITY_MARKER)) {
    return { kind: 'verbatim', status: 429, body }
  }

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
export function renderUpstreamFailure(failure: CodexUpstreamFailure): {
  readonly status: number
  readonly body: string
} {
  if (failure.kind === 'verbatim' || failure.kind === 'rewritten') return { status: failure.status, body: failure.body }
  return { status: failure.status, body: buildErrorEnvelopeBody(failure.message, failure.type, failure.code) }
}

// ---------------------------------------------------------------------------
// In-stream terminal failures (E3 / E4)
// ---------------------------------------------------------------------------

/** Fallback terminal-failure body when the event carries no error object. */
export const UPSTREAM_STREAM_FAILED_WITHOUT_DETAILS = 'upstream stream failed without error details'

/** Raw JSON span of `error` / `response.error` inside an event payload. */
function rawErrorSpan(eventData: string): string | undefined {
  const direct = rawMemberValue(eventData, 'error')
  if (direct !== undefined) return direct
  const responseStart = locateMember(eventData, 'response')
  if (responseStart === undefined) return undefined
  const responseRaw = eventData.slice(responseStart.start, responseStart.end)
  return rawMemberValue(responseRaw, 'error')
}

interface MemberSpan {
  readonly start: number
  readonly end: number
}

/** Locates one top-level member of a raw JSON object. */
function locateMember(text: string, name: string): MemberSpan | undefined {
  const needle = `"${name}"`
  let index = text.indexOf(needle)
  while (index >= 0) {
    let cursor = index + needle.length
    while (cursor < text.length && /\s/.test(text[cursor] ?? '')) cursor++
    if (text[cursor] === ':') {
      const valueStart = cursor + 1
      let i = valueStart
      while (i < text.length && /\s/.test(text[i] ?? '')) i++
      const valueEnd = scanRawValue(text, i)
      if (valueEnd > i) return { start: i, end: valueEnd }
    }
    index = text.indexOf(needle, index + 1)
  }
  return undefined
}

/** Scans one raw JSON value starting at `start`; returns one past its end. */
function scanRawValue(text: string, start: number): number {
  const first = text[start]
  if (first === '"') {
    let i = start + 1
    while (i < text.length) {
      if (text[i] === '\\') {
        i += 2
        continue
      }
      if (text[i] === '"') return i + 1
      i++
    }
    return i
  }
  if (first === '{' || first === '[') {
    const close = first === '{' ? '}' : ']'
    let depth = 0
    let i = start
    while (i < text.length) {
      const current = text[i]
      if (current === '"') {
        i = scanRawValue(text, i)
        continue
      }
      if (current === '{' || current === '[') depth++
      else if (current === '}' || current === ']') {
        depth--
        if (depth === 0 && current === close) return i + 1
      }
      i++
    }
    return i
  }
  let i = start
  while (i < text.length && !',}]'.includes(text[i] ?? '') && !/\s/.test(text[i] ?? '')) i++
  return i
}

/** Raw value text of one member, or `undefined` when absent. */
function rawMemberValue(text: string, name: string): string | undefined {
  const span = locateMember(text, name)
  return span === undefined ? undefined : text.slice(span.start, span.end)
}

/**
 * Terminal-failure body of an `error` / `response.failed` event (E3): the
 * extracted `error` object wrapped as `{"error":<raw bytes>}`, with the
 * event's `sequence_number` added at the top level when present; the pinned
 * fallback when the event carries no error object.
 */
export function codexTerminalFailureBody(eventData: string): string {
  const errorRaw = rawErrorSpan(eventData)
  if (errorRaw === undefined) {
    return serializeOrdered({ error: { message: UPSTREAM_STREAM_FAILED_WITHOUT_DETAILS } })
  }
  const sequence = locateMember(eventData, 'sequence_number')
  if (sequence !== undefined) {
    const sequenceRaw = eventData.slice(sequence.start, sequence.end)
    return `{"error":${errorRaw},"sequence_number":${sequenceRaw}}`
  }
  return `{"error":${errorRaw}}`
}

/**
 * Pre-commit status of a terminal failure (E4): `error.status_code` /
 * `error.status` when numeric, else the type/code mapping (not_found 404,
 * authentication 401, permission 403, rate_limit 429, invalid_request 400,
 * cyber_policy 400), else 502.
 */
export function codexTerminalFailureStatus(eventData: string): number {
  const errorRaw = rawErrorSpan(eventData)
  if (errorRaw !== undefined) {
    try {
      const parsed: unknown = JSON.parse(errorRaw)
      if (typeof parsed === 'object' && parsed !== null) {
        const record = parsed as Record<string, unknown>
        for (const key of ['status_code', 'status']) {
          const value = record[key]
          if (typeof value === 'number' && Number.isFinite(value)) return value
        }
      }
    } catch {
      // fall through to the marker mapping
    }
  }
  const lower = eventData.toLowerCase()
  if (lower.includes('not_found')) return 404
  if (lower.includes('authentication') || lower.includes('unauthorized')) return 401
  if (lower.includes('permission')) return 403
  if (lower.includes('rate_limit')) return 429
  if (lower.includes('invalid_request') || lower.includes('cyber_policy')) return 400
  return 502
}

// ---------------------------------------------------------------------------
// Disconnect / empty-incomplete / model errors (E5, E6, E7)
// ---------------------------------------------------------------------------

/** Pinned message of the incomplete-stream error (recorded, S2D5-17). */
export const MESSAGE_STREAM_DISCONNECTED =
  'stream error: stream disconnected before completion: stream closed before response.completed'

/** Pinned message of the empty-incomplete error (recorded, S2D5-26). */
export const MESSAGE_EMPTY_INCOMPLETE =
  'stream error: upstream terminated with incomplete empty response (0 tokens)'

/** E5 body: `invalid_request_error` with NO `code` (status 408 < 500). */
export function incompleteStreamBody(): string {
  return buildErrorEnvelopeBody(MESSAGE_STREAM_DISCONNECTED, 'invalid_request_error')
}

/** E6 body: the 502 gateway-error envelope. */
export function emptyIncompleteBody(): string {
  return buildErrorEnvelopeBody(MESSAGE_EMPTY_INCOMPLETE, 'server_error', 'internal_server_error')
}

/** E7 body: unknown model (recorded, S2D5-20). */
export function unknownProviderEnvelope(model: string): string {
  return buildErrorEnvelopeBody(`unknown provider for model ${model}`, 'invalid_request_error', 'model_not_found', 'model')
}

/** NE-LENIENT strict-boundary body for malformed request JSON. */
export function invalidRequestBody(): string {
  return buildErrorEnvelopeBody('Invalid request: malformed JSON body', 'invalid_request_error')
}

// ---------------------------------------------------------------------------
// 429 -> cooldown (E2)
// ---------------------------------------------------------------------------

/** Truncation ceiling of the embedded upstream error text (runes). */
const UPSTREAM_ERROR_RUNE_LIMIT = 256

/**
 * Sanitizes the embedded upstream text: bodies longer than 256 runes are cut
 * to the first 253 runes plus `...` (the reference truncation; both
 * `last_upstream_error` and the message suffix use the same value).
 */
export function sanitizeUpstreamErrorSummary(text: string): string {
  const runes = Array.from(text)
  if (runes.length <= UPSTREAM_ERROR_RUNE_LIMIT) return text
  return `${runes.slice(0, UPSTREAM_ERROR_RUNE_LIMIT - 3).join('')}...`
}

/** Renders whole-second durations the way the reference displays them. */
export function goDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60
  if (hours > 0) return `${hours}h${minutes}m${rest}s`
  if (minutes > 0) return `${minutes}m${rest}s`
  return `${rest}s`
}

/** Rendered cooldown response for the next request (E2). */
export interface ModelCooldownResponse {
  readonly status: 429
  readonly retryAfter: string
  readonly body: string
}

/**
 * Builds the cooldown surface: status 429, a `Retry-After` header and the
 * alphabetical `model_cooldown` envelope with the verbatim
 * `last_upstream_error` (truncated) and the requested model string.
 */
export function buildModelCooldownResponse(input: {
  readonly model: string
  readonly provider: string
  readonly lastUpstreamError: string
  readonly resetSeconds: number
}): ModelCooldownResponse {
  const embedded = sanitizeUpstreamErrorSummary(input.lastUpstreamError)
  const envelope: WireObject = {
    code: 'model_cooldown',
    last_upstream_error: embedded,
    message: `All credentials for model ${input.model} are cooling down via provider ${input.provider} (last error: ${embedded})`,
    model: input.model,
    provider: input.provider,
    reset_seconds: input.resetSeconds,
    reset_time: goDuration(input.resetSeconds),
  }
  return { status: 429, retryAfter: String(input.resetSeconds), body: serializeOrdered({ error: envelope }) }
}

/** Frames one payload as a downstream in-stream error frame. */
export function formatInStreamErrorFrame(payload: string): string {
  return `data: ${payload}\n\n`
}
