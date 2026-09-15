import { describe, expect, it } from 'vitest'
import { scanLeadingJsonValue } from './json'
import { reframeUpstreamSse } from './stream'

const encoder = new TextEncoder()

describe('debug', () => {
  it('scanLeadingJsonValue on the delta payload', () => {
    const payload = '{"delta": {"a"}}'
    const leading = scanLeadingJsonValue(payload)
    console.log('leading:', JSON.stringify(leading))
    expect(leading).toBeDefined()
  })

  it('generator over the aborting stream', async () => {
    let served = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        served += 1
        console.log('mock pull', served)
        if (served === 1) {
          controller.enqueue(encoder.encode('data: {"delta": {"a"}}\n\ndata: {"delta"'))
          return
        }
        controller.error(new Error('unexpected EOF'))
      },
    })
    const events: string[] = []
    try {
      for await (const event of reframeUpstreamSse(
        (async function* (): AsyncIterable<Uint8Array> {
          const reader = body.getReader()
          try {
            for (;;) {
              const { done, value } = await reader.read()
              if (done) return
              if (value !== undefined) yield value
            }
          } finally {
            reader.releaseLock()
          }
        })(),
        {},
      )) {
        console.log('event:', JSON.stringify(event))
        events.push(event.kind === 'chunk' ? event.body : event.kind)
      }
    } catch (error) {
      console.log('threw:', String(error))
    }
    expect(events).toEqual(['{"delta": {"a"}}'])
  })
})
