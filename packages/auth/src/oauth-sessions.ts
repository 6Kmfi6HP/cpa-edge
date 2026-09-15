import { isJsonValue, type JsonValue, type Store } from '@cpa-edge/core'
import type { Clock } from './types'
import { formatRfc3339, parseRfc3339Ms } from './wire'

/**
 * Store-backed registry of OAuth login sessions (S6 mapping: namespace
 * `oauth-sessions`, key = state token). Replaces the reference's
 * process-local map so multi-instance runtimes share login state. Flow
 * semantics are S3's: pending sessions live 30 minutes, completed ones 1
 * minute, expired entries are purged on access, and a state error extends
 * the failing session's TTL by a fresh 30 minutes without ever touching
 * completed sessions.
 */

export const OAUTH_SESSIONS_NAMESPACE = 'oauth-sessions'

/** Pending TTL: 30 minutes (covers the slowest device flows). */
export const OAUTH_SESSION_PENDING_TTL_MS = 30 * 60_000

/** Completed TTL: 1 minute. */
export const OAUTH_SESSION_COMPLETED_TTL_MS = 60_000

/** Hard cap on state token length, validated before any registry access. */
export const OAUTH_STATE_MAX_LENGTH = 128

/** Default message when a session is marked failed without one. */
export const OAUTH_SESSION_DEFAULT_ERROR = 'Authentication failed'

/**
 * Session document exactly as S6 pins it. The `status` field carries
 * `'pending'` while a login is in flight and the session error message
 * once `SetError` marked it; `completed` mirrors the completion flag.
 */
export type OAuthSessionDocument = {
  readonly provider: string
  readonly status: string
  readonly source: 'builtin' | 'plugin'
  readonly metadata?: JsonValue
  readonly completed: boolean
  readonly created_at: string
  readonly expires_at: string
}

const STATE_PATTERN = /^[A-Za-z0-9._-]{1,128}$/

/**
 * Validates a state token: 1-128 chars of `[A-Za-z0-9._-]`, no `..`, no
 * path separators. The dot allowance is explicit; the `..` and separator
 * exclusions are the extra rules the reference applies on top.
 */
export function isValidOauthState(state: string): boolean {
  if (state.length === 0 || state.length > OAUTH_STATE_MAX_LENGTH) return false
  if (!STATE_PATTERN.test(state)) return false
  if (state.includes('..')) return false
  return true
}

function asSession(value: JsonValue | undefined): OAuthSessionDocument | undefined {
  if (value === undefined || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as { [key: string]: JsonValue }
  const provider = record['provider']
  const status = record['status']
  const source = record['source']
  const completed = record['completed']
  const createdAt = record['created_at']
  const expiresAt = record['expires_at']
  if (typeof provider !== 'string') return undefined
  if (typeof status !== 'string') return undefined
  if (source !== 'builtin' && source !== 'plugin') return undefined
  if (typeof completed !== 'boolean') return undefined
  if (typeof createdAt !== 'string' || typeof expiresAt !== 'string') return undefined
  const metadata = record['metadata']
  if (metadata !== undefined && !isJsonValue(metadata)) return undefined
  return {
    provider,
    status,
    source,
    metadata,
    completed,
    created_at: createdAt,
    expires_at: expiresAt,
  }
}

/**
 * Session document that is already expired on arrival. `update` callbacks
 * must return a JSON value even when the document they wanted to change
 * vanished mid-flight (the cancel race); writing one of these keeps the
 * vanished session invisible instead of resurrecting it.
 */
function invisibleTombstone(): OAuthSessionDocument {
  const nowMs = 0
  return {
    provider: '',
    status: 'pending',
    source: 'builtin',
    completed: true,
    created_at: formatRfc3339(nowMs),
    expires_at: formatRfc3339(nowMs),
  }
}

export type RegisterResult = { readonly ok: true } | { readonly ok: false; readonly error: 'invalid state' }

export interface RegisterOptions {
  readonly source?: 'builtin' | 'plugin'
  readonly metadata?: JsonValue
}

/** Store-backed OAuth session registry. */
export class OAuthSessionRegistry {
  private readonly store: Store
  private readonly now: Clock

  constructor(store: Store, options: { now?: Clock } = {}) {
    this.store = store
    this.now = options.now ?? (() => Date.now())
  }

  /**
   * Registers a pending session keyed by the state token with a fresh
   * 30-minute TTL. Invalid state tokens are rejected before any write.
   */
  async register(state: string, provider: string, options: RegisterOptions = {}): Promise<RegisterResult> {
    if (!isValidOauthState(state)) return { ok: false, error: 'invalid state' }
    const nowMs = this.now()
    const doc: OAuthSessionDocument = options.metadata === undefined
      ? {
          provider,
          status: 'pending',
          source: options.source ?? 'builtin',
          completed: false,
          created_at: formatRfc3339(nowMs),
          expires_at: formatRfc3339(nowMs + OAUTH_SESSION_PENDING_TTL_MS),
        }
      : {
          provider,
          status: 'pending',
          source: options.source ?? 'builtin',
          metadata: options.metadata,
          completed: false,
          created_at: formatRfc3339(nowMs),
          expires_at: formatRfc3339(nowMs + OAUTH_SESSION_PENDING_TTL_MS),
        }
    await this.store.put(OAUTH_SESSIONS_NAMESPACE, state, doc)
    return { ok: true }
  }

  /**
   * Reads one session, purging it first when its TTL has elapsed. Expired
   * and absent sessions read the same way: `undefined`.
   */
  async get(state: string): Promise<OAuthSessionDocument | undefined> {
    if (!isValidOauthState(state)) return undefined
    const raw = await this.store.get(OAUTH_SESSIONS_NAMESPACE, state)
    const session = asSession(raw)
    if (session === undefined) return undefined
    const expiresAt = parseRfc3339Ms(session.expires_at)
    if (expiresAt !== undefined && expiresAt <= this.now()) {
      await this.store.delete(OAUTH_SESSIONS_NAMESPACE, state)
      return undefined
    }
    return session
  }

  /**
   * Marks a session failed: sets the error status and extends the TTL by a
   * fresh 30 minutes. Completed sessions are never touched; an unknown
   * state is a no-op. An empty message defaults to "Authentication failed".
   */
  async setStatusError(state: string, message?: string): Promise<boolean> {
    if (!isValidOauthState(state)) return false
    let updated = false
    await this.store.update<OAuthSessionDocument>(OAUTH_SESSIONS_NAMESPACE, state, (current) => {
      updated = false
      if (current === undefined) return invisibleTombstone()
      if (current.completed) return current
      updated = true
      const next: OAuthSessionDocument = {
        provider: current.provider,
        status: message === undefined || message.length === 0 ? OAUTH_SESSION_DEFAULT_ERROR : message,
        source: current.source,
        metadata: current.metadata,
        completed: false,
        created_at: current.created_at,
        expires_at: formatRfc3339(this.now() + OAUTH_SESSION_PENDING_TTL_MS),
      }
      return next
    })
    return updated
  }

  /**
   * Completes a session: flips the completion flag and shortens the TTL to
   * 1 minute. Returns false when no live session existed.
   */
  async complete(state: string): Promise<boolean> {
    if (!isValidOauthState(state)) return false
    let updated = false
    await this.store.update<OAuthSessionDocument>(OAUTH_SESSIONS_NAMESPACE, state, (current) => {
      updated = false
      if (current === undefined) return invisibleTombstone()
      updated = true
      const next: OAuthSessionDocument = {
        provider: current.provider,
        status: current.status,
        source: current.source,
        metadata: current.metadata,
        completed: true,
        created_at: current.created_at,
        expires_at: formatRfc3339(this.now() + OAUTH_SESSION_COMPLETED_TTL_MS),
      }
      return next
    })
    return updated
  }

  /**
   * Bulk-completes every still-pending session of one provider - used when
   * a device flow finishes out-of-band. Returns the number of sessions
   * closed.
   */
  async completeAllPendingOfProvider(provider: string): Promise<number> {
    const keys = await this.store.list(OAUTH_SESSIONS_NAMESPACE)
    let closed = 0
    for (const key of keys) {
      const session = await this.get(key)
      if (session === undefined) continue
      if (session.provider !== provider) continue
      if (session.completed || session.status !== 'pending') continue
      if (await this.complete(key)) closed += 1
    }
    return closed
  }

  /**
   * Cancels a session: removes it, but only while it is still pending.
   * Completed and errored sessions (and unknown states) return false.
   */
  async cancel(state: string): Promise<boolean> {
    if (!isValidOauthState(state)) return false
    const session = await this.get(state)
    if (session === undefined) return false
    if (session.completed || session.status !== 'pending') return false
    return await this.store.delete(OAUTH_SESSIONS_NAMESPACE, state)
  }
}
