import { describe, expect, it } from 'vitest'
import {
  formatRfc3339,
  goDurationString,
  goJsonStringify,
  goQueryEscape,
  goValuesEncode,
  jsonStringifyOrdered,
  parseFormValues,
  parseGoUrl,
  parseQueryString,
  parseRfc3339Ms,
} from './wire'

describe('goJsonStringify', () => {
  it('sorts object keys alphabetically like a Go map marshal', () => {
    expect(goJsonStringify({ url: 'u', status: 'ok', state: 's' })).toBe(
      '{"state":"s","status":"ok","url":"u"}',
    )
  })

  it('escapes ampersands and angle brackets like Go HTML escaping', () => {
    expect(goJsonStringify({ url: 'a&b<c>d' })).toBe('{"url":"a\\u0026b\\u003cc\\u003ed"}')
  })

  it('sorts nested object keys too', () => {
    const body = goJsonStringify({
      error: { type: 'authentication_error', param: null, message: 'x', code: 'y' },
    })
    expect(body).toBe('{"error":{"code":"y","message":"x","param":null,"type":"authentication_error"}}')
  })

  it('keeps array order and encodes primitives', () => {
    expect(goJsonStringify({ keys: ['b', 'a'], n: 1, t: true, z: null })).toBe(
      '{"keys":["b","a"],"n":1,"t":true,"z":null}',
    )
  })

  it('emits the recorded realtime failure bodies byte-exactly', () => {
    expect(
      goJsonStringify({
        error: {
          code: 'invalid_api_key',
          message: 'Missing API key',
          param: null,
          type: 'authentication_error',
        },
      }),
    ).toBe(
      '{"error":{"code":"invalid_api_key","message":"Missing API key","param":null,"type":"authentication_error"}}',
    )
    expect(
      goJsonStringify({
        error: {
          code: 'invalid_realtime_client_secret',
          message: 'Realtime client secret is invalid or expired',
          param: null,
          type: 'invalid_request_error',
        },
      }),
    ).toBe(
      '{"error":{"code":"invalid_realtime_client_secret","message":"Realtime client secret is invalid or expired","param":null,"type":"invalid_request_error"}}',
    )
  })

  it('jsonStringifyOrdered preserves insertion order for wire requests', () => {
    expect(jsonStringifyOrdered({ grant_type: 'a', code: 'b' })).toBe('{"grant_type":"a","code":"b"}')
  })
})

describe('goDurationString', () => {
  it('rounds to the nearest second and formats like Go', () => {
    expect(goDurationString(30 * 60_000 - 100)).toBe('30m0s')
    expect(goDurationString(30 * 60_000 - 400)).toBe('30m0s')
    expect(goDurationString(30 * 60_000 - 600)).toBe('29m59s')
    expect(goDurationString(29 * 60_000 + 59_000)).toBe('29m59s')
    expect(goDurationString(3600_000)).toBe('1h0m0s')
    expect(goDurationString(90 * 60_000)).toBe('1h30m0s')
    expect(goDurationString(59_400)).toBe('59s')
    expect(goDurationString(59_600)).toBe('1m0s')
    expect(goDurationString(0)).toBe('0s')
    expect(goDurationString(-5)).toBe('0s')
  })
})

describe('Go query encoding', () => {
  it('escapes spaces as plus and keeps the unreserved set', () => {
    expect(goQueryEscape('a b')).toBe('a+b')
    expect(goQueryEscape('user:profile user:inference')).toBe('user%3Aprofile+user%3Ainference')
    expect(goQueryEscape('http://localhost:54545/callback')).toBe(
      'http%3A%2F%2Flocalhost%3A54545%2Fcallback',
    )
    expect(goQueryEscape('abc-._~09')).toBe('abc-._~09')
  })

  it('sorts keys in url.Values.Encode order', () => {
    expect(
      goValuesEncode({
        state: 'zz',
        client_id: 'cid',
        code_challenge: 'cc',
      }),
    ).toBe('client_id=cid&code_challenge=cc&state=zz')
  })
})

describe('RFC3339 helpers', () => {
  it('formats seconds precision and parses back', () => {
    const ms = Date.UTC(2026, 8, 15, 16, 50, 49, 850)
    expect(formatRfc3339(ms)).toBe('2026-09-15T16:50:49Z')
    expect(parseRfc3339Ms(formatRfc3339(ms))).toBe(Date.UTC(2026, 8, 15, 16, 50, 49))
  })
})

describe('parseGoUrl', () => {
  it('rejects the recorded invalid redirect_url', () => {
    expect(parseGoUrl('http://%zz')).toBeUndefined()
  })

  it('accepts ordinary URLs and extracts the query', () => {
    expect(parseGoUrl('https://x.example/cb?code=1&state=2')?.query).toBe('code=1&state=2')
    expect(parseGoUrl('https://x.example/cb')?.query).toBe('')
  })

  it('rejects control characters and malformed schemes', () => {
    expect(parseGoUrl('http://a\u007fb')).toBeUndefined()
    expect(parseGoUrl('1http://bad')).toBeUndefined()
  })
})

describe('form parsing', () => {
  it('decodes plus and percent escapes', () => {
    expect(parseFormValues('a=1&b=x+y&c=%2Fp')).toEqual({ a: '1', b: 'x y', c: '/p' })
    expect(parseQueryString('?code=1&state=2')).toEqual({ code: '1', state: '2' })
  })
})
