/**
 * Alarm-pass tests (mission T2, R3): the DO alarm drives token refresh
 * per the auth package's scheduling rule, runs one RFC-8628 poll step
 * per due device-flow session, sweeps stale usage records and idle
 * management-ban entries, and re-arms itself.
 */
import { describe, expect, it } from 'vitest'
import type { JsonValue, Store } from '@cpa-edge/core'
import {
  AUTH_FILES_NAMESPACE,
  formatRfc3339,
  KIMI,
  OAuthSessionRegistry,
  parseRfc3339Ms,
  RefreshRegistry,
  type FetchLike,
} from '@cpa-edge/auth'
import {
  DEVICE_POLL_PREFIX,
  IDLE_HEARTBEAT_MS,
  registerDevicePoll,
  REFRESH_QUEUE_KEY,
  runAlarmPass,
  SCHEDULER_NAMESPACE,
} from './alarm'
import { normalizeRuntimeConfig } from './config'
import { DurableObjectStore } from './do-store'
import { makeClock, SimulatedAlarm, SimulatedDoStorage } from './harness'

/** Scripted vendor egress: first matching reply wins. */
function scriptedFetch(
  routes: ReadonlyArray<readonly [string, () => { status: number; body: unknown }]>,
): { fetch: FetchLike; calls: Array<{ url: string; body: string }> } {
  const calls: Array<{ url: string; body: string }> = []
  const fake: FetchLike = (url, init) => {
    calls.push({ url, body: typeof init?.body === 'string' ? init.body : '' })
    for (const [prefix, reply] of routes) {
      if (url.startsWith(prefix)) {
        const out = reply()
        return Promise.resolve(new Response(JSON.stringify(out.body), { status: out.status }))
      }
    }
    return Promise.resolve(new Response('{}', { status: 500 }))
  }
  return { fetch: fake, calls }
}

function newStore(now: () => number): DurableObjectStore {
  return new DurableObjectStore(new SimulatedDoStorage(), { now })
}

/** Instant sleeper: the auth package's retry waits collapse in tests. */
const noSleep = async (): Promise<void> => {}

async function putAuthFile(store: Store, name: string, document: Record<string, JsonValue>): Promise<void> {
  await store.put(AUTH_FILES_NAMESPACE, name, document)
}

const config = () => normalizeRuntimeConfig({})

describe('alarm pass: token refresh', () => {
  it('refreshes a due claude credential and records the bookkeeping', async () => {
    const clock = makeClock(1_700_000_000_000)
    const store = newStore(clock.now)
    await putAuthFile(store, 'claude-test@ex.com.json', {
      type: 'claude',
      access_token: 'old-access',
      refresh_token: 'rt-1',
      email: 'test@ex.com',
      last_refresh: formatRfc3339(clock.now() - 6 * 60 * 60_000),
      expired: formatRfc3339(clock.now() + 60_000),
    })
    const { fetch, calls } = scriptedFetch([
      [
        'https://platform.claude.com/v1/oauth/token',
        () => ({ status: 200, body: { access_token: 'new-access', refresh_token: 'rt-2', expires_in: 3600 } }),
      ],
    ])
    const alarm = new SimulatedAlarm()
    await runAlarmPass({ store, now: clock.now, fetch, config, alarm, sleep: noSleep })

    expect(calls).toHaveLength(1)
    const refreshed = (await store.get(AUTH_FILES_NAMESPACE, 'claude-test@ex.com.json')) as Record<string, JsonValue>
    expect(refreshed['access_token']).toBe('new-access')
    expect(refreshed['refresh_token']).toBe('rt-2')
    expect(parseRfc3339Ms(String(refreshed['expired']))).toBeGreaterThan(clock.now())
    const registry = new RefreshRegistry(store, { now: clock.now })
    const bookkeeping = await registry.get('claude-test@ex.com.json')
    expect(bookkeeping.status).toBe('active')
    expect(bookkeeping.next_refresh_after).toBeUndefined()

    const queue = (await store.get(SCHEDULER_NAMESPACE, REFRESH_QUEUE_KEY)) as Record<string, JsonValue>
    expect(queue['entries']).toEqual([
      { file: 'claude-test@ex.com.json', provider: 'claude', dueAtMs: expect.any(Number) },
    ])
    // Re-armed: never later than the idle heartbeat.
    expect(alarm.lastArmed()).toBeLessThanOrEqual(clock.now() + IDLE_HEARTBEAT_MS)
  })

  it('skips proxy-credentialed credentials instead of refreshing direct', async () => {
    const clock = makeClock(1_700_000_000_000)
    const store = newStore(clock.now)
    await putAuthFile(store, 'claude-proxy@ex.com.json', {
      type: 'claude',
      access_token: 'old-access',
      refresh_token: 'rt-1',
      expired: formatRfc3339(clock.now() + 60_000),
      proxy_url: 'socks5://127.0.0.1:1080',
    })
    const { fetch, calls } = scriptedFetch([])
    const alarm = new SimulatedAlarm()
    await runAlarmPass({ store, now: clock.now, fetch, config, alarm, sleep: noSleep })
    expect(calls).toHaveLength(0)
    const refreshed = (await store.get(AUTH_FILES_NAMESPACE, 'claude-proxy@ex.com.json')) as Record<string, JsonValue>
    expect(refreshed['access_token']).toBe('old-access')
  })

  it('records an unauthorized refresh failure without a backoff', async () => {
    const clock = makeClock(1_700_000_000_000)
    const store = newStore(clock.now)
    await putAuthFile(store, 'codex-a@ex.com.json', {
      type: 'codex',
      access_token: 'old',
      refresh_token: 'rt-1',
      expired: formatRfc3339(clock.now() + 60_000),
    })
    const { fetch } = scriptedFetch([
      ['https://auth.openai.com/oauth/token', () => ({ status: 401, body: { error: 'invalid_grant' } })],
    ])
    await runAlarmPass({ store, now: clock.now, fetch, config, alarm: new SimulatedAlarm(), sleep: noSleep })
    const registry = new RefreshRegistry(store, { now: clock.now })
    const bookkeeping = await registry.get('codex-a@ex.com.json')
    expect(bookkeeping.status).toBe('error')
    expect(bookkeeping.status_message).toBe('unauthorized')
    expect(bookkeeping.next_refresh_after).toBeUndefined()
  })

  it('records a retryable refresh failure with the failure backoff', async () => {
    const clock = makeClock(1_700_000_000_000)
    const store = newStore(clock.now)
    await putAuthFile(store, 'claude-b@ex.com.json', {
      type: 'claude',
      access_token: 'old',
      refresh_token: 'rt-1',
      expired: formatRfc3339(clock.now() + 60_000),
    })
    const { fetch } = scriptedFetch([
      ['https://platform.claude.com/v1/oauth/token', () => ({ status: 503, body: {} })],
    ])
    await runAlarmPass({ store, now: clock.now, fetch, config, alarm: new SimulatedAlarm(), sleep: noSleep })
    const registry = new RefreshRegistry(store, { now: clock.now })
    const bookkeeping = await registry.get('claude-b@ex.com.json')
    expect(bookkeeping.status).toBe('error')
    expect(bookkeeping.next_refresh_after).toBeDefined()
  })

  it('leaves credentials whose token is comfortably fresh untouched', async () => {
    const clock = makeClock(1_700_000_000_000)
    const store = newStore(clock.now)
    await putAuthFile(store, 'claude-fresh@ex.com.json', {
      type: 'claude',
      access_token: 'still-good',
      refresh_token: 'rt-1',
      expired: formatRfc3339(clock.now() + 5 * 60 * 60_000),
      last_refresh: formatRfc3339(clock.now()),
    })
    const { fetch, calls } = scriptedFetch([])
    await runAlarmPass({ store, now: clock.now, fetch, config, alarm: new SimulatedAlarm(), sleep: noSleep })
    expect(calls).toHaveLength(0)
    const doc = (await store.get(AUTH_FILES_NAMESPACE, 'claude-fresh@ex.com.json')) as Record<string, JsonValue>
    expect(doc['access_token']).toBe('still-good')
  })
})

describe('alarm pass: device-flow polls', () => {
  async function seedKimiSession(
    store: Store,
    now: () => number,
    state: string,
  ): Promise<void> {
    const registry = new OAuthSessionRegistry(store, { now })
    await registry.register(state, 'kimi', {
      metadata: {
        device_code: 'dc-1',
        user_code: 'ABCD-EFGH',
        interval: 5_000,
        token_endpoint: 'http://vendor.example/token',
        verification_uri_complete: 'http://vendor.example/verify',
        expires_in: 900,
      },
    })
    expect(await registerDevicePoll(store, 'kimi', state, now)).toBe(true)
  }

  it('one poll step per alarm: pending stays pending with the next poll armed', async () => {
    const clock = makeClock(1_700_000_000_000)
    const store = newStore(clock.now)
    await seedKimiSession(store, clock.now, 'kmi-state-1')
    const { fetch, calls } = scriptedFetch([
      ['http://vendor.example/token', () => ({ status: 400, body: { error: 'authorization_pending' } })],
    ])
    await runAlarmPass({ store, now: clock.now, fetch, config, alarm: new SimulatedAlarm(), sleep: noSleep })
    // Kimi waits one interval before the first poll.
    expect(calls).toHaveLength(0)
    clock.advance(5_000)
    await runAlarmPass({ store, now: clock.now, fetch, config, alarm: new SimulatedAlarm(), sleep: noSleep })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.body).toContain(`client_id=${encodeURIComponent(KIMI.clientId)}`)
    expect(calls[0]?.body).toContain('grant_type=' + encodeURIComponent(KIMI.deviceGrant))
    const registry = new OAuthSessionRegistry(store, { now: clock.now })
    expect((await registry.get('kmi-state-1'))?.status).toBe('pending')
    const pollDoc = (await store.get(SCHEDULER_NAMESPACE, `${DEVICE_POLL_PREFIX}kmi-state-1`)) as Record<
      string,
      JsonValue
    >
    expect(pollDoc['next_poll_at_ms']).toBe(clock.now() + 5_000)
  })

  it('a completed poll persists the credential and completes the session', async () => {
    const clock = makeClock(1_700_000_000_000)
    const store = newStore(clock.now)
    await seedKimiSession(store, clock.now, 'kmi-state-2')
    const { fetch } = scriptedFetch([
      [
        'http://vendor.example/token',
        () => ({
          status: 200,
          body: { access_token: 'kimi-access', refresh_token: 'kimi-refresh', token_type: 'Bearer' },
        }),
      ],
    ])
    clock.advance(5_000)
    await runAlarmPass({ store, now: clock.now, fetch, config, alarm: new SimulatedAlarm(), sleep: noSleep })
    const files = await store.list(AUTH_FILES_NAMESPACE)
    expect(files).toHaveLength(1)
    expect(files[0]).toContain('kimi')
    const saved = (await store.get(AUTH_FILES_NAMESPACE, files[0] ?? '')) as Record<string, JsonValue>
    expect(saved['access_token']).toBe('kimi-access')
    expect(saved['refresh_token']).toBe('kimi-refresh')
    const registry = new OAuthSessionRegistry(store, { now: clock.now })
    const session = await registry.get('kmi-state-2')
    expect(session?.completed).toBe(true)
    await expect(
      store.get(SCHEDULER_NAMESPACE, `${DEVICE_POLL_PREFIX}kmi-state-2`),
    ).resolves.toBeUndefined()
  })

  it('a lapsed deadline marks the session with the recorded expiry message', async () => {
    const clock = makeClock(1_700_000_000_000)
    const store = newStore(clock.now)
    await seedKimiSession(store, clock.now, 'kmi-state-3')
    clock.advance(16 * 60_000)
    const { fetch, calls } = scriptedFetch([])
    await runAlarmPass({ store, now: clock.now, fetch, config, alarm: new SimulatedAlarm(), sleep: noSleep })
    expect(calls).toHaveLength(0)
    const registry = new OAuthSessionRegistry(store, { now: clock.now })
    const session = await registry.get('kmi-state-3')
    expect(session?.status).toBe('kimi: device code expired')
    expect(session?.completed).toBe(false)
  })

  it('xai slow_down widens the interval for the next poll', async () => {
    const clock = makeClock(1_700_000_000_000)
    const store = newStore(clock.now)
    const registry = new OAuthSessionRegistry(store, { now: clock.now })
    await registry.register('xai-state-1', 'xai', {
      metadata: {
        device_code: 'dc-x',
        user_code: 'WXYZ',
        interval: 5_000,
        token_endpoint: 'http://vendor.example/xai-token',
        verification_uri_complete: 'http://vendor.example/xai-verify',
      },
    })
    expect(await registerDevicePoll(store, 'xai', 'xai-state-1', clock.now)).toBe(true)
    const { fetch } = scriptedFetch([
      ['http://vendor.example/xai-token', () => ({ status: 400, body: { error: 'slow_down' } })],
    ])
    // xAI polls immediately on the first due alarm.
    await runAlarmPass({ store, now: clock.now, fetch, config, alarm: new SimulatedAlarm(), sleep: noSleep })
    const pollDoc = (await store.get(SCHEDULER_NAMESPACE, `${DEVICE_POLL_PREFIX}xai-state-1`)) as Record<
      string,
      JsonValue
    >
    expect(pollDoc['interval_ms']).toBe(10_000)
    expect(pollDoc['next_poll_at_ms']).toBe(clock.now() + 10_000)
  })
})

describe('alarm pass: sweeps and re-arm', () => {
  it('drops stale usage records and keeps fresh ones queued', async () => {
    const clock = makeClock(1_700_000_000_000)
    const store = newStore(clock.now)
    const staleStamp = formatRfc3339(clock.now() - 10 * 60_000)
    const freshStamp = formatRfc3339(clock.now() - 1_000)
    await store.enqueue('usage', JSON.stringify({ timestamp: staleStamp, model: 'm' }))
    await store.enqueue('usage', JSON.stringify({ timestamp: freshStamp, model: 'm' }))
    const { fetch } = scriptedFetch([])
    await runAlarmPass({ store, now: clock.now, fetch, config, alarm: new SimulatedAlarm(), sleep: noSleep })
    const remaining = await store.claim('usage', 30_000)
    expect(remaining).toBeDefined()
    expect(JSON.parse(String(remaining?.payload))['timestamp']).toBe(freshStamp)
    await expect(store.claim('usage', 30_000)).resolves.toBeUndefined()
  })

  it('sweeps idle management-ban entries hourly', async () => {
    const clock = makeClock(1_700_000_000_000)
    const store = newStore(clock.now)
    await store.put('mgmt', 'attempts', {
      '9.9.9.9': { failures: 1, last_seen: formatRfc3339(clock.now() - 3 * 60 * 60_000) },
      '8.8.8.8': { failures: 2, last_seen: formatRfc3339(clock.now() - 60_000) },
    })
    const { fetch } = scriptedFetch([])
    await runAlarmPass({ store, now: clock.now, fetch, config, alarm: new SimulatedAlarm(), sleep: noSleep })
    const attempts = (await store.get('mgmt', 'attempts')) as Record<string, JsonValue>
    expect(Object.keys(attempts)).toEqual(['8.8.8.8'])
  })

  it('re-arms at the earliest device poll when one is due before the heartbeat', async () => {
    const clock = makeClock(1_700_000_000_000)
    const store = newStore(clock.now)
    const registry = new OAuthSessionRegistry(store, { now: clock.now })
    await registry.register('xai-soon', 'xai', {
      metadata: {
        device_code: 'dc',
        user_code: 'U',
        interval: 5_000,
        token_endpoint: 'http://vendor.example/t',
        verification_uri_complete: 'http://vendor.example/v',
      },
    })
    await registerDevicePoll(store, 'xai', 'xai-soon', clock.now)
    const { fetch } = scriptedFetch([
      ['http://vendor.example/t', () => ({ status: 400, body: { error: 'authorization_pending' } })],
    ])
    const alarm = new SimulatedAlarm()
    await runAlarmPass({ store, now: clock.now, fetch, config, alarm, sleep: noSleep })
    // The next poll is one widened/regular interval away - earlier than
    // the heartbeat floor.
    expect(alarm.lastArmed()).toBe(clock.now() + 5_000)
  })
})
