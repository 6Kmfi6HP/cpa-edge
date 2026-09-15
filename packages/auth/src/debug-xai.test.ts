import { it } from 'vitest'
import { MemoryStore } from '@cpa-edge/core'
import { OAuthSessionRegistry } from './oauth-sessions'
import { OAuthLoginService } from './oauth-login'

const DEVICE_PAYLOAD = {
  device_code: 'dev-1',
  user_code: 'ABCD-EFGH',
  verification_uri: 'https://auth.kimi.com/device',
  verification_uri_complete: 'https://auth.kimi.com/device?user_code=ABCD-EFGH',
  expires_in: 600,
  interval: 5,
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status })
}

function service(fetch?: (url: string, init?: unknown) => Promise<Response>): OAuthLoginService {
  const store = new MemoryStore()
  const registry = new OAuthSessionRegistry(store, { now: () => 1_760_000_000_000 })
  return new OAuthLoginService(registry, {
    now: () => 1_760_000_000_000,
    serverPort: 8387,
    fetch:
      fetch === undefined
        ? undefined
        : (fetch as (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<Response>),
  })
}

async function serviceWithDiscovery(): Promise<OAuthLoginService> {
  let called = false
  const fetchFn = async (url: string): Promise<Response> => {
    if (!called) {
      called = true
      expect(url).toBe('https://auth.x.ai/.well-known/openid-configuration')
      return jsonResponse({
        device_authorization_endpoint: 'https://auth.x.ai/device',
        token_endpoint: 'https://auth.x.ai/token',
      })
    }
    const { expires_in: _drop, ...rest } = DEVICE_PAYLOAD
    void _drop
    return jsonResponse(rest)
  }
  return service(fetchFn)
}

import { expect } from 'vitest'

it('debug xai via test helper', async () => {
  const noExpires = async () => {
    const { expires_in: _drop, ...rest } = DEVICE_PAYLOAD
    void _drop
    return jsonResponse(rest)
  }
  const xai = await (await serviceWithDiscovery()).xaiLoginUrl()
  console.log('XAI', JSON.stringify(xai))
  const meta = await service(noExpires).metaLoginUrl()
  console.log('META', JSON.stringify(meta))
})
