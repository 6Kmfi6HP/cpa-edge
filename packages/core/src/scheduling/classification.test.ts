import { describe, expect, it } from 'vitest'
import type { RequestScopedRule } from './classification'
import {
  COMPACT_FAULT_STOP_STATUSES,
  RETRY_ROUND_STATUSES,
  classifyFailure,
  isItemNotPersistedShape,
  isModelNotFoundShape,
  isRequestFaultBody,
  looksLikeCloudflareChallenge,
  matchRequestScopedRule,
} from './classification'

const FAULT_BODY = '{"error": {"message": "mock rate limit", "type": "invalid_request_error", "code": "mock_error"}}'
const S4_20_BODY = '{"error": {"message": "mock codex: no handler for GET /responses", "type": "invalid_request_error"}}'
const MODEL_NOT_FOUND_BODY =
  '{"error": {"code": "model_not_found", "message": "model not found: mock-codex-upstream"}}'
const CLOUDFLARE_BODY = 'Attention Required! | Cloudflare - please wait while we verify'

describe('request-fault detection', () => {
  it('flags fault codes and types regardless of status; the ladder keeps 401/402/429 attributed', () => {
    // The body check is shape-only; the classification ladder decides which
    // statuses stay credential-attributed despite fault markers.
    expect(isRequestFaultBody(400, FAULT_BODY)).toBe(true)
    expect(isRequestFaultBody(404, S4_20_BODY)).toBe(true)
    expect(isRequestFaultBody(404, MODEL_NOT_FOUND_BODY)).toBe(false)
    expect(isRequestFaultBody(402, FAULT_BODY)).toBe(true)
    expect(isRequestFaultBody(429, FAULT_BODY)).toBe(true)
    expect(isRequestFaultBody(401, FAULT_BODY)).toBe(true)
    expect(isRequestFaultBody(200, '{"error": {"code": "cyber_policy"}}')).toBe(true)
    expect(isRequestFaultBody(200, '{"code": "previous_response_not_found"}')).toBe(true)
    // ... but those three statuses never become request_scoped:
    expect(classifyFailure({ httpStatus: 402, bodyText: FAULT_BODY }).kind).toBe('payment_required')
    expect(classifyFailure({ httpStatus: 429, bodyText: FAULT_BODY }).kind).toBe('quota')
    expect(classifyFailure({ httpStatus: 401, bodyText: FAULT_BODY }).kind).toBe('unauthorized')
  })

  it('recognizes model-not-found shapes', () => {
    expect(isModelNotFoundShape(MODEL_NOT_FOUND_BODY)).toBe(true)
    expect(isModelNotFoundShape('{"error": {"message": "The model X does not exist"}}')).toBe(false)
  })

  it('recognizes the store:false item-not-persisted 404 body', () => {
    const body =
      'Item with id resp_123 not found: items are not persisted when `store` is set to false.'
    expect(isItemNotPersistedShape(body)).toBe(true)
    expect(isItemNotPersistedShape('item with id missing second marker')).toBe(false)
    expect(isItemNotPersistedShape(undefined)).toBe(false)
  })

  it('detects Cloudflare challenges on 403/503 by body markers', () => {
    expect(looksLikeCloudflareChallenge(403, CLOUDFLARE_BODY)).toBe(true)
    expect(looksLikeCloudflareChallenge(503, 'just a moment...')).toBe(true)
    expect(looksLikeCloudflareChallenge(403, 'plain forbidden')).toBe(false)
    expect(looksLikeCloudflareChallenge(429, CLOUDFLARE_BODY)).toBe(false)
  })
})

describe('request-scoped rules', () => {
  it('matches on status and any substring', () => {
    const rules: RequestScopedRule[] = [{ status: 400, match: ['mock'], action: 'continue' }]
    expect(matchRequestScopedRule(rules, 400, 'mock rate limit')).toBe('continue')
    expect(matchRequestScopedRule(rules, 401, 'mock rate limit')).toBeUndefined()
    expect(matchRequestScopedRule(rules, 400, 'other')).toBeUndefined()
  })

  it('matches on regex patterns', () => {
    const rules: RequestScopedRule[] = [{ matchRegex: ['quota.*exceeded'], action: 'stop-and-cooldown' }]
    expect(matchRequestScopedRule(rules, 429, 'quota window exceeded')).toBe('stop-and-cooldown')
    expect(matchRequestScopedRule(rules, 429, 'nope')).toBeUndefined()
    // An invalid pattern never matches, so the rule is skipped.
    const invalid: RequestScopedRule[] = [{ matchRegex: ['['], action: 'stop' }, { action: 'continue' }]
    expect(matchRequestScopedRule(invalid, 500, 'text')).toBe('continue')
  })

  it('keeps a rule with no constraints always matching', () => {
    expect(matchRequestScopedRule([{ action: 'stop' }], 500, 'anything')).toBe('stop')
  })
})

describe('failure classification ladder', () => {
  it('stops at the first failing credential on request faults (S4-08, S4-20)', () => {
    for (const input of [
      { httpStatus: 400, bodyText: '{"error": {"message": "m", "type": "mock_error"}}' },
      { httpStatus: 400, bodyText: FAULT_BODY },
      { httpStatus: 409, bodyText: '' },
      { httpStatus: 413, bodyText: '' },
      { httpStatus: 422, bodyText: '' },
      { httpStatus: 404, bodyText: S4_20_BODY },
    ]) {
      const classification = classifyFailure(input)
      expect(classification.rotation).toBe('stop')
      expect(classification.cooldown).toBe('none')
      expect(classification.kind).toBe('request_scoped')
      expect(classification.retryRoundEligible).toBe(false)
    }
  })

  it('treats the string_above_max_length fault code as a request-scoped stop even on 502', () => {
    // A transient-looking status carrying the recorded fault code is
    // caller-attributed: rotation stops and nothing cools.
    const classification = classifyFailure({
      httpStatus: 502,
      bodyText: '{"error": {"code": "string_above_max_length", "message": "mock too long"}}',
    })
    expect(classification.kind).toBe('request_scoped')
    expect(classification.rotation).toBe('stop')
    expect(classification.cooldown).toBe('none')
    expect(classification.retryRoundEligible).toBe(false)
  })

  it('classifies 401 and invalid_grant as unauthorized failures', () => {
    const unauthorized = classifyFailure({ httpStatus: 401, bodyText: '{"error": "bad key"}' })
    expect(unauthorized.kind).toBe('unauthorized')
    expect(unauthorized.statusMessage).toBe('unauthorized')
    expect(unauthorized.rotation).toBe('continue')
    expect(unauthorized.retryRoundEligible).toBe(false)
    const grant = classifyFailure({ httpStatus: 401, bodyText: '{"error": "invalid_grant"}' })
    expect(grant.kind).toBe('invalid_grant')
    expect(grant.statusMessage).toBe('invalid_grant')
  })

  it('keeps 402 credential-attributed with fault bodies; 403 with a fault body stops', () => {
    const payment = classifyFailure({ httpStatus: 402, bodyText: FAULT_BODY })
    expect(payment.kind).toBe('payment_required')
    expect(payment.retryRoundEligible).toBe(false)
    // Only 402/429 and authentication-error 401 stay credential-attributed
    // against fault bodies; a 403 carrying one stops the rotation.
    const forbidden = classifyFailure({ httpStatus: 403, bodyText: FAULT_BODY })
    expect(forbidden.kind).toBe('request_scoped')
    expect(forbidden.rotation).toBe('stop')
    const cleanForbidden = classifyFailure({ httpStatus: 403, bodyText: '{"error": "denied"}' })
    expect(cleanForbidden.kind).toBe('payment_required')
    expect(cleanForbidden.retryRoundEligible).toBe(true)
  })

  it('classifies 404 as not_found and model-not-found as model_not_supported', () => {
    const notFound = classifyFailure({ httpStatus: 404, bodyText: '{"error": {"code": 404, "message": "mock rate limit", "status": "NOT_FOUND"}}' })
    expect(notFound.kind).toBe('not_found')
    expect(notFound.statusMessage).toBe('not_found')
    expect(notFound.rotation).toBe('continue')
    const modelNotFound = classifyFailure({ httpStatus: 404, bodyText: MODEL_NOT_FOUND_BODY })
    expect(modelNotFound.kind).toBe('model_not_found')
    expect(modelNotFound.statusMessage).toBe('model_not_supported')
  })

  it('classifies quota, transient and request-failed statuses', () => {
    const quota = classifyFailure({ httpStatus: 429, bodyText: '' })
    expect(quota.kind).toBe('quota')
    expect(quota.statusMessage).toBe('quota exhausted')
    expect(quota.retryRoundEligible).toBe(true)
    for (const status of [408, 500, 502, 503, 504, 520, 526]) {
      const transient = classifyFailure({ httpStatus: status, bodyText: '' })
      expect(transient.kind).toBe('transient')
      expect(transient.statusMessage).toBe('transient upstream error')
      expect((RETRY_ROUND_STATUSES as readonly number[]).includes(status)).toBe(
        status !== 520 && status !== 526,
      )
    }
    const other = classifyFailure({ httpStatus: 419, bodyText: '' })
    expect(other.kind).toBe('request_failed')
    expect(other.statusMessage).toBe('request failed')
    expect(other.retryRoundEligible).toBe(false)
  })

  it('admits exactly the recorded retry-round statuses plus transient transport', () => {
    expect(RETRY_ROUND_STATUSES).toEqual([403, 408, 429, 500, 502, 503, 504])
    const transport = classifyFailure({ errorMessage: 'dial tcp: connection refused' })
    expect(transport.kind).toBe('transient_transport')
    expect(transport.retryRoundEligible).toBe(true)
    expect(transport.cooldown).toBe('none')
  })

  it('treats lifecycle errors as cooldown-free, non-retryable', () => {
    for (const message of [
      'context canceled',
      'context deadline exceeded',
      'unexpected EOF',
      'websocket close 1006 (abnormal closure)',
    ]) {
      const lifecycle = classifyFailure({ errorMessage: message })
      expect(lifecycle.kind).toBe('connection_lifecycle')
      expect(lifecycle.cooldown).toBe('none')
      expect(lifecycle.retryRoundEligible).toBe(false)
      expect(lifecycle.rotation).toBe('continue')
    }
  })

  it('detects Cloudflare challenges as a quota-family ladder', () => {
    const challenge = classifyFailure({ httpStatus: 403, bodyText: CLOUDFLARE_BODY })
    expect(challenge.kind).toBe('cloudflare')
    expect(challenge.statusMessage).toBe('cloudflare challenge')
    const flagged = classifyFailure({ httpStatus: 403, bodyText: 'x', cloudflareChallenge: true })
    expect(flagged.kind).toBe('cloudflare')
  })

  it('honors request-scoped rule actions over the defaults (S4-09)', () => {
    const continueRule = classifyFailure({
      httpStatus: 400,
      bodyText: '{"error": {"message": "mock rate limit", "type": "mock_error", "code": "mock_error"}}',
      requestScopedRules: [{ status: 400, match: ['mock rate limit'], action: 'continue' }],
    })
    expect(continueRule.rotation).toBe('continue')
    expect(continueRule.cooldown).toBe('none')
    expect(continueRule.kind).toBe('request_scoped')
    expect(continueRule.statusMessage).toBe('request_scoped')
    const stopAndCooldown = classifyFailure({
      httpStatus: 500,
      bodyText: 'upstream exploded',
      requestScopedRules: [{ match: ['exploded'], action: 'stop-and-cooldown' }],
    })
    expect(stopAndCooldown.rotation).toBe('stop')
    expect(stopAndCooldown.cooldown).toBe('force')
    const continueAndCooldown = classifyFailure({
      httpStatus: 500,
      bodyText: 'upstream exploded',
      requestScopedRules: [{ match: ['exploded'], action: 'continue-and-cooldown' }],
    })
    expect(continueAndCooldown.rotation).toBe('continue')
    expect(continueAndCooldown.cooldown).toBe('force')
  })

  it('treats the store:false item-not-persisted 404 as a request-scoped stop', () => {
    const classification = classifyFailure({
      httpStatus: 404,
      bodyText: 'Item with id resp_1 not found: items are not persisted when `store` is set to false.',
    })
    expect(classification.kind).toBe('request_scoped')
    expect(classification.rotation).toBe('stop')
    expect(classification.cooldown).toBe('none')
  })
})

describe('route-contextual overrides', () => {
  it('count_tokens 404 is availability-neutral while other statuses classify normally (S4-22)', () => {
    const neutral = classifyFailure({
      route: 'count-tokens',
      httpStatus: 404,
      bodyText: '{"error": {"code": 404, "message": "mock rate limit", "status": "NOT_FOUND"}}',
    })
    expect(neutral.neutral).toBe(true)
    expect(neutral.rotation).toBe('continue')
    expect(neutral.cooldown).toBe('none')
    expect(neutral.skipQuotaObservation).toBe(true)
    const cooling = classifyFailure({ route: 'count-tokens', httpStatus: 429, bodyText: '' })
    expect(cooling.neutral).toBe(false)
    expect(cooling.kind).toBe('quota')
    const modelNotFound = classifyFailure({ route: 'count-tokens', httpStatus: 404, bodyText: MODEL_NOT_FOUND_BODY })
    expect(modelNotFound.kind).toBe('model_not_found')
    expect(modelNotFound.neutral).toBe(false)
  })

  it('/responses/compact stops on the fault statuses and neutralizes the rest (S4-23)', () => {
    for (const status of COMPACT_FAULT_STOP_STATUSES) {
      const stop = classifyFailure({ route: 'responses-compact', httpStatus: status, bodyText: '' })
      expect(stop.rotation).toBe('stop')
      expect(stop.cooldown).toBe('none')
    }
    const neutral = classifyFailure({
      route: 'responses-compact',
      httpStatus: 500,
      bodyText: '{"error": {"message": "mock rate limit", "type": "rate_limit_exceeded", "code": 500, "status": "INTERNAL"}}',
    })
    expect(neutral.neutral).toBe(true)
    expect(neutral.rotation).toBe('continue')
    expect(neutral.cooldown).toBe('none')
    const neutralTransport = classifyFailure({ route: 'responses-compact', errorMessage: 'dial tcp' })
    expect(neutralTransport.neutral).toBe(true)
  })

  it('/responses/compact keeps the excepted failures cooling normally', () => {
    const quota = classifyFailure({ route: 'responses-compact', httpStatus: 429, bodyText: '' })
    expect(quota.kind).toBe('quota')
    expect(quota.cooldown).toBe('ladder')
    const unauthorized = classifyFailure({ route: 'responses-compact', httpStatus: 401, bodyText: '' })
    expect(unauthorized.kind).toBe('unauthorized')
    const scoped = classifyFailure({
      route: 'responses-compact',
      httpStatus: 500,
      bodyText: '',
      credentialScoped: true,
    })
    expect(scoped.credentialScoped).toBe(true)
    const cloudflare = classifyFailure({ route: 'responses-compact', httpStatus: 503, bodyText: CLOUDFLARE_BODY })
    expect(cloudflare.kind).toBe('cloudflare')
    expect(cloudflare.cooldown).toBe('ladder')
    const forced = classifyFailure({
      route: 'responses-compact',
      httpStatus: 500,
      bodyText: 'x',
      requestScopedRules: [{ match: ['x'], action: 'continue-and-cooldown' }],
    })
    expect(forced.cooldown).toBe('force')
  })
})
