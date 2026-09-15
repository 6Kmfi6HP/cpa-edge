/**
 * Unit coverage for rules the recorded goldens do not exercise: merge and
 * drop rules, tool-id/argument edges, cache-control passthrough and limits,
 * the user-id chain, thinking variants, header policy edges, decoder
 * framing, and the error-classification table.
 */
import { describe, expect, it } from 'vitest'
import { CpaError } from '@cpa-edge/core'
import { translateChatToClaude, JSON_OBJECT_INSTRUCTION } from './request'
import { deriveClaudeUserId, firstUserMessageText } from './userid'
import { normalizeToolInputSchema } from './schema'
import { ClaudeStreamChunkTranslator, mapStopReason, validateClaudeAggregatedStream } from './response'
import { decodeSseFrames, parseDownstreamSse } from './sse'
import { classifyClaudeUpstreamError, parseClaudeRateLimitReset, parseClaudeRateLimitResetWithFuzz, wrapTypeForStatus } from './errors'
import { buildClaudeUpstreamHeaders, DEFAULT_ANTHROPIC_VERSION, gatewayUserAgent } from './headers'
import { claudeCodeCliBetas } from './profile'
import type { ChatToClaudeContext } from './types'

const UPSTREAM = 'claude-mock-model'
const BASE = 'http://mock.internal:20002'
const KEY = 'mock-claude-key'

async function translate(body: unknown, ctx: ChatToClaudeContext = { upstreamModel: UPSTREAM }): Promise<Record<string, unknown>> {
  const result = await translateChatToClaude(JSON.stringify(body), ctx)
  return JSON.parse(result.body) as Record<string, unknown>
}

describe('request translation — messages', () => {
  it('consecutive same-role messages merge; empty ones drop', async () => {
    const body = await translate({
      messages: [
        { role: 'user', content: '' },
        { role: 'user', content: 'one' },
        { role: 'user', content: [{ type: 'text', text: 'two' }] },
        { role: 'assistant', content: 'a' },
        { role: 'assistant', content: [{ type: 'text', text: 'b' }] },
      ],
    })
    const messages = body['messages'] as Record<string, unknown>[]
    expect(messages.length).toBe(2)
    expect((messages[0]?.['content'] as Record<string, unknown>[]).map((b) => b['text'])).toEqual(['one', 'two'])
    expect(messages[0]?.['role']).toBe('user')
    expect((messages[1]?.['content'] as Record<string, unknown>[]).map((b) => b['text'])).toEqual(['a', 'b'])
  })

  it('merged assistant turns move tool_use blocks after all text blocks', async () => {
    const body = await translate({
      messages: [
        { role: 'assistant', content: 't1', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
        { role: 'assistant', content: 't2', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'g', arguments: '{}' } }] },
      ],
    })
    const content = ((body['messages'] as Record<string, unknown>[])[0]?.['content']) as Record<string, unknown>[]
    expect(content.map((block) => block['type'])).toEqual(['text', 'text', 'tool_use', 'tool_use'])
  })

  it('repeated tool ids keep the first position and the last content', async () => {
    const body = await translate({
      messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', tool_calls: [{ id: 'call 1!', type: 'function', function: { name: 'f', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'call 1!', content: 'first' },
        { role: 'user', content: 'mid' },
        { role: 'tool', tool_call_id: 'call 1!', content: 'last' },
      ],
    })
    const messages = body['messages'] as Record<string, unknown>[]
    // The first tool result opens a user turn; the repeated id keeps that
    // position and only swaps in the later content. The following user
    // message merges into the same turn, after the tool_result block.
    expect(messages.length).toBe(3)
    const toolTurn = messages[2]?.['content'] as Record<string, unknown>[]
    expect(toolTurn.length).toBe(2)
    const toolResult = toolTurn[0] as Record<string, unknown>
    expect(toolResult['tool_use_id']).toBe('call_1_')
    expect(toolResult['content']).toBe('last')
    expect((toolTurn[1] as Record<string, unknown>)['text']).toBe('mid')
  })

  it('tool ids are sanitized and non-object arguments collapse to {}', async () => {
    const body = await translate({
      messages: [
        {
          role: 'assistant',
          tool_calls: [
            { id: 'we!rd/id', type: 'function', function: { name: 'f', arguments: '[1,2]' } },
            { id: 'ok-1', type: 'function', function: { name: 'g', arguments: 'not json' } },
            { id: 'ok-2', type: 'function', function: { name: 'h', arguments: '{"a":1}' } },
            { id: 'drop', type: 'web_search', function: { name: 'x' } },
          ],
        },
      ],
    })
    const content = ((body['messages'] as Record<string, unknown>[])[0]?.['content']) as Record<string, unknown>[]
    expect(content.length).toBe(3)
    expect(content[0]).toEqual({ type: 'tool_use', id: 'we_rd_id', name: 'f', input: {} })
    expect(content[1]).toEqual({ type: 'tool_use', id: 'ok-1', name: 'g', input: {} })
    // The default breakpoint lands on the last block of the last message.
    expect(content[2]).toEqual({
      type: 'tool_use',
      id: 'ok-2',
      name: 'h',
      input: { a: 1 },
      cache_control: { type: 'ephemeral' },
    })
  })

  it('system-only input appends the synthetic empty user turn', async () => {
    const body = await translate({ messages: [{ role: 'system', content: 'be kind' }] })
    const messages = body['messages'] as Record<string, unknown>[]
    expect(messages.length).toBe(1)
    expect(messages[0]?.['role']).toBe('user')
    expect(messages[0]?.['content']).toEqual([{ type: 'text', text: '', cache_control: { type: 'ephemeral' } }])
  })

  it('assistant reasoning_content is dropped by default and replayed when compat', async () => {
    const plain = await translate({
      messages: [{ role: 'assistant', content: 'x', reasoning_content: 'secret' }],
    })
    const plainContent = ((plain['messages'] as Record<string, unknown>[])[0]?.['content']) as Record<string, unknown>[]
    expect(plainContent.map((b) => b['type'])).toEqual(['text'])

    const compat = await translate(
      { messages: [{ role: 'assistant', content: 'x', reasoning_content: 'secret' }] },
      { upstreamModel: UPSTREAM, compat: true },
    )
    const compatContent = ((compat['messages'] as Record<string, unknown>[])[0]?.['content']) as Record<string, unknown>[]
    expect(compatContent[0]).toEqual({ type: 'thinking', thinking: 'secret', signature: '' })
    expect(compatContent[1]).toEqual({ type: 'text', text: 'x', cache_control: { type: 'ephemeral' } })
  })

  it('system array text parts are kept, non-text parts dropped', async () => {
    const body = await translate({
      messages: [
        {
          role: 'system',
          content: [
            { type: 'text', text: 'a' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
            { type: 'text', text: 'b' },
          ],
        },
      ],
    })
    expect(body['system']).toEqual([
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b', cache_control: { type: 'ephemeral' } },
    ])
  })
})

describe('request translation — fields', () => {
  it('stop: single string wraps (including empty), empty arrays omit', async () => {
    const emptyString = await translate({ messages: [], stop: '' })
    expect(emptyString['stop_sequences']).toEqual([''])
    const emptyArray = await translate({ messages: [], stop: [] })
    expect(emptyString['stop_sequences']).toBeDefined()
    expect(emptyArray['stop_sequences']).toBeUndefined()
    const array = await translate({ messages: [], stop: ['B', 'A'] })
    expect(array['stop_sequences']).toEqual(['B', 'A'])
  })

  it('response_format json_object appends the instruction system block last', async () => {
    const body = await translate({
      messages: [{ role: 'system', content: 'base' }, { role: 'user', content: 'q' }],
      response_format: { type: 'json_object' },
    })
    const system = body['system'] as Record<string, unknown>[]
    expect(system.length).toBe(2)
    // Byte-exact normative sentence (recorded case 27), asserted literally.
    expect(system[1]?.['text']).toBe(
      'You must format your entire response as a valid JSON object. Do not include any explanations, markdown code blocks (such as ```json), or any text outside of the JSON object.',
    )
    expect(system[1]?.['text']).toBe(JSON_OBJECT_INSTRUCTION)
  })

  it('response_format json_schema without a schema falls back to the json_object sentence', async () => {
    const body = await translate({
      messages: [{ role: 'user', content: 'q' }],
      response_format: { type: 'json_schema', json_schema: { name: 'person' } },
    })
    const system = body['system'] as Record<string, unknown>[]
    expect(system[0]?.['text']).toBe(JSON_OBJECT_INSTRUCTION)
  })

  it('response_format json_schema keeps the raw client schema bytes and the description line', async () => {
    // Hand-written with the recorded spacing: the instruction embeds the
    // client's schema bytes VERBATIM, not a re-serialization.
    const raw =
      '{"model": "m", "messages": [{"role": "user", "content": "q"}], ' +
      '"response_format": {"type": "json_schema", "json_schema": {"name": "person", "description": "a person", ' +
      '"schema": {"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]}}}}'
    const result = await translateChatToClaude(raw, { upstreamModel: UPSTREAM })
    const body = JSON.parse(result.body) as Record<string, unknown>
    const system = body['system'] as Record<string, unknown>[]
    const text = system[0]?.['text']
    expect(typeof text).toBe('string')
    const instruction = text as string
    expect(instruction).toContain('Schema Name: person')
    expect(instruction).toContain('Schema Description: a person')
    expect(instruction).toContain(
      'JSON Schema:\n{"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]}',
    )
    expect(instruction).toContain('Do not include any explanations')
  })

  it('tool_choice mapping: none omitted, auto, required -> any, function -> tool', async () => {
    expect((await translate({ messages: [], tools: [], tool_choice: 'none' }))['tool_choice']).toBeUndefined()
    expect((await translate({ messages: [], tool_choice: 'auto' }))['tool_choice']).toEqual({ type: 'auto' })
    expect((await translate({ messages: [], tool_choice: 'required' }))['tool_choice']).toEqual({ type: 'any' })
    expect(
      (await translate({ messages: [], tool_choice: { type: 'function', function: { name: 'f' } } }))['tool_choice'],
    ).toEqual({ type: 'tool', name: 'f' })
  })

  it('tools normalization: type/properties forced, keys sorted lexicographically', async () => {
    const body = await translate({
      messages: [],
      tools: [
        {
          type: 'function',
          function: {
            name: 'f',
            description: 'd',
            parameters: { zeta: 1, type: 'object', properties: { b: { type: 'number' }, a: { type: 'string' } }, required: ['a'] },
          },
        },
      ],
    })
    const tools = body['tools'] as Record<string, unknown>[]
    expect(tools[0]?.['input_schema']).toEqual({
      properties: { a: { type: 'string' }, b: { type: 'number' } },
      required: ['a'],
      type: 'object',
      zeta: 1,
    })
  })

  it('normalizeToolInputSchema flattens root anyOf variants and ensures properties', () => {
    const schema = normalizeToolInputSchema({ anyOf: [{ type: 'object' }, { type: 'string' }] })
    expect(schema).toEqual({ properties: { anyOf_0: { type: 'object' }, anyOf_1: { type: 'string' } }, type: 'object' })
  })

  it('max_tokens and max_completion_tokens: first present wins, default 32000', async () => {
    expect((await translate({ messages: [] }))['max_tokens']).toBe(32000)
    expect((await translate({ messages: [], max_tokens: 5 }))['max_tokens']).toBe(5)
    expect((await translate({ messages: [], max_completion_tokens: 7 }))['max_tokens']).toBe(7)
    expect((await translate({ messages: [], max_tokens: 9, max_completion_tokens: 7 }))['max_tokens']).toBe(9)
  })

  it('sampling knobs never reach the wire', async () => {
    const body = await translate({ messages: [], temperature: 0.7, top_p: 0.9, top_k: 3 })
    expect(body['temperature']).toBeUndefined()
    expect(body['top_p']).toBeUndefined()
    expect(body['top_k']).toBeUndefined()
  })
})

describe('request translation — cache control', () => {
  it('part-level cache_control is copied, message-level applies to the last block', async () => {
    const body = await translate({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'a', cache_control: { type: 'ephemeral', ttl: '10m' } },
            { type: 'text', text: 'b' },
          ],
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'c' }],
          cache_control: { type: 'ephemeral' },
        },
      ],
    })
    const messages = body['messages'] as Record<string, unknown>[]
    const userBlocks = messages[0]?.['content'] as Record<string, unknown>[]
    const assistantBlocks = messages[1]?.['content'] as Record<string, unknown>[]
    expect(userBlocks[0]?.['cache_control']).toEqual({ type: 'ephemeral', ttl: '10m' })
    expect(userBlocks[1]?.['cache_control']).toBeUndefined()
    expect(assistantBlocks[0]?.['cache_control']).toEqual({ type: 'ephemeral' })
  })

  it('existing markers skip the default breakpoint injection entirely', async () => {
    const body = await translate({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'a', cache_control: { type: 'ephemeral' } }] },
        { role: 'assistant', content: 'b' },
      ],
    })
    const messages = body['messages'] as Record<string, unknown>[]
    const assistantBlocks = messages[1]?.['content'] as Record<string, unknown>[]
    expect(assistantBlocks[0]?.['cache_control']).toBeUndefined()
  })

  it('tool-entry cache_control wins over function-level', async () => {
    const body = await translate({
      messages: [],
      tools: [
        { type: 'function', function: { name: 'f' }, cache_control: { type: 'ephemeral' } },
        { type: 'function', function: { name: 'g' } },
      ],
    })
    const tools = body['tools'] as Record<string, unknown>[]
    expect(tools[0]?.['cache_control']).toEqual({ type: 'ephemeral' })
    // An existing marker skips the default injection, so the second tool
    // gets no breakpoint of its own.
    expect(tools[1]?.['cache_control']).toBeUndefined()
  })

  it('more than four breakpoints keep only each section\'s last', async () => {
    const body = await translate({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'a', cache_control: { type: 'ephemeral' } }] },
        { role: 'user', content: [{ type: 'text', text: 'b', cache_control: { type: 'ephemeral' } }] },
        { role: 'user', content: [{ type: 'text', text: 'c', cache_control: { type: 'ephemeral' } }] },
        { role: 'user', content: [{ type: 'text', text: 'd', cache_control: { type: 'ephemeral' } }] },
        { role: 'user', content: [{ type: 'text', text: 'e', cache_control: { type: 'ephemeral' } }] },
      ],
    })
    const messages = body['messages'] as Record<string, unknown>[]
    expect(messages.length).toBe(1)
    const blocks = messages[0]?.['content'] as Record<string, unknown>[]
    const markers = blocks.filter((block) => block['cache_control'] !== undefined)
    expect(markers.length).toBe(1)
    expect(markers[0]?.['text']).toBe('e')
  })
})

describe('request translation — thinking', () => {
  const budget = { kind: 'budget' as const, min: 1024, max: 32000 }

  it('unknown efforts and capability-less models strip thinking', async () => {
    expect((await translate({ messages: [], reasoning_effort: 'high' }))['thinking']).toBeUndefined()
    expect((await translate({ messages: [], reasoning_effort: 'medium-high' }, { upstreamModel: UPSTREAM, thinking: budget }))['thinking']).toBeUndefined()
  })

  it('budget capability clamps into the configured window and below max_tokens', async () => {
    const window = await translate(
      { messages: [], max_tokens: 100000, reasoning_effort: 'max' },
      { upstreamModel: UPSTREAM, thinking: budget },
    )
    expect(window['thinking']).toEqual({ type: 'enabled', budget_tokens: 32000, display: 'summarized' })
    const capped = await translate({ messages: [], reasoning_effort: 'max' }, { upstreamModel: UPSTREAM, thinking: budget })
    expect(capped['thinking']).toEqual({ type: 'enabled', budget_tokens: 31999, display: 'summarized' })
  })

  it('budget capability caps the budget at max_tokens - 1', async () => {
    const body = await translate(
      { messages: [], max_tokens: 1000, reasoning_effort: 'medium' },
      { upstreamModel: UPSTREAM, thinking: budget },
    )
    expect(body['thinking']).toEqual({ type: 'enabled', budget_tokens: 999, display: 'summarized' })
  })

  it('forced tool_choice deletes thinking', async () => {
    const body = await translate(
      { messages: [], reasoning_effort: 'high', tool_choice: 'required' },
      { upstreamModel: UPSTREAM, thinking: budget },
    )
    expect(body['thinking']).toBeUndefined()
  })

  it('model suffix budget survives only with a budget capability', async () => {
    const stripped = await translateChatToClaude(
      JSON.stringify({ model: 'cm(4096)', messages: [] }),
      { upstreamModel: UPSTREAM },
    )
    expect(stripped.modelSuffix).toEqual({ base: 'cm', budgetTokens: 4096 })
    expect(JSON.parse(stripped.body)['thinking']).toBeUndefined()

    const surviving = await translateChatToClaude(
      JSON.stringify({ model: 'cm(2048)', messages: [] }),
      { upstreamModel: UPSTREAM, thinking: budget },
    )
    expect(JSON.parse(surviving.body)['thinking']).toEqual({
      type: 'enabled',
      budget_tokens: 2048,
      display: 'summarized',
    })
  })
})

describe('user-id derivation', () => {
  it('priority chain: metadata.user_id > user > prompt_cache_key > content > model+system > unknown', async () => {
    expect(
      await deriveClaudeUserId({ request: { metadata: { user_id: 'u1' }, user: 'u2', prompt_cache_key: 'p' }, systemTexts: [], model: 'm' }),
    ).toBe('u1')
    expect(await deriveClaudeUserId({ request: { user: 'u2', prompt_cache_key: 'p' }, systemTexts: [], model: 'm' })).toBe('u2')
    const cacheKey = await deriveClaudeUserId({ request: { prompt_cache_key: 'p' }, systemTexts: [], model: 'm' })
    expect(cacheKey).toMatch(/^[0-9a-f]{64}$/)

    const content = await deriveClaudeUserId({
      request: { messages: [{ role: 'user', content: 'hello' }] },
      systemTexts: [],
      model: 'm',
    })
    // sha256("content:hello")
    expect(content).toBe('aed247d5b4f6f6d76b83aaff44ae80eb714c3796bf953c8055d6fa7515b4b291')

    const modelSeed = await deriveClaudeUserId({
      request: { instructions: 'ins' },
      systemTexts: ['s1', 's2'],
      model: 'm',
    })
    expect(modelSeed).not.toBe('unknown')

    const none = await deriveClaudeUserId({ request: {}, systemTexts: [], model: '' })
    expect(none).toBe('unknown')
  })

  it('first user message text joins array parts with newlines', () => {
    expect(
      firstUserMessageText([
        { role: 'system', content: 'sys' },
        { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
      ]),
    ).toBe('a\nb')
  })

  it('metadata.user_id and user land verbatim on the wire', async () => {
    const viaMetadata = await translate({ messages: [], metadata: { user_id: 'x' } })
    expect((viaMetadata['metadata'] as Record<string, unknown>)['user_id']).toBe('x')
    const viaUser = await translate({ messages: [], user: 'y' })
    expect((viaUser['metadata'] as Record<string, unknown>)['user_id']).toBe('y')
  })
})

describe('strict request boundary (NE-LENIENT)', () => {
  it('malformed JSON bodies are rejected with invalid-input', async () => {
    await expect(translateChatToClaude('{"model": "cm", "messages": [', { upstreamModel: UPSTREAM })).rejects.toMatchObject({
      code: 'invalid-input',
    })
    await expect(translateChatToClaude('[1,2,3]', { upstreamModel: UPSTREAM })).rejects.toBeInstanceOf(CpaError)
    await expect(translateChatToClaude('null', { upstreamModel: UPSTREAM })).rejects.toBeInstanceOf(CpaError)
  })
})

describe('stream translation state', () => {
  const ctx = { streamModel: 'm', nowSeconds: () => 0 }

  it('multiple message_delta events each produce a chunk; trailing usage only once', () => {
    const translator = new ClaudeStreamChunkTranslator(ctx)
    const out: string[] = []
    const start = '{"type":"message_start","message":{"id":"i","model":"m","usage":{"input_tokens":1}}}'
    out.push(...translator.translateDataLine(start))
    out.push(...translator.translateDataLine('{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}'))
    out.push(...translator.translateDataLine('{"type":"message_delta","delta":{"stop_reason":"end_turn"}}'))
    out.push(...translator.translateDataLine('{"type":"message_stop"}'))
    out.push(...translator.translateDataLine('{"type":"message_stop"}'))
    const payloads = out.map((frame) => JSON.parse(frame) as Record<string, unknown>)
    expect(payloads.length).toBe(4)
    expect(payloads[1]?.['usage']).toBeDefined()
    expect(payloads[2]?.['usage']).toBeUndefined()
    const trailing = payloads[3] as Record<string, unknown>
    expect(trailing['choices']).toEqual([])
    expect(trailing['usage']).toEqual({
      prompt_tokens: 1,
      completion_tokens: 2,
      total_tokens: 3,
      prompt_tokens_details: { cached_tokens: 0, cached_creation_tokens: 0, cache_write_tokens: 0 },
    })
  })

  it('usage attached to a finish chunk only when the event carries it', () => {
    const translator = new ClaudeStreamChunkTranslator(ctx)
    const out: string[] = []
    out.push(...translator.translateDataLine('{"type":"message_start","message":{"id":"i","model":"m","usage":{"input_tokens":5}}}'))
    out.push(...translator.translateDataLine('{"type":"message_delta","delta":{"stop_reason":"end_turn"}}'))
    const finish = JSON.parse(out[1] ?? '{}') as Record<string, unknown>
    expect(finish['usage']).toBeUndefined()
  })

  it('sequential tool blocks get sequential indices; arguments default to {}', () => {
    const translator = new ClaudeStreamChunkTranslator(ctx)
    const out: string[] = []
    out.push(...translator.translateDataLine('{"type":"message_start","message":{"id":"i","model":"m","usage":{"input_tokens":1}}}'))
    out.push(...translator.translateDataLine('{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"a","name":"f"}}'))
    out.push(...translator.translateDataLine('{"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"b","name":"g"}}'))
    out.push(...translator.translateDataLine('{"type":"content_block_stop","index":2}'))
    out.push(...translator.translateDataLine('{"type":"content_block_stop","index":0}'))
    const chunks = out.slice(1).map((frame) => JSON.parse(frame) as Record<string, unknown>)
    const first = ((chunks[0]?.['choices'] as Record<string, unknown>[])[0]?.['delta'] as Record<string, unknown>)['tool_calls'] as Record<string, unknown>[]
    const second = ((chunks[1]?.['choices'] as Record<string, unknown>[])[0]?.['delta'] as Record<string, unknown>)['tool_calls'] as Record<string, unknown>[]
    expect(first[0]?.['index']).toBe(1)
    expect((first[0]?.['function'] as Record<string, unknown>)['arguments']).toBe('{}')
    expect(second[0]?.['index']).toBe(0)
  })

  it('stop_reason mapping table', () => {
    expect(mapStopReason('end_turn')).toBe('stop')
    expect(mapStopReason('stop_sequence')).toBe('stop')
    expect(mapStopReason('tool_use')).toBe('tool_calls')
    expect(mapStopReason('max_tokens')).toBe('length')
    expect(mapStopReason('refusal')).toBe('content_filter')
    expect(mapStopReason('sensitive')).toBe('content_filter')
    expect(mapStopReason('whatever')).toBe('stop')
    expect(mapStopReason(undefined)).toBe('stop')
  })
})

describe('SSE decoder', () => {
  async function decode(chunks: readonly string[]): Promise<readonly { event?: string; data: string }[]> {
    const source = (async function* () {
      for (const chunk of chunks) yield chunk
    })()
    const out: { event?: string; data: string }[] = []
    for await (const frame of decodeSseFrames(source)) out.push(frame)
    return out
  }

  it('handles CRLF, comments, event names and mid-frame splits', async () => {
    const wire = ': keep-alive\r\n\r\nevent: message_start\r\ndata: {"a":1}\r\n\r\ndata: [DONE]\n\n'
    const frames = await decode([wire.slice(0, 20), wire.slice(20, 40), wire.slice(40)])
    expect(frames).toEqual([
      { event: 'message_start', data: '{"a":1}' },
      { event: undefined, data: '[DONE]' },
    ])
  })

  it('data lines without a space are kept verbatim', async () => {
    const frames = await decode(['data:x\n\n'])
    expect(frames).toEqual([{ event: undefined, data: 'x' }])
  })

  it('parseDownstreamSse splits wire frames into payloads', () => {
    expect(parseDownstreamSse('data: a\n\ndata: [DONE]\n\n')).toEqual(['a', '[DONE]'])
  })
})

describe('error classification', () => {
  it('wrap table per status', () => {
    expect(wrapTypeForStatus(401)).toEqual({ type: 'authentication_error', code: 'invalid_api_key' })
    expect(wrapTypeForStatus(403)).toEqual({ type: 'permission_error', code: 'insufficient_quota' })
    expect(wrapTypeForStatus(404)).toEqual({ type: 'invalid_request_error', code: 'model_not_found' })
    expect(wrapTypeForStatus(429)).toEqual({ type: 'rate_limit_error', code: 'rate_limit_exceeded' })
    expect(wrapTypeForStatus(500)).toEqual({ type: 'server_error', code: 'internal_server_error' })
    expect(wrapTypeForStatus(503)).toEqual({ type: 'server_error', code: 'internal_server_error' })
    expect(wrapTypeForStatus(400)).toEqual({ type: 'invalid_request_error' })
  })

  it('valid JSON bodies pass through verbatim; whitespace bodies wrap', () => {
    expect(classifyClaudeUpstreamError(500, '  {"a":1} ').kind).toBe('verbatim')
    const wrapped = classifyClaudeUpstreamError(500, '   ')
    expect(wrapped.kind).toBe('wrapped')
    if (wrapped.kind === 'wrapped') expect(wrapped.message).toBe('Internal Server Error')
    const custom = classifyClaudeUpstreamError(418, 'teapot broken')
    expect(custom.kind).toBe('wrapped')
    if (custom.kind === 'wrapped') expect(custom.message).toBe('teapot broken')
  })

  it('rate-limit reset parsing and fuzz bounds', () => {
    expect(parseClaudeRateLimitReset({})).toBeUndefined()
    expect(parseClaudeRateLimitReset({ 'retry-after': '12' })).toBe(12)
    expect(parseClaudeRateLimitReset({ 'Anthropic-Ratelimit-Unified-Reset': '30' })).toBe(30)
    expect(parseClaudeRateLimitResetWithFuzz({}, () => 0.999)).toBe(1)
    expect(parseClaudeRateLimitResetWithFuzz({ 'Retry-After': '1' }, () => 0)).toBe(2)
    expect(parseClaudeRateLimitResetWithFuzz({ 'Retry-After': '1' }, () => 0.9999)).toBe(31)
  })

  it('aggregation validation accepts a complete buffer', () => {
    const buffer = [
      'data: {"type":"message_start","message":{"id":"i","model":"m"}}',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
      '',
    ].join('\n')
    expect(validateClaudeAggregatedStream(buffer).ok).toBe(true)
  })

  it('two-tier precedence: the first per-line violation in line order wins', () => {
    const start = 'data: {"type":"message_start","message":{"id":"i","model":"m"}}'
    const badStart = 'data: {"type":"message_start","message":{"id":"","model":""}}'
    const malformed = 'data: {not json}'
    const errorEvent = 'data: {"type":"error","error":{"type":"api_error","message":"boom"}}'
    const delta = 'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}'
    const cases: ReadonlyArray<readonly [string, string]> = [
      // error event before a malformed line: the error event fires first
      [sseBuffer(start, errorEvent, malformed), 'claude executor: upstream returned error event: boom'],
      // malformed line before an error event: malformed fires first
      [sseBuffer(start, malformed, errorEvent), 'claude executor: upstream returned malformed stream data'],
      // an incomplete message_start fires at its line, before a later error event
      [sseBuffer(badStart, errorEvent), 'claude executor: upstream stream message_start is missing id or model'],
      // an error event after a complete message_start still fires (per-line tier)
      [sseBuffer(start, errorEvent, delta), 'claude executor: upstream returned error event: boom'],
    ]
    for (const [buffer, expected] of cases) {
      const result = validateClaudeAggregatedStream(buffer)
      expect(result.ok).toBe(false)
      if (result.ok === false) expect(result.message).toBe(expected)
    }
  })

  it('two-tier precedence: post-loop gates fire only after a clean scan', () => {
    const start = 'data: {"type":"message_start","message":{"id":"i","model":"m"}}'
    const ping = 'data: {"type":"ping"}'
    // zero non-empty payloads (only blank data lines) -> empty stream response
    expect(messageOf('data: \n\ndata:\n\n')).toBe('claude executor: upstream returned empty stream response')
    // payloads but no message_start -> missing message_start
    expect(messageOf(sseBuffer(ping))).toBe('claude executor: upstream stream response is missing message_start')
    // message_start but no message_delta -> ended before completion
    expect(messageOf(sseBuffer(start))).toBe('claude executor: upstream stream response ended before message completion')
  })

  function sseBuffer(...lines: readonly string[]): string {
    return lines.map((line) => `${line}\n\n`).join('')
  }

  function messageOf(buffer: string): string {
    const result = validateClaudeAggregatedStream(buffer)
    expect(result.ok).toBe(false)
    expect(result.ok === false).toBe(true)
    if (result.ok === false) return result.message
    throw new Error('unreachable')
  }
})

describe('header policy', () => {
  it('defaults fill only what the client left unset', () => {
    const headers = buildClaudeUpstreamHeaders({
      clientHeaders: { Accept: 'application/json' },
      apiKey: KEY,
      baseUrl: BASE,
      gatewayVersion: 'v7.3.4',
    })
    expect(headers['Accept']).toBe('application/json')
    expect(headers['Accept-Encoding']).toBe('identity')
    expect(headers['User-Agent']).toBe(gatewayUserAgent('v7.3.4'))
    expect(headers['Anthropic-Version']).toBe(DEFAULT_ANTHROPIC_VERSION)
  })

  it('Anthropic bases switch to x-api-key and get no streaming Accept default', () => {
    const headers = buildClaudeUpstreamHeaders({
      clientHeaders: {},
      apiKey: KEY,
      baseUrl: 'https://api.anthropic.com',
    })
    expect(headers['x-api-key']).toBe(KEY)
    expect(headers['Authorization']).toBeUndefined()
    expect(headers['Accept']).toBeUndefined()
    expect(headers['Accept-Encoding']).toBeUndefined()
  })

  it('credential header overrides are clawed back on streaming requests', () => {
    const headers = buildClaudeUpstreamHeaders({
      clientHeaders: { Accept: '*/*' },
      apiKey: KEY,
      baseUrl: BASE,
      credentialHeaders: { Accept: 'application/json', 'Accept-Encoding': 'gzip', 'X-Custom': 'keep' },
    })
    expect(headers['Accept']).toBe('*/*')
    expect(headers['Accept-Encoding']).toBe('identity')
    expect(headers['X-Custom']).toBe('keep')
  })

  it('CLI profile betas drop the managed effort beta for disabled thinking or haiku models', () => {
    const disabled = claudeCodeCliBetas({ thinking: { type: 'disabled' }, model: 'claude-mock-model' })
    expect(disabled).not.toContain('effort-2025-11-24')
    const haiku = claudeCodeCliBetas({ model: 'claude-3-5-haiku-latest' })
    expect(haiku).not.toContain('effort-2025-11-24')
    const active = claudeCodeCliBetas({ thinking: { type: 'enabled' }, model: 'claude-mock-model' })
    expect(active).toContain('effort-2025-11-24')
  })

  it('CLI profile headers match the recorded case-21 surface', () => {
    const headers = buildClaudeUpstreamHeaders({
      clientHeaders: {},
      apiKey: KEY,
      baseUrl: BASE,
      fingerprintProfile: 'claude-code-cli',
      cliIdentity: { sessionId: 'sid', accountUuid: 'acc', deviceId: 'dev', date: '2026-09-16' },
    })
    expect(headers['User-Agent']).toBe('claude-cli/2.1.258 (external, cli)')
    expect(headers['Accept']).toBe('text/event-stream')
    expect(headers['Accept-Encoding']).toBe('identity')
    expect(headers['Connection']).toBe('keep-alive')
    expect(headers['X-App']).toBe('cli')
    expect(headers['X-Claude-Code-Session-Id']).toBe('sid')
    expect(headers['Anthropic-Dangerous-Direct-Browser-Access']).toBe('true')
    expect(headers['X-Stainless-Lang']).toBe('js')
    expect(headers['X-Stainless-Timeout']).toBe('600')
    expect(headers['Anthropic-Beta']).toContain('oauth-2025-04-20')
    expect(headers['Anthropic-Beta']).toContain('extended-cache-ttl-2025-04-11')
  })
})
