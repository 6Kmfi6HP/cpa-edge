/**
 * Config-ingestion unit tests (S7 F6 + F1 substrate): the block-YAML
 * emitter/parser pair that carries the config between the JSON record
 * (gateway input) and the YAML text (management facade + KV
 * persistence), plus the proxy-url mode semantics of the fail-closed
 * exclusion.
 */

import { describe, expect, it } from 'vitest'
import {
  effectiveEntryMode,
  emitBlockYaml,
  globalProxyUrl,
  loadConfigSource,
  parseBlockYaml,
  proxiedProviderIndexes,
  resolveProxyMode,
  stripProxiedProviders,
} from './config'

const SAMPLE: Record<string, unknown> = {
  port: 18317,
  debug: false,
  'api-keys': ['key-one', 'key-two'],
  'proxy-url': '',
  'remote-management': {
    'allow-remote': true,
    'secret-key': 'mgmt-secret',
    'disable-control-panel': true,
  },
  'claude-api-key': [
    {
      'api-key': 'claude-key',
      'base-url': 'http://127.0.0.1:20002',
      'proxy-url': 'socks5://127.0.0.1:1080',
      models: [{ name: 'claude-a', alias: 'alias-a' }],
    },
    {
      'api-key': 'claude-key-2',
      models: [{ name: 'claude-b' }],
    },
  ],
  'openai-compatibility': [
    {
      name: 'mock-openai',
      'api-key': 'openai-key',
      'base-url': 'http://127.0.0.1:18999/v1',
      models: [{ name: 'upstream-model', alias: 'client-model' }],
    },
  ],
  empty_map: {},
  empty_list: [],
  'weird key: with chars': 'quoted value',
}

describe('block yaml round-trip', () => {
  it('emits dialect text the parser reconstructs losslessly', () => {
    const yaml = emitBlockYaml(SAMPLE)
    expect(yaml).not.toContain('{') // block style only, no flow collections
    const parsed = parseBlockYaml(yaml)
    expect(parsed).toEqual(SAMPLE)
  })

  it('emits empty text for an empty document', () => {
    expect(emitBlockYaml({})).toBe('')
    expect(parseBlockYaml('')).toEqual({})
  })

  it('parses hand-written block YAML of the config dialect', () => {
    const handWritten = [
      '# comment line',
      'port: 18317',
      'remote-management:',
      '  allow-remote: true',
      "  secret-key: 'single quoted'",
      'api-keys:',
      '  - "key one"',
      '  - "key: two"',
      'claude-api-key:',
      '  - api-key: "k1"',
      '    models:',
      '      - name: "m"',
      '        alias: "a"',
    ].join('\n')
    expect(parseBlockYaml(handWritten)).toEqual({
      port: 18317,
      'remote-management': { 'allow-remote': true, 'secret-key': 'single quoted' },
      'api-keys': ['key one', 'key: two'],
      'claude-api-key': [{ 'api-key': 'k1', models: [{ name: 'm', alias: 'a' }] }],
    })
  })

  it('keeps string scalars distinct from lookalike types', () => {
    const parsed = parseBlockYaml(emitBlockYaml({ a: '123', b: 123, c: 'true', d: true, e: null, f: '~' }))
    expect(parsed).toEqual({ a: '123', b: 123, c: 'true', d: true, e: null, f: null })
  })

  it('rejects flow collections it does not implement', () => {
    expect(() => parseBlockYaml('a: [1, 2]')).toThrow()
    expect(() => parseBlockYaml('a: {b: 1}')).toThrow()
  })
})

describe('config source loading (F6)', () => {
  it('prefers the KV document, then JSON, then YAML', async () => {
    const kvYaml = emitBlockYaml({ port: 9999 })
    const fromKv = await loadConfigSource({
      env: {
        CPA_CONFIG_FROM_KV: '1',
        CPA_CONFIG_JSON: JSON.stringify({ port: 1 }),
        CPA_CONFIG_YAML: emitBlockYaml({ port: 2 }),
      },
      readKvConfig: async () => kvYaml,
    })
    expect(fromKv.origin).toBe('kv')
    expect(fromKv.record).toEqual({ port: 9999 })

    const fromJson = await loadConfigSource({
      env: { CPA_CONFIG_JSON: JSON.stringify({ port: 1 }) },
      readKvConfig: async () => kvYaml,
    })
    expect(fromJson.origin).toBe('env-json')
    expect((fromJson.record as { port: number }).port).toBe(1)
    expect(fromJson.yaml).toContain('port: 1')

    const fromYaml = await loadConfigSource({
      env: { CPA_CONFIG_YAML: emitBlockYaml({ port: 2 }) },
    })
    expect(fromYaml.origin).toBe('env-yaml')

    const empty = await loadConfigSource({ env: {} })
    expect(empty.origin).toBe('empty')
    expect(empty.yaml).toBe('')
  })

  it('rejects malformed CPA_CONFIG_JSON with a clear error', async () => {
    await expect(
      loadConfigSource({ env: { CPA_CONFIG_JSON: '{not json' } }),
    ).rejects.toThrow(/CPA_CONFIG_JSON/)
  })
})

describe('proxy-url semantics (F1)', () => {
  it('resolves modes per the S7 value rules', () => {
    expect(resolveProxyMode('')).toBe('inherit')
    expect(resolveProxyMode('  ')).toBe('inherit')
    expect(resolveProxyMode('direct')).toBe('direct')
    expect(resolveProxyMode('NONE')).toBe('direct')
    expect(resolveProxyMode('None')).toBe('direct')
    expect(resolveProxyMode('socks5://127.0.0.1:1080')).toBe('proxy')
    expect(resolveProxyMode('SOCKS5H://host')).toBe('proxy')
    expect(resolveProxyMode('http://proxy:3128')).toBe('proxy')
    expect(resolveProxyMode('https://proxy:3128')).toBe('proxy')
    // Invalid values fall through to direct - no 501 (S7 2.3-F1-5).
    expect(resolveProxyMode('ftp://example.com')).toBe('direct')
    expect(resolveProxyMode('not a url at all')).toBe('direct')
  })

  it('resolves entry modes own-first, then the global scalar', () => {
    const entry = (proxyUrl: string): Readonly<Record<string, unknown>> => ({ 'proxy-url': proxyUrl })
    expect(effectiveEntryMode(entry('socks5://h:1'), '')).toBe('proxy')
    expect(effectiveEntryMode(entry('direct'), 'socks5://h:1')).toBe('direct')
    expect(effectiveEntryMode(entry(''), 'socks5://h:1')).toBe('proxy')
    expect(effectiveEntryMode(entry(''), 'direct')).toBe('direct')
    expect(effectiveEntryMode(entry(''), '')).toBe('direct')
    expect(effectiveEntryMode(entry(''), 'not a url')).toBe('direct')
    expect(effectiveEntryMode({}, '')).toBe('direct')
  })

  it('indexes and strips proxied providers only', () => {
    const record: Record<string, unknown> = {
      'proxy-url': '',
      'claude-api-key': [
        { 'api-key': 'a', 'base-url': 'http://x', 'proxy-url': 'http://p:3128', models: [{ name: 'm1' }] },
        { 'api-key': 'b', 'base-url': 'http://y', models: [{ name: 'm2' }] },
      ],
      'gemini-api-key': [{ 'api-key': 'g', 'proxy-url': 'socks5://h:1', models: [{ name: 'm3' }] }],
    }
    const proxied = proxiedProviderIndexes(record)
    expect(globalProxyUrl(record)).toBe('')
    expect(proxied.get('claude-api-key')).toEqual(new Set([0]))
    expect(proxied.get('gemini-api-key')).toEqual(new Set([0]))
    const stripped = stripProxiedProviders(record, proxied)
    const claude = stripped['claude-api-key'] as Array<Record<string, unknown>>
    expect(claude).toHaveLength(1)
    expect(claude[0]?.['api-key']).toBe('b')
    expect(stripped['gemini-api-key']).toEqual([])
    // The source record is untouched.
    expect((record['claude-api-key'] as unknown[]).length).toBe(2)
  })

  it('treats entries without credentials as unpaired but harmless', () => {
    const record: Record<string, unknown> = {
      'claude-api-key': [{ models: [{ name: 'x' }] }],
    }
    const proxied = proxiedProviderIndexes(record)
    expect(proxied.size).toBe(0)
  })
})
