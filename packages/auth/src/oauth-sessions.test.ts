import { describe, expect, it } from 'vitest'
import { MemoryStore } from '@cpa-edge/core'
import {
  isValidOauthState,
  OAuthSessionRegistry,
  OAUTH_SESSION_COMPLETED_TTL_MS,
  OAUTH_SESSION_DEFAULT_ERROR,
  OAUTH_SESSION_PENDING_TTL_MS,
  OAUTH_SESSIONS_NAMESPACE,
} from './oauth-sessions'

function registry(now: { value: number }): OAuthSessionRegistry {
  const store = new MemoryStore()
  return new OAuthSessionRegistry(store, { now: () => now.value })
}

describe('state validation', () => {
  it('accepts the documented shape and rejects the documented offenders', () => {
    expect(isValidOauthState('0123456789abcdef0123456789abcdef')).toBe(true)
    expect(isValidOauthState('kmi-1760000000000000000')).toBe(true)
    expect(isValidOauthState('bad state!')).toBe(false)
    expect(isValidOauthState('bad/state')).toBe(false)
    expect(isValidOauthState('a..b')).toBe(false)
    expect(isValidOauthState('')).toBe(false)
    expect(isValidOauthState('x'.repeat(129))).toBe(false)
  })
})

describe('session TTL transitions', () => {
  it('purges pending sessions after 30 minutes', async () => {
    const now = { value: 1_000_000 }
    const reg = registry(now)
    await reg.register('state-1', 'anthropic')
    expect((await reg.get('state-1'))?.status).toBe('pending')
    now.value += OAUTH_SESSION_PENDING_TTL_MS - 1
    expect(await reg.get('state-1')).toBeDefined()
    now.value += 2
    expect(await reg.get('state-1')).toBeUndefined()
  })

  it('shortens the TTL to 1 minute on completion', async () => {
    const now = { value: 1_000_000 }
    const reg = registry(now)
    await reg.register('state-1', 'codex')
    expect(await reg.complete('state-1')).toBe(true)
    expect((await reg.get('state-1'))?.completed).toBe(true)
    now.value += OAUTH_SESSION_COMPLETED_TTL_MS + 1
    expect(await reg.get('state-1')).toBeUndefined()
    expect(OAUTH_SESSION_COMPLETED_TTL_MS).toBe(60_000)
    expect(OAUTH_SESSION_PENDING_TTL_MS).toBe(30 * 60_000)
  })

  it('extends the TTL by a fresh 30 minutes on SetError and defaults the message', async () => {
    const now = { value: 1_000_000 }
    const reg = registry(now)
    await reg.register('state-1', 'kimi')
    now.value += 25 * 60_000
    expect(await reg.setStatusError('state-1', '')).toBe(true)
    const failed = await reg.get('state-1')
    expect(failed?.status).toBe(OAUTH_SESSION_DEFAULT_ERROR)
    expect(failed?.completed).toBe(false)
    // 30 more minutes from the SetError moment.
    now.value += 30 * 60_000 + 1
    expect(await reg.get('state-1')).toBeUndefined()
  })

  it('never touches completed sessions in SetError', async () => {
    const now = { value: 1_000_000 }
    const reg = registry(now)
    await reg.register('state-1', 'codex')
    await reg.complete('state-1')
    expect(await reg.setStatusError('state-1', 'boom')).toBe(false)
    expect((await reg.get('state-1'))?.completed).toBe(true)
    expect((await reg.get('state-1'))?.status).toBe('pending')
  })
})

describe('cancel and bulk-complete', () => {
  it('cancels only still-pending sessions', async () => {
    const now = { value: 1_000_000 }
    const reg = registry(now)
    await reg.register('pending', 'anthropic')
    await reg.register('errored', 'anthropic')
    await reg.setStatusError('errored', 'Authentication failed')
    await reg.register('done', 'anthropic')
    await reg.complete('done')
    expect(await reg.cancel('pending')).toBe(true)
    expect(await reg.cancel('pending')).toBe(false)
    expect(await reg.cancel('errored')).toBe(false)
    expect(await reg.cancel('done')).toBe(false)
    expect(await reg.cancel('never-registered')).toBe(false)
    expect(await reg.cancel('bad state!')).toBe(false)
  })

  it('bulk-completes every still-pending session of one provider', async () => {
    const now = { value: 1_000_000 }
    const reg = registry(now)
    await reg.register('k1', 'kimi')
    await reg.register('k2', 'kimi')
    await reg.register('k3', 'kimi')
    await reg.setStatusError('k3', 'Authentication failed')
    await reg.register('c1', 'codex')
    expect(await reg.completeAllPendingOfProvider('kimi')).toBe(2)
    expect((await reg.get('k1'))?.completed).toBe(true)
    expect((await reg.get('k2'))?.completed).toBe(true)
    expect((await reg.get('k3'))?.completed).toBe(false)
    expect((await reg.get('c1'))?.completed).toBe(false)
  })
})

describe('Store mapping (S6 §3.3.6)', () => {
  it('keeps the pinned document shape in the oauth-sessions namespace', async () => {
    const store = new MemoryStore()
    const reg = new OAuthSessionRegistry(store, { now: () => 1_000_000 })
    await reg.register('state-1', 'anthropic', { metadata: { code_verifier: 'v' } })
    const raw = (await store.get(OAUTH_SESSIONS_NAMESPACE, 'state-1')) as Record<string, unknown>
    expect(Object.keys(raw).sort()).toEqual([
      'completed',
      'created_at',
      'expires_at',
      'metadata',
      'provider',
      'source',
      'status',
    ])
    expect(raw['provider']).toBe('anthropic')
    expect(raw['status']).toBe('pending')
    expect(raw['source']).toBe('builtin')
    expect(raw['completed']).toBe(false)
    expect(raw['created_at']).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
    expect(raw['expires_at']).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  })
})
