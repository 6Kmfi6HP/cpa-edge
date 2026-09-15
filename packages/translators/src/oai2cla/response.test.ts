/**
 * Golden replay: response direction (stream + non-stream) against the
 * recorded downstream bytes.
 *
 * Upstream event scripts are rebuilt from the recorded mock controls
 * (spec/recordings/S2d3.cases.json `scripts_needed`); the translated
 * downstream frames/bodies are compared byte-exact with the recorded
 * fixtures (`created` is pinned through the context clock, so no dynamic
 * field is masked). Per R-SSE the comparison runs on DECODED event
 * sequences, never on transport chunk boundaries.
 */
import { describe, expect, it } from 'vitest'
import {
  bootstrapChatChunkStream,
  translateClaudeSseToChatSse,
} from './stream'
import { translateClaudeBufferToChatCompletion } from './response'
import { parseDownstreamSse } from './sse'
import {
  classifyClaudeUpstreamError,
  parseClaudeRateLimitResetWithFuzz,
  renderUnexpectedEofFailure,
  renderUpstreamFailure,
  renderValidationFailure,
  buildModelCooldownResponse,
} from './errors'
import type { ClaudeToChatContext } from './types'
import { readRecordedDownstream } from './fixture-reader'

const MODEL = 'claude-mock-model'
/** Recorded server epoch of the run-1 batch (masked as dynamic upstream). */
const RECORDED_NOW = 1789495019
const CTX: ClaudeToChatContext = { streamModel: MODEL, nowSeconds: () => RECORDED_NOW }

function sse(events: readonly [string, unknown][]): string {
  return events.map(([name, payload]) => `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`).join('')
}

function startMessage(id: string, usage: Record<string, unknown> = { input_tokens: 9, output_tokens: 1 }): unknown {
  return {
    type: 'message_start',
    message: { id, type: 'message', role: 'assistant', model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage },
  }
}

const HAPPY: readonly [string, unknown][] = [
  ['message_start', startMessage('msg_mock_01')],
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello from mock claude upstream' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' more' } }],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 6 } }],
  ['message_stop', { type: 'message_stop' }],
]

const TOOL_USE: readonly [string, unknown][] = [
  ['message_start', startMessage('msg_tool_01')],
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_mock01', name: 'get_weather', input: {} } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"city":' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"Paris"}' } }],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 6 } }],
  ['message_stop', { type: 'message_stop' }],
]

const THINKING: readonly [string, unknown][] = [
  ['message_start', startMessage('msg_think_01')],
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Let me think.' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-mock-01' } }],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Final answer.' } }],
  ['content_block_stop', { type: 'content_block_stop', index: 1 }],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 6 } }],
  ['message_stop', { type: 'message_stop' }],
]

function stopVariant(stopReason: string): readonly [string, unknown][] {
  return [
    ['message_start', startMessage('msg_stop_01', { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 32, cache_creation_input_tokens: 5 })],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: 'END' }, usage: { output_tokens: 7 } }],
    ['message_stop', { type: 'message_stop' }],
  ]
}

const ERROR_EVENT: readonly [string, unknown][] = [
  ['message_start', startMessage('msg_err_01')],
  ['error', { type: 'error', error: { type: 'api_error', message: 'mock in-stream error' } }],
]

const PING_ONLY: readonly [string, unknown][] = [
  ['ping', { type: 'ping' }],
  ['ping', { type: 'ping' }],
]

/** Downstream payloads of a translated stream (R-SSE decoded comparison). */
async function collectPayloads(frames: readonly [string, unknown][]): Promise<readonly string[]> {
  const out: string[] = []
  for await (const frame of translateClaudeSseToChatSse(asyncSource(sse(frames)), CTX)) {
    out.push(frame)
  }
  return parseDownstreamSse(out.join(''))
}

function asyncSource(text: string): AsyncIterable<string> {
  return {
    async *[Symbol.asyncIterator]() {
      yield text
    },
  }
}

/** Data payloads of a recorded downstream SSE body, in order. */
function recordedFrames(caseId: string, step: number): readonly string[] {
  return parseDownstreamSse(readRecordedDownstream(caseId, step).body)
}

describe('S2d3 golden replay — stream translation', () => {
  it('s2d3-baseline-stream: role, content, finish, trailing usage, [DONE]', async () => {
    const frames = await collectPayloads(HAPPY)
    const expected = recordedFrames('s2d3-baseline-stream', 1)
    expect(frames).toEqual(expected)
  })

  it('s2d3-slow: same event order under delayed delivery', async () => {
    const out: string[] = []
    const source = (async function* () {
      for (const [name, payload] of HAPPY) {
        await new Promise((resolve) => setTimeout(resolve, 5))
        yield `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`
      }
    })()
    for await (const frame of translateClaudeSseToChatSse(source, CTX)) out.push(frame)
    expect(parseDownstreamSse(out.join(''))).toEqual(recordedFrames('s2d3-slow', 1))
  })

  it('s2d3-res-tooluse-stream: tool_calls delta chunk with accumulated arguments', async () => {
    const frames = await collectPayloads(TOOL_USE)
    expect(frames).toEqual(recordedFrames('s2d3-res-tooluse-stream', 1))
  })

  it('s2d3-res-thinking: reasoning_content delta, signature_delta ignored', async () => {
    const frames = await collectPayloads(THINKING)
    expect(frames).toEqual(recordedFrames('s2d3-res-thinking', 1))
  })

  it('s2d3-res-stopreasons-usage: max_tokens -> length (stream)', async () => {
    const frames = await collectPayloads(stopVariant('max_tokens'))
    expect(frames).toEqual(recordedFrames('s2d3-res-stopreasons-usage', 1))
  })

  it('s2d3-res-stopreasons-usage: stop_sequence -> stop (stream)', async () => {
    const frames = await collectPayloads(stopVariant('stop_sequence'))
    expect(frames).toEqual(recordedFrames('s2d3-res-stopreasons-usage', 3))
  })

  it('s2d3-err-instream-event: error chunk, translation continues, [DONE] on clean close', async () => {
    const frames = await collectPayloads(ERROR_EVENT)
    expect(frames).toEqual(recordedFrames('s2d3-err-instream-event', 1))
  })

  it('s2d3-disconnect: committed chunks, then one in-stream EOF error frame, no [DONE]', async () => {
    const out: string[] = []
    const fourEvents = sse(HAPPY.slice(0, 4))
    const source = (async function* () {
      yield fourEvents
      throw new Error('unexpected EOF')
    })()
    for await (const frame of translateClaudeSseToChatSse(source, CTX)) out.push(frame)
    const payloads = parseDownstreamSse(out.join(''))
    expect(payloads).toEqual(recordedFrames('s2d3-disconnect', 1))
    expect(payloads[payloads.length - 1]).not.toBe('[DONE]')
  })

  it('upstream [DONE] and ping events produce no downstream output', async () => {
    const frames = [
      ...HAPPY.slice(0, 1),
      ['ping', { type: 'ping' }] as [string, unknown],
    ]
    const out: string[] = []
    const source = (async function* () {
      yield sse(frames)
      yield 'data: [DONE]\n\n'
    })()
    for await (const frame of translateClaudeSseToChatSse(source, CTX)) out.push(frame)
    // role chunk only, then the clean-close [DONE]
    expect(out).toEqual(['data: ' + JSON.stringify({ id: 'msg_mock_01', object: 'chat.completion.chunk', created: RECORDED_NOW, model: MODEL, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }) + '\n\n', 'data: [DONE]\n\n'])
  })

  it('s2d3-empty-stream: zero data lines fail the bootstrap before headers (500, retryable)', async () => {
    const bootstrap = await bootstrapChatChunkStream(asyncSource(''), CTX)
    expect(bootstrap.kind).toBe('empty-stream')
  })

  it('s2d3-empty-stream: ping events do not count as a first payload', async () => {
    const bootstrap = await bootstrapChatChunkStream(asyncSource(sse(PING_ONLY)), CTX)
    expect(bootstrap.kind).toBe('empty-stream')
  })

  it('bootstrap returns the first frame and a working rest stream', async () => {
    const bootstrap = await bootstrapChatChunkStream(asyncSource(sse(HAPPY)), CTX)
    expect(bootstrap.kind).toBe('live')
    if (bootstrap.kind !== 'live') return
    const rest: string[] = [bootstrap.firstFrame]
    for await (const frame of bootstrap.rest) rest.push(frame)
    expect(parseDownstreamSse(rest.join(''))).toEqual(recordedFrames('s2d3-baseline-stream', 1))
  })

  it('transport failure before the first chunk propagates instead of committing', async () => {
    const source = (async function* () {
      throw new Error('upstream connect failed')
    })()
    await expect(async () => {
      for await (const _frame of translateClaudeSseToChatSse(source, CTX)) {
        // no frame expected
      }
    }).rejects.toThrow('upstream connect failed')
  })

  it('transport re-chunking never changes the decoded event sequence', async () => {
    const wire = sse(HAPPY)
    const out: string[] = []
    const source = (async function* () {
      for (let i = 0; i < wire.length; i += 7) {
        yield wire.slice(i, i + 7)
      }
    })()
    for await (const frame of translateClaudeSseToChatSse(source, CTX)) out.push(frame)
    expect(parseDownstreamSse(out.join(''))).toEqual(recordedFrames('s2d3-baseline-stream', 1))
  })
})

describe('S2d3 golden replay — non-stream aggregation', () => {
  const cases: readonly [string, readonly [string, unknown][]][] = [
    ['s2d3-baseline-nonstream', HAPPY],
    ['s2d3-res-tooluse-nonstream', TOOL_USE],
  ]

  for (const [caseId, script] of cases) {
    it(`${caseId}: aggregated chat.completion is byte-exact`, () => {
      const result = translateClaudeBufferToChatCompletion(sse(script), CTX)
      expect(result.kind).toBe('ok')
      if (result.kind !== 'ok') return
      expect(result.body).toBe(readRecordedDownstream(caseId, 1).body)
    })
  }

  it('s2d3-res-thinking: reasoning_content lands after content', () => {
    const result = translateClaudeBufferToChatCompletion(sse(THINKING), CTX)
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.body).toBe(readRecordedDownstream('s2d3-res-thinking', 2).body)
  })

  it('s2d3-res-stopreasons-usage: usage arithmetic with cache tokens', () => {
    const result = translateClaudeBufferToChatCompletion(sse(stopVariant('max_tokens')), CTX)
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.body).toBe(readRecordedDownstream('s2d3-res-stopreasons-usage', 2).body)
  })

  it('s2d3-err-instream-event: in-buffer error event fails validation (502)', () => {
    const result = translateClaudeBufferToChatCompletion(sse(ERROR_EVENT), CTX)
    expect(result.kind).toBe('validation-failed')
    if (result.kind !== 'validation-failed') return
    const rendered = renderValidationFailure(result.message)
    expect(rendered.status).toBe(502)
    expect(rendered.body).toBe(readRecordedDownstream('s2d3-err-instream-event', 2).body)
  })

  it('s2d3-disconnect: aggregation read failure renders the 500 unexpected EOF envelope', () => {
    const rendered = renderUnexpectedEofFailure()
    expect(rendered.status).toBe(500)
    expect(rendered.body).toBe(readRecordedDownstream('s2d3-disconnect', 2).body)
  })
})

describe('S2d3 golden replay — malformed-stream validation (case 25)', () => {
  const MALFORMED_429_BODY = '{"type": "error", "error": {"type": "rate_limit_error", "message": "mock rate limit"}}'

  it('step 1 bad_json -> malformed stream data', () => {
    const buffer = 'data: {not json}\n\n'
    const result = translateClaudeBufferToChatCompletion(buffer, CTX)
    expect(result.kind).toBe('validation-failed')
    if (result.kind !== 'validation-failed') return
    expect(renderValidationFailure(result.message).body).toBe(readRecordedDownstream('s2d3-malformed-validation', 1).body)
  })

  it('step 2 empty -> empty stream response', () => {
    const result = translateClaudeBufferToChatCompletion('', CTX)
    expect(result.kind).toBe('validation-failed')
    if (result.kind !== 'validation-failed') return
    expect(renderValidationFailure(result.message).body).toBe(readRecordedDownstream('s2d3-malformed-validation', 2).body)
  })

  it('step 3 no_start -> missing message_start', () => {
    const buffer = sse([
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }],
      ['message_stop', { type: 'message_stop' }],
    ])
    const result = translateClaudeBufferToChatCompletion(buffer, CTX)
    expect(result.kind).toBe('validation-failed')
    if (result.kind !== 'validation-failed') return
    expect(renderValidationFailure(result.message).body).toBe(readRecordedDownstream('s2d3-malformed-validation', 3).body)
  })

  it('step 4 start_no_id -> message_start is missing id or model', () => {
    const buffer = sse([
      ['message_start', { type: 'message_start', message: { id: '', model: '', usage: { input_tokens: 1 } } }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' } }],
      ['message_stop', { type: 'message_stop' }],
    ])
    const result = translateClaudeBufferToChatCompletion(buffer, CTX)
    expect(result.kind).toBe('validation-failed')
    if (result.kind !== 'validation-failed') return
    expect(renderValidationFailure(result.message).body).toBe(readRecordedDownstream('s2d3-malformed-validation', 4).body)
  })

  it('step 5 no_delta -> ended before message completion', () => {
    const buffer = sse([
      ['message_start', startMessage('msg_ok_01')],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } }],
      ['message_stop', { type: 'message_stop' }],
    ])
    const result = translateClaudeBufferToChatCompletion(buffer, CTX)
    expect(result.kind).toBe('validation-failed')
    if (result.kind !== 'validation-failed') return
    expect(renderValidationFailure(result.message).body).toBe(readRecordedDownstream('s2d3-malformed-validation', 5).body)
  })

  it('error-event message falls back error.message -> error.type -> unknown', () => {
    for (const [error, expected] of [
      [{ type: 'error', error: { type: 'api_error', message: 'boom' } }, 'claude executor: upstream returned error event: boom'],
      [{ type: 'error', error: { type: 'api_error' } }, 'claude executor: upstream returned error event: api_error'],
      [{ type: 'error', error: {} }, `claude executor: upstream returned error event: unknown upstream error`],
    ] as const) {
      const result = translateClaudeBufferToChatCompletion(sse([['message_start', startMessage('x')], ['error', error]]), CTX)
      expect(result.kind).toBe('validation-failed')
      if (result.kind === 'validation-failed') expect(result.message).toBe(expected)
    }
    void MALFORMED_429_BODY
  })
})

describe('S2d3 golden replay — upstream status errors and cooldown', () => {
  const CLAUDE_429_BODY = '{"type": "error", "error": {"type": "rate_limit_error", "message": "mock rate limit"}}'

  it('s2d3-err-429-verbatim-cooldown step 1: valid-JSON 429 body passes through verbatim', () => {
    const failure = classifyClaudeUpstreamError(429, CLAUDE_429_BODY)
    expect(failure.kind).toBe('verbatim')
    const rendered = renderUpstreamFailure(failure)
    expect(rendered.status).toBe(429)
    expect(rendered.body).toBe(readRecordedDownstream('s2d3-err-429-verbatim-cooldown', 1).body)
  })

  it('s2d3-err-429-verbatim-cooldown step 2: headerless cooldown is the 1s ladder', () => {
    const reset = parseClaudeRateLimitResetWithFuzz({})
    expect(reset).toBe(1)
    const response = buildModelCooldownResponse({
      model: 'cm',
      provider: 'claude',
      lastUpstreamError: CLAUDE_429_BODY,
      resetSeconds: reset,
    })
    expect(response.status).toBe(429)
    expect(response.retryAfter).toBe('1')
    expect(response.body).toBe(readRecordedDownstream('s2d3-err-429-verbatim-cooldown', 2).body)
  })

  it('s2d3-retry-after step 2: upstream Retry-After drives the fuzzed cooldown', () => {
    const reset = parseClaudeRateLimitResetWithFuzz({ 'Retry-After': '1' }, () => 0.85)
    expect(reset).toBe(27)
    const response = buildModelCooldownResponse({
      model: 'cm',
      provider: 'claude',
      lastUpstreamError: CLAUDE_429_BODY,
      resetSeconds: reset,
    })
    expect(response.retryAfter).toBe('27')
    expect(response.body).toBe(readRecordedDownstream('s2d3-retry-after', 2).body)
  })

  it('s2d3-retry-after step 1: the direct verbatim 429 carries no Retry-After', () => {
    const failure = classifyClaudeUpstreamError(429, CLAUDE_429_BODY)
    expect(failure.kind).toBe('verbatim')
    const rendered = renderUpstreamFailure(failure)
    expect(rendered.status).toBe(429)
    expect(rendered.body).toBe(readRecordedDownstream('s2d3-retry-after', 1).body)
  })

  it('s2d3-err-wrap-500-nonjson: non-JSON body wraps into the 500 envelope', () => {
    const failure = classifyClaudeUpstreamError(500, 'mock internal failure')
    expect(failure.kind).toBe('wrapped')
    const rendered = renderUpstreamFailure(failure)
    expect(rendered.status).toBe(500)
    expect(rendered.body).toBe(readRecordedDownstream('s2d3-err-wrap-500-nonjson', 1).body)
  })

  it('s2d3-stream-429-commit: pre-first-chunk 429 renders as a plain JSON error', () => {
    const failure = classifyClaudeUpstreamError(429, CLAUDE_429_BODY)
    const rendered = renderUpstreamFailure(failure)
    expect(rendered.status).toBe(429)
    expect(rendered.body).toBe(readRecordedDownstream('s2d3-stream-429-commit', 1).body)
  })

  it('empty-stream bootstrap renders the recorded 500 empty_stream envelope', async () => {
    const { renderEmptyStreamFailure } = await import('./errors')
    const bootstrap = await bootstrapChatChunkStream(asyncSource(sse(PING_ONLY)), CTX)
    expect(bootstrap.kind).toBe('empty-stream')
    if (bootstrap.kind !== 'empty-stream') return
    const rendered = renderEmptyStreamFailure()
    expect(rendered.status).toBe(500)
    expect(rendered.retryable).toBe(true)
    expect(rendered.body).toBe(readRecordedDownstream('s2d3-empty-stream', 1).body)
    expect(rendered.body).toBe(readRecordedDownstream('s2d3-empty-stream', 2).body)
  })
})
