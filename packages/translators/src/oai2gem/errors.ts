/**
 * Error semantics for the oai2gem direction (spec 5).
 *
 * - Upstream non-2xx bodies pass downstream VERBATIM when they are valid
 *   JSON (only surrounding whitespace is trimmed; fixtures C15/C17/C18
 *   pin the byte-identical pass-through), and wrap into per-status
 *   OpenAI-shaped envelopes otherwise.
 * - A pre-commit transport failure renders a plain 500 envelope; a
 *   post-commit failure renders exactly ONE terminal
 *   `data: {"error":...}` frame and NO `[DONE]` (fixture C19).
 * - The 429 model-cooldown surface: the verbatim upstream 429 passes
 *   through first (C15), the window is recorded through the Store, and a
 *   request landing inside it gets the alphabetical `model_cooldown`
 *   envelope with a `Retry-After` header and NO trace header (C16).
 */
import { serializeOrdered } from './json'
import type { WireObject } from './json'

/** Pinned transport failure literal (recorded: hard close mid-stream). */
export const UNEXPECTED_EOF_MESSAGE = 'unexpected EOF'

/** OpenAI-shaped error envelope body; key order message, type, code?, param?. */
export function openAIErrorBody(message: string, type: string, code?: string, param?: string): string {
  const error: WireObject = { message, type }
  if (code !== undefined) error['code'] = code
  if (param !== undefined) error['param'] = param
  return serializeOrdered({ error })
}

/** S1 401 shapes of the gateway-key gate (string `error`, recorded). */
export const MISSING_API_KEY_BODY = '{"error":"Missing API key"}'
export const INVALID_API_KEY_BODY = '{"error":"Invalid API key"}'

/** 400 `model_not_found` envelope of alias resolution (spec 2.1). */
export function modelNotFoundBody(model: string): string {
  return openAIErrorBody(`unknown provider for model ${model}`, 'invalid_request_error', 'model_not_found', 'model')
}

/** Downstream mapping of a wrapped upstream status (spec 5). */
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
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
})

/** Classified failure of an upstream non-2xx response. */
export type GeminiUpstreamFailure =
  | { readonly kind: 'verbatim'; readonly status: number; readonly body: string }
  | { readonly kind: 'wrapped'; readonly status: number; readonly message: string; readonly type: string; readonly code?: string }

/**
 * Classifies an upstream non-2xx response: valid-JSON bodies pass through
 * with their status verbatim; anything else wraps per status.
 */
export function classifyUpstreamError(status: number, body: string): GeminiUpstreamFailure {
  const trimmed = body.trim()
  if (trimmed.length > 0) {
    try {
      JSON.parse(trimmed)
      return { kind: 'verbatim', status, body: trimmed }
    } catch {
      // fall through to the wrapped shape
    }
  }
  const wrap = wrapTypeForStatus(status)
  const message = trimmed.length > 0 ? trimmed : STATUS_TEXTS[status] ?? `HTTP ${status}`
  return { kind: 'wrapped', status, message, type: wrap.type, code: wrap.code }
}

/** Renders a classified failure as the downstream status + body bytes. */
export function renderUpstreamFailure(failure: GeminiUpstreamFailure): {
  readonly status: number
  readonly body: string
} {
  if (failure.kind === 'verbatim') return { status: failure.status, body: failure.body }
  return { status: failure.status, body: openAIErrorBody(failure.message, failure.type, failure.code) }
}

/** Pre-commit transport failure: plain 500 envelope. */
export function renderTransportFailure(message: string): { readonly status: number; readonly body: string } {
  return { status: 500, body: openAIErrorBody(message, 'server_error', 'internal_server_error') }
}

/** Terminal in-stream error frame: one `data:` block, NO `[DONE]` after. */
export function terminalErrorFrame(message: string): string {
  return `data: ${openAIErrorBody(message, 'server_error', 'internal_server_error')}\n\n`
}

/**
 * Transport-error text of an injected upstream failure: the error's own
 * message when it carries one, the pinned literal otherwise.
 */
export function transportErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message
  return UNEXPECTED_EOF_MESSAGE
}

/** Case-insensitive lookup over an ordered header list. */
export function headerValue(headers: ReadonlyArray<readonly [string, string]>, name: string): string | undefined {
  const key = name.toLowerCase()
  for (const [headerName, value] of headers) {
    if (headerName.toLowerCase() === key) return value
  }
  return undefined
}

/**
 * Integer `Retry-After` seconds of an upstream 429. Only plain decimal
 * digits count; anything else carries no usable hint (S4 ladder governs).
 */
export function parseRetryAfterSeconds(headers: ReadonlyArray<readonly [string, string]>): number | undefined {
  const raw = headerValue(headers, 'retry-after')
  if (raw === undefined || !/^[0-9]+$/.test(raw)) return undefined
  const value = Number(raw)
  return Number.isSafeInteger(value) ? value : undefined
}

/** Rendered cooldown response for a request landing inside the window. */
export interface ModelCooldownResponse {
  readonly status: number
  readonly retryAfter: string
  readonly body: string
}

/**
 * Builds the cooldown surface (fixture C16): the triggering status, a
 * `Retry-After` header, and the alphabetical `model_cooldown` envelope
 * (`code, last_upstream_error, message, model, provider, reset_seconds,
 * reset_time`).
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
