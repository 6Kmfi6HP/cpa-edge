/**
 * Targeted units for the oai2gem direction: the recorded behaviors the
 * golden batch pins, plus the corners no golden covers (schema-cleaner
 * rewrites, boundary turns, the capability paths, URL alt passthrough,
 * the auth gate, cooldown bookkeeping, and the raw-byte splicing).
 */
import { describe, expect, it, vi } from 'vitest'
import { MemoryStore } from '@cpa-edge/core'
import {
  DEFAULT_PARAMETERS_JSON_SCHEMA,
  buildGeminiTools,
  cleanGeminiSchema,
  sanitizeFunctionName,
} from './schema'
import { RawJson, rawValueAt, serializeOrdered, setRawMember, deleteRawMember } from './json'
import { parseDataUrl, parseModelSuffix, stripModelSuffix, translateChatToGemini } from './request'
import type { ChatToGeminiContext } from './types'
import { translateGeminiResponseToChatCompletion } from './response'
import { GeminiChunkTranslator, filterUpstreamUsage, translateGeminiStreamToChatChunks } from './stream'
import { decodeUpstreamDataLines } from './sse'
import {
  buildModelCooldownResponse,
  classifyUpstreamError,
  modelNotFoundBody,
  parseRetryAfterSeconds,
  terminalErrorFrame,
  wrapTypeForStatus,
} from './errors'
import { buildGeminiUpstreamHeaders } from './headers'
import { createOai2GemService } from './service'
import type { Oai2GemChatRequest, Oai2GemUpstreamSender } from './service'

const CTX: ChatToGeminiContext = { upstreamModel: 'gemini-mock-model' }

function translate(body: unknown, ctx: ChatToGeminiContext = CTX): string {
  return translateChatToGemini(typeof body === 'string' ? body : JSON.stringify(body), ctx).body
}

function parsed(body: string): Record<string, unknown> {
  return JSON.parse(body) as Record<string, unknown>
}

// ---------------------------------------------------------------------------
// json helpers
// ---------------------------------------------------------------------------

describe('serializeOrdered', () => {
  it('HTML-escapes gateway-written strings on both wire families', () => {
    expect(serializeOrdered('a<b>&c')).toBe('"a\\u003cb\\u003e\\u0026c"')
  })

  it('splices RawJson members verbatim', () => {
    expect(serializeOrdered({ schema: new RawJson('{"a": 1}') })).toBe('{"schema":{"a": 1}}')
  })

  it('keeps insertion order and rejects non-finite numbers', () => {
    expect(serializeOrdered({ b: 1, a: [true, null] })).toBe('{"b":1,"a":[true,null]}')
    expect(() => serializeOrdered(Number.NaN)).toThrow()
  })
})

describe('raw member surgery', () => {
  it('replaces in place and appends compactly', () => {
    expect(setRawMember('{"x": 1, "y": 2}', 'y', '9')).toBe('{"x": 1, "y": 9}')
    expect(setRawMember('{"x": 1}', 'z', '"v"')).toBe('{"x": 1,"z":"v"}')
    expect(setRawMember('{}', 'z', '0')).toBe('{"z":0}')
  })

  it('deletes first and middle members with their separators', () => {
    expect(deleteRawMember('{"a": 1, "b": 2}', 'a')).toBe('{"b": 2}')
    expect(deleteRawMember('{"a": 1, "b": 2, "c": 3}', 'b')).toBe('{"a": 1, "c": 3}')
    expect(deleteRawMember('{"a": 1}', 'missing')).toBe('{"a": 1}')
  })

  it('locates raw spans at nested paths', () => {
    const body = '{"tools":[{"function":{"parameters": {"city": {"type": "string"}}}]}'
    expect(rawValueAt(body, ['tools', '0', 'function', 'parameters'])).toBe('{"city": {"type": "string"}}')
  })
})

// ---------------------------------------------------------------------------
// schema: sanitizer + cleaner + declarations
// ---------------------------------------------------------------------------

describe('sanitizeFunctionName', () => {
  it('maps invalid characters, prefixes bad starts, caps at 64', () => {
    expect(sanitizeFunctionName('get weather!')).toBe('get_weather_')
    expect(sanitizeFunctionName('1get')).toBe('_1get')
    expect(sanitizeFunctionName('get-weather.v1:beta')).toBe('get-weather.v1:beta')
    expect(sanitizeFunctionName('x'.repeat(80))).toHaveLength(64)
    expect(sanitizeFunctionName('-lead')).toBe('_-lead')
  })
})

describe('cleanGeminiSchema', () => {
  it('passes clean schemas through byte-identically (golden-pinned)', () => {
    const raw = '{"type": "object", "properties": {"city": {"type": "string", "description": "City name"}}, "required": ["city"]}'
    expect(cleanGeminiSchema(raw)).toBe(raw)
  })

  it('drops nullable and title members, keeping the other bytes', () => {
    const raw = '{"type": "string", "nullable": true, "title": "Name"}'
    expect(cleanGeminiSchema(raw)).toBe('{"type": "string"}')
  })

  it('rewrites string enums compactly with the Allowed hint (S2d8-04 encoding)', () => {
    expect(cleanGeminiSchema('{"type": "string", "enum": ["celsius", "fahrenheit"]}')).toBe(
      '{"type": "string", "enum": ["celsius","fahrenheit"],"description":"Allowed: celsius, fahrenheit"}',
    )
  })

  it('forces a string enum without a type to string', () => {
    expect(cleanGeminiSchema('{"enum": ["a"]}')).toBe('{"enum": ["a"],"description":"Allowed: a","type":"string"}')
  })

  it('converts a string const into an enum with the hint', () => {
    expect(cleanGeminiSchema('{"const": "yes"}')).toBe('{"enum":["yes"],"description":"Allowed: yes","type":"string"}')
  })

  it('inlines single-element anyOf/oneOf schemas', () => {
    expect(cleanGeminiSchema('{"anyOf": [{"type": "string"}]}')).toBe('{"type": "string"}')
    expect(cleanGeminiSchema('{"oneOf": [{"type": "number"}]}')).toBe('{"type": "number"}')
    expect(cleanGeminiSchema('{"anyOf": [{"type": "a"}, {"type": "b"}]}')).toBe('{"anyOf": [{"type": "a"}, {"type": "b"}]}')
  })

  it('adds missing items to array types', () => {
    expect(cleanGeminiSchema('{"type": "array"}')).toBe('{"type": "array","items":{}}')
  })

  it('folds unsupported constraints into the description hint', () => {
    expect(cleanGeminiSchema('{"type": "string", "additionalProperties": false}')).toBe(
      '{"type": "string","description":"additionalProperties: false"}',
    )
    expect(cleanGeminiSchema('{"description": "Base", "exclusiveMinimum": 0}')).toBe(
      '{"description": "Base exclusiveMinimum: 0"}',
    )
  })

  it('inlines a same-document $ref node', () => {
    const raw = '{"definitions": {"city": {"type": "string"}}, "properties": {"c": {"$ref": "#/definitions/city"}}}'
    const cleaned = cleanGeminiSchema(raw)
    expect(JSON.parse(cleaned)).toEqual({
      definitions: { city: { type: 'string' } },
      properties: { c: { type: 'string' } },
    })
  })

  it('cleans nested members while leaving untouched siblings raw', () => {
    const raw = '{"properties": {"ok": {"type": "number"}, "bad": {"type": "string", "title": "x"}}, "required": ["ok"]}'
    expect(cleanGeminiSchema(raw)).toBe('{"properties": {"ok": {"type": "number"}, "bad": {"type": "string"}}, "required": ["ok"]}')
  })
})

describe('buildGeminiTools', () => {
  const rawBody = JSON.stringify({
    tools: [
      { type: 'function', function: { name: 'get-weather', description: 'Get weather', parameters: { type: 'object' } } },
      { type: 'function', function: { name: 'no-params', strict: true } },
      { google_search: {} },
      { code_execution: {} },
      { url_context: {} },
    ],
  })
  const parsedBody = JSON.parse(rawBody) as { tools: unknown[] }

  it('builds one functionDeclarations node first, then the extra nodes', () => {
    const tools = buildGeminiTools(parsedBody.tools, rawBody)
    expect(tools).toBeDefined()
    const nodes = tools ?? []
    expect(nodes).toHaveLength(4)
    expect(Object.keys(nodes[0] as Record<string, unknown>)).toEqual(['functionDeclarations'])
    expect(nodes[1]).toEqual({ googleSearch: {} })
    expect(nodes[2]).toEqual({ codeExecution: {} })
    expect(nodes[3]).toEqual({ urlContext: {} })
  })

  it('drops strict, defaults the schema, and sanitizes into the name value', () => {
    const tools = buildGeminiTools(parsedBody.tools, rawBody) ?? []
    const first = tools[0] as { functionDeclarations: unknown[] }
    expect(first.functionDeclarations).toHaveLength(2)
    expect(serializeOrdered(first.functionDeclarations[1] as never)).toBe(
      `{"name":"no-params","parametersJsonSchema":${DEFAULT_PARAMETERS_JSON_SCHEMA}}`,
    )
  })
})

// ---------------------------------------------------------------------------
// request translation
// ---------------------------------------------------------------------------

describe('model suffix', () => {
  it('parses and strips alias(<level>) suffixes', () => {
    expect(parseModelSuffix('mock-gemini-think(high)')).toEqual({ base: 'mock-gemini-think', suffix: 'high' })
    expect(parseModelSuffix('plain-model')).toBeUndefined()
    expect(stripModelSuffix('name(max)')).toBe('name')
    expect(stripModelSuffix('name')).toBe('name')
  })
})

describe('message mapping', () => {
  it('collects leading systems into systemInstruction when len > 1', () => {
    const body = translate({
      messages: [
        { role: 'system', content: 'A' },
        { role: 'developer', content: ['ignored', { type: 'text', text: 'B' }] },
        { role: 'user', content: 'hi' },
      ],
    })
    const value = parsed(body)
    expect(value['systemInstruction']).toEqual({
      role: 'user',
      parts: [{ text: 'A' }, { text: 'B' }],
    })
    expect(value['contents']).toEqual([{ role: 'user', parts: [{ text: 'hi' }] }])
  })

  it('turns a lone system message into a user content', () => {
    const value = parsed(translate({ messages: [{ role: 'system', content: 'Only' }] }))
    expect(value['systemInstruction']).toBeUndefined()
    expect(value['contents']).toEqual([{ role: 'user', parts: [{ text: 'Only' }] }])
  })

  it('maps a system message after the conversation start to a user content', () => {
    const value = parsed(
      translate({
        messages: [
          { role: 'system', content: 'A' },
          { role: 'user', content: 'q' },
          { role: 'system', content: 'Late' },
        ],
      }),
    )
    expect(value['systemInstruction']).toEqual({ role: 'user', parts: [{ text: 'A' }] })
    expect(value['contents']).toEqual([
      { role: 'user', parts: [{ text: 'q' }] },
      { role: 'user', parts: [{ text: 'Late' }] },
    ])
  })

  it('drops trailing model content and wraps model-first conversations', () => {
    const value = parsed(
      translate({
        messages: [
          { role: 'user', content: 'q' },
          { role: 'assistant', content: 'a' },
        ],
      }),
    )
    expect(value['contents']).toEqual([{ role: 'user', parts: [{ text: 'q' }] }])

    const wrapped = parsed(
      translate({
        messages: [
          { role: 'assistant', content: 'first' },
          { role: 'user', content: 'q' },
        ],
      }),
    )
    expect(wrapped['contents']).toEqual([
      { role: 'user', parts: [{ text: '' }] },
      { role: 'model', parts: [{ text: 'first' }] },
      { role: 'user', parts: [{ text: 'q' }] },
    ])
  })

  it('mirrors an assistant-only conversation as empty contents', () => {
    const value = parsed(translate({ messages: [{ role: 'assistant', content: 'solo' }] }))
    expect(value['contents']).toEqual([])
  })

  it('skips empty text parts and injects the sentinel on user images only', () => {
    const value = parsed(
      translate({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: '' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
              { type: 'image_url', image_url: { url: 'https://example.com/x.png' } },
            ],
          },
        ],
      }),
    )
    expect(value['contents']).toEqual([
      {
        role: 'user',
        parts: [
          {
            inlineData: { mime_type: 'image/png', data: 'AAA' },
            thoughtSignature: 'skip_thought_signature_validator',
          },
        ],
      },
    ])
  })

  it('maps video_url, file and input_audio parts', () => {
    const value = parsed(
      translate({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'video_url', video_url: { url: 'data:video/mp4;base64,VV' } },
              { type: 'file', file: { filename: 'clip.webm', file_data: 'data:application/octet-stream;base64,FF' } },
              { type: 'input_audio', input_audio: { data: 'BB', format: 'mp3' } },
              { type: 'input_audio', input_audio: { data: 'CC', format: 'g711_ulaw' } },
              { type: 'input_audio', input_audio: { data: 'DD', format: 'weird' } },
            ],
          },
        ],
      }),
    )
    const parts = (value['contents'] as Array<{ parts: Array<Record<string, unknown>> }>)[0]?.parts ?? []
    expect(parts[0]).toEqual({ inlineData: { mime_type: 'video/mp4', data: 'VV' } })
    expect(parts[1]).toEqual({ inlineData: { mime_type: 'video/webm', data: 'FF' } })
    expect(parts[2]).toEqual({ inlineData: { mime_type: 'audio/mpeg', data: 'BB' } })
    expect(parts[3]).toEqual({ inlineData: { mime_type: 'audio/basic', data: 'CC' } })
    expect(parts[4]).toEqual({ inlineData: { mime_type: 'audio/weird', data: 'DD' } })
  })

  it('emits assistant reasoning as a thought part with the sentinel', () => {
    const value = parsed(
      translate({
        messages: [
          { role: 'assistant', reasoning_content: 'thinking...', content: 'answer' },
          { role: 'user', content: 'next' },
        ],
      }),
    )
    // The conversation opens with a model content, so the executor's
    // empty user turn is prepended (spec 3.2 step 8).
    expect(value['contents']).toEqual([
      { role: 'user', parts: [{ text: '' }] },
      {
        role: 'model',
        parts: [
          { text: 'thinking...', thought: true, thoughtSignature: 'skip_thought_signature_validator' },
          { text: 'answer' },
        ],
      },
      { role: 'user', parts: [{ text: 'next' }] },
    ])
    // An assistant-only conversation drops to empty contents (mirrored).
    const solo = parsed(translate({ messages: [{ role: 'assistant', reasoning_content: 'r', content: 'a' }] }))
    expect(solo['contents']).toEqual([])
  })

  it('emits functionResponse parts only for tool_calls with id and name', () => {
    const raw = JSON.stringify({
      messages: [
        {
          role: 'assistant',
          tool_calls: [
            { id: 'a', type: 'function', function: { name: 'one', arguments: '{"x":1}' } },
            { type: 'function', function: { name: 'two', arguments: '{}' } },
            { id: 'c', type: 'function', function: { name: '', arguments: '{}' } },
          ],
        },
      ],
    })
    const value = parsed(translate(raw))
    const contents = value['contents'] as Array<{ role: string; parts: Array<Record<string, unknown>> }>
    // Prepend + model content + synthetic user turn (call `a` has an id).
    expect(contents).toHaveLength(3)
    expect(contents[0]).toEqual({ role: 'user', parts: [{ text: '' }] })
    const parts = contents[1]?.parts ?? []
    expect(parts).toHaveLength(2)
    expect(parts[0]).toHaveProperty('functionCall')
    expect(parts[1]).toHaveProperty('functionCall')
    expect((contents[2]?.parts ?? []).map((part) => (part['functionResponse'] as Record<string, unknown>)['name'])).toEqual(['one'])
  })

  it('defaults a missing tool message to result {} and drops unmatched tool messages', () => {
    const raw = JSON.stringify({
      messages: [
        {
          role: 'assistant',
          tool_calls: [
            { id: 'call-1', type: 'function', function: { name: 'tool-a', arguments: '{}' } },
            { id: 'call-2', type: 'function', function: { name: 'tool-b', arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call-1', content: 'plain result' },
        { role: 'tool', tool_call_id: 'unmatched', content: 'dropped' },
      ],
    })
    const value = parsed(translate(raw))
    const contents = value['contents'] as Array<{ role: string; parts: Array<Record<string, unknown>> }>
    expect(contents).toHaveLength(3)
    expect(contents[0]).toEqual({ role: 'user', parts: [{ text: '' }] })
    const responses = contents[2]?.parts ?? []
    expect(responses).toEqual([
      { functionResponse: { name: 'tool-a', response: { result: '"plain result"' } } },
      { functionResponse: { name: 'tool-b', response: { result: {} } } },
    ])
  })

  it('embeds an object tool result raw and honors the thought-signature chain', () => {
    const raw = JSON.stringify({
      messages: [
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'x',
              type: 'function',
              function: { name: 'fn', arguments: '{}', extra_content: { google: { thought_signature: 'sig-a' } } },
            },
            { id: 'y', type: 'function', function: { name: 'fn2', arguments: '{}' }, thoughtSignature: 'sig-b' },
            { id: 'z', type: 'function', function: { name: 'fn3', arguments: '{}' }, thought_signature: 'sig-c' },
          ],
        },
        { role: 'tool', tool_call_id: 'x', content: { spaced: true } },
      ],
    })
    const value = parsed(translate(raw))
    const contents = value['contents'] as Array<{ role: string; parts: Array<Record<string, unknown>> }>
    const modelParts = contents[1]?.parts ?? []
    expect(modelParts.map((part) => part['thoughtSignature'])).toEqual(['sig-a', 'sig-b', 'sig-c'])
    expect(serializeOrdered((contents[2]?.parts[0] ?? {}) as never)).toContain('{"spaced":true}')
  })
})

describe('generationConfig overlay', () => {
  it('maps sampling knobs in the spec order and honors max_tokens precedence', () => {
    const value = parsed(
      translate({
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0.5,
        top_p: 0.9,
        top_k: 3,
        max_completion_tokens: 10,
        max_tokens: 64,
        n: 2,
      }),
    )
    expect(JSON.stringify(value['generationConfig'])).toBe('{"temperature":0.5,"topP":0.9,"topK":3,"maxOutputTokens":64,"candidateCount":2}')
  })

  it('omits candidateCount for n <= 1 and non-number sampling knobs', () => {
    const value = parsed(
      translate({
        messages: [{ role: 'user', content: 'hi' }],
        n: 1,
        temperature: 'warm',
        max_tokens: 'x',
        max_completion_tokens: 7,
      }),
    )
    expect(JSON.stringify(value['generationConfig'])).toBe('{"maxOutputTokens":7}')
  })

  it('copies a client generationConfig verbatim and overwrites in place', () => {
    const raw = '{"messages":[{"role":"user","content":"hi"}], "generationConfig": {"topP": 0.1, "temperature": 0.2}, "temperature": 0.9}'
    const body = translate(raw)
    // The client object's raw bytes survive; the mapped temperature
    // overwrites its value in place (the raw `": "` spacing stays, the
    // gateway-written value is compact).
    expect(body).toContain('"generationConfig":{"topP": 0.1, "temperature": 0.9}')
  })

  it('maps response_format, modalities and image_config', () => {
    const value = parsed(
      translate({
        messages: [{ role: 'user', content: 'hi' }],
        response_format: { type: 'json_schema', json_schema: { schema: { 'type': 'object', 'x': 1 } } },
        modalities: ['TEXT', 'Image', 'audio'],
        image_config: { aspect_ratio: '16:9', image_size: '1024x1024' },
      }),
    )
    expect(JSON.stringify(value['generationConfig'])).toBe(
      '{"responseMimeType":"application/json","responseJsonSchema":{"type":"object","x":1},"responseModalities":["TEXT","IMAGE"],"imageConfig":{"aspectRatio":"16:9","imageSize":"1024x1024"}}',
    )
  })

  it('strips reasoning_effort thinkingConfigs for thinking-less models (C07)', () => {
    const low = parsed(translate({ messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'low' }))
    expect(JSON.stringify(low['generationConfig'])).toBe('{}')
    const auto = parsed(translate({ messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'auto' }))
    expect(JSON.stringify(auto['generationConfig'])).toBe('{}')
  })

  it('keeps the thinkingConfig for levels-configured models and maps the suffix level', () => {
    const ctx: ChatToGeminiContext = { upstreamModel: 'm', thinking: { levels: ['low', 'high'] } }
    const effort = parsed(translate({ messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'Low ' }, ctx))
    expect(JSON.stringify(effort['generationConfig'])).toBe('{"thinkingConfig":{"thinkingLevel":"low"}}')
    const auto = parsed(translate({ messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'auto' }, ctx))
    expect(JSON.stringify(auto['generationConfig'])).toBe('{"thinkingConfig":{"thinkingBudget":-1}}')
    const suffixed = parsed(translate({ messages: [{ role: 'user', content: 'hi' }] }, { ...ctx, suffixLevel: 'high' }))
    expect(JSON.stringify(suffixed['generationConfig'])).toBe('{"thinkingConfig":{"thinkingLevel":"high"}}')
  })

  it('always ends the body with the injected safetySettings', () => {
    const value = parsed(translate({ messages: [{ role: 'user', content: 'hi' }], tools: [{ type: 'function', function: { name: 'f' } }] }))
    const keys = Object.keys(value)
    expect(keys).toEqual(['contents', 'model', 'tools', 'safetySettings'])
    expect(value['safetySettings']).toEqual([
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'OFF' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'OFF' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'OFF' },
      { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'BLOCK_NONE' },
    ])
  })

  it('rejects malformed JSON bodies (NE-LENIENT)', () => {
    expect(() => translate('{"messages": ')).toThrow()
  })
})

// ---------------------------------------------------------------------------
// response mapping (non-stream)
// ---------------------------------------------------------------------------

const RESPONSE_CTX = {
  nowMs: () => 1_789_507_015_000,
  nextToolCallSeq: (() => {
    let seq = 0
    return () => {
      seq += 1
      return seq
    }
  })(),
}

describe('translateGeminiResponseToChatCompletion', () => {
  it('renders the recorded envelope with the modelVersion echo', () => {
    const body = translateGeminiResponseToChatCompletion(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'hi' }], role: 'model' }, finishReason: 'STOP', index: 0 }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 },
        modelVersion: 'gemini-x',
      }),
      RESPONSE_CTX,
    )
    expect(parsed(body)).toEqual({
      id: '',
      object: 'chat.completion',
      created: 0,
      model: 'gemini-x',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'hi', reasoning_content: null, tool_calls: null },
          finish_reason: 'stop',
          native_finish_reason: 'stop',
        },
      ],
      usage: { completion_tokens: 2, total_tokens: 3, prompt_tokens: 1 },
    })
  })

  it('defaults the model to the literal and drops usage when absent', () => {
    const body = translateGeminiResponseToChatCompletion('{"candidates":[]}', RESPONSE_CTX)
    expect(parsed(body)).toEqual({
      id: '',
      object: 'chat.completion',
      created: 0,
      model: 'model',
      choices: [],
    })
  })

  it('overrides both finish fields for tool calls and splices raw args', () => {
    const upstream = JSON.stringify({
      candidates: [
        {
          content: { parts: [{ functionCall: { name: 'get_weather', args: { city: 'Paris' } } }], role: 'model' },
          finishReason: 'STOP',
          index: 0,
        },
      ],
      modelVersion: 'm',
    })
    const value = parsed(translateGeminiResponseToChatCompletion(upstream, RESPONSE_CTX))
    const choice = (value['choices'] as Array<Record<string, unknown>>)[0]
    expect(choice?.['finish_reason']).toBe('tool_calls')
    expect(choice?.['native_finish_reason']).toBe('tool_calls')
    // The arguments string carries the upstream's RAW bytes (compact here
    // because this upstream was JSON.stringify-ed).
    expect(serializeOrdered(choice?.['message'] as never)).toContain('"arguments":"{\\"city\\":\\"Paris\\"}"')
    expect(serializeOrdered(choice?.['message'] as never)).not.toContain('"index"')
    // A spaced upstream keeps its spacing verbatim (recorded behavior).
    const spaced = '{"candidates":[{"content":{"parts":[{"functionCall":{"name":"f","args":{"city": "Paris"}}}],"role":"model"},"finishReason":"STOP"}]}'
    const spacedValue = parsed(translateGeminiResponseToChatCompletion(spaced, RESPONSE_CTX))
    const spacedChoice = (spacedValue['choices'] as Array<Record<string, unknown>>)[0]
    expect(serializeOrdered(spacedChoice?.['message'] as never)).toContain('"arguments":"{\\"city\\": \\"Paris\\"}"')
  })

  it('maps thoughts/cached usage details and inlineData images', () => {
    const upstream = JSON.stringify({
      candidates: [
        {
          content: {
            parts: [
              { text: 'reason', thought: true },
              { text: 'answer' },
              { inlineData: { mime_type: 'image/webp', data: 'QQ' } },
            ],
            role: 'model',
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 4,
        thoughtsTokenCount: 12,
        totalTokenCount: 26,
        cachedContentTokenCount: 3,
      },
    })
    const value = parsed(translateGeminiResponseToChatCompletion(upstream, RESPONSE_CTX))
    const message = ((value['choices'] as Array<Record<string, unknown>>)[0]?.['message']) as Record<string, unknown>
    expect(message['content']).toBe('answer')
    expect(message['reasoning_content']).toBe('reason')
    expect(message['images']).toEqual([
      { index: 0, type: 'image_url', image_url: { url: 'data:image/webp;base64,QQ' } },
    ])
    expect(value['usage']).toEqual({
      completion_tokens: 16,
      total_tokens: 26,
      prompt_tokens: 10,
      completion_tokens_details: { reasoning_tokens: 12 },
      prompt_tokens_details: { cached_tokens: 3 },
    })
  })

  it('rewrites the model with force-mapping and parses createTime', () => {
    const upstream = JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'x' }], role: 'model' }, finishReason: 'STOP' }],
      createTime: '2026-09-15T21:16:55.416Z',
    })
    const value = parsed(
      translateGeminiResponseToChatCompletion(upstream, { ...RESPONSE_CTX, forceMappingModel: 'alias-x' }),
    )
    expect(value['model']).toBe('alias-x')
    expect(value['created']).toBeGreaterThan(1_700_000_000)
  })
})

// ---------------------------------------------------------------------------
// stream translation
// ---------------------------------------------------------------------------

const STREAM_CTX = {
  nowMs: () => 1_789_507_015_000,
  nextToolCallSeq: (() => {
    let seq = 0
    return () => {
      seq += 1
      return seq
    }
  })(),
}

function framesOf(events: readonly unknown[]): { readonly bodies: string[] } {
  const translator = new GeminiChunkTranslator(STREAM_CTX)
  const bodies: string[] = []
  for (const event of events) {
    const record = structuredClone(event) as Record<string, unknown>
    const kept = filterUpstreamUsage(record)
    const usageMeta = kept && typeof record['usageMetadata'] === 'object' ? (record['usageMetadata'] as Record<string, unknown>) : undefined
    for (const body of translator.translateChunk(record, JSON.stringify(event), kept, usageMeta)) bodies.push(body)
  }
  return { bodies }
}

describe('GeminiChunkTranslator', () => {
  it('sets role assistant per payload-bearing chunk and resets it (C11/C19)', () => {
    const { bodies } = framesOf([
      { candidates: [{ content: { parts: [{ text: 'one' }], role: 'model' }, index: 0 }] },
      { candidates: [{ content: { parts: [{ text: 'two' }], role: 'model' }, index: 0 }] },
      { candidates: [{ content: { parts: [], role: 'model' }, index: 0 }] },
    ])
    const roles = bodies.map((body) => ((parsed(body)['choices'] as Array<Record<string, unknown>>)[0]?.['delta'] as Record<string, unknown>)['role'])
    expect(roles).toEqual(['assistant', 'assistant', null])
  })

  it('fans out per candidate with identical duplicated usage (C22)', () => {
    const { bodies } = framesOf([
      {
        candidates: [
          { content: { parts: [{ text: 'a' }], role: 'model' }, index: 0 },
          { content: { parts: [{ text: 'b' }], role: 'model' }, index: 1 },
        ],
      },
      {
        candidates: [
          { content: { parts: [], role: 'model' }, finishReason: 'STOP', index: 0 },
          { content: { parts: [], role: 'model' }, finishReason: 'STOP', index: 1 },
        ],
        usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 6, totalTokenCount: 15 },
        modelVersion: 'm',
      },
    ])
    expect(bodies).toHaveLength(4)
    const terminal = bodies.slice(2).map((body) => {
      const value = parsed(body)
      return {
        index: (value['choices'] as Array<Record<string, unknown>>)[0]?.['index'],
        finish: (value['choices'] as Array<Record<string, unknown>>)[0]?.['finish_reason'],
        usage: value['usage'],
      }
    })
    expect(terminal).toEqual([
      { index: 0, finish: 'stop', usage: { completion_tokens: 6, total_tokens: 15, prompt_tokens: 9 } },
      { index: 1, finish: 'stop', usage: { completion_tokens: 6, total_tokens: 15, prompt_tokens: 9 } },
    ])
  })

  it('hides usage and finish when candidate 0 never finishes (C23)', () => {
    const { bodies } = framesOf([
      {
        candidates: [
          { content: { parts: [], role: 'model' }, index: 0 },
          { content: { parts: [], role: 'model' }, finishReason: 'STOP', index: 1 },
        ],
        usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 5, totalTokenCount: 13 },
        modelVersion: 'm',
      },
    ])
    expect(bodies).toHaveLength(2)
    for (const body of bodies) {
      const value = parsed(body)
      expect(value['usage']).toBeUndefined()
      expect((value['choices'] as Array<Record<string, unknown>>)[0]?.['finish_reason']).toBeNull()
    }
  })

  it('drops the finish when the usage arrives in a different chunk (C14)', () => {
    const { bodies } = framesOf([
      { candidates: [{ content: { parts: [{ text: 'Partial' }], role: 'model' }, index: 0 }] },
      { candidates: [{ content: { parts: [], role: 'model' }, finishReason: 'STOP', index: 0 }] },
      { usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 }, modelVersion: 'm' },
    ])
    expect(bodies).toHaveLength(2)
    const second = parsed(bodies[1] ?? '')
    expect((second['choices'] as Array<Record<string, unknown>>)[0]?.['finish_reason']).toBeNull()
    expect(second['usage']).toBeUndefined()
  })

  it('keeps native_finish_reason at the upstream reason for tool calls (C12 asymmetry)', () => {
    const { bodies } = framesOf([
      { candidates: [{ content: { parts: [{ text: 'check' }], role: 'model' }, index: 0 }] },
      {
        candidates: [
          { content: { parts: [{ functionCall: { name: 'get_weather', args: { city: 'Paris' } } }], role: 'model' }, index: 0 },
        ],
      },
      {
        candidates: [{ content: { parts: [], role: 'model' }, finishReason: 'STOP', index: 0 }],
        usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 5, totalTokenCount: 16 },
        modelVersion: 'm',
      },
    ])
    const terminal = parsed(bodies[2] ?? '')
    const terminalChoice = (terminal['choices'] as Array<Record<string, unknown>>)[0]
    expect(terminalChoice?.['finish_reason']).toBe('tool_calls')
    expect(terminalChoice?.['native_finish_reason']).toBe('stop')
    const callFrame = parsed(bodies[1] ?? '')
    const callChoice = (callFrame['choices'] as Array<Record<string, unknown>>)[0]
    const delta = callChoice?.['delta'] as Record<string, unknown>
    const call = (delta['tool_calls'] as Array<Record<string, unknown>>)[0]
    expect(call).toEqual({
      id: expect.stringMatching(/^get_weather-\d+-\d+$/),
      index: 0,
      type: 'function',
      function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
    })
  })

  it('counts stream tool-call indexes per candidate across chunks', () => {
    const { bodies } = framesOf([
      {
        candidates: [
          { content: { parts: [{ functionCall: { name: 'a', args: {} } }, { functionCall: { name: 'b', args: {} } }], role: 'model' }, index: 0 },
          { content: { parts: [{ functionCall: { name: 'c', args: {} } }], role: 'model' }, index: 1 },
        ],
      },
      {
        candidates: [{ content: { parts: [{ functionCall: { name: 'd', args: {} } }], role: 'model' }, index: 0 }],
      },
    ])
    const first = parsed(bodies[0] ?? '')
    const second = parsed(bodies[1] ?? '')
    const third = parsed(bodies[2] ?? '')
    const callsOf = (value: Record<string, unknown>): unknown =>
      (((value['choices'] as Array<Record<string, unknown>>)[0]?.['delta'] as Record<string, unknown>)['tool_calls'] as Array<Record<string, unknown>>)?.map((call) => call['index'])
    expect(callsOf(first)).toEqual([0, 1])
    expect(callsOf(second)).toEqual([0])
    expect(callsOf(third)).toEqual([2])
  })

  it('keeps created sticky and model per chunk', () => {
    const { bodies } = framesOf([
      { candidates: [{ content: { parts: [{ text: 'a' }], role: 'model' }, index: 0 }], createTime: '2026-09-15T21:16:55.416Z' },
      { candidates: [{ content: { parts: [{ text: 'b' }], role: 'model' }, index: 0 }] },
      { candidates: [{ content: { parts: [], role: 'model' }, index: 0 }], modelVersion: 'late' },
    ])
    const models = bodies.map((body) => parsed(body)['model'])
    expect(models).toEqual(['model', 'model', 'late'])
    const created = bodies.map((body) => parsed(body)['created'])
    expect(created[0]).toBe(created[1])
    expect(created[1]).toBe(created[2])
  })
})

describe('filterUpstreamUsage', () => {
  it('renames usageMetadata when candidates[0] has no finishReason', () => {
    const record: Record<string, unknown> = {
      candidates: [{ content: { parts: [] }, finishReason: undefined, index: 1 }],
      usageMetadata: { totalTokenCount: 1 },
    }
    expect(filterUpstreamUsage(record)).toBe(false)
    expect(record['usageMetadata']).toBeUndefined()
    expect(record['cpaUsageMetadata']).toEqual({ totalTokenCount: 1 })
  })
})

describe('decodeUpstreamDataLines', () => {
  async function* asSource(chunks: readonly (string | Uint8Array)[]): AsyncIterable<string | Uint8Array> {
    for (const chunk of chunks) yield chunk
  }

  async function collect(source: AsyncIterable<string | Uint8Array>): Promise<string[]> {
    const out: string[] = []
    for await (const line of decodeUpstreamDataLines(source)) out.push(line.data)
    return out
  }

  it('skips event names, comments, [DONE] and non-data lines', async () => {
    const text = [
      'event: ping',
      'data: {"a":1}',
      '',
      ': keep-alive',
      'data: [DONE]',
      'data: {"b":2}',
      'stray line',
      '',
    ].join('\n')
    expect(await collect(asSource([text]))).toEqual(['{"a":1}', '{"b":2}'])
  })

  it('handles payloads split across reads and a missing trailing newline', async () => {
    expect(await collect(asSource(['data: {"a"', ':1}\ndata: {"b', '":2}\n']))).toEqual(['{"a":1}', '{"b":2}'])
    expect(await collect(asSource(['data: {"x":9}']))).toEqual(['{"x":9}'])
  })
})

describe('translateGeminiStreamToChatChunks', () => {
  it('yields one chunk per payload and ends on a clean EOF', async () => {
    const events: string[] = []
    const source = (async function* (): AsyncGenerator<string> {
      yield 'data: {"candidates":[{"content":{"parts":[{"text":"hi"}],"role":"model"},"index":0}]}\n\n'
      yield 'data: not-json\n\n'
    })()
    for await (const event of translateGeminiStreamToChatChunks(source, STREAM_CTX)) {
      expect(event.kind).toBe('chunk')
      if (event.kind === 'chunk') events.push(event.body)
    }
    expect(events).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// errors + headers
// ---------------------------------------------------------------------------

describe('error semantics', () => {
  it('classifies verbatim JSON and wraps the rest by status', () => {
    expect(classifyUpstreamError(429, '  {"error": {"code": 429}} ')).toEqual({
      kind: 'verbatim',
      status: 429,
      body: '{"error": {"code": 429}}',
    })
    expect(classifyUpstreamError(503, 'oops')).toEqual({
      kind: 'wrapped',
      status: 503,
      message: 'oops',
      type: 'server_error',
      code: 'internal_server_error',
    })
    expect(classifyUpstreamError(418, '')).toEqual({
      kind: 'wrapped',
      status: 418,
      message: 'HTTP 418',
      type: 'invalid_request_error',
    })
  })

  it('maps the wrap types per status', () => {
    expect(wrapTypeForStatus(401)).toEqual({ type: 'authentication_error', code: 'invalid_api_key' })
    expect(wrapTypeForStatus(403)).toEqual({ type: 'permission_error', code: 'insufficient_quota' })
    expect(wrapTypeForStatus(429)).toEqual({ type: 'rate_limit_error', code: 'rate_limit_exceeded' })
    expect(wrapTypeForStatus(404)).toEqual({ type: 'invalid_request_error', code: 'model_not_found' })
    expect(wrapTypeForStatus(500)).toEqual({ type: 'server_error', code: 'internal_server_error' })
  })

  it('builds the model_cooldown envelope with alphabetical keys', () => {
    const rendered = buildModelCooldownResponse({
      model: 'm',
      provider: 'gemini',
      lastUpstreamError: 'boom',
      resetSeconds: 1,
      status: 429,
    })
    expect(rendered.body).toBe(
      '{"error":{"code":"model_cooldown","last_upstream_error":"boom","message":"All credentials for model m are cooling down via provider gemini (last error: boom)","model":"m","provider":"gemini","reset_seconds":1,"reset_time":"1s"}}',
    )
    expect(rendered.retryAfter).toBe('1')
  })

  it('parses integer Retry-After hints only', () => {
    expect(parseRetryAfterSeconds([['Retry-After', '30']])).toBe(30)
    expect(parseRetryAfterSeconds([['Retry-After', 'soon']])).toBeUndefined()
    expect(parseRetryAfterSeconds([['retry-after', '5']])).toBe(5)
  })

  it('renders the terminal error frame with no DONE marker', () => {
    expect(terminalErrorFrame('unexpected EOF')).toBe(
      'data: {"error":{"message":"unexpected EOF","type":"server_error","code":"internal_server_error"}}\n\n',
    )
  })

  it('shapes the model_not_found envelope', () => {
    expect(modelNotFoundBody('x')).toBe(
      '{"error":{"message":"unknown provider for model x","type":"invalid_request_error","code":"model_not_found","param":"model"}}',
    )
  })
})

describe('buildGeminiUpstreamHeaders', () => {
  it('emits the recorded set and order with credential overrides last', () => {
    const headers = buildGeminiUpstreamHeaders({
      apiKey: 'key',
      url: 'http://host:1234/path',
      body: 'hello',
      credentialHeaders: { 'X-Custom': 'v', 'content-type': 'text/plain' },
    })
    expect(headers).toEqual([
      ['Host', 'host:1234'],
      ['User-Agent', 'Go-http-client/1.1'],
      ['Content-Length', '5'],
      ['X-Goog-Api-Key', 'key'],
      ['Accept-Encoding', 'gzip'],
      ['X-Custom', 'v'],
      ['content-type', 'text/plain'],
    ])
  })
})

// ---------------------------------------------------------------------------
// facade
// ---------------------------------------------------------------------------

const encoder = new TextEncoder()

function jsonStream(text: string): ReadableStream<Uint8Array> {
  return new Response(text).body ?? new ReadableStream<Uint8Array>()
}

function chatRequest(body: unknown, path = '/v1/chat/completions'): Oai2GemChatRequest {
  return {
    method: 'POST',
    path,
    headers: [['Authorization', 'Bearer oracle-local-key-1'], ['Content-Type', 'application/json']],
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }
}

function headerOf(headers: ReadonlyArray<readonly [string, string]>, name: string): string | undefined {
  const key = name.toLowerCase()
  for (const [headerName, value] of headers) {
    if (headerName.toLowerCase() === key) return value
  }
  return undefined
}

async function bodyOf(body: string | ReadableStream<Uint8Array>): Promise<string> {
  if (typeof body === 'string') return body
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let out = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    out += decoder.decode(value, { stream: true })
  }
  return out + decoder.decode()
}

const SERVICE_OPTIONS_BASE = {
  apiKeys: ['oracle-local-key-1'],
  credentials: [
    {
      apiKey: 'k1',
      baseUrl: 'http://upstream-one.test',
      models: [{ name: 'up-one', alias: 'alias-one' }],
    },
    {
      apiKey: 'k2',
      baseUrl: 'http://upstream-two.test',
      models: [{ name: 'up-two', alias: 'alias-two' }],
    },
  ],
  now: () => 1_789_507_015_000,
  requestRetry: 0,
  transientErrorCooldownSeconds: -1,
}

/** Both credentials serve `shared`; rotation tests need two candidates. */
const SHARED_CREDENTIALS = [
  {
    apiKey: 'k1',
    baseUrl: 'http://upstream-one.test',
    models: [
      { name: 'up-one', alias: 'alias-one' },
      { name: 'up-shared-1', alias: 'shared' },
    ],
  },
  {
    apiKey: 'k2',
    baseUrl: 'http://upstream-two.test',
    models: [
      { name: 'up-two', alias: 'alias-two' },
      { name: 'up-shared-2', alias: 'shared' },
    ],
  },
]

describe('createOai2GemService', () => {
  it('gates the Bearer credential with the S1 shapes', async () => {
    const service = createOai2GemService({ ...SERVICE_OPTIONS_BASE, store: new MemoryStore() })
    const missing = await service.handleChatCompletions(
      { ...chatRequest({ model: 'alias-one', messages: [] }), headers: [] },
      async () => {
        throw new Error('unreachable')
      },
    )
    expect(missing.status).toBe(401)
    expect(missing.body).toBe('{"error":"Missing API key"}')
    const invalid = await service.handleChatCompletions(
      { ...chatRequest({ model: 'alias-one', messages: [] }), headers: [['Authorization', 'Bearer nope']] },
      async () => {
        throw new Error('unreachable')
      },
    )
    expect(invalid.body).toBe('{"error":"Invalid API key"}')
    expect(headerOf(invalid.headers, 'x-cpa-trace-id')).toBeUndefined()
  })

  it('stays open with no configured keys', async () => {
    const service = createOai2GemService({ ...SERVICE_OPTIONS_BASE, apiKeys: [], store: new MemoryStore() })
    const response = await service.handleChatCompletions(chatRequest({ model: 'alias-one', messages: [{ role: 'user', content: 'hi' }] }), async () => ({
      status: 200,
      headers: [],
      body: jsonStream(JSON.stringify({ candidates: [] })),
    }))
    expect(response.status).toBe(200)
  })

  it('rejects malformed bodies and unknown models without dispatch', async () => {
    const service = createOai2GemService({ ...SERVICE_OPTIONS_BASE, store: new MemoryStore() })
    const malformed = await service.handleChatCompletions(chatRequest('{oops'), async () => {
      throw new Error('unreachable')
    })
    expect(malformed.status).toBe(400)
    expect(JSON.parse(String(malformed.body))).toEqual({ error: { message: expect.stringContaining('Invalid request:'), type: 'invalid_request_error' } })
    expect(headerOf(malformed.headers, 'x-cpa-trace-id')).toBeUndefined()

    const unknown = await service.handleChatCompletions(chatRequest({ model: 'nope', messages: [] }), async () => {
      throw new Error('unreachable')
    })
    expect(JSON.parse(String(unknown.body))).toEqual({
      error: { message: 'unknown provider for model nope', type: 'invalid_request_error', code: 'model_not_found', param: 'model' },
    })
  })

  it('normalizes the alt query on the upstream URL', async () => {
    const service = createOai2GemService({ ...SERVICE_OPTIONS_BASE, store: new MemoryStore() })
    const seen: string[] = []
    const send: Oai2GemUpstreamSender = async (request) => {
      seen.push(request.url)
      return { status: 200, headers: [], body: jsonStream(JSON.stringify({ candidates: [] })) }
    }
    await service.handleChatCompletions(chatRequest({ model: 'alias-one', messages: [{ role: 'user', content: 'x' }] }), send)
    await service.handleChatCompletions(chatRequest({ model: 'alias-one', messages: [{ role: 'user', content: 'x' }], stream: true }), send)
    await service.handleChatCompletions(chatRequest({ model: 'alias-one', messages: [{ role: 'user', content: 'x' }] }, '/v1/chat/completions?alt=foo'), send)
    await service.handleChatCompletions(chatRequest({ model: 'alias-one', messages: [{ role: 'user', content: 'x' }], stream: true }, '/v1/chat/completions?alt=sse'), send)
    await service.handleChatCompletions(chatRequest({ model: 'alias-one', messages: [{ role: 'user', content: 'x' }], stream: true }, '/v1/chat/completions?alt=bar'), send)
    expect(seen).toEqual([
      'http://upstream-one.test/v1beta/models/up-one:generateContent',
      'http://upstream-one.test/v1beta/models/up-one:streamGenerateContent?alt=sse',
      'http://upstream-one.test/v1beta/models/up-one:generateContent?$alt=foo',
      'http://upstream-one.test/v1beta/models/up-one:streamGenerateContent?alt=sse',
      'http://upstream-one.test/v1beta/models/up-one:streamGenerateContent?$alt=bar',
    ])
  })

  it('honors ?$alt as an alias of ?alt, plain alt winning (GetAlt semantics)', async () => {
    const service = createOai2GemService({ ...SERVICE_OPTIONS_BASE, store: new MemoryStore() })
    const seen: string[] = []
    const send: Oai2GemUpstreamSender = async (request) => {
      seen.push(request.url)
      return { status: 200, headers: [], body: jsonStream(JSON.stringify({ candidates: [] })) }
    }
    // alt=sse wins over $alt=json: the default sse handling applies.
    await service.handleChatCompletions(
      chatRequest({ model: 'alias-one', messages: [{ role: 'user', content: 'x' }] }, '/v1/chat/completions?alt=sse&$alt=json'),
      send,
    )
    await service.handleChatCompletions(
      chatRequest({ model: 'alias-one', messages: [{ role: 'user', content: 'x' }], stream: true }, '/v1/chat/completions?alt=sse&$alt=json'),
      send,
    )
    // $alt alone carries the non-sse value through as ?$alt=json.
    await service.handleChatCompletions(
      chatRequest({ model: 'alias-one', messages: [{ role: 'user', content: 'x' }] }, '/v1/chat/completions?$alt=json'),
      send,
    )
    await service.handleChatCompletions(
      chatRequest({ model: 'alias-one', messages: [{ role: 'user', content: 'x' }], stream: true }, '/v1/chat/completions?$alt=json'),
      send,
    )
    expect(seen).toEqual([
      'http://upstream-one.test/v1beta/models/up-one:generateContent',
      'http://upstream-one.test/v1beta/models/up-one:streamGenerateContent?alt=sse',
      'http://upstream-one.test/v1beta/models/up-one:generateContent?$alt=json',
      'http://upstream-one.test/v1beta/models/up-one:streamGenerateContent?$alt=json',
    ])
  })

  it('treats the string "true" as non-streaming (literal-true detection)', async () => {
    const service = createOai2GemService({ ...SERVICE_OPTIONS_BASE, store: new MemoryStore() })
    const seen: string[] = []
    const send: Oai2GemUpstreamSender = async (request) => {
      seen.push(request.url)
      return { status: 200, headers: [], body: jsonStream(JSON.stringify({ candidates: [] })) }
    }
    await service.handleChatCompletions(chatRequest({ model: 'alias-one', messages: [{ role: 'user', content: 'x' }], stream: 'true' }), send)
    expect(seen[0]).toContain(':generateContent')
  })

  it('passes a non-JSON upstream error through verbatim with a trace header', async () => {
    const service = createOai2GemService({ ...SERVICE_OPTIONS_BASE, store: new MemoryStore() })
    const response = await service.handleChatCompletions(chatRequest({ model: 'alias-one', messages: [{ role: 'user', content: 'x' }] }), async () => ({
      status: 429,
      headers: [],
      body: jsonStream('  {"error": {"code": 429}} '),
    }))
    expect(response.status).toBe(429)
    expect(response.body).toBe('{"error": {"code": 429}}')
    expect(headerOf(response.headers, 'content-type')).toBe('application/json')
    expect(headerOf(response.headers, 'cache-control')).toBeUndefined()
    expect(headerOf(response.headers, 'x-cpa-trace-id')).toBeDefined()
  })

  it('wraps non-JSON upstream errors by status', async () => {
    const service = createOai2GemService({ ...SERVICE_OPTIONS_BASE, store: new MemoryStore() })
    const response = await service.handleChatCompletions(chatRequest({ model: 'alias-one', messages: [{ role: 'user', content: 'x' }] }), async () => ({
      status: 503,
      headers: [],
      body: jsonStream('maintenance'),
    }))
    expect(response.status).toBe(503)
    expect(JSON.parse(String(response.body))).toEqual({
      error: { message: 'maintenance', type: 'server_error', code: 'internal_server_error' },
    })
  })

  it('retries a pre-commit transport failure on the next credential', async () => {
    const service = createOai2GemService({
      ...SERVICE_OPTIONS_BASE,
      credentials: SHARED_CREDENTIALS,
      store: new MemoryStore(),
      requestRetry: 1,
    })
    const seen: string[] = []
    const response = await service.handleChatCompletions(chatRequest({ model: 'shared', messages: [{ role: 'user', content: 'x' }] }), async (request) => {
      seen.push(request.url)
      if (seen.length === 1) throw new Error('unexpected EOF')
      return { status: 200, headers: [], body: jsonStream(JSON.stringify({ candidates: [] })) }
    })
    expect(seen).toHaveLength(2)
    expect(seen[0]).toContain('upstream-one.test')
    expect(seen[1]).toContain('upstream-two.test')
    expect(response.status).toBe(200)
  })

  it('falls back to the 500 envelope when attempts are exhausted', async () => {
    const service = createOai2GemService({
      ...SERVICE_OPTIONS_BASE,
      credentials: SHARED_CREDENTIALS,
      store: new MemoryStore(),
      requestRetry: 1,
    })
    const response = await service.handleChatCompletions(chatRequest({ model: 'shared', messages: [{ role: 'user', content: 'x' }] }), async () => {
      throw new Error('unexpected EOF')
    })
    // The LAST attempt's outcome wins once the attempt budget is spent.
    expect(response.status).toBe(500)
    expect(JSON.parse(String(response.body))).toEqual({
      error: { message: 'unexpected EOF', type: 'server_error', code: 'internal_server_error' },
    })
  })

  it('serves from the second credential when the first is cooling, then surfaces the envelope', async () => {
    const store = new MemoryStore({ now: () => 1_789_507_015_000 })
    const service = createOai2GemService({
      ...SERVICE_OPTIONS_BASE,
      credentials: SHARED_CREDENTIALS,
      store,
      requestRetry: 0,
    })
    const seen: string[] = []
    const send: Oai2GemUpstreamSender = async (request) => {
      seen.push(request.url)
      if (seen.length <= 1) {
        return { status: 429, headers: [], body: jsonStream('{"error":"limited-one"}') }
      }
      if (seen.length === 2) {
        return { status: 200, headers: [], body: jsonStream(JSON.stringify({ candidates: [] })) }
      }
      return { status: 429, headers: [], body: jsonStream('{"error":"limited-two"}') }
    }
    const first = await service.handleChatCompletions(chatRequest({ model: 'shared', messages: [{ role: 'user', content: 'x' }] }), send)
    expect(first.status).toBe(429)
    expect(first.body).toBe('{"error":"limited-one"}')
    // The second credential still serves the same alias.
    const second = await service.handleChatCompletions(chatRequest({ model: 'shared', messages: [{ role: 'user', content: 'x' }] }), send)
    expect(second.status).toBe(200)
    expect(seen[1]).toContain('upstream-two.test')
    // Its own 429 cools it too (still the verbatim pass-through)...
    const third = await service.handleChatCompletions(chatRequest({ model: 'shared', messages: [{ role: 'user', content: 'x' }] }), send)
    expect(third.status).toBe(429)
    expect(third.body).toBe('{"error":"limited-two"}')
    // ...and every credential now blocks the alias with the envelope.
    const fourth = await service.handleChatCompletions(chatRequest({ model: 'shared', messages: [{ role: 'user', content: 'x' }] }), send)
    expect(fourth.status).toBe(429)
    expect(headerOf(fourth.headers, 'retry-after')).toBe('1')
    expect(headerOf(fourth.headers, 'x-cpa-trace-id')).toBeUndefined()
    expect(JSON.parse(String(fourth.body))).toEqual({
      error: {
        code: 'model_cooldown',
        last_upstream_error: '{"error":"limited-two"}',
        message: 'All credentials for model shared are cooling down via provider gemini (last error: {"error":"limited-two"})',
        model: 'shared',
        provider: 'gemini',
        reset_seconds: 1,
        reset_time: '1s',
      },
    })
    // No upstream call happens while every credential cools.
    expect(seen).toHaveLength(3)
  })

  it('clears the window after a successful exchange', async () => {
    let nowMs = 1_789_507_015_000
    const store = new MemoryStore({ now: () => nowMs })
    const service = createOai2GemService({ ...SERVICE_OPTIONS_BASE, store, now: () => nowMs })
    let status = 429
    const send: Oai2GemUpstreamSender = async () => ({
      status,
      headers: [],
      body: jsonStream(status === 429 ? '{"error":"limited"}' : JSON.stringify({ candidates: [] })),
    })
    await service.handleChatCompletions(chatRequest({ model: 'alias-one', messages: [{ role: 'user', content: 'x' }] }), send)
    status = 200
    // Inside the window the request still surfaces the cooldown envelope.
    const blocked = await service.handleChatCompletions(chatRequest({ model: 'alias-one', messages: [{ role: 'user', content: 'x' }] }), send)
    expect(blocked.status).toBe(429)
    expect(String(blocked.body)).toContain('model_cooldown')
    // After the window melts, a success clears the recorded state.
    nowMs += 2_000
    await service.handleChatCompletions(chatRequest({ model: 'alias-one', messages: [{ role: 'user', content: 'x' }] }), send)
    const after = await service.handleChatCompletions(chatRequest({ model: 'alias-one', messages: [{ role: 'user', content: 'x' }] }), send)
    expect(after.status).toBe(200)
  })

  it('uses the upstream Retry-After hint floored at 10s and doubles after a still-open window', async () => {
    const store = new MemoryStore({ now: () => 1_789_507_015_000 })
    const service = createOai2GemService({ ...SERVICE_OPTIONS_BASE, store })
    const send: Oai2GemUpstreamSender = async () => ({
      status: 429,
      headers: [['Retry-After', '2']],
      body: jsonStream('{"error":"limited"}'),
    })
    await service.handleChatCompletions(chatRequest({ model: 'alias-one', messages: [{ role: 'user', content: 'x' }] }), send)
    const second = await service.handleChatCompletions(chatRequest({ model: 'alias-one', messages: [{ role: 'user', content: 'x' }] }), send)
    expect(headerOf(second.headers, 'retry-after')).toBe('10')
  })

  it('fails the cooldown gate open when the Store errors', async () => {
    const failingStore: MemoryStore = new MemoryStore({ now: () => 1_789_507_015_000 })
    const originalGet = failingStore.get.bind(failingStore)
    failingStore.get = async () => {
      throw new Error('store down')
    }
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const service = createOai2GemService({ ...SERVICE_OPTIONS_BASE, store: failingStore })
    const response = await service.handleChatCompletions(chatRequest({ model: 'alias-one', messages: [{ role: 'user', content: 'x' }] }), async () => ({
      status: 200,
      headers: [],
      body: jsonStream(JSON.stringify({ candidates: [] })),
    }))
    expect(response.status).toBe(200)
    failingStore.get = originalGet
    errorSpy.mockRestore()
  })

  it('resolves aliases case-insensitively', async () => {
    const service = createOai2GemService({ ...SERVICE_OPTIONS_BASE, store: new MemoryStore() })
    const seen: string[] = []
    const response = await service.handleChatCompletions(chatRequest({ model: 'ALIAS-ONE', messages: [{ role: 'user', content: 'x' }] }), async (request) => {
      seen.push(request.url)
      return { status: 200, headers: [], body: jsonStream(JSON.stringify({ candidates: [] })) }
    })
    expect(response.status).toBe(200)
    expect(seen[0]).toContain('up-one')
  })

  it('commits SSE only after the first translated chunk and appends [DONE] on clean EOF', async () => {
    const service = createOai2GemService({ ...SERVICE_OPTIONS_BASE, store: new MemoryStore() })
    const upstreamText = [
      'event: ping',
      'data: {"candidates":[{"content":{"parts":[{"text":"one"}],"role":"model"},"index":0}]}',
      '',
      'data: {"candidates":[{"content":{"parts":[],"role":"model"},"finishReason":"STOP","index":0}],"usageMetadata":{"promptTokenCount":4,"candidatesTokenCount":2,"totalTokenCount":6},"modelVersion":"up-one"}',
      '',
    ].join('\n')
    const response = await service.handleChatCompletions(
      chatRequest({ model: 'alias-one', messages: [{ role: 'user', content: 'x' }], stream: true }),
      async () => ({ status: 200, headers: [], body: jsonStream(upstreamText) }),
    )
    expect(response.status).toBe(200)
    expect(response.headers.map(([name]) => name), 'recorded SSE commit order (T4 F2)').toEqual([
      'Cache-Control',
      'Connection',
      'Content-Type',
      'X-Cpa-Trace-Id',
    ])
    expect(headerOf(response.headers, 'content-type')).toBe('text/event-stream')
    expect(headerOf(response.headers, 'cache-control')).toBe('no-cache')
    expect(headerOf(response.headers, 'x-cpa-trace-id')).toBeDefined()
    const body = await bodyOf(response.body)
    expect(body.endsWith('data: [DONE]\n\n')).toBe(true)
    expect(body).toContain('"model":"model"')
    expect(body).toContain('"finish_reason":"stop"')
  })

  it('sends only the [DONE] frame when the stream produces no data', async () => {
    const service = createOai2GemService({ ...SERVICE_OPTIONS_BASE, store: new MemoryStore() })
    const response = await service.handleChatCompletions(
      chatRequest({ model: 'alias-one', messages: [{ role: 'user', content: 'x' }], stream: true }),
      async () => ({ status: 200, headers: [], body: jsonStream('') }),
    )
    expect(response.status).toBe(200)
    expect(await bodyOf(response.body)).toBe('data: [DONE]\n\n')
  })

  it('renders a plain JSON error when the upstream fails before the first chunk', async () => {
    const service = createOai2GemService({ ...SERVICE_OPTIONS_BASE, store: new MemoryStore() })
    const response = await service.handleChatCompletions(
      chatRequest({ model: 'alias-one', messages: [{ role: 'user', content: 'x' }], stream: true }),
      async () => ({ status: 429, headers: [], body: jsonStream('{"error": {"code": 429}}') }),
    )
    expect(response.status).toBe(429)
    expect(headerOf(response.headers, 'content-type')).toBe('application/json')
    expect(headerOf(response.headers, 'cache-control')).toBeUndefined()
  })

  it('appends the terminal error frame and no [DONE] on a mid-stream disconnect', async () => {
    const service = createOai2GemService({ ...SERVICE_OPTIONS_BASE, store: new MemoryStore() })
    let served = false
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!served) {
          served = true
          controller.enqueue(encoder.encode('data: {"candidates":[{"content":{"parts":[{"text":"one"}],"role":"model"},"index":0}]}\n\n'))
          return
        }
        controller.error(new Error('unexpected EOF'))
      },
    })
    const response = await service.handleChatCompletions(
      chatRequest({ model: 'alias-one', messages: [{ role: 'user', content: 'x' }], stream: true }),
      async () => ({ status: 200, headers: [], body: stream }),
    )
    const body = await bodyOf(response.body)
    expect(body.endsWith('data: {"error":{"message":"unexpected EOF","type":"server_error","code":"internal_server_error"}}\n\n')).toBe(true)
    expect(body).not.toContain('[DONE]')
  })

  it('rewrites every chunk model with force-mapping', async () => {
    const upstreamText = [
      'data: {"candidates":[{"content":{"parts":[{"text":"a"}],"role":"model"},"index":0}]}',
      '',
      'data: {"candidates":[{"content":{"parts":[],"role":"model"},"finishReason":"STOP","index":0}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1,"totalTokenCount":2},"modelVersion":"up-force"}',
      '',
    ].join('\n')
    const credentials = [
      { apiKey: 'k', baseUrl: 'http://up.test', models: [{ name: 'up-force', alias: 'alias-force', forceMapping: true }] },
    ]
    const forced = createOai2GemService({ ...SERVICE_OPTIONS_BASE, credentials, store: new MemoryStore() })
    const response = await forced.handleChatCompletions(
      chatRequest({ model: 'alias-force', messages: [{ role: 'user', content: 'x' }], stream: true }),
      async () => ({ status: 200, headers: [], body: jsonStream(upstreamText) }),
    )
    const body = await bodyOf(response.body)
    expect(body).not.toContain('"model":"model"')
    expect(body).not.toContain('"model":"up-force"')
    expect(body).toContain('"model":"alias-force"')
  })

  it('parses data URLs for media parts', () => {
    expect(parseDataUrl('data:image/png;base64,AA')).toEqual({ mediaType: 'image/png', data: 'AA' })
    expect(parseDataUrl('data:,raw')).toEqual({ mediaType: 'application/octet-stream', data: 'raw' })
    expect(parseDataUrl('http://x/y.png')).toBeUndefined()
    expect(parseDataUrl('data:nocolon')).toBeUndefined()
  })
})
