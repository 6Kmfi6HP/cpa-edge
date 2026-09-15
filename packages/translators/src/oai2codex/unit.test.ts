/**
 * Targeted unit coverage for rules the recorded goldens do not exercise
 * exhaustively: the union->enum trigger matrix (below threshold, non-const
 * branches, duplicates, both unions, pre-existing enums, raw number tokens),
 * the pattern-strip half with its alphabetical remarshal, the session
 * identity chain, tool-name shortening/restoration, the tool_choice
 * variants, history type selection, reasoning capability gating, usage
 * mapping edges, stream state-machine corners, the cooldown ladder, error
 * classification, and the NE-LENIENT boundary.
 */
import { describe, expect, it } from 'vitest'
import { CpaError, MemoryStore } from '@cpa-edge/core'
import { buildCodexUpstreamHeaders, orderCodexUpstreamHeaders } from './headers'
import {
  buildModelCooldownResponse,
  classifyCodexUpstreamError,
  codexTerminalFailureBody,
  codexTerminalFailureStatus,
  goDuration,
  renderUpstreamFailure,
  sanitizeUpstreamErrorSummary,
  wrapTypeForStatus,
} from './errors'
import { normalizeCodexParameters, normalizeCodexToolSchemasInBody, sanitizeToolName, shortenSanitizedName, shortenToolName, buildShortNameMap, restoreToolName } from './tools'
import { translateChatToCodex, translateReasoning, translateToolChoice } from './request'
import { deriveCodexSessionId, truncateRunes, uuidV5 } from './session'
import { CodexStreamChunkTranslator, codexUsageObject, imageMimeType } from './response'
import { parseDownstreamSse } from './sse'
import { createOai2CodexService } from './service'
import type { Oai2CodexChatRequest, Oai2CodexUpstreamRequest, Oai2CodexUpstreamResponse, Oai2CodexUpstreamSender } from './service'

const UPSTREAM_MODEL = 'gpt-mock-codex'

async function translate(body: unknown, options: { readonly thinking?: boolean; readonly session?: { readonly apiKey: string; readonly clientSessionId?: string } } = {}): Promise<Record<string, unknown>> {
  const result = await translateChatToCodex(JSON.stringify(body), {
    upstreamModel: UPSTREAM_MODEL,
    thinking: options.thinking,
    session: options.session ?? { apiKey: 'client-key' },
  })
  return JSON.parse(result.body) as Record<string, unknown>
}

function rawTranslate(body: string): Promise<ReturnType<typeof translateChatToCodex>> {
  return translateChatToCodex(body, { upstreamModel: UPSTREAM_MODEL, session: { apiKey: 'client-key' } })
}

// ---------------------------------------------------------------------------
// 2.11 union -> enum trigger matrix
// ---------------------------------------------------------------------------

const BRANCHES_8 = (value: (index: number) => string) =>
  Array.from({ length: 8 }, (_, index) => `{"const": ${value(index)}}`).join(',')

describe('schema normalization - union -> enum (2.11)', () => {
  it('rewrites an 8-branch pure-const oneOf to enum with the RAW tokens in order', () => {
    const parameters = `{"type": "object", "properties": {"mode": {"type": "string", "oneOf": [${BRANCHES_8((i) => `"v${i}"`)}]}}}`
    expect(normalizeCodexParameters(parameters)).toBe(
      `{"type": "object", "properties": {"mode": {"type": "string","enum":["v0","v1","v2","v3","v4","v5","v6","v7"]}}}`,
    )
  })

  it('keeps number const tokens verbatim (no precision loss)', () => {
    const parameters = `{"properties": {"n": {"oneOf": [{"const": 1},{"const": 2},{"const": 3},{"const": 1e2},{"const": 5},{"const": 6},{"const": 7},{"const": 9007199254740993}]}}}`
    expect(normalizeCodexParameters(parameters)).toBe(
      `{"properties": {"n": {"enum":[1,2,3,1e2,5,6,7,9007199254740993]}}}`,
    )
  })

  it('treats anyOf exactly like oneOf', () => {
    const parameters = `{"properties": {"x": {"anyOf": [${BRANCHES_8((i) => `"a${i}"`)}]}}}`
    expect(normalizeCodexParameters(parameters)).toBe(`{"properties": {"x": {"enum":["a0","a1","a2","a3","a4","a5","a6","a7"]}}}`)
  })

  it('below the 8-branch threshold: byte-untouched', () => {
    const parameters = `{"properties": {"mode": {"oneOf": [${BRANCHES_8((i) => `"v${i}"`).split(',').slice(0, 7).join(',')}]}}}`
    expect(normalizeCodexParameters(parameters)).toBe(parameters)
  })

  it('non-const branch: untouched', () => {
    const branches = BRANCHES_8((i) => `"v${i}"`).replace('{"const": "v3"}', '{"type": "string"}')
    const parameters = `{"properties": {"mode": {"oneOf": [${branches}]}}}`
    expect(normalizeCodexParameters(parameters)).toBe(parameters)
  })

  it('branch with keys outside const/description/title: untouched', () => {
    const branches = BRANCHES_8((i) => `"v${i}"`).replace('{"const": "v3"}', '{"const": "v3", "minimum": 1}')
    const parameters = `{"properties": {"mode": {"oneOf": [${branches}]}}}`
    expect(normalizeCodexParameters(parameters)).toBe(parameters)
  })

  it('duplicate const values: untouched', () => {
    const branches = BRANCHES_8((i) => `"v${i}"`).replace('{"const": "v7"}', '{"const": "v1"}')
    const parameters = `{"properties": {"mode": {"oneOf": [${branches}]}}}`
    expect(normalizeCodexParameters(parameters)).toBe(parameters)
  })

  it('both oneOf and anyOf present: untouched', () => {
    const parameters = `{"properties": {"mode": {"oneOf": [${BRANCHES_8((i) => `"v${i}"`)}], "anyOf": [${BRANCHES_8((i) => `"w${i}"`)}]}}}`
    expect(normalizeCodexParameters(parameters)).toBe(parameters)
  })

  it('pre-existing provably-equal enum: the union is deleted only', () => {
    const parameters = `{"properties": {"mode": {"enum": ["v0", "v1", "v2", "v3", "v4", "v5", "v6", "v7"], "oneOf": [${BRANCHES_8((i) => `"v${i}"`)}]}}}`
    expect(normalizeCodexParameters(parameters)).toBe(`{"properties": {"mode": {"enum": ["v0", "v1", "v2", "v3", "v4", "v5", "v6", "v7"]}}}`)
  })

  it('pre-existing enum that disagrees: byte-untouched', () => {
    const parameters = `{"properties": {"mode": {"enum": ["other"], "oneOf": [${BRANCHES_8((i) => `"v${i}"`)}]}}}`
    expect(normalizeCodexParameters(parameters)).toBe(parameters)
  })

  it('property with a non-object schema: untouched', () => {
    const parameters = '{"properties": {"mode": "not-a-schema"}}'
    expect(normalizeCodexParameters(parameters)).toBe(parameters)
  })

  it('nested properties beyond parameters.properties are not rewritten', () => {
    const inner = `{"oneOf": [${BRANCHES_8((i) => `"v${i}"`)}]}`
    const parameters = `{"properties": {"outer": {"properties": {"inner": ${inner}}}}}`
    expect(normalizeCodexParameters(parameters)).toBe(parameters)
  })
})

describe('schema normalization - pattern strip (2.11)', () => {
  it('deletes \\p pattern attributes and patternProperties keys, then remarshal alphabetically', () => {
    const parameters = '{"properties": {"a": {"type": "string", "pattern": "\\\\p{L}+"}, "b": {"patternProperties": {"\\\\p{N}": {"type": "number"}}}}}'
    const normalized = normalizeCodexParameters(parameters)
    expect(normalized).toBe('{"properties":{"a":{"type":"string"},"b":{}}}')
  })

  it('keeps \\p text inside description/default/enum values (user data)', () => {
    const parameters = '{"properties": {"a": {"description": "use \\\\p{L}", "default": "\\\\p{N}", "enum": ["\\\\p{L}"], "pattern": "\\\\p{L}+"}}}'
    const normalized = normalizeCodexParameters(parameters)
    const parsed = JSON.parse(normalized) as { properties: { a: Record<string, unknown> } }
    expect(parsed.properties.a['description']).toBe('use \\p{L}')
    expect(parsed.properties.a['default']).toBe('\\p{N}')
    expect(parsed.properties.a['enum']).toEqual(['\\p{L}'])
    expect(parsed.properties.a['pattern']).toBeUndefined()
    // The remarshal is alphabetical and compact.
    expect(normalized.startsWith('{"properties":{"a"')).toBe(true)
  })

  it('the alphabetical remarshal decodes \\u escapes (parse trigger)', () => {
    const parameters = '{"properties": {"\\u0061": {"pattern": "\\\\p{L}"}}}'
    const normalized = normalizeCodexParameters(parameters)
    expect(normalized).toBe('{"properties":{"a":{}}}')
  })

  it('non-firing schemas keep their original bytes', () => {
    const parameters = '{"type": "object", "properties": {"a": {"pattern": "^[a-z]+$"}}}'
    expect(normalizeCodexParameters(parameters)).toBe(parameters)
  })

  it('custom tools and nested namespace tools normalize through the body pass', () => {
    const body = `{"tools":[{"type":"function","name":"f","parameters":{"properties":{"m":{"oneOf":[${BRANCHES_8((i) => `"v${i}"`)}]}}},"strict":false},{"type":"mcp","tools":[{"type":"custom","name":"c","parameters":{"properties":{"m":{"oneOf":[${BRANCHES_8((i) => `"w${i}"`)}]}}}}]}]}`
    const normalized = normalizeCodexToolSchemasInBody(body)
    expect(normalized).toContain('"enum":["v0","v1","v2","v3","v4","v5","v6","v7"]')
    expect(normalized).toContain('"enum":["w0","w1","w2","w3","w4","w5","w6","w7"]')
    expect(normalized).not.toContain('oneOf')
  })
})

// ---------------------------------------------------------------------------
// 2.10 name shortening + restoration
// ---------------------------------------------------------------------------

describe('tool-name shortening + restoration (2.10)', () => {
  it('mcp__ names keep the prefix plus the last __ segment, truncated to 64', () => {
    const name = 'mcp__atlassian__jira_search_issues_with_advanced_filters_and_pagination_options'
    expect(shortenToolName(name)).toBe('mcp__jira_search_issues_with_advanced_filters_and_pagination_opt')
    expect(shortenToolName(name).length).toBe(64)
  })

  it('non-mcp long names truncate to 64; short names only sanitize', () => {
    expect(shortenToolName('a'.repeat(80))).toBe('a'.repeat(64))
    expect(sanitizeToolName('we!ird name/here')).toBe('we_ird_name_here')
    expect(shortenToolName('ok-name_1')).toBe('ok-name_1')
    expect(shortenSanitizedName('short')).toBe('short')
  })

  it('distinct originals colliding after shortening take _N suffixes within the limit', () => {
    const long = 'mcp__x__' + 'y'.repeat(60)
    const other = 'mcp__z__' + 'y'.repeat(60)
    const map = buildShortNameMap([long, other])
    const first = shortenToolName(long)
    const second = shortenToolName(other)
    expect(map[first]).toBe(long)
    expect(map[second]).toBe(other)
    expect(first).not.toBe(second)
    expect(second.length).toBeLessThanOrEqual(64)
  })

  it('repeated originals share one short name', () => {
    const map = buildShortNameMap(['same', 'same'])
    expect(Object.keys(map)).toEqual([shortenToolName('same')])
  })

  it('restoration falls back to the wire name for unknown names', () => {
    const map = buildShortNameMap(['mcp__x__' + 'y'.repeat(60)])
    expect(restoreToolName(shortenToolName('mcp__x__' + 'y'.repeat(60)), map)).toBe('mcp__x__' + 'y'.repeat(60))
    expect(restoreToolName('never-declared', map)).toBe('never-declared')
    expect(restoreToolName('x', undefined)).toBe('x')
  })
})

// ---------------------------------------------------------------------------
// 2.9 session identity
// ---------------------------------------------------------------------------

describe('session identity chain (2.9)', () => {
  it('derives stable UUIDs; the first user message and system text shape them, assistant content does not', async () => {
    const base = { apiKey: 'key-1', instructions: ['be terse'], userParts: [{ type: 'input_text', text: 'hello' }] }
    const first = await deriveCodexSessionId(base)
    const second = await deriveCodexSessionId(base)
    expect(first).toBe(second)
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(await deriveCodexSessionId({ ...base, userParts: [{ type: 'input_text', text: 'other' }] })).not.toBe(first)
    expect(await deriveCodexSessionId({ ...base, instructions: ['other system'] })).not.toBe(first)
    const withAssistant = await deriveCodexSessionId({ ...base, userParts: [{ type: 'input_text', text: 'hello' }] })
    expect(withAssistant).toBe(first)
  })

  it('falls back to the api-key UUID when the conversation has no user content', async () => {
    const fallback = await deriveCodexSessionId({ apiKey: 'key-1', instructions: [], userParts: [] })
    expect(fallback).toBe(await uuidV5('cli-proxy-api:codex:prompt-cache:key-1'))
  })

  it('a client session header changes the derived body value', async () => {
    const without = await deriveCodexSessionId({ apiKey: 'key-1', instructions: [], userParts: [{ type: 'input_text', text: 'q' }] })
    const withHeader = await deriveCodexSessionId({
      apiKey: 'key-1',
      instructions: [],
      userParts: [{ type: 'input_text', text: 'q' }],
      clientSessionId: '11111111-2222-3333-4444-555555555555',
    })
    expect(without).not.toBe(withHeader)
  })

  it('truncates identity instructions to 50 runes', () => {
    expect(truncateRunes('ä'.repeat(60), 50)).toBe('ä'.repeat(50))
    expect(truncateRunes('short', 50)).toBe('short')
  })

  it('body prompt_cache_key passes through verbatim for both surfaces; header wins for Session-Id', async () => {
    const request = await rawTranslate('{"model":"cx","messages":[{"role":"user","content":"q"}],"prompt_cache_key":"fixed-123"}')
    expect(request.promptCacheKey).toBe('fixed-123')
    expect(request.sessionHeaderValue).toBe('fixed-123')
    expect((JSON.parse(request.body) as Record<string, unknown>)['prompt_cache_key']).toBe('fixed-123')

    const withHeader = await translateChatToCodex('{"model":"cx","messages":[{"role":"user","content":"q"}]}', {
      upstreamModel: UPSTREAM_MODEL,
      session: { apiKey: 'k', clientSessionId: 'sess-header' },
    })
    expect(withHeader.sessionHeaderValue).toBe('sess-header')
    expect(withHeader.promptCacheKey).not.toBe('sess-header')
  })
})

// ---------------------------------------------------------------------------
// 2.3 request body construction
// ---------------------------------------------------------------------------

describe('request translation (2.3, 3.1-3.3)', () => {
  it('drops the whole reasoning object for capability-less models (recorded strip)', async () => {
    for (const effort of ['high', 'none', 'low']) {
      const body = await translate({ model: 'cx', messages: [{ role: 'user', content: 'q' }], reasoning_effort: effort })
      expect(body['reasoning']).toBeUndefined()
    }
  })

  it('capability-ON models keep the two-phase reasoning construction', async () => {
    expect(await translate({ messages: [], reasoning_effort: 'high' }, { thinking: true })).toEqual({
      effort: 'high',
      summary: 'auto',
    })
    expect(await translate({ messages: [], reasoning_effort: 'none' }, { thinking: true })).toEqual({ effort: 'none' })
    expect(await translate({ messages: [], reasoning_effort: '' }, { thinking: true })).toEqual({ effort: '' })
    expect(await translate({ messages: [] }, { thinking: true })).toEqual({ effort: 'medium', summary: 'auto' })
    expect(translateReasoning({ reasoning_effort: 'high' }, false)).toBeUndefined()
  })

  it('canonical field order: input, [text], tools, tool_choice, store, prompt_cache_key; injected tool after store when the client sent none', async () => {
    const result = await rawTranslate('{"model":"cx","messages":[{"role":"user","content":"q"}],"tools":[{"type":"function","function":{"name":"f"}}]}')
    const body = JSON.parse(result.body) as Record<string, unknown>
    expect(Object.keys(body)).toEqual(['instructions', 'stream', 'parallel_tool_calls', 'include', 'model', 'input', 'tools', 'store', 'prompt_cache_key'])

    const bare = await rawTranslate('{"model":"cx","messages":[{"role":"user","content":"q"}]}')
    const bareBody = JSON.parse(bare.body) as Record<string, unknown>
    expect(Object.keys(bareBody)).toEqual(['instructions', 'stream', 'parallel_tool_calls', 'include', 'model', 'input', 'store', 'tools', 'prompt_cache_key'])
    expect((bareBody['tools'] as unknown[])[0]).toEqual({ type: 'image_generation', output_format: 'png' })
    expect(bareBody['store']).toBe(false)
    expect(bareBody['parallel_tool_calls']).toBe(true)
  })

  it('a client image_generation tool suppresses the injection; spark models suppress it too', async () => {
    const declared = await translate({ messages: [{ role: 'user', content: 'q' }], tools: [{ type: 'image_generation', output_format: 'jpg' }] })
    expect(declared['tools']).toEqual([{ type: 'image_generation', output_format: 'jpg' }])

    const spark = await translateChatToCodex('{"model":"cx","messages":[{"role":"user","content":"q"}]}', {
      upstreamModel: 'gpt-5-codex-spark',
      session: { apiKey: 'k' },
    })
    expect((JSON.parse(spark.body) as Record<string, unknown>)['tools']).toBeUndefined()
    expect((JSON.parse(spark.body) as Record<string, unknown>)['parallel_tool_calls']).toBeUndefined()
  })

  it('system/developer messages become developer input_text; assistant content becomes output_text', async () => {
    const body = await translate({
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'developer', content: 'dev' },
        { role: 'user', content: 'u' },
        { role: 'assistant', content: 'a' },
      ],
    })
    const input = body['input'] as Record<string, unknown>[]
    expect(input.map((item) => [item['role'], (item['content'] as Record<string, unknown>[])[0]?.['type']])).toEqual([
      ['developer', 'input_text'],
      ['developer', 'input_text'],
      ['user', 'input_text'],
      ['assistant', 'output_text'],
    ])
  })

  it('assistant carriers with no content are dropped; empty string content yields zero parts but keeps the item', async () => {
    const body = await translate({
      messages: [
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
        { role: 'user', content: '' },
      ],
      tools: [{ type: 'function', function: { name: 'f' } }],
    })
    const input = body['input'] as Record<string, unknown>[]
    expect(input.map((item) => item['type'])).toEqual(['function_call', 'message'])
    expect(input[1]?.['content']).toEqual([])
  })

  it('synthetic ids for missing tool-call ids; duplicates drop their items and outputs', async () => {
    const body = await translate({
      messages: [
        {
          role: 'assistant',
          tool_calls: [
            { type: 'function', function: { name: 'f', arguments: '{}' } },
            { type: 'function', function: { name: 'f', arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_missing_0_0', content: 'ok' },
      ],
      tools: [{ type: 'function', function: { name: 'f' } }],
    })
    const input = body['input'] as Record<string, unknown>[]
    expect(input.map((item) => item['type'])).toEqual(['function_call', 'function_call_output'])

    const dup = await translate({
      messages: [
        {
          role: 'assistant',
          tool_calls: [
            { id: 'same', type: 'function', function: { name: 'f', arguments: '{}' } },
            { id: 'same', type: 'function', function: { name: 'f', arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'same', content: 'x' },
      ],
      tools: [{ type: 'function', function: { name: 'f' } }],
    })
    expect(dup['input']).toEqual([])
  })

  it('tool messages with no pending call are dropped; a non-tool message resets the pending set', async () => {
    const body = await translate({
      messages: [
        { role: 'tool', tool_call_id: 'orphan', content: 'x' },
        { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
        { role: 'user', content: 'mid' },
        { role: 'tool', tool_call_id: 'c1', content: 'late' },
      ],
      tools: [{ type: 'function', function: { name: 'f' } }],
    })
    const input = body['input'] as Record<string, unknown>[]
    expect(input.map((item) => item['type'])).toEqual(['function_call', 'message'])
  })

  it('history type selection: function-named-after-custom -> custom_tool_call/input; shared names stay function_call', async () => {
    const body = await translate({
      messages: [
        {
          role: 'assistant',
          tool_calls: [
            { id: 'c1', type: 'function', function: { name: 'custom_only', arguments: '["x"]' } },
            { id: 'c2', type: 'function', function: { name: 'shared', arguments: '{}' } },
            { id: 'c3', type: 'function', function: { name: 'undeclared', arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'c1', content: 'r1' },
        { role: 'tool', tool_call_id: 'c2', content: 'r2' },
        { role: 'tool', tool_call_id: 'c3', content: 'r3' },
      ],
      tools: [
        { type: 'custom', name: 'custom_only' },
        { type: 'function', function: { name: 'shared' } },
        { type: 'custom', name: 'shared' },
      ],
    })
    const input = body['input'] as Record<string, unknown>[]
    expect(input.map((item) => [item['type'], item['input'] ?? item['arguments']]).slice(0, 3)).toEqual([
      ['custom_tool_call', '["x"]'],
      ['function_call', '{}'],
      ['function_call', '{}'],
    ])
    expect(input.slice(3).map((item) => item['type'])).toEqual(['custom_tool_call_output', 'function_call_output', 'function_call_output'])
  })

  it('tool_choice variants: string verbatim, function rebuild, custom switch, empty-type drop, other-object verbatim', () => {
    const map: Record<string, string> = {}
    const customOnly = new Set(['custom_only'])
    expect(translateToolChoice('auto', map, customOnly)).toBe('auto')
    expect(translateToolChoice({ type: 'function', function: { name: 'fn' } }, map, customOnly)).toEqual({ type: 'function', name: 'fn' })
    expect(translateToolChoice({ type: 'function', function: { name: 'custom_only' } }, map, customOnly)).toEqual({ type: 'custom', name: 'custom_only' })
    expect(translateToolChoice({ type: 'custom', name: 'custom_only' }, map, customOnly)).toEqual({ type: 'custom', name: 'custom_only' })
    expect(translateToolChoice({ type: 'function' }, map, customOnly)).toEqual({ type: 'function' })
    expect(translateToolChoice({ type: '' }, map, customOnly)).toBeUndefined()
    expect(translateToolChoice({ type: 'web_search', search: 'auto' }, map, customOnly)).toEqual({ type: 'web_search', search: 'auto' })
    expect(translateToolChoice(42, map, customOnly)).toBeUndefined()
  })

  it('text mapping: json_schema keeps the raw schema bytes, json_object leaves an empty text object', async () => {
    const raw =
      '{"model":"cx","messages":[{"role":"user","content":"q"}],' +
      '"response_format":{"type":"json_schema","json_schema":{"name":"s","strict":true,"schema": { "type": "object" }}},' +
      '"text":{"verbosity":"low"}}'
    const result = await rawTranslate(raw)
    expect(result.body).toContain('"text":{"format":{"type":"json_schema","name":"s","strict":true,"schema": { "type": "object" }},"verbosity":"low"}')

    const objectFormat = await translate({ messages: [], response_format: { type: 'json_object' } })
    expect(objectFormat['text']).toEqual({})
  })

  it('sampling knobs are silently dropped', async () => {
    const body = await translate({
      messages: [{ role: 'user', content: 'q' }],
      temperature: 0.5,
      top_p: 0.5,
      max_tokens: 10,
      stop: ['x'],
      presence_penalty: 1,
      user: 'u',
      stream_options: {},
      parallel_tool_calls: false,
      store: true,
      service_tier: 'auto',
    })
    for (const key of ['temperature', 'top_p', 'max_tokens', 'stop', 'presence_penalty', 'user', 'stream_options', 'service_tier']) {
      expect(body[key]).toBeUndefined()
    }
    expect(body['parallel_tool_calls']).toBe(true)
    expect(body['store']).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 2.2 headers
// ---------------------------------------------------------------------------

describe('upstream headers (2.2)', () => {
  const base = { apiKey: 'up-key', sessionId: 'sess-1' }

  it('whitelisted client headers pass with original casing; everything else drops', () => {
    const headers = buildCodexUpstreamHeaders({
      ...base,
      clientHeaders: {
        'X-Codex-Beta-Features': 'b',
        version: '1.2.3',
        'X-Client-Request-Id': 'r',
        Cookie: 'nope',
        Accept: '*/*',
        'User-Agent': 'curl/8',
        'X-Not-Forwarded': 'x',
      },
    })
    expect(headers['X-Codex-Beta-Features']).toBe('b')
    expect(headers['version']).toBe('1.2.3')
    expect(headers['X-Client-Request-Id']).toBe('r')
    expect(headers['Cookie']).toBeUndefined()
    expect(headers['Accept']).toBe('text/event-stream')
  })

  it('cloaking overrides UA/Originator unconditionally; disable-codex-cloaking keeps caller values', () => {
    const cloaked = buildCodexUpstreamHeaders({ ...base, clientHeaders: { 'User-Agent': 'mine', Originator: 'yours' } })
    expect(cloaked['User-Agent']).toContain('codex-tui/0.154.0')
    expect(cloaked['Originator']).toBe('codex-tui')

    const plain = buildCodexUpstreamHeaders({
      ...base,
      disableCodexCloaking: true,
      gatewayVersion: 'v7.3.4',
      clientHeaders: { 'User-Agent': 'mine', Originator: 'yours' },
    })
    expect(plain['User-Agent']).toBe('mine')
    expect(plain['Originator']).toBe('yours')

    const noCaller = buildCodexUpstreamHeaders({ ...base, disableCodexCloaking: true, gatewayVersion: 'v7.3.4', clientHeaders: {} })
    expect(noCaller['User-Agent']).toBe('CLIProxyAPI/v7.3.4')
    expect(noCaller['Originator']).toBeUndefined()
  })

  it('credential headers apply after the whitelist; emission order is Host/UA/Content-Length, ASCII rest, Accept-Encoding last', () => {
    const headers = buildCodexUpstreamHeaders({
      ...base,
      clientHeaders: { 'X-Codex-Window-Id': 'w' },
      credentialHeaders: { 'X-Custom': 'c' },
    })
    const ordered = orderCodexUpstreamHeaders(headers, 'http://mock:21003/responses', 'abc')
    expect(ordered.map(([name]) => name)).toEqual([
      'Host',
      'User-Agent',
      'Content-Length',
      'Accept',
      'Authorization',
      'Connection',
      'Content-Type',
      'Originator',
      'Session-Id',
      'X-Codex-Window-Id',
      'X-Custom',
      'Accept-Encoding',
    ])
    expect(ordered[0]?.[1]).toBe('mock:21003')
    expect(ordered[2]?.[1]).toBe('3')
  })
})

// ---------------------------------------------------------------------------
// 2.6-2.8 stream state machine
// ---------------------------------------------------------------------------

function streamTranslator(): CodexStreamChunkTranslator {
  return new CodexStreamChunkTranslator({ streamModel: UPSTREAM_MODEL })
}

function line(type: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ type, ...payload })
}

describe('stream translation corners (2.6-2.8)', () => {
  it('service_tier latches on every chunk after response.created; usage rides the terminal chunk', () => {
    const translator = streamTranslator()
    const out: string[] = []
    for (const data of [
      line('response.created', { response: { id: 'r', created_at: 5, model: 'm', service_tier: 'priority' } }),
      line('response.output_text.delta', { delta: 'a' }),
      line('response.completed', { response: { id: 'r', status: 'completed', usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } } }),
    ]) {
      const result = translator.translateDataLine(data)
      for (const frame of result.frames) out.push(frame)
    }
    expect(out).toEqual([
      '{"id":"r","object":"chat.completion.chunk","created":5,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"a"},"finish_reason":null,"native_finish_reason":null}],"service_tier":"priority"}',
      '{"id":"r","object":"chat.completion.chunk","created":5,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop","native_finish_reason":"stop"}],"service_tier":"priority","usage":{"completion_tokens":2,"total_tokens":3,"prompt_tokens":1}}',
    ])
  })

  it('no done-chunk after argument deltas; empty-args done emits nothing', () => {
    const translator = streamTranslator()
    const frames: string[] = []
    const collect = (data: string): void => {
      const result = translator.translateDataLine(data)
      if (result.kind === 'frames') frames.push(...result.frames)
    }
    collect(line('response.created', { response: { id: 'r', created_at: 1, model: 'm' } }))
    collect(line('response.output_item.added', { output_index: 0, item: { type: 'function_call', id: 'i', call_id: 'c', name: 'f', arguments: '' } }))
    collect(line('response.function_call_arguments.delta', { item_id: 'i', delta: '{"a"' }))
    collect(line('response.function_call_arguments.done', { item_id: 'i', arguments: '{"a":1}' }))
    collect(line('response.output_item.done', { output_index: 0, item: { type: 'function_call', id: 'i', call_id: 'c', name: 'f', arguments: '{"a":1}' } }))
    collect(line('response.completed', { response: { status: 'completed' } }))
    const toolFrames = frames.filter((frame) => frame.includes('tool_calls'))
    expect(toolFrames.length).toBe(2)
    const terminal = frames[frames.length - 1] ?? ''
    expect(terminal).toContain('"finish_reason":"tool_calls"')
    expect(terminal).toContain('"native_finish_reason":"tool_calls"')

    const empty = streamTranslator()
    const added = empty.translateDataLine(line('response.output_item.added', { output_index: 0, item: { type: 'function_call', id: 'i', call_id: 'c', name: 'f' } }))
    expect(added.frames.length).toBe(1)
    expect(empty.translateDataLine(line('response.function_call_arguments.done', { item_id: 'i', arguments: '' })).frames).toEqual([])
    expect(empty.translateDataLine(line('response.output_item.done', { output_index: 0, item: { type: 'function_call', id: 'i', call_id: 'c', name: 'f', arguments: '' } })).frames).toEqual([])
  })

  it('an unannounced done item emits one complete chunk with the full arguments', () => {
    const translator = streamTranslator()
    const done = translator.translateDataLine(
      line('response.output_item.done', { output_index: 0, item: { type: 'function_call', id: 'i', call_id: 'c', name: 'f', arguments: '{"x":1}' } }),
    )
    expect(done.frames[0]).toContain('"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"c","type":"function","function":{"name":"f","arguments":"{\\"x\\":1}"}}]}')
  })

  it('custom_tool_call items use the input field for arguments deltas', () => {
    const translator = streamTranslator()
    const frames: string[] = []
    for (const data of [
      line('response.output_item.added', { output_index: 0, item: { type: 'custom_tool_call', id: 'i', call_id: 'c', name: 'f' } }),
      line('response.custom_tool_call_input.delta', { item_id: 'i', delta: 'ab' }),
      line('response.custom_tool_call_input.done', { item_id: 'i', input: 'ab' }),
    ]) {
      const result = translator.translateDataLine(data)
      if (result.kind === 'frames') frames.push(...result.frames)
    }
    expect(frames.length).toBe(2)
    expect(frames[1]).toContain('"function":{"arguments":"ab"}')
  })

  it('image chunks carry index 0 and dedup identical consecutive payloads per item', () => {
    const translator = streamTranslator()
    const payload = { item_id: 'img', partial_image_b64: 'AAA' }
    const first = translator.translateDataLine(line('response.image_generation_call.partial_image', payload))
    const repeat = translator.translateDataLine(line('response.image_generation_call.partial_image', payload))
    const second = translator.translateDataLine(line('response.image_generation_call.partial_image', { ...payload, partial_image_b64: 'BBB' }))
    expect(first.frames.length).toBe(1)
    expect(repeat.frames.length).toBe(0)
    expect(second.frames.length).toBe(1)
    expect(first.frames[0]).toContain('"images":[{"index":0,"type":"image_url","image_url":{"url":"data:image/png;base64,AAA"}}')
    expect(imageMimeType('jpg')).toBe('image/jpeg')
    expect(imageMimeType('image/custom')).toBe('image/custom')
    expect(imageMimeType('weird')).toBe('image/png')
  })

  it('response.done stops the read loop without a finish chunk', () => {
    const translator = streamTranslator()
    const result = translator.translateDataLine(line('response.done', {}))
    expect(result.kind).toBe('alias-stop')
  })

  it('reasoning done events emit the \\n\\n separator chunk', () => {
    const frames = streamTranslator().translateDataLine(line('response.reasoning_text.done', {})).frames
    expect(frames[0]).toContain('"reasoning_content":"\\n\\n"')
  })

  it('E6 fires only for incomplete terminals with zero output', () => {
    const translator = streamTranslator()
    translator.translateDataLine(line('response.created', { response: { id: 'r', created_at: 1, model: 'm' } }))
    const empty = translator.translateDataLine(
      line('response.incomplete', { response: { status: 'incomplete', output: [], usage: { output_tokens: 0 } } }),
    )
    expect(empty.kind).toBe('empty-incomplete')

    const withDelta = streamTranslator()
    withDelta.translateDataLine(line('response.output_text.delta', { delta: 'x' }))
    const notEmpty = withDelta.translateDataLine(
      line('response.incomplete', { response: { status: 'incomplete', output: [], usage: { output_tokens: 0 }, incomplete_details: { reason: 'max_output_tokens' } } }),
    )
    expect(notEmpty.kind).toBe('stop')
    expect(notEmpty.kind === 'stop' ? notEmpty.frames[0] : '').toContain('"finish_reason":"length","native_finish_reason":"max_output_tokens"')
  })

  it('interleaved tool calls keep their per-item indices and event order', () => {
    const translator = streamTranslator()
    const frames: string[] = []
    for (const data of [
      line('response.output_item.added', { output_index: 0, item: { type: 'function_call', id: 'a', call_id: 'ca', name: 'f' } }),
      line('response.output_item.added', { output_index: 1, item: { type: 'function_call', id: 'b', call_id: 'cb', name: 'g' } }),
      line('response.function_call_arguments.delta', { item_id: 'a', delta: '1' }),
      line('response.function_call_arguments.delta', { item_id: 'b', delta: '2' }),
      line('response.function_call_arguments.delta', { item_id: 'a', delta: '3' }),
    ]) {
      const result = translator.translateDataLine(data)
      if (result.kind === 'frames') frames.push(...result.frames)
    }
    const indices = frames.map((frame) => /"index":(\d)/.exec(frame)?.[1])
    expect(indices).toEqual(['0', '1', '0', '1', '0'])
  })
})

// ---------------------------------------------------------------------------
// 2.7 usage mapping
// ---------------------------------------------------------------------------

describe('usage mapping (2.7)', () => {
  it('exact key order with the cache_write_tokens duplication; non-integers drop', () => {
    const usage = codexUsageObject({
      input_tokens: 9,
      output_tokens: 6,
      total_tokens: 15,
      input_tokens_details: { cached_tokens: 4, cache_write_tokens: 7 },
      output_tokens_details: { reasoning_tokens: 11 },
    })
    expect(JSON.stringify(usage)).toBe(
      '{"completion_tokens":6,"total_tokens":15,"prompt_tokens":9,"prompt_tokens_details":{"cached_tokens":4,"cache_write_tokens":7,"cached_creation_tokens":7},"completion_tokens_details":{"reasoning_tokens":11}}',
    )
    expect(codexUsageObject({ output_tokens: 1, input_tokens_details: { cache_write_tokens: 1.5 } })).toBe('{"completion_tokens":1}')
    expect(codexUsageObject(null)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 5 error semantics
// ---------------------------------------------------------------------------

describe('error classification (E1, E8)', () => {
  it('valid JSON bodies pass through verbatim with the upstream status', () => {
    const body = '{"error": {"message": "x"}}'
    const rendered = renderUpstreamFailure(classifyCodexUpstreamError(429, body))
    expect(rendered).toEqual({ status: 429, body })
  })

  it('non-JSON bodies wrap per the status mapping', () => {
    expect(renderUpstreamFailure(classifyCodexUpstreamError(429, 'oops'))).toEqual({
      status: 429,
      body: '{"error":{"message":"oops","type":"rate_limit_error","code":"rate_limit_exceeded"}}',
    })
    expect(renderUpstreamFailure(classifyCodexUpstreamError(401, ''))).toEqual({
      status: 401,
      body: '{"error":{"message":"Unauthorized","type":"authentication_error","code":"invalid_api_key"}}',
    })
    expect(wrapTypeForStatus(418)).toEqual({ type: 'invalid_request_error' })
  })

  it('E8 rewrites: context_too_large, auth, usage_limit re-stated as 429 verbatim', () => {
    const context = renderUpstreamFailure(classifyCodexUpstreamError(413, '{"error":{"message":"too big","code":"context_length_exceeded"}}'))
    expect(context).toEqual({
      status: 413,
      body: '{"error":{"message":"too big","type":"invalid_request_error","code":"context_too_large"}}',
    })
    const auth = renderUpstreamFailure(classifyCodexUpstreamError(401, '{"error":{"message":"bad key"}}'))
    expect(auth).toEqual({
      status: 401,
      body: '{"error":{"message":"bad key","type":"authentication_error","code":"auth_unavailable"}}',
    })
    const limitBody = '{"error": {"message": "Usage limit reached", "type": "usage_limit_reached"}}'
    const limit = renderUpstreamFailure(classifyCodexUpstreamError(403, limitBody))
    expect(limit).toEqual({ status: 429, body: limitBody })
  })

  it('terminal failure bodies extract the raw error object and derive the status', () => {
    const failed = '{"type": "response.failed", "response": {"error": {"code": "server_error", "message": "boom"}, "status": "failed"}}'
    expect(codexTerminalFailureBody(failed)).toBe('{"error":{"code": "server_error", "message": "boom"}}')
    expect(codexTerminalFailureStatus(failed)).toBe(502)
    const withStatus = '{"error": {"message": "nope", "status_code": 429}}'
    expect(codexTerminalFailureStatus(withStatus)).toBe(429)
    expect(codexTerminalFailureStatus('{"error": {"code": "not_found"}}')).toBe(404)
    expect(codexTerminalFailureStatus('{"error": {"code": "cyber_policy"}}')).toBe(400)
    expect(codexTerminalFailureBody('{"type": "error"}')).toBe(
      '{"error":{"message":"upstream stream failed without error details"}}',
    )
    const withSeq = '{"error": {"message": "x"}, "sequence_number": 7}'
    expect(codexTerminalFailureBody(withSeq)).toBe('{"error":{"message": "x"},"sequence_number":7}')
  })

  it('cooldown envelope: alphabetical keys, verbatim last_upstream_error, 256-rune truncation, Retry-After', () => {
    const body = buildModelCooldownResponse({
      model: 'cx',
      provider: 'codex',
      lastUpstreamError: '{"error": {"message": "rate limited"}}',
      resetSeconds: 4,
    })
    expect(body.status).toBe(429)
    expect(body.retryAfter).toBe('4')
    expect(body.body).toBe(
      '{"error":{"code":"model_cooldown","last_upstream_error":"{\\"error\\": {\\"message\\": \\"rate limited\\"}}","message":"All credentials for model cx are cooling down via provider codex (last error: {\\"error\\": {\\"message\\": \\"rate limited\\"}})","model":"cx","provider":"codex","reset_seconds":4,"reset_time":"4s"}}',
    )

    const long = 'x'.repeat(300)
    const truncated = sanitizeUpstreamErrorSummary(long)
    expect(truncated).toBe('x'.repeat(253) + '...')
    expect(sanitizeUpstreamErrorSummary('short')).toBe('short')
    expect(goDuration(4)).toBe('4s')
    expect(goDuration(90)).toBe('1m30s')
    expect(goDuration(3600)).toBe('1h0m0s')
  })
})

// ---------------------------------------------------------------------------
// Facade: NE-LENIENT, cooldown ladder, disconnect
// ---------------------------------------------------------------------------

const SERVICE_OPTIONS = {
  credentials: [{ apiKey: 'up-key', baseUrl: 'http://mock:1', models: [{ name: UPSTREAM_MODEL, alias: 'cx' }] }],
  gatewayVersion: 'v7.3.4',
  transientErrorCooldownSeconds: -1,
}

function chatRequest(body: string): Oai2CodexChatRequest {
  return { method: 'POST', path: '/v1/chat/completions', headers: [['Authorization', 'Bearer client']], body }
}

function sseResponse(chunks: string[], abortAfter?: number): Oai2CodexUpstreamResponse {
  const encoder = new TextEncoder()
  let served = 0
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const index = served
      served += 1
      if (abortAfter !== undefined && index >= abortAfter) {
        controller.error(new Error('reset'))
        return
      }
      const chunk = chunks[index]
      if (chunk === undefined) {
        controller.close()
        return
      }
      controller.enqueue(encoder.encode(chunk))
    },
  })
  return { status: 200, headers: [], body: stream }
}

function errorResponse(status: number, body: string, headers: Array<[string, string]> = []): Oai2CodexUpstreamResponse {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(body))
      controller.close()
    },
  })
  return { status, headers, body: stream }
}

async function readBody(response: { readonly body: string | ReadableStream<Uint8Array> }): Promise<string> {
  if (typeof response.body === 'string') return response.body
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let out = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    out += decoder.decode(value, { stream: true })
  }
  return out + decoder.decode()
}

describe('facade behavior', () => {
  it('NE-LENIENT: malformed bodies fail with 400 before any upstream call', async () => {
    let calls = 0
    const send: Oai2CodexUpstreamSender = async () => {
      calls += 1
      throw new Error('unreachable')
    }
    const service = createOai2CodexService({ ...SERVICE_OPTIONS, store: new MemoryStore() })
    const response = await service.handleChatCompletions(chatRequest('{"model": "cx", nope'), send)
    expect(response.status).toBe(400)
    expect(response.body).toBe('{"error":{"message":"Invalid request: malformed JSON body","type":"invalid_request_error"}}')
    expect(calls).toBe(0)
  })

  it('the 429 cooldown ladder: 1s window, escalation, Retry-After hint floor, verbatim embed, recovery', async () => {
    let clockMs = 1_000_000
    const store = new MemoryStore({ now: () => clockMs })
    const service = createOai2CodexService({ ...SERVICE_OPTIONS, store, now: () => clockMs })
    const rateLimitBody = '{"error": {"message": "mock rate limit"}}'
    let upstreamCalls = 0
    const send: Oai2CodexUpstreamSender = async () => {
      upstreamCalls += 1
      return errorResponse(429, rateLimitBody)
    }
    const first = await service.handleChatCompletions(chatRequest('{"model":"cx","messages":[{"role":"user","content":"q"}]}'), send)
    expect(first.status).toBe(429)
    expect(first.body).toBe(rateLimitBody)

    const second = await service.handleChatCompletions(chatRequest('{"model":"cx","messages":[{"role":"user","content":"q"}]}'), send)
    expect(second.status).toBe(429)
    expect(second.body).toContain('"code":"model_cooldown"')
    expect(second.body).toContain(`"last_upstream_error":"{\\"error\\": {\\"message\\": \\"mock rate limit\\"}}"`)
    expect(second.body).toContain('"message":"All credentials for model cx are cooling down via provider codex')
    expect(second.body).toContain('"provider":"codex"')
    expect(parseDownstreamHeaders(second.headers)['retry-after']).toBe('1')
    expect(second.body).toContain('"reset_seconds":1,"reset_time":"1s"')
    expect(upstreamCalls).toBe(1)

    clockMs += 1_100
    const third = await service.handleChatCompletions(chatRequest('{"model":"cx","messages":[{"role":"user","content":"q"}]}'), send)
    expect(third.status).toBe(429)
    expect(upstreamCalls).toBe(2)

    const fourth = await service.handleChatCompletions(chatRequest('{"model":"cx","messages":[{"role":"user","content":"q"}]}'), send)
    // Second consecutive 429 escalates the ladder to 2s; still inside it.
    expect(fourth.status).toBe(429)
    expect(fourth.body).toContain('"reset_seconds":2,"reset_time":"2s"')

    clockMs += 2_100
    const recovered = await service.handleChatCompletions(chatRequest('{"model":"cx","messages":[{"role":"user","content":"q"}]}'), send)
    expect(recovered.status).toBe(429)
    expect(recovered.body).toBe(rateLimitBody)
  })

  it('an upstream Retry-After hint floors the window at 10 seconds', async () => {
    let clockMs = 5_000_000
    const store = new MemoryStore({ now: () => clockMs })
    const service = createOai2CodexService({ ...SERVICE_OPTIONS, store, now: () => clockMs })
    const send: Oai2CodexUpstreamSender = async () => errorResponse(429, '{"error":{"message":"x"}}', [['Retry-After', '2']])
    await service.handleChatCompletions(chatRequest('{"model":"cx","messages":[{"role":"user","content":"q"}]}'), send)
    const cooling = await service.handleChatCompletions(chatRequest('{"model":"cx","messages":[{"role":"user","content":"q"}]}'), send)
    expect(cooling.body).toContain('"reset_seconds":10,"reset_time":"10s"')
    expect(parseDownstreamHeaders(cooling.headers)['retry-after']).toBe('10')
  })

  it('a stream that ends without a terminal event is the pre-commit 408 disconnect shape', async () => {
    const service = createOai2CodexService({ ...SERVICE_OPTIONS, store: new MemoryStore() })
    const send: Oai2CodexUpstreamSender = async () =>
      sseResponse(['event: response.created\ndata: {"type": "response.created", "response": {"id": "r", "created_at": 1, "model": "m"}}\n\n'])
    const response = await service.handleChatCompletions(chatRequest('{"model":"cx","messages":[{"role":"user","content":"q"}],"stream":true}'), send)
    expect(response.status).toBe(408)
    expect(response.body).toBe(
      '{"error":{"message":"stream error: stream disconnected before completion: stream closed before response.completed","type":"invalid_request_error"}}',
    )
  })

  it('model resolution failure (E7) never calls the upstream', async () => {
    let calls = 0
    const send: Oai2CodexUpstreamSender = async () => {
      calls += 1
      throw new Error('unreachable')
    }
    const service = createOai2CodexService({ ...SERVICE_OPTIONS, store: new MemoryStore() })
    const response = await service.handleChatCompletions(chatRequest('{"model":"nope","messages":[]}'), send)
    expect(response.status).toBe(400)
    expect(response.body).toBe('{"error":{"message":"unknown provider for model nope","type":"invalid_request_error","code":"model_not_found","param":"model"}}')
    expect(calls).toBe(0)
  })

  it('strict boundary rejects non-object JSON bodies', async () => {
    const service = createOai2CodexService({ ...SERVICE_OPTIONS, store: new MemoryStore() })
    const send: Oai2CodexUpstreamSender = async () => {
      throw new Error('unreachable')
    }
    const response = await service.handleChatCompletions(chatRequest('[1,2]'), send)
    expect(response.status).toBe(400)
    await expect(rawTranslate('nope')).rejects.toBeInstanceOf(CpaError)
  })
})

function parseDownstreamHeaders(headers: ReadonlyArray<readonly [string, string]>): Record<string, string> {
  const record: Record<string, string> = {}
  for (const [name, value] of headers) record[name.toLowerCase()] = value
  return record
}

void parseDownstreamSse
