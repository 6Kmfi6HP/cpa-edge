import { describe, expect, it } from 'vitest'
import { MemoryStore } from '@cpa-edge/core'
import {
  buildAntigravityAuthorizeUrl,
  buildClaudeAuthorizeUrl,
  buildCodexAuthorizeUrl,
  buildDevinAuthorizeUrl,
  FAILED_STATE_BODY,
  OAuthLoginService,
} from './oauth-login'
import { OAuthSessionRegistry } from './oauth-sessions'

// Golden authorize URLs from tests/fixtures/S3 (S3 §2.3): the query
// parameter sets, order and escaping are byte-pinned; state and PKCE are
// the recorded values.
const CLAUDE_GOLDEN =
  'https://claude.ai/oauth/authorize?client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&code=true&code_challenge=GAHZtAXk-d1j3g1cmeKEenNoOzjxUqFbxrFg38X3w3c&code_challenge_method=S256&redirect_uri=http%3A%2F%2Flocalhost%3A54545%2Fcallback&response_type=code&scope=user%3Aprofile+user%3Ainference+user%3Asessions%3Aclaude_code+user%3Amcp_servers+user%3Afile_upload&state=df2853e8c773ff64cc018c35c6181314'
const CODEX_GOLDEN =
  'https://auth.openai.com/oauth/authorize?client_id=app_EMoamEEZ73f0CkXaXp7hrann&code_challenge=QzqE58A0TJ144p7OKzdcKzwGaboZOEC6ETw3N2ZFazE&code_challenge_method=S256&codex_cli_simplified_flow=true&id_token_add_organizations=true&prompt=login&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&response_type=code&scope=openid+email+profile+offline_access&state=1e03c0c0d98b14ce83481d0f3352dec3'
const ANTIGRAVITY_GOLDEN =
  'https://accounts.google.com/o/oauth2/v2/auth?access_type=offline&client_id=1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com&prompt=consent&redirect_uri=http%3A%2F%2Flocalhost%3A51121%2Foauth-callback&response_type=code&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcloud-platform+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fuserinfo.email+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fuserinfo.profile+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcclog+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fexperimentsandconfigs&state=1ee496cd8ce9500c040b2afc1c504e9d'
const DEVIN_GOLDEN =
  'https://app.devin.ai/auth/cli/continue?redirect_uri=http%3A%2F%2F127.0.0.1%3A8387%2Fcallback&state=ae7762ca6ad4d3efd947fde5473789d3&prompt=select_account&code_challenge=9cNjurdGuSul7d8BU42OKnYJ8SukPvkN8wVTDHvybb8&code_challenge_method=S256'

describe('authorize URL builders (S3 §2.3, byte-exact)', () => {
  it('builds the recorded Claude URL', () => {
    expect(
      buildClaudeAuthorizeUrl({
        state: 'df2853e8c773ff64cc018c35c6181314',
        pkce: { verifier: 'v', challenge: 'GAHZtAXk-d1j3g1cmeKEenNoOzjxUqFbxrFg38X3w3c' },
      }),
    ).toBe(CLAUDE_GOLDEN)
  })

  it('builds the recorded Codex URL with the three extra flags', () => {
    expect(
      buildCodexAuthorizeUrl({
        state: '1e03c0c0d98b14ce83481d0f3352dec3',
        pkce: { verifier: 'v', challenge: 'QzqE58A0TJ144p7OKzdcKzwGaboZOEC6ETw3N2ZFazE' },
      }),
    ).toBe(CODEX_GOLDEN)
  })

  it('builds the recorded Antigravity URL (no PKCE params)', () => {
    expect(
      buildAntigravityAuthorizeUrl({
        state: '1ee496cd8ce9500c040b2afc1c504e9d',
        pkce: { verifier: 'v', challenge: 'c' },
      }),
    ).toBe(ANTIGRAVITY_GOLDEN)
  })

  it('builds the recorded Devin URL in the hand-built order', () => {
    expect(
      buildDevinAuthorizeUrl({
        state: 'ae7762ca6ad4d3efd947fde5473789d3',
        pkce: { verifier: 'v', challenge: '9cNjurdGuSul7d8BU42OKnYJ8SukPvkN8wVTDHvybb8' },
        redirectUri: 'http://127.0.0.1:8387/callback',
      }),
    ).toBe(DEVIN_GOLDEN)
  })

  it('appends cli_pkce_marker=1 and drops redirect_uri in headless mode', () => {
    const url = buildDevinAuthorizeUrl({
      state: 's',
      pkce: { verifier: 'v', challenge: 'c' },
    })
    expect(url).toBe(
      'https://app.devin.ai/auth/cli/continue?state=s&prompt=select_account&code_challenge=c&code_challenge_method=S256&cli_pkce_marker=1',
    )
  })
})

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

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status })
}

describe('login-URL service (§2.5 response bodies)', () => {
  it('answers the map-marshaled body with \\u0026 escaping and registers the session', async () => {
    const svc = service()
    const result = await svc.anthropicLoginUrl()
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected success')
    expect(result.body).toMatch(
      /^\{"state":"[0-9a-f]{32}","status":"ok","url":"https:\/\/claude\.ai\/oauth\/authorize\?client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e\\u0026code=true\\u0026code_challenge=[A-Za-z0-9_-]{43}\\u0026code_challenge_method=S256\\u0026redirect_uri=http%3A%2F%2Flocalhost%3A54545%2Fcallback\\u0026response_type=code\\u0026scope=user%3Aprofile\+user%3Ainference\+user%3Asessions%3Aclaude_code\+user%3Amcp_servers\+user%3Afile_upload\\u0026state=[0-9a-f]{32}"\}$/,
    )
    const parsed = JSON.parse(result.body) as { state: string; status: string }
    expect(parsed.status).toBe('ok')
  })

  it('answers the devin body with the server-port redirect_uri', async () => {
    const svc = service()
    const result = await svc.devinLoginUrl()
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected success')
    expect(result.body).toContain('?redirect_uri=http%3A%2F%2F127.0.0.1%3A8387%2Fcallback\\u0026state=')
  })

  it('requires a server port for the devin flow', async () => {
    const store = new MemoryStore()
    const registry = new OAuthSessionRegistry(store)
    const svc = new OAuthLoginService(registry, {})
    const result = await svc.devinLoginUrl()
    expect(result).toEqual({
      ok: false,
      response: { status: 500, body: '{"error":"failed to generate authorization url"}' },
    })
  })
})

const DEVICE_PAYLOAD = {
  device_code: 'dev-1',
  user_code: 'ABCD-EFGH',
  verification_uri: 'https://auth.kimi.com/device',
  verification_uri_complete: 'https://auth.kimi.com/device?user_code=ABCD-EFGH',
  expires_in: 600,
  interval: 5,
}

describe('device-flow login endpoints (§2.5/§2.6)', () => {

  it('answers the kimi body with the kmi- state and omits expires_in when the vendor omits it', async () => {
    const svc = service(async () => jsonResponse(DEVICE_PAYLOAD))
    const result = await svc.kimiLoginUrl()
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected success')
    expect(result.body).toBe(
      '{"expires_in":600,"flow":"device","state":"kmi-1760000000000000000","status":"ok","url":"https://auth.kimi.com/device?user_code=ABCD-EFGH","user_code":"ABCD-EFGH"}',
    )
    const svcNoExpires = service(async () => {
      const { expires_in: _drop, ...rest } = DEVICE_PAYLOAD
      void _drop
      return jsonResponse(rest)
    })
    const omitted = await svcNoExpires.kimiLoginUrl()
    expect(omitted.ok).toBe(true)
    if (omitted.ok) {
      expect(omitted.body).not.toContain('expires_in')
      expect(JSON.parse(omitted.body) as Record<string, unknown>).toEqual({
        flow: 'device',
        state: 'kmi-1760000000000000000',
        status: 'ok',
        url: 'https://auth.kimi.com/device?user_code=ABCD-EFGH',
        user_code: 'ABCD-EFGH',
      })
    }
  })

  it('falls back to 1800 for xai and 900 for meta when the vendor omits expires_in', async () => {
    const noExpires = async () => {
      const { expires_in: _drop, ...rest } = DEVICE_PAYLOAD
      void _drop
      return jsonResponse(rest)
    }
    const xai = await (await serviceWithDiscovery()).xaiLoginUrl()
    expect(xai.ok).toBe(true)
    if (xai.ok) expect((JSON.parse(xai.body) as Record<string, unknown>)['expires_in']).toBe(1800)
    const meta = await service(noExpires).metaLoginUrl()
    expect(meta.ok).toBe(true)
    if (meta.ok) expect((JSON.parse(meta.body) as Record<string, unknown>)['expires_in']).toBe(900)
  })

  it('answers the pinned 500 bodies when the vendor endpoint is unreachable', async () => {
    const failing = async () => {
      throw new Error('egress blocked')
    }
    const kimi = await service(failing).kimiLoginUrl()
    expect(kimi).toEqual({
      ok: false,
      response: { status: 500, body: '{"error":"failed to generate authorization url"}' },
    })
    const xai = await service(failing).xaiLoginUrl()
    expect(xai).toEqual({
      ok: false,
      response: { status: 500, body: '{"error":"failed to start device authorization flow"}' },
    })
    const meta = await service(failing).metaLoginUrl()
    expect(meta).toEqual({
      ok: false,
      response: { status: 500, body: '{"error":"failed to start device authorization flow"}' },
    })
    expect(FAILED_STATE_BODY).toBe('{"error":"failed to generate state parameter"}')
  })
})

/** xAI needs discovery before the device authorization call. */
async function serviceWithDiscovery(): Promise<OAuthLoginService> {
  let called = false
  const fetchFn = async (url: string): Promise<Response> => {
    if (!called) {
      called = true
      expect(url).toBe('https://auth.x.ai/.well-known/openid-configuration')
      return jsonResponse({
        device_authorization_endpoint: 'https://auth.x.ai/oauth/device/authorize',
        token_endpoint: 'https://auth.x.ai/oauth/token',
      })
    }
    const { expires_in: _drop, ...rest } = DEVICE_PAYLOAD
    void _drop
    return jsonResponse(rest)
  }
  return service(fetchFn)
}
