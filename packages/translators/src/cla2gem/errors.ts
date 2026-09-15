/**
 * Error semantics for the cla2gem direction (S2d8 section 4).
 *
 * - Upstream non-2xx responses pass their HTTP status downstream VERBATIM
 *   but never their body: the Claude envelope
 *   `{"type":"error","error":{"type":...,"message":...}}` is always
 *   rendered, with the type mapped from the status and the message
 *   extracted by the recorded ladder (recorded: S2d8-14/15/18).
 * - A stream that fails before the first translated event renders the
 *   same envelope as a plain JSON response - no SSE headers.
 * - A mid-stream transport failure appends the `[DONE]` pass plus ONE
 *   terminal `event: error` frame with the pinned `unexpected EOF`
 *   message (two-newline framing; HTTP stays 200).
 * - The 429 credential cooldown pins the 500 `api_error` surface whose
 *   message is the model-cooldown text (section 4.2); the ~1s window is
 *   NOT disabled by `transient-error-cooldown-seconds: -1`.
 */
import { isPlainObject, serializeOrdered } from './json'
import type { WireObject } from './json'

/** Pinned message for upstream transport failures (recorded: hard close). */
export const UNEXPECTED_EOF_MESSAGE = 'unexpected EOF'

/** Provider name in the model-cooldown message (recorded: `gemini`). */
export const COOLDOWN_PROVIDER = 'gemini'

const STATUS_TEXTS: Readonly<Record<number, string>> = Object.freeze({
  400: 'Bad Request',
  401: 'Unauthorized',
  402: 'Payment Required',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  413: 'Content Too Large',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
})

function statusText(status: number): string {
  return STATUS_TEXTS[status] ?? `HTTP ${status}`
}

/** Status -> Claude error type (section 4.1 ladder). */
export function claudeErrorTypeForStatus(status: number): string {
  if (status === 401) return 'authentication_error'
  if (status === 402) return 'billing_error'
  if (status === 403) return 'permission_error'
  if (status === 404) return 'not_found_error'
  if (status === 413) return 'request_too_large'
  if (status === 429) return 'rate_limit_error'
  if (status === 504) return 'timeout_error'
  if (status === 529) return 'overloaded_error'
  if (status >= 500) return 'api_error'
  return 'invalid_request_error'
}

/** Claude error envelope body: type, error{type, message} (wire order). */
export function buildClaudeErrorEnvelope(type: string, message: string): string {
  const error: WireObject = { type, message }
  return serializeOrdered({ type: 'error', error })
}

/** Result of the message/type extraction ladder. */
export interface ClaudeErrorExtraction {
  readonly type: string
  readonly message: string
}

/**
 * Extracts the downstream error type and message from an upstream error
 * body (recorded ladder, section 4.1):
 *
 * - `M` starts as the raw body text (empty -> the HTTP reason phrase);
 * - when the body is valid JSON whose `error` is an OBJECT: a string
 *   `error.message` sets `M`, else a string `error.code` sets `M` (numeric
 *   codes are IGNORED); a string `error.type` overrides the status type;
 * - only when `error` is NOT an object: a string top-level `type` other
 *   than `"error"` overrides the type, and a string top-level `message`
 *   sets `M`; a non-JSON body keeps the raw text as `M`.
 */
export function extractClaudeError(
  status: number,
  body: string,
  reasonFallback?: string,
): ClaudeErrorExtraction {
  let type = claudeErrorTypeForStatus(status)
  let message = body
  if (body.trim().length === 0) {
    message = reasonFallback ?? statusText(status)
    return { type, message }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return { type, message: body }
  }
  if (isPlainObject(parsed)) {
    const error = parsed['error']
    if (isPlainObject(error)) {
      if (typeof error['message'] === 'string') message = error['message']
      else if (typeof error['code'] === 'string') message = error['code']
      if (typeof error['type'] === 'string') type = error['type']
      return { type, message }
    }
    const topLevelType = parsed['type']
    if (typeof topLevelType === 'string' && topLevelType !== 'error') type = topLevelType
    const topLevelMessage = parsed['message']
    if (typeof topLevelMessage === 'string') message = topLevelMessage
    return { type, message }
  }
  return { type, message: body }
}

/** Renders one upstream failure as the downstream status + envelope bytes. */
export function renderUpstreamFailure(status: number, body: string, reasonFallback?: string): {
  readonly status: number
  readonly body: string
} {
  const extracted = extractClaudeError(status, body, reasonFallback)
  return { status, body: buildClaudeErrorEnvelope(extracted.type, extracted.message) }
}

/** Pre-commit transport failure surface: plain 500 `unexpected EOF`. */
export function renderUnexpectedEofFailure(): { readonly status: number; readonly body: string } {
  return { status: 500, body: buildClaudeErrorEnvelope('api_error', UNEXPECTED_EOF_MESSAGE) }
}

/** Model-cooldown surface of a request inside the 429 window (section 4.2). */
export function buildModelCooldownResponse(input: {
  readonly model: string
  readonly lastUpstreamError: string
}): { readonly status: 500; readonly body: string } {
  const message = `All credentials for model ${input.model} are cooling down via provider ${COOLDOWN_PROVIDER} (last error: ${input.lastUpstreamError})`
  return { status: 500, body: buildClaudeErrorEnvelope('api_error', message) }
}

/** Generic 400 body of an unreadable client request (S1 base shape). */
export function buildInvalidRequestBody(detail: string): string {
  return serializeOrdered({ error: { message: `Invalid request: ${detail}`, type: 'invalid_request_error' } })
}
