import { describe, expect, it } from 'vitest'
import { CpaError, ERROR_CODES, createErrorEnvelope, isErrorCode, isErrorEnvelope } from './errors'
import type { ErrorCode } from './errors'

describe('error registry', () => {
  it('holds exactly the platform codes', () => {
    expect(ERROR_CODES).toEqual([
      'not-found',
      'invalid-input',
      'unauthorized',
      'forbidden',
      'rate-limited',
      'quota-exhausted',
      'upstream-error',
      'timeout',
      'conflict',
      'unavailable',
    ])
  })

  it('is frozen', () => {
    expect(Object.isFrozen(ERROR_CODES)).toBe(true)
  })

  it('builds envelopes from code, message and details', () => {
    const envelope = createErrorEnvelope('rate-limited', 'slow down', { retryAfter: 30 })
    expect(envelope).toEqual({ code: 'rate-limited', message: 'slow down', details: { retryAfter: 30 } })
    expect(Object.isFrozen(envelope)).toBe(true)
    expect(Object.isFrozen(envelope.details)).toBe(true)
  })

  it('omits the details key when no details are given', () => {
    const envelope = createErrorEnvelope('timeout', 'too slow')
    expect(Object.keys(envelope)).toEqual(['code', 'message'])
    expect(envelope.details).toBeUndefined()
  })

  it('rejects unknown codes at runtime', () => {
    expect(() => createErrorEnvelope('made-up' as unknown as ErrorCode, 'x')).toThrow(CpaError)
    expect(() => new CpaError('made-up' as unknown as ErrorCode, 'x')).toThrow(CpaError)
  })

  it('rejects non-string messages', () => {
    expect(() => createErrorEnvelope('timeout', 42 as unknown as string)).toThrow(CpaError)
  })

  it('rejects details JSON cannot encode', () => {
    expect(() =>
      createErrorEnvelope('conflict', 'clash', { reason: undefined as unknown as number }),
    ).toThrow(CpaError)
    expect(() =>
      new CpaError('conflict', 'clash', { reason: (() => 1) as unknown as number }),
    ).toThrow(CpaError)
  })

  it('carries code, details, envelope and cause on CpaError', () => {
    const cause = new Error('socket closed')
    const error = new CpaError('upstream-error', 'provider failed', { status: 503 }, cause)
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('CpaError')
    expect(error.code).toBe('upstream-error')
    expect(error.message).toBe('provider failed')
    expect(error.details).toEqual({ status: 503 })
    expect(error.cause).toBe(cause)
    expect(error.envelope).toEqual({
      code: 'upstream-error',
      message: 'provider failed',
      details: { status: 503 },
    })
    expect(JSON.parse(JSON.stringify(error))).toEqual(error.envelope)
  })

  it('narrows codes with isErrorCode', () => {
    for (const code of ERROR_CODES) {
      expect(isErrorCode(code)).toBe(true)
    }
    expect(isErrorCode('made-up')).toBe(false)
    expect(isErrorCode(42)).toBe(false)
    expect(isErrorCode(undefined)).toBe(false)
  })

  it('narrows envelopes with isErrorEnvelope', () => {
    const envelope = createErrorEnvelope('unavailable', 'try later')
    expect(isErrorEnvelope(envelope)).toBe(true)
    expect(isErrorEnvelope(JSON.parse(JSON.stringify(envelope)))).toBe(true)
    expect(isErrorEnvelope(null)).toBe(false)
    expect(isErrorEnvelope('timeout')).toBe(false)
    expect(isErrorEnvelope({ code: 'timeout' })).toBe(false)
    expect(isErrorEnvelope({ code: 'made-up', message: 'x' })).toBe(false)
    expect(isErrorEnvelope({ code: 'timeout', message: 'm', details: { hole: undefined } })).toBe(false)
  })
})
