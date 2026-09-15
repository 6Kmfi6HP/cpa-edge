/**
 * Unit coverage for rules the golden replay touches only once or not at
 * all: the full thinking clamp/400 table, the countTokens formula pieces
 * and tokenizer selection, tool-id determinism and FIFO pairing, the
 * alt-framing matrix, in-stream terminal errors, cooldown windows and
 * escalation, the auth-transport surface, model discovery asymmetries and
 * the upstream header policy.
 */
import { describe, expect, it, vi } from 'vitest'
import { CpaError, MemoryStore } from '@cpa-edge/core'
import type { Store } from '@cpa-edge/core'
import {
  applyRequestThinking,
  convertBudgetToLevel,
  effectiveThinkingLevel,
  extractSourceThinkingConfig,
} from './thinking'
import { deriveToolCallId, translateGeminiRequest, translateGeminiToOpenAI, withStreamOptions } from './request'
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
import { createGem2OaiService, openAICompatUserAgent } from './service'
import type {
  Gem2OaiCredential,
  Gem2OaiRequest,
  Gem2OaiResponse,
  Gem2OaiService,
  Gem2OaiUpstreamRequest,
  Gem2OaiUpstreamResponse,
  Gem2OaiUpstreamSender,
  HeaderList,
} from './service'

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
  readonly apiKeys?: readonly string[]
  readonly requestRetry?: number
}

function facade(options: FacadeOptions = {}): Gem2OaiService {
  return createGem2OaiService({
    credentials: options.credentials ?? [credential()],
    registry: [{ id: 'mock-model', displayName: 'mock-model' }],
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
    const body: Record<string, unknown> = { reasoning_effort: '' }
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
