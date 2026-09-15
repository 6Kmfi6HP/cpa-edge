
import { describe, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { createManagementApi } from './api'
import { MemoryStore } from '@cpa-edge/core'

describe('api-call scratch', () => {
  it('prints the upstream request', async () => {
    const reqText = await readFile(new URL('../../../tests/fixtures/S5/S5-api-call-mock/request.http', import.meta.url), 'utf8')
    // STEP 3 request body
    const m = /### S5-api-call-mock STEP 3 — POST \/v0\/management\/api-call\n([\s\S]*?)\n\n### /.exec(reqText + '\n\n### END')
    const bodySection = (m?.[1] ?? '')
    const json = bodySection.slice(bodySection.indexOf('{'))
    let captured: unknown = undefined
    const api = createManagementApi({
      configYaml: 'host: ""\nport: 8407\nremote-management:\n  allow-remote: true\n  secret-key: "k"\napi-keys: []\n',
      managementKey: 'k',
      store: new MemoryStore(),
      buildInfo: { version: 'v7.3.4', commit: 'x', buildDate: 'y', supportPlugin: true },
      clientIp: '127.0.0.1',
      sendUpstream: async (request) => {
        captured = request
        return { status: 200, headers: [], body: '' }
      },
    })
    const response = await api.handle(new Request('http://127.0.0.1:8407/v0/management/api-call', {
      method: 'POST',
      headers: [['Authorization', 'Bearer k']],
      body: json,
    }))
    console.log('status', response.status)
    console.log('captured', JSON.stringify(captured, null, 1))
  })
})
