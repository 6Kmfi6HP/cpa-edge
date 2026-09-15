import { describe, expect, it } from 'vitest'
import { MemoryStore } from '@cpa-edge/core'
import {
  INVALID_MANAGEMENT_KEY_BODY,
  isLocalIp,
  isParseableIp,
  looksLikeBcrypt,
  MANAGEMENT_BAN_DURATION_MS,
  MANAGEMENT_BAN_THRESHOLD,
  ManagementAuthService,
  MGMT_ATTEMPTS_KEY,
  MGMT_ATTEMPTS_NAMESPACE,
  MISSING_MANAGEMENT_KEY_BODY,
  prepareManagementSecret,
  prepareManagementSecretSync,
  REMOTE_MANAGEMENT_DISABLED_BODY,
  resolveClientIp,
  verifyManagementSecret,
} from './mgmt-auth'

const SECRET = 'oracle-mgmt-key-1'
const REMOTE = '203.0.113.7'

function service(
  store: MemoryStore,
  config: { allowRemote?: boolean; secret?: string; env?: string; local?: string },
  now: () => number,
): ManagementAuthService {
  return new ManagementAuthService(store, {
    getConfig: () => ({
      configSecret: config.secret,
      envSecret: config.env,
      localSecret: config.local,
      allowRemote: config.allowRemote ?? true,
    }),
    now,
  })
}

function request(overrides: {
  authorization?: string
  'x-management-key'?: string
  'x-forwarded-for'?: string
  'x-real-ip'?: string
  remoteAddr?: string
}) {
  return {
    headers: {
      remoteAddr: overrides.remoteAddr ?? REMOTE,
      ...(overrides.authorization === undefined ? {} : { authorization: overrides.authorization }),
      ...(overrides['x-management-key'] === undefined
        ? {}
        : { 'x-management-key': overrides['x-management-key'] }),
      ...(overrides['x-forwarded-for'] === undefined
        ? {}
        : { 'x-forwarded-for': overrides['x-forwarded-for'] }),
      ...(overrides['x-real-ip'] === undefined ? {} : { 'x-real-ip': overrides['x-real-ip'] }),
    },
  }
}

describe('XFF resolution (gin trust-all semantics)', () => {
  it('returns the leftmost parseable entry', () => {
    expect(resolveClientIp({ 'x-forwarded-for': '1.2.3.4, 127.0.0.1', remoteAddr: REMOTE })).toBe(
      '1.2.3.4',
    )
    expect(resolveClientIp({ 'x-forwarded-for': '127.0.0.1', remoteAddr: REMOTE })).toBe(
      '127.0.0.1',
    )
  })

  it('falls back on unparseable entries anywhere in the list', () => {
    expect(
      resolveClientIp({ 'x-forwarded-for': '10.0.0.99, garbage', 'x-real-ip': '9.9.9.9', remoteAddr: REMOTE }),
    ).toBe('9.9.9.9')
    expect(
      resolveClientIp({ 'x-forwarded-for': 'garbage, 10.0.0.99', 'x-real-ip': '9.9.9.9', remoteAddr: REMOTE }),
    ).toBe('9.9.9.9')
  })

  it('falls back to X-Real-IP, then the TCP remote address', () => {
    expect(resolveClientIp({ 'x-real-ip': '9.9.9.9', remoteAddr: `${REMOTE}:5555` })).toBe('9.9.9.9')
    expect(resolveClientIp({ remoteAddr: `${REMOTE}:5555` })).toBe(REMOTE)
    expect(resolveClientIp({ remoteAddr: '[2001:db8::1]:5555' })).toBe('2001:db8::1')
  })

  it('recognizes loopback and parseable addresses', () => {
    expect(isLocalIp('127.0.0.1')).toBe(true)
    expect(isLocalIp('::1')).toBe(true)
    expect(isLocalIp(REMOTE)).toBe(false)
    expect(isParseableIp('10.0.0.99')).toBe(true)
    expect(isParseableIp('2001:db8::1')).toBe(true)
    expect(isParseableIp('not-an-ip')).toBe(false)
    expect(isParseableIp('999.1.1.1')).toBe(false)
  })
})

describe('bcrypt-at-startup secret semantics (R-BCRYPT)', () => {
  it('hashes plaintext once and is idempotent afterwards', async () => {
    const first = await prepareManagementSecret(SECRET)
    expect(first.mutated).toBe(true)
    expect(looksLikeBcrypt(first.stored)).toBe(true)
    expect(first.stored.startsWith('$2')).toBe(true)
    const second = await prepareManagementSecret(first.stored)
    expect(second).toEqual({ stored: first.stored, mutated: false })
    const sync = prepareManagementSecretSync(SECRET)
    expect(sync.mutated).toBe(true)
    expect(looksLikeBcrypt(sync.stored)).toBe(true)
  })

  it('keeps plaintext working as the presented key', async () => {
    const prepared = await prepareManagementSecret(SECRET)
    expect(await verifyManagementSecret(SECRET, prepared.stored)).toBe(true)
    expect(await verifyManagementSecret('wrong', prepared.stored)).toBe(false)
  })

  it('compares non-hashed stored values in constant time', async () => {
    expect(await verifyManagementSecret('plain', 'plain')).toBe(true)
    expect(await verifyManagementSecret('plain', 'other')).toBe(false)
  })

  it('leaves empty secrets untouched', async () => {
    expect(await prepareManagementSecret('')).toEqual({ stored: '', mutated: false })
  })
})

describe('management pipeline (§2.2)', () => {
  it('accepts both key styles against a bcrypt config secret', async () => {
    const store = new MemoryStore()
    const prepared = prepareManagementSecretSync(SECRET)
    const svc = service(store, { secret: prepared.stored }, () => 0)
    expect(
      await svc.authenticate(request({ 'x-management-key': SECRET, 'x-forwarded-for': '127.0.0.1' })),
    ).toEqual({ ok: true })
    expect(
      await svc.authenticate(request({ authorization: `Bearer ${SECRET}`, 'x-forwarded-for': '127.0.0.1' })),
    ).toEqual({ ok: true })
  })

  it('answers the recorded 401 bodies', async () => {
    const store = new MemoryStore()
    const svc = service(store, { secret: SECRET }, () => 0)
    expect(await svc.authenticate(request({ 'x-forwarded-for': '127.0.0.1' }))).toEqual({
      ok: false,
      status: 401,
      body: MISSING_MANAGEMENT_KEY_BODY,
    })
    expect(MISSING_MANAGEMENT_KEY_BODY).toBe('{"error":"missing management key"}')
    expect(await svc.authenticate(request({ 'x-management-key': 'nope', 'x-forwarded-for': '127.0.0.1' }))).toEqual({
      ok: false,
      status: 401,
      body: INVALID_MANAGEMENT_KEY_BODY,
    })
  })

  it('gates remote clients when allow-remote is false (not counted)', async () => {
    const store = new MemoryStore()
    const svc = service(store, { secret: SECRET, allowRemote: false }, () => 0)
    expect(
      await svc.authenticate(request({ 'x-management-key': SECRET, 'x-forwarded-for': '10.0.0.99' })),
    ).toEqual({ ok: false, status: 403, body: REMOTE_MANAGEMENT_DISABLED_BODY })
    const doc = await store.get(MGMT_ATTEMPTS_NAMESPACE, MGMT_ATTEMPTS_KEY)
    expect(doc).toBeUndefined()
    // A spoofed loopback XFF passes the gate (recorded reality).
    expect(
      await svc.authenticate(request({ 'x-management-key': SECRET, 'x-forwarded-for': '127.0.0.1' })),
    ).toEqual({ ok: true })
  })

  it('answers remote management key not set when no secret survived hot reload', async () => {
    const store = new MemoryStore()
    const svc = service(store, {}, () => 0)
    expect(await svc.authenticate(request({ 'x-forwarded-for': '10.0.0.99' }))).toEqual({
      ok: false,
      status: 403,
      body: '{"error":"remote management key not set"}',
    })
  })

  it('accepts the env secret from anywhere and forces allow-remote on', async () => {
    const store = new MemoryStore()
    const svc = service(store, { env: 'env-secret', allowRemote: false }, () => 0)
    expect(
      await svc.authenticate(request({ 'x-management-key': 'env-secret', 'x-forwarded-for': '10.0.0.99' })),
    ).toEqual({ ok: true })
  })

  it('answers the pinned 403 for a local-only setup, per the step-6 order', async () => {
    // S3 §2.2: with neither config nor env secret, the pipeline answers
    // "remote management key not set" even for loopback clients; the
    // step-6 check precedes the local-password compare.
    const store = new MemoryStore()
    const svc = service(store, { local: 'local-secret' }, () => 0)
    expect(
      await svc.authenticate(request({ 'x-management-key': 'local-secret', 'x-forwarded-for': '127.0.0.1' })),
    ).toEqual({ ok: false, status: 403, body: '{"error":"remote management key not set"}' })
  })

  it('checks the local password before the config secret for loopback clients', async () => {
    const store = new MemoryStore()
    const svc = service(store, { local: 'local-secret', secret: SECRET, allowRemote: false }, () => 0)
    expect(
      await svc.authenticate(request({ 'x-management-key': 'local-secret', 'x-forwarded-for': '127.0.0.1' })),
    ).toEqual({ ok: true })
    expect(
      await svc.authenticate(request({ 'x-management-key': 'local-secret', 'x-forwarded-for': '10.0.0.99' })),
    ).toEqual({ ok: false, status: 403, body: REMOTE_MANAGEMENT_DISABLED_BODY })
  })
})

describe('ban window arithmetic (injectable clock)', () => {
  it('bans on the 5th counted failure; the 5th request still answers 401', async () => {
    expect(MANAGEMENT_BAN_THRESHOLD).toBe(5)
    expect(MANAGEMENT_BAN_DURATION_MS).toBe(30 * 60_000)
    const store = new MemoryStore()
    const now = { value: 1_000_000 }
    const svc = service(store, { secret: SECRET }, () => now.value)
    for (let i = 1; i <= 4; i += 1) {
      const result = await svc.authenticate(
        request({ 'x-management-key': 'wrong', 'x-forwarded-for': '127.0.0.1' }),
      )
      expect(result).toEqual({ ok: false, status: 401, body: INVALID_MANAGEMENT_KEY_BODY })
    }
    const fifth = await svc.authenticate(
      request({ 'x-management-key': 'wrong', 'x-forwarded-for': '127.0.0.1' }),
    )
    expect(fifth).toEqual({ ok: false, status: 401, body: INVALID_MANAGEMENT_KEY_BODY })
    // The ban now applies to any later request - even with a valid key.
    const banned = await svc.authenticate(
      request({ 'x-management-key': SECRET, 'x-forwarded-for': '127.0.0.1' }),
    )
    expect(banned).toEqual({
      ok: false,
      status: 403,
      body: '{"error":"IP banned due to too many failed attempts. Try again in 30m0s"}',
    })
    now.value += 10 * 60_000
    const later = await svc.authenticate(
      request({ 'x-management-key': 'wrong', 'x-forwarded-for': '127.0.0.1' }),
    )
    expect(later).toEqual({
      ok: false,
      status: 403,
      body: '{"error":"IP banned due to too many failed attempts. Try again in 20m0s"}',
    })
  })

  it('resets the counter on success', async () => {
    const store = new MemoryStore()
    const now = { value: 1_000_000 }
    const svc = service(store, { secret: SECRET }, () => now.value)
    for (let i = 1; i <= 4; i += 1) {
      await svc.authenticate(request({ 'x-management-key': 'wrong', 'x-forwarded-for': '127.0.0.1' }))
    }
    expect(await svc.authenticate(request({ 'x-management-key': SECRET, 'x-forwarded-for': '127.0.0.1' }))).toEqual({
      ok: true,
    })
    for (let i = 1; i <= 4; i += 1) {
      const result = await svc.authenticate(
        request({ 'x-management-key': 'wrong', 'x-forwarded-for': '127.0.0.1' }),
      )
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.status).toBe(401)
    }
    const doc = (await store.get(MGMT_ATTEMPTS_NAMESPACE, MGMT_ATTEMPTS_KEY)) as Record<
      string,
      { failures: number }
    >
    expect(doc['127.0.0.1']).toEqual({ failures: 4 })
  })

  it('lifts the ban when it expires and resets the counter', async () => {
    const store = new MemoryStore()
    const now = { value: 1_000_000 }
    const svc = service(store, { secret: SECRET }, () => now.value)
    for (let i = 1; i <= 5; i += 1) {
      await svc.authenticate(request({ 'x-management-key': 'wrong', 'x-forwarded-for': '127.0.0.1' }))
    }
    now.value += MANAGEMENT_BAN_DURATION_MS + 1
    const after = await svc.authenticate(
      request({ 'x-management-key': 'wrong', 'x-forwarded-for': '127.0.0.1' }),
    )
    expect(after).toEqual({ ok: false, status: 401, body: INVALID_MANAGEMENT_KEY_BODY })
  })

  it('keys the counter by the resolved (spoofable) IP', async () => {
    const store = new MemoryStore()
    const svc = service(store, { secret: SECRET }, () => 0)
    for (let i = 1; i <= 5; i += 1) {
      await svc.authenticate(request({ 'x-management-key': 'wrong', 'x-forwarded-for': '10.1.1.1' }))
    }
    const other = await svc.authenticate(
      request({ 'x-management-key': 'wrong', 'x-forwarded-for': '10.2.2.2' }),
    )
    expect(other).toEqual({ ok: false, status: 401, body: INVALID_MANAGEMENT_KEY_BODY })
  })

  it('sweeps entries without live bans or outstanding failures', async () => {
    const store = new MemoryStore()
    const now = { value: 1_000_000 }
    const svc = service(store, { secret: SECRET }, () => now.value)
    await svc.authenticate(request({ 'x-management-key': 'wrong', 'x-forwarded-for': '10.9.9.9' }))
    await svc.sweepIdleEntries()
    const doc = (await store.get(MGMT_ATTEMPTS_NAMESPACE, MGMT_ATTEMPTS_KEY)) as Record<
      string,
      unknown
    >
    expect(doc['10.9.9.9']).toEqual({ failures: 1 })
  })
})
