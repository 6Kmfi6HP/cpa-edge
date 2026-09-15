/**
 * Targeted unit tests for the res2oai direction (S2d6): the request
 * whitelist/append rules, the input state machine corners, tool
 * translation + name restoration, the non-stream echo quirks, the usage
 * orders of both paths, the stream state machine edges, the error
 * catalog, and the facade slices the goldens do not pin (401/404/400
 * family, cooldown window + 500 shape, request-retry, Store-failure
 * isolation, pre-commit failures).
 */
import { describe, expect, it } from 'vitest'
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


// ---------------------------------------------------------------------------
// R4: stream translation
// ---------------------------------------------------------------------------

describe('S2d6 stream state machine (§3.4/§4)', () => {
  it('starts on the first choices-carrying chunk (empty choices accepted) and echoes the alias', async () => {
    const out = await collectFrames([`data: ${usageChunk()}\n\n`, 'data: [DONE]\n\n'], streamContext())
    expect(out).toContain(
      '"response":{"id":"chatcmpl-x","object":"response","created_at":1770000000,"status":"in_progress","background":false,"error":null,"output":[],"model":"mock-model"}',
    )
    expect(out).toContain('"output":[],"model":"mock-model"}')
  })

  it('falls back to the resolved model when the alias is empty', async () => {
    const out = await collectFrames([`data: ${chunk({ role: 'assistant' })}\n\n`, 'data: [DONE]\n\n'], streamContext({ requestedModel: '' }))
    expect(out).toContain('"model":"mock-gpt-model"')
  })

  it('drops chunks without a choices array and foreign object types, but still captures usage', async () => {
    const out = await collectFrames(
      [
        `data: ${chunk({ role: 'assistant' })}\n\n`,
        'data: {"id":"x","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant"},"finish_reason":"stop"}]}\n\n',
        'data: {"object":"other"}\n\n',
        `data: ${usageChunk()}\n\n`,
        'data: [DONE]\n\n',
      ],
      streamContext(),
    )
    expect(out).toContain('"sequence_number":5,"response"')
    expect(out).toContain('"usage":{"input_tokens":9,"input_tokens_details":{"cached_tokens":0},"output_tokens":6,"total_tokens":15,"output_tokens_details":{"reasoning_tokens":0}}')
  })

  it('writes reasoning tokens before total when the upstream reports them (§3.5)', async () => {
    const usage = JSON.stringify({
      id: 'chatcmpl-x',
      object: 'chat.completion.chunk',
      created: 1770000000,
      choices: [],
      usage: { prompt_tokens: 9, completion_tokens: 6, total_tokens: 15, output_tokens_details: { reasoning_tokens: 4 } },
    })
    const out = await collectFrames([`data: ${chunk({ role: 'assistant' })}\n\n`, `data: ${chunk({}, 'stop')}\n\n`, `data: ${usage}\n\n`, 'data: [DONE]\n\n'], streamContext())
    expect(out).toContain('"usage":{"input_tokens":9,"input_tokens_details":{"cached_tokens":0},"output_tokens":6,"output_tokens_details":{"reasoning_tokens":4},"total_tokens":15}')
  })

  it('derives total from input+output when the upstream total is 0', async () => {
    const usage = JSON.stringify({
      id: 'chatcmpl-x',
      object: 'chat.completion.chunk',
      created: 1770000000,
      choices: [],
      usage: { prompt_tokens: 9, completion_tokens: 6, total_tokens: 0 },
    })
    const out = await collectFrames([`data: ${chunk({ role: 'assistant' })}\n\n`, `data: ${chunk({}, 'stop')}\n\n`, `data: ${usage}\n\n`, 'data: [DONE]\n\n'], streamContext())
    expect(out).toContain('"total_tokens":15')
  })

  it('emits the reasoning done-set with the pinned key order before the message item', async () => {
    const out = await collectFrames(
      [
        `data: ${chunk({ role: 'assistant' })}\n\n`,
        `data: ${chunk({ reasoning_content: 'P' })}\n\n`,
        `data: ${chunk({ content: 'A' })}\n\n`,
        `data: ${chunk({}, 'stop')}\n\n`,
        'data: [DONE]\n\n',
      ],
      streamContext(),
    )
    expect(out).toContain('"event":"response.output_item.done"' + '\ndata: {"type":"response.output_item.done","item":{"id":"rs_chatcmpl-x_0","type":"reasoning","encrypted_content":"","summary":[{"type":"summary_text","text":"P"}]},"output_index":0,"sequence_number":7}')
    expect(out).toContain('"output_index":1,"item":{"id":"msg_chatcmpl-x_0"')
  })

  it('buffers tool fragments, emits added before deltas, and closes at finish', async () => {
    const out = await collectFrames(
      [
        `data: ${chunk({ tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 't', arguments: '' } }] })}\n\n`,
        `data: ${chunk({ tool_calls: [{ index: 0, function: { arguments: '{"a"' } }] })}\n\n`,
        `data: ${chunk({}, 'tool_calls')}\n\n`,
        'data: [DONE]\n\n',
      ],
      streamContext({ tools: [{ chatName: 't', originalName: 't', custom: false }] }),
    )
    expect(out).toContain('"item":{"id":"fc_c1","type":"function_call","status":"in_progress","arguments":"","call_id":"c1","name":"t"}')
    expect(out).toContain('"delta":"{\\"a\\""')
    expect(out).toContain('"arguments":"{\\"a\\""')
    expect(out).toContain('"item":{"id":"fc_c1","type":"function_call","status":"completed","arguments":"{\\"a\\"","call_id":"c1","name":"t"}')
  })

  it('gives custom tool calls no argument deltas and unwraps input at done', async () => {
    const out = await collectFrames(
      [
        `data: ${chunk({ tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'p', arguments: '{"inp' } }] })}\n\n`,
        `data: ${chunk({ tool_calls: [{ index: 0, function: { arguments: 'ut":"v"}' } }] })}\n\n`,
        `data: ${chunk({}, 'tool_calls')}\n\n`,
        'data: [DONE]\n\n',
      ],
      streamContext({ tools: [{ chatName: 'p', originalName: 'p', custom: true }] }),
    )
    expect(out).not.toContain('function_call_arguments.delta')
    expect(out).toContain('"input":"v"')
    expect(out).toContain('"type":"response.custom_tool_call_input.done"')
  })

  it('drops an open tool with empty or invalid arguments at [DONE] when no finish_reason arrived', async () => {
    const out = await collectFrames(
      [
        `data: ${chunk({ tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 't', arguments: '' } }] })}\n\n`,
        'data: [DONE]\n\n',
      ],
      streamContext({ tools: [{ chatName: 't', originalName: 't', custom: false }] }),
    )
    expect(out).toContain('"event":"response.output_item.added"')
    expect(out).not.toContain('function_call_arguments.done')
    // No message and no completed function item -> terminal suppressed -> CloseError.
    expect(out).toContain('upstream stream closed before a terminal event')
  })

  it('finalizes open items at clean EOF without [DONE] and fails in-stream', async () => {
    const out = await collectFrames(
      [`data: ${chunk({ content: 'A' })}\n\n`, 'data: [DONE_MISSING]\n\n'],
      streamContext(),
    )
    expect(out).toContain('"event":"response.output_item.done"')
    expect(out).toContain('upstream stream closed before [DONE]')
    expect(out).not.toMatch(/\n\n\n$/)
  })

  it('drops [DONE] before any choices chunk: zero frames upstream of the empty-stream gate', async () => {
    const translator = new ChatToResponsesStreamTranslator(streamContext())
    // The pipeline drops the marker; the translator never starts.
    const frames: string[] = []
    let sawFrames = false
    for await (const frame of translateChatSseToResponsesFrames([encoder.encode('data: [DONE]\n\n')], {
      ctx: streamContext(),
      failureEvent: 'error',
    })) {
      sawFrames = true
      void frame
    }
    expect(sawFrames).toBe(false)
    expect(frames).toEqual([])
    expect(translator.isStarted).toBe(false)
  })

  it('keys items per choice index (multi-choice unit pin, §4.2)', async () => {
    const dual = JSON.stringify({
      id: 'chatcmpl-x',
      object: 'chat.completion.chunk',
      created: 1770000000,
      model: 'mock-gpt-model',
      choices: [
        { index: 0, delta: { content: 'A' }, finish_reason: null },
        { index: 1, delta: { content: 'B' }, finish_reason: null },
      ],
    })
    const out = await collectFrames([`data: ${dual}\n\n`, 'data: [DONE]\n\n'], streamContext())
    expect(out).toContain('"item":{"id":"msg_chatcmpl-x_0","type":"message"')
    expect(out).toContain('"item":{"id":"msg_chatcmpl-x_1","type":"message"')
  })

  it('drops events after the terminal event', async () => {
    const out = await collectFrames(
      [
        `data: ${chunk({ role: 'assistant' })}\n\n`,
        `data: ${chunk({}, 'stop')}\n\n`,
        'data: [DONE]\n\n',
        `data: ${chunk({ content: 'LATE' })}\n\n`,
      ],
      streamContext(),
    )
    expect(out).toContain('response.completed')
    expect(out).not.toContain('LATE')
    expect(out.endsWith('\n\n\n')).toBe(true)
  })

  it('echoes original request fields in the terminal event, deep-sorted', async () => {
    const out = await collectFrames(
      [`data: ${chunk({ role: 'assistant' })}\n\n`, `data: ${chunk({}, 'stop')}\n\n`, 'data: [DONE]\n\n'],
      streamContext({
        originalBody:
          '{"model":"mock-model","instructions":"sys","max_output_tokens":32,"reasoning":{"effort":"high"},"tools":[{"type":"function","name":"t","parameters":{"b":1,"a":2}}],"text":{"format":{"type":"text"}},"stream":true}',
      }),
    )
    expect(out).toContain('"max_output_tokens":32,"model":"mock-model","reasoning":{"effort":"high"}')
    expect(out).toContain('"text":{"format":{"type":"text"}},"tools":[{"description":"","name":"t","parameters":{"a":2,"b":1},"type":"function"}]')
    expect(out).not.toContain('"instructions"')
  })

  it('suppresses the terminal event for reasoning-only streams and emits the CloseError frame', async () => {
    const out = await collectFrames(
      [
        `data: ${chunk({ role: 'assistant' })}\n\n`,
        `data: ${chunk({ reasoning_content: 'P' })}\n\n`,
        'data: [DONE]\n\n',
      ],
      streamContext(),
    )
    expect(out).not.toContain('response.completed')
    expect(out).toContain(
      'upstream stream closed before a terminal event (last event: response.output_item.done)","param":null,"type":"server_error"},"sequence_number":8}',
    )
    expect(out).not.toMatch(/\n\n\n$/)
  })
})

describe('S2d6 upstream stream-error classification (§5.2)', () => {
  it('classifies error-family event names and embedded error objects', () => {
    expect(classifyStreamError({ event: 'error', data: '{}' })).toBeDefined()
    expect(classifyStreamError({ event: 'response.failed', data: '{}' })).toBeDefined()
    expect(classifyStreamError({ event: undefined, data: '{"error":{"code":"x","message":"m"}}' })).toBeDefined()
    expect(classifyStreamError({ event: undefined, data: '{"response":{"error":{"message":"m"}}}' })).toBeDefined()
    expect(classifyStreamError({ event: undefined, data: '{"code":"c","message":"m"}' })).toBeDefined()
    expect(classifyStreamError({ event: undefined, data: chunk({ role: 'assistant' }) })).toBeUndefined()
  })

  it('embeds the upstream error object with sorted keys', () => {
    const failure = upstreamStreamFailure({ type: 'rate_limit_error', message: 'm', code: 429 })
    expect(failure.detail).toBe('{"code":429,"message":"m","type":"rate_limit_error"}')
  })

  it('maps statuses onto the in-stream error vocabulary', () => {
    expect(statusStreamFailure('m', 401).detail).toBe('{"code":"invalid_api_key","message":"m","param":null,"type":"invalid_request_error"}')
    expect(statusStreamFailure('m', 403).detail).toContain('insufficient_quota')
    expect(statusStreamFailure('m', 429).detail).toContain('rate_limit_exceeded')
    expect(statusStreamFailure('m', 404).detail).toContain('model_not_found')
    expect(statusStreamFailure('m', 408).detail).toContain('request_timeout')
    expect(statusStreamFailure('m', 455).detail).toContain('"code":"invalid_request_error"')
    expect(statusStreamFailure('m', 502).detail).toBe('{"code":"internal_server_error","message":"m","param":null,"type":"server_error"}')
    expect(streamErrorTypeForStatus(401).code).toBe('invalid_api_key')
  })
})

// ---------------------------------------------------------------------------
// R5: error catalog
// ---------------------------------------------------------------------------

describe('S2d6 error catalog (§5)', () => {
  it('passes valid-JSON upstream error bodies verbatim and wraps the rest', () => {
    expect(classifyUpstreamError(429, '{"error": {"a": 1}}')).toEqual({ kind: 'verbatim', status: 429, body: '{"error": {"a": 1}}' })
    const wrapped = classifyUpstreamError(500, 'boom')
    expect(wrapped.kind).toBe('wrapped')
    if (wrapped.kind === 'wrapped') {
      expect(renderUpstreamFailure(wrapped)).toEqual({
        status: 500,
        body: '{"error":{"message":"boom","type":"server_error","code":"internal_server_error"}}',
      })
    }
    const empty = classifyUpstreamError(418, '')
    if (empty.kind === 'wrapped') {
      expect(renderUpstreamFailure(empty).body).toBe('{"error":{"message":"HTTP 418","type":"invalid_request_error"}}')
    }
  })

  it('sanitizes pre-frame stream errors: sorted keys, redaction, truncation, status normalization', () => {
    expect(sanitizeInitialStreamError('{"error": {"message": "mock rate limit", "type": "rate_limit_exceeded", "code": 429, "status": "RESOURCE_EXHAUSTED"}}')).toBe(
      '{"error":{"code":429,"message":"mock rate limit","status":"RESOURCE_EXHAUSTED","type":"rate_limit_exceeded"}}',
    )
    expect(sanitizeInitialStreamError('{"response":{"error":{"api_key":"k","message":"m"}}}')).toBe('{"error":{"api_key":"[REDACTED]","message":"m"}}')
    expect(sanitizeInitialStreamError('{"error":{"message":"' + 'x'.repeat(2100) + '"}}')).toBe(
      `{"error":{"message":"${'x'.repeat(2048)}"}}`,
    )
    expect(sanitizeInitialStreamError('plain text')).toBe('{"error":{"message":"plain text"}}')
    expect(normalizeErrorStatus(302)).toBe(500)
    expect(normalizeErrorStatus(600)).toBe(500)
    expect(normalizeErrorStatus(429)).toBe(429)
  })

  it('frames in-stream failures per client identity with the leading newline', () => {
    const failure = statusStreamFailure('unexpected EOF', 500)
    expect(formatTerminalErrorFrame('error', failure, 5)).toBe(
      '\nevent: error\ndata: {"type":"error","error":{"code":"internal_server_error","message":"unexpected EOF","param":null,"type":"server_error"},"sequence_number":5}\n\n',
    )
    expect(formatTerminalErrorFrame('response.failed', failure, 5)).toBe(
      '\nevent: response.failed\ndata: {"type":"response.failed","sequence_number":5,"response":{"status":"failed","error":{"code":"internal_server_error","message":"unexpected EOF","param":null,"type":"server_error"}}}\n\n',
    )
    expect(closeErrorText('response.output_item.done')).toBe(
      'upstream stream closed before a terminal event (last event: response.output_item.done)',
    )
  })

  it('detects codex clients via UA patterns and Originator prefixes', () => {
    expect(isCodexClient({ 'User-Agent': 'codex-tui/0.154.0 (Mac OS 26.5.2; arm64) iTerm.app/3.6.11' })).toBe(true)
    expect(isCodexClient({ 'User-Agent': 'curl/8.7.1', Originator: 'codex_cli_rs 1.0' })).toBe(true)
    expect(isCodexClient({ 'user-agent': 'curl/8.7.1', originator: 'Codex Desktop' })).toBe(true)
    expect(isCodexClient({ 'User-Agent': 'curl/8.7.1' })).toBe(false)
    expect(isCodexClient({ Originator: 'vscode' })).toBe(false)
  })

  it('builds the gateway-local envelopes', () => {
    expect(buildModelNotFoundEnvelope('no-such-model')).toBe(
      '{"error":{"message":"unknown provider for model no-such-model","type":"invalid_request_error","code":"model_not_found","param":"model"}}',
    )
    expect(buildModelNotFoundEnvelope('')).toBe(
      '{"error":{"message":"unknown provider for model ","type":"invalid_request_error","code":"model_not_found","param":"model"}}',
    )
    expect(buildCompactStreamRejectedEnvelope()).toBe(
      '{"error":{"message":"Streaming not supported for compact responses","type":"invalid_request_error"}}',
    )
    expect(buildMalformedBodyEnvelope()).toBe(
      '{"error":{"message":"Invalid request: malformed JSON body","type":"invalid_request_error"}}',
    )
  })

  it('builds the cooldown 500 shape with the verbatim error and a sanitized summary', () => {
    const long = 'x'.repeat(300)
    const rendered = buildModelCooldownResponse({ model: 'mock-model', provider: 'mock-openai', lastUpstreamError: long })
    expect(rendered.status).toBe(500)
    expect(rendered.body).toBe(
      '{"error":{"code":"model_cooldown","last_upstream_error":"' + long + '","message":"All credentials for model mock-model are cooling down via provider mock-openai (last error: ' +
        'x'.repeat(253) + '...)"}}',
    )
  })
})

// ---------------------------------------------------------------------------
// R2: upstream wire
// ---------------------------------------------------------------------------

describe('S2d6 upstream wire (§3.2)', () => {
  it('pins the header set per mode and the emission order', () => {
    const nonStream = orderUpstreamHeaders(buildUpstreamHeaders({ apiKey: 'k', stream: false }), 'http://h:1/v1', 'abc')
    expect(nonStream).toEqual([
      ['Host', 'h:1'],
      ['User-Agent', 'cli-proxy-openai-compat'],
      ['Content-Length', '3'],
      ['Authorization', 'Bearer k'],
      ['Content-Type', 'application/json'],
      ['Accept-Encoding', 'gzip'],
    ])
    const stream = orderUpstreamHeaders(buildUpstreamHeaders({ apiKey: 'k', stream: true }), 'http://h:1/v1', 'abc')
    expect(stream).toEqual([
      ['Host', 'h:1'],
      ['User-Agent', 'cli-proxy-openai-compat'],
      ['Content-Length', '3'],
      ['Accept', 'text/event-stream'],
      ['Authorization', 'Bearer k'],
      ['Cache-Control', 'no-cache'],
      ['Content-Type', 'application/json'],
      ['Accept-Encoding', 'gzip'],
    ])
  })

  it('appends stream_options after the translated body', () => {
    expect(withStreamOptions('{"model":"m","messages":[],"stream":true}')).toBe(
      '{"model":"m","messages":[],"stream":true,"stream_options":{"include_usage":true}}',
    )
    expect(withStreamOptions('{}')).toBe('{"stream_options":{"include_usage":true}}')
    expect(withStreamOptions('nope')).toBe('nope')
  })
})


// ---------------------------------------------------------------------------
// R6: facade slices the goldens do not pin
// ---------------------------------------------------------------------------

function makeService(
  overrides: Partial<Parameters<typeof createRes2OaiService>[0]> = {},
): ReturnType<typeof createRes2OaiService> {
  return createRes2OaiService({
    apiKeys: ['gateway-key'],
    credentials: [
      {
        apiKey: 'up-key-1',
        baseUrl: 'http://up1.test/v1',
        provider: 'provider-a',
        models: [{ name: 'up-model', alias: 'alias' }],
      },
    ],
    store: new MemoryStore(),
    now: () => FROZEN,
    requestRetry: 0,
    transientErrorCooldownSeconds: -1,
    ...overrides,
  })
}

function requestOf(path: string, body: string, headers: Array<[string, string]> = []): Res2OaiRequest {
  return {
    method: 'POST',
    path,
    headers: [['Authorization', 'Bearer gateway-key'], ...headers],
    body,
  }
}

function reply(body: string, status = 200): Res2OaiUpstreamResponse {
  return {
    status,
    headers: [['Content-Type', status === 200 ? 'text/event-stream' : 'application/json']],
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(body))
        controller.close()
      },
    }),
  }
}

async function sendCapture(
  responses: readonly (Res2OaiUpstreamResponse | Error)[],
): Promise<{ send: Res2OaiUpstreamSender; calls: Res2OaiUpstreamRequest[] }> {
  const calls: Res2OaiUpstreamRequest[] = []
  let index = 0
  const send: Res2OaiUpstreamSender = async (call) => {
    calls.push(call)
    const next = responses[index]
    index += 1
    if (next === undefined) throw new Error('harness: unexpected upstream call')
    if (next instanceof Error) throw next
    return next
  }
  return { send, calls }
}

async function bodyOf(response: Res2OaiResponse): Promise<string> {
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

function headerOf(response: Res2OaiResponse, name: string): string | undefined {
  const key = name.toLowerCase()
  for (const [headerName, value] of response.headers) {
    if (headerName.toLowerCase() === key) return value
  }
  return undefined
}

describe('S2d6 facade: gateway-local surfaces', () => {
  it('rejects missing and invalid keys with the recorded 401 shapes', async () => {
    const service = makeService()
    const missing = await service.handleResponses(
      { method: 'POST', path: '/v1/responses', headers: [], body: '{"model":"alias","input":"hi"}' },
      (await sendCapture([])).send,
    )
    expect(missing.status).toBe(401)
    expect(await bodyOf(missing)).toBe('{"error":"Missing API key"}')
    expect(headerOf(missing, 'content-type')).toBe('application/json; charset=utf-8')
    const invalid = await service.handleResponses(
      { method: 'POST', path: '/v1/responses', headers: [['Authorization', 'Bearer wrong']], body: '{"model":"alias","input":"hi"}' },
      (await sendCapture([])).send,
    )
    expect(await bodyOf(invalid)).toBe('{"error":"Invalid API key"}')
  })

  it('answers 404 with an empty body for unknown paths and wrong methods, 204 for OPTIONS', async () => {
    const service = makeService()
    const { send } = await sendCapture([])
    const unknown = await service.handleResponses(requestOf('/v1/other', '{}'), send)
    expect(unknown).toEqual({ status: 404, headers: [], body: '' })
    const wrongMethod = await service.handleResponses(
      { method: 'GET', path: '/v1/responses', headers: [['Authorization', 'Bearer gateway-key']], body: '' },
      send,
    )
    expect(wrongMethod).toEqual({ status: 404, headers: [], body: '' })
    const options = await service.handleResponses(
      { method: 'OPTIONS', path: '/v1/responses', headers: [], body: '' },
      send,
    )
    expect(options.status).toBe(204)
    expect(headerOf(options, 'access-control-allow-origin')).toBe('*')
  })

  it('resolves the model from the body with the strict boundary in front (NE-LENIENT)', async () => {
    const service = makeService()
    const { send, calls } = await sendCapture([])
    const malformed = await service.handleResponses(requestOf('/v1/responses', 'this is not json'), send)
    expect(malformed.status).toBe(400)
    expect(await bodyOf(malformed)).toBe(buildMalformedBodyEnvelope())
    expect(calls.length).toBe(0)
    const notFound = await service.handleResponses(requestOf('/v1/responses', '{"model":"nope","input":"hi"}'), send)
    expect(await bodyOf(notFound)).toBe(buildModelNotFoundEnvelope('nope'))
    expect(headerOf(notFound, 'content-type')).toBe('application/json')
    const emptyModel = await service.handleResponses(requestOf('/v1/responses', '{"input":"hi"}'), send)
    expect(await bodyOf(emptyModel)).toBe(buildModelNotFoundEnvelope(''))
  })

  it('rejects compact stream:true before any upstream call', async () => {
    const service = makeService()
    const { send, calls } = await sendCapture([])
    const response = await service.handleResponses(
      requestOf('/v1/responses/compact', '{"model":"alias","input":"hi","stream":true}'),
      send,
    )
    expect(response.status).toBe(400)
    expect(await bodyOf(response)).toBe(buildCompactStreamRejectedEnvelope())
    expect(headerOf(response, 'content-type')).toBe('application/json; charset=utf-8')
    expect(calls.length).toBe(0)
  })

  it('accepts the codex alias paths', async () => {
    const service = makeService()
    const { send, calls } = await sendCapture([reply(`data: ${chunk({ role: 'assistant' })}\n\ndata: [DONE]\n\n`)])
    const response = await service.handleResponses(
      requestOf('/backend-api/codex/responses', '{"model":"alias","input":"hi","stream":true}'),
      send,
    )
    expect(response.status).toBe(200)
    expect(headerOf(response, 'content-type')).toBe('text/event-stream')
    expect(calls[0]?.url).toBe('http://up1.test/v1/chat/completions')
  })
})

describe('S2d6 facade: cooldown + retry slices', () => {
  it('429 cools the credential; the next request inside the window answers the 500 model_cooldown shape', async () => {
    let nowMs = FROZEN
    const store = new MemoryStore()
    const service = makeService({ store, now: () => nowMs })
    const error429 = reply('{"error": {"message": "mock rate limit"}}', 429)
    const { send, calls } = await sendCapture([error429, error429])
    const first = await service.handleResponses(requestOf('/v1/responses', '{"model":"alias","input":"hi"}'), send)
    expect(first.status).toBe(429)
    expect(await bodyOf(first)).toBe('{"error": {"message": "mock rate limit"}}')
    nowMs = FROZEN + 100
    const second = await service.handleResponses(requestOf('/v1/responses', '{"model":"alias","input":"hi"}'), send)
    expect(second.status).toBe(500)
    expect(await bodyOf(second)).toBe(
      '{"error":{"code":"model_cooldown","last_upstream_error":"{\\"error\\": {\\"message\\": \\"mock rate limit\\"}}","message":"All credentials for model alias are cooling down via provider provider-a (last error: {\\"error\\": {\\"message\\": \\"mock rate limit\\"}})"}}',
    )
    expect(calls.length).toBe(1)
    nowMs = FROZEN + 1001
    const third = await service.handleResponses(requestOf('/v1/responses', '{"model":"alias","input":"hi"}'), send)
    expect(third.status).toBe(429)
    expect(calls.length).toBe(2)
  })

  it('never shortens a longer stored cooldown window (store.update race guard)', async () => {
    let nowMs = FROZEN
    const store = new MemoryStore()
    const service = makeService({ store, now: () => nowMs })
    const error429 = reply('{"e":1}', 429)
    const { send, calls } = await sendCapture([error429, error429])
    await service.handleResponses(requestOf('/v1/responses', '{"model":"alias","input":"hi"}'), send)
    nowMs = FROZEN + 500
    await service.handleResponses(requestOf('/v1/responses', '{"model":"alias","input":"hi"}'), send)
    // The second request rode the cooldown (no new upstream call) and left the window intact.
    expect(calls.length).toBe(1)
    const stored = await store.get('res2oai', 'credential-cooldown:0')
    expect((stored as { until_ms: number } | undefined)?.until_ms).toBe(FROZEN + 1000)
  })

  it('moves to the next credential on retryable failures when requestRetry > 0', async () => {
    const service = makeService({
      requestRetry: 1,
      credentials: [
        { apiKey: 'k1', baseUrl: 'http://up1.test/v1', models: [{ name: 'up-model', alias: 'alias' }] },
        { apiKey: 'k2', baseUrl: 'http://up2.test/v1', models: [{ name: 'up-model', alias: 'alias' }] },
      ],
    })
    const { send, calls } = await sendCapture([
      reply('{"error":{"message":"limited"}}', 429),
      reply(`data: ${chunk({ role: 'assistant' })}\n\ndata: ${chunk({}, 'stop')}\n\ndata: [DONE]\n\n`),
    ])
    const response = await service.handleResponses(
      requestOf('/v1/responses', '{"model":"alias","input":"hi","stream":true}'),
      send,
    )
    expect(response.status).toBe(200)
    expect(calls.map((call) => call.url)).toEqual([
      'http://up1.test/v1/chat/completions',
      'http://up2.test/v1/chat/completions',
    ])
  })

  it('keeps the rendered 429 response intact when the Store write fails, reporting the error', async () => {
    const originalReport = globalThis.reportError
    const seen: unknown[] = []
    globalThis.reportError = (error: unknown) => {
      seen.push(error)
    }
    try {
      const failingStore = new MemoryStore()
      const service = makeService({
        store: new Proxy(failingStore, {
          get(target, prop) {
            if (prop === 'update') {
              return () => {
                throw new Error('store down')
              }
            }
            return Reflect.get(target, prop) as unknown
          },
        }) as never,
      })
      const { send, calls } = await sendCapture([reply('{"error": {"m": 1}}', 429)])
      const response = await service.handleResponses(requestOf('/v1/responses', '{"model":"alias","input":"hi"}'), send)
      expect(response.status).toBe(429)
      expect(await bodyOf(response)).toBe('{"error": {"m": 1}}')
      expect(calls.length).toBe(1)
      expect(seen.length).toBe(1)
    } finally {
      globalThis.reportError = originalReport
    }
  })
})

describe('S2d6 facade: transport + upstream failure slices', () => {
  it('renders the pre-commit 500 unexpected-EOF envelope when the transport fails', async () => {
    const service = makeService()
    const { send, calls } = await sendCapture([new Error('connection reset'), new Error('connection reset')])
    const nonStream = await service.handleResponses(requestOf('/v1/responses', '{"model":"alias","input":"hi"}'), send)
    expect(nonStream.status).toBe(500)
    expect(await bodyOf(nonStream)).toBe(
      '{"error":{"message":"unexpected EOF","type":"server_error","code":"internal_server_error"}}',
    )
    const stream = await service.handleResponses(
      requestOf('/v1/responses', '{"model":"alias","input":"hi","stream":true}'),
      send,
    )
    expect(stream.status).toBe(500)
    expect(await bodyOf(stream)).toBe(
      '{"error":{"message":"unexpected EOF","type":"server_error","code":"internal_server_error"}}',
    )
    expect(calls.length).toBe(2)
  })

  it('answers in-band upstream error frames before the first frame with a JSON error', async () => {
    const service = makeService()
    const { send } = await sendCapture([reply('event: error\ndata: {"error":{"message":"boom","code":"x"}}\n\n')])
    const response = await service.handleResponses(
      requestOf('/v1/responses', '{"model":"alias","input":"hi","stream":true}'),
      send,
    )
    expect(response.status).toBe(502)
    expect(await bodyOf(response)).toBe('{"error":{"code":"x","message":"boom"}}')
  })

  it('passes non-2xx compact replies through like non-stream errors', async () => {
    const service = makeService()
    const { send } = await sendCapture([reply('{"error": {"compact": true}}', 403)])
    const response = await service.handleResponses(requestOf('/v1/responses/compact', '{"model":"alias","input":"hi"}'), send)
    expect(response.status).toBe(403)
    expect(await bodyOf(response)).toBe('{"error": {"compact": true}}')
  })

  it('re-marshals invalid-JSON compact replies verbatim', async () => {
    const service = makeService()
    const { send } = await sendCapture([reply('not json')])
    const response = await service.handleResponses(requestOf('/v1/responses/compact', '{"model":"alias","input":"hi"}'), send)
    expect(await bodyOf(response)).toBe('not json')
  })

  it('synthesizes a response for an empty upstream body', async () => {
    const service = makeService()
    const { send } = await sendCapture([reply('')])
    const response = await service.handleResponses(requestOf('/v1/responses', '{"model":"alias","input":"hi"}'), send)
    expect(response.status).toBe(200)
    expect(await bodyOf(response)).toContain('"status":"completed"')
    expect(await bodyOf(response)).toContain('"output":[]')
  })
})
