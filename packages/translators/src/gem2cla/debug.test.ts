import { describe, expect, it } from 'vitest'
import { ClaudeToGeminiStreamTranslator } from './response'

describe('debug', () => {
  it('fragments', () => {
    const translator = new ClaudeToGeminiStreamTranslator({ resolvedModel: 'm', now: () => 0 })
    const out: string[] = []
    const events = [
      ['message_start', { type: 'message_start', message: { id: 'i', model: 'm' } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'get_weather' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"city":"Par"' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'is"}' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 12 } }],
      ['message_stop', { type: 'message_stop' }],
    ] as const
    for (const [name, payload] of events) {
      const json = JSON.stringify(payload)
      console.log('WIRE:', JSON.stringify(`event: ${name}\ndata: ${json}\n\n`))
      out.push(...translator.translateDataLine(json))
    }
    for (const chunk of out) console.log('CHUNK:', chunk)
    expect(true).toBe(true)
  })
})
