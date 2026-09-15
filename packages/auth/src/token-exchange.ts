import type { JsonValue, Store } from '@cpa-edge/core'
import { decodeJwtPayload } from './crypto-util'
import {
  antigravityFileName,
  claudeFileName,
  codexFileName,
  devinFileName,
  kimiFileName,
  metaFileName,
  saveAuthFile,
  xaiFileName,
} from './credential-docs'
import { ANTIGRAVITY, CLAUDE, CODEX, DEVIN, OAUTH_CALLBACK_POLL_INTERVAL_MS, OAUTH_CALLBACK_WAIT_MS } from './providers'
import { consumeCallbackFile, type OAuthCallbackFile } from './oauth-callback'
import type { OAuthSessionRegistry } from './oauth-sessions'
import type { Clock, FetchLike, SleepFn } from './types'
import { asPlainObject, readNumber, readObject, readString } from './types'
import { formatRfc3339, jsonStringifyOrdered } from './wire'

/**
 * Authorization-code token exchanges per provider, credential-document
 * assembly, and the login waiter that stands behind the login-URL
 * endpoints. Request wire formats follow S3 §2.3: Claude posts JSON with a
 * fixed field order, Codex and Antigravity post forms with alphabetically
 * encoded keys, Devin posts its minimal JSON pair. Vendor calls are
 * CREDENTIALED-ONLY (R-FIXTURE) and always run through the injectable
 * fetch, so tests replay scripted responses.
 */

export interface ExchangeDeps {
  readonly fetch?: FetchLike
  readonly now?: Clock
  /** Notification hook for advisory-call failures (never fatal). */
  readonly onAdvisoryFailure?: (endpoint: string, error: unknown) => void
}

function defaultFetch(): FetchLike {
  return (url, init) => fetch(url, init)
}

async function readJson(response: Response): Promise<Record<string, unknown> | undefined> {
  const text = await response.text()
  try {
    return asPlainObject(JSON.parse(text))
  } catch {
    return undefined
  }
}

/** Result of an exchange: the auth-file name plus the document to persist. */
export interface ExchangeResult {
  readonly fileName: string
  readonly document: Record<string, JsonValue>
}

/** Error with the session status message the waiter records. */
export class ExchangeError extends Error {
  readonly statusMessage: string
  constructor(statusMessage: string, cause?: unknown) {
    super(statusMessage, cause === undefined ? undefined : { cause })
    this.name = 'ExchangeError'
    this.statusMessage = statusMessage
  }
}

/** Splits a `code#state` pair the native Claude client produces. */
export function splitCodeState(code: string): { code: string; state?: string } {
  const hash = code.indexOf('#')
  if (hash < 0) return { code }
  return { code: code.slice(0, hash), state: code.slice(hash + 1) }
}

export interface ClaudeExchangeInput {
  readonly code: string
  readonly codeVerifier: string
  readonly redirectUri?: string
  readonly state?: string
}

/**
 * Claude code exchange + advisory identity calls. The `#state` suffix on
 * the code overrides the state field. Profile/roles calls never fail the
 * login; non-empty profile values override the token-response identity.
 */
export async function exchangeClaudeCode(
  input: ClaudeExchangeInput,
  deps: ExchangeDeps = {},
): Promise<ExchangeResult> {
  const fetchLike = deps.fetch ?? defaultFetch()
  const now = deps.now ?? (() => Date.now())
  const nowMs = now()
  const split = splitCodeState(input.code)
  const state = split.state ?? input.state ?? ''
  const body = jsonStringifyOrdered({
    grant_type: 'authorization_code',
    code: split.code,
    redirect_uri: input.redirectUri ?? CLAUDE.redirectUri,
    client_id: CLAUDE.clientId,
    code_verifier: input.codeVerifier,
    state,
  })
  const response = await fetchLike(CLAUDE.tokenEndpoint, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
      'User-Agent': 'axios/1.15.2',
      'Accept-Encoding': 'gzip, compress, deflate, br',
      Connection: 'close',
    },
    body,
  })
  if (!response.ok) {
    throw new ExchangeError('Failed to exchange authorization code for tokens')
  }
  const token = await readJson(response)
  if (token === undefined) {
    throw new ExchangeError('Failed to exchange authorization code for tokens')
  }
  const accessToken = readString(token, 'access_token')
  const refreshToken = readString(token, 'refresh_token')
  const expiresIn = readNumber(token, 'expires_in')
  if (accessToken === undefined || refreshToken === undefined || expiresIn === undefined) {
    throw new ExchangeError('Failed to exchange authorization code for tokens')
  }
  const organization = readObject(token, 'organization')
  const account = readObject(token, 'account')
  let organizationUuid =
    organization === undefined ? undefined : readString(organization, 'uuid')
  let organizationName =
    organization === undefined ? undefined : readString(organization, 'name')
  let accountUuid = account === undefined ? undefined : readString(account, 'uuid')
  let email = account === undefined ? undefined : readString(account, 'email_address')
  // Advisory identity calls: failures are reported, never fatal.
  const bearer = { Authorization: `Bearer ${accessToken}`, 'Cache-Control': 'no-cache' }
  try {
    const profileResponse = await fetchLike(CLAUDE.profileEndpoint, { method: 'GET', headers: bearer })
    if (profileResponse.ok) {
      const profile = await readJson(profileResponse)
      if (profile !== undefined) {
        const profileOrg = readString(profile, 'organization_uuid')
        const profileAccount = readString(profile, 'account_uuid')
        const profileEmail = readString(profile, 'email')
        const profileOrgName = readString(profile, 'organization_name')
        if (profileOrg !== undefined && profileOrg.length > 0) organizationUuid = profileOrg
        if (profileAccount !== undefined && profileAccount.length > 0) accountUuid = profileAccount
        if (profileEmail !== undefined && profileEmail.length > 0) email = profileEmail
        if (profileOrgName !== undefined && profileOrgName.length > 0) organizationName = profileOrgName
      }
    }
  } catch (error) {
    deps.onAdvisoryFailure?.(CLAUDE.profileEndpoint, error)
  }
  try {
    const rolesResponse = await fetchLike(CLAUDE.rolesEndpoint, { method: 'GET', headers: bearer })
    if (!rolesResponse.ok) {
      deps.onAdvisoryFailure?.(CLAUDE.rolesEndpoint, new Error(`status ${rolesResponse.status}`))
    }
  } catch (error) {
    deps.onAdvisoryFailure?.(CLAUDE.rolesEndpoint, error)
  }
  const effectiveEmail = email ?? accountUuid ?? 'unknown'
  const document: Record<string, JsonValue> = {
    id_token: '',
    access_token: accessToken,
    refresh_token: refreshToken,
    last_refresh: formatRfc3339(nowMs),
    email: effectiveEmail,
    type: 'claude',
    expired: formatRfc3339(nowMs + expiresIn * 1000),
  }
  if (accountUuid !== undefined) document['account_uuid'] = accountUuid
  if (organizationUuid !== undefined) document['organization_uuid'] = organizationUuid
  if (organizationName !== undefined) document['organization_name'] = organizationName
  const fileName = await claudeFileName({
    organizationUuid,
    accountUuid,
    email: effectiveEmail,
  })
  return { fileName, document }
}

export interface CodexExchangeInput {
  readonly code: string
  readonly codeVerifier: string
  readonly redirectUri?: string
}

/** Codex code exchange; the id_token JWT is decoded, never verified. */
export async function exchangeCodexCode(
  input: CodexExchangeInput,
  deps: ExchangeDeps = {},
): Promise<ExchangeResult> {
  const fetchLike = deps.fetch ?? defaultFetch()
  const now = deps.now ?? (() => Date.now())
  const nowMs = now()
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: CODEX.clientId,
    code: input.code,
    redirect_uri: input.redirectUri ?? CODEX.redirectUri,
    code_verifier: input.codeVerifier,
  })
  const response = await fetchLike(CODEX.tokenEndpoint, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  })
  if (!response.ok) {
    throw new ExchangeError('Failed to exchange authorization code for tokens')
  }
  const token = await readJson(response)
  if (token === undefined) {
    throw new ExchangeError('Failed to exchange authorization code for tokens')
  }
  const accessToken = readString(token, 'access_token')
  const refreshToken = readString(token, 'refresh_token')
  const idToken = readString(token, 'id_token')
  const expiresIn = readNumber(token, 'expires_in')
  if (accessToken === undefined || refreshToken === undefined || expiresIn === undefined) {
    throw new ExchangeError('Failed to exchange authorization code for tokens')
  }
  const claims = idToken === undefined ? undefined : decodeJwtPayload(idToken)
  const email =
    claims === undefined ? undefined : (readString(claims, 'email') ?? 'unknown')
  const accountId =
    claims === undefined
      ? undefined
      : readString(claims, 'https://api.openai.com/auth.chatgpt_account_id')
  const planType =
    claims === undefined
      ? undefined
      : readString(claims, 'https://api.openai.com/auth.chatgpt_plan_type')
  const document: Record<string, JsonValue> = {
    id_token: idToken ?? '',
    access_token: accessToken,
    refresh_token: refreshToken,
    last_refresh: formatRfc3339(nowMs),
    email: email ?? 'unknown',
    type: 'codex',
    expired: formatRfc3339(nowMs + expiresIn * 1000),
  }
  if (accountId !== undefined) document['account_id'] = accountId
  if (planType !== undefined && planType.length > 0) document['plan_type'] = planType
  const fileName = await codexFileName({
    accountId,
    email: email ?? 'unknown',
    plan: planType,
  })
  return { fileName, document }
}

/** Antigravity code exchange + mandatory enrichment (failures fatal). */
export async function exchangeAntigravityCode(
  input: { readonly code: string; readonly codeVerifier?: string },
  deps: ExchangeDeps = {},
): Promise<ExchangeResult> {
  const fetchLike = deps.fetch ?? defaultFetch()
  const now = deps.now ?? (() => Date.now())
  const nowMs = now()
  const form = new URLSearchParams({
    code: input.code,
    client_id: ANTIGRAVITY.clientId,
    client_secret: ANTIGRAVITY.clientSecret,
    redirect_uri: ANTIGRAVITY.redirectUri,
    grant_type: 'authorization_code',
  })
  const response = await fetchLike(ANTIGRAVITY.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  })
  if (!response.ok) {
    throw new ExchangeError('Failed to exchange authorization code for tokens')
  }
  const token = await readJson(response)
  if (token === undefined) {
    throw new ExchangeError('Failed to exchange authorization code for tokens')
  }
  const accessToken = readString(token, 'access_token')
  const refreshToken = readString(token, 'refresh_token')
  const expiresIn = readNumber(token, 'expires_in')
  if (accessToken === undefined || refreshToken === undefined || expiresIn === undefined) {
    throw new ExchangeError('Failed to exchange authorization code for tokens')
  }
  const bearer = { Authorization: `Bearer ${accessToken}` }
  const emailResponse = await fetchLike(ANTIGRAVITY.userinfoEndpoint, { method: 'GET', headers: bearer })
  if (!emailResponse.ok) throw new ExchangeError('Failed to exchange authorization code for tokens')
  const profile = await readJson(emailResponse)
  const email = profile === undefined ? undefined : readString(profile, 'email')
  if (email === undefined) {
    throw new ExchangeError('Failed to exchange authorization code for tokens')
  }
  const projectResponse = await fetchLike(ANTIGRAVITY.cloudCodeEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...bearer },
    body: JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY' } }),
  })
  if (!projectResponse.ok) {
    throw new ExchangeError('Failed to exchange authorization code for tokens')
  }
  const project = await readJson(projectResponse)
  const projectObject = project === undefined ? undefined : readObject(project, 'cloudaicompanionProject')
  const projectId =
    projectObject === undefined ? undefined : readString(projectObject, 'id') ?? readString(projectObject, 'projectId')
  if (projectId === undefined) {
    throw new ExchangeError('Failed to exchange authorization code for tokens')
  }
  const document: Record<string, JsonValue> = {
    type: 'antigravity',
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: expiresIn,
    timestamp: nowMs,
    expired: formatRfc3339(nowMs + expiresIn * 1000),
    email,
    project_id: projectId,
  }
  return { fileName: antigravityFileName(email), document }
}

export interface DevinExchangeInput {
  readonly code: string
  readonly codeVerifier: string
  /** Optional best-effort status endpoint (email/plan); not pinned by S3. */
  readonly statusEndpoint?: string
}

/** Devin code exchange; enrichment is best effort, wrap uses the eyJ rule. */
export async function exchangeDevinCode(
  input: DevinExchangeInput,
  deps: ExchangeDeps = {},
): Promise<ExchangeResult> {
  const fetchLike = deps.fetch ?? defaultFetch()
  const now = deps.now ?? (() => Date.now())
  const nowMs = now()
  const response = await fetchLike(DEVIN.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: jsonStringifyOrdered({ code: input.code, code_verifier: input.codeVerifier }),
  })
  if (!response.ok) {
    throw new ExchangeError('Failed to exchange authorization code for tokens')
  }
  const token = await readJson(response)
  const rawToken = token === undefined ? undefined : readString(token, 'token')
  if (rawToken === undefined) {
    throw new ExchangeError('Failed to exchange authorization code for tokens')
  }
  const sessionToken =
    rawToken.startsWith('eyJ') && !rawToken.startsWith(DEVIN.sessionTokenPrefix)
      ? `${DEVIN.sessionTokenPrefix}${rawToken}`
      : rawToken
  let userName: string | undefined
  let userId: string | undefined
  let orgId: string | undefined
  let email: string | undefined
  let plan: string | undefined
  try {
    const selfResponse = await fetchLike(DEVIN.selfEndpoint, {
      method: 'GET',
      headers: { Authorization: `Bearer ${sessionToken}` },
    })
    if (selfResponse.ok) {
      const self = await readJson(selfResponse)
      if (self !== undefined) {
        userName = readString(self, 'user_name')
        userId = readString(self, 'user_id')
        orgId = readString(self, 'org_id')
      }
    }
  } catch (error) {
    deps.onAdvisoryFailure?.(DEVIN.selfEndpoint, error)
  }
  if (input.statusEndpoint !== undefined) {
    try {
      const statusResponse = await fetchLike(input.statusEndpoint, {
        method: 'GET',
        headers: { Authorization: `Bearer ${sessionToken}` },
      })
      if (statusResponse.ok) {
        const status = await readJson(statusResponse)
        if (status !== undefined) {
          email = readString(status, 'email')
          plan = readString(status, 'plan')
        }
      }
    } catch (error) {
      deps.onAdvisoryFailure?.(input.statusEndpoint, error)
    }
  }
  const document: Record<string, JsonValue> = {
    type: 'devin',
    api_key: sessionToken,
    session_token: sessionToken,
    auth_kind: 'oauth',
    base_url: DEVIN.baseUrlAttribute,
  }
  if (userName !== undefined) document['user_name'] = userName
  if (userId !== undefined) document['user_id'] = userId
  if (orgId !== undefined) document['org_id'] = orgId
  if (email !== undefined) document['email'] = email
  if (plan !== undefined) document['plan'] = plan
  const fileName = await devinFileName({
    userName,
    userId,
    sessionToken,
  })
  return { fileName, document }
}

/** Builds the Kimi credential document from a device-flow token payload. */
export async function buildKimiCredential(
  payload: Record<string, unknown>,
  nowMs: number,
): Promise<ExchangeResult> {
  const accessToken = readString(payload, 'access_token')
  const refreshToken = readString(payload, 'refresh_token')
  if (accessToken === undefined || refreshToken === undefined) {
    throw new ExchangeError('Failed to save authentication tokens')
  }
  const document: Record<string, JsonValue> = {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: readString(payload, 'token_type') ?? 'Bearer',
    type: 'kimi',
    timestamp: nowMs,
  }
  const scope = readString(payload, 'scope')
  if (scope !== undefined) document['scope'] = scope
  const expiresIn = readNumber(payload, 'expires_in')
  if (expiresIn !== undefined) {
    document['expired'] = formatRfc3339(nowMs + expiresIn * 1000)
  }
  return { fileName: kimiFileName(nowMs), document }
}

/** Builds the xAI credential document (email/sub from the id_token JWT). */
export async function buildXaiCredential(
  payload: Record<string, unknown>,
  tokenEndpoint: string,
  nowMs: number,
): Promise<ExchangeResult> {
  const accessToken = readString(payload, 'access_token')
  const refreshToken = readString(payload, 'refresh_token')
  const expiresIn = readNumber(payload, 'expires_in')
  if (accessToken === undefined || refreshToken === undefined || expiresIn === undefined) {
    throw new ExchangeError('Failed to save authentication tokens')
  }
  const idToken = readString(payload, 'id_token')
  const claims = idToken === undefined ? undefined : decodeJwtPayload(idToken)
  const email = claims === undefined ? undefined : readString(claims, 'email')
  const sub = claims === undefined ? undefined : readString(claims, 'sub')
  const document: Record<string, JsonValue> = {
    access_token: accessToken,
    refresh_token: refreshToken,
    id_token: idToken ?? '',
    token_type: readString(payload, 'token_type') ?? 'Bearer',
    expires_in: expiresIn,
    expired: formatRfc3339(nowMs + expiresIn * 1000),
    last_refresh: formatRfc3339(nowMs),
    base_url: 'https://api.x.ai/v1',
    token_endpoint: tokenEndpoint,
    auth_kind: 'oauth',
    timestamp: nowMs,
  }
  if (email !== undefined) document['email'] = email
  if (sub !== undefined) document['sub'] = sub
  const fileName = xaiFileName({ email, sub, nowMs })
  return { fileName, document }
}

/**
 * Builds the Meta credential document. When key minting succeeded the
 * stored `access_token` becomes the minted `api_key` and `expired` stays
 * empty (an API key has no DCA deadline); otherwise `expired` is the DCA
 * expiry.
 */
export async function buildMetaCredential(
  payload: Record<string, unknown>,
  nowMs: number,
): Promise<ExchangeResult> {
  const accessToken = readString(payload, 'access_token')
  if (accessToken === undefined) {
    throw new ExchangeError('Failed to save authentication tokens')
  }
  const minted = readObject(payload, 'minted')
  const apiKey = minted === undefined ? undefined : readString(minted, 'api_key')
  const userEmail = minted === undefined ? undefined : readString(minted, 'user_email')
  const document: Record<string, JsonValue> = {
    auth_kind: 'oauth',
    access_token: apiKey !== undefined ? apiKey : accessToken,
    dca_token: accessToken,
    type: 'meta',
  }
  if (apiKey !== undefined) {
    document['api_key'] = apiKey
  } else {
    const expiresIn = readNumber(payload, 'expires_in')
    document['expires_in'] = expiresIn ?? 0
    document['expired'] = formatRfc3339(nowMs + (expiresIn ?? 0) * 1000)
    document['dca_expired'] = formatRfc3339(nowMs + (expiresIn ?? 0) * 1000)
    document['dca_expires_at'] = nowMs + (expiresIn ?? 0) * 1000
  }
  if (minted !== undefined) {
    const baseUrl = readString(minted, 'base_url')
    if (baseUrl !== undefined) document['base_url'] = baseUrl
    const fullName = readString(minted, 'user_full_name')
    if (fullName !== undefined) document['name'] = fullName
  }
  if (userEmail !== undefined) document['email'] = userEmail
  document['last_refresh'] = formatRfc3339(nowMs)
  const fileName = await metaFileName({
    email: userEmail,
    accessToken: apiKey !== undefined ? apiKey : accessToken,
  })
  return { fileName, document }
}

export interface LoginWaiterDeps extends ExchangeDeps {
  readonly sleep?: SleepFn
  readonly pollIntervalMs?: number
  readonly timeoutMs?: number
  readonly devinStatusEndpoint?: string
}

export type LoginWaiterOutcome =
  | { readonly ok: true; readonly fileName: string }
  /** The session stopped being pending (cancel race): silent abort. */
  | { readonly ok: false; readonly aborted: true }
  | { readonly ok: false; readonly aborted: false; readonly statusMessage: string }

/**
 * Login waiter shared by the code-flow endpoints: polls the callback
 * handshake document every 500 ms for at most 5 minutes, exchanges the
 * code, and saves the credential. A session that stops being pending
 * (cancel race) aborts silently; a timeout or exchange/save failure marks
 * the session with the recorded status message.
 */
export async function runCodeLoginWaiter(
  store: Store,
  registry: OAuthSessionRegistry,
  provider: 'anthropic' | 'codex' | 'antigravity' | 'devin',
  state: string,
  deps: LoginWaiterDeps = {},
): Promise<LoginWaiterOutcome> {
  const now = deps.now ?? (() => Date.now())
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const deadlineAt = now() + (deps.timeoutMs ?? OAUTH_CALLBACK_WAIT_MS)
  let callback: OAuthCallbackFile | undefined
  while (now() < deadlineAt) {
    const session = await registry.get(state)
    if (session === undefined || session.completed || session.status !== 'pending') {
      return { ok: false, aborted: true }
    }
    callback = await consumeCallbackFile(store, provider, state)
    if (callback !== undefined) break
    await sleep(deps.pollIntervalMs ?? OAUTH_CALLBACK_POLL_INTERVAL_MS)
  }
  if (callback === undefined) {
    await registry.setStatusError(state, 'Timeout waiting for OAuth callback')
    return { ok: false, aborted: false, statusMessage: 'Timeout waiting for OAuth callback' }
  }
  if (callback.error.length > 0) {
    await registry.setStatusError(state, callback.error)
    return { ok: false, aborted: false, statusMessage: callback.error }
  }
  const session = await registry.get(state)
  if (session === undefined || session.completed || session.status !== 'pending') {
    return { ok: false, aborted: true }
  }
  const metadata = asPlainObject(session.metadata)
  const codeVerifier = metadata === undefined ? undefined : readString(metadata, 'code_verifier')
  if (codeVerifier === undefined) {
    await registry.setStatusError(state, 'Bad request')
    return { ok: false, aborted: false, statusMessage: 'Bad request' }
  }
  let result: ExchangeResult
  try {
    result =
      provider === 'anthropic'
        ? await exchangeClaudeCode(
            { code: callback.code, codeVerifier, state },
            { fetch: deps.fetch, now: deps.now, onAdvisoryFailure: deps.onAdvisoryFailure },
          )
        : provider === 'codex'
          ? await exchangeCodexCode({ code: callback.code, codeVerifier }, { fetch: deps.fetch, now: deps.now })
          : provider === 'antigravity'
            ? await exchangeAntigravityCode({ code: callback.code }, { fetch: deps.fetch, now: deps.now })
            : await exchangeDevinCode(
                { code: callback.code, codeVerifier, statusEndpoint: deps.devinStatusEndpoint },
                { fetch: deps.fetch, now: deps.now, onAdvisoryFailure: deps.onAdvisoryFailure },
              )
  } catch (error) {
    const message =
      error instanceof ExchangeError
        ? error.statusMessage
        : 'Failed to exchange authorization code for tokens'
    await registry.setStatusError(state, message)
    return { ok: false, aborted: false, statusMessage: message }
  }
  try {
    await saveAuthFile(store, result.fileName, result.document)
  } catch {
    await registry.setStatusError(state, 'Failed to save authentication tokens')
    return { ok: false, aborted: false, statusMessage: 'Failed to save authentication tokens' }
  }
  await registry.complete(state)
  return { ok: true, fileName: result.fileName }
}
