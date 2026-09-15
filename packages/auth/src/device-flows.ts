import { CODEX, KIMI, META, XAI } from './providers'
import type { Clock, FetchLike, SleepFn } from './types'
import { asPlainObject, readNumber, readString } from './types'

/**
 * Device-code flows (RFC 8628 and vendor variants) for Kimi, xAI, Meta and
 * Codex. Starters perform the device-authorization request (plus xAI's
 * OIDC discovery with its https/x.ai endpoint check); pollers drive the
 * token endpoint with the per-provider semantics the spec pins:
 *
 * - Kimi: first poll after one interval; `slow_down` is a no-op in the
 *   reference (fixed ticker) - mirrored here on purpose (O-5).
 * - xAI: first poll immediately; `slow_down` adds 5 s.
 * - Meta: first poll after one interval; `slow_down` adds 5 s and resets
 *   the ticker; unexpected non-200 bodies without an error keep polling.
 * - Codex: proprietary deviceauth API; 403/404 keep polling, success
 *   yields an authorization code + PKCE pair for the standard exchange.
 */

/** Result of a device-authorization start. */
export interface DeviceLoginStart {
  /** RFC 8628 `device_code`; unused by the Codex variant. */
  readonly deviceCode: string
  readonly userCode: string
  readonly verificationUriComplete: string
  /** Poll interval, already floored at 5 s. */
  readonly intervalMs: number
  /** Vendor-provided lifetime; Kimi omits the key entirely when absent. */
  readonly expiresInSeconds: number | undefined
  /** Token endpoint the poller posts to (discovery-derived for xAI). */
  readonly tokenEndpoint: string
  /** Codex device variant: `device_auth_id` instead of a device code. */
  readonly deviceAuthId?: string
  /** Optional extra request headers (e.g. Kimi's platform headers). */
  readonly extraHeaders?: Readonly<Record<string, string>>
}

/** Outcome of a poll loop. */
export type DevicePollResult =
  | { readonly ok: true; readonly payload: Record<string, unknown> }
  | { readonly ok: false; readonly message: string }

export interface DeviceFlowDeps {
  readonly fetch?: FetchLike
  readonly sleep?: SleepFn
  readonly now?: Clock
  /** Extra headers for Kimi's vendor endpoints (names not pinned by S3). */
  readonly kimiHeaders?: Readonly<Record<string, string>>
}

async function readJsonResponse(
  response: Response,
): Promise<{ status: number; json: Record<string, unknown> | undefined }> {
  const text = await response.text()
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }
  return { status: response.status, json: asPlainObject(json) }
}

function intervalFromVendor(value: unknown, floorMs: number): number {
  const seconds =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(seconds) || seconds < 0) return floorMs
  return Math.max(seconds * 1000, floorMs)
}

function verificationUriOf(json: Record<string, unknown>): string {
  return (
    readString(json, 'verification_uri_complete') ??
    readString(json, 'verification_uri') ??
    ''
  )
}

export interface StartDeviceLoginInput {
  readonly fetch: FetchLike
  readonly kimiHeaders?: Readonly<Record<string, string>>
}

/** Kimi: device authorization against the fixed vendor endpoint. */
export async function startKimiDeviceLogin(
  input: StartDeviceLoginInput,
): Promise<DeviceLoginStart> {
  const response = await input.fetch(KIMI.deviceAuthorizationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...input.kimiHeaders },
    body: `client_id=${encodeURIComponent(KIMI.clientId)}`,
  })
  if (!response.ok) throw new Error('device authorization failed')
  const { json } = await readJsonResponse(response)
  if (json === undefined) throw new Error('device authorization response unparsable')
  const deviceCode = readString(json, 'device_code')
  const userCode = readString(json, 'user_code')
  if (deviceCode === undefined || userCode === undefined) {
    throw new Error('device authorization response incomplete')
  }
  return {
    deviceCode,
    userCode,
    verificationUriComplete: verificationUriOf(json),
    intervalMs: intervalFromVendor(readNumber(json, 'interval'), KIMI.intervalFloorMs),
    expiresInSeconds: readNumber(json, 'expires_in'),
    tokenEndpoint: KIMI.tokenEndpoint,
    extraHeaders: input.kimiHeaders,
  }
}

function isXaiHttpsEndpoint(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') return false
    const host = parsed.hostname
    return host === 'x.ai' || host.endsWith('.x.ai')
  } catch {
    return false
  }
}

/** xAI: OIDC discovery, endpoint validation, then device authorization. */
export async function startXaiDeviceLogin(
  input: StartDeviceLoginInput,
): Promise<DeviceLoginStart> {
  const discovery = await input.fetch(XAI.discoveryEndpoint, { method: 'GET' })
  if (!discovery.ok) throw new Error('discovery failed')
  const { json: discovered } = await readJsonResponse(discovery)
  if (discovered === undefined) throw new Error('discovery response unparsable')
  const deviceEndpoint = readString(discovered, 'device_authorization_endpoint')
  const tokenEndpoint = readString(discovered, 'token_endpoint')
  if (deviceEndpoint === undefined || tokenEndpoint === undefined) {
    throw new Error('discovery response incomplete')
  }
  if (!isXaiHttpsEndpoint(deviceEndpoint) || !isXaiHttpsEndpoint(tokenEndpoint)) {
    throw new Error('discovery endpoints outside the x.ai origin')
  }
  const form = new URLSearchParams({
    client_id: XAI.clientId,
    scope: XAI.deviceScope,
  })
  const response = await input.fetch(deviceEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  })
  if (!response.ok) throw new Error('device authorization failed')
  const { json } = await readJsonResponse(response)
  if (json === undefined) throw new Error('device authorization response unparsable')
  const deviceCode = readString(json, 'device_code')
  const userCode = readString(json, 'user_code')
  if (deviceCode === undefined || userCode === undefined) {
    throw new Error('device authorization response incomplete')
  }
  return {
    deviceCode,
    userCode,
    verificationUriComplete: verificationUriOf(json),
    intervalMs: intervalFromVendor(readNumber(json, 'interval'), XAI.intervalFloorMs),
    expiresInSeconds: readNumber(json, 'expires_in'),
    tokenEndpoint,
  }
}

/** Meta: device authorization against the fixed vendor endpoint. */
export async function startMetaDeviceLogin(
  input: StartDeviceLoginInput,
): Promise<DeviceLoginStart> {
  const response = await input.fetch(META.deviceAuthorizationEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': META.userAgent,
    },
    body: `client_id=${encodeURIComponent(META.clientId)}`,
  })
  if (!response.ok) throw new Error('device authorization failed')
  const { json } = await readJsonResponse(response)
  if (json === undefined) throw new Error('device authorization response unparsable')
  const deviceCode = readString(json, 'device_code')
  const userCode = readString(json, 'user_code')
  if (deviceCode === undefined || userCode === undefined) {
    throw new Error('device authorization response incomplete')
  }
  return {
    deviceCode,
    userCode,
    verificationUriComplete: verificationUriOf(json),
    intervalMs: intervalFromVendor(readNumber(json, 'interval'), META.intervalFloorMs),
    expiresInSeconds: readNumber(json, 'expires_in'),
    tokenEndpoint: META.tokenEndpoint,
  }
}

/** Codex device variant: usercode request returns `device_auth_id`. */
export async function startCodexDeviceLogin(
  input: StartDeviceLoginInput,
): Promise<DeviceLoginStart> {
  const response = await input.fetch(CODEX.deviceUsercodeEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: CODEX.clientId }),
  })
  if (!response.ok) throw new Error('device authorization failed')
  const { json } = await readJsonResponse(response)
  if (json === undefined) throw new Error('device authorization response unparsable')
  const deviceAuthId = readString(json, 'device_auth_id')
  const userCode = readString(json, 'user_code') ?? readString(json, 'usercode')
  if (deviceAuthId === undefined || userCode === undefined) {
    throw new Error('device authorization response incomplete')
  }
  return {
    deviceCode: deviceAuthId,
    deviceAuthId,
    userCode,
    verificationUriComplete: CODEX.deviceVerificationUrl,
    intervalMs: intervalFromVendor(
      readNumber(json, 'interval') ?? readString(json, 'interval'),
      5_000,
    ),
    expiresInSeconds: 900,
    tokenEndpoint: CODEX.deviceTokenEndpoint,
  }
}

export interface PollDeviceInput {
  readonly start: DeviceLoginStart
  /** Poll deadline in epoch ms. */
  readonly deadlineAtMs: number
}

export interface PollDeviceDeps {
  readonly fetch: FetchLike
  readonly sleep: SleepFn
  readonly now: Clock
  readonly kimiHeaders?: Readonly<Record<string, string>>
}

async function postToken(
  deps: PollDeviceDeps,
  endpoint: string,
  init: { headers: Record<string, string>; body: string },
): Promise<{ status: number; json: Record<string, unknown> | undefined }> {
  const response = await deps.fetch(endpoint, { method: 'POST', ...init })
  return readJsonResponse(response)
}

/** Kimi poll: fixed ticker, `slow_down` no-op, exact terminal messages. */
export async function pollKimiDeviceToken(
  input: PollDeviceInput,
  deps: PollDeviceDeps,
): Promise<DevicePollResult> {
  const form = (deviceCode: string): string =>
    `client_id=${encodeURIComponent(KIMI.clientId)}&device_code=${encodeURIComponent(deviceCode)}&grant_type=${encodeURIComponent(KIMI.deviceGrant)}`
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    ...(deps.kimiHeaders ?? {}),
  }
  while (deps.now() < input.deadlineAtMs) {
    await deps.sleep(input.start.intervalMs)
    const { status, json } = await postToken(deps, input.start.tokenEndpoint, {
      headers,
      body: form(input.start.deviceCode),
    })
    const error = json === undefined ? undefined : readString(json, 'error')
    if (error === 'authorization_pending') continue
    if (error === 'slow_down') {
      // The reference never widens the interval here; mirrored (O-5).
      continue
    }
    if (error === 'expired_token') return { ok: false, message: 'kimi: device code expired' }
    if (error === 'access_denied') return { ok: false, message: 'kimi: access denied by user' }
    if (status === 200 && error === undefined && json !== undefined) {
      return { ok: true, payload: json }
    }
    return { ok: false, message: `kimi: unexpected device token response (${status})` }
  }
  return { ok: false, message: 'kimi: device code expired' }
}

/** xAI poll: immediate first poll, `slow_down` widens the interval by 5 s. */
export async function pollXaiDeviceToken(
  input: PollDeviceInput,
  deps: PollDeviceDeps,
): Promise<DevicePollResult> {
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' }
  const form = (deviceCode: string): string =>
    `grant_type=urn:ietf:params:oauth:grant-type:device_code&device_code=${encodeURIComponent(deviceCode)}&client_id=${encodeURIComponent(XAI.clientId)}`
  let intervalMs = input.start.intervalMs
  while (deps.now() < input.deadlineAtMs) {
    const { status, json } = await postToken(deps, input.start.tokenEndpoint, {
      headers,
      body: form(input.start.deviceCode),
    })
    const error = json === undefined ? undefined : readString(json, 'error')
    if (error === 'authorization_pending') {
      await deps.sleep(intervalMs)
      continue
    }
    if (error === 'slow_down') {
      intervalMs += 5_000
      await deps.sleep(intervalMs)
      continue
    }
    if (error === 'expired_token' || error === 'access_denied') {
      return { ok: false, message: `xai: ${error}` }
    }
    if (status >= 200 && status < 300 && error === undefined && json !== undefined) {
      return { ok: true, payload: json }
    }
    return { ok: false, message: `xai: unexpected device token response (${status})` }
  }
  return { ok: false, message: 'xai: device code expired' }
}

/** Meta poll: ticker reset on `slow_down`, non-fatal mint step afterwards. */
export async function pollMetaDeviceToken(
  input: PollDeviceInput,
  deps: PollDeviceDeps,
): Promise<DevicePollResult> {
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'User-Agent': META.userAgent,
  }
  const form = (deviceCode: string): string =>
    `grant_type=urn:ietf:params:oauth:grant-type:device_code&device_code=${encodeURIComponent(deviceCode)}&client_id=${encodeURIComponent(META.clientId)}`
  let intervalMs = input.start.intervalMs
  while (deps.now() < input.deadlineAtMs) {
    await deps.sleep(intervalMs)
    const { status, json } = await postToken(deps, input.start.tokenEndpoint, {
      headers,
      body: form(input.start.deviceCode),
    })
    if (status === 200 && json !== undefined && readString(json, 'error') === undefined) {
      return { ok: true, payload: await mintMetaKey(json, deps) }
    }
    const error = json === undefined ? undefined : readString(json, 'error')
    if (error === 'authorization_pending') continue
    if (error === 'slow_down') {
      intervalMs += 5_000
      continue
    }
    if (error === 'access_denied' || error === 'expired_token') {
      return { ok: false, message: `meta: ${error}` }
    }
    if (error !== undefined) return { ok: false, message: `meta: ${error}` }
    // Unexpected non-200 without an error body: keep polling.
    continue
  }
  return { ok: false, message: 'meta: device code expired' }
}

/**
 * Meta key minting: exchange the DCA access token for an API key. Mint
 * failure is non-fatal for login - the credential then keeps the DCA
 * expiry instead of an empty one.
 */
async function mintMetaKey(
  tokenPayload: Record<string, unknown>,
  deps: PollDeviceDeps,
): Promise<Record<string, unknown>> {
  const dcaToken = readString(tokenPayload, 'access_token')
  if (dcaToken === undefined) return tokenPayload
  let minted: Record<string, unknown> | undefined
  try {
    const response = await deps.fetch(META.keyMintEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${dcaToken}`,
        'User-Agent': META.userAgent,
      },
      body: JSON.stringify({ dca_token: dcaToken }),
    })
    if (response.ok) minted = asPlainObject(JSON.parse(await response.text()))
  } catch {
    minted = undefined
  }
  return { ...tokenPayload, ...(minted === undefined ? {} : { minted }) }
}

/** Codex device poll: 403/404 keep polling; success carries code + PKCE. */
export async function pollCodexDeviceToken(
  input: PollDeviceInput,
  deps: PollDeviceDeps,
): Promise<DevicePollResult> {
  const headers = { 'Content-Type': 'application/json' }
  const body = JSON.stringify({
    device_auth_id: input.start.deviceAuthId,
    user_code: input.start.userCode,
  })
  while (deps.now() < input.deadlineAtMs) {
    const { status, json } = await postToken(deps, input.start.tokenEndpoint, { headers, body })
    if (status === 403 || status === 404) {
      await deps.sleep(input.start.intervalMs)
      continue
    }
    if (status >= 200 && status < 300 && json !== undefined) {
      const authorizationCode = readString(json, 'authorization_code')
      const codeVerifier = readString(json, 'code_verifier')
      if (authorizationCode === undefined || codeVerifier === undefined) {
        return { ok: false, message: 'codex: device token response incomplete' }
      }
      return { ok: true, payload: json }
    }
    if (status < 200 || status >= 300) {
      return { ok: false, message: `codex: device token failed (${status})` }
    }
    await deps.sleep(input.start.intervalMs)
  }
  return { ok: false, message: 'codex: device code expired' }
}

/** Deadline helper: min(vendor lifetime, provider cap), epoch ms. */
export function deviceDeadlineMs(
  provider: 'kimi' | 'xai' | 'meta' | 'codex',
  expiresInSeconds: number | undefined,
  nowMs: number,
): number {
  const cap = provider === 'xai' ? XAI.deadlineMs : provider === 'codex' ? 15 * 60_000 : KIMI.deadlineMs
  if (expiresInSeconds === undefined) return nowMs + cap
  return nowMs + Math.min(cap, expiresInSeconds * 1000)
}
