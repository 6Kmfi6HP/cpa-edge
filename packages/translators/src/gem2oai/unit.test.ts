/**
 * Unit coverage for rules the golden replay touches only once or not at
 * all: the full thinking clamp/400 table, the countTokens formula pieces
 * and tokenizer selection, tool-id determinism and FIFO pairing, the
 * alt-framing matrix, in-stream terminal errors, cooldown windows and
 * escalation, the auth-transport surface, model discovery asymmetries and
 * the upstream header policy.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CpaError, MemoryStore } from '@cpa-edge/core'
import type { Store } from '@cpa-edge/core'
import {
  applyRequestThinking,
  convertBudgetToLevel,
  effectiveThinkingLevel,
  extractSourceThinkingConfig,
} from './thinking'
import { deriveToolCallId, translateGeminiRequest, translateGeminiToOpenAI } from './request'
import {
  extractReasoningTexts,
  mapFinishReason,
  parseToolArguments,
  translateOpenAIResponseToGeminiNonStream,
  usageMetadata,
} from './response'
import {
  OpenAIChunkTranslator,
  frameDownstreamEvent,
  framingForAlt,
  isUpstreamErrorPayload,
  translateOpenAIStreamToGemini,
} from './stream'
import { countTranslatedBodyTokens, encodingForUpstreamModel, renderCountTokensResponse } from './count'
import {
  INVALID_API_KEY_BODY,
  MISSING_API_KEY_BODY,
  actionNotFoundBody,
  buildModelCooldownResponse,
  classifyUpstreamError,
  isTpmRateLimitBody,
  modelNotFoundBody,
  openAIErrorBody,
  parseRetryAfterSeconds,
  renderGatewayError,
  transportErrorMessage,
  upstreamErrorSummary,
  wrapTypeForStatus,
} from './errors'
import { parseModelMethod, rawModelRecord, renderModelsList, splitV1BetaPath } from './models'
import { authenticateV1Beta, extractClientCredentials } from './auth'
import type { Gem2OaiRegistryEntry } from './models'
import { createGem2OaiService, openAICompatUserAgent } from './service'
import type {
  Gem2OaiCredential,
  Gem2OaiRequest,
  Gem2OaiResponse,
  Gem2OaiService,
  Gem2OaiUpstreamRequest,
  Gem2OaiUpstreamResponse,
  Gem2OaiUpstreamSender,
} from './service'
import type { HeaderList } from './types'

const UPSTREAM_MODEL = 'mock-gpt-model'
const BASE_URL = 'http://mock.internal:20999/v1'

const encoder = new TextEncoder()

function credential(overrides: Partial<Gem2OaiCredential> = {}): Gem2OaiCredential {
  return {
    name: 'mock-openai',
    apiKey: 'mock-upstream-key',
    baseUrl: BASE_URL,
    models: [{ name: UPSTREAM_MODEL, alias: 'mock-model' }],
    ...overrides,
  }
}

interface FacadeOptions {
  readonly store?: Store
  readonly now?: () => number
  readonly credentials?: readonly Gem2OaiCredential[]
  readonly registry?: readonly Gem2OaiRegistryEntry[]
  readonly apiKeys?: readonly string[]
  readonly requestRetry?: number
}

function facade(options: FacadeOptions = {}): Gem2OaiService {
  return createGem2OaiService({
    credentials: options.credentials ?? [credential()],
    registry: options.registry ?? [{ id: 'mock-model', displayName: 'mock-model' }],
    apiKeys: options.apiKeys ?? ['oracle-local-key-1'],
    store: options.store ?? new MemoryStore(),
    now: options.now ?? (() => 1_789_492_684_000),
    requestRetry: options.requestRetry ?? 0,
    transientErrorCooldownSeconds: -1,
  })
}

function request(path: string, body: string, headers: HeaderList = [['x-goog-api-key', 'oracle-local-key-1']]): Gem2OaiRequest {
  return { method: 'POST', path, headers, body }
}

function staticBody(text: string, status = 200): Gem2OaiUpstreamResponse {
  return { status, headers: [], body: new Response(text).body as ReadableStream<Uint8Array> }
}

function staticJson(value: unknown, status = 200): Gem2OaiUpstreamResponse {
  return staticBody(JSON.stringify(value), status)
}

function byteStream(chunks: readonly string[]): ReadableStream<Uint8Array> {
  let index = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index]
      index += 1
      if (chunk === undefined) {
        controller.close()
        return
      }
      controller.enqueue(encoder.encode(chunk))
    },
  })
}

async function readBody(body: Gem2OaiResponse['body']): Promise<string> {
  if (typeof body === 'string') return body
  const reader = (body as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  let out = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value !== undefined) out += decoder.decode(value, { stream: true })
  }
  return out + decoder.decode()
}

function headerOf(response: Gem2OaiResponse, name: string): string | undefined {
  const key = name.toLowerCase()
  for (const [headerName, value] of response.headers) {
    if (headerName.toLowerCase() === key) return value
  }
  return undefined
}

async function translate(body: unknown, stream = false): Promise<Record<string, unknown>> {
  const result = await translateGeminiRequest(JSON.stringify(body), {
    upstreamModel: UPSTREAM_MODEL,
    stream,
  })
  return JSON.parse(result.body) as Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Thinking pipeline (section 3.3)
// ---------------------------------------------------------------------------

describe('thinking — stage 1 conversion', () => {
  it('maps budgets to ladder levels', () => {
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
    expect(convertBudgetToLevel(100000)).toBe('xhigh')
    expect(convertBudgetToLevel(-5)).toBeUndefined()
  })

  it('stage 1 writes the raw level; stage 2 rewrites in place', async () => {
    const body = '{"contents":[{"role":"user","parts":[{"text":"hi"}]}],"generationConfig":{"thinkingConfig":{"thinkingLevel":"AUTO"}}}'
    const stage1 = await translateGeminiToOpenAI(body, { upstreamModel: UPSTREAM_MODEL, stream: false })
    expect((JSON.parse(stage1.body) as Record<string, unknown>)['reasoning_effort']).toBe('auto')

    const effective = await translateGeminiRequest(body, { upstreamModel: UPSTREAM_MODEL, stream: false })
    const value = JSON.parse(effective.body) as Record<string, unknown>
    expect(value['reasoning_effort']).toBe('medium')
    // Key position preserved: reasoning_effort sits before `stream`.
    expect(Object.keys(value)).toEqual(['model', 'messages', 'reasoning_effort', 'stream'])
  })

  it('reads the snake_case variants of the thinking keys', () => {
    const camel = extractSourceThinkingConfig({
      generationConfig: { thinkingConfig: { thinkingLevel: 'High ', thinkingBudget: 10 } },
    })
    expect(camel.level).toBe('high')
    expect(camel.budget).toBe(10)
    const snake = extractSourceThinkingConfig({
      generationConfig: { thinkingConfig: { thinking_level: 'low', thinking_budget: 300 } },
    })
    expect(snake.level).toBe('low')
    expect(snake.budget).toBe(300)
    expect(extractSourceThinkingConfig({ generationConfig: {} })).toEqual({})
    expect(extractSourceThinkingConfig({})).toEqual({})
  })
})

describe('thinking — effective level table (stage 2)', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['low', 'low'],
    ['medium', 'medium'],
    ['high', 'high'],
    ['auto', 'medium'],
    ['none', 'low'],
    ['minimal', 'low'],
    ['xhigh', 'high'],
    ['max', 'high'],
  ]
  for (const [input, expected] of cases) {
    it(`level "${input}" -> "${expected}"`, () => {
      expect(effectiveThinkingLevel(input)).toBe(expected)
    })
  }

  it('non-canonical levels fail with the recorded message', () => {
    expect(() => effectiveThinkingLevel('ultra')).toThrow(CpaError)
    try {
      effectiveThinkingLevel('ultra')
    } catch (error) {
      expect((error as CpaError).message).toBe('level "ultra" not supported, valid levels: low, medium, high')
      expect((error as CpaError).code).toBe('invalid-input')
    }
  })

  it('budgets map through the ladder and clamp', async () => {
    for (const [budget, expected] of [
      [-1, 'medium'],
      [0, 'low'],
      [100, 'low'],
      [1024, 'low'],
      [1025, 'medium'],
      [2048, 'medium'],
      [8192, 'medium'],
      [8193, 'high'],
      [24577, 'high'],
      [30000, 'high'],
    ] as const) {
      const body = await translate({
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        generationConfig: { thinkingConfig: { thinkingBudget: budget } },
      })
      expect(body['reasoning_effort'], `budget ${budget}`).toBe(expected)
    }
  })

  it('unconvertible budgets fail with the recorded message', () => {
    const body = { reasoning_effort: '' }
    expect(() => applyRequestThinking(body, { generationConfig: { thinkingConfig: { thinkingBudget: -5 } } })).toThrow(
      CpaError,
    )
    try {
      applyRequestThinking(body, { generationConfig: { thinkingConfig: { thinkingBudget: -5 } } })
    } catch (error) {
      expect((error as CpaError).message).toBe('budget -5 cannot be converted to a valid level')
    }
  })

  it('a custom levels capability clamps to its own range', () => {
    expect(effectiveThinkingLevel('max', { levels: ['low', 'medium'] })).toBe('medium')
    expect(effectiveThinkingLevel('none', { levels: ['low', 'medium'] })).toBe('low')
    expect(effectiveThinkingLevel('none', { levels: ['low', 'medium'], disableAllowed: true })).toBeUndefined()
    expect(effectiveThinkingLevel('auto', { levels: ['low', 'medium', 'high', 'xhigh'] })).toBe('high')
    try {
      effectiveThinkingLevel('ultra', { levels: ['minimal', 'low'] })
      expect.unreachable('non-canonical level must fail')
    } catch (error) {
      expect((error as CpaError).message).toBe('level "ultra" not supported, valid levels: minimal, low')
    }
  })

  it('the level key wins over the budget key in both stages', async () => {
    const body = await translate({
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      generationConfig: { thinkingConfig: { thinkingLevel: 'low', thinkingBudget: 30000 } },
    })
    expect(body['reasoning_effort']).toBe('low')
  })

  it('facade renders the thinking 400s on generateContent and countTokens', async () => {
    const service = facade()
    const bad = JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      generationConfig: { thinkingConfig: { thinkingLevel: 'ultra' } },
    })
    const generate = await service.handleV1Beta(request('/v1beta/models/mock-model:generateContent', bad), async () => {
      throw new Error('must not be called')
    })
    expect(generate.status).toBe(400)
    expect(generate.body).toBe(openAIErrorBody('level "ultra" not supported, valid levels: low, medium, high', 'invalid_request_error'))
    expect(headerOf(generate, 'content-type')).toBe('application/json')
    expect(headerOf(generate, 'x-cpa-trace-id')).toBeDefined()

    const count = await service.handleV1Beta(request('/v1beta/models/mock-model:countTokens', bad), async () => {
      throw new Error('must not be called')
    })
    expect(count.status).toBe(400)
    expect(count.body).toBe(generate.body)

    const budget = await service.handleV1Beta(
      request(
        '/v1beta/models/mock-model:countTokens',
        JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
          generationConfig: { thinkingConfig: { thinkingBudget: -100 } },
        }),
      ),
      async () => {
        throw new Error('must not be called')
      },
    )
    expect(budget.status).toBe(400)
    expect(budget.body).toBe(openAIErrorBody('budget -100 cannot be converted to a valid level', 'invalid_request_error'))
  })
})

// ---------------------------------------------------------------------------
// Request translation units (section 3.1)
// ---------------------------------------------------------------------------

describe('request translation — contents rules', () => {
  it('maps roles and concatenates text-only turns', async () => {
    const body = await translate({
      contents: [
        { role: 'model', parts: [{ text: 'Hi' }] },
        { role: 'user', parts: [{ text: 'a' }, { text: 'b' }] },
        { role: 'function', parts: [{ text: 'r' }] },
        { role: 'weird-role', parts: [{ text: 'x' }] },
      ],
    })
    expect(body['messages']).toEqual([
      { role: 'assistant', content: 'Hi' },
      { role: 'user', content: 'ab' },
      { role: 'function', content: 'r' },
      { role: 'weird-role', content: 'x' },
    ])
  })

  it('drops thought parts and thought-only turns entirely', async () => {
    const body = await translate({
      contents: [
        { role: 'user', parts: [{ thought: true, text: 'hidden' }] },
        { role: 'user', parts: [{ text: 'visible' }] },
        { role: 'user', parts: [{ thought: true, text: 'a' }, { text: 'b' }] },
      ],
    })
    expect(body['messages']).toEqual([
      { role: 'user', content: 'visible' },
      { role: 'user', content: 'b' },
    ])
  })

  it('mixed turns render an ordered content array', async () => {
    const body = await translate({
      contents: [
        {
          role: 'user',
          parts: [
            { text: 'look' },
            { inlineData: { mimeType: 'image/png', data: 'aGk=' } },
            { text: 'and listen' },
            { inlineData: { mimeType: 'audio/ogg', data: 'QUdH' } },
          ],
        },
      ],
    })
    expect(body['messages']).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,aGk=' } },
          { type: 'text', text: 'and listen' },
          { type: 'input_audio', input_audio: { data: 'QUdH', format: 'opus' } },
        ],
      },
    ])
  })

  it('empty turns still emit an empty-content message', async () => {
    const body = await translate({ contents: [{ role: 'user', parts: [] }, { role: 'assistant' }] })
    expect(body['messages']).toEqual([
      { role: 'user', content: '' },
      { role: 'assistant', content: '' },
    ])
  })

  it('inline data covers audio formats, video and the file branch', async () => {
    const body = await translate({
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType: 'audio/wave', data: 'A' } },
            { inlineData: { mimeType: 'audio/x-wav', data: 'A' } },
            { inlineData: { mimeType: 'audio/flac', data: 'A' } },
            { inlineData: { mimeType: 'audio/pcm', data: 'A' } },
            { inlineData: { mimeType: 'audio/l16', data: 'A' } },
            { inlineData: { mimeType: 'audio/mp3', data: 'A' } },
            { inlineData: { mimeType: 'video/mp4', data: 'A' } },
            { inlineData: { mimeType: '', data: 'A' } },
            { inlineData: { mimeType: 'application/pdf', data: 'A' } },
            { inlineData: { mimeType: 'text/csv', data: 'A' } },
            { inlineData: { mimeType: 'weird/thing', data: 'A' } },
            { inlineData: { mimeType: 'image/png', data: '' } },
          ],
        },
      ],
    })
    const content = (body['messages'] as Record<string, unknown>[])[0]?.['content'] as Record<string, unknown>[]
    expect(
      content.map((part) =>
        part['input_audio'] !== undefined ? (part['input_audio'] as Record<string, unknown>)['format'] : null,
      ),
    ).toEqual([
      'wav',
      'wav',
      'flac',
      'pcm16',
      'pcm16',
      'mp3',
      null, // video/mp4 -> video_url
      null, // empty mime -> octet-stream file part
      null, // application/pdf -> file part
      null, // text/csv -> file part
      null, // weird mime -> octet-stream file part
    ])
    const video = content[6] as Record<string, unknown>
    expect(video['type']).toBe('video_url')
    const fileOctet = content[7] as Record<string, unknown>
    expect(fileOctet['type']).toBe('file')
    expect(fileOctet['file']).toEqual({ filename: 'document', file_data: 'A' })
    const filePdf = content[8] as Record<string, unknown>
    expect(filePdf['file']).toEqual({ filename: 'document.pdf', file_data: 'A' })
    const fileCsv = content[9] as Record<string, unknown>
    expect(fileCsv['file']).toEqual({ filename: 'document.csv', file_data: 'A' })
    const fileWeird = content[10] as Record<string, unknown>
    expect(fileWeird['file']).toEqual({ filename: 'document', file_data: 'A' })
    expect(content[11]).toBeUndefined()
  })

  it('fileData covers url passthrough, file parts and the text fallback', async () => {
    const body = await translate({
      contents: [
        {
          role: 'user',
          parts: [
            { fileData: { fileUri: 'https://x/y.png', mimeType: 'image/png' } },
            { fileData: { fileUri: 'https://x/y.mp4', mimeType: 'video/mp4' } },
            { fileData: { fileUri: 'https://x/doc.pdf', mimeType: 'application/pdf' } },
            { fileData: { fileUri: 'https://x/f', mimeType: 'weird/thing' } },
            { fileData: { fileUri: 'https://x/f' } },
            { fileData: { fileUri: '', mimeType: 'image/png' } },
          ],
        },
      ],
    })
    const content = (body['messages'] as Record<string, unknown>[])[0]?.['content'] as Record<string, unknown>[]
    expect(content[0]).toEqual({ type: 'image_url', image_url: { url: 'https://x/y.png' } })
    expect(content[1]).toEqual({ type: 'video_url', video_url: { url: 'https://x/y.mp4' } })
    expect(content[2]).toEqual({ type: 'file', file: { filename: 'document.pdf', file_url: 'https://x/doc.pdf' } })
    expect(content[3]).toEqual({ type: 'text', text: 'File: https://x/f (Type: weird/thing)' })
    expect(content[4]).toEqual({ type: 'text', text: 'File: https://x/f' })
    expect(content[5]).toBeUndefined()
  })

  it('system instruction uses the parts array form for both key spellings', async () => {
    for (const key of ['systemInstruction', 'system_instruction']) {
      const body = await translate({ [key]: { parts: [{ text: 'be kind' }, { thought: true, text: 'hidden' }] } })
      expect(body['messages']).toEqual([{ role: 'system', content: [{ type: 'text', text: 'be kind' }] }])
    }
  })

  it('generationConfig maps with the recorded key order and drop rules', async () => {
    const body = await translate({
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      generationConfig: {
        temperature: 0.5,
        maxOutputTokens: 128,
        topP: 0.9,
        topK: 4,
        stopSequences: ['END', 'STOP'],
        candidateCount: 2,
        responseModalities: ['TEXT', 'Audio', 'VIDEO'],
      },
      safetySettings: [{ category: 'HARM' }],
      labels: { k: 'v' },
      cachedContent: 'x',
      frequencyPenalty: 1,
      seed: 3,
    })
    expect(Object.keys(body)).toEqual(['model', 'messages', 'temperature', 'max_tokens', 'top_p', 'top_k', 'stop', 'n', 'modalities', 'stream'])
    expect(body['modalities']).toEqual(['text', 'audio'])
    expect(body['safetySettings']).toBeUndefined()
    expect(body['seed']).toBeUndefined()
  })

  it('stop filters non-strings and drops when empty; service_tier passes through', async () => {
    const body = await translate({
      contents: [],
      generationConfig: { stopSequences: [1, 'END'] },
      service_tier: 'flex',
    })
    expect(body['stop']).toEqual(['END'])
    expect(body['service_tier']).toBe('flex')
    const empty = await translate({ contents: [], generationConfig: { stopSequences: [1, 2] }, service_tier: 5 })
    expect(empty['stop']).toBeUndefined()
    expect(empty['service_tier']).toBeUndefined()
  })

  it('toolConfig maps the four variants and drops unknown modes', async () => {
    const tools = [{ functionDeclarations: [{ name: 'a' }, { name: 'b' }] }]
    const cases: ReadonlyArray<readonly [unknown, unknown]> = [
      [{ mode: 'NONE' }, 'none'],
      [{ mode: 'AUTO' }, 'auto'],
      [{ mode: 'ANY', allowedFunctionNames: ['a'] }, { type: 'function', function: { name: 'a' } }],
      [{ mode: 'ANY', allowedFunctionNames: ['a', 'b'] }, 'required'],
      [{ mode: 'ANY' }, 'required'],
      [{ mode: 'WEIRD' }, undefined],
    ]
    for (const [config, expected] of cases) {
      const body = await translate({ contents: [], tools, toolConfig: { functionCallingConfig: config } })
      expect(body['tool_choice'], JSON.stringify(config)).toEqual(expected)
    }
    const absent = await translate({ contents: [], tools })
    expect(absent['tool_choice']).toBeUndefined()
  })

  it('tools keep the client parameter key order and fall back to parametersJsonSchema', async () => {
    const body = await translate({
      contents: [],
      tools: [
        { googleSearch: {} },
        { functionDeclarations: [{ name: 'json', parametersJsonSchema: { b: 1, a: 2 } }] },
      ],
    })
    expect(body['tools']).toEqual([
      { type: 'function', function: { name: 'json', description: '', parameters: { b: 1, a: 2 } } },
    ])
  })

  it('malformed bodies are rejected with 400 (strict boundary)', async () => {
    const service = facade()
    const response = await service.handleV1Beta(request('/v1beta/models/mock-model:generateContent', '{"contents": '), async () => {
      throw new Error('must not be called')
    })
    expect(response.status).toBe(400)
    expect(response.body).toBe(openAIErrorBody('Invalid request: malformed JSON body', 'invalid_request_error'))
  })
})

// ---------------------------------------------------------------------------
// Tool ids + pairing (section 3.1.1)
// ---------------------------------------------------------------------------

describe('tool-call ids and function responses', () => {
  it('derives the recorded deterministic id from raw args bytes', async () => {
    const id = await deriveToolCallId('call', 1, 0, 'read_file', '{"path":"a.txt"}')
    expect(id).toBe('call_afc3091cba33b0e168fe2b6d')
  })

  it('hash args spacing verbatim: whitespace changes the id', async () => {
    const compact = await deriveToolCallId('call', 0, 0, 'f', '{"a":1}')
    const spaced = await deriveToolCallId('call', 0, 0, 'f', '{"a": 1}')
    expect(compact).not.toBe(spaced)
  })

  it('uses explicit ids, queues them and pairs responses FIFO', async () => {
    const body = await translate({
      contents: [
        { role: 'model', parts: [{ functionCall: { id: 'x1', name: 'f', args: {} } }, { functionCall: { name: 'f', args: {} } }] },
        { role: 'function', parts: [{ functionResponse: { name: 'f', response: { ok: 1 } } }, { functionResponse: { id: 'x1', name: 'f', response: { done: true } } }] },
      ],
    })
    const messages = body['messages'] as Record<string, unknown>[]
    const assistant = messages[0] as Record<string, unknown>
    const calls = assistant['tool_calls'] as Record<string, unknown>[]
    expect((calls[0] as Record<string, unknown>)['id']).toBe('x1')
    const generated = (calls[1] as Record<string, unknown>)['id'] as string
    expect(generated.startsWith('call_')).toBe(true)
    // First response has no id: it takes the OLDEST queued id (the explicit
    // x1); the second declares x1, removing it from the queue again.
    const tool1 = messages[1] as Record<string, unknown>
    expect(tool1['tool_call_id']).toBe('x1')
    const tool2 = messages[2] as Record<string, unknown>
    expect(tool2['tool_call_id']).toBe('x1')
    const tail = messages[3] as Record<string, unknown>
    expect(tail).toEqual({ role: 'function', content: '' })
  })

  it('stringifies response content, else the whole response, with sorted keys', async () => {
    const body = await translate({
      contents: [
        { role: 'model', parts: [{ functionCall: { id: 'a', name: 'f', args: {} } }] },
        {
          role: 'function',
          parts: [
            { functionResponse: { name: 'f', response: { z: 1, a: 2 } } },
            { functionResponse: { name: 'f', response: { content: { y: 1, b: 2 } } } },
            { functionResponse: { name: 'f', response: { content: 'plain' } } },
          ],
        },
      ],
    })
    const messages = body['messages'] as Record<string, unknown>[]
    expect(messages[1]?.['content']).toBe('{"a":2,"z":1}')
    expect(messages[2]?.['content']).toBe('{"b":2,"y":1}')
    expect(messages[3]?.['content']).toBe('"plain"')
  })

  it('the response-id fallback derives from raw response bytes', async () => {
    const body = await translate({
      contents: [{ role: 'function', parts: [{ functionResponse: { name: 'f', response: { result: 'a' } } }] }],
    })
    const fallback = await deriveToolCallId('response', 0, 0, 'f', '{"result":"a"}')
    const messages = body['messages'] as Record<string, unknown>[]
    expect(messages[0]?.['tool_call_id']).toBe(fallback)
  })

  it('turn index counts dropped thought-only turns', async () => {
    const seed = { contents: [{ role: 'user', parts: [{ functionCall: { name: 'f', args: {} } }] }] }
    const withThoughtTurn = {
      contents: [{ role: 'user', parts: [{ thought: true, text: 'x' }] }, { role: 'user', parts: [{ functionCall: { name: 'f', args: {} } }] }],
    }
    const idPlain = await translateGeminiToOpenAI(JSON.stringify(seed), { upstreamModel: UPSTREAM_MODEL, stream: false })
    const idShifted = await translateGeminiToOpenAI(JSON.stringify(withThoughtTurn), { upstreamModel: UPSTREAM_MODEL, stream: false })
    const callsPlain = ((JSON.parse(idPlain.body) as Record<string, unknown>)['messages'] as Record<string, unknown>[])[0]?.['tool_calls'] as Record<string, unknown>[]
    const callsShifted = ((JSON.parse(idShifted.body) as Record<string, unknown>)['messages'] as Record<string, unknown>[])[0]?.['tool_calls'] as Record<string, unknown>[]
    expect((callsPlain[0] as Record<string, unknown>)['id']).not.toBe((callsShifted[0] as Record<string, unknown>)['id'])
  })
})

// ---------------------------------------------------------------------------
// Response translation units (section 3.2)
// ---------------------------------------------------------------------------

describe('response translation — non-stream', () => {
  it('maps the finish-reason table', () => {
    expect(mapFinishReason('stop')).toBe('STOP')
    expect(mapFinishReason('length')).toBe('MAX_TOKENS')
    expect(mapFinishReason('tool_calls')).toBe('STOP')
    expect(mapFinishReason('content_filter')).toBe('SAFETY')
    expect(mapFinishReason('whatever')).toBe('STOP')
  })

  it('extracts reasoning texts from string, array and object shapes', () => {
    expect(extractReasoningTexts('one')).toEqual(['one'])
    expect(extractReasoningTexts('')).toEqual([])
    expect(extractReasoningTexts(['a', { text: 'b' }, { nope: 1 }, ''])).toEqual(['a', 'b'])
    expect(extractReasoningTexts({ text: 'c' })).toEqual(['c'])
    expect(extractReasoningTexts({ other: 1 })).toEqual([])
    expect(extractReasoningTexts(5)).toEqual([])
  })

  it('parses tool arguments with sorted keys and a {} fallback', () => {
    expect(parseToolArguments('{"b":1,"a":{"z":1,"b":2}}')).toEqual({ a: { b: 2, z: 1 }, b: 1 })
    expect(parseToolArguments('')).toEqual({})
    expect(parseToolArguments('not json')).toEqual({})
    expect(parseToolArguments('[1,2]')).toEqual({})
  })

  it('usageMetadata follows the recorded key order and detail rules', () => {
    const usage = usageMetadata({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 99,
      completion_tokens_details: { reasoning_tokens: 0 },
      prompt_tokens_details: { cached_tokens: 3 },
    })
    expect(JSON.stringify(usage)).toBe(
      '{"promptTokenCount":10,"candidatesTokenCount":5,"totalTokenCount":99,"cachedContentTokenCount":3}',
    )
    expect(usageMetadata({ input_tokens: 1, output_tokens: 2 })).toEqual({
      promptTokenCount: 1,
      candidatesTokenCount: 2,
      totalTokenCount: 3,
    })
    expect(usageMetadata(undefined)).toBeUndefined()
    expect(usageMetadata({})).toBeUndefined()
  })

  it('builds the envelope with thought parts first, content, then tool calls', () => {
    const body = translateOpenAIResponseToGeminiNonStream(
      JSON.stringify({
        model: 'mock-gpt-model',
        choices: [
          {
            index: 3,
            message: {
              role: 'assistant',
              content: 'answer',
              reasoning_content: ['step one', 'step two'],
              tool_calls: [
                { id: 'c1', type: 'function', function: { name: 'f', arguments: '{"b":1,"a":2}' } },
                { id: '', type: 'function', function: { name: 'g', arguments: 'bad' } },
                { type: 'web_search', function: { name: 'x' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      }),
      { streamModel: 'mock-gpt-model' },
    )
    expect(JSON.parse(body)).toEqual({
      candidates: [
        {
          content: {
            parts: [
              { thought: true, text: 'step one' },
              { thought: true, text: 'step two' },
              { text: 'answer' },
              { functionCall: { id: 'c1', name: 'f', args: { a: 2, b: 1 } } },
              { functionCall: { name: 'g', args: {} } },
            ],
            role: 'model',
          },
          index: 3,
          finishReason: 'STOP',
        },
      ],
      model: 'mock-gpt-model',
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 },
    })
  })

  it('multi-choice overlays merge into one candidate with the last index', () => {
    const body = translateOpenAIResponseToGeminiNonStream(
      JSON.stringify({
        model: 'm',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'a' }, finish_reason: 'stop' },
          { index: 1, message: { role: 'assistant', content: 'b' }, finish_reason: 'length' },
        ],
      }),
      { streamModel: 'm' },
    )
    expect(JSON.parse(body)).toEqual({
      candidates: [
        {
          content: { parts: [{ text: 'a' }, { text: 'b' }], role: 'model' },
          index: 1,
          finishReason: 'MAX_TOKENS',
        },
      ],
      model: 'm',
    })
  })

  it('force-mapping rewrites the response model to the client alias', () => {
    const body = translateOpenAIResponseToGeminiNonStream(
      JSON.stringify({ model: 'upstream-name', choices: [{ index: 0, message: { role: 'assistant', content: 'x' } }] }),
      { streamModel: 'upstream-name', forceMappingModel: 'alias' },
    )
    expect((JSON.parse(body) as Record<string, unknown>)['model']).toBe('alias')
  })
})

// ---------------------------------------------------------------------------
// Stream mapping + framing (sections 4.1-4.2)
// ---------------------------------------------------------------------------

describe('stream — chunk mapping', () => {
  const ctx = { streamModel: 'mock-gpt-model' }

  function chunk(delta: unknown, finish?: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      model: 'mock-gpt-model',
      choices: [{ index: 0, delta, finish_reason: finish ?? null }],
      ...extra,
    }
  }

  it('drops role-only chunks and maps content deltas', () => {
    const translator = new OpenAIChunkTranslator(ctx)
    expect(translator.translateChunk(chunk({ role: 'assistant' }))).toEqual([])
    const [text] = translator.translateChunk(chunk({ content: 'Hi' })) as string[]
    expect(JSON.parse(text ?? '')).toEqual({
      candidates: [{ content: { parts: [{ text: 'Hi' }], role: 'model' }, index: 0 }],
      model: 'mock-gpt-model',
    })
  })

  it('reasoning deltas become thought frames; a content frame on the same chunk follows them', () => {
    const translator = new OpenAIChunkTranslator(ctx)
    const frames = translator.translateChunk(chunk({ reasoning_content: 'think', content: 'say' })) as string[]
    expect(frames.length).toBe(2)
    expect(JSON.parse(frames[0] ?? '')).toEqual({
      candidates: [{ content: { parts: [{ thought: true, text: 'think' }], role: 'model' }, index: 0 }],
      model: 'mock-gpt-model',
    })
    expect(JSON.parse(frames[1] ?? '')).toEqual({
      candidates: [{ content: { parts: [{ text: 'say' }], role: 'model' }, index: 0 }],
      model: 'mock-gpt-model',
    })
  })

  it('tool deltas buffer silently and flush once on the finish frame (Q8: content+finish loses finish)', () => {
    const translator = new OpenAIChunkTranslator(ctx)
    expect(translator.translateChunk(chunk({ tool_calls: [{ index: 0, id: 'x', type: 'function', function: { name: 'f', arguments: '' } }] }))).toEqual([])
    translator.translateChunk(chunk({ tool_calls: [{ index: 0, function: { arguments: '{"a"' } }] }))
    translator.translateChunk(chunk({ tool_calls: [{ index: 0, function: { arguments: ':1}' } }] }))
    // Combined content+finish emits ONLY the content frame (recorded Q8).
    const combined = translator.translateChunk(chunk({ content: 'mid' }, 'tool_calls')) as string[]
    expect(combined.length).toBe(1)
    expect(JSON.parse(combined[0] ?? '')).toEqual({
      candidates: [{ content: { parts: [{ text: 'mid' }], role: 'model' }, index: 0 }],
      model: 'mock-gpt-model',
    })
    const finish = translator.translateChunk(chunk({}, 'stop')) as string[]
    expect(JSON.parse(finish[0] ?? '')).toEqual({
      candidates: [
        { content: { parts: [{ functionCall: { id: 'x', name: 'f', args: { a: 1 } } }], role: 'model' }, index: 0, finishReason: 'STOP' },
      ],
      model: 'mock-gpt-model',
    })
  })

  it('buffered tool calls drop when the stream ends without a finish frame', () => {
    const translator = new OpenAIChunkTranslator(ctx)
    translator.translateChunk(chunk({ tool_calls: [{ index: 0, id: 'x', type: 'function', function: { name: 'f', arguments: '{}' } }] }))
    // No finish frame ever arrives: nothing is flushed.
    expect(translator.translateChunk(chunk({ role: 'assistant' }))).toEqual([])
  })

  it('usage-only frame keeps the candidates, usageMetadata, model order', () => {
    const translator = new OpenAIChunkTranslator(ctx)
    const [frame] = translator.translateChunk(
      chunk({}, undefined, { choices: [], usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } }),
    ) as string[]
    expect(frame).toBe(
      '{"candidates":[],"usageMetadata":{"promptTokenCount":8,"candidatesTokenCount":2,"totalTokenCount":10},"model":"mock-gpt-model"}',
    )
  })

  it('per-choice usage frame keeps the candidates, model, usageMetadata order', () => {
    const translator = new OpenAIChunkTranslator(ctx)
    const [frame] = translator.translateChunk(
      chunk({}, undefined, { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
    ) as string[]
    expect(frame).toBe(
      '{"candidates":[{"content":{"parts":[],"role":"model"},"index":0}],"model":"mock-gpt-model","usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1,"totalTokenCount":2}}',
    )
  })

  it('the frame model is sticky: a chunk without model reuses the last one', () => {
    const translator = new OpenAIChunkTranslator(ctx)
    const [frame] = translator.translateChunk({ model: '', choices: [{ index: 0, delta: { content: 'x' } }] }) as string[]
    expect((JSON.parse(frame ?? '') as Record<string, unknown>)['model']).toBe('mock-gpt-model')
  })
})

/** Body fence of one S1-17 downstream recording (fixture-anchored expectations). */
function recordedS1Body(name: string): string {
  const text = readFileSync(`tests/fixtures/S1/S1-17/${name}.downstream.md`, 'utf8').replace(/\r\n/g, '\n')
  const marker = text.indexOf('## Body')
  const open = text.indexOf('\n```', marker)
  const close = text.indexOf('```', open + 4)
  return text.slice(open + 4, close).replace(/^\n/, '').replace(/\n$/, '')
}

describe('stream — error payloads and framing modes', () => {
  const ctx = { streamModel: 'mock-gpt-model' }

  async function collect(source: AsyncIterable<string | Uint8Array>): Promise<readonly unknown[]> {
    const out: unknown[] = []
    for await (const event of translateOpenAIStreamToGemini(source, ctx)) out.push(event)
    return out
  }

  function sse(frames: readonly string[]): AsyncIterable<string> {
    return {
      async *[Symbol.asyncIterator]() {
        for (const frame of frames) yield frame
      },
    }
  }

  it('recognizes error payloads by all recorded shapes', () => {
    expect(isUpstreamErrorPayload({ error: { message: 'x' } })).toBe(true)
    expect(isUpstreamErrorPayload({ response: { error: {} } })).toBe(true)
    expect(isUpstreamErrorPayload({ code: 'c', message: 'm' })).toBe(true)
    expect(isUpstreamErrorPayload({ type: 'response.failed' })).toBe(true)
    expect(isUpstreamErrorPayload({ type: 'chat.completion.chunk' })).toBe(false)
    expect(isUpstreamErrorPayload({})).toBe(false)
  })

  it('an error payload inside a data frame is terminal and passes through verbatim', async () => {
    const payload = '{"error":{"message":"boom","type":"server_error","code":"internal_server_error","status":502}}'
    const events = await collect(sse([`data: ${payload}\n\n`, 'data: [DONE]\n\n']))
    expect(events).toEqual([{ kind: 'terminal-error', body: payload, status: 502 }])
  })

  it('an error event name marks the frame terminal even with a plain payload', async () => {
    const events = await collect(sse(['event: error\ndata: {"a":1}\n\n']))
    expect(events).toEqual([{ kind: 'terminal-error', body: '{"a":1}', status: 502 }])
  })

  it('a stray JSON line outside a data frame terminates with the 502 wrap', async () => {
    const events = await collect(sse(['{"oops":\n', '\n']))
    expect(events).toEqual([
      {
        kind: 'terminal-error',
        body: '{"error":{"message":"{\\"oops\\":","type":"server_error","code":"internal_server_error"}}',
        status: 502,
      },
    ])
  })

  it('an unparseable data payload terminates with the wrapped raw text', async () => {
    const events = await collect(sse(['data: {"broken"\n\n']))
    expect(events).toEqual([
      {
        kind: 'terminal-error',
        body: '{"error":{"message":"{\\"broken\\"","type":"server_error","code":"internal_server_error"}}',
        status: 502,
      },
    ])
  })

  it('[DONE] and clean EOF both end the stream with no extra event', async () => {
    expect(await collect(sse(['data: [DONE]\n\n']))).toEqual([])
    expect(await collect(sse([]))).toEqual([])
  })

  it('framing modes: sse frames data blocks and error events; raw emits bare bytes', () => {
    expect(frameDownstreamEvent('sse', { kind: 'chunk', body: '{"a":1}' })).toBe('data: {"a":1}\n\n')
    expect(frameDownstreamEvent('sse', { kind: 'terminal-error', body: '{"e":1}', status: 502 })).toBe(
      'event: error\ndata: {"e":1}\n\n',
    )
    expect(frameDownstreamEvent('raw', { kind: 'chunk', body: '{"a":1}' })).toBe('{"a":1}')
    expect(frameDownstreamEvent('raw', { kind: 'terminal-error', body: '{"e":1}', status: 502 })).toBe('{"e":1}')
  })

  it('translates upstream chunks whose payload carries trailing garbage after the JSON value (S1-17 recorded pin)', async () => {
    const mockFile = JSON.parse(
      readFileSync('tests/fixtures/S1/S1-17/mock-response.json', 'utf8'),
    ) as { readonly canned_sse_frames: readonly string[] }
    // Each recorded frame ends with a stray '}' after the balanced JSON
    // value; the reference still translates every chunk (S1-17 golden).
    for (const frame of mockFile.canned_sse_frames) {
      if (frame === 'data: [DONE]') continue
      expect(frame.endsWith('}}'), 'S1-17 chunks carry the recorded trailing brace').toBe(true)
    }

    const events: Array<{ kind: string; body: string }> = []
    // The canned strings are the wire frames without their SSE terminators.
    const source = sse(mockFile.canned_sse_frames.map((frame) => `${frame}

`))
    for await (const event of translateOpenAIStreamToGemini(source, ctx)) {
      events.push(event)
    }
    // Role chunk dropped, content + finish translated, [DONE] ends cleanly.
    expect(events).toEqual([
      {
        kind: 'chunk',
        body: '{"candidates":[{"content":{"parts":[{"text":"Hello from mock openai upstream"}],"role":"model"},"index":0}],"model":"mock-gpt-model"}',
      },
      {
        kind: 'chunk',
        body: '{"candidates":[{"content":{"parts":[],"role":"model"},"index":0,"finishReason":"STOP"}],"model":"mock-gpt-model"}',
      },
    ])

    const producedSse = events.map((event) => frameDownstreamEvent('sse', event as never)).join('')
    const recordedSse = recordedS1Body('stream-alt-sse')
    // The fence convention eats both trailing newlines of the last SSE
    // frame: the true wire bytes are the fence content plus '\n\n'.
    expect(producedSse).toBe(recordedSse + '\n\n')
    expect(events.map((event) => frameDownstreamEvent('raw', event as never)).join('')).toBe(
      recordedS1Body('stream-alt-json'),
    )
  })

  it('completely non-JSON payloads still take the terminal-error path', async () => {
    const events = await collect(sse(['data: not-json-at-all\n\n']))
    expect(events).toEqual([
      {
        kind: 'terminal-error',
        body: '{"error":{"message":"not-json-at-all","type":"server_error","code":"internal_server_error"}}',
        status: 502,
      },
    ])
  })

  it('alt normalization: sse/empty/absent select SSE; anything else selects raw', () => {
    expect(framingForAlt('sse')).toBe('sse')
    expect(framingForAlt('')).toBe('sse')
    expect(framingForAlt(undefined)).toBe('sse')
    expect(framingForAlt('SSE')).toBe('raw')
    expect(framingForAlt('json')).toBe('raw')
    expect(framingForAlt('media')).toBe('raw')
  })
})

// ---------------------------------------------------------------------------
// countTokens (section 3.4 / R-TOK)
// ---------------------------------------------------------------------------

describe('countTokens — tokenizer selection and formula', () => {
  it('selects the encoding by upstream-model prefix', () => {
    expect(encodingForUpstreamModel('mock-gpt-model')).toBe('o200k_base')
    expect(encodingForUpstreamModel('gpt-5-mini')).toBe('o200k_base')
    expect(encodingForUpstreamModel('gpt-4.1')).toBe('o200k_base')
    expect(encodingForUpstreamModel('gpt-4o-mini')).toBe('o200k_base')
    expect(encodingForUpstreamModel('gpt-4-turbo')).toBe('cl100k_base')
    expect(encodingForUpstreamModel('gpt-3.5-turbo')).toBe('cl100k_base')
    expect(encodingForUpstreamModel('gpt-3')).toBe('cl100k_base')
    expect(encodingForUpstreamModel('o1-mini')).toBe('o200k_base')
    expect(encodingForUpstreamModel('o3')).toBe('o200k_base')
    expect(encodingForUpstreamModel('o4-mini')).toBe('o200k_base')
    expect(encodingForUpstreamModel('')).toBe('cl100k_base')
  })

  it('renders the byte-exact response body', () => {
    expect(renderCountTokensResponse(4)).toBe('{"totalTokens":4,"promptTokensDetails":[{"modality":"TEXT","tokenCount":4}]}')
  })

  it('counts per-message role, name and content segments', async () => {
    const translated = await translateGeminiRequest(
      JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Say hello' }] }] }),
      { upstreamModel: UPSTREAM_MODEL, stream: false },
    )
    expect(countTranslatedBodyTokens(translated.value, translated.body, UPSTREAM_MODEL)).toBe(4)
  })

  it('counts the audio id, never the audio data; image urls count', async () => {
    const translated = await translateGeminiRequest(
      JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              { inlineData: { mimeType: 'audio/wav', data: 'AAAA' } },
              { inlineData: { mimeType: 'image/png', data: 'aGk=' } },
            ],
          },
        ],
      }),
      { upstreamModel: UPSTREAM_MODEL, stream: false },
    )
    // Segments: role "user" only - the audio part contributes nothing (no
    // id), the image url is a data: URL string of base64 noise.
    const withoutImage = await translateGeminiRequest(
      JSON.stringify({ contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'audio/wav', data: 'AAAA' } }] }] }),
      { upstreamModel: UPSTREAM_MODEL, stream: false },
    )
    expect(countTranslatedBodyTokens(withoutImage.value, withoutImage.body, UPSTREAM_MODEL)).toBe(1)
    expect(countTranslatedBodyTokens(translated.value, translated.body, UPSTREAM_MODEL)).toBeGreaterThan(1)
  })

  it('counts tools, tool_choice and tool-call fields (the 79-token golden body)', async () => {
    const body = JSON.stringify({
      systemInstruction: { parts: [{ text: 'Be helpful.' }] },
      contents: [
        { role: 'user', parts: [{ text: 'Read a.txt' }] },
        { role: 'model', parts: [{ functionCall: { name: 'read_file', args: { path: 'a.txt' } } }] },
        { role: 'function', parts: [{ functionResponse: { name: 'read_file', response: { result: 'ok' } } }] },
      ],
      tools: [{ functionDeclarations: [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }] }],
      toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
    })
    const translated = await translateGeminiRequest(body, { upstreamModel: UPSTREAM_MODEL, stream: false })
    expect(countTranslatedBodyTokens(translated.value, translated.body, UPSTREAM_MODEL)).toBe(79)
  })

  it('an empty model counts with cl100k_base (recorded selection)', async () => {
    const translated = await translateGeminiRequest(
      JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Say hello' }] }] }),
      { upstreamModel: '', stream: false },
    )
    expect(countTranslatedBodyTokens(translated.value, translated.body, '')).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Error semantics (section 5)
// ---------------------------------------------------------------------------

describe('error bodies and upstream failures', () => {
  it('wraps statuses per the shared table', () => {
    expect(wrapTypeForStatus(401)).toEqual({ type: 'authentication_error', code: 'invalid_api_key' })
    expect(wrapTypeForStatus(403)).toEqual({ type: 'permission_error', code: 'insufficient_quota' })
    expect(wrapTypeForStatus(429)).toEqual({ type: 'rate_limit_error', code: 'rate_limit_exceeded' })
    expect(wrapTypeForStatus(404)).toEqual({ type: 'invalid_request_error', code: 'model_not_found' })
    expect(wrapTypeForStatus(500)).toEqual({ type: 'server_error', code: 'internal_server_error' })
    expect(wrapTypeForStatus(400)).toEqual({ type: 'invalid_request_error' })
  })

  it('valid-JSON upstream bodies pass verbatim; others wrap', () => {
    const verbatim = classifyUpstreamError(429, '{"error":{"message":"x"}}')
    expect(verbatim).toEqual({ kind: 'verbatim', status: 429, body: '{"error":{"message":"x"}}' })
    const wrapped = classifyUpstreamError(503, 'upstream exploded')
    expect(wrapped).toEqual({
      kind: 'wrapped',
      status: 503,
      message: 'upstream exploded',
      type: 'server_error',
      code: 'internal_server_error',
    })
    const empty = classifyUpstreamError(404, '')
    expect(empty).toEqual({ kind: 'wrapped', status: 404, message: 'Not Found', type: 'invalid_request_error', code: 'model_not_found' })
  })

  it('renderGatewayError passes valid JSON verbatim and wraps the rest', () => {
    expect(renderGatewayError('{"error":"boom"}', 500)).toBe('{"error":"boom"}')
    expect(renderGatewayError('unexpected EOF', 500)).toBe(
      '{"error":{"message":"unexpected EOF","type":"server_error","code":"internal_server_error"}}',
    )
    expect(transportErrorMessage(new Error('unexpected EOF'))).toBe('unexpected EOF')
    expect(transportErrorMessage('not an error')).toBe('unexpected EOF')
  })

  it('parses Retry-After hints and the tokens-per-minute pattern', () => {
    expect(parseRetryAfterSeconds([['Retry-After', '30']])).toBe(30)
    expect(parseRetryAfterSeconds([['retry-after', '0']])).toBe(0)
    expect(parseRetryAfterSeconds([['Retry-After', 'soon']])).toBeUndefined()
    expect(parseRetryAfterSeconds([['Retry-After', '1.5']])).toBeUndefined()
    expect(parseRetryAfterSeconds([])).toBeUndefined()
    expect(isTpmRateLimitBody('{"error":{"code":"TPMRateLimitExceeded","message":"x"}}')).toBe(true)
    expect(isTpmRateLimitBody('{"error":{"message":"Tokens per minute limit exceeded"}}')).toBe(true)
    expect(isTpmRateLimitBody('{"error":{"code":"rate_limit_exceeded","message":"mock rate limit"}}')).toBe(false)
    expect(isTpmRateLimitBody('not json')).toBe(false)
  })

  it('summarizes upstream errors as code: message', () => {
    expect(upstreamErrorSummary('{"error":{"code":"rate_limit_exceeded","message":"mock rate limit"}}')).toBe(
      'rate_limit_exceeded: mock rate limit',
    )
    expect(upstreamErrorSummary('{"error":{"message":"only message"}}')).toBe('only message')
    expect(upstreamErrorSummary('raw text')).toBe('raw text')
  })

  it('renders the alphabetical model_cooldown envelope', () => {
    const rendered = buildModelCooldownResponse({
      model: 'mock-model',
      provider: 'openai-compatible-mock-openai',
      lastUpstreamError: 'rate_limit_exceeded: mock rate limit',
      resetSeconds: 4,
      status: 429,
    })
    expect(rendered.status).toBe(429)
    expect(rendered.retryAfter).toBe('4')
    expect(rendered.body).toBe(
      '{"error":{"code":"model_cooldown","last_upstream_error":"rate_limit_exceeded: mock rate limit","message":"All credentials for model mock-model are cooling down via provider openai-compatible-mock-openai (last error: rate_limit_exceeded: mock rate limit)","model":"mock-model","provider":"openai-compatible-mock-openai","reset_seconds":4,"reset_time":"4s"}}',
    )
  })

  it('builds the request-error envelopes byte-exact', () => {
    expect(modelNotFoundBody('nope')).toBe(
      '{"error":{"message":"unknown provider for model nope","type":"invalid_request_error","code":"model_not_found","param":"model"}}',
    )
    expect(actionNotFoundBody('/v1beta/models/justname')).toBe(
      '{"error":{"message":"/v1beta/models/justname not found.","type":"invalid_request_error"}}',
    )
    expect(MISSING_API_KEY_BODY).toBe('{"error":"Missing API key"}')
    expect(INVALID_API_KEY_BODY).toBe('{"error":"Invalid API key"}')
  })
})

// ---------------------------------------------------------------------------
// Client auth (section 2.2)
// ---------------------------------------------------------------------------

describe('client auth — five transports', () => {
  const query = (text: string) => new URLSearchParams(text)

  it('extracts credentials from all five transports in order', () => {
    const headers: HeaderList = [
      ['Authorization', 'bearer oracle-local-key-1'],
      ['X-Goog-Api-Key', 'k2'],
      ['X-Api-Key', 'k3'],
    ]
    expect(extractClientCredentials(headers, query('key=k4&auth_token=k5'))).toEqual([
      'oracle-local-key-1',
      'k2',
      'k3',
      'k4',
      'k5',
    ])
  })

  it('a non-Bearer or single-token Authorization value is used verbatim', () => {
    expect(extractClientCredentials([['Authorization', 'oracle-local-key-1']], query(''))).toEqual(['oracle-local-key-1'])
    expect(extractClientCredentials([['Authorization', 'Basic abc']], query(''))).toEqual(['Basic abc'])
    expect(extractClientCredentials([['Authorization', 'Bearer   spaced  ']], query(''))).toEqual(['spaced'])
    expect(extractClientCredentials([['Authorization', 'Bearer ']], query(''))).toEqual([])
  })

  it('any matching credential passes; none matching fails invalid; none present fails missing', () => {
    const ok = authenticateV1Beta([['X-Api-Key', 'right']], query(''), ['right'])
    expect(ok).toEqual({ kind: 'ok' })
    const wrongFirst = authenticateV1Beta([['Authorization', 'Bearer wrong'], ['X-Api-Key', 'right']], query(''), ['right'])
    expect(wrongFirst).toEqual({ kind: 'ok' })
    const invalid = authenticateV1Beta([['X-Goog-Api-Key', 'wrong']], query(''), ['right'])
    expect(invalid).toEqual({ kind: 'invalid' })
    const missing = authenticateV1Beta([], query(''), ['right'])
    expect(missing).toEqual({ kind: 'missing' })
  })

  it('an empty key set leaves the group open', () => {
    expect(authenticateV1Beta([], query(''), [])).toEqual({ kind: 'ok' })
  })

  it('facade renders the 401 shapes with the charset content type and no trace', async () => {
    const service = facade()
    const missing = await service.handleV1Beta(
      { method: 'POST', path: '/v1beta/models/mock-model:countTokens', headers: [], body: '{}' },
      async () => {
        throw new Error('must not be called')
      },
    )
    expect(missing.status).toBe(401)
    expect(missing.body).toBe(MISSING_API_KEY_BODY)
    expect(headerOf(missing, 'content-type')).toBe('application/json; charset=utf-8')
    expect(headerOf(missing, 'x-cpa-trace-id')).toBeUndefined()

    const invalid = await service.handleV1Beta(
      {
        method: 'POST',
        path: '/v1beta/models/mock-model:countTokens',
        headers: [['x-goog-api-key', 'wrong']],
        body: '{}',
      },
      async () => {
        throw new Error('must not be called')
      },
    )
    expect(invalid.status).toBe(401)
    expect(invalid.body).toBe(INVALID_API_KEY_BODY)
  })

  it('client credentials ride every transport through the facade (query keys parse from the path)', async () => {
    const countBody = '{"contents":[{"role":"user","parts":[{"text":"hi"}]}]}'
    const cases: ReadonlyArray<readonly [string, Gem2OaiRequest]> = [
      ['x-goog', request('/v1beta/models/mock-model:countTokens', countBody, [['X-Goog-Api-Key', 'oracle-local-key-1']])],
      ['bearer', request('/v1beta/models/mock-model:countTokens', countBody, [['Authorization', 'Bearer oracle-local-key-1']])],
      ['raw-authorization', request('/v1beta/models/mock-model:countTokens', countBody, [['Authorization', 'oracle-local-key-1']])],
      ['x-api-key', request('/v1beta/models/mock-model:countTokens', countBody, [['X-Api-Key', 'oracle-local-key-1']])],
      ['query-key', request('/v1beta/models/mock-model:countTokens?key=oracle-local-key-1', countBody, [])],
      ['query-auth-token', request('/v1beta/models/mock-model:countTokens?auth_token=oracle-local-key-1', countBody, [])],
    ]
    for (const [name, v1BetaRequest] of cases) {
      const service = facade()
      const response = await service.handleV1Beta(v1BetaRequest, async () => {
        throw new Error('must not be called')
      })
      expect(response.status, name).toBe(200)
      expect(response.body, name).toBe('{"totalTokens":3,"promptTokensDetails":[{"modality":"TEXT","tokenCount":3}]}')
    }
  })
})

// ---------------------------------------------------------------------------
// Path parsing + model discovery (sections 2.1, 2.4)
// ---------------------------------------------------------------------------

describe('path parsing and discovery', () => {
  it('splits the path from its query and parses colons', () => {
    const target = splitV1BetaPath('/v1beta/models/m:streamGenerateContent?alt=sse&key=k')
    expect(target.pathname).toBe('/v1beta/models/m:streamGenerateContent')
    expect(target.query.get('alt')).toBe('sse')
    expect(target.query.get('key')).toBe('k')
    expect(parseModelMethod('m:generateContent')).toEqual({ model: 'm', method: 'generateContent' })
    expect(parseModelMethod('justname')).toBeUndefined()
    expect(parseModelMethod('a:b:c')).toBeUndefined()
    expect(parseModelMethod('m:')).toBeUndefined()
    expect(parseModelMethod(':generateContent')).toBeUndefined()
  })

  it('renders the LIST with defaults and the raw GET record without them', () => {
    const registry = [
      { id: 'plain' },
      { id: 'rich', displayName: 'Fancy', description: 'D', supportedGenerationMethods: ['generateContent', 'countTokens'] },
    ]
    expect(renderModelsList(registry)).toBe(
      '{"models":[' +
        '{"description":"plain","displayName":"plain","name":"models/plain","supportedGenerationMethods":["generateContent"]},' +
        '{"description":"D","displayName":"Fancy","name":"models/rich","supportedGenerationMethods":["generateContent","countTokens"]}]}',
    )
    expect(JSON.stringify(rawModelRecord({ id: 'plain' }))).toBe('{"displayName":"plain","name":"models/plain"}')
    expect(JSON.stringify(rawModelRecord(registry[1] ?? { id: 'rich' }))).toBe(
      '{"description":"D","displayName":"Fancy","name":"models/rich","supportedGenerationMethods":["generateContent","countTokens"]}',
    )
  })

  it('facade: GET routes (list, raw get, 404s) carry the charset type and no trace', async () => {
    const service = facade({
      registry: [
        { id: 'mock-model', displayName: 'mock-model' },
        { id: 'cm', displayName: 'claude-mock-model' },
      ],
    })
    const list = await service.handleV1Beta(
      { method: 'GET', path: '/v1beta/models', headers: [['x-goog-api-key', 'oracle-local-key-1']], body: '' },
      async () => {
        throw new Error('must not be called')
      },
    )
    expect(list.status).toBe(200)
    expect(headerOf(list, 'content-type')).toBe('application/json; charset=utf-8')
    expect(headerOf(list, 'x-cpa-trace-id')).toBeUndefined()
    expect(JSON.parse(list.body as string)).toEqual({
      models: [
        { description: 'mock-model', displayName: 'mock-model', name: 'models/mock-model', supportedGenerationMethods: ['generateContent'] },
        { description: 'cm', displayName: 'claude-mock-model', name: 'models/cm', supportedGenerationMethods: ['generateContent'] },
      ],
    })

    const get = await service.handleV1Beta(
      { method: 'GET', path: '/v1beta/models/mock-model', headers: [['x-goog-api-key', 'oracle-local-key-1']], body: '' },
      async () => {
        throw new Error('must not be called')
      },
    )
    expect(get.body).toBe('{"displayName":"mock-model","name":"models/mock-model"}')

    for (const path of ['/v1beta/models/models/mock-model', '/v1beta/models/no-such-model', '/v1beta/models/m:generateContent']) {
      const miss = await service.handleV1Beta(
        { method: 'GET', path, headers: [['x-goog-api-key', 'oracle-local-key-1']], body: '' },
        async () => {
          throw new Error('must not be called')
        },
      )
      expect(miss.status, path).toBe(404)
      expect(miss.body, path).toBe('{"error":{"message":"Not Found","type":"not_found"}}')
      expect(headerOf(miss, 'content-type')).toBe('application/json; charset=utf-8')
    }
  })

  it('facade: malformed actions and unknown methods follow the recorded statuses', async () => {
    const service = facade()
    for (const path of ['/v1beta/models/justname', '/v1beta/models/a:b:c']) {
      const notFound = await service.handleV1Beta(request(path, '{}'), async () => {
        throw new Error('must not be called')
      })
      expect(notFound.status, path).toBe(404)
      expect(notFound.body, path).toBe(actionNotFoundBody(path))
      expect(headerOf(notFound, 'content-type')).toBe('application/json; charset=utf-8')
    }
    const unknown = await service.handleV1Beta(request('/v1beta/models/mock-model:bogusMethod', '{"x":1}'), async () => {
      throw new Error('must not be called')
    })
    expect(unknown.status).toBe(200)
    expect(unknown.body).toBe('')
    expect(unknown.headers).toEqual([])

    for (const path of ['/v1beta/models/nonexistent-model:generateContent', '/v1beta/models/models/mock-model:generateContent']) {
      const bad = await service.handleV1Beta(request(path, '{}'), async () => {
        throw new Error('must not be called')
      })
      expect(bad.status, path).toBe(400)
      expect(bad.body, path).toBe(
        modelNotFoundBody(path.includes('/models/models/') ? 'models/mock-model' : 'nonexistent-model'),
      )
      expect(headerOf(bad, 'content-type')).toBe('application/json')
      expect(headerOf(bad, 'x-cpa-trace-id')).toBeUndefined()
    }
  })

  it('facade: stray routes mirror the empty R-404', async () => {
    const service = facade()
    const miss = await service.handleV1Beta(
      { method: 'POST', path: '/v1beta/other', headers: [['x-goog-api-key', 'oracle-local-key-1']], body: '' },
      async () => {
        throw new Error('must not be called')
      },
    )
    expect(miss.status).toBe(404)
    expect(miss.body).toBe('')
    expect(miss.headers).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Facade: upstream wire policy + framing + cooldown mechanics
// ---------------------------------------------------------------------------

describe('facade — upstream wire', () => {
  it('emits the recorded header set and order; client headers never forward', async () => {
    const service = facade()
    const captured: Gem2OaiUpstreamRequest[] = []
    const send: Gem2OaiUpstreamSender = async (call) => {
      captured.push(call)
      return staticJson({
        model: UPSTREAM_MODEL,
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      })
    }
    const response = await service.handleV1Beta(
      {
        method: 'POST',
        path: '/v1beta/models/mock-model:generateContent',
        headers: [
          ['Authorization', 'Bearer oracle-local-key-1'],
          ['X-Goog-Api-Key', 'oracle-local-key-1'],
          ['User-Agent', 's2d2-test/1.0'],
          ['X-Client-Marker', 's2d2-case1'],
          ['Content-Type', 'application/json'],
        ],
        body: '{"contents":[{"role":"user","parts":[{"text":"Say hello"}]}]}',
      },
      send,
    )
    expect(response.status).toBe(200)
    const call = captured[0]
    expect(call).toBeDefined()
    if (call === undefined) return
    expect(call.url).toBe(`${BASE_URL}/chat/completions`)
    expect(call.method).toBe('POST')
    expect(call.headers).toEqual([
      ['Host', 'mock.internal:20999'],
      ['User-Agent', openAICompatUserAgent()],
      ['Content-Length', String(encoder.encode(call.body).length)],
      ['Authorization', 'Bearer mock-upstream-key'],
      ['Content-Type', 'application/json'],
      ['Accept-Encoding', 'gzip'],
    ])
    expect(call.body).toBe(
      '{"model":"mock-gpt-model","messages":[{"role":"user","content":"Say hello"}],"stream":false}',
    )
  })

  it('stream requests add Accept/Cache-Control in the recorded slots and stream_options last', async () => {
    const service = facade()
    const captured: Gem2OaiUpstreamRequest[] = []
    const send: Gem2OaiUpstreamSender = async (call) => {
      captured.push(call)
      return { status: 200, headers: [], body: byteStream(['data: [DONE]\n\n']) }
    }
    await service.handleV1Beta(request('/v1beta/models/mock-model:streamGenerateContent?alt=sse', '{"contents":[]}'), send)
    const call = captured[0]
    if (call === undefined) throw new Error('no upstream call')
    expect(call.headers).toEqual([
      ['Host', 'mock.internal:20999'],
      ['User-Agent', openAICompatUserAgent()],
      ['Content-Length', String(encoder.encode(call.body).length)],
      ['Accept', 'text/event-stream'],
      ['Authorization', 'Bearer mock-upstream-key'],
      ['Cache-Control', 'no-cache'],
      ['Content-Type', 'application/json'],
      ['Accept-Encoding', 'gzip'],
    ])
    expect(call.body.endsWith('"stream":true,"stream_options":{"include_usage":true}}')).toBe(true)
  })

  it('a trailing slash on the base-url is trimmed; custom headers join the sorted set', async () => {
    const service = facade({
      credentials: [
        credential({ baseUrl: 'http://mock.internal:20999/v1/', headers: { 'X-Custom': 'yes' } as Readonly<Record<string, string>> }),
      ],
    })
    const captured: Gem2OaiUpstreamRequest[] = []
    const send: Gem2OaiUpstreamSender = async (call) => {
      captured.push(call)
      return staticJson({ model: UPSTREAM_MODEL, choices: [{ index: 0, message: { role: 'assistant', content: 'ok' } }] })
    }
    await service.handleV1Beta(request('/v1beta/models/mock-model:generateContent', '{"contents":[]}'), send)
    const call = captured[0]
    if (call === undefined) throw new Error('no upstream call')
    expect(call.url).toBe('http://mock.internal:20999/v1/chat/completions')
    expect(call.headers.map(([name]) => name)).toEqual([
      'Host',
      'User-Agent',
      'Content-Length',
      'Authorization',
      'Content-Type',
      'X-Custom',
      'Accept-Encoding',
    ])
  })

  it('non-2xx upstream errors pass through verbatim with a trace header', async () => {
    const service = facade()
    const errorBody = '{"error":{"message":"mock rate limit","type":"rate_limit_exceeded","code":"rate_limit_exceeded"}}'
    const response = await service.handleV1Beta(
      request('/v1beta/models/mock-model:generateContent', '{"contents":[]}'),
      async () => staticBody(errorBody, 429),
    )
    expect(response.status).toBe(429)
    expect(response.body).toBe(errorBody)
    expect(headerOf(response, 'content-type')).toBe('application/json')
    expect(headerOf(response, 'x-cpa-trace-id')).toBeDefined()
  })

  it('non-JSON upstream errors wrap per status', async () => {
    const service = facade()
    const response = await service.handleV1Beta(
      request('/v1beta/models/mock-model:generateContent', '{"contents":[]}'),
      async () => staticBody('gateway exploded', 502),
    )
    expect(response.status).toBe(502)
    expect(response.body).toBe('{"error":{"message":"gateway exploded","type":"server_error","code":"internal_server_error"}}')
  })

  it('a pre-commit transport failure renders the plain 500; requestRetry rotates candidates', async () => {
    const exhausted = await facade({ requestRetry: 0 }).handleV1Beta(
      request('/v1beta/models/mock-model:generateContent', '{"contents":[]}'),
      async () => {
        throw new Error('unexpected EOF')
      },
    )
    expect(exhausted.status).toBe(500)
    expect(exhausted.body).toBe(
      '{"error":{"message":"unexpected EOF","type":"server_error","code":"internal_server_error"}}',
    )
    expect(headerOf(exhausted, 'x-cpa-trace-id')).toBeDefined()

    const credentials: readonly Gem2OaiCredential[] = [
      credential(),
      credential({ name: 'second', baseUrl: 'http://mock2.internal:20999/v1' }),
    ]
    const service = facade({ requestRetry: 1, credentials })
    const attempts: string[] = []
    const response = await service.handleV1Beta(
      request('/v1beta/models/mock-model:generateContent', '{"contents":[]}'),
      async (call) => {
        attempts.push(call.url)
        if (attempts.length === 1) throw new Error('connection reset')
        return staticJson({ model: UPSTREAM_MODEL, choices: [{ index: 0, message: { role: 'assistant', content: 'second try' } }] })
      },
    )
    expect(attempts.length).toBe(2)
    expect(response.status).toBe(200)
    expect((JSON.parse(response.body as string) as Record<string, unknown>)['candidates']).toBeDefined()
  })

  it('a stream that closes with no translatable chunk commits headers + empty body', async () => {
    const service = facade()
    const response = await service.handleV1Beta(
      request('/v1beta/models/mock-model:streamGenerateContent?alt=sse', '{"contents":[]}'),
      async () => ({ status: 200, headers: [], body: byteStream(['data: {"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}],"model":"mock-gpt-model"}\n\n', 'data: [DONE]\n\n']) }),
    )
    expect(response.status).toBe(200)
    expect(headerOf(response, 'content-type')).toBe('text/event-stream')
    expect(headerOf(response, 'cache-control')).toBe('no-cache')
    expect(headerOf(response, 'connection')).toBe('keep-alive')
    expect(await readBody(response.body)).toBe('')
  })
})

describe('facade — alt framing modes downstream', () => {
  const frames = [
    'data: {"model":"mock-gpt-model","choices":[{"index":0,"delta":{"content":"A"},"finish_reason":null}]}\n\n',
    'data: {"model":"mock-gpt-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ]

  async function streamFor(path: string): Promise<Gem2OaiResponse> {
    const service = facade()
    return service.handleV1Beta(request(path, '{"contents":[]}'), async () => ({
      status: 200,
      headers: [],
      body: byteStream(frames),
    }))
  }

  it('no alt: SSE headers and data framing', async () => {
    const response = await streamFor('/v1beta/models/mock-model:streamGenerateContent')
    expect(headerOf(response, 'content-type')).toBe('text/event-stream')
    expect(await readBody(response.body)).toBe(
      'data: {"candidates":[{"content":{"parts":[{"text":"A"}],"role":"model"},"index":0}],"model":"mock-gpt-model"}\n\n' +
        'data: {"candidates":[{"content":{"parts":[],"role":"model"},"index":0,"finishReason":"STOP"}],"model":"mock-gpt-model"}\n\n',
    )
  })

  it('$alt=sse matches alt=sse; a non-lowercase alt selects raw mode', async () => {
    const viaDollar = await streamFor('/v1beta/models/mock-model:streamGenerateContent?$alt=sse')
    expect(headerOf(viaDollar, 'content-type')).toBe('text/event-stream')
    const uppercase = await streamFor('/v1beta/models/mock-model:streamGenerateContent?alt=SSE')
    expect(headerOf(uppercase, 'content-type')).toBe('text/plain; charset=utf-8')
    expect(headerOf(uppercase, 'cache-control')).toBeUndefined()
    expect(headerOf(uppercase, 'connection')).toBeUndefined()
    expect(await readBody(uppercase.body)).toBe(
      '{"candidates":[{"content":{"parts":[{"text":"A"}],"role":"model"},"index":0}],"model":"mock-gpt-model"}' +
        '{"candidates":[{"content":{"parts":[],"role":"model"},"index":0,"finishReason":"STOP"}],"model":"mock-gpt-model"}',
    )
  })

  it('mid-stream transport failures frame the transport text after the flushed chunks', async () => {
    const service = facade()
    const response = await service.handleV1Beta(
      request('/v1beta/models/mock-model:streamGenerateContent?alt=sse', '{"contents":[]}'),
      async () => {
        let served = false
        return {
          status: 200,
          headers: [],
          body: new ReadableStream<Uint8Array>({
            pull(controller) {
              if (!served) {
                served = true
                controller.enqueue(encoder.encode(frames[0] ?? ''))
                return
              }
              controller.error(new Error('unexpected EOF'))
            },
          }),
        }
      },
    )
    expect(response.status).toBe(200)
    const body = await readBody(response.body)
    expect(body).toBe(
      'data: {"candidates":[{"content":{"parts":[{"text":"A"}],"role":"model"},"index":0}],"model":"mock-gpt-model"}\n\n' +
        'event: error\ndata: {"error":{"message":"unexpected EOF","type":"server_error","code":"internal_server_error"}}\n\n',
    )
  })
})

describe('facade — cooldown mechanics (section 5.3)', () => {
  const errorBody = '{"error":{"message":"mock rate limit","type":"rate_limit_exceeded","code":"rate_limit_exceeded"}}'

  async function error429(): Promise<Gem2OaiUpstreamResponse> {
    return staticBody(errorBody, 429)
  }

  it('the default window escalates 1 -> 2 -> 4 across post-window failures', async () => {
    let clock = 1_000
    const store = new MemoryStore({ now: () => clock })
    const service = facade({ store, now: () => clock })
    const path = '/v1beta/models/mock-model:generateContent'

    const first = await service.handleV1Beta(request(path, '{"contents":[]}'), error429)
    expect(first.status).toBe(429)
    expect(first.body).toBe(errorBody)

    clock += 500 // inside the 1s window
    const inWindow = await service.handleV1Beta(request(path, '{"contents":[]}'), async () => {
      throw new Error('must not be called')
    })
    expect(inWindow.status).toBe(429)
    expect(JSON.parse(inWindow.body as string)).toEqual({
      error: {
        code: 'model_cooldown',
        last_upstream_error: 'rate_limit_exceeded: mock rate limit',
        message:
          'All credentials for model mock-model are cooling down via provider openai-compatible-mock-openai (last error: rate_limit_exceeded: mock rate limit)',
        model: 'mock-model',
        provider: 'openai-compatible-mock-openai',
        reset_seconds: 1,
        reset_time: '1s',
      },
    })
    expect(headerOf(inWindow, 'retry-after')).toBe('1')
    expect(headerOf(inWindow, 'x-cpa-trace-id')).toBeUndefined()

    clock += 1_000 // post-window: second consecutive failure doubles the window
    await service.handleV1Beta(request(path, '{"contents":[]}'), error429)
    clock += 100
    const secondWindow = await service.handleV1Beta(request(path, '{"contents":[]}'), async () => {
      throw new Error('must not be called')
    })
    expect(headerOf(secondWindow, 'retry-after')).toBe('2')

    clock += 5_000 // third consecutive failure: the recorded 4s window
    await service.handleV1Beta(request(path, '{"contents":[]}'), error429)
    clock += 100
    const thirdWindow = await service.handleV1Beta(request(path, '{"contents":[]}'), async () => {
      throw new Error('must not be called')
    })
    expect(headerOf(thirdWindow, 'retry-after')).toBe('4')
    expect(JSON.parse(thirdWindow.body as string)).toEqual({
      error: {
        code: 'model_cooldown',
        last_upstream_error: 'rate_limit_exceeded: mock rate limit',
        message:
          'All credentials for model mock-model are cooling down via provider openai-compatible-mock-openai (last error: rate_limit_exceeded: mock rate limit)',
        model: 'mock-model',
        provider: 'openai-compatible-mock-openai',
        reset_seconds: 4,
        reset_time: '4s',
      },
    })
  })

  it('a success resets the escalation streak', async () => {
    let clock = 1_000
    const store = new MemoryStore({ now: () => clock })
    const service = facade({ store, now: () => clock })
    const path = '/v1beta/models/mock-model:generateContent'
    await service.handleV1Beta(request(path, '{"contents":[]}'), error429)
    clock += 2_000
    await service.handleV1Beta(request(path, '{"contents":[]}'), error429)
    clock += 3_000
    const success = await service.handleV1Beta(request(path, '{"contents":[]}'), async () =>
      staticJson({ model: UPSTREAM_MODEL, choices: [{ index: 0, message: { role: 'assistant', content: 'ok' } }] }),
    )
    expect(success.status).toBe(200)
    clock += 100
    const after = await service.handleV1Beta(request(path, '{"contents":[]}'), async () => {
      throw new Error('must not be called')
    })
    expect(headerOf(after, 'retry-after')).toBeUndefined() // no cooldown window at all
  })

  it('an upstream Retry-After hint wins over the ladder; TPM bodies open 60s', async () => {
    let clock = 1_000
    const store = new MemoryStore({ now: () => clock })
    const service = facade({ store, now: () => clock })
    const path = '/v1beta/models/mock-model:generateContent'
    await service.handleV1Beta(request(path, '{"contents":[]}'), async () => ({
      status: 429,
      headers: [['Retry-After', '30']],
      body: new Response(errorBody).body as ReadableStream<Uint8Array>,
    }))
    clock += 100
    const hinted = await service.handleV1Beta(request(path, '{"contents":[]}'), async () => {
      throw new Error('must not be called')
    })
    expect(headerOf(hinted, 'retry-after')).toBe('30')

    clock += 60_000
    const tpmBody = '{"error":{"code":"TPMRateLimitExceeded","message":"You exceeded your tokens per minute limit"}}'
    await service.handleV1Beta(request(path, '{"contents":[]}'), async () => ({
      status: 429,
      headers: [],
      body: new Response(tpmBody).body as ReadableStream<Uint8Array>,
    }))
    clock += 100
    const tpm = await service.handleV1Beta(request(path, '{"contents":[]}'), async () => {
      throw new Error('must not be called')
    })
    expect(headerOf(tpm, 'retry-after')).toBe('60')
  })

  it('a failing store never rejects the rendered response and surfaces through reportError', async () => {
    const failingStore: Store = {
      get: async () => undefined,
      put: async () => undefined,
      delete: async () => true,
      list: async () => [],
      update: async () => {
        throw new Error('store down')
      },
      enqueue: async () => 'id',
      claim: async () => undefined,
      ack: async () => true,
      release: async () => true,
      ringAppend: async () => undefined,
      ringRead: async () => [],
    }
    const reported: unknown[] = []
    const original = globalThis.reportError
    globalThis.reportError = (error: unknown) => {
      reported.push(error)
    }
    try {
      const service = facade({ store: failingStore })
      const response = await service.handleV1Beta(
        request('/v1beta/models/mock-model:generateContent', '{"contents":[]}'),
        error429,
      )
      expect(response.status).toBe(429)
      expect(response.body).toBe(errorBody)
      expect(reported.length).toBeGreaterThan(0)
      expect((reported[0] as Error).message).toBe('store down')
    } finally {
      globalThis.reportError = original
    }
  })

  it('the cooldown gate applies to countTokens too (same pipeline)', async () => {
    let clock = 1_000
    const store = new MemoryStore({ now: () => clock })
    const service = facade({ store, now: () => clock })
    await service.handleV1Beta(
      request('/v1beta/models/mock-model:generateContent', '{"contents":[]}'),
      error429,
    )
    clock += 100
    const count = await service.handleV1Beta(
      request('/v1beta/models/mock-model:countTokens', '{"contents":[{"role":"user","parts":[{"text":"hi"}]}]}'),
      async () => {
        throw new Error('must not be called')
      },
    )
    expect(count.status).toBe(429)
    expect(JSON.parse(count.body as string)).toMatchObject({ error: { code: 'model_cooldown', reset_seconds: 1 } })
  })

  it('requestRetry rotates credentials on 429 and only the last response renders', async () => {
    const clock = 1_000
    const store = new MemoryStore({ now: () => clock })
    const credentials: readonly Gem2OaiCredential[] = [
      credential({ name: 'first', apiKey: 'k1' }),
      credential({ name: 'second', apiKey: 'k2', baseUrl: 'http://mock2.internal:20999/v1' }),
    ]
    const service = facade({ store, now: () => clock, requestRetry: 1, credentials })
    const captured: string[] = []
    const response = await service.handleV1Beta(
      request('/v1beta/models/mock-model:generateContent', '{"contents":[]}'),
      async (call) => {
        captured.push(call.url)
        return call.url.includes('mock2') ? staticJson({ model: UPSTREAM_MODEL, choices: [{ index: 0, message: { role: 'assistant', content: 'ok' } }] }) : staticBody(errorBody, 429)
      },
    )
    expect(captured).toEqual(['http://mock.internal:20999/v1/chat/completions', 'http://mock2.internal:20999/v1/chat/completions'])
    expect(response.status).toBe(200)
  })
})
