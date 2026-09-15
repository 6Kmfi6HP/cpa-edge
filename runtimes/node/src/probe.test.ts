import { describe, it } from 'vitest'
import { createNodeGateway, makeGatewayRequest } from './index'

const CANNED = {"id": "chatcmpl-mock-0001", "object": "chat.completion", "created": 1770000000, "model": "mock-gpt-model", "choices": [{"index": 0, "message": {"role": "assistant", "content": "Hello from mock openai upstream more"}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 9, "completion_tokens": 6, "total_tokens": 15}}
const FRAMES = ["data: {\"id\": \"chatcmpl-mock-0001\", \"object\": \"chat.completion.chunk\", \"created\": 1770000000, \"model\": \"mock-gpt-model\", \"choices\": [{\"index\": 0, \"delta\": {\"role\": \"assistant\"}, \"finish_reason\": null}]}}", "data: {\"id\": \"chatcmpl-mock-0001\", \"object\": \"chat.completion.chunk\", \"created\": 1770000000, \"model\": \"mock-gpt-model\", \"choices\": [{\"index\": 0, \"delta\": {\"content\": \"Hello from mock openai upstream\"}, \"finish_reason\": null}]}}", "data: {\"id\": \"chatcmpl-mock-0001\", \"object\": \"chat.completion.chunk\", \"created\": 1770000000, \"model\": \"mock-gpt-model\", \"choices\": [{\"index\": 0, \"delta\": {}, \"finish_reason\": \"stop\"}]}}", "data: [DONE]"]

function pythonJson(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value)
  if (Array.isArray(value)) return `[${value.map(pythonJson).join(', ')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}: ${pythonJson(entry)}`).join(', ')}}`
  }
  throw new Error('bad')
}

const encoder = new TextEncoder()

describe('probe S1-18 replay through res2oai', () => {
  it('stream request', async () => {
    const calls: Array<{ url: string; headers: Array<[string, string]>; body: string }> = []
    const fetchLike = async (url: string, init?: RequestInit): Promise<Response> => {
      const record = (init?.headers ?? {}) as Record<string, string>
      const headers = Object.entries(record).map(([n, v]) => [n, v] as [string, string])
      calls.push({ url, headers, body: typeof init?.body === 'string' ? init.body : '' })
      const isStream = headers.some(([n, v]) => n.toLowerCase() === 'accept' && v === 'text/event-stream')
      console.log('UPSTREAM CALL', url, 'accept-sse:', isStream, 'body:', calls[0]?.body.slice(0, 90))
      if (isStream) {
        const chunks = FRAMES.map((f: string) => encoder.encode(`${f}\n\n`))
        let served = 0
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            const chunk = chunks[served]
            served += 1
            if (chunk === undefined) { controller.close(); return }
            controller.enqueue(chunk)
          },
        })
        return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
      }
      return new Response(pythonJson(CANNED), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    const gateway = createNodeGateway({
      config: {
        port: 18317,
        'api-keys': ['oracle-local-key-1'],
        'openai-compatibility': [
          { name: 'mock-openai', 'api-key': 'mock-upstream-key', 'base-url': 'http://host.docker.internal:18999/v1', models: [{ name: 'mock-gpt-model', alias: 'mock-model' }] },
        ],
      },
      fetch: fetchLike,
    })
    const response = await gateway.handle(
      makeGatewayRequest('POST', '/v1/responses', [['Authorization', 'Bearer oracle-local-key-1'], ['Content-Type', 'application/json']], '{"model": "mock-model", "input": "Say hello", "stream": true}'),
    )
    console.log('STATUS', response.status)
    const body = typeof response.body === 'string' ? response.body : '<stream>'
    console.log('BODY', body.slice(0, 200))
  })
})
