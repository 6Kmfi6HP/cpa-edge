
import { describe, it } from 'vitest'
import { readFile } from 'node:fs/promises'

describe('scratch', () => {
  it('debug S1-17 replay', async () => {
    const runtime = (await import('../../runtimes/node/src/index.ts')) as {
      createNodeGateway: (options: Record<string, unknown>) => {
        handle: (request: Record<string, unknown>) => Promise<{
          status: number
          headers: ReadonlyArray<readonly [string, string]>
          body: unknown
        }>
      }
    }
    const mock = JSON.parse(
      await readFile(new URL('../fixtures/S1/S1-17/mock-response.json', import.meta.url), 'utf8'),
    ) as Record<string, unknown>
    const encoder = new TextEncoder()
    const captured: Array<Record<string, unknown>> = []
    const fetchLike = async (input: unknown, init: unknown): Promise<Response> => {
      const initRecord = (init ?? {}) as Record<string, unknown>
      const headers = initRecord['headers'] as Record<string, string>
      captured.push({ url: String(input), init: initRecord })
      const isStream = Object.entries(headers).some(
        ([name, value]) => name.toLowerCase() === 'accept' && value === 'text/event-stream',
      )
      console.log('CAPTURED URL', String(input))
      console.log('CAPTURED HEADERS', JSON.stringify(headers))
      console.log('isStream?', isStream)
      if (isStream) {
        const frames = (mock['canned_sse_frames'] as string[]).map((frame) => encoder.encode(`${frame}\n\n`))
        let served = 0
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            const chunk = frames[served]
            served += 1
            if (chunk === undefined) {
              controller.close()
              return
            }
            controller.enqueue(chunk)
          },
        })
        return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
      }
      return new Response(JSON.stringify(mock['canned_non_stream']), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    const gateway = runtime.createNodeGateway({
      config: {
        'api-keys': ['oracle-local-key-1'],
        'remote-management': { 'allow-remote': true, 'secret-key': 'oracle-mgmt-key-1' },
        'request-retry': 0,
        'transient-error-cooldown-seconds': -1,
        'openai-compatibility': [
          {
            name: 'mock-openai',
            'api-key': 'mock-upstream-key',
            'base-url': 'http://host.docker.internal:18999/v1',
            models: [{ name: 'mock-gpt-model', alias: 'mock-model' }],
          },
        ],
      },
      now: () => 1789490828000,
      fetch: fetchLike,
      remoteAddress: '192.168.65.1',
    })
    const raw = await readFile(new URL('../fixtures/S1/S1-17/stream-alt-json.request.http', import.meta.url), 'utf8')
    const [head, body] = raw.split('\n\n')
    const headers: Array<[string, string]> = []
    for (const line of (head ?? '').split('\n').slice(1)) {
      const colon = line.indexOf(': ')
      if (colon > 0) headers.push([line.slice(0, colon), line.slice(colon + 2)])
    }
    const request = {
      method: 'POST',
      url: 'http://127.0.0.1:18317/v1beta/models/mock-model:streamGenerateContent?alt=json',
      headers: headers.filter(([name]) => name !== 'Host' && name !== 'Content-Length'),
      body: encoder.encode((body ?? '').replace('^\n', '')),
      remoteAddress: '192.168.65.1',
    }
    const response = await gateway.handle(request)
    console.log('STATUS', response.status)
    console.log('HEADERS', JSON.stringify(response.headers))
    const decoder = new TextDecoder()
    if (typeof response.body === 'string') {
      console.log('BODY(str)', response.body)
    } else {
      const reader = response.body.getReader()
      let out = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        out += decoder.decode(value ?? new Uint8Array(0), { stream: true })
      }
      console.log('BODY(stream)', out)
    }
  })
})
