/**
 * Error semantics for the cla2oai direction (S2d4 sections 5, 4.4, 7.8).
 *
 * - Handler-level errors answer with the Claude envelope
 *   `{"type":"error","error":{"type":...,"message":...}}`; the type comes
 *   from the status map unless the upstream payload overrides it, and the
 *   message follows the recorded extraction ladder (error object ->
 *   error.type/error.message-or-code; top-level type/message; raw text
 *   otherwise). Recorded: the upstream 429 reshapes to
 *   `rate_limit_exceeded` / `mock rate limit` with the code dropped.
 * - The middleware 401s are the ONE exception: plain `{"error":"<string>"}`
 *   with `charset=utf-8` content type (recorded: S2d4-auth-missing).
 * - The 429 credential-cooldown surface carries the triggering upstream
 *   status (429 recorded), a `Retry-After` header (1 recorded), the
 *   NAMESPACED provider `openai-compatible-<entry name>` and the
 *   last-upstream-error summary - for the recorded mock body the
 *   VERBATIM raw bytes (the summarizer's `": {"` cut mangles the spaced
 *   JSON, so the sanitized raw text is embedded verbatim; section 7.8).
 */
import { isPlainObject, isValidJson, serializeOrdered } from './json'
import type { WireObject } from './json'

/** Pinned message for upstream transport failures (recorded: hard close). */
export const UNEXPECTED_EOF_MESSAGE = 'unexpected EOF'

/** Middleware-level 401 bodies (plain string shape, not the Claude envelope). */
export const MISSING_API_KEY_BODY = '{"error":"Missing API key"}'
export const INVALID_API_KEY_BODY = '{"error":"Invalid API key"}'

const STATUS_TEXTS: Readonly<Record<number, string>> = Object.freeze({
  400: 'Bad Request',
  401: 'Unauthorized',
  402: 'Payment Required',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  408: 'Request Timeout',
  413: 'Content Too Large',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
})

function statusText(status: number): string {
  return STATUS_TEXTS[status] ?? `HTTP ${status}`
}

/** Status -> Claude error type (section 5.1 ladder). */
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
 * body (recorded ladder, section 5.1):
 *
 * - the raw body text starts as the message (empty -> the HTTP reason
 *   phrase);
 * - valid JSON whose `error` is an OBJECT: a string `error.message` sets
 *   the message, else a string `error.code` does; a string `error.type`
 *   overrides the status type (the code itself is dropped);
 * - only when `error` is NOT an object: a string top-level `type` other
 *   than `"error"` overrides the type, and a string top-level `message`
 *   sets the message;
 * - a non-JSON body keeps the raw text as the message.
 */
export function extractClaudeError(
  status: number,
  body: string,
  reasonFallback?: string,
): ClaudeErrorExtraction {
  const type = claudeErrorTypeForStatus(status)
  if (body.trim().length === 0) {
    return { type, message: reasonFallback ?? statusText(status) }
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
      let message = body
      if (typeof error['message'] === 'string') message = error['message']
      else if (typeof error['code'] === 'string') message = error['code']
      const errorType = error['type']
      return { type: typeof errorType === 'string' ? errorType : type, message }
    }
    let overridden = type
    const topLevelType = parsed['type']
    if (typeof topLevelType === 'string' && topLevelType !== 'error') overridden = topLevelType
    let message = body
    const topLevelMessage = parsed['message']
    if (typeof topLevelMessage === 'string') message = topLevelMessage
    return { type: overridden, message }
  }
  return { type, message: body }
}

/** Renders one upstream failure as the downstream status + envelope bytes. */
export function renderUpstreamFailure(
  status: number,
  body: string,
  reasonFallback?: string,
): { readonly status: number; readonly body: string } {
  const extracted = extractClaudeError(status, body, reasonFallback)
  return { status, body: buildClaudeErrorEnvelope(extracted.type, extracted.message) }
}

/** 400 unknown-provider envelope of alias resolution (recorded bytes). */
export function unknownProviderEnvelope(model: string): string {
  // The rendered message is trimmed (an empty model yields no trailing
  // space).
  return buildClaudeErrorEnvelope('invalid_request_error', `unknown provider for model ${model}`.trim())
}

/** Pre-commit transport failure surface: plain 500 `unexpected EOF`. */
export function renderUnexpectedEofFailure(): { readonly status: 500; readonly body: string } {
  return { status: 500, body: buildClaudeErrorEnvelope('api_error', UNEXPECTED_EOF_MESSAGE) }
}

// ---------------------------------------------------------------------------
// Upstream error summary (cooldown bookkeeping, section 7.8)
// ---------------------------------------------------------------------------

/** Length cap of a sanitized summary (runes, per the scheduling spec). */
const SUMMARY_MAX_RUNES = 256

/** The byte sequence the summarizer cuts on, when it appears early. */
const SUMMARY_CUT_SEQUENCE = '": {"'

/** Where the `": {"` cut may still fire (bytes from the start). */
const SUMMARY_CUT_WINDOW = 50

/** Strips ANSI escape sequences and stray control characters. */
function sanitizeSummaryText(text: string): string {
  return text
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
}

/** Truncates to the summary rune cap. */
function truncateRunes(text: string, max: number): string {
  const runes = [...text]
  return runes.length <= max ? text : runes.slice(0, max).join('')
}

/** `code: message` of a parsed error-ish record, when derivable. */
function compactSummaryOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const error = isPlainObject(record['error']) ? (record['error'] as Record<string, unknown>) : record
  const code = error['code'] ?? error['type']
  const message = error['message']
  const codeText = typeof code === 'string' ? code : undefined
  const messageText = typeof message === 'string' ? message : undefined
  if (codeText !== undefined && messageText !== undefined) return `${codeText}: ${messageText}`
  if (messageText !== undefined) return messageText
  if (codeText !== undefined) return codeText
  return undefined
}

/**
 * Summarizes an upstream error body for cooldown bookkeeping (section
 * 7.8 mechanism): the summarizer looks for `": {"` within the first 50
 * bytes and takes everything after it as a JSON candidate. A VALID
 * candidate - or no cut firing at all - yields the compact
 * `<code>: <message>` form; an INVALID candidate (the cut mangled the
 * JSON) yields the sanitized RAW error text VERBATIM. The recorded mock
 * body hits the verbatim branch.
 */
export function summarizeUpstreamError(text: string): string {
  const cutAt = text.indexOf(SUMMARY_CUT_SEQUENCE)
  if (cutAt >= 0 && cutAt < SUMMARY_CUT_WINDOW) {
    const candidate = text.slice(cutAt + SUMMARY_CUT_SEQUENCE.length)
    if (isValidJson(candidate)) {
      let parsed: unknown
      try {
        parsed = JSON.parse(candidate)
      } catch {
        parsed = undefined
      }
      const compact = compactSummaryOf(parsed)
      return truncateRunes(sanitizeSummaryText(compact ?? candidate), SUMMARY_MAX_RUNES)
    }
    // Invalid candidate: the sanitized RAW error text, verbatim.
    return truncateRunes(sanitizeSummaryText(text), SUMMARY_MAX_RUNES)
  }
  const compact = compactSummaryOf(safeParse(text))
  return truncateRunes(sanitizeSummaryText(compact ?? text), SUMMARY_MAX_RUNES)
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Model cooldown surface (section 5.2)
// ---------------------------------------------------------------------------

/** Rendered cooldown response for a request landing inside the window. */
export interface ModelCooldownResponse {
  /** Status of the triggering upstream error (429 in the golden). */
  readonly status: number
  /** `Retry-After` header value: the internal reset estimate seconds. */
  readonly retryAfter: string
  /** Claude envelope bytes of the cooldown error. */
  readonly body: string
}

/** Prefix of the namespaced openai-compatibility provider key (recorded). */
export function openAICompatProviderKey(entryName: string): string {
  return `openai-compatible-${entryName}`
}

/**
 * Builds the cooldown surface: the triggering status, a `Retry-After`
 * header and the Claude envelope whose message is the model-cooldown
 * text with the NAMESPACED provider and the summarized last error
 * (recorded: `All credentials for model mock-model are cooling down via
 * provider openai-compatible-mock-openai (last error: ...)`, type from
 * the status map).
 */
export function buildModelCooldownResponse(input: {
  readonly model: string
  readonly provider: string
  readonly lastUpstreamError: string
  readonly resetSeconds: number
  readonly status: number
}): ModelCooldownResponse {
  const message = `All credentials for model ${input.model} are cooling down via provider ${input.provider} (last error: ${input.lastUpstreamError})`
  return {
    status: input.status,
    retryAfter: String(input.resetSeconds),
    body: buildClaudeErrorEnvelope(claudeErrorTypeForStatus(input.status), message),
  }
}
