
/**
 * Targeted units of the Codex passthrough (S2d9): the id-normalization
 * matrix, the image-generation mode matrix, the Lite dialect, per-frame
 * usage-detail injection, Codex-client detection, error re-serialization
 * (alphabetical keys, raw number tokens, sanitizers), the cooldown
 * families, SSE framer edge cases (comment gluing, `data:` normalization,
 * split payloads, CRLF endings), model echo + force-mapping, the
 * `response.done` rename, terminal output repair, first-frame gating and
 * the compact route's local rejections. Golden byte behavior lives in
 * golden.test.ts; these units pin the rules the fixtures do not reach.
 */
import { describe, expect, test } from 'vitest'
import { MemoryStore } from '@cpa-edge/core'
import {
  buildAuthUnavailableResponse,
  buildModelCooldownResponse,
  classifyUpstreamStatusError,
  codexTerminalFailureStatus,
  formatTerminalFailureFrame,
  incompleteStreamBody,
  isCodexClient,
  modelNotFoundBody,
  synthesizedDetailForStatus,
  terminalFailureDetail,
  truncateRunes,
} from './errors'
import {
  appendMember,
  deleteMember,
  marshalSorted,
  parseStrictJson,
  remarshalSortedRaw,
  scanObjectMembers,
  serializeOrdered,
  tryParseJson,
} from './json'
import { isPlainObject } from './json'
import { planInputItemIds, ITEM_ID_RUNE_LIMIT } from './ids'
import { translateCompactPassthrough, translateResponsesPassthrough } from './request'
import type { PassthroughRequestContext } from './request'
import {
  hydrateOutputItemIds,
  injectResponseModel,
  repairEmptyOutput,
  renameTypeValue,
  rewriteModelFields,
  transformFramePayload,
} from './response'
import type { FrameTransformState } from './response'
import { aggregatePassthroughStream } from './stream'
import { formatDataLine, parseDownstreamSse, scanSseLines } from './sse'
import { isValidEncryptedContent } from './signature'
import { createCodexPassthroughService } from './service'
import type {
  CodexPassthroughResponse,
  CodexPassthroughService,
  CodexPassthroughUpstreamRequest,
  CodexPassthroughUpstreamResponse,
} from './service'

const FROZEN_NOW = 1_789_506_658_255

/** Real SSE line terminators (kept out of string literals for clarity). */
const LF = '\n'
const CRLF = '\r\n'

function baseContext(overrides: Partial<PassthroughRequestContext> = {}): PassthroughRequestContext {
  return {
    upstreamModel: 'mock-codex-upstream',
    lite: false,
    imageMode: 'off',
    thinking: false,
    session: { apiKey: 'oracle-local-key-1' },
    ...overrides,
  }
}

async function translate(body: string, overrides: Partial<PassthroughRequestContext> = {}) {
  const parsed = parseStrictJson(body)
  const record = isPlainObject(parsed) ? parsed : {}
  return translateResponsesPassthrough(body, record, baseContext(overrides))
}

async function translateCompact(body: string, overrides: Partial<PassthroughRequestContext> = {}) {
  const parsed = parseStrictJson(body)
  const record = isPlainObject(parsed) ? parsed : {}
  return translateCompactPassthrough(body, record, baseContext(overrides))
}

function passthroughBody(json: string): string {
  return json
}

async function collect(response: CodexPassthroughResponse): Promise<string> {
  if (typeof response.body === 'string') return response.body
  const reader = (response.body as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  let out = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value !== undefined) out += decoder.decode(value, { stream: true })
  }
  return out + decoder.decode()
}

function streamOf(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

function rejectingStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    pull() {
      throw new Error('connection reset by peer')
    },
  })
}

function textOf(value: unknown): string {
  return JSON.stringify(value) ?? 'null'
}

// ---------------------------------------------------------------------------
// Id normalization matrix (3.2)
// ---------------------------------------------------------------------------

describe('item id normalization', () => {
  test('bare ids gain their type prefix', async () => {
    const plan = await planInputItemIds([
      { type: 'message', id: 'abc', encryptedValid: false },
      { type: 'reasoning', id: 'abc', encryptedValid: true },
      { type: 'function_call', id: 'x', encryptedValid: false },
      { type: 'custom_tool_call', id: 'x', encryptedValid: false },
      { type: 'custom_tool_call_output', id: 'x', encryptedValid: false },
    ])
    expect(plan[0]).toEqual({ kind: 'rewrite', value: 'msg_abc' })
    expect(plan[1]).toEqual({ kind: 'rewrite', value: 'rs_abc' })
    expect(plan[2]).toEqual({ kind: 'rewrite', value: 'fc_x' })
    expect(plan[3]).toEqual({ kind: 'rewrite', value: 'ctc_x' })
    expect(plan[4]).toEqual({ kind: 'rewrite', value: 'ctco_x' })
  })

  test('empty ids stay empty, prefixed ids pass verbatim, unknown types are skipped', async () => {
    const plan = await planInputItemIds([
      { type: 'message', id: '', encryptedValid: false },
      { type: 'message', id: 'msg_ok', encryptedValid: false },
      { type: 'other_type', id: 'bare', encryptedValid: false },
      { type: 'message', id: undefined, encryptedValid: false },
    ])
    expect(plan[0]).toEqual({ kind: 'keep' })
    expect(plan[1]).toEqual({ kind: 'keep' })
    expect(plan[2]).toEqual({ kind: 'keep' })
    expect(plan[3]).toEqual({ kind: 'keep' })
  })

  test('overlong ids shorten deterministically to a hash-suffixed form within the cap', async () => {
    const long = `${'a'.repeat(80)}`
    const plan = await planInputItemIds([{ type: 'function_call', id: long, encryptedValid: false }])
    const action = plan[0]
    expect(action?.kind).toBe('rewrite')
    if (action?.kind !== 'rewrite') return
    expect(Array.from(action.value).length).toBeLessThanOrEqual(ITEM_ID_RUNE_LIMIT)
    expect(action.value.endsWith(`-${'a'.repeat(0)}`)).toBe(false)
    const again = await planInputItemIds([{ type: 'function_call', id: long, encryptedValid: false }])
    expect(again[0]).toEqual(action)
    const different = await planInputItemIds([{ type: 'function_call', id: `${'b'.repeat(80)}`, encryptedValid: false }])
    expect((different[0] as { value: string }).value).not.toBe(action.value)
  })

  test('a re-prefixed id colliding with a preserved id takes a hash variant', async () => {
    const plan = await planInputItemIds([
      { type: 'message', id: 'msg_dup', encryptedValid: false },
      { type: 'message', id: 'dup', encryptedValid: false },
    ])
    expect(plan[0]).toEqual({ kind: 'keep' })
    const rewrite = plan[1]
    expect(rewrite?.kind).toBe('rewrite')
    if (rewrite?.kind !== 'rewrite') return
    expect(rewrite.value.startsWith('msg_')).toBe(true)
    expect(rewrite.value).not.toBe('msg_dup')
  })

  test('encrypted reasoning items with overlong ids drop entirely', async () => {
    const plan = await planInputItemIds([{ type: 'reasoning', id: 'r'.repeat(80), encryptedValid: true }])
    expect(plan[0]).toEqual({ kind: 'drop' })
  })
})

// ---------------------------------------------------------------------------
// Image-generation mode matrix (3.2)
// ---------------------------------------------------------------------------

describe('image-generation modes', () => {
  test('off: no tools member -> created with the single injected tool', async () => {
    const out = await translate('{"model": "codex-mock", "input": "hi"}')
    expect(out.body).toContain('"tools":[{"type":"image_generation","output_format":"png"}]')
  })

  test('off: declared tools gain the injected tool, an existing image tool blocks injection', async () => {
    const out = await translate(
      '{"model": "codex-mock", "input": "hi", "tools": [{"type": "function", "name": "f"}]}',
    )
    expect(out.body).toContain('"tools": [{"type": "function", "name": "f"},{"type":"image_generation","output_format":"png"}]')
    const present = await translate(
      '{"model": "codex-mock", "input": "hi", "tools": [{"type": "image_generation"}]}',
    )
    expect(present.body.match(/image_generation/g)?.length).toBe(1)
  })

  test('true/all/chat strip declared image tools and tool_choice entries; parallel_tool_calls drops with them', async () => {
    for (const mode of ['true', 'all', 'chat'] as const) {
      const out = await translate(
        passthroughBody(
          '{"model": "codex-mock", "input": "hi", "tools": [{"type": "image_generation"}], "tool_choice": {"type": "image_generation"}}',
        ),
        { imageMode: mode },
      )
      expect(out.body, mode).not.toContain('image_generation')
      expect(out.body, mode).not.toContain('tool_choice')
      expect(out.body, mode).not.toContain('parallel_tool_calls')
    }
  })

  test('true strips nested tool_choice tools entries only', async () => {
    const out = await translate(
      '{"model": "codex-mock", "input": "hi", "tools": [{"type": "function", "name": "f"}, {"type": "image_generation"}], "tool_choice": {"type": "tools", "tools": [{"type": "image_generation"}, {"type": "function", "name": "f"}]}}',
      { imageMode: 'true' },
    )
    expect(out.body).toContain('"tools": [{"type": "function", "name": "f"}]')
    expect(out.body).toContain('"tool_choice": {"type": "tools", "tools": [{"type": "function", "name": "f"}]}')
    expect(out.body).toContain('"parallel_tool_calls":true')
  })

  test('passthrough preserves declared tools without injecting', async () => {
    const out = await translate('{"model": "codex-mock", "input": "hi", "tools": [{"type": "image_generation"}]}', {
      imageMode: 'passthrough',
    })
    expect(out.body).toContain('"tools": [{"type": "image_generation"}]')
  })

  test('Lite never injects and forces parallel_tool_calls false', async () => {
    const out = await translate('{"model": "codex-mock", "input": "hi"}', { lite: true })
    expect(out.body).not.toContain('image_generation')
    expect(out.body).toContain('"parallel_tool_calls":false')
  })
})

// ---------------------------------------------------------------------------
// Lite dialect + request rewrite units
// ---------------------------------------------------------------------------

describe('request rewrites', () => {
  test('non-Lite defaults absent instructions to empty, Lite leaves them absent', async () => {
    const out = await translate('{"model": "codex-mock", "input": "hi"}')
    expect(out.body).toContain('"instructions":""')
    const lite = await translate('{"model": "codex-mock", "input": "hi"}', { lite: true })
    expect(lite.body).not.toContain('instructions')
  })

  test('null instructions become empty; a thinking-capable model keeps reasoning verbatim', async () => {
    const out = await translate('{"model": "codex-mock", "input": "hi", "instructions": null}')
    expect(out.body).toContain('"instructions": ""')
    const keep = await translate(
      '{"model": "codex-mock", "input": "hi", "reasoning": {"effort": "high", "summary": "auto"}}',
      { thinking: true },
    )
    expect(keep.body).toContain('"reasoning": {"effort": "high", "summary": "auto"}')
    const strip = await translate('{"model": "codex-mock", "input": "hi", "reasoning": {"effort": "high"}}')
    expect(strip.body).not.toContain('"reasoning":')
  })

  test('service_tier priority survives, other tiers drop', async () => {
    const keep = await translate('{"model": "codex-mock", "input": "hi", "service_tier": "priority"}')
    expect(keep.body).toContain('"service_tier": "priority"')
    const drop = await translate('{"model": "codex-mock", "input": "hi", "service_tier": "auto"}')
    expect(drop.body).not.toContain('service_tier')
  })

  test('thinking suffix rides the upstream model name and preserves the reasoning object', async () => {
    const out = await translate('{"model": "codex-mock(high)", "input": "hi", "reasoning": {"effort": "high"}}', {
      upstreamModel: 'mock-codex-upstream(high)',
      thinking: true,
    })
    expect(out.body.startsWith('{"model": "mock-codex-upstream(high)"')).toBe(true)
    expect(out.body).toContain('"reasoning": {"effort": "high"}')
  })

  test('client prompt_cache_key drives both body field and Session-Id value', async () => {
    const out = await translate('{"model": "codex-mock", "input": "hi", "prompt_cache_key": "sess-1"}')
    expect(out.promptCacheKey).toBe('sess-1')
    expect(out.sessionHeaderValue).toBe('sess-1')
    expect(out.body).toContain('"prompt_cache_key": "sess-1"')
  })

  test('derived identity is stable across identical requests and shared by header + body', async () => {
    const first = await translate('{"model": "codex-mock", "input": "Say hi"}')
    const second = await translate('{"model": "codex-mock", "input": "Say hi"}')
    expect(first.promptCacheKey).toBe(second.promptCacheKey)
    expect(first.sessionHeaderValue).toBe(first.promptCacheKey)
    const other = await translate('{"model": "codex-mock", "input": "Say something else"}')
    expect(other.promptCacheKey).not.toBe(first.promptCacheKey)
  })

  test('web_search aliases rewrite in tools and tool_choice, spacing preserved', async () => {
    const out = await translate(
      '{"model": "codex-mock", "input": "hi", "tools": [{"type": "web_search_preview_2025_03_11"}], "tool_choice": {"type": "web_search_preview"}}',
    )
    expect(out.body).toContain('{"type": "web_search"}')
    expect(out.body).toContain('"tool_choice": {"type": "web_search"}')
  })

  test('compact translate deletes stream, rewrites model, keeps store/include untouched, derives the cache key', async () => {
    const out = await translateCompact(
      '{"model": "codex-mock", "instructions": "C", "input": [{"type": "message", "role": "user", "content": [{"type": "input_text", "text": "t"}]}], "stream": false, "store": true, "include": ["x"]}',
    )
    expect(out.body).not.toContain('"stream"')
    expect(out.body).toContain('"model": "mock-codex-upstream"')
    expect(out.body).toContain('"store": true')
    expect(out.body).toContain('"include": ["x"]')
    expect(out.body).toContain('"prompt_cache_key":')
    expect(out.sessionHeaderValue).toBe(out.promptCacheKey)
  })
})

// ---------------------------------------------------------------------------
// Usage-detail injection (4.2/4.7)
// ---------------------------------------------------------------------------

describe('usage-detail injection', () => {
  const ctx = { clientModel: undefined, outputRepair: { rebuild: false, hydrate: false } }

  test('missing detail objects append after total_tokens, output first', () => {
    const payload = '{"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3}}}'
    const state: FrameTransformState = { items: [] }
    const out = transformFramePayload(payload, ctx, state)
    expect(out.kind).toBe('terminal-success')
    if (out.kind !== 'terminal-success') return
    expect(out.payload).toBe(
      '{"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3,"output_tokens_details":{"reasoning_tokens":0},"input_tokens_details":{"cached_tokens":0}}}}',
    )
  })

  test('present details never move; partial detail objects gain only the missing inner key', () => {
    const complete = '{"type":"x","response":{"usage":{"total_tokens":1,"input_tokens_details":{"cached_tokens":5},"output_tokens_details":{"reasoning_tokens":2}}}}'
    const state: FrameTransformState = { items: [] }
    const out = transformFramePayload(complete, ctx, state)
    expect(out.kind).toBe('forward')
    if (out.kind !== 'forward') return
    expect(out.payload).toBe(complete)
    const partial = '{"type":"x","usage":{"input_tokens_details":{"cached_tokens":5}}}'
    const out2 = transformFramePayload(partial, ctx, state)
    expect(out2.kind).toBe('forward')
    if (out2.kind !== 'forward') return
    expect(out2.payload).toBe(
      '{"type":"x","usage":{"input_tokens_details":{"cached_tokens":5},"output_tokens_details":{"reasoning_tokens":0}}}',
    )
  })

  test('compaction payloads and non-JSON pass untouched', () => {
    const compaction = '{"object":"response.compaction","usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3}}'
    const state: FrameTransformState = { items: [] }
    const out = transformFramePayload(compaction, ctx, state)
    expect(out.kind).toBe('forward')
    if (out.kind !== 'forward') return
    expect(out.payload).toBe(compaction)
    const raw = transformFramePayload('[DONE]', ctx, state)
    expect(raw.kind).toBe('forward')
    const notJson = transformFramePayload('not-json', ctx, state)
    expect(notJson.kind).toBe('forward')
  })
})

// ---------------------------------------------------------------------------
// Model echo + force-mapping + rename + output repair (4.2/4.3/4.6)
// ---------------------------------------------------------------------------

describe('stream payload transforms', () => {
  test('created frames gain the client model at the response object end; present models stay', () => {
    const payload = '{"type":"response.created","response":{"id":"r","output":[]}}'
    const out = injectResponseModel(payload, 'codex-mock')
    expect(out).toBe('{"type":"response.created","response":{"id":"r","output":[],"model":"codex-mock"}}')
    const present = '{"type":"response.created","response":{"model":"upstream"}}'
    expect(injectResponseModel(present, 'codex-mock')).toBe(present)
  })

  test('force-mapping rewrites every model/modelVersion field in place', () => {
    const payload = '{"type":"t","model":"a","response":{"model":"b","nested":{"modelVersion":"c"}},"other":1}'
    const out = rewriteModelFields(payload, 'alias')
    const parsed = tryParseJson(out) as Record<string, unknown>
    expect(textOf(parsed['model'])).toBe('"alias"')
    const response = parsed['response'] as Record<string, unknown>
    expect(textOf(response['model'])).toBe('"alias"')
    const nested = response['nested'] as Record<string, unknown>
    expect(textOf(nested['modelVersion'])).toBe('"alias"')
    expect(parsed['other']).toBe(1)
  })

  test('response.done renames only the payload type value', () => {
    expect(renameTypeValue('{"type":"response.done","x":1}', 'response.completed')).toBe(
      '{"type":"response.completed","x":1}',
    )
  })

  test('output repair rebuilds by output_index with unindexed items appended', () => {
    const payload = '{"type":"response.completed","response":{"id":"r","output":[]}}'
    const state: FrameTransformState = {
      items: [
        { outputIndex: 1, raw: '{"id":"two"}' },
        { outputIndex: undefined, raw: '{"id":"unindexed"}' },
        { outputIndex: 0, raw: '{"id":"one"}' },
      ],
    }
    const out = repairEmptyOutput(payload, state)
    expect(out).toBe('{"type":"response.completed","response":{"id":"r","output":[{"id":"one"},{"id":"two"},{"id":"unindexed"}]}}')
  })

  test('a terminal missing the output member reconstructs it exactly like an empty one (4.6)', () => {
    const state: FrameTransformState = {
      items: [
        { outputIndex: 1, raw: '{"id":"two"}' },
        { outputIndex: 0, raw: '{"id":"one"}' },
      ],
    }
    const missing = repairEmptyOutput('{"type":"response.completed","response":{"id":"r"}}', state)
    expect(missing).toBe('{"type":"response.completed","response":{"id":"r","output":[{"id":"one"},{"id":"two"}]}}')
    const empty = repairEmptyOutput('{"type":"response.completed","response":{"id":"r","output":[]}}', state)
    expect(empty).toBe('{"type":"response.completed","response":{"id":"r","output":[{"id":"one"},{"id":"two"}]}}')
    // Without recorded items a missing member stays missing.
    const bare = repairEmptyOutput('{"type":"response.completed","response":{"id":"r"}}', { items: [] })
    expect(bare).toBe('{"type":"response.completed","response":{"id":"r"}}')
  })

  test('the live transform forwards a reconstructed output when the terminal carried none', () => {
    const ctx = { clientModel: undefined, outputRepair: { rebuild: true, hydrate: true } }
    const state: FrameTransformState = { items: [] }
    const done = transformFramePayload(
      '{"type":"response.output_item.done","output_index":0,"item":{"id":"msg","type":"message"}}',
      ctx,
      state,
    )
    expect(done.kind).toBe('forward')
    const terminal = transformFramePayload('{"type":"response.completed","response":{"id":"r"}}', ctx, state)
    expect(terminal.kind).toBe('terminal-success')
    if (terminal.kind !== 'terminal-success') return
    expect(JSON.parse(terminal.payload)).toEqual({
      type: 'response.completed',
      response: { id: 'r', output: [{ id: 'msg', type: 'message' }] },
    })
  })

  test('id hydration fills missing ids of a non-empty output from matching done items', () => {
    const payload =
      '{"type":"response.completed","response":{"output":[{"type":"message","content":[]},{"id":"kept"}]}}'
    const state: FrameTransformState = { items: [{ outputIndex: 0, raw: '{"id":"filled"}' }] }
    const out = hydrateOutputItemIds(payload, state)
    expect(out).toBe(
      '{"type":"response.completed","response":{"output":[{"type":"message","content":[],"id":"filled"},{"id":"kept"}]}}',
    )
  })
})

// ---------------------------------------------------------------------------
// Codex-client detection (5.2)
// ---------------------------------------------------------------------------

describe('codex-client detection', () => {
  test('User-Agent patterns and Originator prefixes (versioned included)', () => {
    expect(isCodexClient({ 'User-Agent': 'codex_cli_rs/0.5.0' })).toBe(true)
    expect(isCodexClient({ 'User-Agent': 'Codex/1.0' })).toBe(true)
    expect(isCodexClient({ Originator: 'codex_cli_rs/0.42.0 (linux)' })).toBe(true)
    expect(isCodexClient({ Originator: 'codex desktop 1.2' })).toBe(true)
    expect(isCodexClient({ Originator: 'codex-tui' })).toBe(true)
    expect(isCodexClient({ 'User-Agent': 'curl/8.7.1' })).toBe(false)
    expect(isCodexClient({ Originator: 'someone-else' })).toBe(false)
    expect(isCodexClient({})).toBe(false)
  })

  test('plain clients get event: error, codex clients get response.failed (fixed key orders)', () => {
    const detail = synthesizedDetailForStatus(408, 'boom')
    expect(typeof detail).toBe('string')
    const plain = formatTerminalFailureFrame('error', detail, 3)
    expect(plain).toBe('\nevent: error\ndata: {"type":"error","error":' + detail + ',"sequence_number":3}\n\n')
    const codex = formatTerminalFailureFrame('response.failed', detail, 3)
    expect(codex).toBe(
      '\nevent: response.failed\ndata: {"type":"response.failed","sequence_number":3,"response":{"status":"failed","error":' +
        detail +
        '}}\n\n',
    )
  })

  test('terminal failure detail: nested error object, response.error, or the payload minus wrappers', () => {
    expect(terminalFailureDetail({ type: 'error', error: { code: 'x', api_key: 'k', message: 'm' } })).toBe(
      marshalSorted({ api_key: '[REDACTED]', code: 'x', message: 'm' }),
    )
    expect(
      terminalFailureDetail({ type: 'response.failed', response: { status: 'failed', error: { code: 'c' } } }),
    ).toBe('{"code":"c"}')
    expect(terminalFailureDetail({ type: 'error', code: 'server_error', message: 'upstream exploded' })).toBe(
      '{"code":"server_error","message":"upstream exploded"}',
    )
    expect(terminalFailureDetail({ type: 'error', sequence_number: 2 })).toBeUndefined()
    expect(codexTerminalFailureStatus({ type: 'error', code: 'invalid_api_key' })).toBe(401)
    expect(codexTerminalFailureStatus({ type: 'error', code: 'model_not_found' })).toBe(404)
    expect(codexTerminalFailureStatus({ type: 'error', code: 'usage_limit_reached' })).toBe(429)
    expect(codexTerminalFailureStatus({ type: 'error', code: 'whatever' })).toBe(502)
  })

  test('long strings truncate at 2048 runes inside sanitized details', () => {
    const long = 'x'.repeat(3000)
    const detail = terminalFailureDetail({ type: 'error', error: { message: long } })
    expect(detail).toBeDefined()
    if (detail === undefined) return
    const parsed = tryParseJson(`{${detail.slice(1, -1)}}`) as { message?: string }
    expect(Array.from(parsed.message ?? '').length).toBe(2048)
  })
})

// ---------------------------------------------------------------------------
// Error re-serialization (5.1)
// ---------------------------------------------------------------------------

describe('upstream HTTP-level classification', () => {
  test('401 rewrites to the auth_unavailable shape', () => {
    const out = classifyUpstreamStatusError(401, '{"error":{"message":"Invalid token","type":"authentication_error","code":"invalid_api_key"}}')
    expect(out.status).toBe(401)
    expect(out.body).toBe('{"error":{"code":"auth_unavailable","message":"Invalid token","type":"authentication_error"}}')
  })

  test('content-verbatim re-serialization keeps every field, alphabetical, numbers raw', () => {
    const out = classifyUpstreamStatusError(
      429,
      '{"error":{"message":"You have exceeded your usage limit","type":"usage_limit_reached","code":"usage_limit_reached","resets_in_seconds":3600}}',
    )
    expect(out.status).toBe(429)
    expect(out.body).toBe(
      '{"error":{"code":"usage_limit_reached","message":"You have exceeded your usage limit","resets_in_seconds":3600,"type":"usage_limit_reached"}}',
    )
    const odd = classifyUpstreamStatusError(400, '{"error":{"n":1.50,"z":"tail"}}')
    expect(odd.body).toBe('{"error":{"n":1.50,"z":"tail"}}')
  })

  test('sanitizers redact secret-ish keys and wrap non-JSON bodies', () => {
    const out = classifyUpstreamStatusError(500, '{"error":{"message":"m","token":"leaked"}}')
    expect(out.body).toBe('{"error":{"message":"m","token":"[REDACTED]"}}')
    const wrapped = classifyUpstreamStatusError(503, 'upstream exploded')
    expect(wrapped.status).toBe(503)
    expect(JSON.parse(wrapped.body)).toEqual({
      error: { message: 'upstream exploded', type: 'server_error', code: 'internal_server_error' },
    })
  })

  test('context-length and thinking-signature rewrites', () => {
    const context = classifyUpstreamStatusError(400, '{"error":{"message":"context too large","type":"x"}}')
    expect(JSON.parse(context.body)).toEqual({
      error: { message: 'context too large', type: 'invalid_request_error', code: 'context_too_large' },
    })
    const signature = classifyUpstreamStatusError(400, '{"error":{"message":"invalid_encrypted_content here"}}')
    expect(JSON.parse(signature.body).error.code).toBe('thinking_signature_invalid')
    const previous = classifyUpstreamStatusError(400, '{"error":{"message":"previous_response_not_found"}}')
    expect(JSON.parse(previous.body).error.code).toBe('previous_response_not_found')
  })

  test('raw alphabetical remarshal helper', () => {
    expect(remarshalSortedRaw('{"b":1,"a":{"d":2,"c":3}}')).toBe('{"a":{"c":3,"d":2},"b":1}')
    expect(remarshalSortedRaw('not an object')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// SSE framer + stream pipeline units (4.1/4.2/5.2/5.3)
// ---------------------------------------------------------------------------

async function collectLines(source: string[]): Promise<string[]> {
  const out: string[] = []
  for await (const item of scanSseLines(textSource(source))) {
    out.push(
      item.kind === 'line'
        ? `L:${item.raw}${item.ending}${item.data !== undefined ? ` D=${item.data}` : ''}`
        : item.kind === 'blank'
          ? `B${item.ending === '\r\n' ? '-CRLF' : ''}`
          : 'END',
    )
  }
  return out
}

describe('sse line scanner', () => {
  test('splits lines, strips the optional data space, keeps CRLF endings', async () => {
    const items = await collectLines(['event: x\r\ndata:{"a":1}\r\n\r\ndata: y\n\n'])
    expect(items).toEqual([
      'L:event: x' + CRLF,
      'L:data:{"a":1}' + CRLF + ' D={"a":1}',
      'B-CRLF',
      'L:data: y' + LF + ' D=y',
      'B',
      'END',
    ])
  })

  test('split payloads reassemble identically to whole chunks', async () => {
    const whole = await collectStream([
      'event: response.created\ndata: {"type":"resp',
      'onse.created","response":{"id":"r"}}\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r","output":[]}}\n',
    ])
    const single = await collectStream([
      'event: response.created\ndata: {"type":"response.created","response":{"id":"r"}}\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r","output":[]}}\n',
    ])
    expect(whole).toEqual(single)
  })
})



async function collectStream(chunks: readonly string[]): Promise<string[]> {
  const out: string[] = []
  for await (const frame of passthroughFrames(chunks)) out.push(frame)
  return out
}

/** Array chunks as an async text source (chunk splits preserved). */
async function* textSource(chunks: readonly (string | Uint8Array)[]): AsyncIterable<string | Uint8Array> {
  for (const chunk of chunks) yield chunk
}

async function* passthroughFrames(chunks: readonly string[]): AsyncIterable<string> {
  const { translatePassthroughStream } = await import('./stream')
  yield* translatePassthroughStream(textSource(chunks), {
    clientModel: 'codex-mock',
    lite: false,
    failureEvent: 'error',
  })
}

describe('stream pipeline', () => {
  test('comment lines glue onto the following frame; data: normalizes to "data: "', async () => {
    const frames = await collectStream([
      'event: response.created\ndata: {"type":"response.created","response":{"id":"r"}}\n\n',
      ': keepalive\n\n',
      'event: response.output_text.delta\ndata:{"type":"response.output_text.delta","delta":"Hi"}\n\n',
    ])
    expect(frames).toEqual([
      'event: response.created\ndata: {"type":"response.created","response":{"id":"r","model":"codex-mock"}}\n\n',
      ': keepalive\nevent: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hi"}\n\n',
      // No terminal event followed: the synthesized disconnect frame
      // counts the two forwarded frames.
      '\nevent: error\ndata: {"type":"error","error":{"code":"request_timeout","message":"' +
        'stream error: stream disconnected before completion: stream closed before response.completed' +
        '","param":null,"type":"invalid_request_error"},"sequence_number":2}\n\n',
    ])
  })

  test('lines outside the SSE grammar are dropped, never glued into frames', async () => {
    // Between two frames: the annotation line must not start the next one.
    const between = await collectStream([
      'event: response.created\ndata: {"type":"response.created","response":{"id":"r"}}\n\n',
      'MOCK: wait 300ms after last frame\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r","output":[]}}\n\n',
    ])
    expect(between).toEqual([
      'event: response.created\ndata: {"type":"response.created","response":{"id":"r","model":"codex-mock"}}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r","output":[]}}\n\n',
      '\n',
    ])
    expect(between.join('')).not.toContain('MOCK')

    // The recorded S2d9-08 shape: an annotation after the last data line,
    // then a close without a terminal - the frame flushes clean and the
    // synthesized disconnect follows it.
    const trailing = await collectStream([
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"partial answer"}\n',
      'MOCK: wait 300ms after last frame, then close the socket\n',
    ])
    expect(trailing).toEqual([
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"partial answer"}\n\n',
      '\nevent: error\ndata: {"type":"error","error":{"code":"request_timeout","message":"' +
        'stream error: stream disconnected before completion: stream closed before response.completed' +
        '","param":null,"type":"invalid_request_error"},"sequence_number":1}\n\n',
    ])
  })

  test('CRLF frames are preserved and extended, the disconnect frame stays LF', async () => {
    const frames = await collectStream([
      'event: response.created\r\ndata: {"type":"response.created","response":{"id":"r"}}\r\n\r\n',
    ])
    expect(frames.length).toBe(2)
    expect(frames[0]).toBe(
      'event: response.created\r\ndata: {"type":"response.created","response":{"id":"r","model":"codex-mock"}}\r\n\r\n',
    )
    expect(frames[1]).toContain('\nevent: error\ndata: ')
    expect(frames[1]).toContain('"sequence_number":1')
  })

  test('event-line-separated blocks flush when the next event: line arrives; WriteDone follows the terminal', async () => {
    const frames = await collectStream([
      'event: response.created\ndata: {"type":"response.created","response":{"id":"r"}}\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r","output":[]}}\n',
    ])
    expect(frames).toEqual([
      'event: response.created\ndata: {"type":"response.created","response":{"id":"r","model":"codex-mock"}}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r","output":[]}}\n\n',
      '\n',
    ])
  })

  test('response.done is renamed on BOTH the event line and the payload; the stream still closes', async () => {
    const frames = await collectStream([
      'event: response.done\ndata: {"type":"response.done","response":{"id":"r"}}\n',
    ])
    expect(frames).toEqual([
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r"}}\n\n',
      '\n',
    ])
  })

  test('[DONE] forwards verbatim and is not terminal', async () => {
    const frames = await collectStream([
      'data: [DONE]\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r"}}\n\n',
    ])
    expect(frames[0]).toBe('data: [DONE]\n\n')
    expect(frames[2]).toBe('\n')
  })

  test('disconnect after forwarded frames yields one failure frame with the frame count', async () => {
    const frames = await collectStream([
      'event: response.created\ndata: {"type":"response.created","response":{"id":"r"}}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"x"}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"y"}\n\n',
    ])
    const failure = frames[3]
    expect(failure).toBe(
      '\nevent: error\ndata: {"type":"error","error":{"code":"request_timeout","message":"' +
        'stream error: stream disconnected before completion: stream closed before response.completed' +
        '","param":null,"type":"invalid_request_error"},"sequence_number":3}\n\n',
    )
  })

  test('an in-stream error frame carries the upstream sequence number and drops from the wire', async () => {
    const frames = await collectStream([
      'event: response.created\ndata: {"type":"response.created","response":{"id":"r"}}\n\n',
      'data: {"type":"error","code":"server_error","message":"boom","sequence_number":9}\n\n',
    ])
    expect(frames.length).toBe(2)
    expect(frames[1]).toContain('"sequence_number":9')
    expect(frames[1]).toContain('"code":"server_error","message":"boom"')
  })

  test('a rejecting read before any frame is a pre-commit 408', async () => {
    const { PassthroughPreCommitError, translatePassthroughStream } = await import('./stream')
    const readOnce = (async function* (): AsyncIterable<Uint8Array> {
      yield new TextEncoder().encode('event: x\n')
      await rejectingStream().getReader().read()
    })()
    await expect(async () => {
      for await (const _frame of translatePassthroughStream(readOnce, {
        clientModel: 'm',
        lite: false,
        failureEvent: 'error',
      })) {
        void _frame
      }
    }).rejects.toBeInstanceOf(PassthroughPreCommitError)
  })

  test('first-frame gating: an error frame before any data never commits SSE headers', async () => {
    const { bootstrapPassthroughStream } = await import('./stream')
    const bootstrap = await bootstrapPassthroughStream(
      textSource(['data: {"type":"error","code":"invalid_api_key","message":"bad key"}\n\n']),
      { clientModel: 'm', lite: false, failureEvent: 'error' },
    )
    expect(bootstrap.kind).toBe('pre-commit')
    if (bootstrap.kind !== 'pre-commit') return
    expect(bootstrap.status).toBe(401)
    // The error frame's own fields (minus the transport wrappers) become
    // the plain-JSON error content, mirroring the recorded in-stream rule.
    expect(JSON.parse(bootstrap.body)).toEqual({
      error: { code: 'invalid_api_key', message: 'bad key' },
    })
  })

  test('aggregation returns the terminal response object; without a terminal it is the 408 body', () => {
    const ok = aggregatePassthroughStream(
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"id":"i1"}}\n' +
        'data: {"type":"response.completed","response":{"id":"r","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n',
      false,
    )
    expect(ok.kind).toBe('ok')
    if (ok.kind !== 'ok') return
    expect(JSON.parse(ok.body)).toEqual({
      id: 'r',
      output: [{ id: 'i1' }],
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        total_tokens: 2,
        output_tokens_details: { reasoning_tokens: 0 },
        input_tokens_details: { cached_tokens: 0 },
      },
    })
    const incomplete = aggregatePassthroughStream('data: {"type":"response.created"}\n\n', false)
    expect(incomplete.kind).toBe('incomplete')
    const failed = aggregatePassthroughStream('data: {"type":"error","code":"model_not_found","message":"nope"}\n\n', false)
    expect(failed.kind).toBe('error')
    if (failed.kind !== 'error') return
    expect(failed.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// Signature validation (3.2)
// ---------------------------------------------------------------------------

describe('encrypted-content validation', () => {
  test('the recorded valid envelope passes; broken values fail', () => {
    expect(
      isValidEncryptedContent(
        'gAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      ),
    ).toBe(true)
    expect(isValidEncryptedContent('invalid-encrypted-content-value')).toBe(false)
    expect(isValidEncryptedContent('gAAAAshort')).toBe(false)
    expect(isValidEncryptedContent(null)).toBe(false)
    expect(isValidEncryptedContent('  ')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Raw-JSON splice helpers
// ---------------------------------------------------------------------------

describe('raw splice helpers', () => {
  test('member deletion removes one adjacent separator, whitespace included', () => {
    const members = scanObjectMembers('{"a": 1, "b": 2, "c": 3}', { start: 0, end: 19 })
    const b = members?.find((member) => member.key === 'b')
    expect(b).toBeDefined()
    if (b === undefined) return
    expect(deleteMember('{"a": 1, "b": 2, "c": 3}', b)).toBe('{"a": 1, "c": 3}')
    const last = members?.find((member) => member.key === 'c')
    if (last === undefined) return
    expect(deleteMember('{"a": 1, "b": 2, "c": 3}', last)).toBe('{"a": 1, "b": 2}')
  })

  test('appendMember stays compact and handles empty objects', () => {
    expect(appendMember('{"a":1}', { start: 0, end: 7 }, '"b":2')).toBe('{"a":1,"b":2}')
    expect(appendMember('{}', { start: 0, end: 2 }, '"b":2')).toBe('{"b":2}')
  })
})

// ---------------------------------------------------------------------------
// Facade units: routing, auth gate, compact rejection, cooldown families
// ---------------------------------------------------------------------------

function buildService(overrides: Record<string, unknown> = {}): CodexPassthroughService {
  return createCodexPassthroughService({
    apiKeys: ['oracle-local-key-1'],
    credentials: [
      {
        apiKey: 'mock-codex-key-1',
        baseUrl: 'http://upstream.test',
        models: [
          { name: 'mock-codex-upstream', alias: 'codex-mock' },
          { name: 'mock-codex-upstream', alias: 'codex-mock-forced', forceMapping: true },
        ],
      },
    ],
    store: new MemoryStore(),
    now: () => FROZEN_NOW,
    ...overrides,
  } as never)
}

function request(path: string, body: string, headers: Record<string, string> = {}): Parameters<CodexPassthroughService['handleResponses']>[0] {
  return {
    method: 'POST',
    path,
    headers: Object.entries({ Authorization: 'Bearer oracle-local-key-1', 'Content-Type': 'application/json', ...headers }),
    body,
  }
}

function okSend(): (req: CodexPassthroughUpstreamRequest) => Promise<CodexPassthroughUpstreamResponse> {
  return async () => ({
    status: 200,
    headers: [['Content-Type', 'text/event-stream']],
    body: streamOf(['data: {"type":"response.completed","response":{"id":"r","output":[]}}\n\n']),
  })
}

describe('facade routing and gates', () => {
  test('unknown route and wrong method: 404 empty (R-404); OPTIONS answers the CORS block', async () => {
    const service = buildService()
    const missing = await service.handleResponses(request('/v1/nope', '{}'), okSend())
    expect(missing.status).toBe(404)
    expect(missing.body).toBe('')
    const wrongMethod = await service.handleResponses({ ...request('/v1/responses', '{}'), method: 'GET' }, okSend())
    expect(wrongMethod.status).toBe(404)
    expect(wrongMethod.body).toBe('')
    const options = await service.handleResponses({ ...request('/v1/responses', ''), method: 'OPTIONS' }, okSend())
    expect(options.status).toBe(204)
    expect(options.headers.some(([name]) => name === 'Access-Control-Allow-Origin')).toBe(true)
  })

  test('auth gate: missing and invalid keys use the S1 string bodies; X-Api-Key is accepted', async () => {
    const service = buildService()
    const missing = await service.handleResponses(
      { method: 'POST', path: '/v1/responses', headers: [['Content-Type', 'application/json']], body: '{"model":"codex-mock"}' },
      okSend(),
    )
    expect(missing.status).toBe(401)
    expect(missing.body).toBe('{"error":"Missing API key"}')
    expect(missing.headers[0]).toEqual(['Content-Type', 'application/json; charset=utf-8'])
    const invalid = await service.handleResponses(
      {
        method: 'POST',
        path: '/v1/responses',
        headers: [['Authorization', 'Bearer nope']],
        body: '{"model":"codex-mock"}',
      },
      okSend(),
    )
    expect(invalid.body).toBe('{"error":"Invalid API key"}')
    const viaHeader = await service.handleResponses(
      {
        method: 'POST',
        path: '/v1/responses',
        headers: [['X-Api-Key', 'oracle-local-key-1']],
        body: '{"model":"codex-mock","input":"hi","stream":true}',
      },
      okSend(),
    )
    expect(viaHeader.status).toBe(200)
  })

  test('strict boundary: malformed JSON rejects 400 before any upstream call', async () => {
    const service = buildService()
    let calls = 0
    const response = await service.handleResponses(request('/v1/responses', '{"model": '),
      async (req) => {
        calls += 1
        return okSend()(req)
      },
    )
    expect(response.status).toBe(400)
    expect(calls).toBe(0)
    expect(JSON.parse(response.body as string).error.type).toBe('invalid_request_error')
  })

  test('unknown model: 400 model_not_found, no upstream call, S1-23 literal order', async () => {
    const service = buildService()
    let calls = 0
    const response = await service.handleResponses(request('/v1/responses', '{"model": "no-such-model", "input": "hi"}'),
      async (req) => {
        calls += 1
        return okSend()(req)
      },
    )
    expect(calls).toBe(0)
    expect(response.status).toBe(400)
    expect(response.body).toBe(modelNotFoundBody('no-such-model'))
    expect(response.body).toBe(
      '{"error":{"message":"unknown provider for model no-such-model","type":"invalid_request_error","code":"model_not_found","param":"model"}}',
    )
  })

  test('compact with stream:true rejects 400 with no upstream call', async () => {
    const service = buildService()
    let calls = 0
    const response = await service.handleResponses(
      request('/v1/responses/compact', '{"model": "codex-mock", "input": "x", "stream": true}'),
      async (req) => {
        calls += 1
        return okSend()(req)
      },
    )
    expect(calls).toBe(0)
    expect(response.status).toBe(400)
    expect(response.body).toBe('{"error":{"message":"Streaming not supported for compact responses","type":"invalid_request_error"}}')
    expect(response.headers[0]).toEqual(['Content-Type', 'application/json; charset=utf-8'])
  })

  test('the codex direct-route aliases serve the same pipeline', async () => {
    const service = buildService()
    const response = await service.handleResponses(
      request('/backend-api/codex/responses', '{"model": "codex-mock", "input": "hi", "stream": true}'),
      okSend(),
    )
    expect(response.status).toBe(200)
    expect(response.headers[0]).toEqual(['Content-Type', 'text/event-stream'])
  })

  test('upstream URL: base-url wins, trailing slash trimmed; default targets the chatgpt backend', async () => {
    const service = buildService()
    const seen: string[] = []
    await service.handleResponses(
      request('/v1/responses', '{"model": "codex-mock", "input": "hi", "stream": true}'),
      async (req) => {
        seen.push(req.url)
        return okSend()(req)
      },
    )
    expect(seen[0]).toBe('http://upstream.test/responses')
    const defaultService = createCodexPassthroughService({
      apiKeys: ['oracle-local-key-1'],
      credentials: [
        { apiKey: 'k', baseUrl: 'https://chatgpt.com/backend-api/codex/', models: [{ name: 'mock-codex-upstream', alias: 'codex-mock' }] },
      ],
      store: new MemoryStore(),
      now: () => FROZEN_NOW,
    })
    const seen2: string[] = []
    await defaultService.handleResponses(
      request('/v1/responses/compact', '{"model": "codex-mock", "input": "x"}'),
      async (req) => {
        seen2.push(req.url)
        return { status: 200, headers: [], body: streamOf(['{}']) }
      },
    )
    expect(seen2[0]).toBe('https://chatgpt.com/backend-api/codex/responses/compact')
  })

  test('Lite header forwarding reaches the upstream under the canonical name', async () => {
    const service = buildService()
    const seen: Record<string, string> = {}
    await service.handleResponses(
      request('/v1/responses', '{"model": "codex-mock", "input": "hi", "stream": true}', {
        'X-OpenAI-Internal-Codex-Responses-Lite': 'true',
      }),
      async (req) => {
        for (const [name, value] of req.headers) seen[name] = value
        return okSend()({ ...req })
      },
    )
    expect(seen['X-Openai-Internal-Codex-Responses-Lite']).toBe('true')
  })
})

describe('cooldown families', () => {
  test('an upstream 429 arms a rate-limit window rendered from resets_in_seconds with Retry-After', async () => {
    const store = new MemoryStore()
    const service = createCodexPassthroughService({
      apiKeys: ['oracle-local-key-1'],
      credentials: [
        { apiKey: 'k', baseUrl: 'http://u', models: [{ name: 'mock-codex-upstream', alias: 'codex-mock' }] },
      ],
      store,
      now: () => FROZEN_NOW,
      transientErrorCooldownSeconds: -1,
    })
    const body =
      '{"error":{"message":"You have exceeded your usage limit","type":"usage_limit_reached","code":"usage_limit_reached","resets_in_seconds":3600}}'
    const first = await service.handleResponses(
      request('/v1/responses', '{"model": "codex-mock", "input": "hi", "stream": true}'),
      async () => ({ status: 429, headers: [], body: streamOf([body]) }),
    )
    expect(first.status).toBe(429)
    expect(first.headers.some(([name]) => name === 'Retry-After')).toBe(false)
    const second = await service.handleResponses(
      request('/v1/responses', '{"model": "codex-mock", "input": "hi", "stream": true}'),
      async () => {
        throw new Error('no upstream call expected')
      },
    )
    expect(second.status).toBe(429)
    expect(second.headers.find(([name]) => name === 'Retry-After')?.[1]).toBe('3600')
    expect(JSON.parse(second.body as string)).toEqual({
      error: {
        code: 'model_cooldown',
        last_upstream_error: 'usage_limit_reached: You have exceeded your usage limit',
        message:
          'All credentials for model codex-mock are cooling down via provider codex (last error: usage_limit_reached: You have exceeded your usage limit)',
        model: 'codex-mock',
        provider: 'codex',
        reset_seconds: 3600,
        reset_time: '1h0m0s',
      },
    })
  })

  test('a >300-rune upstream error truncates in BOTH model_cooldown members', async () => {
    const service = createCodexPassthroughService({
      apiKeys: ['oracle-local-key-1'],
      credentials: [
        { apiKey: 'k', baseUrl: 'http://u', models: [{ name: 'mock-codex-upstream', alias: 'codex-mock' }] },
      ],
      store: new MemoryStore(),
      now: () => FROZEN_NOW,
    })
    const longMessage = 'x'.repeat(320)
    const body = `{"error":{"message":"${longMessage}","type":"usage_limit_reached","code":"usage_limit_reached","resets_in_seconds":3600}}`
    const first = await service.handleResponses(
      request('/v1/responses', '{"model": "codex-mock", "input": "hi", "stream": true}'),
      async () => ({ status: 429, headers: [], body: streamOf([body]) }),
    )
    expect(first.status).toBe(429)
    const second = await service.handleResponses(
      request('/v1/responses', '{"model": "codex-mock", "input": "hi", "stream": true}'),
      async () => {
        throw new Error('no upstream call expected')
      },
    )
    expect(second.status).toBe(429)
    const parsed = JSON.parse(second.body as string) as {
      error: { last_upstream_error: string; message: string }
    }
    const truncated = parsed.error.last_upstream_error
    // 253 runes of the summary plus the literal `...` - on the standalone
    // member AND inside the message suffix, like the S2d5 sibling.
    expect(Array.from(truncated).length).toBe(256)
    expect(truncated.startsWith('usage_limit_reached: ')).toBe(true)
    expect(truncated.endsWith('...')).toBe(true)
    expect(parsed.error.message).toBe(
      `All credentials for model codex-mock are cooling down via provider codex (last error: ${truncated})`,
    )
  })

  test('an upstream 404 model_not_found arms the not-found window rendered as the enriched 503', async () => {
    const store = new MemoryStore()
    const service = createCodexPassthroughService({
      apiKeys: ['oracle-local-key-1'],
      credentials: [
        { apiKey: 'k', baseUrl: 'http://u', models: [{ name: 'mock-codex-upstream', alias: 'codex-mock' }] },
      ],
      store,
      now: () => FROZEN_NOW,
      transientErrorCooldownSeconds: -1,
    })
    const body =
      '{"error":{"message":"model not found: mock-codex-upstream","type":"invalid_request_error","code":"model_not_found","param":"model"}}'
    const first = await service.handleResponses(
      request('/v1/responses', '{"model": "codex-mock", "input": "hi", "stream": true}'),
      async () => ({ status: 404, headers: [], body: streamOf([body]) }),
    )
    expect(first.status).toBe(404)
    const second = await service.handleResponses(
      request('/v1/responses', '{"model": "codex-mock", "input": "hi", "stream": true}'),
      async () => {
        throw new Error('no upstream call expected')
      },
    )
    expect(second.status).toBe(503)
    expect(JSON.parse(second.body as string)).toEqual({
      error: {
        message:
          'auth_unavailable: no auth available (providers=codex, model=codex-mock; last upstream error: model_not_found: model not found: mock-codex-upstream)',
        type: 'server_error',
        code: 'internal_server_error',
      },
    })
  })

  test('the window lapses once the clock passes it', async () => {
    let now = FROZEN_NOW
    const service = createCodexPassthroughService({
      apiKeys: ['oracle-local-key-1'],
      credentials: [
        { apiKey: 'k', baseUrl: 'http://u', models: [{ name: 'mock-codex-upstream', alias: 'codex-mock' }] },
      ],
      store: new MemoryStore(),
      now: () => now,
    })
    await service.handleResponses(
      request('/v1/responses', '{"model": "codex-mock", "input": "hi", "stream": true}'),
      async () => ({ status: 429, headers: [], body: streamOf(['{"error":{"message":"m","type":"usage_limit_reached","code":"usage_limit_reached"}}']) }),
    )
    now += 10_000
    const after = await service.handleResponses(
      request('/v1/responses', '{"model": "codex-mock", "input": "hi", "stream": true}'),
      okSend(),
    )
    expect(after.status).toBe(200)
  })

  test('cooldown builders produce the recorded byte shapes', () => {
    const cooldown = buildModelCooldownResponse({
      model: 'codex-mock',
      provider: 'codex',
      lastUpstreamError: 'usage_limit_reached: You have exceeded your usage limit',
      resetSeconds: 3600,
    })
    expect(cooldown.body).toBe(
      '{"error":{"code":"model_cooldown","last_upstream_error":"usage_limit_reached: You have exceeded your usage limit","message":"All credentials for model codex-mock are cooling down via provider codex (last error: usage_limit_reached: You have exceeded your usage limit)","model":"codex-mock","provider":"codex","reset_seconds":3600,"reset_time":"1h0m0s"}}',
    )
    const unavailable = buildAuthUnavailableResponse({
      providers: ['codex'],
      model: 'codex-mock',
      lastUpstreamError: 'model_not_found: model not found: mock-codex-upstream',
    })
    expect(unavailable.body).toBe(
      '{"error":{"message":"auth_unavailable: no auth available (providers=codex, model=codex-mock; last upstream error: model_not_found: model not found: mock-codex-upstream)","type":"server_error","code":"internal_server_error"}}',
    )
  })

  test('a Store write failure never rejects the rendered response', async () => {
    const reported: unknown[] = []
    const globalScope = globalThis as { reportError?: (error: unknown) => void }
    const originalReport = globalScope.reportError
    globalScope.reportError = (error: unknown) => {
      reported.push(error)
    }
    try {
    const failingStore = new MemoryStore()
    failingStore.update = () => {
      throw new Error('store down')
    }
    const service = createCodexPassthroughService({
      apiKeys: ['oracle-local-key-1'],
      credentials: [
        { apiKey: 'k', baseUrl: 'http://u', models: [{ name: 'mock-codex-upstream', alias: 'codex-mock' }] },
      ],
      store: failingStore,
      now: () => FROZEN_NOW,
    })
    const response = await service.handleResponses(
      request('/v1/responses', '{"model": "codex-mock", "input": "hi", "stream": true}'),
      async () => ({ status: 429, headers: [], body: streamOf(['{"error":{"message":"m","type":"usage_limit_reached"}}']) }),
    )
    expect(response.status).toBe(429)
    expect(reported.length).toBe(1)
    } finally {
      globalScope.reportError = originalReport
    }
  })
})

describe('stream facade units', () => {
  test('pre-commit disconnect renders as plain JSON 408, never SSE', async () => {
    const service = buildService()
    const response = await service.handleResponses(
      request('/v1/responses', '{"model": "codex-mock", "input": "hi", "stream": true}'),
      async () => ({ status: 200, headers: [], body: streamOf(['']) }),
    )
    expect(response.status).toBe(408)
    expect(response.body).toBe(incompleteStreamBody())
    expect(response.headers[0]).toEqual(['Content-Type', 'application/json'])
  })

  test('rejected upstream reads before the first frame also render the 408 JSON', async () => {
    const service = buildService()
    const response = await service.handleResponses(
      request('/v1/responses', '{"model": "codex-mock", "input": "hi", "stream": true}'),
      async () => ({ status: 200, headers: [], body: rejectingStream() }),
    )
    expect(response.status).toBe(408)
    expect(typeof response.body).toBe('string')
  })

  test('force-mapping rewrites model fields on the stream but never injects', async () => {
    const service = buildService()
    const response = await service.handleResponses(
      request('/v1/responses', '{"model": "codex-mock-forced", "input": "hi", "stream": true}'),
      async () => ({
        status: 200,
        headers: [],
        body: streamOf([
          'event: response.created\ndata: {"type":"response.created","response":{"id":"r","model":"mock-codex-upstream"}}\n\n',
          'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r","model":"mock-codex-upstream","output":[]}}\n\n',
        ]),
      }),
    )
    const body = await collect(response)
    expect(body).toContain('"model":"codex-mock-forced"')
    expect(body).not.toContain('mock-codex-upstream')
    expect(body.endsWith('\n\n\n')).toBe(true)
  })

  test('compact: upstream body verbatim with the compaction usage skip', async () => {
    const service = buildService()
    const reply =
      '{"id":"c1","object":"response.compaction","status":"completed","output":[{"type":"summary","text":"S."}],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}'
    const response = await service.handleResponses(
      request('/v1/responses/compact', '{"model": "codex-mock", "input": "x"}'),
      async () => ({ status: 200, headers: [['Content-Type', 'application/json']], body: streamOf([reply]) }),
    )
    expect(response.status).toBe(200)
    expect(response.body).toBe(reply)
  })

  test('upstream headers filter into the SSE commit minus hop-by-hop and proxy pairs', async () => {
    const service = buildService()
    const response = await service.handleResponses(
      request('/v1/responses', '{"model": "codex-mock", "input": "hi", "stream": true}'),
      async () => ({
        status: 200,
        headers: [
          ['Content-Type', 'text/event-stream'],
          ['X-Custom-Trace', 'keep-me'],
          ['Connection', 'close'],
          ['Transfer-Encoding', 'chunked'],
          ['Set-Cookie', 'a=b'],
          ['Content-Length', '5'],
          ['Content-Encoding', 'gzip'],
          ['Access-Control-Allow-Origin', 'http://evil'],
          ['X-Litellm-Version', '1'],
          ['Keep-Alive', 'timeout=5'],
        ],
        body: streamOf(['data: {"type":"response.completed","response":{"id":"r","output":[]}}\n\n']),
      }),
    )
    expect(response.status).toBe(200)
    const names = response.headers.map(([name]) => name)
    expect(names).toContain('X-Custom-Trace')
    // Gateway-owned values survive; the upstream's hop-by-hop and proxy
    // pairs never reach the client.
    expect(response.headers.find(([name]) => name === 'Connection')?.[1]).toBe('keep-alive')
    expect(names).not.toContain('Transfer-Encoding')
    expect(names).not.toContain('Set-Cookie')
    expect(names).not.toContain('Content-Length')
    expect(names).not.toContain('Content-Encoding')
    expect(names).not.toContain('X-Litellm-Version')
    expect(names).not.toContain('Keep-Alive')
    // The gateway's own CORS value wins over the upstream's.
    expect(response.headers.find(([name]) => name === 'Access-Control-Allow-Origin')?.[1]).toBe('*')
  })

  test('upstream names the gateway already set never duplicate on the SSE commit', async () => {
    const service = buildService()
    const response = await service.handleResponses(
      request('/v1/responses', '{"model": "codex-mock", "input": "hi", "stream": true}'),
      async () => ({
        status: 200,
        headers: [
          ['Content-Type', 'text/event-stream'],
          ['cache-control', 'no-transform'],
          ['X-Extra-Note', 'one'],
        ],
        body: streamOf(['data: {"type":"response.completed","response":{"id":"r","output":[]}}\n\n']),
      }),
    )
    expect(response.status).toBe(200)
    // One Content-Type on the wire - the gateway-set value - whatever the
    // upstream casing; unclaimed upstream names still copy once.
    expect(response.headers.filter(([name]) => name.toLowerCase() === 'content-type')).toEqual([
      ['Content-Type', 'text/event-stream'],
    ])
    expect(response.headers.filter(([name]) => name.toLowerCase() === 'cache-control')).toEqual([
      ['Cache-Control', 'no-cache'],
    ])
    expect(response.headers.filter(([name]) => name.toLowerCase() === 'x-extra-note')).toEqual([
      ['X-Extra-Note', 'one'],
    ])
  })

  test('request-retry falls through cooling candidates to a live one', async () => {
    let calls = 0
    const service = createCodexPassthroughService({
      apiKeys: ['oracle-local-key-1'],
      credentials: [
        { apiKey: 'k1', baseUrl: 'http://u1', models: [{ name: 'mock-codex-upstream', alias: 'codex-mock' }] },
        { apiKey: 'k2', baseUrl: 'http://u2', models: [{ name: 'mock-codex-upstream', alias: 'codex-mock' }] },
      ],
      store: new MemoryStore(),
      now: () => FROZEN_NOW,
      requestRetry: 1,
    })
    const response = await service.handleResponses(
      request('/v1/responses', '{"model": "codex-mock", "input": "hi", "stream": true}'),
      async (req) => {
        calls += 1
        if (calls === 1) {
          return { status: 429, headers: [], body: streamOf(['{"error":{"message":"m","type":"usage_limit_reached"}}']) }
        }
        void req
        return okSend()(req)
      },
    )
    expect(calls).toBe(2)
    expect(response.status).toBe(200)
  })

  test('compact: a non-compaction body still gains the usage details', async () => {
    const service = buildService()
    const reply = '{"id":"c1","object":"response","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}'
    const response = await service.handleResponses(
      request('/v1/responses/compact', '{"model": "codex-mock", "input": "x"}'),
      async () => ({ status: 200, headers: [], body: streamOf([reply]) }),
    )
    expect(response.body).toBe(
      '{"id":"c1","object":"response","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2,"output_tokens_details":{"reasoning_tokens":0},"input_tokens_details":{"cached_tokens":0}}}',
    )
  })
})

// ---------------------------------------------------------------------------
// Small shared helpers used above
// ---------------------------------------------------------------------------

test('parseDownstreamSse decodes event/data pairs', () => {
  const frames = parseDownstreamSse('event: a\ndata: 1\n\ndata: 2\n\n')
  expect(frames).toEqual([
    { event: 'a', data: '1' },
    { event: undefined, data: '2' },
  ])
})

test('formatDataLine keeps the single-space prefix', () => {
  expect(formatDataLine('{"x":1}')).toBe('data: {"x":1}')
})

test('truncateRunes cuts by code points', () => {
  expect(truncateRunes('ab\u{1F600}cd', 3)).toBe('ab\u{1F600}')
})

test('serializeOrdered keeps insertion order', () => {
  expect(serializeOrdered({ b: 1, a: 2 })).toBe('{"b":1,"a":2}')
})
