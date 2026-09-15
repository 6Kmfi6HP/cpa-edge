/**
 * Failure classification: how an upstream or transport failure changes
 * rotation, cooldown and retry decisions, including the route-contextual
 * overrides for count-tokens endpoints, `/responses/compact` and the
 * `store:false` item-not-persisted 404.
 *
 * The classifier is a pure decision function. It never talks to the Store
 * and never reads the clock; the cooldown tracker consumes its output.
 */

/** Route context that changes how failures are classified. */
export type RouteKind = 'default' | 'count-tokens' | 'responses-compact'

/** The failure families the scheduler distinguishes. */
export type FailureKind =
  | 'request_scoped'
  | 'connection_lifecycle'
  | 'transient_transport'
  | 'model_not_found'
  | 'quota'
  | 'unauthorized'
  | 'invalid_grant'
  | 'payment_required'
  | 'not_found'
  | 'transient'
  | 'cloudflare'
  | 'request_failed'
  | 'force_cooldown'

/** Actions of a `request-scoped-errors` rule. */
export type RequestScopedRuleAction = 'stop' | 'stop-and-cooldown' | 'continue' | 'continue-and-cooldown'

/** One `request-scoped-errors` rule of a credential or provider. */
export interface RequestScopedRule {
  /** HTTP status the rule applies to; `undefined` matches any status. */
  readonly status?: number | undefined
  /** Substrings of the error text; any one matching applies the rule. */
  readonly match?: readonly string[] | undefined
  /** Regular expressions over the error text; any one matching applies. */
  readonly matchRegex?: readonly string[] | undefined
  readonly action: RequestScopedRuleAction
}

/** Everything the classifier needs to know about one failure. */
export interface FailureInput {
  /** Upstream HTTP status; `undefined` for pre-HTTP transport errors. */
  readonly httpStatus?: number | undefined
  /** Raw upstream response body, when one arrived. */
  readonly bodyText?: string | undefined
  /** Transport-level error text (no HTTP response), when applicable. */
  readonly errorMessage?: string | undefined
  /** Executor says the failure is credential-wide (unified rate limits). */
  readonly credentialScoped?: boolean | undefined
  /** Executor says the response carries a Cloudflare challenge. */
  readonly cloudflareChallenge?: boolean | undefined
  /** OAuth layer says the failure is an `invalid_grant`. */
  readonly invalidGrant?: boolean | undefined
  /** Route the request was served on. */
  readonly route?: RouteKind | undefined
  /** `request-scoped-errors` rules of the credential (and its provider). */
  readonly requestScopedRules?: readonly RequestScopedRule[] | undefined
}

/** The scheduling decisions derived from one failure. */
export interface FailureClassification {
  readonly kind: FailureKind
  /** Whether same-request rotation to the next credential continues. */
  readonly rotation: 'stop' | 'continue'
  /** `ladder` applies the kind's cooldown table; `force` is the 60 s
   * force-cooldown that survives `disable-cooling`; `none` cools nothing. */
  readonly cooldown: 'none' | 'ladder' | 'force'
  /** Neutral failures change no scheduler state and skip quota observation. */
  readonly neutral: boolean
  /** Whether the failure may start an additional retry round. */
  readonly retryRoundEligible: boolean
  /** Whether a quota failure is credential-wide (propagates to siblings). */
  readonly credentialScoped: boolean
  /** Neutral failures skip quota observation; everything else observes. */
  readonly skipQuotaObservation: boolean
  /** Status message recorded in the credential's model state. */
  readonly statusMessage: string
}

/**
 * Error codes of request-fault bodies: caller-attributed failures that stop
 * rotation at the first failing credential.
 */
export const REQUEST_FAULT_CODES: readonly string[] = Object.freeze([
  'cyber_policy',
  'context_length_exceeded',
  'message_too_big',
  'string_above_max_string',
  'invalid_prompt',
  'invalid_value',
  'unsupported_value',
  'invalid_request_error',
  'previous_response_not_found',
])

/** Error types of request-fault bodies. */
export const REQUEST_FAULT_TYPES: readonly string[] = Object.freeze([
  'invalid_request',
  'invalid_request_error',
  'bad_request_error',
  'invalid_prompt',
])

/** Statuses that make a `/responses/compact` failure stop at the first credential. */
export const COMPACT_FAULT_STOP_STATUSES: readonly number[] = Object.freeze([400, 404, 405, 409, 413, 422, 501])

/** Statuses that still cool normally on `/responses/compact`. */
export const COMPACT_COOLDOWN_STATUSES: readonly number[] = Object.freeze([401, 402, 403, 429])

/** Statuses that admit an additional retry round. */
export const RETRY_ROUND_STATUSES: readonly number[] = Object.freeze([403, 408, 429, 500, 502, 503, 504])

/**
 * Parses text as JSON when possible. Unparseable text is not an error here:
 * upstream bodies are best-effort material, and every caller treats a
 * missing object as "no structured fields available".
 */
export function tryParseJson(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined || text === '') return undefined
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return undefined
  } catch {
    // Lenient by contract: a body that is not a JSON object carries no
    // structured error fields, and the classifier falls back to text
    // matching instead.
    return undefined
  }
}

function readErrorObject(parsed: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const error = parsed?.['error']
  if (typeof error === 'object' && error !== null && !Array.isArray(error)) {
    return error as Record<string, unknown>
  }
  return undefined
}

function readString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key]
  return typeof value === 'string' ? value : undefined
}

/**
 * Whether the failure carries a request-fault body. Statuses 402 and 429
 * and authentication-error 401 bodies stay credential-attributed even when
 * their bodies carry fault markers.
 */
export function isRequestFaultBody(httpStatus: number | undefined, bodyText: string | undefined): boolean {
  const parsed = tryParseJson(bodyText)
  const errorObject = readErrorObject(parsed)
  const code = readString(errorObject, 'code') ?? readString(parsed, 'code')
  const type = readString(errorObject, 'type') ?? readString(parsed, 'type')
  if (code !== undefined && (REQUEST_FAULT_CODES as readonly string[]).includes(code)) return true
  if (type !== undefined && (REQUEST_FAULT_TYPES as readonly string[]).includes(type)) return true
  return false
}

/** Whether a body is an explicit model-not-found shape. */
export function isModelNotFoundShape(bodyText: string | undefined): boolean {
  const parsed = tryParseJson(bodyText)
  const errorObject = readErrorObject(parsed)
  const code = readString(errorObject, 'code')
  if (code === 'model_not_found') return true
  const message = readString(errorObject, 'message')
  return message !== undefined && message.toLowerCase().includes('model not found')
}

/**
 * Whether a body text is the `store:false` item-not-persisted 404: rotation
 * stops at the first failing credential and no cooldown is applied.
 */
export function isItemNotPersistedShape(bodyText: string | undefined): boolean {
  if (bodyText === undefined) return false
  const lowered = bodyText.toLowerCase()
  return (
    lowered.includes('item with id') &&
    lowered.includes('not found') &&
    lowered.includes('items are not persisted when `store` is set to false')
  )
}

/**
 * Best-effort Cloudflare challenge detection: a 403/503 whose body carries
 * challenge markers. Executors can pass their own, more precise signal via
 * `cloudflareChallenge`, which always wins.
 */
export function looksLikeCloudflareChallenge(httpStatus: number | undefined, bodyText: string | undefined): boolean {
  if (httpStatus !== 403 && httpStatus !== 503) return false
  if (bodyText === undefined) return false
  const lowered = bodyText.toLowerCase()
  return lowered.includes('cloudflare') || lowered.includes('just a moment') || lowered.includes('attention required')
}

/**
 * Matches `request-scoped-errors` rules against a failure. A rule matches
 * when its status (when set) equals the failure status, its `match`
 * substrings (when set) include one contained in the text, and its
 * `match-regex` patterns (when set) include one matching the text.
 */
export function matchRequestScopedRule(
  rules: readonly RequestScopedRule[] | undefined,
  httpStatus: number | undefined,
  errorText: string,
): RequestScopedRuleAction | undefined {
  if (rules === undefined) return undefined
  for (const rule of rules) {
    if (rule.status !== undefined && rule.status !== httpStatus) continue
    if (rule.match !== undefined && rule.match.length > 0) {
      const hit = rule.match.some((needle) => needle !== '' && errorText.includes(needle))
      if (!hit) continue
    }
    if (rule.matchRegex !== undefined && rule.matchRegex.length > 0) {
      let matched = false
      for (const pattern of rule.matchRegex) {
        // An invalid pattern cannot match anything; skipping it is the only
        // safe interpretation for operator-authored regexes.
        try {
          if (new RegExp(pattern).test(errorText)) {
            matched = true
            break
          }
        } catch {
          continue
        }
      }
      if (!matched) continue
    }
    return rule.action
  }
  return undefined
}

function isLifecycleError(message: string): boolean {
  const lowered = message.toLowerCase()
  return (
    lowered.includes('context canceled') ||
    lowered.includes('deadline exceeded') ||
    lowered.includes('unexpected eof') ||
    lowered.includes('client disconnect') ||
    lowered.includes('dropped connection') ||
    lowered.includes('websocket close 1000') ||
    lowered.includes('websocket close 1001') ||
    lowered.includes('websocket close 1006') ||
    lowered === 'eof' ||
    lowered.endsWith(' eof')
  )
}

function ladderClassification(
  httpStatus: number | undefined,
  options: { credentialScoped: boolean; cloudflare: boolean; invalidGrant: boolean },
): { kind: FailureKind; statusMessage: string } {
  if (options.invalidGrant) return { kind: 'invalid_grant', statusMessage: 'invalid_grant' }
  switch (httpStatus) {
    case 401:
      return { kind: 'unauthorized', statusMessage: 'unauthorized' }
    case 402:
    case 403:
      return { kind: 'payment_required', statusMessage: 'payment_required' }
    case 404:
      return { kind: 'not_found', statusMessage: 'not_found' }
    case 429:
      return { kind: 'quota', statusMessage: 'quota exhausted' }
    case 408:
    case 500:
    case 502:
    case 503:
    case 504:
    case 520:
    case 521:
    case 522:
    case 523:
    case 524:
    case 525:
    case 526:
      return { kind: 'transient', statusMessage: 'transient upstream error' }
    default:
      return { kind: 'request_failed', statusMessage: 'request failed' }
  }
}

function stopClassification(kind: FailureKind, statusMessage: string): FailureClassification {
  return {
    kind,
    rotation: 'stop',
    cooldown: 'none',
    neutral: false,
    retryRoundEligible: false,
    credentialScoped: false,
    skipQuotaObservation: false,
    statusMessage,
  }
}

/**
 * Classifies one failure into scheduling decisions, applying the
 * route-contextual rules. Precedence: an explicit model-not-found shape
 * wins first; then request-scoped rules; then the request-fault stop rule;
 * then lifecycle and transport shapes; then the raw status ladder under
 * the route overrides.
 */
export function classifyFailure(input: FailureInput): FailureClassification {
  const route: RouteKind = input.route ?? 'default'
  const httpStatus = input.httpStatus
  const bodyText = input.bodyText
  const credentialScoped = input.credentialScoped === true
  const cloudflare = input.cloudflareChallenge === true || looksLikeCloudflareChallenge(httpStatus, bodyText)
  const invalidGrant =
    input.invalidGrant === true || (bodyText !== undefined && bodyText.includes('invalid_grant'))
  const errorText = input.errorMessage ?? bodyText ?? ''

  // 1. An explicit model-not-found shape always means a 12 h model-scoped
  // cooldown and continues rotation, on every route.
  if (isModelNotFoundShape(bodyText)) {
    return {
      kind: 'model_not_found',
      rotation: 'continue',
      cooldown: 'ladder',
      neutral: false,
      retryRoundEligible: false,
      credentialScoped,
      skipQuotaObservation: false,
      statusMessage: 'model_not_supported',
    }
  }

  // 2. The `store:false` item-not-persisted 404 is a request-scoped stop.
  if (isItemNotPersistedShape(bodyText)) {
    return stopClassification('request_scoped', 'request_scoped')
  }

  // 3. Operator-authored request-scoped rules override the defaults.
  const ruleAction = matchRequestScopedRule(input.requestScopedRules, httpStatus, errorText)
  if (ruleAction !== undefined) {
    const force = ruleAction === 'stop-and-cooldown' || ruleAction === 'continue-and-cooldown'
    const stop = ruleAction === 'stop' || ruleAction === 'stop-and-cooldown'
    return {
      kind: force ? 'force_cooldown' : 'request_scoped',
      rotation: stop ? 'stop' : 'continue',
      cooldown: force ? 'force' : 'none',
      neutral: false,
      retryRoundEligible: false,
      credentialScoped: false,
      skipQuotaObservation: false,
      statusMessage: force ? 'transient upstream error' : 'request_scoped',
    }
  }

  // 4. Transport-level failures (no HTTP status): lifecycle errors never
  // cool and keep requests rotating within the round; other transport
  // errors are transient-transport - no cooldown, retry rounds allowed.
  if (httpStatus === undefined) {
    const lifecycle = isLifecycleError(errorText)
    const kind: FailureKind = lifecycle ? 'connection_lifecycle' : 'transient_transport'
    if (route === 'responses-compact' && !credentialScoped && !cloudflare && !invalidGrant) {
      // Transport failures on compact requests are availability-neutral.
      return {
        kind,
        rotation: 'continue',
        cooldown: 'none',
        neutral: true,
        retryRoundEligible: !lifecycle,
        credentialScoped: false,
        skipQuotaObservation: true,
        statusMessage: lifecycle ? 'connection lifecycle' : 'transient transport',
      }
    }
    return {
      kind,
      rotation: 'continue',
      cooldown: 'none',
      neutral: false,
      retryRoundEligible: !lifecycle,
      credentialScoped: false,
      skipQuotaObservation: false,
      statusMessage: lifecycle ? 'connection lifecycle' : 'transient transport',
    }
  }

  // 5. Request-fault stops: fault bodies and the 400/409/413/422 statuses -
  // except 402/429 and authentication-error 401 bodies, which stay
  // credential-attributed.
  const faultBody = isRequestFaultBody(httpStatus, bodyText)
  const faultStatus = httpStatus === 400 || httpStatus === 409 || httpStatus === 413 || httpStatus === 422
  const credentialAttributed = httpStatus === 401 || httpStatus === 402 || httpStatus === 429
  if ((faultBody || faultStatus) && !credentialAttributed) {
    if (route === 'responses-compact' && (credentialScoped || cloudflare || invalidGrant)) {
      // The compact fault-stop rule yields to these three failure shapes.
    } else {
      return stopClassification('request_scoped', 'request_scoped')
    }
  }

  const ladder = ladderClassification(httpStatus, { credentialScoped, cloudflare, invalidGrant })
  const kind = cloudflare && (httpStatus === 403 || httpStatus === 503) ? 'cloudflare' : ladder.kind
  const statusMessage = kind === 'cloudflare' ? 'cloudflare challenge' : ladder.statusMessage
  const retryRoundEligible =
    (RETRY_ROUND_STATUSES as readonly number[]).includes(httpStatus) || kind === 'transient_transport'

  // 6. Route overrides on the remaining (non-fault) failures.
  if (route === 'count-tokens' && httpStatus === 404) {
    // A count-tokens 404 that is not model-not-found-shaped is
    // availability-neutral: no cooldown, no scheduler state, rotation
    // continues, quota observation skipped.
    return {
      kind: 'not_found',
      rotation: 'continue',
      cooldown: 'none',
      neutral: true,
      retryRoundEligible: false,
      credentialScoped: false,
      skipQuotaObservation: true,
      statusMessage: 'not_found',
    }
  }
  if (route === 'responses-compact') {
    const excepted = credentialScoped || cloudflare || invalidGrant
    if (!excepted && (COMPACT_FAULT_STOP_STATUSES as readonly number[]).includes(httpStatus)) {
      return stopClassification('request_scoped', 'request_scoped')
    }
    if (!excepted && !(COMPACT_COOLDOWN_STATUSES as readonly number[]).includes(httpStatus)) {
      // Every other compact failure is neutral: rotation continues, no
      // cooldown, no scheduler state change.
      return {
        kind,
        rotation: 'continue',
        cooldown: 'none',
        neutral: true,
        retryRoundEligible,
        credentialScoped: false,
        skipQuotaObservation: true,
        statusMessage,
      }
    }
  }

  // 7. The default ladder: cooldown applies, rotation continues.
  return {
    kind,
    rotation: 'continue',
    cooldown: 'ladder',
    neutral: false,
    retryRoundEligible,
    credentialScoped,
    skipQuotaObservation: false,
    statusMessage,
  }
}
