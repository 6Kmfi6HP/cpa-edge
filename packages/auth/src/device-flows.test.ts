import { describe, expect, it } from 'vitest'
import {
  deviceDeadlineMs,
  pollCodexDeviceToken,
  pollKimiDeviceToken,
  pollMetaDeviceToken,
  pollXaiDeviceToken,
  startCodexDeviceLogin,
  startKimiDeviceLogin,
  startMetaDeviceLogin,
  startXaiDeviceLogin,
  type DeviceLoginStart,
} from './device-flows'
import type { FetchLike } from './types'

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status })
}

function start(overrides: Partial<DeviceLoginStart> = {}): DeviceLoginStart {
  return {
    deviceCode: 'dev-1',
    userCode: 'ABCD',
    verificationUriComplete: 'https://vendor/device',
    intervalMs: 5_000,
    expiresInSeconds: 600,
    tokenEndpoint: 'https://vendor/token',
    ...overrides,
  }
}

function deps(fetchFn: FetchLike, nowFn: () => number, sleeper: (ms: number) => Promise<void>) {
  return { fetch: fetchFn, now: nowFn, sleep: sleeper }
}

/** Clock that only advances when the poller sleeps. */
function steppingClock(startMs: number): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let value = startMs
  return {
    now: () => value,
    sleep: async (ms: number) => {
      value += ms
    },
  }
}

describe('device authorization starters', () => {
  it('starts the kimi flow against the fixed endpoint', async () => {
    let seen = ''
    const fetchFn: FetchLike = async (url, init) => {
      seen = `${init?.method} ${url} ${init?.body ?? ''}`
      return jsonResponse({
        device_code: 'dev-1',
        user_code: 'ABCD',
        verification_uri_complete: 'https://auth.kimi.com/device?user_code=ABCD',
        expires_in: 600,
        interval: 5,
      })
    }
    const started = await startKimiDeviceLogin({ fetch: fetchFn })
    expect(started.deviceCode).toBe('dev-1')
    expect(started.intervalMs).toBe(5_000)
    expect(seen).toBe('POST https://auth.kimi.com/api/oauth/device_authorization client_id=17e5f671-d194-4dfb-9706-5516cb48c098')
  })

  it('rejects xai discovery endpoints outside the https x.ai origin', async () => {
    const badFetch: FetchLike = async () =>
      jsonResponse({
        device_authorization_endpoint: 'http://auth.x.ai/device',
        token_endpoint: 'https://auth.x.ai/token',
      })
    await expect(startXaiDeviceLogin({ fetch: badFetch })).rejects.toThrow()
    const offOrigin: FetchLike = async () =>
      jsonResponse({
        device_authorization_endpoint: 'https://evil.example/device',
        token_endpoint: 'https://auth.x.ai/token',
      })
    await expect(startXaiDeviceLogin({ fetch: offOrigin })).rejects.toThrow()
  })

  it('starts the xai flow from discovery', async () => {
    let call = 0
    const fetchFn: FetchLike = async (url) => {
      call += 1
      if (call === 1) {
        return jsonResponse({
          device_authorization_endpoint: 'https://auth.x.ai/device',
          token_endpoint: 'https://auth.x.ai/token',
        })
      }
      return jsonResponse({ device_code: 'd', user_code: 'U', verification_uri_complete: 'v' })
    }
    const started = await startXaiDeviceLogin({ fetch: fetchFn })
    expect(started.tokenEndpoint).toBe('https://auth.x.ai/token')
    expect(started.intervalMs).toBe(5_000)
  })

  it('starts the meta flow with the pinned user agent', async () => {
    let agent = ''
    const fetchFn: FetchLike = async (_url, init) => {
      agent = init?.headers?.['User-Agent'] ?? ''
      return jsonResponse({ device_code: 'd', user_code: 'U', verification_uri_complete: 'v' })
    }
    await startMetaDeviceLogin({ fetch: fetchFn })
    expect(agent).toBe('muse-code/1.0.2')
  })

  it('starts the codex device flow and normalizes the interval', async () => {
    const fetchFn: FetchLike = async (_url, init) => {
      expect(init?.body).toBe(JSON.stringify({ client_id: 'app_EMoamEEZ73f0CkXaXp7hrann' }))
      return jsonResponse({ device_auth_id: 'da-1', usercode: 'U', interval: '7' })
    }
    const started = await startCodexDeviceLogin({ fetch: fetchFn })
    expect(started.deviceAuthId).toBe('da-1')
    expect(started.userCode).toBe('U')
    expect(started.intervalMs).toBe(7_000)
    expect(started.verificationUriComplete).toBe('https://auth.openai.com/codex/device')
  })
})

describe('kimi poll semantics', () => {
  const base = start()

  it('treats slow_down as a no-op at the same interval (O-5)', async () => {
    const clock = steppingClock(0)
    const responses = [
      jsonResponse({ error: 'slow_down' }),
      jsonResponse({ error: 'slow_down' }),
      jsonResponse({ access_token: 'a', refresh_token: 'r', token_type: 'Bearer', expires_in: 600 }),
    ]
    let call = 0
    const fetchFn: FetchLike = async () => {
      const response = responses[call]
      call += 1
      return response as Response
    }
    const result = await pollKimiDeviceToken(
      { start: base, deadlineAtMs: 60_000 },
      deps(fetchFn, clock.now, clock.sleep),
    )
    expect(result.ok).toBe(true)
    // Two pending polls at the fixed 5s interval each, then success.
    expect(clock.now()).toBe(15_000)
  })

  it('fails with the exact terminal messages', async () => {
    const clock = steppingClock(0)
    const expired = await pollKimiDeviceToken(
      { start: base, deadlineAtMs: 60_000 },
      deps(async () => jsonResponse({ error: 'expired_token' }), clock.now, clock.sleep),
    )
    expect(expired).toEqual({ ok: false, message: 'kimi: device code expired' })
    const denied = await pollKimiDeviceToken(
      { start: base, deadlineAtMs: 60_000 },
      deps(async () => jsonResponse({ error: 'access_denied' }), clock.now, clock.sleep),
    )
    expect(denied).toEqual({ ok: false, message: 'kimi: access denied by user' })
  })

  it('expires at the deadline', async () => {
    const clock = steppingClock(0)
    const result = await pollKimiDeviceToken(
      { start: base, deadlineAtMs: 0 },
      deps(async () => jsonResponse({ error: 'authorization_pending' }), clock.now, clock.sleep),
    )
    expect(result).toEqual({ ok: false, message: 'kimi: device code expired' })
  })
})

describe('xai poll semantics', () => {
  it('polls immediately, widens the interval on slow_down, and fails terminal errors', async () => {
    const clock = steppingClock(0)
    let call = 0
    const fetchFn: FetchLike = async () => {
      call += 1
      if (call === 1) return jsonResponse({ error: 'authorization_pending' }, 400)
      if (call === 2) return jsonResponse({ error: 'slow_down' }, 400)
      return jsonResponse({ error: 'expired_token' }, 400)
    }
    const result = await pollXaiDeviceToken(
      { start: start(), deadlineAtMs: 60_000 },
      deps(fetchFn, clock.now, clock.sleep),
    )
    expect(result).toEqual({ ok: false, message: 'xai: expired_token' })
    // immediate poll, then 5s, then 10s widened interval.
    expect(clock.now()).toBe(15_000)
  })
})

describe('meta poll semantics', () => {
  it('polls after one interval and mints the api key after success', async () => {
    const clock = steppingClock(0)
    let call = 0
    const bodies: string[] = []
    const fetchFn: FetchLike = async (url, init) => {
      call += 1
      bodies.push(`${url} ${init?.body ?? ''}`)
      if (call === 1) return jsonResponse({ error: 'authorization_pending' }, 400)
      if (call === 2) {
        return jsonResponse({ access_token: 'dca-1', token_type: 'Bearer', expires_in: 900 })
      }
      return jsonResponse({ api_key: 'minted-key', user_email: 'a@x.com', base_url: 'https://api.meta.ai/v1' })
    }
    const result = await pollMetaDeviceToken(
      { start: start(), deadlineAtMs: 60_000 },
      deps(fetchFn, clock.now, clock.sleep),
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect((result.payload as Record<string, unknown>)['minted']).toBeDefined()
    }
    expect(bodies[1]).toContain('https://vendor/token')
    expect(bodies[2]).toContain('https://api.meta.ai/muse-code/key')
    expect(bodies[2]).toContain('"dca_token":"dca-1"')
  })

  it('keeps polling on an unexpected non-200 without an error body', async () => {
    const clock = steppingClock(0)
    let call = 0
    const fetchFn: FetchLike = async () => {
      call += 1
      if (call <= 2) return new Response('gateway junk', { status: 502 })
      return jsonResponse({ access_token: 'dca-1', token_type: 'Bearer', expires_in: 900 })
    }
    const result = await pollMetaDeviceToken(
      { start: start(), deadlineAtMs: 60_000 },
      deps(fetchFn, clock.now, clock.sleep),
    )
    expect(result.ok).toBe(true)
  })

  it('fails on unknown error strings', async () => {
    const clock = steppingClock(0)
    const result = await pollMetaDeviceToken(
      { start: start(), deadlineAtMs: 60_000 },
      deps(async () => jsonResponse({ error: 'server_error' }, 400), clock.now, clock.sleep),
    )
    expect(result).toEqual({ ok: false, message: 'meta: server_error' })
  })
})

describe('codex device poll semantics', () => {
  it('keeps polling on 403/404 and returns the code + PKCE pair on 2xx', async () => {
    const clock = steppingClock(0)
    let call = 0
    const fetchFn: FetchLike = async (_url, init) => {
      call += 1
      expect(init?.body).toBe(JSON.stringify({ device_auth_id: 'da-1', user_code: 'ABCD' }))
      if (call === 1) return new Response(null, { status: 403 })
      if (call === 2) return new Response(null, { status: 404 })
      return jsonResponse({ authorization_code: 'ac-1', code_verifier: 'cv-1', code_challenge: 'cc' })
    }
    const started = start({ deviceAuthId: 'da-1', tokenEndpoint: 'https://auth.openai.com/api/accounts/deviceauth/token' })
    const result = await pollCodexDeviceToken(
      { start: started, deadlineAtMs: 60_000 },
      deps(fetchFn, clock.now, clock.sleep),
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.payload['authorization_code']).toBe('ac-1')
      expect(result.payload['code_verifier']).toBe('cv-1')
    }
  })

  it('fails on other non-2xx statuses', async () => {
    const clock = steppingClock(0)
    const result = await pollCodexDeviceToken(
      { start: start({ deviceAuthId: 'da-1' }), deadlineAtMs: 60_000 },
      deps(async () => new Response(null, { status: 500 }), clock.now, clock.sleep),
    )
    expect(result).toEqual({ ok: false, message: 'codex: device token failed (500)' })
  })
})

describe('deviceDeadlineMs', () => {
  it('caps the deadline per provider and honors the vendor lifetime', () => {
    const now = 1_000
    expect(deviceDeadlineMs('xai', 3600, now)).toBe(now + 30 * 60_000)
    expect(deviceDeadlineMs('xai', 60, now)).toBe(now + 60_000)
    expect(deviceDeadlineMs('kimi', undefined, now)).toBe(now + 15 * 60_000)
    expect(deviceDeadlineMs('meta', undefined, now)).toBe(now + 15 * 60_000)
    expect(deviceDeadlineMs('codex', undefined, now)).toBe(now + 15 * 60_000)
  })
})
