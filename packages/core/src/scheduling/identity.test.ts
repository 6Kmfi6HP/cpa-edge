import { describe, expect, it } from 'vitest'
import {
  AUTH_INDEX_FAMILIES,
  StableIdGenerator,
  ascendingCredentialOrder,
  authIndexSeed,
  deriveAuthIndex,
  deriveCredentialIdentity,
  deriveEntrylessCompatibilityIdentity,
  formatSortedHeaders,
  openAiCompatibilityKind,
  stableCredentialDigest,
} from './identity'

/**
 * Recorded identity values (S4 fixtures, oracle-recorded against
 * CLIProxyAPI v7.3.4). These pin the derivations numerically.
 */
const BASE = 'http://host.docker.internal:18999/v1'
const COMPAT_NAME = 'mock-openai'

const compatEntry = (apiKey: string) => ({ apiKey, baseUrl: BASE, proxyUrl: '' })

describe('credential identity derivation', () => {
  it('reproduces the recorded openai-compatibility auth IDs (S4-01)', async () => {
    const key1 = await deriveCredentialIdentity('openai-compatibility', compatEntry('s4-oai-key-1'), COMPAT_NAME)
    const key2 = await deriveCredentialIdentity('openai-compatibility', compatEntry('s4-oai-key-2'), COMPAT_NAME)
    const key3 = await deriveCredentialIdentity('openai-compatibility', compatEntry('s4-oai-key-3'), COMPAT_NAME)
    expect(key1.id).toBe('openai-compatibility:mock-openai:2add2ed9fa51')
    expect(key3.id).toBe('openai-compatibility:mock-openai:922ad5b89d42')
    expect(key2.id).toBe('openai-compatibility:mock-openai:9d9fdb184163')
    // Rotation order is ascending auth ID byte order: key-1 < key-3 < key-2.
    expect(ascendingCredentialOrder([key1, key2, key3]).map((entry) => entry.id)).toEqual([
      key1.id,
      key3.id,
      key2.id,
    ])
  })

  it('hashes kind plus NUL-prefixed trimmed parts', async () => {
    const digest = await stableCredentialDigest('openai-compatibility:mock-openai', [
      '  s4-oai-key-1 ',
      ` ${BASE} `,
      '',
    ])
    expect(digest).toBe('2add2ed9fa51')
  })

  it('reproduces the recorded empty-api-key gemini chain (S4-20)', async () => {
    const identity = await deriveCredentialIdentity('gemini', { apiKey: '', baseUrl: BASE })
    expect(identity.id).toBe('gemini:apikey:88c747d7b66d')
    // Empty api key: the family-literal seed form does not apply, so the
    // index falls back to the auth ID seed.
    const index = await deriveAuthIndex({
      authId: identity.id,
      familyLiteral: 'gemini-api-key',
      baseUrl: BASE,
      apiKey: '',
    })
    expect(index).toBe('2f8a144d9ae23286')
  })

  it('reproduces the recorded auth_index values of the compat pool (S4-07)', async () => {
    const index1 = await deriveAuthIndex({
      authId: 'openai-compatibility:mock-openai:2add2ed9fa51',
      familyLiteral: 'openai-compatibility',
      baseUrl: BASE,
      apiKey: 's4-oai-key-1',
    })
    const index2 = await deriveAuthIndex({
      authId: 'openai-compatibility:mock-openai:9d9fdb184163',
      familyLiteral: 'openai-compatibility',
      baseUrl: BASE,
      apiKey: 's4-oai-key-2',
    })
    const index3 = await deriveAuthIndex({
      authId: 'openai-compatibility:mock-openai:922ad5b89d42',
      familyLiteral: 'openai-compatibility',
      baseUrl: BASE,
      apiKey: 's4-oai-key-3',
    })
    expect(index1).toBe('6a5fde1a341d633e')
    expect(index2).toBe('a42ae2a9f932510a')
    expect(index3).toBe('9a4c4e139e376f20')
  })

  it('derives vertex identities from three parts only', async () => {
    const vertex = await deriveCredentialIdentity('vertex', {
      apiKey: 'k',
      baseUrl: BASE,
      proxyUrl: '',
      prefix: 'p',
      headers: { 'x-a': '1' },
    })
    expect(vertex.id).toMatch(/^vertex:apikey:[0-9a-f]{12}$/)
    // The same inputs under gemini fold prefix and headers in, so the
    // digests differ.
    const gemini = await deriveCredentialIdentity('gemini', {
      apiKey: 'k',
      baseUrl: BASE,
      proxyUrl: '',
      prefix: 'p',
      headers: { 'x-a': '1' },
    })
    expect(gemini.id).not.toBe(vertex.id)
    // Vertex has no family-literal case: its index falls back to `id:`.
    const seed = authIndexSeed({
      authId: vertex.id,
      familyLiteral: 'vertex-api-key',
      baseUrl: BASE,
      apiKey: 'k',
    })
    expect(seed).toBe(`id:${vertex.id}`)
  })

  it('uses the interactions kind for interaction credentials', async () => {
    const identity = await deriveCredentialIdentity('interactions', { apiKey: 'k', baseUrl: BASE })
    expect(identity.kind).toBe('gemini-interactions:apikey')
    expect(identity.id).toBe(`gemini-interactions:apikey:${identity.digest}`)
  })

  it('falls back to the bare compatibility kind for empty provider names', () => {
    expect(openAiCompatibilityKind('')).toBe('openai-compatibility')
    expect(openAiCompatibilityKind(undefined)).toBe('openai-compatibility')
    expect(openAiCompatibilityKind(' Mock-OpenAI ')).toBe('openai-compatibility:mock-openai')
  })

  it('derives the entryless compatibility credential from the base URL only', async () => {
    const identity = await deriveEntrylessCompatibilityIdentity(BASE, COMPAT_NAME)
    const manual = await stableCredentialDigest('openai-compatibility:mock-openai', [BASE])
    expect(identity.digest).toBe(manual)
    expect(identity.id).toBe(`openai-compatibility:mock-openai:${manual}`)
  })

  it('serializes header overrides with sorted keys', () => {
    expect(formatSortedHeaders({})).toBe('')
    expect(formatSortedHeaders({ 'x-b': '2', 'x-a': '1' })).toBe('x-a=1&x-b=2')
  })

  it('disambiguates repeated derivations with a counter suffix', async () => {
    const generator = new StableIdGenerator()
    const identity = await deriveCredentialIdentity('gemini', { apiKey: 'k', baseUrl: BASE })
    expect(generator.issue(identity)).toBe(identity.id)
    expect(generator.issue({ ...identity })).toBe(`${identity.id}-2`)
    expect(generator.issue({ ...identity })).toBe(`${identity.id}-3`)
  })

  it('orders seeds: plugin seed, then .json file path, then family literal, then id fallback', async () => {
    const authId = 'gemini:apikey:88c747d7b66d'
    expect(authIndexSeed({ authId, pluginSeed: 'plug-1' })).toBe('auth_index_seed:plug-1')
    expect(
      authIndexSeed({
        authId,
        filePath: '/root/.cli-proxy-api/acc@gmail.com.json',
        fileKind: 'gemini',
        familyLiteral: 'gemini-api-key',
        baseUrl: BASE,
        apiKey: 'k',
      }),
    ).toBe('gemini:/root/.cli-proxy-api/acc@gmail.com.json')
    expect(
      authIndexSeed({
        authId,
        filePath: 'config:mock-openai[0]',
        fileKind: 'gemini',
        familyLiteral: 'gemini-api-key',
        baseUrl: BASE,
        apiKey: 'k',
      }),
    ).toBe(`gemini-api-key:${BASE}+k`)
    expect(authIndexSeed({ authId })).toBe(`id:${authId}`)
    // An unknown family literal never takes the seed form.
    expect(authIndexSeed({ authId, familyLiteral: 'vertex-api-key', baseUrl: BASE, apiKey: 'k' })).toBe(
      `id:${authId}`,
    )
    expect(AUTH_INDEX_FAMILIES).not.toContain('vertex-api-key')
  })
})
