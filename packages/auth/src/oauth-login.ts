import type { JsonValue } from '@cpa-edge/core'
import { generatePkcePair, randomHex, type PkcePair } from './crypto-util'
import { ANTIGRAVITY, CLAUDE, CODEX, DEVIN, KIMI, META, XAI } from './providers'
import type { OAuthSessionRegistry } from './oauth-sessions'
import type { AuthResponse, Clock, FetchLike } from './types'
import { goJsonStringify, goQueryEscape, goValuesEncode, parseFormValues } from './wire'
import { startKimiDeviceLogin, startMetaDeviceLogin, startXaiDeviceLogin, type DeviceLoginStart } from './device-flows'

/**
 * Authorization-URL building for the code-flow providers plus the
 * login-URL service the management endpoints delegate to. URL query
 * strings are built with Go's `url.Values.Encode` semantics for the
 * alphabetical providers (Claude, Codex, Antigravity) and in the reference
 * hand-built order for Devin, whose `cli_pkce_marker=1` marks the headless
 * manual-code mode used when no redirect URI is supplied.
 */

/** Inputs every authorize-URL builder takes; randomness stays injectable. */
export interface AuthorizeUrlInput {
  readonly state: string
  readonly pkce: PkcePair
}

/** Claude: alphabetical params, `code=true`, loopback redirect 54545. */
export function buildClaudeAuthorizeUrl(input: AuthorizeUrlInput): string {
  const query = goValuesEncode({
    client_id: CLAUDE.clientId,
    code: 'true',
    code_challenge: input.pkce.challenge,
    code_challenge_method: 'S256',
    redirect_uri: CLAUDE.redirectUri,
    response_type: 'code',
    scope: CLAUDE.scope,
    state: input.state,
  })
  return `${CLAUDE.authorizeEndpoint}?${query}`
}

/** Codex: alphabetical params incl. the three extra login flags. */
export function buildCodexAuthorizeUrl(input: AuthorizeUrlInput): string {
  const query = goValuesEncode({
    client_id: CODEX.clientId,
    code_challenge: input.pkce.challenge,
    code_challenge_method: 'S256',
    codex_cli_simplified_flow: 'true',
    id_token_add_organizations: 'true',
    prompt: 'login',
    redirect_uri: CODEX.redirectUri,
    response_type: 'code',
    scope: CODEX.scope,
    state: input.state,
  })
  return `${CODEX.authorizeEndpoint}?${query}`
}

/** Antigravity: alphabetical params, `access_type=offline`, `prompt=consent`. */
export function buildAntigravityAuthorizeUrl(input: AuthorizeUrlInput): string {
  const query = goValuesEncode({
    access_type: 'offline',
    client_id: ANTIGRAVITY.clientId,
    prompt: 'consent',
    redirect_uri: ANTIGRAVITY.redirectUri,
    response_type: 'code',
    scope: ANTIGRAVITY.scopes.join(' '),
    state: input.state,
  })
  return `${ANTIGRAVITY.authorizeEndpoint}?${query}`
}

export interface DevinAuthorizeUrlInput extends AuthorizeUrlInput {
  /** Management-flow redirect (`http://127.0.0.1:<port>/callback`); omit for headless mode. */
  readonly redirectUri?: string
}

/**
 * Devin: hand-built param order - `redirect_uri`?, `state`?,
 * `prompt=select_account`, `code_challenge`, `code_challenge_method` -
 * with `cli_pkce_marker=1` appended when no redirect URI is supplied
 * (headless manual-code mode).
 */
export function buildDevinAuthorizeUrl(input: DevinAuthorizeUrlInput): string {
  const pairs: string[] = []
  if (input.redirectUri !== undefined && input.redirectUri.length > 0) {
    pairs.push(`redirect_uri=${goQueryEscape(input.redirectUri)}`)
  }
  if (input.state.length > 0) {
    pairs.push(`state=${goQueryEscape(input.state)}`)
  }
  pairs.push('prompt=select_account')
  pairs.push(`code_challenge=${goQueryEscape(input.pkce.challenge)}`)
  pairs.push('code_challenge_method=S256')
  if (input.redirectUri === undefined || input.redirectUri.length === 0) {
    pairs.push('cli_pkce_marker=1')
  }
  return `${DEVIN.authorizeEndpoint}?${pairs.join('&')}`
}

/** Local URL-building failure bodies of the login endpoints (500). */
export const FAILED_PKCE_BODY = '{"error":"failed to generate PKCE codes"}'
export const FAILED_STATE_BODY = '{"error":"failed to generate state parameter"}'
export const FAILED_AUTHORIZATION_URL_BODY = '{"error":"failed to generate authorization url"}'

/** Outcome of a login-URL endpoint: success carries the byte-exact body. */
export type LoginUrlResult =
  | { readonly ok: true; readonly state: string; readonly body: string }
  | { readonly ok: false; readonly response: AuthResponse }

export interface LoginServiceDeps {
  readonly now?: Clock
  readonly fetch?: FetchLike
  /** Main server port, used by the Devin management redirect URI. */
  readonly serverPort?: number
}

/**
 * Login-URL service behind `anthropic|codex|antigravity|devin-auth-url`
 * and the device-flow endpoints `kimi|xai|meta-auth-url`. Every success
 * registers a pending session in the Store-backed registry and answers
 * with the map-marshaled JSON body (alphabetical keys, `&` escaped).
 */
export class OAuthLoginService {
  private readonly registry: OAuthSessionRegistry
  private readonly now: Clock
  private readonly fetch: FetchLike
  private readonly serverPort: number | undefined

  constructor(registry: OAuthSessionRegistry, deps: LoginServiceDeps = {}) {
    this.registry = registry
    this.now = deps.now ?? (() => Date.now())
    this.fetch = deps.fetch ?? ((url, init) => fetch(url, init))
    this.serverPort = deps.serverPort
  }

  /** `GET /v0/management/anthropic-auth-url`. */
  async anthropicLoginUrl(): Promise<LoginUrlResult> {
    return this.codeFlowLogin('anthropic', (state, pkce) => buildClaudeAuthorizeUrl({ state, pkce }))
  }

  /** `GET /v0/management/codex-auth-url`. */
  async codexLoginUrl(): Promise<LoginUrlResult> {
    return this.codeFlowLogin('codex', (state, pkce) => buildCodexAuthorizeUrl({ state, pkce }))
  }

  /** `GET /v0/management/antigravity-auth-url`. */
  async antigravityLoginUrl(): Promise<LoginUrlResult> {
    return this.codeFlowLogin('antigravity', (state, pkce) =>
      buildAntigravityAuthorizeUrl({ state, pkce }),
    )
  }

  /** `GET /v0/management/devin-auth-url`. */
  async devinLoginUrl(): Promise<LoginUrlResult> {
    if (this.serverPort === undefined) {
      return { ok: false, response: { status: 500, body: FAILED_AUTHORIZATION_URL_BODY } }
    }
    const redirectUri = `http://127.0.0.1:${this.serverPort}/callback`
    return this.codeFlowLogin('devin', (state, pkce) =>
      buildDevinAuthorizeUrl({ state, pkce, redirectUri }),
    )
  }

  private async codeFlowLogin(
    provider: string,
    buildUrl: (state: string, pkce: PkcePair) => string,
  ): Promise<LoginUrlResult> {
    let pkce: PkcePair
    try {
      pkce = await generatePkcePair()
    } catch {
      return { ok: false, response: { status: 500, body: FAILED_PKCE_BODY } }
    }
    let state: string
    try {
      state = randomHex(16)
    } catch {
      return { ok: false, response: { status: 500, body: FAILED_STATE_BODY } }
    }
    let url: string
    try {
      url = buildUrl(state, pkce)
    } catch {
      return { ok: false, response: { status: 500, body: FAILED_AUTHORIZATION_URL_BODY } }
    }
    await this.registry.register(state, provider, { metadata: { code_verifier: pkce.verifier } })
    const body = goJsonStringify({ state, status: 'ok', url })
    return { ok: true, state, body }
  }

  /** `GET /v0/management/kimi-auth-url` - live Kimi device flow. */
  async kimiLoginUrl(): Promise<LoginUrlResult> {
    return this.deviceFlowLogin('kimi', KIMI.statePrefix, (fetchLike) =>
      startKimiDeviceLogin({ fetch: fetchLike }),
    )
  }

  /** `GET /v0/management/xai-auth-url` - live xAI discovery + device flow. */
  async xaiLoginUrl(): Promise<LoginUrlResult> {
    return this.deviceFlowLogin('xai', XAI.statePrefix, (fetchLike) =>
      startXaiDeviceLogin({ fetch: fetchLike }),
    )
  }

  /** `GET /v0/management/meta-auth-url` - live Meta device flow. */
  async metaLoginUrl(): Promise<LoginUrlResult> {
    return this.deviceFlowLogin('meta', META.statePrefix, (fetchLike) =>
      startMetaDeviceLogin({ fetch: fetchLike }),
    )
  }

  private async deviceFlowLogin(
    provider: string,
    statePrefix: string,
    start: (fetchLike: FetchLike) => Promise<DeviceLoginStart>,
  ): Promise<LoginUrlResult> {
    let started: DeviceLoginStart
    try {
      started = await start(this.fetch)
    } catch {
      return {
        ok: false,
        response: { status: 500, body: deviceStartFailureBody(provider) },
      }
    }
    const nowMs = this.now()
    const state = `${statePrefix}${(nowMs * 1_000_000).toString()}`
    const registered = await this.registry.register(state, provider, {
      metadata: deviceSessionMetadata(started),
    })
    if (!registered.ok) {
      return { ok: false, response: { status: 500, body: FAILED_STATE_BODY } }
    }
    const body = goJsonStringify(deviceResponseBody(provider, state, started))
    return { ok: true, state, body }
  }
}

function deviceStartFailureBody(provider: string): string {
  if (provider === 'kimi') return '{"error":"failed to generate authorization url"}'
  return '{"error":"failed to start device authorization flow"}'
}

function deviceSessionMetadata(started: DeviceLoginStart): JsonValue {
  return {
    device_code: started.deviceCode,
    user_code: started.userCode,
    interval: started.intervalMs,
    expires_in: started.expiresInSeconds,
    token_endpoint: started.tokenEndpoint,
    verification_uri_complete: started.verificationUriComplete,
    ...(started.deviceAuthId === undefined ? {} : { device_auth_id: started.deviceAuthId }),
    ...(started.codeVerifier === undefined ? {} : { code_verifier: started.codeVerifier }),
  }
}

function deviceResponseBody(provider: string, state: string, started: DeviceLoginStart): JsonValue {
  const body: { [key: string]: JsonValue } = {
    flow: 'device',
    state,
    status: 'ok',
    url: started.verificationUriComplete,
    user_code: started.userCode,
  }
  if (provider === 'kimi') {
    // Kimi: expires_in is emitted only when the vendor response provides
    // it - no fallback branch, the key is omitted entirely.
    if (started.expiresInSeconds !== undefined) body['expires_in'] = started.expiresInSeconds
    return body
  }
  const fallback = provider === 'xai' ? XAI.expiresFallbackSeconds : META.expiresFallbackSeconds
  body['expires_in'] = started.expiresInSeconds ?? fallback
  return body
}

/**
 * Parses a form-encoded device/token response body into a record, the way
 * the poll loops read vendor payloads.
 */
export function parseVendorPayload(text: string): Record<string, string> {
  return parseFormValues(text)
}
