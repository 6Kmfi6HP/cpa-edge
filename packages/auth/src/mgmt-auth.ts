import type { JsonValue, Store } from '@cpa-edge/core'
import bcrypt from 'bcryptjs'
import { constantTimeEqual } from './crypto-util'
import { extractBearerToken } from './api-keys'
import type { Clock } from './types'
import { formatRfc3339, goDurationString, goJsonStringify, parseRfc3339Ms } from './wire'

/**
 * Management-plane authorization for `/v0/management/*`.
 *
 * Per-request pipeline, in recorded order: resolve the client IP with
 * trust-all XFF semantics, check the per-IP ban (before any key
 * validation), apply the remote gate, then validate the presented key
 * against the local password (loopback only), the env secret
 * (constant-time) and the config secret (bcrypt). Counted failures are
 * "missing management key" and "invalid management key" only; banned and
 * remote-disabled responses never count, and the failing request that
 * triggers a ban is itself answered 401. Failure counters and ban
 * deadlines live in the Store document `mgmt/attempts`.
 */

/** Consecutive counted failures that trigger a 30-minute ban. */
export const MANAGEMENT_BAN_THRESHOLD = 5

/** Ban duration, 30 minutes. */
export const MANAGEMENT_BAN_DURATION_MS = 30 * 60_000

/** Suggested sweep cadence for idle attempt entries (hourly upstream). */
export const MANAGEMENT_SWEEP_INTERVAL_MS = 60 * 60_000

/** Idle time after which a swept entry is purged unless still banned. */
export const MANAGEMENT_SWEEP_MAX_IDLE_MS = 2 * 60 * 60_000

/** Store namespace + key for the per-IP failure counters (S6 mapping). */
export const MGMT_ATTEMPTS_NAMESPACE = 'mgmt'
export const MGMT_ATTEMPTS_KEY = 'attempts'

export const MISSING_MANAGEMENT_KEY_BODY = '{"error":"missing management key"}'
export const INVALID_MANAGEMENT_KEY_BODY = '{"error":"invalid management key"}'
export const REMOTE_MANAGEMENT_DISABLED_BODY = '{"error":"remote management disabled"}'
export const REMOTE_MANAGEMENT_KEY_NOT_SET_BODY = '{"error":"remote management key not set"}'

/** Headers the management middleware always sets; runtimes own the values. */
export const MANAGEMENT_BUILD_HEADER_NAMES: readonly string[] = [
  'X-Cpa-Version',
  'X-Cpa-Commit',
  'X-Cpa-Build-Date',
  'X-Cpa-Support-Plugin',
]

/**
 * Per-IP attempt record kept in the `mgmt/attempts` document. `last_seen`
 * is the S6-registered activity timestamp (RFC3339, stamped on every
 * counted failure); it is optional here only so untrusted reads stay
 * narrow - every entry this module writes carries it.
 */
export type ManagementAttemptEntry = {
  readonly failures: number
  readonly banned_until?: string
  readonly last_seen?: string
}

/** The whole attempts document: client IP to attempt record. */
export type ManagementAttemptsDocument = {
  readonly [ip: string]: ManagementAttemptEntry
}

/** Recognizes bcrypt hashes by their `$2a$`/`$2b$`/`$2y$` prefix. */
export function looksLikeBcrypt(value: string): boolean {
  return value.startsWith('$2a$') || value.startsWith('$2b$') || value.startsWith('$2y$')
}

export interface PreparedManagementSecret {
  /** Value to keep as the stored secret (hash, or the original if unchanged). */
  readonly stored: string
  /** True when the input was plaintext and is now hashed. */
  readonly mutated: boolean
}

/**
 * Startup mutation of `remote-management.secret-key`: a non-empty plaintext
 * is hashed once (bcrypt, cost 10); values that already look like bcrypt are
 * left byte-identical. The plaintext remains the accepted presented key.
 * Idempotent: feeding the returned `stored` back in changes nothing.
 */
export async function prepareManagementSecret(secret: string): Promise<PreparedManagementSecret> {
  if (secret.length === 0) return { stored: '', mutated: false }
  if (looksLikeBcrypt(secret)) return { stored: secret, mutated: false }
  const hashed = await bcrypt.hash(secret, 10)
  return { stored: hashed, mutated: true }
}

/** Synchronous flavor of {@link prepareManagementSecret} for sync factories. */
export function prepareManagementSecretSync(secret: string): PreparedManagementSecret {
  if (secret.length === 0) return { stored: '', mutated: false }
  if (looksLikeBcrypt(secret)) return { stored: secret, mutated: false }
  return { stored: bcrypt.hashSync(secret, 10), mutated: true }
}

/**
 * Compares a presented key against the stored secret: bcrypt compare when
 * the stored value is a hash, constant-time equality otherwise (defensive
 * for not-yet-mutated values). Plaintext keys keep working either way.
 */
export async function verifyManagementSecret(presented: string, stored: string): Promise<boolean> {
  if (stored.length === 0 || presented.length === 0) return false
  if (looksLikeBcrypt(stored)) return bcrypt.compare(presented, stored)
  return constantTimeEqual(presented, stored)
}

function isIpv4(text: string): boolean {
  const parts = text.split('.')
  if (parts.length !== 4) return false
  for (const part of parts) {
    if (part.length === 0 || part.length > 3) return false
    if (!/^\d+$/.test(part)) return false
    // Go's net.ParseIP treats dotted quads with leading zeros (for
    // example `01.1.1.1`) as unparseable; a lone `0` octet stays valid.
    if (part.length > 1 && part.startsWith('0')) return false
    if (Number(part) > 255) return false
  }
  return true
}

function isIpv6(text: string): boolean {
  if (!text.includes(':')) return false
  const doubled = text.split('::')
  if (doubled.length > 2) return false
  const groups: string[] = []
  for (const segment of doubled) {
    if (segment.length === 0) continue
    for (const piece of segment.split(':')) {
      if (piece.length === 0) return false
      const tail = piece.split('.')
      if (tail.length === 4) {
        if (!isIpv4(piece)) return false
        groups.push('v4')
        continue
      }
      if (tail.length > 1) return false
      if (piece.length > 4 || !/^[0-9a-fA-F]+$/.test(piece)) return false
      groups.push(piece)
    }
  }
  if (doubled.length === 2) return groups.length < 8
  return groups.length === 8
}

/** True when the text parses as an IPv4 or IPv6 address. */
export function isParseableIp(text: string): boolean {
  return isIpv4(text) || isIpv6(text)
}

export interface ClientAddressInput {
  readonly 'x-forwarded-for'?: string
  readonly 'x-real-ip'?: string
  /** TCP remote address in `host:port` or `[v6]:port` form. */
  readonly remoteAddr: string
}

function hostOfRemoteAddr(remoteAddr: string): string {
  const trimmed = remoteAddr.trim()
  if (trimmed.startsWith('[')) {
    const close = trimmed.indexOf(']')
    if (close > 0) return trimmed.slice(1, close)
    return trimmed
  }
  const colon = trimmed.lastIndexOf(':')
  if (colon > 0) return trimmed.slice(0, colon)
  return trimmed
}

/**
 * Resolves the client IP the way the reference does under gin's trust-all
 * default: the `X-Forwarded-For` list is walked right to left and yields
 * the leftmost parseable entry; an unparseable entry anywhere aborts the
 * walk and resolution falls to `X-Real-IP`, then the TCP remote address.
 * The result is spoofable by design - recorded reality, not endorsement.
 */
export function resolveClientIp(input: ClientAddressInput): string {
  const forwarded = input['x-forwarded-for']
  if (forwarded !== undefined && forwarded.trim().length > 0) {
    const entries = forwarded
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
    let resolved: string | undefined
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i] as string
      if (!isParseableIp(entry)) {
        resolved = undefined
        break
      }
      if (i === 0) resolved = entry
    }
    if (resolved !== undefined) return resolved
  }
  const realIp = input['x-real-ip']
  if (realIp !== undefined && realIp.trim().length > 0 && isParseableIp(realIp.trim())) {
    return realIp.trim()
  }
  return hostOfRemoteAddr(input.remoteAddr)
}

/** Loopback check of the resolved IP. */
export function isLocalIp(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1'
}

/** Live management auth configuration, supplied by the runtime. */
export interface ManagementAuthConfig {
  /** Stored config secret, already bcrypt-mutated at load (R-BCRYPT). */
  readonly configSecret?: string
  /** `MANAGEMENT_PASSWORD` env value, if set. */
  readonly envSecret?: string
  /** TUI-era local password, accepted for loopback clients only. */
  readonly localSecret?: string
  /** `remote-management.allow-remote` config value. */
  readonly allowRemote: boolean
}

/** Headers the pipeline reads, lowercased names. */
export interface ManagementRequestHeaders extends ClientAddressInput {
  readonly authorization?: string
  readonly 'x-management-key'?: string
}

export interface ManagementRequestContext {
  readonly headers: ManagementRequestHeaders
}

export type ManagementAuthResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: 401 | 403; readonly body: string }

type AttemptsRecord = { [ip: string]: ManagementAttemptEntry }

function asAttemptsRecord(value: JsonValue | undefined): AttemptsRecord {
  if (value === undefined || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as AttemptsRecord
}

function bannedBody(remainingMs: number): string {
  return goJsonStringify({
    error: `IP banned due to too many failed attempts. Try again in ${goDurationString(remainingMs)}`,
  })
}

/** Service performing the full management authz pipeline against the Store. */
export class ManagementAuthService {
  private readonly store: Store
  private readonly getConfig: () => ManagementAuthConfig
  private readonly now: Clock

  constructor(
    store: Store,
    options: { getConfig: () => ManagementAuthConfig; now?: Clock },
  ) {
    this.store = store
    this.getConfig = options.getConfig
    this.now = options.now ?? (() => Date.now())
  }

  /** True when management routes must be registered (any secret configured). */
  isManagementEnabled(): boolean {
    const config = this.getConfig()
    return (
      (config.configSecret ?? '').length > 0 ||
      (config.envSecret ?? '').length > 0 ||
      (config.localSecret ?? '').length > 0
    )
  }

  async authenticate(context: ManagementRequestContext): Promise<ManagementAuthResult> {
    const config = this.getConfig()
    const nowMs = this.now()
    const clientIp = resolveClientIp(context.headers)
    const local = isLocalIp(clientIp)

    // Ban check before any key validation; never counts a failure.
    const banRemainingMs = await this.checkBan(clientIp, nowMs)
    if (banRemainingMs !== undefined) {
      return { ok: false, status: 403, body: bannedBody(banRemainingMs) }
    }

    const authorization = context.headers.authorization
    const presentedKey =
      authorization !== undefined && authorization.length > 0
        ? extractBearerToken(authorization)
        : context.headers['x-management-key'] ?? ''

    // Remote gate; never counted.
    const allowRemote = config.allowRemote || (config.envSecret ?? '').length > 0
    if (!local && !allowRemote) {
      return { ok: false, status: 403, body: REMOTE_MANAGEMENT_DISABLED_BODY }
    }
    // Hot-reload edge: no secret configured at all; never counted.
    if ((config.configSecret ?? '').length === 0 && (config.envSecret ?? '').length === 0) {
      return { ok: false, status: 403, body: REMOTE_MANAGEMENT_KEY_NOT_SET_BODY }
    }
    if (presentedKey.length === 0) {
      const bannedMs = await this.countFailure(clientIp, nowMs)
      if (bannedMs !== undefined) {
        return { ok: false, status: 403, body: bannedBody(bannedMs) }
      }
      return { ok: false, status: 401, body: MISSING_MANAGEMENT_KEY_BODY }
    }

    let authenticated = false
    if (local && (config.localSecret ?? '').length > 0) {
      authenticated = constantTimeEqual(presentedKey, config.localSecret as string)
    }
    if (!authenticated && (config.envSecret ?? '').length > 0) {
      authenticated = constantTimeEqual(presentedKey, config.envSecret as string)
    }
    if (!authenticated && (config.configSecret ?? '').length > 0) {
      authenticated = await verifyManagementSecret(presentedKey, config.configSecret as string)
    }
    if (authenticated) {
      await this.reset(clientIp, nowMs)
      return { ok: true }
    }
    const bannedMs = await this.countFailure(clientIp, nowMs)
    if (bannedMs !== undefined) {
      return { ok: false, status: 403, body: bannedBody(bannedMs) }
    }
    return { ok: false, status: 401, body: INVALID_MANAGEMENT_KEY_BODY }
  }

  /**
   * Read-side ban check for the outcomes that never count a failure
   * (valid key, remote gate, unset secret): returns the remaining ban
   * milliseconds, or undefined when the IP is not banned. An expired ban
   * is lifted here, resetting the counter as a side effect.
   */
  private async checkBan(ip: string, nowMs: number): Promise<number | undefined> {
    const doc = asAttemptsRecord(await this.store.get(MGMT_ATTEMPTS_NAMESPACE, MGMT_ATTEMPTS_KEY))
    const entry = doc[ip]
    const bannedUntil =
      entry === undefined || entry.banned_until === undefined
        ? undefined
        : parseRfc3339Ms(entry.banned_until)
    if (bannedUntil === undefined) return undefined
    if (bannedUntil > nowMs) return bannedUntil - nowMs
    await this.liftExpiredBan(ip, nowMs)
    return undefined
  }

  /**
   * Counted-failure path: one atomic update both re-checks the ban and
   * counts the failure, so a concurrent burst serializes on the store.
   * Exactly `MANAGEMENT_BAN_THRESHOLD` requests answer 401 (the last of
   * them triggers the ban) and the rest find the live ban and answer 403.
   * Returns the remaining ban milliseconds when the request hit a live ban
   * instead of being counted. An expired ban found here counts as lifted:
   * the count starts over and the stale deadline is dropped.
   */
  private async countFailure(ip: string, nowMs: number): Promise<number | undefined> {
    let banRemainingMs: number | undefined
    await this.store.update(MGMT_ATTEMPTS_NAMESPACE, MGMT_ATTEMPTS_KEY, (current) => {
      // The callback may re-run against a newer document; the decision is
      // recomputed from scratch on every run, so the reported outcome
      // always matches the state this update commits.
      banRemainingMs = undefined
      const doc: AttemptsRecord = asAttemptsRecord(current)
      const existing = doc[ip]
      const bannedUntil =
        existing === undefined || existing.banned_until === undefined
          ? undefined
          : parseRfc3339Ms(existing.banned_until)
      if (bannedUntil !== undefined && bannedUntil > nowMs) {
        banRemainingMs = bannedUntil - nowMs
        return doc
      }
      const failures = (existing?.failures ?? 0) + 1
      const lastSeen = formatRfc3339(nowMs)
      if (failures >= MANAGEMENT_BAN_THRESHOLD) {
        return {
          ...doc,
          [ip]: {
            failures: 0,
            banned_until: formatRfc3339(nowMs + MANAGEMENT_BAN_DURATION_MS),
            last_seen: lastSeen,
          },
        }
      }
      return { ...doc, [ip]: { failures, last_seen: lastSeen } }
    })
    return banRemainingMs
  }

  private async reset(ip: string, nowMs: number): Promise<void> {
    await this.store.update(MGMT_ATTEMPTS_NAMESPACE, MGMT_ATTEMPTS_KEY, (current) => {
      const doc: AttemptsRecord = asAttemptsRecord(current)
      if (doc[ip] === undefined) return doc
      return { ...doc, [ip]: { failures: 0, last_seen: formatRfc3339(nowMs) } }
    })
  }

  private async liftExpiredBan(ip: string, nowMs: number): Promise<void> {
    await this.store.update(MGMT_ATTEMPTS_NAMESPACE, MGMT_ATTEMPTS_KEY, (current) => {
      const doc: AttemptsRecord = asAttemptsRecord(current)
      const entry = doc[ip]
      if (entry === undefined || entry.banned_until === undefined) return doc
      const until = parseRfc3339Ms(entry.banned_until)
      if (until === undefined || until <= nowMs) {
        return { ...doc, [ip]: { failures: 0, last_seen: formatRfc3339(nowMs) } }
      }
      return doc
    })
  }

  /**
   * Purges attempt entries that no longer matter: entries with a live ban
   * are kept, zero-failure entries are dropped, and the rest are judged by
   * the `last_seen` activity timestamp - idle beyond the 2-hour cutoff,
   * with no live ban, they are removed. Runtimes schedule this sweep;
   * upstream runs it hourly. An entry without a readable `last_seen` is
   * kept, since its idleness cannot be judged.
   */
  async sweepIdleEntries(): Promise<void> {
    const nowMs = this.now()
    await this.store.update(MGMT_ATTEMPTS_NAMESPACE, MGMT_ATTEMPTS_KEY, (current) => {
      const doc: AttemptsRecord = asAttemptsRecord(current)
      const next: AttemptsRecord = {}
      for (const [ip, entry] of Object.entries(doc)) {
        const until =
          entry.banned_until === undefined ? undefined : parseRfc3339Ms(entry.banned_until)
        if (until !== undefined && until > nowMs) {
          next[ip] = entry
          continue
        }
        if (entry.failures === 0) continue
        const lastSeen = entry.last_seen === undefined ? undefined : parseRfc3339Ms(entry.last_seen)
        if (lastSeen !== undefined && nowMs - lastSeen > MANAGEMENT_SWEEP_MAX_IDLE_MS) continue
        next[ip] = {
          failures: entry.failures,
          ...(entry.last_seen === undefined ? {} : { last_seen: entry.last_seen }),
        }
      }
      return next
    })
  }
}
