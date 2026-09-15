import { describe, expect, it } from 'vitest'
import { ClaudeToGeminiStreamTranslator } from './response'

describe('debug', () => {
  it('fragment bytes', () => {
    const translator = new ClaudeToGeminiStreamTranslator({ resolvedModel: 'm', now: () => 0 })
    const feed = (payload: unknown) => translator.translateDataLine(JSON.stringify(payload))
    feed({ type: 'message_start', message: { id: 'i', model: 'm' } })
    feed({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'get_weather' } })
    feed({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"city":"Par"' } })
    feed({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'is"}' } })
    const out = feed({ type: 'content_block_stop', index: 0 })
    expect(out.length).toBe(1)
    const chunk = out[0] ?? ''
    const argsStart = chunk.indexOf('"args":') + '"args":'.length
    const idAt = chunk.indexOf(',"id"', argsStart)
    const argsBytes = chunk.slice(argsStart, idAt)
    console.log('ARGS BYTES:', JSON.stringify(argsBytes), 'len:', argsBytes.length)
    // exact expected chunk, hand-assembled
    const raw = '{"city":"Par"is"}'
    const expected =
      '{"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"get_weather","args":' +
      raw +
      ',"id":"t1"}}]}}],"usageMetadata":{"trafficType":"PROVISIONED_THROUGHPUT"},"modelVersion":"m","createTime":"' +
      chunk.slice(chunk.indexOf('"createTime":"') + 13, chunk.indexOf('"createTime":"') + 33) +
      '","responseId":"i","finishReason":"STOP"}'
    console.log('EXPECTED len:', expected.length, 'ACTUAL len:', chunk.length)
    console.log('EQUAL:', chunk === expected)
    if (chunk !== expected) {
      for (let i = 0; i < Math.max(chunk.length, expected.length); i++) {
        if (chunk[i] !== expected[i]) {
          console.log('first diff at', i, 'actual:', JSON.stringify(chunk.slice(i - 10, i + 10)), 'expected:', JSON.stringify(expected.slice(i - 10, i + 10)))
          break
        }
      }
    }
    expect(chunk).toBe(expected)
  })
})
