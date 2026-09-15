import { describe, expect, it } from 'vitest'
import {
  authSelectionMessage,
  bareAuthSelectionMessage,
  buildAuthUnavailableResponse,
  buildModelCooldownResponse,
  buildTerminalAuthResponse,
  formatGoDurationMs,
  sanitizeUpstreamErrorSummary,
} from './client-errors'

// Recorded upstream bodies (S4 fixtures) - the builders must reproduce
// these bytes exactly.
const MOCK_ERROR_BODY = '{"error": {"message": "mock rate limit", "type": "mock_error", "code": "mock_error"}}'

describe('upstream error summaries', () => {
  it('truncates summaries longer than 256 runes to 253 runes plus ellipsis', () => {
    const exact = 'x'.repeat(256)
    expect(sanitizeUpstreamErrorSummary(exact)).toBe(exact)
    const longer = 'x'.repeat(257)
    expect(sanitizeUpstreamErrorSummary(longer)).toBe(`${'x'.repeat(253)}...`)
    // Runes, not UTF-16 code units.
    const multibyte = 'é'.repeat(257)
    const sanitized = sanitizeUpstreamErrorSummary(multibyte)
    expect([...sanitized]).toHaveLength(256)
    expect(sanitized.endsWith('...')).toBe(true)
  })
})

describe('Go duration rendering', () => {
  it('renders seconds, minutes and hours like Go', () => {
    expect(formatGoDurationMs(1_000)).toBe('1s')
    expect(formatGoDurationMs(4_000)).toBe('4s')
    expect(formatGoDurationMs(91_000)).toBe('1m31s')
    expect(formatGoDurationMs(3_600_000)).toBe('1h0m0s')
    expect(formatGoDurationMs(9_000_000)).toBe('2h30m0s')
    expect(formatGoDurationMs(500)).toBe('500ms')
    expect(formatGoDurationMs(1_800_000)).toBe('30m0s')
  })
})

describe('model_cooldown response (429)', () => {
  const escapedBody = MOCK_ERROR_BODY.replaceAll('"', '\\"')

  it('reproduces the recorded S4-06 body byte for byte', () => {
    const response = buildModelCooldownResponse({
      model: 'mock-model',
      provider: 'openai-compatible-mock-openai',
      resetMs: 1_000,
      lastUpstreamError: MOCK_ERROR_BODY,
    })
    expect(response.status).toBe(429)
    expect(response.headers).toEqual({ 'Retry-After': '1' })
    expect(response.body).toBe(
      `{"error":{"code":"model_cooldown","last_upstream_error":"${escapedBody}","message":"All credentials for model mock-model are cooling down via provider openai-compatible-mock-openai (last error: ${escapedBody})","model":"mock-model","provider":"openai-compatible-mock-openai","reset_seconds":1,"reset_time":"1s"}}`,
    )
  })

  it('ceils sub-second remainders for the header, seconds and reset_time', () => {
    const response = buildModelCooldownResponse({
      model: 'gm',
      provider: 'gemini',
      resetMs: 200,
    })
    expect(response.headers['Retry-After']).toBe('1')
    expect(response.body).toContain('"reset_seconds":1')
    expect(response.body).toContain('"reset_time":"1s"')
    expect(response.body).toContain('"last_upstream_error":""')
    expect(response.body).toContain('"message":"All credentials for model gm are cooling down via provider gemini"')
  })

  it('omits the provider segment when no provider is known', () => {
    const response = buildModelCooldownResponse({ model: 'm', provider: undefined, resetMs: 90_400 })
    expect(response.body).toContain('"reset_seconds":91')
    expect(response.body).toContain('"reset_time":"1m31s"')
    expect(response.body).toContain('"provider":""')
    expect(response.body).toContain('"message":"All credentials for model m are cooling down"')
  })
})

describe('auth selection responses (503)', () => {
  const escapedBody = MOCK_ERROR_BODY.replaceAll('"', '\\"')

  it('reproduces the recorded S4-05 auth_unavailable body byte for byte', () => {
    const response = buildAuthUnavailableResponse({
      reason: 'auth_unavailable',
      providers: ['openai-compatible-mock-openai'],
      model: 'mock-model',
      lastUpstreamError: MOCK_ERROR_BODY,
    })
    expect(response.status).toBe(503)
    expect(response.body).toBe(
      `{"error":{"message":"auth_unavailable: no auth available (providers=openai-compatible-mock-openai, model=mock-model; last upstream error: ${escapedBody})","type":"server_error","code":"internal_server_error"}}`,
    )
  })

  it('reproduces the recorded S4-14 terminal authentication body byte for byte', () => {
    const response = buildTerminalAuthResponse({
      reason: 'auth_unavailable',
      providers: ['openai-compatible-mock-openai'],
      model: 'mock-model',
      lastUpstreamError: MOCK_ERROR_BODY,
    })
    expect(response.status).toBe(503)
    expect(response.body).toBe(
      `{"error":{"message":"auth_unavailable: no auth available (providers=openai-compatible-mock-openai, model=mock-model; last upstream error: ${escapedBody})","type":"authentication_error","code":"upstream_authentication_required","retryable":false}}`,
    )
  })

  it('defaults providers and model to unknown and renders the claude hint', () => {
    const claude = authSelectionMessage({ reason: 'auth_unavailable', providers: ['claude'], model: 'gm' })
    expect(claude).toBe(
      'auth_unavailable: no auth available (providers=claude, model=gm); check Claude auth/key session and cooldown state via /v0/management/auth-files',
    )
    const unknown = authSelectionMessage({ reason: 'auth_not_found', providers: [], model: '' })
    expect(unknown).toBe('auth_not_found: no auth available (providers=unknown, model=unknown)')
    expect(bareAuthSelectionMessage('auth_not_found')).toBe('auth_not_found: no auth available')
  })
})
