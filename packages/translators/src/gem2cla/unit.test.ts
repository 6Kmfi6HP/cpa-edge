/**
 * Unit coverage for rules the recorded goldens do not exercise: the part
 * and merge rules, the tool-id pairing chain, tool-schema cleaning, the
 * thinking variants, the user-id precedence chain, cache-breakpoint
 * placement, stream state-machine edges (empty-parts chunks, silent
 * accumulation, the raw-args cascade), the validator families (502 and
 * countTokens), the local token estimate (R-TOK), always-STOP,
 * promptTokenCount=0, header policy edges, and the service facades
 * (gateway-key gate, cooldown bookkeeping, alt framing).
 */
import { describe, expect, it } from 'vitest'
import { CpaError, MemoryStore } from '@cpa-edge/core'
import { translateGeminiToClaude, assembleClaudeContent } from './request'
import { cleanToolParameters, claudeToolObject } from './schema'
import { deriveClaudeUserId, sha256Hex } from './userid'
import {
  ClaudeToGeminiStreamTranslator,
  consolidateParts,
  formatRfc3339Seconds,
  inStreamErrorChunk,
  translateClaudeBufferToGemini,
  validateClaudeAggregatedStream,
} from './response'
import {
  claudeInputSegments,
  estimateClaudeInputTokens,
  serializeTokenCountRequest,
  validateClaudeTokenCountRequest,
} from './tokens'
import {
  classifyClaudeUpstreamError,
  formatTerminalErrorFrame,
  parseClaudeRateLimitReset,
  parseClaudeRateLimitResetWithFuzz,
  renderEmptyStreamFailure,
  renderUnexpectedEofFailure,
  renderValidationFailure,
} from './errors'
import { buildClaudeUpstreamHeaders, orderUpstreamHeaders } from './headers'
import { decodeSseFrames } from './sse'
import { bootstrapGeminiStream } from './stream'
import { createGem2ClaService } from './service'
import type {
  Gem2ClaCredential,
  Gem2ClaRequest,
  Gem2ClaResponse,
  Gem2ClaUpstreamResponse,
  Gem2ClaUpstreamSender,
} from './service'
import type { GeminiToClaudeContext } from './types'

const UPSTREAM = 'claude-mock-model'
const BASE = 'http://mock.internal:20002'
const KEY = 'mock-claude-key'
const encoder = new TextEncoder()
const CTX: GeminiToClaudeContext = { upstreamModel: UPSTREAM }

async function translate(body: unknown, ctx: GeminiToClaudeContext = CTX): Promise<Record<string, unknown>> {
  const result = await translateGeminiToClaude(JSON.stringify(body), ctx)
  return JSON.parse(result.body) as Record<string, unknown>
}

function messagesOf(body: Record<string, unknown>): Record<string, unknown>[] {
  return body['messages'] as Record<string, unknown>[]
}

function contentOf(body: Record<string, unknown>, index: number): Record<string, unknown>[] {
  return (messagesOf(body)[index] ?? {})['content'] as Record<string, unknown>[]
}

// ---------------------------------------------------------------------------
// Request translation — contents
// ---------------------------------------------------------------------------

describe('request translation — contents', () => {
  it('role mapping: model->assistant, function/tool->user, others dropped', async () => {
    const body = await translate({
      contents: [
        { role: 'user', parts: [{ text: 'u' }] },
        { role: 'model', parts: [{ text: 'a' }] },
        { role: 'function', parts: [{ text: 'f' }] },
        { role: 'tool', parts: [{ text: 't' }] },
        { role: 'bogus', parts: [{ text: 'x' }] },
        { role: '', parts: [{ text: 'x' }] },
        { parts: [{ text: 'x' }] },
      ],
    })
    const roles = messagesOf(body).map((message) => message['role'])
    // The function and tool turns are consecutive user turns: they merge.
    expect(roles).toEqual(['user', 'assistant', 'user'])
    expect(((messagesOf(body)[2] ?? {})['content'] as Record<string, unknown>[]).map((b) => b['text'])).toEqual(['f', 't'])
  })

  it('same-role turns merge; assistant tool_use blocks move after text blocks', async () => {
    const body = await translate({
      contents: [
        { role: 'user', parts: [{ text: 'a' }] },
        { role: 'user', parts: [{ text: 'b' }, { functionCall: { name: 'f', args: {} } }] },
        { role: 'model', parts: [{ functionCall: { name: 'g', args: {} } }, { text: 't' }] },
        { role: 'model', parts: [{ text: 't2' }] },
      ],
    })
    const messages = messagesOf(body)
    expect(messages.length).toBe(2)
    expect((messages[0]?.['content'] as Record<string, unknown>[]).map((b) => b['text'])).toEqual(['a', 'b'])
    const assistant = messages[1]?.['content'] as Record<string, unknown>[]
    expect(assistant.map((b) => b['type'])).toEqual(['text', 'text', 'tool_use'])
  })

  it('system_instruction becomes a lone leading user turn that never merges', async () => {
    const body = await translate({
      system_instruction: { parts: [{ text: 'one' }, { text: 'two' }] },
      contents: [{ role: 'user', parts: [{ text: 'q' }] }],
    })
    const messages = messagesOf(body)
    expect(messages.length).toBe(2)
    expect(messages[0]).toEqual({ role: 'user', content: [{ type: 'text', text: 'one\ntwo' }] })
    expect(messages[1]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'q', cache_control: { type: 'ephemeral' } }],
    })
  })

  it('camelCase systemInstruction, string system_instruction and empty parts are all dropped', async () => {
    for (const instruction of ['plain string', { noParts: true }, { parts: [] }, { parts: [{ inlineData: {} }] }]) {
      const body = await translate({ systemInstruction: { parts: [{ text: 'x' }] }, system_instruction: instruction, contents: [] })
      expect(body['messages']).toEqual([])
    }
  })

  it('thought parts are skipped; text parts stay separate blocks', async () => {
    const body = await translate({
      contents: [{ role: 'user', parts: [{ text: 'a' }, { thought: true, text: 'secret' }, { text: 'b' }] }],
    })
    expect(contentOf(body, 0).map((block) => block['text'])).toEqual(['a', 'b'])
  })

  it('a functionCall inside a user turn is dropped; functionResponse works anywhere', async () => {
    const body = await translate({
      contents: [
        {
          role: 'user',
          parts: [
            { functionCall: { name: 'f', args: {} } },
            { functionResponse: { name: 'f', response: { result: 'ok' } } },
          ],
        },
      ],
    })
    expect(contentOf(body, 0).map((block) => block['type'])).toEqual(['tool_result'])
  })
})

// ---------------------------------------------------------------------------
// Request translation — tool pairing and functionResponse encoding
// ---------------------------------------------------------------------------

describe('request translation — tool pairing', () => {
  it('generated ids count up per functionCall; responses consume them FIFO', async () => {
    const body = await translate({
      contents: [
        {
          role: 'model',
          parts: [{ functionCall: { name: 'a', args: {} } }, { functionCall: { name: 'b', args: {} } }],
        },
        { role: 'user', parts: [{ functionResponse: { name: 'a', response: {} } }] },
      ],
    })
    const assistant = contentOf(body, 0)
    expect((assistant[0] as Record<string, unknown>)['id']).toBe('toolu_gemini_0000000000000001')
    expect((assistant[1] as Record<string, unknown>)['id']).toBe('toolu_gemini_0000000000000002')
    const result = contentOf(body, 1)[0] as Record<string, unknown>
    expect(result['tool_use_id']).toBe('toolu_gemini_0000000000000001')
  })

  it('explicit ids win; an explicit response id removes itself from the queue', async () => {
    const body = await translate({
      contents: [
        {
          role: 'model',
          parts: [
            { functionCall: { id: 'toolu_x', name: 'a', args: {} } },
            { functionCall: { call_id: 'toolu_y', name: 'b', args: {} } },
            { functionCall: { name: 'c', args: {} } },
          ],
        },
        { role: 'user', parts: [{ functionResponse: { id: 'toolu_y', response: {} } }] },
        { role: 'user', parts: [{ functionResponse: { response: {} } }] },
      ],
    })
    const assistant = contentOf(body, 0)
    expect(assistant.map((block) => (block as Record<string, unknown>)['id'])).toEqual([
      'toolu_x',
      'toolu_y',
      'toolu_gemini_0000000000000001',
    ])
    // toolu_y was consumed by its explicit response, so the FIFO hands out
    // toolu_x; the two user turns merged into one message.
    const results = contentOf(body, 1)
    expect(results.length).toBe(2)
    expect((results[0] as Record<string, unknown>)['tool_use_id']).toBe('toolu_y')
    expect((results[1] as Record<string, unknown>)['tool_use_id']).toBe('toolu_x')
  })

  it('a response without any pending id generates a fresh one', async () => {
    const body = await translate({
      contents: [{ role: 'user', parts: [{ functionResponse: { name: 'f', response: { result: 'r' } } }] }],
    })
    expect((contentOf(body, 0)[0] as Record<string, unknown>)['tool_use_id']).toBe('toolu_gemini_0000000000000001')
  })

  it('functionResponse content encoding: result string, result raw JSON, response raw, empty', async () => {
    const raw =
      '{"contents":[{"role":"user","parts":[' +
      '{"functionResponse":{"name":"a","response":{"result":"plain"}}},' +
      '{"functionResponse":{"name":"b","response":{"result":{"nested": true}}}},' +
      '{"functionResponse":{"name":"c","response":{"whole": 1}}},' +
      '{"functionResponse":{"name":"d"}}' +
      ']}]}'
    const body = await translateGeminiToClaude(raw, CTX)
    const parsed = JSON.parse(body.body) as Record<string, unknown>
    const blocks = (messagesOf(parsed)[0] ?? {})['content'] as Record<string, unknown>[]
    expect(blocks[0]?.['content']).toBe('plain')
    expect(blocks[1]?.['content']).toBe('{"nested": true}')
    expect(blocks[2]?.['content']).toBe('{"whole": 1}')
    expect(blocks[3]?.['content']).toBe('')
  })

  it('functionCall args keep the client bytes verbatim (spacing included)', async () => {
    const raw =
      '{"contents":[{"role":"model","parts":[{"functionCall":{"name":"f",' +
      '"args":{"city":  "Paris",  "units": "C"}}}]}]}'
    const body = await translateGeminiToClaude(raw, CTX)
    expect(body.body).toContain('"input":{"city":  "Paris",  "units": "C"}')
  })

  it('non-object functionCall args collapse to the empty-object skeleton', async () => {
    const body = await translate({
      contents: [{ role: 'model', parts: [{ functionCall: { name: 'f', args: 'text' } }] }],
    })
    expect((contentOf(body, 0)[0] as Record<string, unknown>)['input']).toEqual({})
  })
})

// ---------------------------------------------------------------------------
// Request translation — media parts
// ---------------------------------------------------------------------------

describe('request translation — media parts', () => {
  const image = { mimeType: 'image/png', data: 'aGk=' }
  const pdf = { mimeType: 'application/pdf', data: 'aGk=' }
  const text = { mimeType: 'text/plain', data: 'aGk=' }
  const audio = { mimeType: 'audio/wav', data: 'aGk=' }

  it('inlineData maps image/application/text and placeholders the rest', async () => {
    const body = await translate({
      contents: [{ role: 'user', parts: [{ inlineData: image }, { inline_data: pdf }, { inlineData: text }, { inlineData: audio }] }],
    })
    expect(contentOf(body, 0).map((block) => block['type'])).toEqual(['image', 'document', 'document', 'text'])
    expect(contentOf(body, 0)[3]).toEqual({
      type: 'text',
      text: 'Media content: inline data (Type: audio/wav)',
      cache_control: { type: 'ephemeral' },
    })
  })

  it('inline parts with empty mime or data are dropped', async () => {
    const body = await translate({
      contents: [{ role: 'user', parts: [{ inlineData: { mimeType: '', data: 'x' } }, { inlineData: { mimeType: 'image/png' } }] }],
    })
    expect(body['messages']).toEqual([])
  })

  it('fileData maps image url / document url with media_type and File: placeholders', async () => {
    const body = await translate({
      contents: [
        {
          role: 'user',
          parts: [
            { fileData: { mimeType: 'image/png', fileUri: 'https://x/i.png' } },
            { file_data: { mimeType: 'application/pdf', fileUri: 'https://x/d.pdf' } },
            { fileData: { mimeType: 'audio/wav', fileUri: 'https://x/a.wav' } },
          ],
        },
      ],
    })
    const blocks = contentOf(body, 0)
    expect(blocks[0]).toEqual({ type: 'image', source: { type: 'url', url: 'https://x/i.png' } })
    expect(blocks[1]).toEqual({
      type: 'document',
      source: { type: 'url', url: 'https://x/d.pdf', media_type: 'application/pdf' },
    })
    expect(blocks[2]).toEqual({
      type: 'text',
      text: 'File: https://x/a.wav (Type: audio/wav)',
      cache_control: { type: 'ephemeral' },
    })
  })
})

// ---------------------------------------------------------------------------
// Request translation — tools, tool choice, generation config
// ---------------------------------------------------------------------------

describe('request translation — tools and config', () => {
  it('functionDeclarations become sorted tool objects with cleaned input_schema', async () => {
    const body = await translate({
      contents: [],
      tools: [
        {
          functionDeclarations: [
            {
              name: 'f',
              description: 'd',
              parameters: { type: 'OBJECT', properties: { q: { type: 'STRING' } }, additionalProperties: true },
            },
            { name: 'g' },
          ],
        },
        { notFunctionDeclarations: true },
      ],
    })
    const tools = body['tools'] as Record<string, unknown>[]
    expect(tools.length).toBe(2)
    expect(Object.keys(tools[0] ?? {})).toEqual(['description', 'input_schema', 'name'])
    expect(tools[0]?.['input_schema']).toEqual({
      $schema: 'http://json-schema.org/draft-07/schema#',
      additionalProperties: false,
      properties: { q: { type: 'string' } },
      type: 'object',
    })
    expect(tools[1]?.['input_schema']).toEqual({})
    // No pre-existing markers: the LAST tool gets the breakpoint.
    expect(tools[1]?.['cache_control']).toEqual({ type: 'ephemeral' })
    expect(tools[0]?.['cache_control']).toBeUndefined()
  })

  it('cleanToolParameters lowercases type arrays too and keeps other members', () => {
    const cleaned = cleanToolParameters({ type: ['String', 'NULL'], enum: ['a'] }) as Record<string, unknown>
    expect(cleaned['type']).toEqual(['string', 'null'])
    expect(cleaned['enum']).toEqual(['a'])
  })

  it('claudeToolObject reads parameters before parametersJsonSchema', () => {
    const tool = claudeToolObject({ name: 'f', parameters: { type: 'object' }, parametersJsonSchema: { type: 'STRING' } })
    expect((tool['input_schema'] as Record<string, unknown>)['type']).toBe('object')
  })

  it('tool_choice modes (snake and camel) and allowedFunctionNames', async () => {
    const auto = await translate({ contents: [], toolConfig: { functionCallingConfig: { mode: 'AUTO' } } })
    expect(auto['tool_choice']).toEqual({ type: 'auto' })
    const none = await translate({ contents: [], tool_config: { function_calling_config: { mode: 'NONE' } } })
    expect(none['tool_choice']).toEqual({ type: 'none' })
    const tool = await translate({
      contents: [],
      toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['f'] } },
    })
    expect(tool['tool_choice']).toEqual({ type: 'tool', name: 'f' })
    const any = await translate({
      contents: [],
      tool_config: { function_calling_config: { mode: 'ANY', allowed_function_names: ['f', 'g'] } },
    })
    expect(any['tool_choice']).toEqual({ type: 'any' })
    const absent = await translate({ contents: [], tool_config: { function_calling_config: {} } })
    expect(absent['tool_choice']).toBeUndefined()
    const other = await translate({ contents: [], tool_config: { function_calling_config: { mode: 'WEIRD' } } })
    expect(other['tool_choice']).toBeUndefined()
  })

  it('maxOutputTokens: default 32000, numeric strings parse, garbage coerces to 0', async () => {
    expect((await translate({ contents: [] }))['max_tokens']).toBe(32000)
    expect((await translate({ contents: [], generationConfig: { maxOutputTokens: 512 } }))['max_tokens']).toBe(512)
    expect((await translate({ contents: [], generationConfig: { maxOutputTokens: '500' } }))['max_tokens']).toBe(500)
    expect((await translate({ contents: [], generationConfig: { maxOutputTokens: 'abc' } }))['max_tokens']).toBe(0)
    expect((await translate({ contents: [], generationConfig: { maxOutputTokens: null } }))['max_tokens']).toBe(0)
  })

  it('stopSequences need a non-empty array; sampling knobs never reach the wire', async () => {
    const stop = await translate({
      contents: [],
      generationConfig: { stopSequences: ['END', 'STOP'], temperature: 0.7, topP: 0.9, topK: 40, top_p: 0.5 },
    })
    expect(stop['stop_sequences']).toEqual(['END', 'STOP'])
    expect(stop['temperature']).toBeUndefined()
    expect(stop['top_p']).toBeUndefined()
    expect(stop['top_k']).toBeUndefined()
    const empty = await translate({ contents: [], generationConfig: { stopSequences: [] } })
    expect(empty['stop_sequences']).toBeUndefined()
  })

  it('service_tier passes through after metadata', async () => {
    const body = await translate({ contents: [], service_tier: 'priority' })
    expect(Object.keys(body)).toContain('service_tier')
    expect(body['service_tier']).toBe('priority')
    expect(Object.keys(body).indexOf('service_tier')).toBeGreaterThan(Object.keys(body).indexOf('metadata'))
  })
})

// ---------------------------------------------------------------------------
// Request translation — thinking
// ---------------------------------------------------------------------------

describe('request translation — thinking', () => {
  const levels = { kind: 'levels' as const, levels: ['low', 'medium'] }
  const budget = { kind: 'budget' as const, min: 1024, max: 32000 }

  it('levels and budgets translate; unknown levels and empty strings produce nothing', async () => {
    expect((await translate({ contents: [], generationConfig: { thinkingConfig: { thinkingLevel: 'none' } } }))['thinking']).toBeUndefined()
    expect((await translate({ contents: [], generationConfig: { thinkingConfig: { thinkingLevel: 'LOW' } } }, { upstreamModel: UPSTREAM, thinking: budget }))['thinking']).toEqual({ type: 'enabled', budget_tokens: 1024 })
    expect((await translate({ contents: [], generationConfig: { thinkingConfig: { thinkingLevel: 'auto' } } }, { upstreamModel: UPSTREAM, thinking: budget }))['thinking']).toEqual({ type: 'enabled' })
    expect((await translate({ contents: [], generationConfig: { thinkingConfig: { thinking_level: 'xhigh' } } }, { upstreamModel: UPSTREAM, thinking: budget }))['thinking']).toEqual({ type: 'enabled', budget_tokens: 32768 })
    expect((await translate({ contents: [], generationConfig: { thinkingConfig: { thinkingBudget: 0 } } }, { upstreamModel: UPSTREAM, thinking: budget }))['thinking']).toEqual({ type: 'disabled' })
    expect((await translate({ contents: [], generationConfig: { thinkingConfig: { thinking_budget: -1 } } }, { upstreamModel: UPSTREAM, thinking: budget }))['thinking']).toEqual({ type: 'enabled' })
    expect((await translate({ contents: [], generationConfig: { thinkingConfig: { thinkingBudget: 777 } } }, { upstreamModel: UPSTREAM, thinking: budget }))['thinking']).toEqual({ type: 'enabled', budget_tokens: 777 })
    expect((await translate({ contents: [], generationConfig: { thinkingConfig: { thinkingLevel: 'bogus' } } }, { upstreamModel: UPSTREAM, thinking: budget }))['thinking']).toBeUndefined()
    expect((await translate({ contents: [], generationConfig: { thinkingConfig: {} } }, { upstreamModel: UPSTREAM, thinking: budget }))['thinking']).toBeUndefined()
  })

  it('capability-less models strip the block entirely (S2d7-08 pin)', async () => {
    const body = await translate({ contents: [], generationConfig: { thinkingConfig: { thinkingLevel: 'low' } } })
    expect(body['thinking']).toBeUndefined()
  })

  it('a levels-capable model maps a level to the adaptive shape with effort', async () => {
    const body = await translate(
      { contents: [], generationConfig: { thinkingConfig: { thinkingLevel: 'medium' } } },
      { upstreamModel: UPSTREAM, thinking: levels },
    )
    expect(body['thinking']).toEqual({ type: 'adaptive' })
    expect(body['output_config']).toEqual({ effort: 'medium' })
  })

  it('a forced tool_choice deletes whatever thinking survived', async () => {
    const body = await translate(
      {
        contents: [],
        generationConfig: { thinkingConfig: { thinkingLevel: 'medium' } },
        toolConfig: { functionCallingConfig: { mode: 'ANY' } },
      },
      { upstreamModel: UPSTREAM, thinking: budget },
    )
    expect(body['thinking']).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Request translation — user id chain
// ---------------------------------------------------------------------------

describe('user-id derivation', () => {
  const model = 'claude-mock-model'

  it('verbatim passthrough first, then each hashed seed source in order', async () => {
    const viaMeta = await translate({ contents: [], metadata: { user_id: 'u1' } })
    expect((viaMeta['metadata'] as Record<string, unknown>)['user_id']).toBe('u1')
    const viaUser = await translate({ contents: [], user: 'u2' })
    expect((viaUser['metadata'] as Record<string, unknown>)['user_id']).toBe('u2')
    const viaCache = await deriveClaudeUserId({
      request: { prompt_cache_key: 'p' },
      rawBody: '{"prompt_cache_key":"p"}',
      model,
    })
    expect(viaCache).toMatch(/^[0-9a-f]{64}$/)
    expect(viaCache).toBe(await sha256Hex('prompt_cache_key:p'))
    const viaSession = await deriveClaudeUserId({
      request: { session_id: 's' },
      rawBody: '{"session_id":"s"}',
      model,
    })
    expect(viaSession).toBe(await sha256Hex('session_id:s'))
    const viaCamel = await deriveClaudeUserId({
      request: { sessionId: 's2' },
      rawBody: '{"sessionId":"s2"}',
      model,
    })
    expect(viaCamel).toBe(await sha256Hex('session_id:s2'))
  })

  it('conversation sources: conversation.id, string conversation, conversation_id', async () => {
    const viaNested = await deriveClaudeUserId({
      request: { conversation: { id: 'c1' } },
      rawBody: '{"conversation":{"id":"c1"}}',
      model,
    })
    expect(viaNested).toBe(await sha256Hex('conversation_id:c1'))
    const viaString = await deriveClaudeUserId({
      request: { conversation: 'c2' },
      rawBody: '{"conversation":"c2"}',
      model,
    })
    expect(viaString).toBe(await sha256Hex('conversation_id:c2'))
    const viaFlat = await deriveClaudeUserId({
      request: { conversation_id: 'c3' },
      rawBody: '{"conversation_id":"c3"}',
      model,
    })
    expect(viaFlat).toBe(await sha256Hex('conversation_id:c3'))
  })

  it('the content seed hashes the first user-or-missing turn text', async () => {
    const seed = await deriveClaudeUserId({
      request: { contents: [{ role: 'model', parts: [{ text: 'skip' }] }, { parts: [{ text: 'a' }, { text: 'b' }] }] },
      rawBody: '{}',
      model,
    })
    expect(seed).toBe(await sha256Hex('content:a\nb'))
    // The recorded oracle value for "Say hello".
    const recorded = await deriveClaudeUserId({
      request: { contents: [{ role: 'user', parts: [{ text: 'Say hello' }] }] },
      rawBody: '{}',
      model,
    })
    expect(recorded).toBe('120226d8c5cb65e3acdd1f5e56fb3cf04f8bf909fe34ece9118dcc2d0e8b6c46')
  })

  it('the model seed embeds instructions and the raw system variants; unknown as last resort', async () => {
    const modelSeed = await deriveClaudeUserId({
      request: { instructions: 'ins', system_instruction: { parts: [{ text: 't' }] } },
      rawBody: '{"instructions":"ins","system_instruction":{"parts":[{"text":"t"}]}}',
      model,
    })
    expect(modelSeed).toBe(await sha256Hex('model:claude-mock-model;instructions:ins;system_instruction:{"parts":[{"text":"t"}]}'))
    const unknown = await deriveClaudeUserId({ request: {}, rawBody: '{}', model: '' })
    expect(unknown).toBe('unknown')
  })
})

// ---------------------------------------------------------------------------
// Stream state machine
// ---------------------------------------------------------------------------

describe('stream translation state machine', () => {
  const now = () => 1_700_000_000_000
  const ctx = { resolvedModel: 'ignored-on-stream', now }

  function translator(): ClaudeToGeminiStreamTranslator {
    return new ClaudeToGeminiStreamTranslator(ctx)
  }

  function feed(t: ClaudeToGeminiStreamTranslator, payload: unknown): readonly string[] {
    return t.translateDataLine(JSON.stringify(payload))
  }

  it('chunk skeleton order and finishReason nesting (valid args)', () => {
    const t = translator()
    feed(t, { type: 'message_start', message: { id: 'mid', model: 'm1' } })
    feed(t, { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tid', name: 'f' } })
    feed(t, { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"a":' } })
    feed(t, { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '1}' } })
    const chunks = feed(t, { type: 'content_block_stop', index: 0 })
    expect(chunks.length).toBe(1)
    const chunk = chunks[0] ?? ''
    expect(chunk.startsWith('{"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"f","args":{"a":1},"id":"tid"}}]},"finishReason":"STOP"}],"usageMetadata":{"trafficType":"PROVISIONED_THROUGHPUT"},"modelVersion":"m1","createTime":"')).toBe(true)
    expect(chunk.endsWith(`","responseId":"mid"}`)).toBe(true)
  })

  it('corrupt args shift the id to the part and finishReason to the chunk root', () => {
    const t = translator()
    feed(t, { type: 'message_start', message: { id: 'mid', model: 'm1' } })
    feed(t, { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tid', name: 'f' } })
    feed(t, { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"a":' } })
    feed(t, { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'bad"' } })
    const chunks = feed(t, { type: 'content_block_stop', index: 0 })
    const chunk = chunks[0] ?? ''
    expect(chunk).toContain('"functionCall":{"name":"f","args":{"a":bad"},"id":"tid"')
    expect(chunk.endsWith('"responseId":"mid","finishReason":"STOP"}')).toBe(true)
    expect(chunk).not.toContain('"finishReason":"STOP"}],"usageMetadata"')
  })

  it('a tool block without an id omits the id entirely; empty fragments default args to {}', () => {
    const t = translator()
    feed(t, { type: 'message_start', message: { id: 'mid', model: 'm1' } })
    feed(t, { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: 'f' } })
    const chunks = feed(t, { type: 'content_block_stop', index: 0 })
    expect(chunks[0]).toContain('"functionCall":{"name":"f","args":{}}')
  })

  it('empty text and unknown deltas emit ONE empty-parts chunk; input_json_delta emits nothing', () => {
    const t = translator()
    feed(t, { type: 'message_start', message: { id: 'i', model: 'm' } })
    expect(feed(t, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '' } })).toEqual([
      expect.stringContaining('"parts":[]'),
    ])
    expect(feed(t, { type: 'content_block_delta', index: 0, delta: { type: 'what_is_this' } })).toEqual([
      expect.stringContaining('"parts":[]'),
    ])
    expect(feed(t, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta' } })).toEqual([
      expect.stringContaining('"parts":[]'),
    ])
    expect(feed(t, { type: 'content_block_delta', index: 0 })).toEqual([expect.stringContaining('"parts":[]')])
    expect(feed(t, { type: 'content_block_delta', index: 3, delta: { type: 'input_json_delta', partial_json: '{}' } })).toEqual([])
  })

  it('thinking and signature deltas become thought parts; message_stop and unknown events emit nothing', () => {
    const t = translator()
    feed(t, { type: 'message_start', message: { id: 'i', model: 'm' } })
    expect(feed(t, { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hm' } })).toEqual([
      expect.stringContaining('"parts":[{"thought":true,"text":"hm"}]'),
    ])
    expect(feed(t, { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } })).toEqual([
      expect.stringContaining('"parts":[{"thought":true,"thoughtSignature":"sig"}]'),
    ])
    expect(feed(t, { type: 'message_stop' })).toEqual([])
    expect(feed(t, { type: 'ping' })).toEqual([])
    expect(feed(t, { type: 'unknown_event' })).toEqual([])
  })

  it('message_delta always emits STOP with usage-derived counts (promptTokenCount 0 default)', () => {
    const t = translator()
    feed(t, { type: 'message_start', message: { id: 'i', model: 'm', usage: { input_tokens: 99 } } })
    const withUsage = feed(t, { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 6, cache_read_input_tokens: 4, cache_creation_input_tokens: 1, thinking_tokens: 2 } })
    expect(withUsage.length).toBe(1)
    expect(withUsage[0]).toContain('"usageMetadata":{"trafficType":"PROVISIONED_THROUGHPUT","promptTokenCount":0,"candidatesTokenCount":6,"totalTokenCount":6,"cachedContentTokenCount":5,"thoughtsTokenCount":2}')
    expect(withUsage[0]).toContain('"content":{"role":"model","parts":[]},"finishReason":"STOP"')
    const noUsage = feed(t, { type: 'message_delta', delta: { stop_reason: 'end_turn' } })
    expect(noUsage.length).toBe(1)
    expect(noUsage[0]).toContain('"usageMetadata":{"trafficType":"PROVISIONED_THROUGHPUT"},"modelVersion"')
  })

  it('chunks before message_start carry the empty id/model defaults', () => {
    const t = translator()
    const chunks = feed(t, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } })
    expect(chunks[0]).toContain('"modelVersion":""')
    expect(chunks[0]).toContain('"responseId":""')
  })

  it('in-stream error events render the fixed 400 INVALID_ARGUMENT chunk', () => {
    expect(inStreamErrorChunk({ type: 'error', error: { type: 'overloaded_error', message: 'boom' } })).toBe(
      '{"error":{"code":400,"message":"boom","status":"INVALID_ARGUMENT"}}',
    )
    expect(inStreamErrorChunk({ type: 'error', error: {} })).toBe(
      '{"error":{"code":400,"message":"Unknown error occurred","status":"INVALID_ARGUMENT"}}',
    )
  })

  it('formatRfc3339Seconds has second precision and a numeric zone offset', () => {
    const date = new Date(Date.UTC(2026, 8, 15, 9, 4, 6, 512))
    const formatted = formatRfc3339Seconds(date.getTime())
    const pad = (value: number): string => String(value).padStart(2, '0')
    const offset = -date.getTimezoneOffset()
    const sign = offset >= 0 ? '+' : '-'
    const absolute = Math.abs(offset)
    const expected =
      `2026-09-15T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
      `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`
    expect(formatted).toBe(expected)
    expect(formatted).toMatch(/T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/)
    expect(formatted).not.toContain('.')
  })
})

// ---------------------------------------------------------------------------
// Non-stream aggregation and the 502 validator
// ---------------------------------------------------------------------------

describe('non-stream aggregation and validation', () => {
  const ctx = { resolvedModel: 'claude-mock-model', now: () => 1_700_000_000_000 }

  function sse(lines: readonly string[]): string {
    return lines.map((line) => `${line}\n\n`).join('')
  }

  const start = 'data: {"type":"message_start","message":{"id":"i","model":"m"}}'
  const delta = (text: string) => `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":${JSON.stringify(text)}}}`
  const stop = 'data: {"type":"message_stop"}'

  it('consolidates consecutive text and thought parts; last signature wins', () => {
    const merged = consolidateParts([
      { text: 'a' },
      { text: 'b' },
      { thought: true, text: 't1' },
      { thought: true, thoughtSignature: 's1' },
      { thought: true, thoughtSignature: 's2' },
      { functionCall: { name: 'f', args: {} } },
      { text: 'c' },
    ])
    expect(merged).toEqual([
      { text: 'ab' },
      { thought: true, text: 't1', thoughtSignature: 's2' },
      { functionCall: { name: 'f', args: {} } },
      { text: 'c' },
    ])
  })

  it('the validator family fires per line before the post-loop gates', () => {
    const errorEvent = (payload: unknown) => `data: ${JSON.stringify(payload)}`
    expect(validateClaudeAggregatedStream('data: {not json}\n\n')).toEqual({
      ok: false,
      message: 'claude executor: upstream returned malformed stream data',
    })
    expect(validateClaudeAggregatedStream('data: \n\ndata: [DONE]\n\n')).toEqual({
      ok: false,
      message: 'claude executor: upstream returned empty stream response',
    })
    expect(validateClaudeAggregatedStream(sse(['data: {"type":"ping"}']))).toEqual({
      ok: false,
      message: 'claude executor: upstream stream response is missing message_start',
    })
    expect(validateClaudeAggregatedStream(sse([start]))).toEqual({
      ok: false,
      message: 'claude executor: upstream stream response ended before message completion',
    })
    expect(validateClaudeAggregatedStream(sse(['data: {"type":"message_start","message":{"id":"","model":"m"}}', 'data: {"type":"message_delta"}']))).toEqual({
      ok: false,
      message: 'claude executor: upstream stream message_start is missing id or model',
    })
    for (const [error, expected] of [
      [{ type: 'error', error: { type: 'api_error', message: 'boom' } }, 'claude executor: upstream returned error event: boom'],
      [{ type: 'error', error: { type: 'api_error' } }, 'claude executor: upstream returned error event: api_error'],
      [{ type: 'error', error: {} }, 'claude executor: upstream returned error event: unknown upstream error'],
    ] as const) {
      const result = validateClaudeAggregatedStream(sse([start, errorEvent(error)]))
      expect(result).toEqual({ ok: false, message: expected })
    }
    // empty payloads and [DONE] are skipped entirely
    expect(validateClaudeAggregatedStream(sse(['data:', start, 'data: [DONE]', 'data: {"type":"message_delta"}']))).toEqual({ ok: true })
  })

  it('two-tier precedence: the first per-line violation in line order wins', () => {
    const malformed = 'data: {oops}'
    const errorEvent = 'data: {"type":"error","error":{"message":"boom"}}'
    expect(validateClaudeAggregatedStream(sse([start, errorEvent, malformed]))).toEqual({
      ok: false,
      message: 'claude executor: upstream returned error event: boom',
    })
    expect(validateClaudeAggregatedStream(sse([start, malformed, errorEvent]))).toEqual({
      ok: false,
      message: 'claude executor: upstream returned malformed stream data',
    })
  })

  it('aggregates text into one part with the always-STOP finishReason and delta-only usage', () => {
    const result = translateClaudeBufferToGemini(sse([start, delta('Hello'), delta(' there'), 'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":6}}', stop]), ctx)
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.body).toContain('"parts":[{"text":"Hello there"}]},"finishReason":"STOP"')
    expect(result.body).toContain('"usageMetadata":{"promptTokenCount":0,"candidatesTokenCount":6,"totalTokenCount":6,"trafficType":"PROVISIONED_THROUGHPUT"}')
    expect(result.body).toContain('"modelVersion":"claude-mock-model"')
  })

  it('corrupt args append a second root-level usageMetadata instead of replacing', () => {
    const toolStart = 'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t","name":"f"}}'
    const frag = (text: string) => `data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":${JSON.stringify(text)}}}`
    const blockStop = 'data: {"type":"content_block_stop","index":0}'
    const result = translateClaudeBufferToGemini(
      sse([start, toolStart, frag('{"a":'), frag('bad"'), blockStop, 'data: {"type":"message_delta","delta":{},"usage":{"output_tokens":3}}']),
      ctx,
    )
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.body).toContain('"parts":[{"functionCall":{"name":"f","args":{"a":bad"},"id":"t"}')
    expect(result.body).toContain('"finishReason":"STOP"}],"usageMetadata":{"trafficType":"PROVISIONED_THROUGHPUT"}')
    expect(result.body.endsWith(',"responseId":"i","usageMetadata":{"promptTokenCount":0,"candidatesTokenCount":3,"totalTokenCount":3,"trafficType":"PROVISIONED_THROUGHPUT"}}')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// countTokens (R-TOK)
// ---------------------------------------------------------------------------

describe('countTokens', () => {
  it('the seven validator strings are byte-exact', () => {
    expect(validateClaudeTokenCountRequest('{nope')).toEqual({ ok: false, message: 'invalid Claude token count request JSON' })
    expect(validateClaudeTokenCountRequest('[1]')).toEqual({ ok: false, message: 'Claude token count request must be a JSON object' })
    expect(validateClaudeTokenCountRequest('{}')).toEqual({
      ok: false,
      message: 'Claude token count request messages must be a non-empty array',
    })
    expect(validateClaudeTokenCountRequest('{"messages":[]}')).toEqual({
      ok: false,
      message: 'Claude token count request messages must be a non-empty array',
    })
    expect(validateClaudeTokenCountRequest('{"messages":["x"]}')).toEqual({
      ok: false,
      message: 'Claude token count request messages must contain objects',
    })
    expect(validateClaudeTokenCountRequest('{"messages":[{}]}')).toEqual({
      ok: false,
      message: 'Claude token count request message role must be user or assistant',
    })
    expect(validateClaudeTokenCountRequest('{"messages":[{"role":"user"}]}')).toEqual({
      ok: false,
      message: 'Claude token count request message content must be a string or array',
    })
    expect(validateClaudeTokenCountRequest('{"messages":[{"role":"user","content":["x"]}]}')).toEqual({
      ok: false,
      message: 'Claude token count request content blocks must be typed objects',
    })
    expect(validateClaudeTokenCountRequest('{"messages":[{"role":"user","content":[{"type":"text","text":"a"}]}]}')).toEqual({ ok: true, request: expect.anything() })
  })

  it('the recorded oracle count: ["user","Say hello"] joined counts to 4 (S2d7-12)', () => {
    const assembly = assembleClaudeContent('{"contents": [{"role": "user", "parts": [{"text": "Say hello"}]}]}')
    expect(claudeInputSegments(assembly)).toEqual(['user', 'Say hello'])
    expect(estimateClaudeInputTokens(assembly)).toBe(4)
    expect(serializeTokenCountRequest(assembly)).toBe(
      '{"messages":[{"role":"user","content":[{"type":"text","text":"Say hello"}]}]}',
    )
  })

  it('segments include tool fields, tool names and tool_choice', () => {
    const assembly = assembleClaudeContent(
      JSON.stringify({
        contents: [
          { role: 'model', parts: [{ functionCall: { name: 'f', args: { x: 1 } } }] },
          { role: 'user', parts: [{ functionResponse: { name: 'f', response: { result: 'ok' } } }] },
        ],
        tools: [{ functionDeclarations: [{ name: 'f' }] }],
        toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
      }),
    )
    const segments = claudeInputSegments(assembly)
    expect(segments).toEqual(['assistant', 'toolu_gemini_0000000000000001', 'f', '{"x":1}', 'user', 'toolu_gemini_0000000000000001', 'ok', 'f', '{"type":"auto"}'])
    expect(estimateClaudeInputTokens(assembly)).toBeGreaterThan(4)
  })
})

// ---------------------------------------------------------------------------
// Errors and cooldown
// ---------------------------------------------------------------------------

describe('error classification and cooldown', () => {
  const CLAUDE_429_BODY = '{"type": "error", "error": {"type": "rate_limit_error", "message": "mock rate limit"}}'

  it('valid-JSON upstream bodies pass through verbatim; others wrap with the status kept', () => {
    const verbatim = classifyClaudeUpstreamError(429, CLAUDE_429_BODY)
    expect(verbatim.kind).toBe('verbatim')
    const wrapped = classifyClaudeUpstreamError(500, 'mock internal failure')
    expect(wrapped.kind).toBe('wrapped')
    if (wrapped.kind === 'wrapped') {
      expect(wrapped.message).toBe('mock internal failure')
      expect(wrapped.type).toBe('server_error')
      expect(wrapped.code).toBe('internal_server_error')
    }
    const empty = classifyClaudeUpstreamError(503, '   ')
    expect(empty.kind).toBe('wrapped')
    if (empty.kind === 'wrapped') expect(empty.message).toBe('Service Unavailable')
  })

  it('the 502/500/empty-stream envelopes carry the pinned key order', () => {
    expect(renderValidationFailure('claude executor: upstream returned empty stream response')).toEqual({
      status: 502,
      body: '{"error":{"message":"claude executor: upstream returned empty stream response","type":"server_error","code":"internal_server_error"}}',
    })
    expect(renderUnexpectedEofFailure()).toEqual({
      status: 500,
      body: '{"error":{"message":"unexpected EOF","type":"server_error","code":"internal_server_error"}}',
    })
    const gate = renderEmptyStreamFailure()
    expect(gate.status).toBe(500)
    expect(gate.retryable).toBe(true)
    expect(gate.body).toBe(
      '{"error":{"message":"empty_stream: upstream stream closed before first payload","type":"server_error","code":"internal_server_error"}}',
    )
    expect(formatTerminalErrorFrame('unexpected EOF')).toBe(
      'event: error\ndata: {"error":{"message":"unexpected EOF","type":"server_error","code":"internal_server_error"}}\n\n',
    )
  })

  it('rate-limit reset parsing and the flat 1s ladder', () => {
    expect(parseClaudeRateLimitReset({})).toBeUndefined()
    expect(parseClaudeRateLimitReset({ 'Retry-After': '9' })).toBe(9)
    expect(parseClaudeRateLimitReset({ 'Retry-After': '1e3', 'Anthropic-Ratelimit-Unified-Reset': '30' })).toBe(30)
    expect(parseClaudeRateLimitResetWithFuzz({}, () => 0.99)).toBe(1)
    expect(parseClaudeRateLimitResetWithFuzz({ 'Retry-After': '1' }, () => 0)).toBe(2)
    expect(parseClaudeRateLimitResetWithFuzz({ 'Retry-After': '1' }, () => 0.999)).toBe(31)
  })
})

// ---------------------------------------------------------------------------
// Upstream header policy
// ---------------------------------------------------------------------------

describe('upstream header policy', () => {
  it('forwards the allowlist, fills defaults, drops everything else', () => {
    const headers = buildClaudeUpstreamHeaders({
      clientHeaders: {
        Accept: '*/*',
        'x-goog-api-key': 'gateway-key',
        'X-Mock-Mode': 'happy',
        'X-Not-Forwarded': 'no',
        'x-stainless-retry-count': '2',
        'anthropic-custom': 'yes',
      },
      apiKey: KEY,
      baseUrl: BASE,
      gatewayVersion: 'v7.3.4',
    })
    expect(headers['Accept']).toBe('*/*')
    expect(headers['Accept-Encoding']).toBe('identity')
    expect(headers['User-Agent']).toBe('CLIProxyAPI/v7.3.4')
    expect(headers['Anthropic-Version']).toBe('2023-06-01')
    expect(headers['Authorization']).toBe(`Bearer ${KEY}`)
    expect(headers['x-goog-api-key']).toBeUndefined()
    expect(headers['X-Mock-Mode']).toBeUndefined()
    expect(headers['X-Not-Forwarded']).toBeUndefined()
    expect(headers['x-stainless-retry-count']).toBe('2')
    expect(headers['anthropic-custom']).toBe('yes')
    expect(headers['Anthropic-Beta']).toBeUndefined()
  })

  it('case-variant twins fold into one canonical key', () => {
    const headers = buildClaudeUpstreamHeaders({
      clientHeaders: { accept: 'application/json', 'anthropic-version': '2023-01-01', 'anthropic-beta': 'b1, b2' },
      apiKey: KEY,
      baseUrl: BASE,
    })
    const lowered = Object.keys(headers).map((name) => name.toLowerCase())
    expect(new Set(lowered).size).toBe(lowered.length)
    expect(headers['Accept']).toBe('application/json')
    expect(headers['Anthropic-Version']).toBe('2023-01-01')
    expect(headers['Anthropic-Beta']).toBe('b1,b2')
  })

  it('Anthropic bases switch to x-api-key and skip the streaming defaults', () => {
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

  it('emission order: Host, User-Agent, Content-Length, then the rest ASCII-sorted', () => {
    const headers = buildClaudeUpstreamHeaders({ clientHeaders: { Accept: '*/*' }, apiKey: KEY, baseUrl: 'http://h:1' })
    const ordered = orderUpstreamHeaders(headers, 'http://h:1', 'abc')
    expect(ordered.map(([name]) => name)).toEqual([
      'Host',
      'User-Agent',
      'Content-Length',
      'Accept',
      'Accept-Encoding',
      'Anthropic-Version',
      'Authorization',
      'Content-Type',
    ])
    expect(ordered[2]?.[1]).toBe('3')
  })
})

// ---------------------------------------------------------------------------
// SSE decoder
// ---------------------------------------------------------------------------

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

  it('data lines without a space are kept verbatim; unterminated tails deliver', async () => {
    expect((await decode(['data:x\n\n']))[0]?.data).toBe('x')
    expect((await decode(['data: {"a":1}\n\ndata: tail']))[1]?.data).toBe('tail')
  })
})

// ---------------------------------------------------------------------------
// Service facade
// ---------------------------------------------------------------------------

const CREDENTIAL: Gem2ClaCredential = { apiKey: KEY, baseUrl: BASE, models: [{ name: UPSTREAM, alias: 'cm' }] }

function serviceRequest(path: string, body: unknown, headers: Record<string, string> = {}): Gem2ClaRequest {
  return {
    method: 'POST',
    path,
    headers: Object.entries(headers).map(([name, value]) => [name, value]),
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }
}

function byteStream(chunks: readonly Uint8Array[], abortAfter?: number): ReadableStream<Uint8Array> {
  let served = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const index = served
      served += 1
      if (abortAfter !== undefined && index >= abortAfter) {
        controller.error(new Error('reset'))
        return
      }
      const chunk = chunks[index]
      if (chunk === undefined) controller.close()
      else controller.enqueue(chunk)
    },
  })
}

function happyStream(): ReadableStream<Uint8Array> {
  const events = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"i","model":"m"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
  ]
  return byteStream(events.map((event) => encoder.encode(event)))
}

async function readBody(response: Gem2ClaResponse): Promise<string> {
  if (typeof response.body === 'string') return response.body
  const reader = (response.body as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  let out = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    out += decoder.decode(value, { stream: true })
  }
  return out + decoder.decode()
}

describe('service facade', () => {
  function makeService(overrides: Partial<Parameters<typeof createGem2ClaService>[0]> = {}) {
    return createGem2ClaService({
      apiKeys: ['gateway-key'],
      credentials: [CREDENTIAL],
      gatewayVersion: 'v7.3.4',
      store: new MemoryStore(),
      now: () => 1_000_000,
      requestRetry: 0,
      transientErrorCooldownSeconds: -1,
      ...overrides,
    })
  }

  it('the gateway-key gate: missing key 401, wrong key 401, no upstream call', async () => {
    const service = makeService()
    let calls = 0
    const send: Gem2ClaUpstreamSender = async () => {
      calls += 1
      throw new Error('must not be called')
    }
    const missing = await service.handleV1beta(
      serviceRequest('/v1beta/models/cm:generateContent', { contents: [] }, {}),
      send,
    )
    expect(missing.status).toBe(401)
    expect(missing.body).toBe('{"error":"Missing API key"}')
    expect(missing.headers).toContainEqual(['Content-Type', 'application/json; charset=utf-8'])
    const wrong = await service.handleV1beta(
      serviceRequest('/v1beta/models/cm:generateContent', { contents: [] }, { 'x-goog-api-key': 'nope' }),
      send,
    )
    expect(wrong.status).toBe(401)
    expect(wrong.body).toBe('{"error":"Invalid API key"}')
    const bearer = await service.handleV1beta(
      serviceRequest('/v1beta/models/cm:generateContent', { contents: [] }, { Authorization: 'Bearer gateway-key' }),
      async () => ({ status: 200, headers: [], body: happyStream() }),
    )
    expect(bearer.status).toBe(200)
    expect(calls).toBe(0)
  })

  it('unroutable paths render 404 with an empty body (R-404 style)', async () => {
    const service = makeService()
    const response = await service.handleV1beta(serviceRequest('/v1beta/models', {}), async () => {
      throw new Error('must not be called')
    })
    expect(response.status).toBe(404)
    expect(response.body).toBe('')
  })

  it('unknown models fail with the model_not_found envelope and no upstream call', async () => {
    const service = makeService()
    const response = await service.handleV1beta(
      serviceRequest('/v1beta/models/claude-mock-model:generateContent', { contents: [] }, { 'x-goog-api-key': 'gateway-key' }),
      async () => {
        throw new Error('must not be called')
      },
    )
    expect(response.status).toBe(400)
    expect(response.body).toBe(
      '{"error":{"message":"unknown provider for model claude-mock-model","type":"invalid_request_error","code":"model_not_found","param":"model"}}',
    )
  })

  it('malformed bodies are rejected before any upstream call (NE-LENIENT)', async () => {
    const service = makeService()
    const response = await service.handleV1beta(
      serviceRequest('/v1beta/models/cm:generateContent', '{"contents": [', { 'x-goog-api-key': 'gateway-key' }),
      async () => {
        throw new Error('must not be called')
      },
    )
    expect(response.status).toBe(400)
    expect(response.body).toBe(
      '{"error":{"message":"Invalid request: malformed JSON body","type":"invalid_request_error"}}',
    )
  })

  it('countTokens answers locally: malformed -> string 1, non-object -> string 2, empty messages -> string 3', async () => {
    const service = makeService()
    const auth = { 'x-goog-api-key': 'gateway-key' }
    const malformed = await service.handleV1beta(
      serviceRequest('/v1beta/models/cm:countTokens', '{"contents": [', auth),
      async () => {
        throw new Error('must not be called')
      },
    )
    expect(malformed.status).toBe(400)
    expect(malformed.body).toBe(
      '{"error":{"message":"invalid Claude token count request JSON","type":"invalid_request_error"}}',
    )
    const nonObject = await service.handleV1beta(serviceRequest('/v1beta/models/cm:countTokens', '[1,2]', auth), async () => {
      throw new Error('must not be called')
    })
    expect(nonObject.body).toBe(
      '{"error":{"message":"Claude token count request must be a JSON object","type":"invalid_request_error"}}',
    )
    const empty = await service.handleV1beta(
      serviceRequest('/v1beta/models/cm:countTokens', { contents: [{ role: 'system', parts: [{ text: 'x' }] }] }, auth),
      async () => {
        throw new Error('must not be called')
      },
    )
    expect(empty.status).toBe(400)
    expect(empty.body).toBe(
      '{"error":{"message":"Claude token count request messages must be a non-empty array","type":"invalid_request_error"}}',
    )
    const ok = await service.handleV1beta(
      serviceRequest('/v1beta/models/cm:countTokens', { contents: [{ role: 'user', parts: [{ text: 'Say hello' }] }] }, auth),
      async () => {
        throw new Error('must not be called')
      },
    )
    expect(ok.status).toBe(200)
    expect(ok.body).toBe('{"totalTokens":4,"promptTokensDetails":[{"modality":"TEXT","tokenCount":4}]}')
  })

  it('a chunk-less 2xx stream trips the pre-commit empty_stream gate (500, retryable)', async () => {
    const service = makeService()
    const response = await service.handleV1beta(
      serviceRequest('/v1beta/models/cm:streamGenerateContent?alt=sse', { contents: [] }, { 'x-goog-api-key': 'gateway-key' }),
      async () => ({ status: 200, headers: [], body: byteStream([]) }),
    )
    expect(response.status).toBe(500)
    expect(response.body).toBe(
      '{"error":{"message":"empty_stream: upstream stream closed before first payload","type":"server_error","code":"internal_server_error"}}',
    )
  })

  it('transport failures before the first chunk render the 500 unexpected-EOF envelope', async () => {
    const service = makeService()
    const response = await service.handleV1beta(
      serviceRequest('/v1beta/models/cm:generateContent', { contents: [] }, { 'x-goog-api-key': 'gateway-key' }),
      async () => {
        throw new Error('connect refused')
      },
    )
    expect(response.status).toBe(500)
    expect(response.body).toBe(
      '{"error":{"message":"unexpected EOF","type":"server_error","code":"internal_server_error"}}',
    )
  })

  it('mid-stream disconnects append the terminal event:error frame and stay 200', async () => {
    const service = makeService()
    const response = await service.handleV1beta(
      serviceRequest('/v1beta/models/cm:streamGenerateContent', { contents: [] }, { 'x-goog-api-key': 'gateway-key' }),
      async () => ({
        status: 200,
        headers: [],
        body: byteStream(
          [
            encoder.encode('event: message_start\ndata: {"type":"message_start","message":{"id":"i","model":"m"}}\n\n'),
            encoder.encode('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"a"}}\n\n'),
          ],
          2,
        ),
      }),
    )
    expect(response.status).toBe(200)
    expect(response.headers).toEqual([
      ['Content-Type', 'text/event-stream'],
      ['Cache-Control', 'no-cache'],
    ])
    const body = await readBody(response)
    expect(body.endsWith('event: error\ndata: {"error":{"message":"unexpected EOF","type":"server_error","code":"internal_server_error"}}\n\n')).toBe(true)
    expect(body).toContain('data: {"candidates":')
  })

  it('alt=json responses concatenate raw chunks with no framing and a text/plain content type', async () => {
    const service = makeService()
    const response = await service.handleV1beta(
      serviceRequest('/v1beta/models/cm:streamGenerateContent?alt=json', { contents: [] }, { 'x-goog-api-key': 'gateway-key' }),
      async () => ({ status: 200, headers: [], body: happyStream() }),
    )
    expect(response.status).toBe(200)
    expect(response.headers).toEqual([['Content-Type', 'text/plain; charset=utf-8']])
    const body = await readBody(response)
    expect(body).not.toContain('data: ')
    expect(body.startsWith('{"candidates":')).toBe(true)
    expect(body).not.toContain('\n\n')
  })

  it('upstream 429 passes through verbatim, starts the cooldown, and gates the next request', async () => {
    const store = new MemoryStore()
    const service = makeService({ store, now: () => 1_000_000 })
    const upstream429 = (): Gem2ClaUpstreamResponse => ({
      status: 429,
      headers: [['Content-Type', 'application/json']],
      body: byteStream([encoder.encode('{"type": "error", "error": {"type": "rate_limit_error", "message": "mock rate limit"}}')]),
    })
    const first = await service.handleV1beta(
      serviceRequest('/v1beta/models/cm:generateContent', { contents: [] }, { 'x-goog-api-key': 'gateway-key' }),
      async () => upstream429(),
    )
    expect(first.status).toBe(429)
    expect(first.body).toBe('{"type": "error", "error": {"type": "rate_limit_error", "message": "mock rate limit"}}')
    const gated = await service.handleV1beta(
      serviceRequest('/v1beta/models/cm:streamGenerateContent?alt=sse', { contents: [] }, { 'x-goog-api-key': 'gateway-key' }),
      async () => {
        throw new Error('a gated request must not reach the upstream')
      },
    )
    expect(gated.status).toBe(429)
    expect(gated.headers).toContainEqual(['Retry-After', '1'])
    expect(gated.body).toBe(
      '{"error":{"code":"model_cooldown","last_upstream_error":"{\\"type\\": \\"error\\", \\"error\\": {\\"type\\": \\"rate_limit_error\\", \\"message\\": \\"mock rate limit\\"}}","message":"All credentials for model cm are cooling down via provider claude (last error: {\\"type\\": \\"error\\", \\"error\\": {\\"type\\": \\"rate_limit_error\\", \\"message\\": \\"mock rate limit\\"}})","model":"cm","provider":"claude","reset_seconds":1,"reset_time":"1s"}}',
    )
    // after the window passes the credential serves again
    const later = makeService({ store, now: () => 1_000_000 + 2000 })
    const ok = await later.handleV1beta(
      serviceRequest('/v1beta/models/cm:generateContent', { contents: [] }, { 'x-goog-api-key': 'gateway-key' }),
      async () => ({ status: 200, headers: [], body: happyStream() }),
    )
    expect(ok.status).toBe(200)
  })

  it('a Store failure during the cooldown write does not lose the verbatim 429', async () => {
    const store = new MemoryStore()
    store.update = async () => {
      throw new Error('cooldown store down')
    }
    const service = makeService({ store })
    const reported: unknown[] = []
    const originalReport = globalThis.reportError
    globalThis.reportError = (error: unknown) => {
      reported.push(error)
    }
    try {
      const response = await service.handleV1beta(
        serviceRequest('/v1beta/models/cm:generateContent', { contents: [] }, { 'x-goog-api-key': 'gateway-key' }),
        async () => ({
          status: 429,
          headers: [],
          body: byteStream([encoder.encode('{"type":"error","error":{"message":"rate"}}')]),
        }),
      )
      expect(response.status).toBe(429)
      expect(response.body).toBe('{"type":"error","error":{"message":"rate"}}')
      expect(reported.length).toBe(1)
      expect((reported[0] as Error).message).toBe('cooldown store down')
    } finally {
      globalThis.reportError = originalReport
    }
  })

  it('concurrent 429s never shorten a longer cooldown window', async () => {
    // Deterministic grace draws: the fuzz adds exactly 1s to the parsed reset.
    const originalRandom = Math.random
    Math.random = () => 0
    const store = new MemoryStore()
    const service = makeService({ store, now: () => 1_000_000 })
    try {
      let calls = 0
      let arrivals = 0
      let release: () => void = () => {}
      const bothArrived = new Promise<void>((resolve) => {
        release = resolve
      })
      const send: Gem2ClaUpstreamSender = async () => {
        calls += 1
        arrivals += 1
        const longWindow = calls === 1
        if (arrivals === 2) release()
        await bothArrived
        return {
          status: 429,
          headers: longWindow ? [['Retry-After', '30']] : [],
          body: byteStream([encoder.encode('{"e":1}')]),
        }
      }
      const [first, second] = await Promise.all([
        service.handleV1beta(
          serviceRequest('/v1beta/models/cm:generateContent', { contents: [] }, { 'x-goog-api-key': 'gateway-key' }),
          send,
        ),
        service.handleV1beta(
          serviceRequest('/v1beta/models/cm:generateContent', { contents: [] }, { 'x-goog-api-key': 'gateway-key' }),
          send,
        ),
      ])
      expect(first.status).toBe(429)
      expect(second.status).toBe(429)
      const gated = await service.handleV1beta(
        serviceRequest('/v1beta/models/cm:generateContent', { contents: [] }, { 'x-goog-api-key': 'gateway-key' }),
        async () => {
          throw new Error('a gated request must not reach the upstream')
        },
      )
      expect(gated.headers).toContainEqual(['Retry-After', '31'])
      expect(gated.body).toContain('"reset_seconds":31')
    } finally {
      Math.random = originalRandom
    }
  })

  it('the stream bootstrap returns the first frame and a working rest stream', async () => {
    const source = (async function* () {
      yield 'data: {"type":"message_start","message":{"id":"i","model":"m"}}\n\n'
      yield 'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"x"}}\n\n'
      yield 'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"y"}}\n\n'
    })()
    const bootstrap = await bootstrapGeminiStream(source, { resolvedModel: 'm', now: () => 0 })
    expect(bootstrap.kind).toBe('live')
    if (bootstrap.kind !== 'live') return
    expect(bootstrap.firstFrame.kind).toBe('chunk')
    const rest: string[] = []
    for await (const frame of bootstrap.rest) rest.push(frame.kind === 'chunk' ? frame.payload : 'terminal')
    expect(rest.length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Strict boundary
// ---------------------------------------------------------------------------

describe('strict request boundary (NE-LENIENT)', () => {
  it('malformed and non-object bodies are rejected with invalid-input', async () => {
    await expect(translateGeminiToClaude('{"contents": [', CTX)).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(translateGeminiToClaude('[1,2,3]', CTX)).rejects.toBeInstanceOf(CpaError)
    await expect(translateGeminiToClaude('null', CTX)).rejects.toBeInstanceOf(CpaError)
    await expect(translateGeminiToClaude('""', CTX)).rejects.toBeInstanceOf(CpaError)
  })
})
