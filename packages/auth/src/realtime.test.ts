import { describe, expect, it } from 'vitest'
import {
  authenticateRealtimeRequest,
  DEFAULT_SECRET_LIFETIME_MS,
  InMemoryRealtimeSecretRegistry,
  INVALID_REALTIME_SECRET_BODY,
  MAX_SECRET_LIFETIME_MS,
  MIN_SECRET_LIFETIME_MS,
  realtimeApiKeyErrorBody,
  realtimeServiceErrorBody,
  REALTIME_SECRET_PREFIX,
  StoreRealtimeSecretRegistry,
} from './realtime'
import { MemoryStore } from '@cpa-edge/core'

const URL_RT = 'http://127.0.0.1:8407/v1/realtime'
const KEYS = ['oracle-local-key-1']

describe('ek_ secret shape and lifetime bounds', () => {
  it('issues ek_-prefixed 43-char base64url secrets', async () => {
    const registry = new InMemoryRealtimeSecretRegistry()
    const secret = await registry.issue()
    expect(secret.token.startsWith(`${REALTIME_SECRET_PREFIX}`)).toBe(true)
    expect(secret.token.length).toBe(REALTIME_SECRET_PREFIX.length + 43)
    expect(/^[A-Za-z0-9_-]+$/.test(secret.token.slice(REALTIME_SECRET_PREFIX.length))).toBe(true)
  })

  it('clamps requested lifetimes into the 10s..2h window', async () => {
    expect(DEFAULT_SECRET_LIFETIME_MS).toBe(10 * 60_000)
    expect(MIN_SECRET_LIFETIME_MS).toBe(10_000)
    expect(MAX_SECRET_LIFETIME_MS).toBe(2 * 60 * 60_000)
    const registry = new InMemoryRealtimeSecretRegistry({ now: () => 1_000_000 })
    const short = await registry.issue(1)
    const long = await registry.issue(MAX_SECRET_LIFETIME_MS * 10)
    expect(short.expiresAtMs - 1_000_000).toBe(MIN_SECRET_LIFETIME_MS)
    expect(long.expiresAtMs - 1_000_000).toBe(MAX_SECRET_LIFETIME_MS)
  })
})

describe('realtime auth (§2.1 dual middleware)', () => {
  it('rejects an unknown ek_ token with the recorded nested 401 body', async () => {
    const result = await authenticateRealtimeRequest({
      apiKeys: KEYS,
      headers: { authorization: 'Bearer ek_00000000000000000000000000000000000000000000' },
      url: URL_RT,
    })
    expect(result).toEqual({ ok: false, status: 401, body: INVALID_REALTIME_SECRET_BODY })
    expect(new TextEncoder().encode(INVALID_REALTIME_SECRET_BODY).length).toBe(152)
  })

  it('yields the same 401 when no secret store is initialized', async () => {
    const result = await authenticateRealtimeRequest({
      apiKeys: KEYS,
      headers: { authorization: 'Bearer ek_00000000000000000000000000000000000000000000' },
      url: URL_RT,
    })
    expect(result).toEqual({ ok: false, status: 401, body: INVALID_REALTIME_SECRET_BODY })
  })

  it('rejects an expired secret with the same body', async () => {
    const registry = new InMemoryRealtimeSecretRegistry({ now: () => 10_000_000 })
    const secret = await registry.issue(MIN_SECRET_LIFETIME_MS)
    const result = await authenticateRealtimeRequest({
      apiKeys: KEYS,
      headers: { authorization: `Bearer ${secret.token}` },
      url: URL_RT,
      secrets: registry,
      now: () => 10_000_000 + MIN_SECRET_LIFETIME_MS + 1,
    })
    expect(result).toEqual({ ok: false, status: 401, body: INVALID_REALTIME_SECRET_BODY })
  })

  it('accepts a live issued secret', async () => {
    const registry = new InMemoryRealtimeSecretRegistry()
    const secret = await registry.issue()
    const result = await authenticateRealtimeRequest({
      apiKeys: KEYS,
      headers: { authorization: `Bearer ${secret.token}` },
      url: URL_RT,
      secrets: registry,
    })
    expect(result.ok).toBe(true)
  })

  it('falls through non-ek_ credentials to the standard matrix with realtime bodies', async () => {
    const missing = await authenticateRealtimeRequest({
      apiKeys: KEYS,
      headers: {},
      url: 'http://h/v1/realtime/sessions',
    })
    expect(missing).toEqual({
      ok: false,
      status: 401,
      body: realtimeApiKeyErrorBody('Missing API key'),
    })
    expect(new TextEncoder().encode(realtimeApiKeyErrorBody('Missing API key')).length).toBe(107)
    const invalid = await authenticateRealtimeRequest({
      apiKeys: KEYS,
      headers: { authorization: 'Bearer wrong-key-000' },
      url: 'http://h/v1/realtime/sessions',
    })
    expect(invalid).toEqual({
      ok: false,
      status: 401,
      body: realtimeApiKeyErrorBody('Invalid API key'),
    })
    const valid = await authenticateRealtimeRequest({
      apiKeys: KEYS,
      headers: { authorization: 'Bearer oracle-local-key-1' },
      url: 'http://h/v1/realtime/sessions',
    })
    expect(valid.ok).toBe(true)
  })

  it('shapes the 5xx auth-layer body', () => {
    expect(realtimeServiceErrorBody('boom')).toBe(
      '{"error":{"code":"authentication_service_error","message":"boom","param":null,"type":"server_error"}}',
    )
  })
})

describe('StoreRealtimeSecretRegistry', () => {
  it('round-trips secrets keyed by hash, expiring on read', async () => {
    const store = new MemoryStore()
    const registry = new StoreRealtimeSecretRegistry(store, { now: () => 5_000_000 })
    const secret = await registry.issue()
    expect((await registry.find(secret.token))?.token).toBe(secret.token)
    const late = new StoreRealtimeSecretRegistry(store, {
      now: () => 5_000_000 + DEFAULT_SECRET_LIFETIME_MS + 1,
    })
    expect(await late.find(secret.token)).toBeUndefined()
    // The expired document is removed on access.
    expect(await store.list('realtime-secrets')).toEqual([])
  })
})
