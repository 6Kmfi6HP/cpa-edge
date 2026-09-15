/**
 * Targeted unit tests for the cla2oai direction (S2d4).
 *
 * The golden suite replays every recorded case byte-exactly; these
 * units pin the unrecorded edges the spec derives from code evidence:
 * the tool-result content ladder, reminder buffering positions, the
 * emission gate, the tool_choice ladder, schema normalization and
 * re-serialization, the two-stage thinking table including its 400s,
 * the stream state machine corners (buffered tool arguments, belated
 * starts, interleaved text, error payloads, empty upstream), the error
 * extraction ladder, the upstream-error summarizer mechanism, and the
 * facade gates (auth transports, 404s, alias-only resolution, DD-model
 * decode, cooldown windows and hints).
 */
import { describe, expect, it, vi } from 'vitest'
import { MemoryStore } from '@cpa-edge/core'
import {
  applyRequestThinking,
  convertBudgetToLevel,
  effectiveThinkingLevel,
} from './thinking'
import {
  buildMessages,
  buildToolChoice,
  buildTools,
  translateClaudeToOpenAI,
} from './request'
import {
  argumentsAreValidObject,
  buildToolNameIndex,
  fixJson,
  normalizeObjectSchemaProperties,
  restoreToolName,
  sanitizeClaudeToolId,
  serializeToolParameters,
  usesUnsupportedPropertyEscape,
} from './schema'
import {
  captureFinishReason,
  extractOpenAIUsage,
  mapFinishReasonToStopReason,
  translateOpenAIResponseToClaude,
} from './response'
import {
  OpenAIToClaudeStreamTranslator,
  StreamFailureError,
  bootstrapCla2OaiStream,
  decodeUpstreamSseFrames,
  translateOpenAIToClaudeFrames,
} from './stream'
import {
  buildClaudeErrorEnvelope,
  claudeErrorTypeForStatus,
  extractClaudeError,
  openAICompatProviderKey,
  summarizeUpstreamError,
} from './errors'
import { countTranslatedBodyTokens, estimateClaudeInputTokens } from './tokens'
import { createCla2OaiService } from './service'
import type {
  Cla2OaiRequest,
  Cla2OaiResponse,
  Cla2OaiUpstreamRequest,
  Cla2OaiUpstreamResponse,
  Cla2OaiUpstreamSender,
} from './service'
import { decodeCloakedModelId } from './types'

const encoder = new TextEncoder()

function requestOf(body: string, options: { readonly path?: string; readonly method?: string; readonly headers?: ReadonlyArray<readonly [string, string]> } = {}): Cla2OaiRequest {
  return {
    method: options.method ?? 'POST',
    path: options.path ?? '/v1/messages',
    headers: options.headers ?? [['Authorization', 'Bearer oracle-local-key-1']],
    body,
  }
}

function serviceOf(options: { readonly store?: MemoryStore; readonly now?: () => number; readonly credentials?: unknown } = {}) {
  return createCla2OaiService({
    apiKeys: ['oracle-local-key-1'],
    credentials: (options.credentials as never) ?? [
      {
        name: 'mock-openai',
        apiKey: 'mock-upstream-key',
        baseUrl: 'http://upstream.test/v1',
        models: [{ name: 'mock-gpt-model', alias: 'mock-model' }],
      },
    ],
    store: options.store ?? new MemoryStore(),
    now: options.now ?? (() => 1_789_506_604_000),
    requestRetry: 0,
  })
}

function jsonReply(body: string, status = 200): Cla2OaiUpstreamResponse {
  return {
    status,
    headers: [['Content-Type', 'application/json']],
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(body))
        controller.close()
      },
    }),
  }
}

function sseReply(frames: readonly string[]): Cla2OaiUpstreamResponse {
  return {
    status: 200,
    headers: [['Content-Type', 'text/event-stream']],
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame))
        controller.close()
      },
    }),
  }
}

async function readBody(response: Cla2OaiResponse): Promise<string> {
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

function headerOf(response: Cla2OaiResponse, name: string): string | undefined {
  const key = name.toLowerCase()
  for (const [headerName, value] of response.headers) {
    if (headerName.toLowerCase() === key) return value
  }
  return undefined
}

/** Parses a translated body for structural assertions. */
function parseMessages(body: string): Array<Record<string, unknown>> {
  return (JSON.parse(body) as { messages: Array<Record<string, unknown>> }).messages
}

// ---------------------------------------------------------------------------
// Request translation
// ---------------------------------------------------------------------------

describe('cla2oai request translation', () => {
  const ctx = { upstreamModel: 'mock-gpt-model', stream: false }

  it('keeps the string system form as a one-part text array', () => {
    const body = translateClaudeToOpenAI(
      '{"model":"m","system":"Be brief.","messages":[{"role":"user","content":"Hi"}]}',
      ctx,
    ).body
    expect(JSON.parse(body)).toEqual({
      model: 'mock-gpt-model',
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'Be brief.' }] },
        { role: 'user', content: 'Hi' },
      ],
      stream: false,
    })
  })

  it('drops a system block where every part is blank or attribution', () => {
    const raw = JSON.stringify({
      model: 'm',
      system: [
        { type: 'text', text: '   ' },
        { type: 'text', text: 'x-anthropic-billing-header: {\"tier\":\"free\"}' },
        { type: 'image', source: { type: 'url', url: 'https://x.test/i.png' } },
      ],
      messages: [{ role: 'user', content: 'Hi' }],
    })
    const messages = parseMessages(translateClaudeToOpenAI(raw, ctx).body)
    expect(messages).toEqual([{ role: 'user', content: 'Hi' }])
  })

  it('wraps mid-conversation system turns and buffers them behind tool_use ids', () => {
    const raw = JSON.stringify({
      model: 'm',
      messages: [
        { role: 'user', content: 'Q' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'f', input: {} }] },
        { role: 'system', content: [{ type: 'text', text: 'note one' }] },
        { role: 'system', content: 'note two' },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }, { type: 'text', text: 'after' }] },
      ],
    })
    const messages = parseMessages(translateClaudeToOpenAI(raw, ctx).body)
    const texts = messages.map((message) => JSON.stringify(message))
    // Reminder 1 buffered behind the pending tool_use id; the SECOND
    // system turn buffers too (the ids are still pending).
    // Emission order: tool message, then both reminders in FIFO order,
    // then the user content.
    expect(texts).toEqual([
      '{"role":"user","content":"Q"}',
      '{"role":"assistant","content":"","tool_calls":[{"function":{"arguments":"{}","name":"f"},"id":"t1","type":"function"}]}',
      '{"role":"tool","tool_call_id":"t1","content":"ok"}',
      '{"role":"user","content":[{"type":"text","text":"<system-reminder>\\nnote one\\n</system-reminder>"}]}',
      '{"role":"user","content":[{"type":"text","text":"<system-reminder>\\nnote two\\n</system-reminder>"}]}',
      '{"role":"user","content":[{"type":"text","text":"after"}]}',
    ])
  })

  it('emits a reminder immediately when no tool_use ids are pending', () => {
    const raw = JSON.stringify({
      model: 'm',
      messages: [
        { role: 'user', content: 'Q' },
        { role: 'system', content: 'note' },
        { role: 'assistant', content: 'A' },
      ],
    })
    const messages = parseMessages(translateClaudeToOpenAI(raw, ctx).body)
    expect(messages[1]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: '<system-reminder>\nnote\n</system-reminder>' }],
    })
  })

  it('HTML-escapes the reminder wrapper the way the gateway serializer does', () => {
    const raw = JSON.stringify({
      model: 'm',
      messages: [{ role: 'system', content: 'note' }],
    })
    const body = translateClaudeToOpenAI(raw, ctx).body
    expect(body).toContain('\\u003csystem-reminder\\u003e')
    expect(body).toContain('\\u003c/system-reminder\\u003e')
  })

  it('drops an assistant turn where nothing survives the emission gate', () => {
    const raw = JSON.stringify({
      model: 'm',
      messages: [
        { role: 'user', content: 'Q' },
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm', signature: '' }] },
        { role: 'user', content: 'R' },
      ],
    })
    const messages = parseMessages(translateClaudeToOpenAI(raw, ctx).body)
    expect(messages).toEqual([
      { role: 'user', content: 'Q' },
      { role: 'user', content: 'R' },
    ])
  })

  it('joins multiple signed thinking blocks into one reasoning_content', () => {
    const raw = JSON.stringify({
      model: 'm',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'first', signature: 'sig-a' },
            { type: 'thinking', thinking: 'second', signature: 'sig-b' },
            { type: 'text', text: 'answer' },
          ],
        },
      ],
    })
    const messages = parseMessages(translateClaudeToOpenAI(raw, ctx).body)
    expect(messages[0]).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'answer' }],
      reasoning_content: 'first\n\nsecond',
    })
  })

  it('keeps unsigned thinking for an is-compat model entry', () => {
    const raw = JSON.stringify({
      model: 'm',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'hmm', signature: '' },
            { type: 'text', text: 'answer' },
          ],
        },
      ],
    })
    const body = translateClaudeToOpenAI(raw, { ...ctx, isCompat: true }).body
    expect(JSON.parse(body).messages).toEqual([
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'answer' }],
        reasoning_content: 'hmm',
      },
    ])
  })

  it('keeps raw spacing of tool_use input bytes inside the arguments string', () => {
    const raw = '{"model":"m","messages":[{"role":"assistant","content":[{"type":"tool_use","id":"c1","name":"f","input":{"a": 1,  "b": [2]}}]}]}'
    const body = translateClaudeToOpenAI(raw, ctx).body
    expect(body).toContain(
      '"arguments":"{\\"a\\": 1,  \\"b\\": [2]}"',
    )
  })

  it('ladders tool_result content: absent, string, joined blocks, raw fallback', () => {
    const raw = JSON.stringify({
      model: 'm',
      messages: [
        { role: 'user', content: 'Q' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'a', name: 'f', input: {} },
            { type: 'tool_use', id: 'b', name: 'f', input: {} },
            { type: 'tool_use', id: 'c', name: 'f', input: {} },
            { type: 'tool_use', id: 'd', name: 'f', input: {} },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'a' },
            { type: 'tool_result', tool_use_id: 'b', content: 'plain text' },
            {
              type: 'tool_result',
              tool_use_id: 'c',
              content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }],
            },
            { type: 'tool_result', tool_use_id: 'd', content: [{ type: 'text', text: ' ' }] },
          ],
        },
      ],
    })
    const messages = parseMessages(translateClaudeToOpenAI(raw, ctx).body)
    const tools = messages.filter((message) => message['role'] === 'tool')
    expect(tools.map((message) => [message['tool_call_id'], message['content']])).toEqual([
      ['a', ''],
      ['b', 'plain text'],
      ['c', 'one\n\ntwo'],
      // Blank-only text array: the RAW JSON of the content member.
      ['d', '[{"type":"text","text":" "}]'],
    ])
  })

  it('renders the placeholder and relay for images-only tool results', () => {
    const raw = JSON.stringify({
      model: 'm',
      messages: [
        { role: 'user', content: 'Q' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'img', name: 'render', input: {} }],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'img',
              content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }],
            },
            { type: 'text', text: 'and this too' },
          ],
        },
      ],
    })
    const messages = parseMessages(translateClaudeToOpenAI(raw, ctx).body)
    expect(messages[2]).toEqual({
      role: 'tool',
      tool_call_id: 'img',
      content: '[Tool returned image content; the images follow in the next user message.]',
    })
    // Single user turn preserved: relay parts prepended to the own content.
    expect(messages[3]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'Images returned by the preceding tool call(s):' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
        { type: 'text', text: 'and this too' },
      ],
    })
  })

  it('falls back to the top-level url and octet-stream for images without derivable URLs', () => {
    const raw = JSON.stringify({
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', data: 'AA==' } },
            { type: 'image', url: 'https://fallback.test/i.png' },
            { type: 'image', source: { type: 'url', url: '' } },
          ],
        },
      ],
    })
    const messages = parseMessages(translateClaudeToOpenAI(raw, ctx).body)
    expect(messages[0]).toEqual({
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: 'data:application/octet-stream;base64,AA==' } },
        { type: 'image_url', image_url: { url: 'https://fallback.test/i.png' } },
      ],
    })
  })

  it('reorders tool_results only on a one-to-one id match', () => {
    const raw = JSON.stringify({
      model: 'm',
      messages: [
        { role: 'user', content: 'Q' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'x1', name: 'f', input: {} },
            { type: 'tool_use', id: 'x2', name: 'f', input: {} },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'x2', content: 'second' },
            { type: 'tool_result', tool_use_id: 'x1', content: 'first' },
          ],
        },
      ],
    })
    const aligned = parseMessages(translateClaudeToOpenAI(raw, ctx).body)
    expect(aligned.filter((m) => m['role'] === 'tool').map((m) => m['tool_call_id'])).toEqual(['x1', 'x2'])

    const partial = JSON.stringify({
      model: 'm',
      messages: [
        { role: 'user', content: 'Q' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'y1', name: 'f', input: {} }, { type: 'tool_use', id: 'y2', name: 'f', input: {} }] },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'y2', content: 'only' },
            { type: 'text', text: 'go on' },
          ],
        },
      ],
    })
    const untouched = parseMessages(translateClaudeToOpenAI(partial, ctx).body)
    expect(untouched.filter((m) => m['role'] === 'tool').map((m) => [m['tool_call_id'], m['content']])).toEqual([
      ['y2', 'only'],
    ])
  })

  it('forwards messages:[] untouched', () => {
    const body = translateClaudeToOpenAI('{"model":"m","messages":[]}', ctx).body
    expect(JSON.parse(body).messages).toEqual([])
  })

  it('maps the tool_choice ladder', () => {
    expect(buildToolChoice({ type: 'auto' })).toBe('auto')
    expect(buildToolChoice({ type: 'any' })).toBe('required')
    expect(buildToolChoice({ type: 'tool', name: 'Get_Weather' })).toEqual({
      type: 'function',
      function: { name: 'Get_Weather' },
    })
    expect(buildToolChoice({ type: 'weird' })).toBe('auto')
    expect(buildToolChoice({})).toBe('auto')
    expect(buildToolChoice('any')).toBe('auto')
    expect(buildToolChoice(undefined)).toBeUndefined()
  })

  it('drops temperature-losers and unknown fields, keeps top-level user strings', () => {
    const raw = JSON.stringify({
      model: 'm',
      max_tokens: 10,
      temperature: 0.3,
      top_p: 0.8,
      top_k: 5,
      stop_sequences: [],
      metadata: { user_id: 'u' },
      user: 'ext-1',
      cache_control: { type: 'ephemeral' },
      unknown_field: 'x',
      messages: [{ role: 'user', content: 'Hi' }],
    })
    const parsed = JSON.parse(translateClaudeToOpenAI(raw, ctx).body)
    expect(Object.keys(parsed)).toEqual(['model', 'messages', 'max_tokens', 'temperature', 'stream', 'user'])
  })

  it('normalizes and re-serializes input_schema with sorted keys and pattern pruning', () => {
    const { entries } = buildTools({
      tools: [
        {
          name: 't',
          description: 'd',
          input_schema: {
            type: 'object',
            properties: {
              city: { type: 'string' },
              code: {
                type: 'string',
                pattern: '\\p{Emoji}',
              },
            },
            patternProperties: {
              '^x_': { type: 'string' },
              '\\p{Unsupported}': { type: 'number' },
            },
          },
        },
        { name: 'bare', input_schema: { type: 'object' } },
      ],
    })
    const rendered = JSON.parse(JSON.stringify(entries[0]))
    expect(Object.keys(rendered.function.parameters)).toEqual([
      'patternProperties',
      'properties',
      'type',
    ])
    expect(Object.keys(rendered.function.parameters.properties)).toEqual(['city', 'code'])
    // The unsupported pattern value and key are gone; the supported ones stay.
    expect(rendered.function.parameters.properties.code).toEqual({ type: 'string' })
    expect(Object.keys(rendered.function.parameters.patternProperties)).toEqual(['^x_'])
    expect(JSON.parse(JSON.stringify(entries[1])).function.parameters).toEqual({
      properties: {},
      type: 'object',
    })
  })

  it('detects unsupported unicode property escapes', () => {
    expect(usesUnsupportedPropertyEscape('\\p{Lu}')).toBe(false)
    expect(usesUnsupportedPropertyEscape('\\p{Latin}')).toBe(false)
    expect(usesUnsupportedPropertyEscape('\\pL')).toBe(false)
    expect(usesUnsupportedPropertyEscape('\\p{Emoji}')).toBe(true)
    expect(usesUnsupportedPropertyEscape('\\pX')).toBe(true)
    expect(usesUnsupportedPropertyEscape('abc')).toBe(false)
  })

  it('fills properties:{} recursively through normalizeObjectSchemaProperties', () => {
    expect(normalizeObjectSchemaProperties({ type: 'object' })).toEqual({ type: 'object', properties: {} })
    expect(
      normalizeObjectSchemaProperties({
        type: 'object',
        properties: { nested: { type: 'object' }, leaf: { type: 'string' } },
      }),
    ).toEqual({
      type: 'object',
      properties: { nested: { type: 'object', properties: {} }, leaf: { type: 'string' } },
    })
  })
})

// ---------------------------------------------------------------------------
// Two-stage thinking
// ---------------------------------------------------------------------------

describe('cla2oai thinking pipeline', () => {
  const capability = { levels: ['low', 'medium', 'high'] as readonly string[] }

  it('maps budgets through the stage-1 ladder', () => {
    expect(convertBudgetToLevel(-1)).toBe('auto')
    expect(convertBudgetToLevel(0)).toBe('none')
    expect(convertBudgetToLevel(1)).toBe('minimal')
    expect(convertBudgetToLevel(512)).toBe('minimal')
    expect(convertBudgetToLevel(513)).toBe('low')
    expect(convertBudgetToLevel(1024)).toBe('low')
    expect(convertBudgetToLevel(1025)).toBe('medium')
    expect(convertBudgetToLevel(8192)).toBe('medium')
    expect(convertBudgetToLevel(8193)).toBe('high')
    expect(convertBudgetToLevel(24576)).toBe('high')
    expect(convertBudgetToLevel(24577)).toBe('xhigh')
    expect(convertBudgetToLevel(-5)).toBeUndefined()
  })

  it('produces the recorded EFFECTIVE table (stage 2)', () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['none', 'low'],
      ['minimal', 'low'],
      ['low', 'low'],
      ['medium', 'medium'],
      ['high', 'high'],
      ['xhigh', 'high'],
      ['max', 'high'],
      ['auto', 'medium'],
    ]
    for (const [level, expected] of cases) {
      expect(effectiveThinkingLevel(level, capability)).toBe(expected)
    }
    expect(() => effectiveThinkingLevel('ultra', capability)).toThrow(
      'level "ultra" not supported, valid levels: low, medium, high',
    )
  })

  it('fails unconvertible budgets with the recorded message before dispatch', () => {
    const body: Record<string, unknown> = { reasoning_effort: '' }
    expect(() => applyRequestThinking(body, { thinking: { type: 'enabled', budget_tokens: -5 } }, capability)).toThrow(
      'budget -5 cannot be converted to a valid level',
    )
  })

  it('leaves the body untouched without a stage-1 effort key', () => {
    const body: Record<string, unknown> = {}
    applyRequestThinking(body, { thinking: { type: 'enabled', budget_tokens: 8192 } }, capability)
    expect(body).toEqual({})
  })

  it('maps the adaptive effort rows including the no-effort clamp', () => {
    const raw = (thinking: unknown, outputConfig?: unknown) =>
      JSON.stringify({ model: 'm', thinking, output_config: outputConfig, messages: [{ role: 'user', content: 'Hi' }] })
    const ctx = { upstreamModel: 'mock-gpt-model', stream: false }
    const effortOf = (text: string) => JSON.parse(translateClaudeToOpenAI(text, ctx).body).reasoning_effort

    const translated1 = translateClaudeToOpenAI(raw({ type: 'adaptive' }, { effort: 'AUTO' }), ctx)
    applyRequestThinking(translated1.value, JSON.parse(raw({ type: 'adaptive' }, { effort: 'AUTO' })), capability)
    expect(effortOf(serialize(translated1.value))).toBe('medium')

    const translated2 = translateClaudeToOpenAI(raw({ type: 'adaptive' }), ctx)
    applyRequestThinking(translated2.value, JSON.parse(raw({ type: 'adaptive' })), capability)
    expect(effortOf(serialize(translated2.value))).toBe('high')

    const translated3 = translateClaudeToOpenAI(raw({ type: 'disabled' }), ctx)
    applyRequestThinking(translated3.value, JSON.parse(raw({ type: 'disabled' })), capability)
    expect(effortOf(serialize(translated3.value))).toBe('low')
  })

  function serialize(value: Record<string, unknown>): string {
    return JSON.stringify(value)
  }
})

// ---------------------------------------------------------------------------
// Response translation
// ---------------------------------------------------------------------------

describe('cla2oai non-stream response translation', () => {
  const toolNames = buildToolNameIndex([{ name: 'Get_Weather' }])

  it('maps the finish-reason ladder and the absent-finish default', () => {
    expect(mapFinishReasonToStopReason('stop')).toBe('end_turn')
    expect(mapFinishReasonToStopReason('length')).toBe('max_tokens')
    expect(mapFinishReasonToStopReason('tool_calls')).toBe('tool_use')
    expect(mapFinishReasonToStopReason('content_filter')).toBe('end_turn')
    expect(mapFinishReasonToStopReason('function_call')).toBe('tool_use')
    expect(mapFinishReasonToStopReason('mystery')).toBe('end_turn')
  })

  it('derives stop_reason tool_use from produced tool blocks when finish_reason is absent', () => {
    const upstream = JSON.stringify({
      id: 'r1',
      model: 'mock-gpt-model',
      choices: [
        { index: 0, message: { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{}' } }] } },
      ],
    })
    const parsed = JSON.parse(translateOpenAIResponseToClaude(upstream, { toolNames }))
    expect(parsed.stop_reason).toBe('tool_use')
    expect(parsed.content).toEqual([
      { type: 'tool_use', id: 'c1', name: 'Get_Weather', input: {} },
    ])
  })

  it('walks array-form content: merged text runs, reasoning before text, tool flushes', () => {
    const upstream = JSON.stringify({
      id: 'r1',
      model: 'mock-gpt-model',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'a' },
              { type: 'text', text: 'b' },
              { type: 'reasoning', text: 'why' },
              { type: 'text', text: 'c' },
              { type: 'unknown_kind', x: 1 },
              { type: 'tool_calls', tool_call: { id: 'c9', function: { name: 'other', arguments: '' } } },
            ],
          },
        },
      ],
    })
    const parsed = JSON.parse(translateOpenAIResponseToClaude(upstream, { toolNames }))
    expect(parsed.content).toEqual([
      { type: 'text', text: 'ab' },
      { type: 'thinking', thinking: 'why' },
      { type: 'text', text: 'c' },
      { type: 'tool_use', id: 'c9', name: 'other', input: {} },
    ])
  })

  it('computes the usage cache math with the clamp and the fallbacks', () => {
    expect(extractOpenAIUsage(undefined)).toEqual({ input_tokens: 0, output_tokens: 0 })
    expect(
      extractOpenAIUsage({ prompt_tokens: 120, completion_tokens: 13, prompt_tokens_details: { cached_tokens: 30, cache_write_tokens: 5 } }),
    ).toEqual({ input_tokens: 90, output_tokens: 13, cache_read_input_tokens: 30, cache_creation_input_tokens: 5 })
    expect(
      extractOpenAIUsage({ prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 30 } }),
    ).toEqual({ input_tokens: 0, output_tokens: 1, cache_read_input_tokens: 30 })
    expect(
      extractOpenAIUsage({ prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: { cache_creation_tokens: 4 } }),
    ).toEqual({ input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 4 })
  })

  it('sanitizes tool ids and restores names case-insensitively', () => {
    expect(sanitizeClaudeToolId('call:rich:1')).toBe('call_rich_1')
    expect(restoreToolName(toolNames, 'GET_WEATHER')).toBe('Get_Weather')
    expect(restoreToolName(toolNames, 'unknown_tool')).toBe('unknown_tool')
  })

  it('repairs single-quoted arguments and rejects non-objects', () => {
    expect(fixJson("{'a': 'b'}")).toBe('{"a": "b"}')
    expect(argumentsAreValidObject('')).toBe(true)
    expect(argumentsAreValidObject('{}')).toBe(true)
    expect(argumentsAreValidObject('{"a":1}')).toBe(true)
    expect(argumentsAreValidObject('[1]')).toBe(false)
    expect(argumentsAreValidObject('not json')).toBe(false)
  })

  it('serializes tool parameters with sorted keys and HTML escaping', () => {
    expect(serializeToolParameters({ type: 'object', properties: { q: { type: 'string', pattern: 'a<b' } } })).toBe(
      '{"properties":{"q":{"pattern":"a\\u003cb","type":"string"}},"type":"object"}',
    )
  })
})

// ---------------------------------------------------------------------------
// Stream state machine
// ---------------------------------------------------------------------------

describe('cla2oai stream state machine', () => {
  const toolNames = buildToolNameIndex([{ name: 'Get_Weather' }])
  const ctx = { inputTokens: 5, toolNames }

  function chunk(delta: Record<string, unknown>, finish?: string): Record<string, unknown> {
    return {
      id: 'chatcmpl-x',
      model: 'mock-gpt-model',
      choices: [{ index: 0, delta, ...(finish !== undefined ? { finish_reason: finish } : {}) }],
    }
  }

  it('joins multiple data lines of one frame with a newline', async () => {
    const frames: Array<{ event?: string; dataLines: readonly string[] }> = []
    for await (const event of decodeUpstreamSseFrames([source('data: {"a":\ndata: 1}\n\n')])) {
      if (event.kind === 'frame') frames.push(event.frame)
    }
    expect(frames).toEqual([{ dataLines: ['{"a":', '1}'] }])
  })

  it('emits no input_json_delta when nothing accumulated', async () => {
    const translator = new OpenAIToClaudeStreamTranslator(ctx)
    const events: string[] = []
    for (const e of translator.processChunk(chunk({ tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '' } }] }))) events.push(e)
    for (const e of translator.processChunk(chunk({}, 'tool_calls'))) events.push(e)
    expect(events.join('')).toContain('"type":"tool_use","id":"c1","name":"Get_Weather","input":{}')
    expect(events.join('')).not.toContain('input_json_delta')
    // start + stop only for the tool block, then the [DONE] pass adds
    // message_delta + message_stop.
    const done = translator.handleDone()
    expect(done.join('')).toContain('"stop_reason":"tool_use"')
  })

  it('synthesizes belated starts with tool_<index> names and buffered text after tool blocks', async () => {
    const translator = new OpenAIToClaudeStreamTranslator(ctx)
    const events: string[] = []
    for (const e of translator.processChunk(chunk({ role: 'assistant' }))) events.push(e)
    // Tool accumulator never gets a name; text arrives while it is open.
    for (const e of translator.processChunk(chunk({ tool_calls: [{ index: 3, id: 'c2', function: { arguments: '{"x":' } }], content: 'interleaved' }))) events.push(e)
    for (const e of translator.processChunk(chunk({}, 'stop'))) events.push(e)
    const all = events.join('')
    expect(all).toContain('"content_block_start","index":1,"content_block":{"type":"tool_use","id":"c2","name":"tool_3","input":{}}')
    expect(all).toContain('"partial_json":"{\\"x\\":')
    // Buffered text flushes after the tool blocks with a fresh index.
    expect(all.indexOf('tool_3')).toBeLessThan(all.indexOf('"type":"text_delta","text":"interleaved"'))
    expect(all).toContain('"content_block_start","index":2,"content_block":{"type":"text","text":""}')
  })

  it('classifies finish reasons per announced tool arguments', () => {
    expect(captureFinishReason('length', ['{"a":1}']).reason).toBe('length')
    expect(captureFinishReason('content_filter', []).reason).toBe('content_filter')
    expect(captureFinishReason('tool_calls', []).reason).toBe('stop')
    expect(captureFinishReason('tool_calls', ['']).reason).toBe('tool_calls')
    expect(captureFinishReason('tool_calls', ['{}']).reason).toBe('tool_calls')
    expect(captureFinishReason('tool_calls', ['{"a":1}']).reason).toBe('tool_calls')
    expect(captureFinishReason('tool_calls', ['[1]']).reason).toBe('length')
    expect(captureFinishReason('weird', []).reason).toBe('weird')
  })

  it('emits message_delta at the chunk carrying finish and usage together', () => {
    const translator = new OpenAIToClaudeStreamTranslator(ctx)
    const events: string[] = []
    for (const e of translator.processChunk(chunk({ role: 'assistant' }))) events.push(e)
    for (const e of translator.processChunk(chunk({ content: 'x' }))) events.push(e)
    const finishEvents = translator.processChunk({
      id: 'chatcmpl-x',
      model: 'mock-gpt-model',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    })
    expect(finishEvents.join('')).toContain('"stop_reason":"end_turn","stop_sequence":null},"usage":{"input_tokens":10,"output_tokens":2}')
    // [DONE] afterwards emits nothing new.
    expect(translator.handleDone()).toEqual([])
  })

  it('fails a pre-commit error payload with the payload status and text', async () => {
    const pipeline = translateOpenAIToClaudeFrames(
      [source('data: {"error":{"message":"boom","code":"x"},"status":429}\n\n')],
      ctx,
    )
    await expect(async () => {
      for await (const _frame of pipeline) {
        void _frame
      }
    }).rejects.toBeInstanceOf(StreamFailureError)
  })

  it('renders malformed frames and bare JSON lines as 502 failures', async () => {
    await expect(async () => {
      for await (const _frame of translateOpenAIToClaudeFrames([source('data: {broken\n\n')], ctx)) {
        void _frame
      }
    }).rejects.toMatchObject({ status: 502 })
    await expect(async () => {
      for await (const _frame of translateOpenAIToClaudeFrames([source('{"bare":1}\n')], ctx)) {
        void _frame
      }
    }).rejects.toMatchObject({ status: 502 })
  })

  it('ends empty when the upstream produced no data frame at all', async () => {
    const bootstrap = await bootstrapCla2OaiStream([source('')], ctx)
    expect(bootstrap.kind).toBe('committed-empty')
  })

  it('renders the terminal error frame after committed events on a transport failure', async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: ' + JSON.stringify(chunk({ role: 'assistant' })) + '\n\n'))
        controller.enqueue(encoder.encode('data: ' + JSON.stringify(chunk({ content: 'hi' })) + '\n\n'))
        controller.error(new Error('reset'))
      },
    })
    const frames: string[] = []
    for await (const frame of translateOpenAIToClaudeFrames(streamToIterable(source), ctx)) {
      frames.push(frame.kind === 'chunk' ? frame.payload : `E:${frame.message}`)
    }
    const all = frames.join('')
    expect(all).toContain('event: message_start')
    expect(all).toContain('"type":"text_delta","text":"hi"')
    expect(all).toContain('event: error\ndata: {"type":"error","error":{"type":"api_error","message":"unexpected EOF"}}')
    expect(all).not.toContain('message_stop')
  })

  function source(text: string): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(text))
        controller.close()
      },
    })
  }

  async function* streamToIterable(stream: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
    const reader = stream.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        if (value !== undefined) yield value
      }
    } finally {
      reader.releaseLock()
    }
  }
})

// ---------------------------------------------------------------------------
// Error semantics
// ---------------------------------------------------------------------------

describe('cla2oai error semantics', () => {
  it('maps statuses to Claude error types', () => {
    expect(claudeErrorTypeForStatus(401)).toBe('authentication_error')
    expect(claudeErrorTypeForStatus(402)).toBe('billing_error')
    expect(claudeErrorTypeForStatus(403)).toBe('permission_error')
    expect(claudeErrorTypeForStatus(404)).toBe('not_found_error')
    expect(claudeErrorTypeForStatus(413)).toBe('request_too_large')
    expect(claudeErrorTypeForStatus(429)).toBe('rate_limit_error')
    expect(claudeErrorTypeForStatus(504)).toBe('timeout_error')
    expect(claudeErrorTypeForStatus(529)).toBe('overloaded_error')
    expect(claudeErrorTypeForStatus(500)).toBe('api_error')
    expect(claudeErrorTypeForStatus(400)).toBe('invalid_request_error')
  })

  it('extracts type and message per the recorded ladder', () => {
    expect(extractClaudeError(429, '{"error":{"message":"m","type":"t","code":"c"}}')).toEqual({ type: 't', message: 'm' })
    expect(extractClaudeError(400, '{"error":{"code":"c","type":"t"}}')).toEqual({ type: 't', message: 'c' })
    expect(extractClaudeError(400, '{"type":"other","message":"m"}')).toEqual({ type: 'other', message: 'm' })
    expect(extractClaudeError(500, 'plain text')).toEqual({ type: 'api_error', message: 'plain text' })
    expect(extractClaudeError(500, '')).toEqual({ type: 'api_error', message: 'Internal Server Error' })
  })

  it('renders the Claude envelope in wire order', () => {
    expect(buildClaudeErrorEnvelope('invalid_request_error', 'x')).toBe(
      '{"type":"error","error":{"type":"invalid_request_error","message":"x"}}',
    )
  })

  it('summarizes upstream errors per the 7.8 cut mechanism', () => {
    // The recorded mock body: the `": {"` cut mangles the spaced JSON, so
    // the sanitized RAW text is embedded verbatim.
    const recorded = '{"error": {"message": "mock rate limit", "type": "rate_limit_exceeded", "code": "rate_limit_exceeded"}}'
    expect(summarizeUpstreamError(recorded)).toBe(recorded)
    // A compact body: no cut fires, the code: message form wins.
    expect(summarizeUpstreamError('{"error":{"message":"m","code":"c"}}')).toBe('c: m')
    expect(summarizeUpstreamError('{"message":"m","code":"c"}')).toBe('c: m')
    expect(summarizeUpstreamError('raw text')).toBe('raw text')
    // Long verbatim bodies truncate at 256 runes.
    expect(summarizeUpstreamError('x'.repeat(300)).length).toBe(256)
  })

  it('namespaces the provider key', () => {
    expect(openAICompatProviderKey('mock-openai')).toBe('openai-compatible-mock-openai')
  })
})

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

describe('cla2oai token estimation', () => {
  it('reproduces the recorded deterministic estimates (3/33/7/6 and 43)', () => {
    const estimate = (body: string) => estimateClaudeInputTokens(JSON.parse(body) as Record<string, unknown>)
    expect(
      estimate('{"model":"mock-model","max_tokens":64,"stream":true,"messages":[{"role":"user","content":"Hi"}]}'),
    ).toBe(3)
    expect(
      estimate('{"model":"mock-model","max_tokens":128,"stream":true,"messages":[{"role":"user","content":"What is the answer?"}]}'),
    ).toBe(7)
    expect(
      estimate('{"model":"mock-model","max_tokens":128,"stream":true,"messages":[{"role":"user","content":"Paris weather now."}]}'),
    ).toBe(6)
    const schema = { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] }
    const tools = [{ name: 'Get_Weather', description: 'Get current weather', input_schema: schema }]
    expect(
      estimate(JSON.stringify({ model: 'mock-model', max_tokens: 256, stream: true, tools, messages: [{ role: 'user', content: 'Weather in Paris?' }] })),
    ).toBe(33)
  })

  it('counts translated bodies for count_tokens with the recorded 43', () => {
    const translated = translateClaudeToOpenAI(
      JSON.stringify({
        model: 'mock-model',
        max_tokens: 256,
        system: 'You are terse.',
        messages: [{ role: 'user', content: 'Hello there, count me.' }],
        tools: [{ name: 'Get_Weather', description: 'Get current weather', input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }],
      }),
      { upstreamModel: 'mock-gpt-model', stream: false },
    )
    expect(countTranslatedBodyTokens(translated.value, translated.body, 'mock-gpt-model')).toBe(43)
  })
})

// ---------------------------------------------------------------------------
// Facade gates
// ---------------------------------------------------------------------------

describe('cla2oai facade', () => {
  it('answers wrong methods and unknown paths with an empty 404', async () => {
    const service = serviceOf()
    const get = await service.handleV1Messages(requestOf('{}', { method: 'GET' }), async () => jsonReply('{}'))
    expect(get.status).toBe(404)
    expect(get.body).toBe('')
    expect(get.headers).toEqual([])
    const unknown = await service.handleV1Messages(requestOf('{}', { path: '/v1/other' }), async () => jsonReply('{}'))
    expect(unknown.status).toBe(404)
  })

  it('runs the five-transport auth gate', async () => {
    const service = serviceOf()
    const missing = await service.handleV1Messages(requestOf('{}', { headers: [] }), async () => jsonReply('{}'))
    expect(missing.status).toBe(401)
    expect(missing.body).toBe('{"error":"Missing API key"}')
    expect(headerOf(missing, 'content-type')).toBe('application/json; charset=utf-8')

    const invalid = await service.handleV1Messages(
      requestOf('{}', { headers: [['Authorization', 'Bearer nope']] }),
      async () => jsonReply('{}'),
    )
    expect(invalid.status).toBe(401)
    expect(invalid.body).toBe('{"error":"Invalid API key"}')

    const transports: ReadonlyArray<readonly [string, Cla2OaiRequest]> = [
      ['bearer', requestOf('{"model":"mock-model","messages":[]}', { headers: [['Authorization', 'Bearer oracle-local-key-1']] })],
      ['x-api-key', requestOf('{"model":"mock-model","messages":[]}', { headers: [['X-Api-Key', 'oracle-local-key-1']] })],
      ['x-goog-api-key', requestOf('{"model":"mock-model","messages":[]}', { headers: [['X-Goog-Api-Key', 'oracle-local-key-1']] })],
      ['query key', requestOf('{"model":"mock-model","messages":[]}', { path: '/v1/messages?key=oracle-local-key-1', headers: [] })],
      ['auth_token', requestOf('{"model":"mock-model","messages":[]}', { path: '/v1/messages?auth_token=oracle-local-key-1', headers: [] })],
    ]
    for (const [name, request] of transports) {
      const response = await service.handleV1Messages(request, async () => jsonReply('{"id":"x","model":"mock-gpt-model","choices":[]}'))
      expect(response.status, name).toBe(200)
    }
  })

  it('routes alias-only and decodes cloaked model ids', async () => {
    const service = serviceOf()
    const upstream = await service.handleV1Messages(
      requestOf('{"model":"mock-gpt-model","messages":[]}'),
      async () => jsonReply('{"id":"x","model":"mock-gpt-model","choices":[]}'),
    )
    expect(upstream.status).toBe(400)
    expect(upstream.body).toBe(
      '{"type":"error","error":{"type":"invalid_request_error","message":"unknown provider for model mock-gpt-model"}}',
    )

    expect(decodeCloakedModelId('claude-fable-5-dd-ledom-kcom')).toBe('mock-model')
    let calls = 0
    const cloaked = await service.handleV1Messages(
      requestOf('{"model":"claude-fable-5-dd-ledom-kcom","messages":[{"role":"user","content":"Hi"}]}'),
      async () => {
        calls += 1
        return jsonReply('{"id":"x","model":"mock-gpt-model","choices":[]}')
      },
    )
    expect(calls).toBe(1)
    expect(cloaked.status).toBe(200)
  })

  it('reads a malformed body as an empty model (unknown-provider 400)', async () => {
    const service = serviceOf()
    const response = await service.handleV1Messages(requestOf('not json'), async () => jsonReply('{}'))
    expect(response.status).toBe(400)
    expect(response.body).toBe('{"type":"error","error":{"type":"invalid_request_error","message":"unknown provider for model"}}')
    const arrayBody = await service.handleV1Messages(requestOf('[1,2]'), async () => jsonReply('{}'))
    expect(arrayBody.status).toBe(400)
  })

  it('gunzips non-stream bodies that start with the gzip magic bytes', async () => {
    const service = serviceOf()
    const compressed = await gzipBytes(encoder.encode('{"id":"gz-1","model":"mock-gpt-model","choices":[{"index":0,"message":{"role":"assistant","content":"from gzip"},"finish_reason":"stop"}]}'))
    const response = await service.handleV1Messages(
      requestOf('{"model":"mock-model","messages":[{"role":"user","content":"Hi"}]}'),
      async () => ({
        status: 200,
        headers: [],
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(compressed)
            controller.close()
          },
        }),
      }),
    )
    expect(response.status).toBe(200)
    expect(JSON.parse(await readBody(response)).content).toEqual([{ type: 'text', text: 'from gzip' }])
  })

  it('renders a pre-commit transport failure as a plain 500 unexpected EOF', async () => {
    const service = serviceOf()
    const response = await service.handleV1Messages(
      requestOf('{"model":"mock-model","stream":true,"messages":[{"role":"user","content":"Hi"}]}'),
      async () => {
        throw new Error('connection refused')
      },
    )
    expect(response.status).toBe(500)
    expect(headerOf(response, 'content-type')).toBe('application/json')
    expect(response.body).toBe(
      '{"type":"error","error":{"type":"api_error","message":"unexpected EOF"}}',
    )
  })

  it('keeps the cooldown window from an upstream Retry-After hint and expires afterwards', async () => {
    let clock = 1_789_506_604_000
    const store = new MemoryStore()
    const service = serviceOf({ store, now: () => clock })
    const request = requestOf('{"model":"mock-model","messages":[{"role":"user","content":"Hi"}]}')
    const limited: Cla2OaiUpstreamSender = async () => ({
      status: 429,
      headers: [['Content-Type', 'application/json'], ['Retry-After', '7']],
      body: bytesOf('{"error":{"message":"limited"}}'),
    })
    const first = await service.handleV1Messages(request, limited)
    expect(first.status).toBe(429)

    clock += 1_000
    let dispatched = 0
    const gated = await service.handleV1Messages(request, async () => {
      dispatched += 1
      return jsonReply('{"id":"x","model":"mock-gpt-model","choices":[]}')
    })
    // Inside the hinted 7s window: cooldown surface, no dispatch.
    expect(gated.status).toBe(429)
    expect(headerOf(gated, 'retry-after')).toBe('7')
    expect(dispatched).toBe(0)
    expect(JSON.parse(gated.body as string).error.message).toContain(
      'All credentials for model mock-model are cooling down via provider openai-compatible-mock-openai (last error: {"error":{"message":"limited"}})',
    )

    clock += 7_000
    const recovered = await service.handleV1Messages(request, async () => {
      dispatched += 1
      return jsonReply('{"id":"x","model":"mock-gpt-model","choices":[]}')
    })
    expect(recovered.status).toBe(200)
    expect(dispatched).toBe(1)
  })

  it('surfaces store failures through reportError without failing the response', async () => {
    let clock = 1_789_506_604_000
    const failingStore = new MemoryStore()
    const spy = vi.spyOn(failingStore, 'update').mockRejectedValue(new Error('store down'))
    const reporter = vi.fn()
    vi.stubGlobal('reportError', reporter)
    const service = serviceOf({ store: failingStore, now: () => clock })
    const request = requestOf('{"model":"mock-model","messages":[{"role":"user","content":"Hi"}]}')
    const first = await service.handleV1Messages(request, async () => ({
      status: 429,
      headers: [],
      body: bytesOf('{"error":{"message":"limited"}}'),
    }))
    // Render-first: the 429 reshape reached the client even though the
    // cooldown write failed.
    expect(first.status).toBe(429)
    expect(JSON.parse(first.body as string).error.message).toBe('limited')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(reporter).toHaveBeenCalled()
    spy.mockRestore()
    vi.unstubAllGlobals()
  })

  function bytesOf(text: string): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(text))
        controller.close()
      },
    })
  }

  async function gzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      },
    }).pipeThrough(new CompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>)
    const reader = stream.getReader()
    const chunks: Uint8Array[] = []
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value !== undefined) chunks.push(value)
    }
    let length = 0
    for (const chunk of chunks) length += chunk.length
    const out = new Uint8Array(length)
    let at = 0
    for (const chunk of chunks) {
      out.set(chunk, at)
      at += chunk.length
    }
    return out
  }
})
