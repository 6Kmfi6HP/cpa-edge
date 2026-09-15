import type { JsonValue, Store } from '@cpa-edge/core'
import { ANTIGRAVITY, CLAUDE, CODEX, KIMI, META, XAI } from './providers'
import { metaDcaTokenOf, refreshSecretOf } from './credential-docs'
import { decodeJwtPayload } from './crypto-util'
import type { Clock, FetchLike } from './types'
import { asPlainObject, readNumber, readString } from './types'
import { formatRfc3339, parseRfc3339Ms } from './wire'

/**
 * Token refresh lifecycle (S3 §2.7): per-provider refresh leads, the
 * scheduling rule, refresh-on-401 during request execution, retry and
 * backoff rules, and the refresh-registry bookkeeping persisted through
 * the Store.
 */

/** Refresh-check loop interval (runtime scheduling concern; exported for parity). */
export const REFRESH_CHECK_INTERVAL_MS = 5_000

/** Maximum concurrent refreshes the reference allows. */
export const MAX_CONCURRENT_REFRESHES = 16

/** Backoff while another refresh for the credential is already in flight. */
export const REFRESH_PENDING_BACKOFF_MS = 60_000

/** Backoff after a failed refresh. */
export const REFRESH_FAILURE_BACKOFF_MS = 5 * 60_000

/** Backoff when a refresh "succeeded" but the expiry did not move. */
export const REFRESH_INEFFECTIVE_BACKOFF_MS = 30_000

/** Per-attempt timeout of the Claude and Codex refresh calls. */
export const REFRESH_ATTEMPT_TIMEOUT_MS = 30_000

/** Per-credential refresh leads, in ms; `undefined` = never scheduled. */
export const REFRESH_LEADS_MS: Readonly<Record<string, number | undefined>> = {
  claude: CLAUDE.refreshLeadMs,
  codex: CODEX.refreshLeadMs,
  antigravity: ANTIGRAVITY.refreshLeadMs,
  kimi: KIMI.refreshLeadMs,
  xai: XAI.refreshLeadMs,
  meta: undefined,
  devin: undefined,
}

/** Store namespace + key scheme for the refresh registry. */
export const REFRESH_REGISTRY_NAMESPACE = 'auth-refresh'

/** One credential's refresh bookkeeping document. */
export type RefreshRegistryDocument = {
  readonly last_refreshed_at?: string
  readonly next_refresh_after?: string
  readonly status?: string
  readonly status_message?: string
}

/** Kind tag of a credential as the scheduler sees it. */
export type CredentialKind = 'oauth' | 'api-key'

/** Scheduling view of one credential. */
export interface RefreshSchedulingInput {
  readonly kind: CredentialKind
  readonly provider: string
  /** Access-token expiry (auth file `expired`, RFC3339) in epoch ms. */
  readonly expiresAtMs?: number
  /** Metadata/attribute override `refresh_interval_seconds`-style value, ms. */
  readonly preferredIntervalMs?: number
}

/**
 * Scheduling rule (`shouldRefresh`): API-key credentials are never
 * scheduled; a future `nextRefreshAfter` skips the credential; with a
 * lead, refresh when time-to-expiry is within it, or - when no expiry is
 * known - when the interval since the last refresh exceeds the lead; a
 * preferred interval replaces the lead with the same two comparisons.
 */
export function shouldRefresh(
  input: RefreshSchedulingInput,
  bookkeeping: RefreshRegistryDocument,
  nowMs: number,
): boolean {
  if (input.kind === 'api-key') return false
  const nextAfter =
    bookkeeping.next_refresh_after === undefined
      ? undefined
      : parseRfc3339Ms(bookkeeping.next_refresh_after)
  if (nextAfter !== undefined && nextAfter > nowMs) return false
  const lastRefreshedAt =
    bookkeeping.last_refreshed_at === undefined
      ? undefined
      : parseRfc3339Ms(bookkeeping.last_refreshed_at)
  const windowMs = input.preferredIntervalMs ?? REFRESH_LEADS_MS[input.provider]
  if (windowMs === undefined) return false
  if (input.expiresAtMs !== undefined) {
    return input.expiresAtMs - nowMs <= windowMs
  }
  if (lastRefreshedAt === undefined) return true
  return nowMs - lastRefreshedAt >= windowMs
}

/** Classifies an upstream failure as unauthorized (refresh-on-401 trigger). */
export function isUnauthorizedUpstreamError(error: {
  readonly status?: number
  readonly message?: string
}): boolean {
  if (error.status === 401) return true
  const text = error.message ?? ''
  return text.includes('status 401') || text.includes('401 unauthorized')
}

/**
 * Detects whether a credential can be refreshed after a 401: OAuth
 * credentials need `refresh_token` (or the camelCase `refreshToken`
 * metadata spelling); Meta instead needs the stored `dca_token`.
 */
export function isRefreshCredential(
  provider: string,
  document: Record<string, JsonValue>,
): boolean {
  if (provider === 'meta') return metaDcaTokenOf(document) !== undefined
  return refreshSecretOf(document) !== undefined
}

/** Outcome of one refresh attempt. */
export type RefreshOutcome =
  | {
      readonly ok: true
      /** Replacement fields for the credential document. */
      readonly documentPatch: Record<string, JsonValue>
      /** True when the new expiry differs from the previous one. */
      readonly effective: boolean
    }
  | {
      readonly ok: false
      readonly retryable: boolean
      readonly message: string
      /** Blocking deadline for 429-driven cooldowns (epoch ms). */
      readonly blockedUntilMs?: number
      /** Failure carried HTTP 401: credential becomes unavailable. */
      readonly unauthorized: boolean
    }

export interface RefreshDeps {
  readonly fetch?: FetchLike
  readonly now?: Clock
  /** Injected sleeper for retry waits; defaults to real time. */
  readonly sleep?: (ms: number) => Promise<void>
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

function clampRetryAfterMs(valueMs: number): number {
  const min = 5_000
  const max = 5 * 60_000
  if (valueMs < min) return min
  if (valueMs > max) return max
  return valueMs
}

/** Parses `Retry-After` (seconds or HTTP-date) or `Retry-After-Ms`. */
export function parseRetryAfterMs(
  headers: Headers,
  nowMs: number,
): number | undefined {
  const retryAfterMs = headers.get('Retry-After-Ms')
  if (retryAfterMs !== null) {
    const parsed = Number(retryAfterMs)
    if (Number.isFinite(parsed) && parsed >= 0) return clampRetryAfterMs(parsed)
  }
  const retryAfter = headers.get('Retry-After')
  if (retryAfter === null) return undefined
  const asSeconds = Number(retryAfter)
  if (Number.isFinite(asSeconds) && asSeconds >= 0) return clampRetryAfterMs(asSeconds * 1000)
  const asDate = Date.parse(retryAfter)
  if (!Number.isNaN(asDate)) return clampRetryAfterMs(asDate - nowMs)
  return undefined
}

/**
 * Claude refresh with the recorded retry policy: attempt 1 immediately,
 * then `attempt` seconds of sleep between attempts; 5xx responses are
 * retryable, other 4xx are not, and a 429 blocks the refresh token until
 * the clamped `Retry-After` deadline (subsequent refreshes fail fast,
 * non-retryable). An empty `refresh_token` in the response keeps the
 * previous one. Per-attempt timeout: 30 s.
 */
export async function refreshClaudeToken(
  document: Record<string, JsonValue>,
  deps: RefreshDeps & { maxRetries?: number },
): Promise<RefreshOutcome> {
  const fetchLike = deps.fetch ?? defaultFetch()
  const now = deps.now ?? (() => Date.now())
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const maxRetries = deps.maxRetries ?? 3
  const refreshToken = refreshSecretOf(document)
  if (refreshToken === undefined) {
    return { ok: false, retryable: false, message: 'missing refresh token', unauthorized: false }
  }
  const body = {
    client_id: CLAUDE.clientId,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: CLAUDE.scope,
  }
  let attempt = 1
  for (;;) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REFRESH_ATTEMPT_TIMEOUT_MS)
    try {
      const response = await fetchLike(CLAUDE.tokenEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (response.status === 429) {
        const retryAfterMs = parseRetryAfterMs(response.headers, now())
        const blockedUntilMs = retryAfterMs === undefined ? undefined : now() + retryAfterMs
        return {
          ok: false,
          retryable: false,
          message: 'refresh rate limited',
          blockedUntilMs,
          unauthorized: false,
        }
      }
      if (response.status >= 500) {
        if (attempt >= maxRetries) {
          return { ok: false, retryable: true, message: 'upstream unavailable', unauthorized: false }
        }
        await sleep(attempt * 1000)
        attempt += 1
        continue
      }
      if (!response.ok) {
        return {
          ok: false,
          retryable: false,
          message: `refresh rejected (${response.status})`,
          unauthorized: response.status === 401,
        }
      }
      const token = await readJson(response)
      if (token === undefined) {
        return { ok: false, retryable: false, message: 'unparsable refresh response', unauthorized: false }
      }
      const accessToken = readString(token, 'access_token')
      const nextRefreshToken = readString(token, 'refresh_token')
      const expiresIn = readNumber(token, 'expires_in')
      if (accessToken === undefined || expiresIn === undefined) {
        return { ok: false, retryable: false, message: 'incomplete refresh response', unauthorized: false }
      }
      const nowMs = now()
      const patch: Record<string, JsonValue> = {
        access_token: accessToken,
        refresh_token: nextRefreshToken === undefined || nextRefreshToken.length === 0
          ? refreshToken
          : nextRefreshToken,
        last_refresh: formatRfc3339(nowMs),
        expired: formatRfc3339(nowMs + expiresIn * 1000),
      }
      const previousExpiry =
        typeof document['expired'] === 'string' ? document['expired'] : undefined
      const expiredValue = patch['expired']
      return {
        ok: true,
        documentPatch: patch,
        effective: typeof expiredValue === 'string' && expiredValue !== previousExpiry,
      }
    } catch {
      if (attempt >= maxRetries) {
        return { ok: false, retryable: true, message: 'refresh transport failure', unauthorized: false }
      }
      await sleep(attempt * 1000)
      attempt += 1
    } finally {
      clearTimeout(timer)
    }
  }
}

/** Codex refresh; `refresh_token_reused` in the error body is terminal. */
export async function refreshCodexToken(
  document: Record<string, JsonValue>,
  deps: RefreshDeps,
): Promise<RefreshOutcome> {
  const fetchLike = deps.fetch ?? defaultFetch()
  const now = deps.now ?? (() => Date.now())
  const refreshToken = refreshSecretOf(document)
  if (refreshToken === undefined) {
    return { ok: false, retryable: false, message: 'missing refresh token', unauthorized: false }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REFRESH_ATTEMPT_TIMEOUT_MS)
  try {
    const form = new URLSearchParams({
      client_id: CODEX.clientId,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: CODEX.refreshScope,
    })
    const response = await fetchLike(CODEX.tokenEndpoint, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
      signal: controller.signal,
    })
    if (!response.ok) {
      const text = await response.text()
      const reused = text.includes('refresh_token_reused')
      return {
        ok: false,
        retryable: !reused,
        message: reused ? 'refresh token reused' : `refresh rejected (${response.status})`,
        unauthorized: response.status === 401,
      }
    }
    const token = await readJson(response)
    if (token === undefined) {
      return { ok: false, retryable: false, message: 'unparsable refresh response', unauthorized: false }
    }
    const accessToken = readString(token, 'access_token')
    const nextRefreshToken = readString(token, 'refresh_token')
    const idToken = readString(token, 'id_token')
    const expiresIn = readNumber(token, 'expires_in')
    if (accessToken === undefined || nextRefreshToken === undefined || expiresIn === undefined) {
      return { ok: false, retryable: false, message: 'incomplete refresh response', unauthorized: false }
    }
    const nowMs = now()
    const claims = idToken === undefined ? undefined : decodeJwtPayload(idToken)
    const patch: Record<string, JsonValue> = {
      access_token: accessToken,
      refresh_token: nextRefreshToken,
      id_token: idToken ?? '',
      last_refresh: formatRfc3339(nowMs),
      expired: formatRfc3339(nowMs + expiresIn * 1000),
    }
    if (claims !== undefined) {
      const email = readString(claims, 'email')
      if (email !== undefined) patch['email'] = email
    }
    return { ok: true, documentPatch: patch, effective: true }
  } finally {
    clearTimeout(timer)
  }
}

/** Kimi refresh: form POST with the fixed client id. */
export async function refreshKimiToken(
  document: Record<string, JsonValue>,
  deps: RefreshDeps,
): Promise<RefreshOutcome> {
  const fetchLike = deps.fetch ?? defaultFetch()
  const now = deps.now ?? (() => Date.now())
  const refreshToken = refreshSecretOf(document)
  if (refreshToken === undefined) {
    return { ok: false, retryable: false, message: 'missing refresh token', unauthorized: false }
  }
  const form = new URLSearchParams({
    client_id: KIMI.clientId,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  })
  const response = await fetchLike(KIMI.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  })
  return simpleFormRefreshOutcome(response, now)
}

/** xAI refresh: form POST against the discovery-derived token endpoint. */
export async function refreshXaiToken(
  document: Record<string, JsonValue>,
  deps: RefreshDeps,
): Promise<RefreshOutcome> {
  const fetchLike = deps.fetch ?? defaultFetch()
  const now = deps.now ?? (() => Date.now())
  const refreshToken = refreshSecretOf(document)
  if (refreshToken === undefined) {
    return { ok: false, retryable: false, message: 'missing refresh token', unauthorized: false }
  }
  const tokenEndpoint =
    typeof document['token_endpoint'] === 'string' && document['token_endpoint'].length > 0
      ? document['token_endpoint']
      : 'https://auth.x.ai/oauth/token'
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: XAI.clientId,
    refresh_token: refreshToken,
  })
  const response = await fetchLike(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  })
  return simpleFormRefreshOutcome(response, now)
}

async function simpleFormRefreshOutcome(
  response: Response,
  now: () => number,
): Promise<RefreshOutcome> {
  if (!response.ok) {
    return {
      ok: false,
      retryable: response.status >= 500,
      message: `refresh rejected (${response.status})`,
      unauthorized: response.status === 401,
    }
  }
  const token = await readJson(response)
  if (token === undefined) {
    return { ok: false, retryable: false, message: 'unparsable refresh response', unauthorized: false }
  }
  const accessToken = readString(token, 'access_token')
  const nextRefreshToken = readString(token, 'refresh_token')
  const expiresIn = readNumber(token, 'expires_in')
  if (accessToken === undefined || nextRefreshToken === undefined || expiresIn === undefined) {
    return { ok: false, retryable: false, message: 'incomplete refresh response', unauthorized: false }
  }
  const nowMs = now()
  return {
    ok: true,
    documentPatch: {
      access_token: accessToken,
      refresh_token: nextRefreshToken,
      expires_in: expiresIn,
      expired: formatRfc3339(nowMs + expiresIn * 1000),
      last_refresh: formatRfc3339(nowMs),
    },
    effective: true,
  }
}

/**
 * Meta has no refresh-token grant: a 401 triggers a re-mint of the API
 * key from the stored `dca_token`. Mint failure is non-fatal for the
 * stored credential but fails the refresh.
 */
export async function refreshMetaToken(
  document: Record<string, JsonValue>,
  deps: RefreshDeps,
): Promise<RefreshOutcome> {
  const fetchLike = deps.fetch ?? defaultFetch()
  const now = deps.now ?? (() => Date.now())
  const dcaToken = metaDcaTokenOf(document)
  if (dcaToken === undefined) {
    return { ok: false, retryable: false, message: 'missing dca token', unauthorized: false }
  }
  const response = await fetchLike(META.keyMintEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${dcaToken}`,
      'User-Agent': META.userAgent,
    },
    body: JSON.stringify({ dca_token: dcaToken }),
  })
  if (!response.ok) {
    return {
      ok: false,
      retryable: response.status >= 500,
      message: `key mint rejected (${response.status})`,
      unauthorized: response.status === 401,
    }
  }
  const minted = await readJson(response)
  const apiKey = minted === undefined ? undefined : readString(minted, 'api_key')
  if (apiKey === undefined) {
    return { ok: false, retryable: false, message: 'incomplete mint response', unauthorized: false }
  }
  const nowMs = now()
  return {
    ok: true,
    documentPatch: {
      access_token: apiKey,
      api_key: apiKey,
      last_refresh: formatRfc3339(nowMs),
    },
    effective: apiKey !== document['access_token'],
  }
}

/** Dispatches a refresh to the provider implementation. */
export async function refreshCredential(
  provider: string,
  document: Record<string, JsonValue>,
  deps: RefreshDeps = {},
): Promise<RefreshOutcome> {
  switch (provider) {
    case 'claude':
      return refreshClaudeToken(document, deps)
    case 'codex':
      return refreshCodexToken(document, deps)
    case 'kimi':
      return refreshKimiToken(document, deps)
    case 'xai':
      return refreshXaiToken(document, deps)
    case 'meta':
      return refreshMetaToken(document, deps)
    case 'antigravity':
      return refreshAntigravityToken(document, deps)
    default:
      return { ok: false, retryable: false, message: 'unsupported provider', unauthorized: false }
  }
}

/** Antigravity refresh: form POST with the public client secret. */
export async function refreshAntigravityToken(
  document: Record<string, JsonValue>,
  deps: RefreshDeps,
): Promise<RefreshOutcome> {
  const fetchLike = deps.fetch ?? defaultFetch()
  const now = deps.now ?? (() => Date.now())
  const refreshToken = refreshSecretOf(document)
  if (refreshToken === undefined) {
    return { ok: false, retryable: false, message: 'missing refresh token', unauthorized: false }
  }
  const form = new URLSearchParams({
    client_id: ANTIGRAVITY.clientId,
    client_secret: ANTIGRAVITY.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  })
  const response = await fetchLike(ANTIGRAVITY.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  })
  if (!response.ok) {
    return {
      ok: false,
      retryable: response.status >= 500,
      message: `refresh rejected (${response.status})`,
      unauthorized: response.status === 401,
    }
  }
  const token = await readJson(response)
  if (token === undefined) {
    return { ok: false, retryable: false, message: 'unparsable refresh response', unauthorized: false }
  }
  const accessToken = readString(token, 'access_token')
  const nextRefreshToken = readString(token, 'refresh_token')
  const expiresIn = readNumber(token, 'expires_in')
  if (accessToken === undefined || nextRefreshToken === undefined || expiresIn === undefined) {
    return { ok: false, retryable: false, message: 'incomplete refresh response', unauthorized: false }
  }
  const nowMs = now()
  return {
    ok: true,
    documentPatch: {
      access_token: accessToken,
      refresh_token: nextRefreshToken,
      expires_in: expiresIn,
      expired: formatRfc3339(nowMs + expiresIn * 1000),
      timestamp: nowMs,
    },
    effective: true,
  }
}

/**
 * Refresh registry: per-credential bookkeeping persisted through the
 * Store (namespace `auth-refresh`, key = auth-file name). Tracks the last
 * refresh, the next-eligible time (backoff), and the failure state that
 * excludes a credential from scheduling and selection.
 */
export class RefreshRegistry {
  private readonly store: Store
  private readonly now: Clock

  constructor(store: Store, options: { now?: Clock } = {}) {
    this.store = store
    this.now = options.now ?? (() => Date.now())
  }

  async get(fileName: string): Promise<RefreshRegistryDocument> {
    const raw = await this.store.get(REFRESH_REGISTRY_NAMESPACE, fileName)
    if (raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) return {}
    return raw as RefreshRegistryDocument
  }

  /** Records a successful refresh and clears any failure state. */
  async recordSuccess(fileName: string, effective: boolean): Promise<void> {
    const nowMs = this.now()
    await this.store.update<RefreshRegistryDocument>(
      REFRESH_REGISTRY_NAMESPACE,
      fileName,
      (current) => ({
        ...(current ?? {}),
        last_refreshed_at: formatRfc3339(nowMs),
        status: 'active',
        ...(effective ? {} : { next_refresh_after: formatRfc3339(nowMs + REFRESH_INEFFECTIVE_BACKOFF_MS) }),
      }),
    )
  }

  /** Records a failed refresh with the failure backoff. */
  async recordFailure(fileName: string, message: string): Promise<void> {
    const nowMs = this.now()
    await this.store.update<RefreshRegistryDocument>(
      REFRESH_REGISTRY_NAMESPACE,
      fileName,
      (current) => ({
        ...(current ?? {}),
        next_refresh_after: formatRfc3339(nowMs + REFRESH_FAILURE_BACKOFF_MS),
        status: 'error',
        status_message: message,
      }),
    )
  }

  /** Marks the credential unavailable after a 401 refresh failure. */
  async recordUnauthorized(fileName: string, message: string): Promise<void> {
    await this.store.update<RefreshRegistryDocument>(
      REFRESH_REGISTRY_NAMESPACE,
      fileName,
      (current) => ({
        ...(current ?? {}),
        status: 'error',
        status_message: message,
      }),
    )
  }
}

/**
 * Refresh-on-401 coordinator. At most one synchronous refresh per request;
 * a single-flight promise per credential makes concurrent requests share
 * the in-flight refresh, and a caller whose failing access token already
 * differs from the current one reuses the newer token without refreshing.
 */
export class UnauthorizedRefresher {
  private readonly store: Store
  private readonly registry: RefreshRegistry
  private readonly now: Clock
  private readonly inFlight = new Map<string, Promise<void>>()

  constructor(store: Store, options: { registry?: RefreshRegistry; now?: Clock } = {}) {
    this.store = store
    this.registry = options.registry ?? new RefreshRegistry(store, options)
    this.now = options.now ?? (() => Date.now())
  }

  /**
   * Attempts one refresh for the credential after an upstream 401.
   * `failedAccessToken` is the token the failed request used; when the
   * stored token has already moved on, the newer one is reused and no
   * refresh runs. Returns the refreshed document, or the failure.
   */
  async refreshAfterUnauthorized(input: {
    readonly fileName: string
    readonly provider: string
    readonly document: Record<string, JsonValue>
    readonly failedAccessToken: string
    readonly deps?: RefreshDeps
  }): Promise<
    | { readonly refreshed: true; readonly document: Record<string, JsonValue> }
    | { readonly refreshed: false; readonly outcome: RefreshOutcome | undefined }
  > {
    const currentAccessToken = input.document['access_token']
    if (
      typeof currentAccessToken === 'string' &&
      currentAccessToken !== input.failedAccessToken
    ) {
      return { refreshed: true, document: input.document }
    }
    if (!isRefreshCredential(input.provider, input.document)) {
      return { refreshed: false, outcome: undefined }
    }
    const flight = this.inFlight.get(input.fileName)
    if (flight !== undefined) {
      await flight
      const updated = await this.loadDocument(input.fileName)
      return updated === undefined
        ? { refreshed: false, outcome: undefined }
        : { refreshed: true, document: updated }
    }
    let promise: Promise<void>
    const run = async (): Promise<void> => {
      const outcome = await refreshCredential(input.provider, input.document, input.deps ?? {})
      if (outcome.ok) {
        const next: Record<string, JsonValue> = { ...input.document, ...outcome.documentPatch }
        await this.store.put('auth', input.fileName, next)
        await this.registry.recordSuccess(input.fileName, outcome.effective)
        return
      }
      if (outcome.unauthorized) {
        await this.registry.recordUnauthorized(input.fileName, 'unauthorized')
        return
      }
      await this.registry.recordFailure(input.fileName, outcome.message)
    }
    promise = run().finally(() => {
      this.inFlight.delete(input.fileName)
    })
    this.inFlight.set(input.fileName, promise)
    await promise
    const updated = await this.loadDocument(input.fileName)
    return updated === undefined
      ? { refreshed: false, outcome: undefined }
      : { refreshed: true, document: updated }
  }

  private async loadDocument(fileName: string): Promise<Record<string, JsonValue> | undefined> {
    const raw = await this.store.get('auth', fileName)
    if (raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) return undefined
    return raw as Record<string, JsonValue>
  }
}
