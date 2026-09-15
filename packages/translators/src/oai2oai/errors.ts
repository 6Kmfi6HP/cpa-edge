/**
 * Error semantics for the oai2oai direction.
 *
 * Recorded facts the shapes below follow:
 *
 * - non-2xx upstream replies keep their status, and valid-JSON bodies
 *   pass downstream VERBATIM (the wire-note 429 pin: same bytes,
 *   spacing included); anything else wraps into the OpenAI envelope
 *   with the status-mapped type/code;
 * - an error object inside an upstream data frame ends the stream as
 *   ONE terminal `data:` frame, and no `[DONE]` follows it;
 * - a 429 puts the model's credentials into a rate-limit cooldown the
 *   `transient-error-cooldown-seconds: -1` switch does NOT disable; the
 *   next request inside the window answers with the triggering status,
 *   a `Retry-After` header and the alphabetically-keyed `model_cooldown`
 *   envelope (recorded on this executor family in S2d2);
 * - transport failures surface the transport's own text, with the pinned
 *   `unexpected EOF` literal as the fallback.
 */
import { serializeOrdered } from './json'
import type { HeaderList, WireObject } from './types'

/** Pinned transport-failure literal (recorded hard close mid-stream). */
export const UNEXPECTED_EOF_MESSAGE = 'unexpected EOF'

// ---------------------------------------------------------------------------
// OpenAI-shaped envelopes (this surface's error bodies)
// ---------------------------------------------------------------------------

/** Ordered error envelope: message, type, then optional code/param. */
export function openAIErrorBody(message: string, type: string, code?: string, param?: string): string {
  const error: WireObject = { message, type }
  if (code !== undefined) error['code'] = code
  if (param !== undefined) error['param'] = param
  return serializeOrdered({ error })
}

/** Malformed-body rejection of the strict request boundary (NE-LENIENT). */
export function invalidRequestBody(): string {
  return openAIErrorBody('Invalid request: malformed JSON body', 'invalid_request_error')
}

/** Alias-resolution rejection; the model string embeds JSON-escaped. */
export function modelNotFoundBody(model: string): string {
  return openAIErrorBody(
    `unknown provider for model ${model}`,
    'invalid_request_error',
    'model_not_found',
    'model',
  )
}

/** No-credential fallback of the attempt loop. */
export function serverErrorBody(message: string): string {
  return openAIErrorBody(message, 'server_error', 'internal_server_error')
}

/** Plain-string error body of the gateway-key gate (recorded 401 family). */
export function plainErrorBody(message: string): string {
  return serializeOrdered({ error: message })
}

/** Downstream mapping of a wrapped status. */
export function wrapTypeForStatus(status: number): { readonly type: string; readonly code?: string } {
  if (status === 401) return { type: 'authentication_error', code: 'invalid_api_key' }
  if (status === 403) return { type: 'permission_error', code: 'insufficient_quota' }
  if (status === 429) return { type: 'rate_limit_error', code: 'rate_limit_exceeded' }
  if (status === 404) return { type: 'invalid_request_error', code: 'model_not_found' }
  if (status >= 500) return { type: 'server_error', code: 'internal_server_error' }
  return { type: 'invalid_request_error' }
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

/**
 * Shared error-body derivation: text that is itself valid JSON is
 * emitted verbatim, anything else is wrapped with the type/code the
 * status maps to.
 */
export function renderGatewayError(message: string, status: number): string {
  const trimmed = message.trim()
  if (trimmed.length > 0) {
    try {
      JSON.parse(trimmed)
      return trimmed
    } catch {
      // fall through to the wrapped shape
    }
  }
  const wrap = wrapTypeForStatus(status)
  return openAIErrorBody(trimmed.length > 0 ? trimmed : statusText(status), wrap.type, wrap.code)
}

// ---------------------------------------------------------------------------
// Upstream HTTP errors (the wire-note verbatim rule)
// ---------------------------------------------------------------------------

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
 * with their status and bytes VERBATIM; anything else keeps the status
 * and wraps into the OpenAI-shaped envelope.
 */
export function classifyUpstreamError(status: number, body: string): UpstreamFailure {
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
  return {
    kind: 'wrapped',
    status,
    message: trimmed.length > 0 ? trimmed : statusText(status),
    type: wrap.type,
    code: wrap.code,
  }
}

/** Renders a classified failure as the downstream status + body bytes. */
export function renderUpstreamFailure(failure: UpstreamFailure): {
  readonly status: number
  readonly body: string
} {
  if (failure.kind === 'verbatim') return { status: failure.status, body: failure.body }
  return { status: failure.status, body: openAIErrorBody(failure.message, failure.type, failure.code) }
}

/** Pre-commit transport failure: the wrapped 500 `unexpected EOF` form. */
export function transportFailureBody(error: unknown): string {
  return renderGatewayError(transportErrorMessage(error), 500)
}

/**
 * Transport-error text of an injected upstream failure: the error's own
 * message when it carries one, the pinned literal otherwise.
 */
export function transportErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message
  return UNEXPECTED_EOF_MESSAGE
}

// ---------------------------------------------------------------------------
// In-stream error detection
// ---------------------------------------------------------------------------

/** `event:` names of the error family (payload-based checks mirror these). */
const ERROR_EVENT_NAMES: readonly string[] = Object.freeze(['error', 'response.error', 'response.failed'])

/** Status hint of an upstream error payload: `status`/`status_code` in 400..599, else 502. */
export function upstreamErrorStatus(payload: Record<string, unknown>): number {
  for (const key of ['status', 'status_code'] as const) {
    const raw = payload[key]
    if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 400 && raw <= 599) return raw
  }
  return 502
}

/** Recognizes an error object inside an upstream data frame. */
export function isUpstreamErrorPayload(payload: Record<string, unknown>): boolean {
  if ('error' in payload) return true
  const response = payload['response']
  if (typeof response === 'object' && response !== null && 'error' in (response as Record<string, unknown>)) {
    return true
  }
  if ('code' in payload && 'message' in payload) return true
  const type = payload['type']
  if (typeof type === 'string' && ERROR_EVENT_NAMES.includes(type)) return true
  return false
}

// ---------------------------------------------------------------------------
// Upstream 429 hints (cooldown windows)
// ---------------------------------------------------------------------------

/**
 * Integer `Retry-After` seconds of an upstream 429. Only plain decimal
 * digits count; anything else carries no usable hint.
 */
export function parseRetryAfterSeconds(headers: HeaderList): number | undefined {
  const raw = headerValueOf(headers, 'retry-after')
  if (raw === undefined || !/^[0-9]+$/.test(raw)) return undefined
  const value = Number(raw)
  return Number.isSafeInteger(value) ? value : undefined
}

function headerValueOf(headers: HeaderList, name: string): string | undefined {
  const key = name.toLowerCase()
  for (const [headerName, value] of headers) {
    if (headerName.toLowerCase() === key) return value
  }
  return undefined
}

/**
 * Tokens-per-minute pattern of an upstream 429 body: an `error.code`
 * containing `TPMRateLimitExceeded`, or a message naming the
 * tokens-per-minute limit as exceeded. Without a `Retry-After` header
 * such a failure opens the 60-second fallback window.
 */
export function isTpmRateLimitBody(body: string): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return false
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false
  const error = (parsed as Record<string, unknown>)['error']
  if (typeof error !== 'object' || error === null || Array.isArray(error)) return false
  const record = error as Record<string, unknown>
  const code = typeof record['code'] === 'string' ? record['code'] : ''
  if (code.includes('TPMRateLimitExceeded')) return true
  const message = typeof record['message'] === 'string' ? record['message'] : ''
  const lower = message.toLowerCase()
  return lower.includes('tokens per minute') && lower.includes('limit') && lower.includes('exceeded')
}

/** `code: message` summary of an upstream error body (cooldown bookkeeping). */
export function upstreamErrorSummary(body: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return body
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return body
  const error = (parsed as Record<string, unknown>)['error']
  if (typeof error !== 'object' || error === null || Array.isArray(error)) return body
  const record = error as Record<string, unknown>
  const code = typeof record['code'] === 'string' ? record['code'] : undefined
  const message = typeof record['message'] === 'string' ? record['message'] : undefined
  if (code !== undefined && message !== undefined) return `${code}: ${message}`
  if (message !== undefined) return message
  return body
}

// ---------------------------------------------------------------------------
// Model cooldown envelope (the 429 slice of this executor family)
// ---------------------------------------------------------------------------

/** Rendered cooldown response for a request landing inside the window. */
export interface ModelCooldownResponse {
  /** Status of the triggering upstream error (429 in the family golden). */
  readonly status: number
  /** `Retry-After` header value: the window seconds. */
  readonly retryAfter: string
  /** Alphabetically keyed `model_cooldown` envelope bytes. */
  readonly body: string
}

/**
 * Builds the cooldown surface: the status of the triggering upstream
 * error, a `Retry-After` header and the alphabetical `model_cooldown`
 * envelope whose `last_upstream_error` carries the summary form (the
 * `code: message` text, embedded verbatim into the message).
 */
export function buildModelCooldownResponse(input: {
  readonly model: string
  readonly provider: string
  readonly lastUpstreamError: string
  readonly resetSeconds: number
  readonly status: number
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
  return {
    status: input.status,
    retryAfter: String(input.resetSeconds),
    body: serializeOrdered({ error: envelope }),
  }
}
