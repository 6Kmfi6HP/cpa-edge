import { describe, expect, it } from 'vitest'
import { MemoryStore } from '../store-memory'
import {
  DEFAULT_SESSION_AFFINITY_TTL_MS,
  SessionAffinityRegistry,
  baseModelKey,
  extractSessionIdentity,
  normalizeSessionAffinityTtlMs,
  parseGoDurationMs,
  sessionCacheKey,
} from './session'

const T0 = 1_700_000_000_000

describe('session identity extraction', () => {
  it('prefers the recorded source order', async () => {
    const everything = {
      headers: {
        'X-Claude-Code-Session-Id': 'claude-code',
        'Session-Id': 'session-id',
        'X-Http-Session-Id': 'http-session',
        'X-Session-ID': 'session-id-2',
        'X-Session-Affinity': 'affinity',
        'X-Slot-Session-Id': 'slot',
        'X-Conversation-Id': 'conversation',
        'X-Thread-Id': 'thread',
        'X-Client-Request-Id': 'client-request',
      },
      body: { metadata: { user_id: 'user-1' }, session_id: 'body-session', prompt_cache_key: 'cache' },
    }
    expect(await extractSessionIdentity(everything)).toBe('claude-code')
    expect(
      await extractSessionIdentity({ headers: everything.headers, body: { metadata: { user_id: 'user-1' } } }),
    ).toBe('user-1')
    const withoutClaudeCode = { ...everything, headers: { ...everything.headers, 'X-Claude-Code-Session-Id': '' } }
    expect(await extractSessionIdentity(withoutClaudeCode)).toBe('user-1')
    const noMetadata = { ...withoutClaudeCode, body: { session_id: 'body-session' } }
    expect(await extractSessionIdentity(noMetadata)).toBe('session-id')
    expect(await extractSessionIdentity({ ...noMetadata, headers: { 'X-Session-ID': 'only' } })).toBe('only')
  })

  it('reads header names ASCII-case-insensitively', async () => {
    expect(await extractSessionIdentity({ headers: { 'x-session-id': 'lower' } })).toBe('lower')
  })

  it('reads the body fields in priority order', async () => {
    expect(await extractSessionIdentity({ headers: {}, body: { cachedContent: 'cc' } })).toBe('cc')
    expect(await extractSessionIdentity({ headers: {}, body: { thread_id: 'th' } })).toBe('th')
    expect(await extractSessionIdentity({ headers: {}, body: { sessionId: 'sid' } })).toBe('sid')
    expect(await extractSessionIdentity({ headers: {}, body: { prompt_cache_key: 'pck' } })).toBe('pck')
    expect(await extractSessionIdentity({ headers: {}, body: { conversation_id: 'cid' } })).toBe('cid')
    expect(await extractSessionIdentity({ headers: {}, body: { chat_id: 'chat' } })).toBe('chat')
    expect(await extractSessionIdentity({ headers: {}, body: { conversation: { id: 'conv' } } })).toBe('conv')
  })

  it('falls back to the execution session and the first-message hash', async () => {
    expect(await extractSessionIdentity({ headers: {}, executionSessionId: 'exec-1' })).toBe('exec-1')
    const hashed = await extractSessionIdentity({ headers: {}, firstMessage: 'hello world' })
    expect(hashed).toMatch(/^[0-9a-f]{16}$/)
    expect(await extractSessionIdentity({ headers: {}, firstMessage: 'hello world' })).toBe(hashed)
    expect(await extractSessionIdentity({ headers: {}, firstMessage: 'other' })).not.toBe(hashed)
    expect(await extractSessionIdentity({ headers: {} })).toBeUndefined()
  })
})

describe('session keys and TTL', () => {
  it('strips thinking suffixes from the model key', () => {
    expect(baseModelKey('gpt-5-codex(high)')).toBe('gpt-5-codex')
    expect(baseModelKey('cm(4096)')).toBe('cm')
    expect(baseModelKey('plain-model')).toBe('plain-model')
  })

  it('formats the cache key as provider :: session-id :: model', () => {
    expect(sessionCacheKey('gemini', 's1', 'gm(1024)')).toBe('gemini :: s1 :: gm')
  })

  it('parses Go duration strings and floors the TTL', () => {
    expect(parseGoDurationMs('1h')).toBe(3_600_000)
    expect(parseGoDurationMs('1h30m')).toBe(5_400_000)
    expect(parseGoDurationMs('90s')).toBe(90_000)
    expect(parseGoDurationMs('500ms')).toBe(500)
    expect(parseGoDurationMs('0.5s')).toBe(500)
    expect(parseGoDurationMs('1m1s')).toBe(61_000)
    expect(parseGoDurationMs('nonsense')).toBeUndefined()
    expect(parseGoDurationMs('')).toBeUndefined()
    expect(normalizeSessionAffinityTtlMs(parseGoDurationMs('1h') ?? 0)).toBe(DEFAULT_SESSION_AFFINITY_TTL_MS)
    expect(normalizeSessionAffinityTtlMs(500)).toBe(1_000)
    expect(normalizeSessionAffinityTtlMs(0)).toBe(DEFAULT_SESSION_AFFINITY_TTL_MS)
  })
})

describe('session affinity registry', () => {
  function makeRegistry(clock: { now: number }): SessionAffinityRegistry {
    return new SessionAffinityRegistry(new MemoryStore({ now: () => clock.now }), () => clock.now)
  }

  it('binds, reads and expires bindings lazily', async () => {
    const clock = { now: T0 }
    const registry = makeRegistry(clock)
    const key = sessionCacheKey('openai-compatible-mock-openai', 'sess-1', 'mock-model')
    await registry.bind(key, 'auth-1', 60_000)
    expect((await registry.get(key))?.authId).toBe('auth-1')
    clock.now = T0 + 60_001
    expect(await registry.get(key)).toBeUndefined()
  })

  it('refreshes only the bound credential (compare-and-set)', async () => {
    const clock = { now: T0 }
    const registry = makeRegistry(clock)
    const key = sessionCacheKey('p', 's', 'm')
    await registry.bind(key, 'auth-1', 60_000)
    clock.now = T0 + 30_000
    await registry.bind(key, 'auth-2', 60_000)
    await registry.refresh(key, 'auth-1', 60_000)
    expect((await registry.get(key))?.authId).toBe('auth-2')
    clock.now = T0 + 30_000
    await registry.refresh(key, 'auth-2', 60_000)
    expect((await registry.get(key))?.expiresAt).toBe(T0 + 90_000)
  })

  it('unbinds only while the binding still names the credential', async () => {
    const clock = { now: T0 }
    const registry = makeRegistry(clock)
    const key = sessionCacheKey('p', 's', 'm')
    await registry.bind(key, 'auth-1', 60_000)
    expect(await registry.unbind(key, 'auth-2')).toBe(false)
    expect((await registry.get(key))?.authId).toBe('auth-1')
    expect(await registry.unbind(key, 'auth-1')).toBe(true)
    expect(await registry.get(key)).toBeUndefined()
  })

  it('matches stored session-id prefixes (LCP lookup)', async () => {
    const clock = { now: T0 }
    const registry = makeRegistry(clock)
    await registry.bind(sessionCacheKey('p', 'thread-123', 'm'), 'auth-1', 60_000)
    await registry.bind(sessionCacheKey('p', 'other', 'm'), 'auth-2', 60_000)
    const binding = await registry.longestPrefixLookup('p', 'thread-123-child-9', 'm')
    expect(binding?.authId).toBe('auth-1')
    expect(await registry.longestPrefixLookup('p', 'unrelated', 'm')).toBeUndefined()
    // A different model scope never matches.
    expect(await registry.longestPrefixLookup('p', 'thread-123-child-9', 'm2')).toBeUndefined()
  })
})
