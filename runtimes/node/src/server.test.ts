/**
 * Socket-level tests: the node adapter must emit the same wire bytes
 * the recorded fixtures show (status, headers, bodies, redirects).
 */
import { afterAll, describe, expect, it } from 'vitest'
import { createNodeGateway, listenGateway, type GatewayServer, type NodeGateway } from './index'

const API_KEY = 'oracle-local-key-1'

const CONFIG: Readonly<Record<string, unknown>> = {
  port: 0,
  'api-keys': [API_KEY],
  'openai-compatibility': [
    {
      name: 'mock-openai',
      'api-key': 'mock-upstream-key',
      'base-url': 'http://127.0.0.1:18999/v1',
      models: [{ name: 'mock-gpt-model', alias: 'mock-model' }],
    },
  ],
}

let server: GatewayServer | undefined
let gateway: NodeGateway | undefined

async function running(): Promise<{ server: GatewayServer; gateway: NodeGateway; base: string }> {
  if (server === undefined || gateway === undefined) {
    gateway = createNodeGateway({ config: CONFIG })
    server = await listenGateway(gateway, { host: '127.0.0.1', port: 0 })
  }
  return { server, gateway, base: `http://127.0.0.1:${server.port}` }
}

afterAll(async () => {
  if (server !== undefined) await server.close()
})

describe('node server adapter', () => {
  it('serves the root payload over a real socket', async () => {
    const { base } = await running()
    const response = await fetch(`${base}/`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(await response.text()).toBe(
      '{"endpoints":["POST /v1/chat/completions","POST /v1/completions","GET /v1/models"],"message":"CLI Proxy API Server"}',
    )
  })

  it('emits the empty-body 404 and the OPTIONS 204', async () => {
    const { base } = await running()
    const missing = await fetch(`${base}/nope`)
    expect(missing.status).toBe(404)
    expect(missing.headers.get('content-type')).toBeNull()
    expect(missing.headers.get('content-length')).toBe('0')
    expect(missing.headers.get('access-control-allow-origin')).toBe('*')
    expect(await missing.text()).toBe('')
    const options = await fetch(`${base}/v1/chat/completions`, { method: 'OPTIONS' })
    expect(options.status).toBe(204)
  })

  it('emits the 301 redirect with the gin HTML body and no CORS', async () => {
    const { base } = await running()
    const response = await fetch(`${base}/v1/models/`, { redirect: 'manual' })
    expect(response.status).toBe(301)
    expect(response.headers.get('location')).toBe('/v1/models')
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
    expect(await response.text()).toBe('<a href="/v1/models">Moved Permanently</a>.\n')
  })

  it('serves the authenticated models list with a canonical-cased trace-free header set', async () => {
    const { base } = await running()
    const response = await fetch(`${base}/v1/models`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    })
    expect(response.status).toBe(200)
    const parsed = JSON.parse(await response.text()) as { data: Array<{ id: string }> }
    expect(parsed.data.map((entry) => entry.id)).toEqual(['mock-model'])
  })

  it('preserves request header casing into the auth gate (X-Api-Key)', async () => {
    const { base } = await running()
    const response = await fetch(`${base}/v1/models`, { headers: { 'X-Api-Key': API_KEY } })
    expect(response.status).toBe(200)
  })
})
