/**
 * Error semantics for the Gemini client -> OpenAI upstream direction
 * (S2d2 section 5).
 *
 * - Upstream non-2xx bodies pass downstream VERBATIM when they are valid
 *   JSON and wrap per status otherwise (the shared error-body derivation).
 * - The 429 model-cooldown envelope renders with alphabetically sorted
 *   keys and a `Retry-After` header; its `last_upstream_error` is the
 *   extracted `code: message` summary of the upstream body.
 * - Cooldown windows come from the upstream `Retry-After` hint, the
 *   tokens-per-minute pattern (60s fallback), or the escalating default
 *   ladder (first failure ~1s, doubling per post-window failure).
 */
import { serializeOrdered } from './json'
import type { HeaderList, WireObject } from './types'

// ---------------------------------------------------------------------------
// Gateway-built error bodies (shared derivation, section 5.5)
// ---------------------------------------------------------------------------

/** OpenAI-shaped error envelope: key order message, type, code?, param?. */
export function openAIErrorBody(message: string, type: string, code?: string, param?: string): string {
  const error: WireObject = { message, type }
  if (code !== undefined) error['code'] = code
  if (param !== undefined) error['param'] = param
  return serializeOrdered({ error })
}

/** Downstream mapping of a wrapped status (section 5.5). */
export function wrapTypeForStatus(status: number): { readonly type: string; readonly code?: string } {
  if (status === 401) return { type: 'authentication_error', code: 'invalid_api_key' }
  if (status === 403) return { type: 'permission_error', code: 'insufficient_quota' }
  if (status === 429) return { type: 'rate_limit_error', code: 'rate_limit_exceeded' }
  if (status === 404) return { type: 'invalid_request_error', code: 'model_not_found' }
  if (status >= 500) return { type: 'server_error', code: 'internal_server_error' }
  return { type: 'invalid_request_error' }
}

/**
 * Shared error-body derivation: error text that is itself valid JSON is
 * emitted verbatim, anything else is wrapped with the type/code of the
 * status.
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
  return openAIErrorBody(trimmed, wrap.type, wrap.code)
}

/** `Malformed API key` shapes of the client-auth gate (section 2.2). */
export const MISSING_API_KEY_BODY = '{"error":"Missing API key"}'
export const INVALID_API_KEY_BODY = '{"error":"Invalid API key"}'

/** 400 `model_not_found` envelope of alias resolution (section 5.1). */
export function modelNotFoundBody(model: string): string {
  return openAIErrorBody(`unknown provider for model ${model}`, 'invalid_request_error', 'model_not_found', 'model')
}

/** Handler-written JSON 404 for a malformed `*action` segment (section 2.1). */
export function actionNotFoundBody(pathname: string): string {
  return openAIErrorBody(`${pathname} not found.`, 'invalid_request_error')
}

/** 404 of the single-model GET for an id that does not resolve (section 2.4). */
export const MODEL_GET_NOT_FOUND_BODY = '{"error":{"message":"Not Found","type":"not_found"}}'

/** Pinned transport failure literal (recorded: hard close mid-stream). */
export const UNEXPECTED_EOF_MESSAGE = 'unexpected EOF'

/**
 * Transport-error text of an injected upstream failure: the error's own
 * message when it carries one, the pinned literal otherwise.
 */
export function transportErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message
  return UNEXPECTED_EOF_MESSAGE
}

// ---------------------------------------------------------------------------
// Upstream HTTP errors (section 5.2)
// ---------------------------------------------------------------------------

/** Classified failure of an upstream non-2xx response. */
export type OpenAIUpstreamFailure =
  | { readonly kind: 'verbatim'; readonly status: number; readonly body: string }
  | { readonly kind: 'wrapped'; readonly status: number; readonly message: string; readonly type: string; readonly code?: string }

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

/**
 * Classifies an upstream non-2xx response: valid-JSON bodies pass through
 * with their status verbatim; anything else wraps per status.
 */
export function classifyUpstreamError(status: number, body: string): OpenAIUpstreamFailure {
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
  const message = trimmed.length > 0 ? trimmed : STATUS_TEXTS[status] ?? `HTTP ${status}`
  return { kind: 'wrapped', status, message, type: wrap.type, code: wrap.code }
}

/** Renders a classified failure as the downstream status + body bytes. */
export function renderUpstreamFailure(failure: OpenAIUpstreamFailure): {
  readonly status: number
  readonly body: string
} {
  if (failure.kind === 'verbatim') return { status: failure.status, body: failure.body }
  return { status: failure.status, body: openAIErrorBody(failure.message, failure.type, failure.code) }
}

// ---------------------------------------------------------------------------
// Upstream 429 hints (section 5.3)
// ---------------------------------------------------------------------------

/** Case-insensitive header lookup on an ordered header list. */
export function headerValue(headers: HeaderList, name: string): string | undefined {
  const key = name.toLowerCase()
  for (const [headerName, value] of headers) {
    if (headerName.toLowerCase() === key) return value
  }
  return undefined
}

/**
 * Integer `Retry-After` seconds of an upstream 429. Only plain decimal
 * digits count; anything else carries no usable hint.
 */
export function parseRetryAfterSeconds(headers: HeaderList): number | undefined {
  const raw = headerValue(headers, 'retry-after')
  if (raw === undefined || !/^[0-9]+$/.test(raw)) return undefined
  const value = Number(raw)
  return Number.isSafeInteger(value) ? value : undefined
}

/**
 * Tokens-per-minute pattern of an upstream 429 body: an `error.code`
 * containing `TPMRateLimitExceeded`, or a message naming the tokens-per-
 * minute limit as exceeded. Without a `Retry-After` header such a failure
 * opens the 60-second fallback window.
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
// Model cooldown envelope (section 5.3)
// ---------------------------------------------------------------------------

/** Rendered cooldown response for a request landing inside the window. */
export interface ModelCooldownResponse {
  /** Status of the triggering upstream error (429 in the golden). */
  readonly status: number
  /** `Retry-After` header value: the window seconds. */
  readonly retryAfter: string
  /** Alphabetically keyed `model_cooldown` envelope bytes. */
  readonly body: string
}

/**
 * Builds the cooldown surface: the status of the triggering upstream
 * error, a `Retry-After` header and the alphabetical `model_cooldown`
 * envelope.
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
