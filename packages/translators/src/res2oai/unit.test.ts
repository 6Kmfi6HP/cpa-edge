/**
 * Targeted unit tests for the res2oai direction (S2d6): the request
 * whitelist/append rules, the input state machine corners, tool
 * translation + name restoration, the non-stream echo quirks, the usage
 * orders of both paths, the stream state machine edges, the error
 * catalog, and the facade slices the goldens do not pin (401/404/400
 * family, cooldown window + 500 shape, request-retry, Store-failure
 * isolation, pre-commit failures).
 */
import { describe, expect, it, vi } from 'vitest'
import { MemoryStore } from '@cpa-edge/core'
import {
  CUSTOM_TOOL_PARAMETERS,
  chatToolCallEntry,
  customToolArguments,
  qualifyToolName,
  resolveCallName,
  serializeChatTools,
  translateToolChoice,
  translateToolDeclarations,
} from './tools'
import { REASONING_UNAVAILABLE, translateReasoningEffort, translateResponseFormat, translateResponsesToChat } from './request'
import { translateCompactPassthrough } from './compact'
import { ensureResponsesUsageDetails, translateChatToResponses } from './response'
import { ChatToResponsesStreamTranslator, classifyStreamError } from './stream'
import {
  buildCompactStreamRejectedEnvelope,
  buildMalformedBodyEnvelope,
  buildModelCooldownResponse,
  buildModelNotFoundEnvelope,
  classifyUpstreamError,
  closeErrorText,
  formatTerminalErrorFrame,
  isCodexClient,
  normalizeErrorStatus,
  renderUpstreamFailure,
  sanitizeInitialStreamError,
  statusStreamFailure,
  streamErrorTypeForStatus,
  upstreamStreamFailure,
} from './errors'
import { orderUpstreamHeaders, buildUpstreamHeaders } from './headers'
import { createRes2OaiService, withStreamOptions } from './service'
import type { Res2OaiRequest, Res2OaiResponse, Res2OaiUpstreamRequest, Res2OaiUpstreamResponse, Res2OaiUpstreamSender } from './service'
import { translateChatSseToResponsesFrames } from './stream'
import type { ChatToResponsesStreamContext } from './types'

const encoder = new TextEncoder()
const FROZEN = 1_789_504_600_000

function chatBody(body: string, model = 'mock-gpt-model'): string {
  return translateResponsesToChat(body, { upstreamModel: model }).body
}

function streamEvents(script: readonly (string | { readonly event?: string; readonly data: string })[]): string[] {
  return script.map((entry) => {
    if (typeof entry === 'string') return entry
    return `event: ${entry.event ?? 'x'}\ndata: ${entry.data}\n\n`
  })
}

async function collectFrames(
  script: readonly string[],
  ctx: ChatToResponsesStreamContext,
  failureEvent: 'error' | 'response.failed' = 'error',
): Promise<string> {
  let out = ''
  for await (const frame of translateChatSseToResponsesFrames(script.map((chunk) => encoder.encode(chunk)), {
    ctx,
    failureEvent,
  })) {
    out += frame.kind === 'event' ? `event: ${frame.event}\ndata: ${frame.data}\n\n` : frame.kind === 'error-frame' ? frame.text : '\n'
  }
  return out
}

function streamContext(overrides: Partial<ChatToResponsesStreamContext> = {}): ChatToResponsesStreamContext {
  return {
    requestedModel: 'mock-model',
    resolvedModel: 'mock-gpt-model',
    tools: [],
    originalBody: '{"model":"mock-model","input":"hi","stream":true}',
    ...overrides,
  }
}

function chunk(delta: Record<string, unknown>, finish: string | null = null, index = 0): string {
  return JSON.stringify({
    id: 'chatcmpl-x',
    object: 'chat.completion.chunk',
    created: 1770000000,
    model: 'mock-gpt-model',
    choices: [{ index, delta, finish_reason: finish }],
  })
}

function usageChunk(): string {
  return JSON.stringify({
    id: 'chatcmpl-x',
    object: 'chat.completion.chunk',
    created: 1770000000,
    model: 'mock-gpt-model',
    choices: [],
    usage: { prompt_tokens: 9, completion_tokens: 6, total_tokens: 15 },
  })
}

// ---------------------------------------------------------------------------
// R1: request translation
// ---------------------------------------------------------------------------

describe('S2d6 request translation (§3.1)', () => {
  it('keeps the template order: model, messages, stream, then produced fields', () => {
    const body = chatBody(
      '{"model":"m","instructions":"sys","input":"hi","max_output_tokens":10,"tools":[{"type":"function","name":"t","description":"d","parameters":{"type":"object"}}],"tool_choice":"auto","reasoning":{"effort":"HIGH"},"temperature":1}',
    )
    expect(body).toBe(
      '{"model":"mock-gpt-model","messages":[{"role":"system","content":"sys"},{"role":"user","content":"hi"}],"stream":false,"max_tokens":10,' +
        '"tools":[{"function":{"description":"d","name":"t","parameters":{"type":"object"}},"type":"function"}],' +
        '"tool_choice":"auto","reasoning_effort":"high"}',
    )
  })

  it('drops temperature/top_p/user/store/metadata and unknown fields (whitelist)', () => {
    const parsed = JSON.parse(chatBody('{"model":"m","input":"hi","temperature":0.7,"top_p":0.9,"user":"u","store":false,"weird":1}')) as Record<string, unknown>
    for (const key of ['temperature', 'top_p', 'user', 'store', 'weird']) {
      expect(Object.hasOwn(parsed, key), `whitelist drop: ${key}`).toBe(false)
    }
  })

  it('rewrites non-string instructions to their raw JSON text', () => {
    const body = chatBody('{"model":"m","instructions":{"a":1},"input":"hi"}')
    expect(body).toContain('"content":"{\\"a\\":1}"')
  })

  it('lowercases and trims reasoning.effort; empty effort drops the field', () => {
    expect(translateReasoningEffort({ effort: ' Medium ' })).toBe('medium')
    expect(translateReasoningEffort({ effort: '  ' })).toBeUndefined()
    expect(translateReasoningEffort({ effort: 5 })).toBeUndefined()
    expect(translateReasoningEffort(undefined)).toBeUndefined()
  })

  it('maps text.format to response_format with the pinned json_schema field order', () => {
    const body = '{"model":"m","input":"hi","text":{"format":{"type":"json_schema","json_schema":{"strict":true,"schema":{"type":"object"},"name":"s","description":"d"}}}}'
    const out = chatBody(body)
    expect(out).toContain(
      '"response_format":{"type":"json_schema","json_schema":{"name":"s","description":"d","strict":true,"schema":{"type":"object"}}}',
    )
  })

  it('omits response_format for unknown format types and absent text', () => {
    expect(chatBody('{"model":"m","input":"hi","text":{"format":{"type":"weird"}}}')).not.toContain('response_format')
    expect(chatBody('{"model":"m","input":"hi","text":{"format":"json"}}')).not.toContain('response_format')
    expect(translateResponseFormat({}, '')).toBeUndefined()
  })

  it('copies max_output_tokens only for finite numbers', () => {
    expect(chatBody('{"model":"m","input":"hi","max_output_tokens":"128"}')).not.toContain('max_tokens')
    expect(chatBody('{"model":"m","input":"hi","max_output_tokens":128}')).toContain('"max_tokens":128')
  })

  it('maps input_image details: originals become high, unknown detail drops, input_file drops', () => {
    const body = chatBody(
      '{"model":"m","input":[{"type":"message","role":"user","content":[{"type":"input_image","image_url":"https://a","detail":"original"},{"type":"input_image","image_url":"https://b","detail":"auto"},{"type":"input_image","image_url":"https://c","detail":"weird"},{"type":"input_image","image_url":"https://d"},{"type":"input_file","file_id":"f"},{"type":"input_text","text":"hi"}]}]}',
    )
    expect(body).toContain('{"type":"image_url","image_url":{"url":"https://a","detail":"high"}}')
    expect(body).toContain('{"type":"image_url","image_url":{"url":"https://b","detail":"auto"}}')
    expect(body).toContain('{"type":"image_url","image_url":{"url":"https://c"}}')
    expect(body).toContain('{"type":"image_url","image_url":{"url":"https://d"}}')
    expect(body).not.toContain('file_id')
  })

  it('maps developer role to user and string content stays a string', () => {
    const parsed = JSON.parse(
      chatBody(
        '{"model":"m","input":[{"type":"message","role":"developer","content":[{"type":"input_text","text":"dev"}]},{"type":"message","role":"user","content":"plain"}]}',
      ),
    ) as { messages: Array<{ role: string; content: unknown }> }
    expect(parsed.messages[0]).toEqual({ role: 'user', content: [{ type: 'text', text: 'dev' }] })
    expect(parsed.messages[1]).toEqual({ role: 'user', content: 'plain' })
  })

  it('emits empty content arrays for absent content and keeps part order', () => {
    const parsed = JSON.parse(
      chatBody('{"model":"m","input":[{"type":"message","role":"user"}]}'),
    ) as { messages: Array<{ content: unknown }> }
    expect(parsed.messages[0]?.content).toEqual([])
  })
})

describe('S2d6 input state machine (§3.1.1)', () => {
  it('buffers consecutive function_calls into ONE assistant message (sorted keys)', () => {
    const body = chatBody(
      '{"model":"m","input":[{"type":"message","role":"user","content":"go"},{"type":"function_call","call_id":"c1","name":"a","arguments":"{}"},{"type":"function_call","call_id":"c2","name":"b","arguments":"[]"}]}',
    )
    const parsed = JSON.parse(body) as { messages: unknown[] }
    expect(parsed.messages[1]).toEqual({
      role: 'assistant',
      tool_calls: [
        { function: { arguments: '{}', name: 'a' }, id: 'c1', type: 'function' },
        { function: { arguments: '[]', name: 'b' }, id: 'c2', type: 'function' },
      ],
    })
  })

  it('wraps custom_tool_call inputs as single-field arguments and flattens custom outputs', () => {
    const body = chatBody(
      '{"model":"m","input":[{"type":"message","role":"user","content":"go"},{"type":"custom_tool_call","call_id":"c1","name":"p","input":"x\\ny"},{"type":"custom_tool_call_output","call_id":"c1","output":"done"}]}',
    )
    expect(body).toContain(customToolArguments('x\ny'))
    expect(body).toContain('{"role":"tool","tool_call_id":"c1","content":"done"}')
  })

  it('qualifies namespace function_calls and pairs id-less outputs with calls by name', () => {
    const body = chatBody(
      '{"model":"m","input":[{"type":"message","role":"user","content":"go"},{"type":"function_call","call_id":"c1","name":"read","namespace":"fs","arguments":"{}"},{"type":"function_call_output","name":"read","output":"ok"}]}',
    )
    expect(body).toContain('"name":"fs__read"')
    expect(body).toContain('{"role":"tool","tool_call_id":"c1","content":"ok"}')
  })

  it('routes orphan outputs to user messages and drops empty ones', () => {
    const body = chatBody(
      '{"model":"m","input":[{"type":"message","role":"user","content":"go"},{"type":"function_call_output","call_id":"zzz","output":"note"},{"type":"function_call_output","call_id":"yyy","output":""}]}',
    )
    expect(body).toContain('{"role":"user","content":"note"}')
    expect(body).not.toContain('yyy')
  })

  it('stringifies non-image JSON array outputs as their raw text, image arrays as parts', () => {
    const body = chatBody(
      '{"model":"m","input":[{"type":"message","role":"user","content":"go"},{"type":"function_call","call_id":"c1","name":"a","arguments":"{}"},' +
        '{"type":"function_call_output","call_id":"c1","output":"[\\"just text\\"]"},' +
        '{"type":"function_call","call_id":"c2","name":"a","arguments":"{}"},' +
        '{"type":"function_call_output","call_id":"c2","output":[{"type":"input_image","image_url":"https://img"}]}]}',
    )
    expect(body).toContain('"content":"[\\"just text\\"]"')
    expect(body).toContain('"content":[{"type":"image_url","image_url":{"url":"https://img"}}]')
  })

  it('buffers reasoning summaries onto the next assistant message; empty becomes the placeholder', () => {
    const body = chatBody(
      '{"model":"m","input":[{"type":"reasoning","summary":[{"type":"summary_text","text":"think"}]},{"type":"message","role":"assistant","content":[{"type":"output_text","text":"answer"}]}]}',
    )
    expect(body).toContain('"reasoning_content":"think"')
    const trailing = chatBody(
      '{"model":"m","input":[{"type":"message","role":"user","content":"go"},{"type":"reasoning","summary":[]},{"type":"message","role":"user","content":"again"}]}',
    )
    expect(trailing).toContain(
      `{"role":"assistant","content":"","reasoning_content":"${REASONING_UNAVAILABLE}"}`,
    )
  })

  it('defers messages that arrive while tool outputs are awaited', () => {
    const body = chatBody(
      '{"model":"m","input":[{"type":"message","role":"user","content":"go"},{"type":"function_call","call_id":"c1","name":"a","arguments":"{}"},' +
        '{"type":"message","role":"user","content":"early"},{"type":"function_call_output","call_id":"c1","output":"ok"}]}',
    )
    const parsed = JSON.parse(body) as { messages: Array<{ role: string; content?: unknown; tool_calls?: unknown }> }
    expect(parsed.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'user'])
    expect(parsed.messages[3]?.content).toBe('early')
  })

  it('merges a tool-call flush into the preceding plain assistant message', () => {
    const body = chatBody(
      '{"model":"m","input":[{"type":"message","role":"user","content":"go"},{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hm"}]},{"type":"function_call","call_id":"c1","name":"a","arguments":"{}"}]}',
    )
    const parsed = JSON.parse(body) as { messages: Array<Record<string, unknown>> }
    expect(parsed.messages.length).toBe(2)
    expect(parsed.messages[1]?.['tool_calls']).toEqual([
      { function: { arguments: '{}', name: 'a' }, id: 'c1', type: 'function' },
    ])
  })

  it('drops unknown item types and additional_tools items from messages', () => {
    const body = chatBody(
      '{"model":"m","input":[{"type":"message","role":"user","content":"go"},{"type":"web_search_call","id":"ws"},{"type":"additional_tools","tools":[{"type":"function","name":"t2"}]}]}',
    )
    const parsed = JSON.parse(body) as { messages: unknown[]; tools: unknown[] }
    expect(parsed.messages.length).toBe(1)
    expect(parsed.tools).toEqual([
      { function: { description: '', name: 't2', parameters: {} }, type: 'function' },
    ])
  })
})

describe('S2d6 tools translation (§3.1.2)', () => {
  it('dedups by chat name (first wins), keeps declaration order', () => {
    const { chatTools, declared } = translateToolDeclarations([
      { record: { type: 'function', name: 'a', parameters: { type: 'object' } }, namespace: undefined },
      { record: { type: 'function', name: 'a', description: 'second' }, namespace: undefined },
      { record: { type: 'function', name: 'b' }, namespace: undefined },
    ])
    expect(chatTools.map((tool) => (tool as { function: { name: string } }).function.name)).toEqual(['a', 'b'])
    expect(declared[0]?.chatName).toBe('a')
    expect(serializeChatTools(chatTools)).toContain('"description":"second"')
    expect(serializeChatTools(chatTools)).not.toContain('"description":""')
  })

  it('qualifies namespace children unless already prefixed', () => {
    expect(qualifyToolName('fs', 'read')).toBe('fs__read')
    expect(qualifyToolName('fs__', 'read')).toBe('fs__read')
    const { chatTools } = translateToolDeclarations([
      {
        record: { type: 'namespace', name: 'fs', tools: [{ type: 'function', name: 'read' }, { type: 'function', name: 'mcp__x' }, { type: 'function', name: 'fs__y' }] },
        namespace: undefined,
      },
    ])
    expect(chatTools.map((tool) => (tool as { function: { name: string } }).function.name)).toEqual(['fs__read', 'mcp__x', 'fs__y'])
  })

  it('gives custom tools the fixed input schema', () => {
    const { chatTools, declared } = translateToolDeclarations([
      { record: { type: 'custom', name: 'p', description: 'd' }, namespace: undefined },
    ])
    expect(chatTools[0]).toEqual({ type: 'function', function: { name: 'p', description: 'd', parameters: CUSTOM_TOOL_PARAMETERS } })
    expect(declared[0]?.custom).toBe(true)
  })

  it('maps tool_choice objects to the chat shape and canonicalizes names', () => {
    const declared = [
      { chatName: 'get_weather', originalName: 'get_weather', custom: false },
      { chatName: 'fs__read', originalName: 'read', namespace: 'fs', custom: false },
    ]
    expect(translateToolChoice({ type: 'function', name: 'get_weather' }, declared)).toEqual({
      type: 'function',
      function: { name: 'get_weather' },
    })
    expect(translateToolChoice({ type: 'custom', name: 'read' }, declared)).toEqual({
      type: 'function',
      function: { name: 'fs__read' },
    })
    expect(translateToolChoice({ type: 'function', name: 'read', namespace: 'fs' }, declared)).toEqual({
      type: 'function',
      function: { name: 'fs__read' },
    })
    expect(translateToolChoice('auto', declared)).toBe('auto')
    expect(translateToolChoice('required', declared)).toBe('required')
    expect(translateToolChoice({ type: 'weird', x: 1 }, declared)).toEqual({ type: 'weird', x: 1 })
  })

  it('restores call names: flat wins over namespace, ambiguity stays as-is', () => {
    const flatAndNamespaced = [
      { chatName: 'get', originalName: 'get', custom: false },
      { chatName: 'fs__get', originalName: 'get', namespace: 'fs', custom: false },
    ]
    expect(resolveCallName('get', flatAndNamespaced)).toEqual({ name: 'get', namespace: undefined, custom: false })
    expect(resolveCallName('fs__get', flatAndNamespaced)).toEqual({ name: 'get', namespace: 'fs', custom: false })
    const ambiguous = [
      { chatName: 'a__get', originalName: 'get', namespace: 'a', custom: false },
      { chatName: 'b__get', originalName: 'get', namespace: 'b', custom: false },
    ]
    expect(resolveCallName('get', ambiguous)).toEqual({ name: 'get', namespace: undefined, custom: false })
    expect(resolveCallName('unknown', [])).toEqual({ name: 'unknown', namespace: undefined, custom: false })
  })

  it('serializes buffered tool-call entries with sorted keys', () => {
    expect(JSON.stringify(chatToolCallEntry('c1', 'n', '{}'))).toBe('{"id":"c1","type":"function","function":{"name":"n","arguments":"{}"}}')
  })
})

// ---------------------------------------------------------------------------
// R1: compact passthrough
// ---------------------------------------------------------------------------

describe('S2d6 compact passthrough (§2.4)', () => {
  it('rewrites the model value and deletes the stream key in place', () => {
    const body = '{"model":"mock-model","instructions":"s","input":[1,2],"stream":false}'
    expect(translateCompactPassthrough(body, 'mock-gpt-model')).toBe(
      '{"model":"mock-gpt-model","instructions":"s","input":[1,2]}',
    )
  })

  it('deletes a leading or middle stream member cleanly', () => {
    expect(translateCompactPassthrough('{"stream":false,"model":"a"}', 'b')).toBe('{"model":"b"}')
    expect(translateCompactPassthrough('{"model":"a","stream":true,"x":1}', 'b')).toBe('{"model":"b","x":1}')
    expect(translateCompactPassthrough('{"stream":false}', 'b')).toBe('{}')
  })

  it('preserves spacing and unknown members byte-for-byte', () => {
    const body = '{ "model" : "a" ,  "weird" : [ 1.5, true ] }'
    expect(translateCompactPassthrough(body, 'b')).toBe('{ "model" : "b" ,  "weird" : [ 1.5, true ] }')
  })
})

// ---------------------------------------------------------------------------
// R3: non-stream response translation + usage orders
// ---------------------------------------------------------------------------

describe('S2d6 non-stream response translation (§3.3)', () => {
  const ctx = {
    resolvedModel: 'mock-gpt-model',
    tools: [],
    chatTools: [],
    toolChoice: undefined,
    maxTokens: undefined,
    now: () => FROZEN,
  }

  const upstream = JSON.stringify({
    id: 'chatcmpl-1',
    object: 'chat.completion',
    created: 1770000000,
    model: 'mock-gpt-model',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'hello', reasoning_content: 'why' },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 9, completion_tokens: 6, total_tokens: 15 },
  })

  it('builds the template order with the reasoning item first and the upstream-model echo', () => {
    const body = translateChatToResponses(upstream, ctx)
    expect(body).toBe(
      '{"id":"chatcmpl-1","object":"response","created_at":1770000000,"status":"completed","background":false,"error":null,"incomplete_details":null,"model":"mock-gpt-model",' +
        '"output":[{"id":"rs_chatcmpl-1","type":"reasoning","encrypted_content":"","summary":[{"type":"summary_text","text":"why"}]},' +
        '{"id":"msg_chatcmpl-1_0","type":"message","status":"completed","content":[{"type":"output_text","annotations":[],"logprobs":[],"text":"hello"}],"role":"assistant"}],' +
        '"usage":{"input_tokens":9,"output_tokens":6,"total_tokens":15,"output_tokens_details":{"reasoning_tokens":0},"input_tokens_details":{"cached_tokens":0}}}',
    )
  })

  it('synthesizes the id and falls back to server time when created is 0', () => {
    const body = translateChatToResponses('{"choices":[{"index":0,"message":{"role":"assistant","content":"x"},"finish_reason":"stop"}]}', ctx)
    expect(body).toContain(`"id":"resp_${FROZEN.toString(16)}_0"`)
    expect(body).toContain(`"created_at":${Math.floor(FROZEN / 1000)}`)
  })

  it('maps content_filter to the content_filter incomplete reason', () => {
    const body = translateChatToResponses(
      JSON.stringify({ id: 'r', created: 5, choices: [{ index: 0, message: { role: 'assistant', content: 'x' }, finish_reason: 'content_filter' }] }),
      ctx,
    )
    expect(body).toContain('"status":"incomplete","background":false,"error":null,"incomplete_details":{"reason":"content_filter"}')
  })

  it('stringifies non-string message content and synthesizes missing call ids', () => {
    const body = translateChatToResponses(
      JSON.stringify({
        id: 'r',
        created: 5,
        choices: [{ index: 0, message: { role: 'assistant', content: { a: 1 }, tool_calls: [{ function: { name: 't', arguments: '{}' } }] }, finish_reason: 'tool_calls' }],
      }),
      ctx,
    )
    expect(body).toContain('"text":"{\\"a\\":1}"')
    expect(body).toContain('"id":"fc_call_r_0_0","type":"function_call","status":"completed","arguments":"{}","call_id":"call_r_0_0","name":"t"')
  })

  it('emits custom_tool_call items with the unwrapped input for declared custom tools', () => {
    const body = translateChatToResponses(
      JSON.stringify({
        id: 'r',
        created: 5,
        choices: [{ index: 0, message: { role: 'assistant', content: '', tool_calls: [{ id: 'c9', type: 'function', function: { name: 'p', arguments: '{"input":"raw"}' } }] }, finish_reason: 'tool_calls' }],
      }),
      { ...ctx, tools: [{ chatName: 'p', originalName: 'p', custom: true }], chatTools: [] },
    )
    expect(body).toContain('"id":"ctc_c9","type":"custom_tool_call","status":"completed","input":"raw","call_id":"c9","name":"p"')
  })

  it('restores namespaces on reply calls (flat names win)', () => {
    const declared = [
      { chatName: 'get', originalName: 'get', custom: false },
      { chatName: 'fs__read', originalName: 'read', namespace: 'fs', custom: false },
    ]
    const body = translateChatToResponses(
      JSON.stringify({
        id: 'r',
        created: 5,
        choices: [{ index: 0, message: { role: 'assistant', tool_calls: [{ id: 'a', function: { name: 'fs__read', arguments: '{}' } }, { id: 'b', function: { name: 'get', arguments: '{}' } }] }, finish_reason: 'tool_calls' }],
      }),
      { ...ctx, tools: declared, chatTools: [] },
    )
    expect(body).toContain('"call_id":"a","name":"read","namespace":"fs"')
    expect(body).toContain('"call_id":"b","name":"get"')
    expect(body).not.toContain('"namespace":"fs","x"')
  })

  it('keeps inline detail positions when the upstream reports them (§3.3 + §8-4)', () => {
    const body = translateChatToResponses(
      JSON.stringify({
        id: 'r',
        created: 5,
        choices: [{ index: 0, message: { role: 'assistant', content: 'x' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 9, completion_tokens: 6, total_tokens: 15, prompt_tokens_details: { cached_tokens: 2 }, output_tokens_details: { reasoning_tokens: 4 } },
      }),
      ctx,
    )
    expect(body).toContain('"usage":{"input_tokens":9,"input_tokens_details":{"cached_tokens":2},"output_tokens":6,"output_tokens_details":{"reasoning_tokens":4},"total_tokens":15}')
  })

  it('appends only input_tokens_details when reasoning was reported inline', () => {
    const body = translateChatToResponses(
      JSON.stringify({
        id: 'r',
        created: 5,
        choices: [{ index: 0, message: { role: 'assistant', content: 'x' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, output_tokens_details: { reasoning_tokens: 4 } },
      }),
      ctx,
    )
    expect(body).toContain('"usage":{"input_tokens":1,"output_tokens":1,"output_tokens_details":{"reasoning_tokens":4},"total_tokens":2,"input_tokens_details":{"cached_tokens":0}}')
  })

  it('copies a usage object with no base fields verbatim, then ensures details', () => {
    const body = translateChatToResponses(
      JSON.stringify({ id: 'r', created: 5, choices: [{ index: 0, message: { role: 'assistant', content: 'x' }, finish_reason: 'stop' }], usage: { custom: 'v' } }),
      ctx,
    )
    expect(body).toContain('"usage":{"custom":"v","output_tokens_details":{"reasoning_tokens":0},"input_tokens_details":{"cached_tokens":0}}')
  })

  it('parses upstream bodies leniently (invalid JSON yields a synthesized response)', () => {
    const body = translateChatToResponses('not json', ctx)
    expect(body).toContain('"status":"completed"')
    expect(body).toContain('"output":[]')
  })
})

describe('S2d6 EnsureResponsesUsageDetails (§2.4/§3.3/§3.5)', () => {
  it('appends both detail objects after total in the pinned order', () => {
    expect(ensureResponsesUsageDetails('{"id":1,"usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3}}')).toBe(
      '{"id":1,"usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3,"output_tokens_details":{"reasoning_tokens":0},"input_tokens_details":{"cached_tokens":0}}}',
    )
  })

  it('adds inner keys to present detail objects and leaves complete ones alone', () => {
    expect(ensureResponsesUsageDetails('{"usage":{"output_tokens_details":{},"input_tokens_details":{"cached_tokens":1}}}')).toBe(
      '{"usage":{"output_tokens_details":{"reasoning_tokens":0},"input_tokens_details":{"cached_tokens":1}}}',
    )
    const done = '{"usage":{"input_tokens_details":{"cached_tokens":1},"output_tokens_details":{"reasoning_tokens":2}}}'
    expect(ensureResponsesUsageDetails(done)).toBe(done)
  })

  it('finds usage under response, exempts compaction payloads, skips invalid JSON', () => {
    expect(ensureResponsesUsageDetails('{"response":{"usage":{"total_tokens":1}}}')).toBe(
      '{"response":{"usage":{"total_tokens":1,"output_tokens_details":{"reasoning_tokens":0},"input_tokens_details":{"cached_tokens":0}}}}',
    )
    expect(ensureResponsesUsageDetails('{"object":"response.compaction","usage":{}}')).toBe('{"object":"response.compaction","usage":{}}')
    expect(ensureResponsesUsageDetails('nope')).toBe('nope')
    expect(ensureResponsesUsageDetails('{"usage":"not an object"}')).toBe('{"usage":"not an object"}')
  })
})
