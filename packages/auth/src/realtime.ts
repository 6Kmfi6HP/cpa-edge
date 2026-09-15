import {
  authenticateClientRequest,
  INVALID_API_KEY_BODY,
  MISSING_API_KEY_BODY,
  type ClientAuthHeaders,
  type ClientAuthResult,
  extractBearerToken,
} from './api-keys'
import { sha256Hex } from './crypto-util'
import type { Store, JsonValue } from '@cpa-edge/core'
import type { Clock } from './types'
import { formatRfc3339, goJsonStringify, parseRfc3339Ms } from './wire'

/**
 * Realtime client-secret surface.
 *
 * Ephemeral secrets issued by the client-secrets endpoint look like
 * `ek_<43 chars base64url>` (32 random bytes). On the realtime routes that
 * accept them, an `ek_`-prefixed bearer is validated against the secret
 * registry BEFORE the standard API-key evaluation: an unknown or expired
 * secret aborts with the recorded nested 401, and any other credential falls
 * through to the normal matrix. When no registry is wired up at all, an
 * `ek_`-prefixed token still produces the same 401 - no silent downgrade.
 */

/** Prefix of every realtime client secret. */
export const REALTIME_SECRET_PREFIX = 'ek_'

/** Random bytes per secret. */
export const REALTIME_SECRET_BYTES = 32

/** Default lifetime of an issued secret: 10 minutes. */
export const DEFAULT_SECRET_LIFETIME_MS = 10 * 60_000

/** Lower bound for requested lifetimes: 10 seconds. */
export const MIN_SECRET_LIFETIME_MS = 10_000

/** Upper bound for requested lifetimes: 2 hours. */
export const MAX_SECRET_LIFETIME_MS = 2 * 60 * 60_000

/** Byte-exact 401 body for a syntactically valid but unknown/expired secret. */
export const INVALID_REALTIME_SECRET_BODY =
  '{"error":{"code":"invalid_realtime_client_secret","message":"Realtime client secret is invalid or expired","param":null,"type":"invalid_request_error"}}'

/** One issued secret. */
export interface RealtimeSecret {
  readonly token: string
  readonly expiresAtMs: number
}

/** Storage seam for issued secrets; ephemerality is the caller's choice. */
export interface RealtimeSecretRegistry {
  issue(lifetimeMs?: number): Promise<RealtimeSecret>
  find(token: string): Promise<RealtimeSecret | undefined>
}

export interface RealtimeSecretRegistryOptions {
  readonly now?: Clock
  /** Random secret generator, overridable for tests. */
  readonly randomSecret?: () => string
}

function clampLifetime(lifetimeMs: number | undefined): number {
  const requested = lifetimeMs ?? DEFAULT_SECRET_LIFETIME_MS
  if (requested < MIN_SECRET_LIFETIME_MS) return MIN_SECRET_LIFETIME_MS
  if (requested > MAX_SECRET_LIFETIME_MS) return MAX_SECRET_LIFETIME_MS
  return requested
}

function randomSecretToken(): string {
  const bytes = new Uint8Array(REALTIME_SECRET_BYTES)
  crypto.getRandomValues(bytes)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  const base64 = btoa(binary)
  return `${REALTIME_SECRET_PREFIX}${base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`
}

/** Process-local registry; the parity choice of the reference. */
export class InMemoryRealtimeSecretRegistry implements RealtimeSecretRegistry {
  private readonly secrets = new Map<string, number>()
  private readonly now: Clock
  private readonly randomSecret: () => string

  constructor(options: RealtimeSecretRegistryOptions = {}) {
    this.now = options.now ?? (() => Date.now())
    this.randomSecret = options.randomSecret ?? randomSecretToken
  }

  async issue(lifetimeMs?: number): Promise<RealtimeSecret> {
    const token = this.randomSecret()
    const expiresAtMs = this.now() + clampLifetime(lifetimeMs)
    this.secrets.set(token, expiresAtMs)
    return { token, expiresAtMs }
  }

  async find(token: string): Promise<RealtimeSecret | undefined> {
    const expiresAtMs = this.secrets.get(token)
    if (expiresAtMs === undefined) return undefined
    if (expiresAtMs <= this.now()) {
      this.secrets.delete(token)
      return undefined
    }
    return { token, expiresAtMs }
  }
}

/**
 * Store-backed registry for deployments that share secrets across
 * instances. Documents live in the `realtime-secrets` namespace, keyed by
 * the SHA-256 of the token so the secret itself never becomes a Store key.
 */
export class StoreRealtimeSecretRegistry implements RealtimeSecretRegistry {
  private readonly store: Store
  private readonly now: Clock
  private readonly randomSecret: () => string

  constructor(store: Store, options: RealtimeSecretRegistryOptions = {}) {
    this.store = store
    this.now = options.now ?? (() => Date.now())
    this.randomSecret = options.randomSecret ?? randomSecretToken
  }

  async issue(lifetimeMs?: number): Promise<RealtimeSecret> {
    const secret = { token: this.randomSecret(), expiresAtMs: this.now() + clampLifetime(lifetimeMs) }
    const key = await sha256Hex(secret.token)
    const doc: { readonly [k: string]: JsonValue } = {
      token: secret.token,
      expires_at: formatRfc3339(secret.expiresAtMs),
    }
    await this.store.put('realtime-secrets', key, doc)
    return secret
  }

  async find(token: string): Promise<RealtimeSecret | undefined> {
    const key = await sha256Hex(token)
    const doc = await this.store.get('realtime-secrets', key)
    if (doc === undefined) return undefined
    const record = doc as { [k: string]: JsonValue }
    const expiresAt = record['expires_at']
    if (typeof expiresAt !== 'string') return undefined
    const expiresAtMs = parseRfc3339Ms(expiresAt)
    if (expiresAtMs === undefined) return undefined
    if (expiresAtMs <= this.now()) {
      await this.store.delete('realtime-secrets', key)
      return undefined
    }
    return { token, expiresAtMs }
  }
}

/** Builds the realtime-shaped API-key failure body (alphabetical keys). */
export function realtimeApiKeyErrorBody(message: string): string {
  return goJsonStringify({
    error: {
      code: 'invalid_api_key',
      message,
      param: null,
      type: 'authentication_error',
    },
  })
}

/** Builds the realtime-shaped body for auth-layer 5xx failures. */
export function realtimeServiceErrorBody(message: string): string {
  return goJsonStringify({
    error: {
      code: 'authentication_service_error',
      message,
      param: null,
      type: 'server_error',
    },
  })
}

export interface RealtimeAuthInput {
  readonly apiKeys: readonly string[]
  readonly headers: ClientAuthHeaders
  readonly url: string
  /** Secret registry; absent means no store is initialized. */
  readonly secrets?: RealtimeSecretRegistry
  readonly now?: Clock
}

/**
 * Evaluates a request on a realtime route that accepts ephemeral secrets:
 * `GET|POST /v1/realtime`, calls, translations. An `ek_`-prefixed bearer is
 * resolved against the registry first; anything else falls through to the
 * standard API-key evaluation with the realtime error shapes.
 */
export async function authenticateRealtimeRequest(input: RealtimeAuthInput): Promise<ClientAuthResult> {
  const now = input.now ?? (() => Date.now())
  const authorization = input.headers.authorization
  if (authorization !== undefined && authorization.length > 0) {
    const token = extractBearerToken(authorization)
    if (token.startsWith(REALTIME_SECRET_PREFIX)) {
      const found =
        input.secrets === undefined ? undefined : await input.secrets.find(token)
      if (found === undefined || found.expiresAtMs <= now()) {
        return { ok: false, status: 401, body: INVALID_REALTIME_SECRET_BODY }
      }
      return { ok: true, open: false, apiKey: token, source: 'realtime-client-secret' }
    }
  }
  const standard = authenticateClientRequest({
    apiKeys: input.apiKeys,
    headers: input.headers,
    url: input.url,
  })
  if (standard.ok) return standard
  const body = standard.body === MISSING_API_KEY_BODY
    ? realtimeApiKeyErrorBody('Missing API key')
    : standard.body === INVALID_API_KEY_BODY
      ? realtimeApiKeyErrorBody('Invalid API key')
      : standard.body
  return { ok: false, status: standard.status, body, headers: standard.headers }
}
