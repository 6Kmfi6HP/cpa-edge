import { describe, expect, it } from 'vitest'
import { MemoryStore } from '@cpa-edge/core'
import {
  antigravityFileName,
  AUTH_FILES_NAMESPACE,
  claudeFileName,
  codexFileName,
  deleteAuthFile,
  devinFileName,
  isRefreshableCredential,
  kimiFileName,
  listAuthFiles,
  metaFileName,
  metaDcaTokenOf,
  parseAuthFileDocument,
  refreshSecretOf,
  sanitizePlanTag,
  sanitizeFileToken,
  saveAuthFile,
  shortHash,
  vertexFileName,
  xaiFileName,
} from './credential-docs'
import { sha256Hex } from './crypto-util'

describe('crypto vectors', () => {
  it('computes the well-known SHA-256 vector', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })
})

describe('auth-file parse rules (S3 §3.2)', () => {
  it('skips gemini files case-insensitively', () => {
    for (const type of ['gemini', 'Gemini', 'GEMINI', 'gemini-cli']) {
      const result = parseAuthFileDocument('a.json', { type })
      expect(result).toEqual({ ok: false, reason: 'gemini' })
    }
  })

  it('treats a missing type as provider unknown', () => {
    const result = parseAuthFileDocument('a.json', { access_token: 't' })
    expect(result.ok && result.file.provider).toBe('unknown')
  })

  it('drops files with invalid weight values', () => {
    expect(parseAuthFileDocument('a.json', { type: 'claude', weight: 'NaN' })).toEqual({
      ok: false,
      reason: 'invalid-weight',
    })
    expect(parseAuthFileDocument('a.json', { type: 'claude', weight: 2_000_000 })).toEqual({
      ok: false,
      reason: 'invalid-weight',
    })
    expect(parseAuthFileDocument('a.json', { type: 'claude', weight: -3 })).toEqual({
      ok: false,
      reason: 'invalid-weight',
    })
    const zero = parseAuthFileDocument('a.json', { type: 'claude', weight: 0 })
    expect(zero.ok && zero.file.weight).toBe(0)
    const string = parseAuthFileDocument('a.json', { type: 'claude', weight: '42' })
    expect(string.ok && string.file.weight).toBe(42)
  })

  it('ignores non-json keys and non-object documents', () => {
    expect(parseAuthFileDocument('a.oauth', { type: 'claude' })).toEqual({
      ok: false,
      reason: 'not-json-key',
    })
    expect(parseAuthFileDocument('a.json', 'string')).toEqual({ ok: false, reason: 'not-object' })
  })

  it('trims prefixes and resolves the label fallback chain', () => {
    const result = parseAuthFileDocument('a.json', {
      type: 'antigravity',
      prefix: '/p/',
      email: 'user@example.com',
    })
    expect(result.ok && result.file.prefix).toBe('p')
    expect(result.ok && result.file.label).toBe('user@example.com')
    const project = parseAuthFileDocument('b.json', {
      type: 'antigravity',
      project_id: 'proj-1',
    })
    expect(project.ok && project.file.label).toBe('proj-1')
    const innerSlash = parseAuthFileDocument('c.json', {
      type: 'antigravity',
      prefix: 'a/b',
    })
    expect(innerSlash.ok && innerSlash.file.prefix).toBe('')
  })

  it('skips unknown-provider entries when listing credentials', async () => {
    const store = new MemoryStore()
    await saveAuthFile(store, 'claude-a@x.com.json', {
      type: 'claude',
      access_token: 't',
      refresh_token: 'r',
    })
    await store.put(AUTH_FILES_NAMESPACE, 'no-type.json', { access_token: 't' })
    await store.put(AUTH_FILES_NAMESPACE, 'gemini.json', { type: 'gemini' })
    const loaded = await listAuthFiles(store)
    expect(loaded.length).toBe(1)
    const first = loaded[0]
    if (first === undefined) throw new Error('expected one credential')
    expect(first.provider).toBe('claude')
    expect(first.disabled).toBe(false)
    expect(first.document['disabled']).toBe(false)
  })

  it('saves materialize disabled and delete removes', async () => {
    const store = new MemoryStore()
    await saveAuthFile(store, 'kimi-1.json', { type: 'kimi', access_token: 't' })
    expect(((await store.get(AUTH_FILES_NAMESPACE, 'kimi-1.json')) as Record<string, unknown>)['disabled']).toBe(false)
    expect(await deleteAuthFile(store, 'kimi-1.json')).toBe(true)
    expect(await deleteAuthFile(store, 'kimi-1.json')).toBe(false)
  })
})

describe('file naming (S3 §3.2)', () => {
  it('names claude files by the org digest with the account-uuid fallback', async () => {
    const orgHash = (await shortHash('org-uuid')).slice(0, 8)
    expect(
      await claudeFileName({ organizationUuid: 'org-uuid', email: 'a@x.com' }),
    ).toBe(`claude-${orgHash}-a@x.com.json`)
    const accountHash = (await shortHash('account-uuid')).slice(0, 8)
    expect(
      await claudeFileName({ accountUuid: 'account-uuid', email: 'a@x.com' }),
    ).toBe(`claude-${accountHash}-a@x.com.json`)
    expect(await claudeFileName({ email: 'a@x.com' })).toBe('claude-a@x.com.json')
  })

  it('names codex files with the sanitized plan tag', async () => {
    const hash = (await shortHash('acct-1')).slice(0, 8)
    expect(
      await codexFileName({ accountId: 'acct-1', email: 'a@x.com', plan: 'ChatGPT Plus!' }),
    ).toBe(`codex-${hash}-a@x.com-chatgpt-plus-.json`)
    expect(await codexFileName({ email: 'a@x.com' })).toBe('codex-a@x.com.json')
    expect(sanitizePlanTag('Team-X')).toBe('team-x')
  })

  it('names antigravity, kimi and vertex files', async () => {
    expect(antigravityFileName('a@x.com')).toBe('antigravity-a@x.com.json')
    expect(antigravityFileName()).toBe('antigravity.json')
    expect(kimiFileName(1_760_000_000_000)).toBe('kimi-1760000000000.json')
    expect(vertexFileName('my project')).toBe('vertex-my_project.json')
  })

  it('sanitizes devin identifiers with the hash fallback', async () => {
    expect(await devinFileName({ userName: 'user@example.com', sessionToken: 'tok' })).toBe(
      'devin-user@example.com.json',
    )
    expect(await devinFileName({ sessionToken: 'tok' })).toBe(
      `devin-user-${(await shortHash('tok')).slice(0, 8)}.json`,
    )
    const unsafe = await devinFileName({ userId: 'a b/c'.repeat(50), sessionToken: 'tok' })
    expect(unsafe.startsWith('devin-user-')).toBe(true)
    expect(sanitizeFileToken('a b')).toBe('a_b')
  })

  it('names xai and meta files', async () => {
    expect(xaiFileName({ email: 'a@x.com', nowMs: 1 })).toBe('xai-a@x.com.json')
    expect(xaiFileName({ sub: 's-1', nowMs: 1 })).toBe('xai-s-1.json')
    expect(xaiFileName({ nowMs: 1_760_000_000_000 })).toBe('xai--1760000000000000000.json')
    const hash = (await shortHash('tok')).slice(0, 8)
    expect(await metaFileName({ email: 'a@x.com', accessToken: 'tok' })).toBe(
      `meta-a@x.com-${hash}.json`,
    )
  })
})

describe('refresh-credential detection (camelCase acceptance)', () => {
  it('reads refresh_token, refreshToken and meta dca_token', () => {
    expect(refreshSecretOf({ refresh_token: 'r' })).toBe('r')
    expect(refreshSecretOf({ refreshToken: 'r' })).toBe('r')
    expect(refreshSecretOf({})).toBeUndefined()
    expect(metaDcaTokenOf({ dca_token: 'd' })).toBe('d')
    expect(isRefreshableCredential('claude', { refreshToken: 'r' })).toBe(true)
    expect(isRefreshableCredential('claude', {})).toBe(false)
    expect(isRefreshableCredential('meta', { refreshToken: 'r' })).toBe(false)
    expect(isRefreshableCredential('meta', { dca_token: 'd' })).toBe(true)
  })
})
