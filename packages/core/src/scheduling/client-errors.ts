/**
 * Client-visible scheduling error payloads: the exact bytes the gateway
 * emits when scheduling fails to find a usable credential.
 *
 * The JSON key orders below are contract material, pinned by the recorded
 * fixtures: the model-cooldown object marshals with alphabetically sorted
 * keys, the auth-unavailable object with a fixed struct order. The builders
 * return ready-to-serialize body strings plus status and headers so
 * handlers never assemble these shapes by hand.
 */

/** Failure reason prefix of the auth-selection error. */
export type AuthSelectionReason = 'auth_unavailable' | 'auth_not_found'

/** Truncation bound of the last upstream error text. */
export const UPSTREAM_ERROR_SUMMARY_MAX_RUNES = 256

/**
 * Sanitizes an upstream error summary for an error payload: summaries
 * longer than 256 runes are cut to the first 253 runes plus `...`.
 */
export function sanitizeUpstreamErrorSummary(summary: string): string {
  const runes = [...summary]
  if (runes.length <= UPSTREAM_ERROR_SUMMARY_MAX_RUNES) return summary
  return `${runes.slice(0, UPSTREAM_ERROR_SUMMARY_MAX_RUNES - 3).join('')}...`
}

/**
 * Renders whole milliseconds the way Go prints a duration: `4s`,
 * `1m31s`, `1h0m0s`. Sub-second values render as milliseconds.
 */
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

/** A ready-to-serialize HTTP error response. */
export interface SchedulingErrorResponse {
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  /** The exact JSON body bytes to write, no trailing newline. */
  readonly body: string
}

/** Facts of an all-cooling model used to build the 429 payload. */
export interface ModelCooldownFacts {
  readonly model: string
  readonly provider: string | undefined
  /** Milliseconds until the earliest credential recovers. */
  readonly resetMs: number
  /** Last upstream error text, verbatim (it is truncated by the sanitizer). */
  readonly lastUpstreamError?: string | undefined
}

/**
 * Builds the `model_cooldown` response: HTTP 429, a `Retry-After` header of
 * the ceiling of the reset in seconds, and the alphabetical-key body:
 *
 * `{"error":{"code":"model_cooldown","last_upstream_error":...,"message":
 * "All credentials for model <m> are cooling down[ via provider <p>][ (last
 * error: <summary>)]","model":...,"provider":...,"reset_seconds":...,
 * "reset_time":"..."}}`
 *
 * `reset_time` renders the same ceiling (sub-second remainders read as
 * `1s`).
 */
export function buildModelCooldownResponse(facts: ModelCooldownFacts): SchedulingErrorResponse {
  const resetSeconds = Math.ceil(facts.resetMs / 1000)
  const summary =
    facts.lastUpstreamError !== undefined && facts.lastUpstreamError !== ''
      ? sanitizeUpstreamErrorSummary(facts.lastUpstreamError)
      : undefined
  let message = `All credentials for model ${facts.model} are cooling down`
  if (facts.provider !== undefined && facts.provider !== '') {
    message += ` via provider ${facts.provider}`
  }
  if (summary !== undefined) {
    message += ` (last error: ${summary})`
  }
  const error: Record<string, string | number> = {
    code: 'model_cooldown',
    last_upstream_error: summary ?? '',
    message,
    model: facts.model,
    provider: facts.provider ?? '',
    reset_seconds: resetSeconds,
    reset_time: formatGoDurationMs(resetSeconds * 1000),
  }
  return {
    status: 429,
    headers: { 'Retry-After': String(resetSeconds) },
    body: JSON.stringify({ error }),
  }
}

/** Facts of a no-credential selection used to build the 503 payload. */
export interface AuthSelectionFacts {
  readonly reason: AuthSelectionReason
  /** Providers registered for the model, in registration order. */
  readonly providers: readonly string[]
  readonly model: string
  readonly lastUpstreamError?: string | undefined
}

/**
 * The enriched `no auth available` message shared by the 503 shapes:
 * `<reason>: no auth available (providers=<p1,p2>, model=<model>[; last
 * upstream error: <summary>])`. Providers and model default to `unknown`;
 * a provider list containing `claude` appends the management hint after
 * the closing parenthesis.
 */
export function authSelectionMessage(facts: AuthSelectionFacts): string {
  const providers = facts.providers.length > 0 ? facts.providers.join(',') : 'unknown'
  const model = facts.model !== '' ? facts.model : 'unknown'
  const summary =
    facts.lastUpstreamError !== undefined && facts.lastUpstreamError !== ''
      ? sanitizeUpstreamErrorSummary(facts.lastUpstreamError)
      : undefined
  let message = `${facts.reason}: no auth available (providers=${providers}, model=${model}`
  if (summary !== undefined) {
    message += `; last upstream error: ${summary}`
  }
  message += ')'
  if (facts.providers.includes('claude')) {
    message +=
      '; check Claude auth/key session and cooldown state via /v0/management/auth-files'
  }
  return message
}

/**
 * The bare message of surfaces without provider/model context (recorded on
 * the codex-only routes): `<reason>: no auth available`.
 */
export function bareAuthSelectionMessage(reason: AuthSelectionReason): string {
  return `${reason}: no auth available`
}

/**
 * Builds the auth-selection 503 response for a non-quota exhaustion: no
 * ready credential (or none registered). Struct order fixed:
 * `{"error":{"message":...,"type":"server_error","code":"internal_server_error"}}`.
 */
export function buildAuthUnavailableResponse(facts: AuthSelectionFacts): SchedulingErrorResponse {
  const error: Record<string, string> = {
    message: authSelectionMessage(facts),
    type: 'server_error',
    code: 'internal_server_error',
  }
  return { status: 503, headers: {}, body: JSON.stringify({ error }) }
}

/**
 * Builds the terminal authentication 503 response for an all-unauthorized
 * credential pool: `{"error":{"message":...,"type":"authentication_error",
 * "code":"upstream_authentication_required","retryable":false}}`. The
 * message keeps the enriched auth-selection form.
 */
export function buildTerminalAuthResponse(facts: AuthSelectionFacts): SchedulingErrorResponse {
  const error: Record<string, string | boolean> = {
    message: authSelectionMessage(facts),
    type: 'authentication_error',
    code: 'upstream_authentication_required',
    retryable: false,
  }
  return { status: 503, headers: {}, body: JSON.stringify({ error }) }
}
