/**
 * The Durable Object alarm pass (mission T2, R3): the S7 substrate for
 * every piece of timed work on serverless.
 *
 * One alarm firing runs, in order:
 *
 * 1. the token-refresh pass - every refreshable OAuth credential in the
 *    Store is evaluated with the auth package's scheduling rule; due
 *    credentials are refreshed through the vendor token endpoints and
 *    the bookkeeping rides the `auth-refresh` documents. Credentials
 *    whose effective proxy mode is `proxy` are skipped: this runtime
 *    has no proxy egress, and a refresh must never be silently sent
 *    direct (S7 section 2.3-F1-6). The queue document that records the
 *    scan (`scheduler/refresh-queue`) is the artifact the next alarm
 *    time is computed from.
 * 2. the device-flow poll pass - one poll step per due RFC-8628 session
 *    (kimi / xai / meta), mirroring the auth package's loop semantics
 *    step by step; sessions complete with the same recorded
 *    transitions as upstream (S7 section 2.3-F5b-2).
 * 3. the usage retention sweep - stale usage records are claimed and
 *    dropped, oldest first (S6 section 3.5.3 consumer-side retention).
 * 4. the management attempt sweep - hourly purge of idle ban entries
 *    (S6 section 3.3.3).
 * 5. re-arm - the next alarm lands at the earliest interesting moment,
 *    and never later than the idle heartbeat, so new credentials and
 *    uploaded auth files are picked up without any external trigger.
 *
 * Cooldown expiry needs no alarm work by contract: cooldown reads are
 * lazily evaluated against their timestamps (core CooldownTracker), so
 * expiry re-checks ride request time; the alarm path only guarantees
 * the substrate that could ever need one.
 */
import type { JsonValue, Store } from '@cpa-edge/core'
import {
  deviceDeadlineMs,
  isRefreshableCredential,
  KIMI,
  META,
  OAuthSessionRegistry,
  parseRfc3339Ms,
  REFRESH_LEADS_MS,
  RefreshRegistry,
  refreshCredential,
  shouldRefresh,
  XAI,
  buildKimiCredential,
  buildMetaCredential,
  buildXaiCredential,
  ExchangeError,
  saveAuthFile,
  AUTH_FILES_NAMESPACE,
  ManagementAuthService,
  prepareManagementSecretSync,
  MANAGEMENT_SWEEP_INTERVAL_MS,
  formatRfc3339,
  type FetchLike,
} from '@cpa-edge/auth'
import { resolveProxyMode, type NormalizedConfig } from './config'

/** Store namespace of the alarm scheduler's own documents. */
export const SCHEDULER_NAMESPACE = 'scheduler'

/** Queue document recording one refresh scan (the refresh-queue doc). */
export const REFRESH_QUEUE_KEY = 'refresh-queue'

/** Key prefix of one device-flow poll bookkeeping document. */
export const DEVICE_POLL_PREFIX = 'device-poll:'

/** Maintenance document: cross-pass sweep cadence bookkeeping. */
export const MAINTENANCE_KEY = 'maintenance'

/**
 * Longest gap between alarms when nothing is due. Wakes the object so
 * newly uploaded credentials, device sessions and config edits are
 * noticed without an external trigger.
 */
export const IDLE_HEARTBEAT_MS = 60_000

/** Refresh attempts per alarm pass, bounded by the reference's pool cap. */
const REFRESH_PASS_LIMIT = 16

/** Stale usage records dropped per alarm pass (oldest first). */
const USAGE_SWEEP_LIMIT = 128

/** Claim lease the retention sweep uses (same as the pop consumer). */
const SWEEP_LEASE_MS = 30_000

/** Provider ids whose login sessions poll a device-code endpoint. */
type DeviceProvider = 'kimi' | 'xai' | 'meta'

/** One refresh-queue document entry (JSON-value compatible). */
type RefreshQueueEntry = {
  readonly file: string
  readonly provider: string
  /** Epoch ms at or after which the credential becomes due, if ever. */
  readonly dueAtMs: number | null
}

/**
 * The refresh-queue document written by every refresh pass. A type
 * alias (not an interface) so it satisfies the Store's JSON-value
 * narrowing (S6 section 0).
 */
export type RefreshQueueDocument = {
  readonly version: 1
  readonly checked_at: string
  readonly next_due_at_ms: number | null
  readonly entries: readonly RefreshQueueEntry[]
}

/** Device-flow poll bookkeeping (one per pending login session). */
export type DevicePollDocument = {
  readonly state: string
  readonly provider: DeviceProvider
  readonly device_code: string
  readonly token_endpoint: string
  /** Current poll interval; `slow_down` widens it (kimi keeps it fixed). */
  readonly interval_ms: number
  /** Epoch ms of the next poll step. */
  readonly next_poll_at_ms: number
  /** Epoch ms after which the session is terminal-expired. */
  readonly deadline_at_ms: number
}

/** Clock + transport + config the alarm pass consumes. */
export interface AlarmDeps {
  readonly store: Store
  readonly now: () => number
  readonly fetch: FetchLike
  /** Current normalized config (proxy-url, retention, management). */
  readonly config: () => NormalizedConfig
  /** Sleeper for in-refresh retry waits; defaults to real time (tests stub it). */
  readonly sleep?: (ms: number) => Promise<void>
}

// ---------------------------------------------------------------------------
// Device poll registration (gateway side)
// ---------------------------------------------------------------------------

function asRecord(value: JsonValue | undefined): Readonly<Record<string, JsonValue>> | undefined {
  if (value === undefined || typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined
  }
  return value as Readonly<Record<string, JsonValue>>
}

const readStringField = (source: Readonly<Record<string, JsonValue>>, key: string): string | undefined => {
  const value = source[key]
  return typeof value === 'string' ? value : undefined
}

const readNumberField = (source: Readonly<Record<string, JsonValue>>, key: string): number | undefined => {
  const value = source[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Registers poll bookkeeping for a fresh device-flow session the login
 * endpoint just created. The session document (written by the auth
 * plane) is the source of truth; the poll document only adds timing
 * state the alarm needs. Kimi and Meta wait one interval before the
 * first poll; xAI polls immediately (recorded first-poll semantics).
 */
export async function registerDevicePoll(
  store: Store,
  provider: DeviceProvider,
  state: string,
  now: () => number,
): Promise<boolean> {
  const session = await new OAuthSessionRegistry(store, { now }).get(state)
  if (session === undefined) return false
  const metadata = asRecord(session.metadata)
  if (metadata === undefined) return false
  const deviceCode = readStringField(metadata, 'device_code')
  const tokenEndpoint = readStringField(metadata, 'token_endpoint')
  const intervalMs = readNumberField(metadata, 'interval')
  if (deviceCode === undefined || tokenEndpoint === undefined || intervalMs === undefined) return false
  const nowMs = now()
  const document: DevicePollDocument = {
    state,
    provider,
    device_code: deviceCode,
    token_endpoint: tokenEndpoint,
    interval_ms: Math.max(intervalMs, 5_000),
    next_poll_at_ms: provider === 'xai' ? nowMs : nowMs + Math.max(intervalMs, 5_000),
    deadline_at_ms: deviceDeadlineMs(provider, readNumberField(metadata, 'expires_in'), nowMs),
  }
  await store.put(SCHEDULER_NAMESPACE, `${DEVICE_POLL_PREFIX}${state}`, document)
  return true
}

/**
 * Schedules the next alarm no later than `atMs`: sets it when none is
 * armed or the armed one would land later (a `setAlarm` call replaces
 * the pending one, so a careless poke could delay work).
 */
export async function ensureAlarmBefore(
  alarm: { setAlarm(scheduledAtMs: number): Promise<void>; getAlarm(): Promise<number | null> },
  atMs: number,
): Promise<void> {
  const current = await alarm.getAlarm()
  if (current !== null && current <= atMs) return
  await alarm.setAlarm(atMs)
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

/** Epoch-ms deadline parse of a credential's `expired` field. */
function credentialExpiryMs(document: Readonly<Record<string, JsonValue>>): number | undefined {
  const expired = document['expired']
  if (typeof expired !== 'string' || expired.length === 0) return undefined
  const parsed = parseRfc3339Ms(expired)
  return parsed === undefined || Number.isNaN(parsed) ? undefined : parsed
}

/** Optional per-credential refresh interval override, in epoch ms. */
function preferredIntervalMs(document: Readonly<Record<string, JsonValue>>): number | undefined {
  const raw = document['refresh_interval_seconds']
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return undefined
  return raw * 1_000
}

/**
 * Next instant at which the scheduling rule would answer `due`, for
 * alarm arming. A live backoff wins; otherwise the lead window against
 * the token expiry; otherwise the interval since the last refresh.
 * `undefined` = never (api-key kinds, providers without leads).
 */
function nextRefreshDueAtMs(
  input: { readonly provider: string; readonly expiresAtMs?: number; readonly preferredIntervalMs?: number },
  bookkeeping: { readonly next_refresh_after?: string; readonly last_refreshed_at?: string },
  nowMs: number,
): number | undefined {
  const backoff = bookkeeping.next_refresh_after === undefined
    ? undefined
    : parseRfc3339Ms(bookkeeping.next_refresh_after)
  if (backoff !== undefined && backoff > nowMs) return backoff
  const windowMs = input.preferredIntervalMs ?? REFRESH_LEADS_MS[input.provider]
  if (windowMs === undefined) return undefined
  if (input.expiresAtMs !== undefined) return Math.max(nowMs, input.expiresAtMs - windowMs)
  const last = bookkeeping.last_refreshed_at === undefined
    ? undefined
    : parseRfc3339Ms(bookkeeping.last_refreshed_at)
  if (last === undefined) return nowMs
  return Math.max(nowMs, last + windowMs)
}

/**
 * The refresh scan. Returns the earliest next-due moment over every
 * refreshable credential (including skipped ones), and writes the
 * refresh-queue document.
 */
async function refreshPass(deps: AlarmDeps): Promise<number | undefined> {
  const { store, now, fetch, config } = deps
  const registry = new RefreshRegistry(store, { now })
  const names = await store.list(AUTH_FILES_NAMESPACE)
  const entries: RefreshQueueEntry[] = []
  let nextDue: number | undefined
  let refreshed = 0

  for (const name of names) {
    const parsed = parseAuthFile(name, await store.get(AUTH_FILES_NAMESPACE, name))
    if (parsed === undefined) continue
    const { provider, document, disabled, proxyUrl } = parsed
    // Proxy-credentialed credentials cannot carry traffic here and their
    // refresh is skipped rather than silently sent direct (NE-S7-01 /
    // S7 section 2.3-F1-6).
    if (resolveProxyMode(proxyUrl, config().proxyUrl) === 'proxy') continue
    if (disabled) continue
    if (!isRefreshableCredential(provider, document)) continue

    const input = {
      kind: 'oauth' as const,
      provider,
      expiresAtMs: credentialExpiryMs(document),
      ...(preferredIntervalMs(document) === undefined
        ? {}
        : { preferredIntervalMs: preferredIntervalMs(document) }),
    }
    const bookkeeping = await registry.get(name)
    const dueAtMs = nextRefreshDueAtMs(input, bookkeeping, now())
    if (dueAtMs === undefined) continue
    entries.push({ file: name, provider, dueAtMs })
    nextDue = nextDue === undefined ? dueAtMs : Math.min(nextDue, dueAtMs)
    if (!shouldRefresh(input, bookkeeping, now()) || refreshed >= REFRESH_PASS_LIMIT) continue

    const outcome = await refreshCredential(provider, document, {
      fetch,
      now,
      ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
    })
    refreshed += 1
    if (outcome.ok) {
      const patch = outcome.documentPatch
      await store.update<Record<string, JsonValue>>(AUTH_FILES_NAMESPACE, name, (current) => ({
        ...(current ?? document),
        ...patch,
      }))
      await registry.recordSuccess(name, outcome.effective)
      const patchedExpiry = credentialExpiryMs({ ...document, ...patch })
      const windowMs = input.preferredIntervalMs ?? REFRESH_LEADS_MS[provider]
      if (patchedExpiry !== undefined && windowMs !== undefined) {
        const nextRound = Math.max(now(), patchedExpiry - windowMs)
        nextDue = nextDue === undefined ? nextRound : Math.min(nextDue, nextRound)
      }
      continue
    }
    if (outcome.unauthorized) {
      await registry.recordUnauthorized(name, 'unauthorized')
      continue
    }
    await registry.recordFailure(name, outcome.message, outcome.blockedUntilMs)
    if (outcome.blockedUntilMs !== undefined) {
      nextDue = nextDue === undefined ? outcome.blockedUntilMs : Math.min(nextDue, outcome.blockedUntilMs)
    }
  }

  const queueDocument: RefreshQueueDocument = {
    version: 1,
    checked_at: formatRfc3339(now()),
    next_due_at_ms: nextDue === undefined ? null : nextDue,
    entries,
  }
  await store.put(SCHEDULER_NAMESPACE, REFRESH_QUEUE_KEY, queueDocument)
  return nextDue
}

/** Narrow parse of one auth file document for the refresh scan. */
function parseAuthFile(
  name: string,
  value: JsonValue | undefined,
): {
  readonly provider: string
  readonly document: Record<string, JsonValue>
  readonly disabled: boolean
  readonly proxyUrl: string
} | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  void name
  const provider = typeof record['type'] === 'string' ? record['type'].trim().toLowerCase() : ''
  return {
    provider: provider.length > 0 ? provider : 'unknown',
    document: record as Record<string, JsonValue>,
    disabled: record['disabled'] === true,
    proxyUrl: typeof record['proxy_url'] === 'string' ? record['proxy_url'] : '',
  }
}

// ---------------------------------------------------------------------------
// Device-flow poll steps
// ---------------------------------------------------------------------------

/** Outcome of one poll step. */
type PollStep =
  | { readonly kind: 'pending'; readonly nextPollAtMs: number; readonly intervalMs: number }
  | { readonly kind: 'terminal'; readonly message: string }
  | { readonly kind: 'success'; readonly payload: Record<string, unknown> }

async function postJson(
  fetch: FetchLike,
  endpoint: string,
  init: { readonly headers: Record<string, string>; readonly body: string },
): Promise<{ status: number; json: Record<string, unknown> | undefined }> {
  const response = await fetch(endpoint, { method: 'POST', ...init })
  const text = await response.text()
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }
  const record =
    typeof json === 'object' && json !== null && !Array.isArray(json)
      ? (json as Record<string, unknown>)
      : undefined
  return { status: response.status, json: record }
}

function formOf(pairs: ReadonlyArray<readonly [string, string]>): string {
  return pairs.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&')
}

/** Kimi step: fixed ticker, `slow_down` is a no-op (recorded O-5). */
async function kimiPollStep(doc: DevicePollDocument, fetch: FetchLike, nowMs: number): Promise<PollStep> {
  const form = formOf([
    ['client_id', KIMI.clientId],
    ['device_code', doc.device_code],
    ['grant_type', KIMI.deviceGrant],
  ])
  const { status, json } = await postJson(fetch, doc.token_endpoint, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
  })
  const error = json === undefined ? undefined : typeof json['error'] === 'string' ? json['error'] : undefined
  if (error === 'authorization_pending' || error === 'slow_down') {
    return { kind: 'pending', nextPollAtMs: nowMs + doc.interval_ms, intervalMs: doc.interval_ms }
  }
  if (error === 'expired_token') return { kind: 'terminal', message: 'kimi: device code expired' }
  if (error === 'access_denied') return { kind: 'terminal', message: 'kimi: access denied by user' }
  if (status === 200 && error === undefined && json !== undefined) {
    return { kind: 'success', payload: json }
  }
  return { kind: 'terminal', message: `kimi: unexpected device token response (${status})` }
}

/** xAI step: `slow_down` widens the interval by 5 s. */
async function xaiPollStep(doc: DevicePollDocument, fetch: FetchLike, nowMs: number): Promise<PollStep> {
  const form = formOf([
    ['grant_type', 'urn:ietf:params:oauth:grant-type:device_code'],
    ['device_code', doc.device_code],
    ['client_id', XAI.clientId],
  ])
  const { status, json } = await postJson(fetch, doc.token_endpoint, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
  })
  const error = json === undefined ? undefined : typeof json['error'] === 'string' ? json['error'] : undefined
  if (error === 'authorization_pending') {
    return { kind: 'pending', nextPollAtMs: nowMs + doc.interval_ms, intervalMs: doc.interval_ms }
  }
  if (error === 'slow_down') {
    const widened = doc.interval_ms + 5_000
    return { kind: 'pending', nextPollAtMs: nowMs + widened, intervalMs: widened }
  }
  if (error === 'expired_token' || error === 'access_denied') {
    return { kind: 'terminal', message: `xai: ${error}` }
  }
  if (status >= 200 && status < 300 && error === undefined && json !== undefined) {
    return { kind: 'success', payload: json }
  }
  return { kind: 'terminal', message: `xai: unexpected device token response (${status})` }
}

/** Meta step: `slow_down` widens the ticker; non-200 without error keeps polling. */
async function metaPollStep(doc: DevicePollDocument, fetch: FetchLike, nowMs: number): Promise<PollStep> {
  const form = formOf([
    ['grant_type', 'urn:ietf:params:oauth:grant-type:device_code'],
    ['device_code', doc.device_code],
    ['client_id', META.clientId],
  ])
  const { status, json } = await postJson(fetch, doc.token_endpoint, {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': META.userAgent,
    },
    body: form,
  })
  const error = json === undefined ? undefined : typeof json['error'] === 'string' ? json['error'] : undefined
  if (status === 200 && json !== undefined && error === undefined) {
    return { kind: 'success', payload: await mintMetaKey(json, fetch) }
  }
  if (error === 'authorization_pending') {
    return { kind: 'pending', nextPollAtMs: nowMs + doc.interval_ms, intervalMs: doc.interval_ms }
  }
  if (error === 'slow_down') {
    const widened = doc.interval_ms + 5_000
    return { kind: 'pending', nextPollAtMs: nowMs + widened, intervalMs: widened }
  }
  if (error === 'access_denied' || error === 'expired_token') {
    return { kind: 'terminal', message: `meta: ${error}` }
  }
  if (error !== undefined) return { kind: 'terminal', message: `meta: ${error}` }
  // Unexpected non-200 without an error body: keep polling (recorded).
  return { kind: 'pending', nextPollAtMs: nowMs + doc.interval_ms, intervalMs: doc.interval_ms }
}

/**
 * Meta key minting: the DCA access token is exchanged for an API key.
 * Mint failure is non-fatal for login - the credential then keeps the
 * DCA expiry instead of an empty one (same rule as the package's
 * device-flow loop).
 */
async function mintMetaKey(
  payload: Record<string, unknown>,
  fetch: FetchLike,
): Promise<Record<string, unknown>> {
  const dcaToken = typeof payload['access_token'] === 'string' ? payload['access_token'] : undefined
  if (dcaToken === undefined) return payload
  try {
    const response = await fetch(META.keyMintEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${dcaToken}`,
        'User-Agent': META.userAgent,
      },
      body: JSON.stringify({ dca_token: dcaToken }),
    })
    if (!response.ok) return payload
    const text = await response.text()
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return payload
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return payload
    return { ...payload, minted: parsed as Record<string, unknown> }
  } catch {
    return payload
  }
}

function asDevicePollDocument(value: JsonValue | undefined): DevicePollDocument | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const state = readStringField(record, 'state')
  const provider = readStringField(record, 'provider')
  const deviceCode = readStringField(record, 'device_code')
  const tokenEndpoint = readStringField(record, 'token_endpoint')
  const intervalMs = readNumberField(record, 'interval_ms')
  const nextPollAtMs = readNumberField(record, 'next_poll_at_ms')
  const deadlineAtMs = readNumberField(record, 'deadline_at_ms')
  if (
    state === undefined ||
    deviceCode === undefined ||
    tokenEndpoint === undefined ||
    intervalMs === undefined ||
    nextPollAtMs === undefined ||
    deadlineAtMs === undefined
  ) {
    return undefined
  }
  if (provider !== 'kimi' && provider !== 'xai' && provider !== 'meta') return undefined
  return {
    state,
    provider,
    device_code: deviceCode,
    token_endpoint: tokenEndpoint,
    interval_ms: intervalMs,
    next_poll_at_ms: nextPollAtMs,
    deadline_at_ms: deadlineAtMs,
  }
}

/**
 * The device-flow poll pass: one step per due session. Transport
 * failures count as transient - the step retries on the next alarm
 * instead of stranding the session.
 */
async function devicePass(deps: AlarmDeps): Promise<number | undefined> {
  const { store, now, fetch } = deps
  const registry = new OAuthSessionRegistry(store, { now })
  const keys = await store.list(SCHEDULER_NAMESPACE, DEVICE_POLL_PREFIX)
  let nextPoll: number | undefined

  for (const key of keys) {
    const doc = asDevicePollDocument(await store.get(SCHEDULER_NAMESPACE, key))
    if (doc === undefined) {
      await store.delete(SCHEDULER_NAMESPACE, key)
      continue
    }
    const nowMs = now()
    if (doc.next_poll_at_ms > nowMs) {
      nextPoll = nextPoll === undefined ? doc.next_poll_at_ms : Math.min(nextPoll, doc.next_poll_at_ms)
      continue
    }
    const session = await registry.get(doc.state)
    if (session === undefined || session.completed || session.status !== 'pending') {
      // The session ended (cancel race, completion, TTL): drop the
      // bookkeeping; the registry owns the session's own lifecycle.
      await store.delete(SCHEDULER_NAMESPACE, key)
      continue
    }
    if (nowMs >= doc.deadline_at_ms) {
      await registry.setStatusError(doc.state, `${doc.provider}: device code expired`)
      await store.delete(SCHEDULER_NAMESPACE, key)
      continue
    }
    let step: PollStep
    try {
      step =
        doc.provider === 'kimi'
          ? await kimiPollStep(doc, fetch, nowMs)
          : doc.provider === 'xai'
            ? await xaiPollStep(doc, fetch, nowMs)
            : await metaPollStep(doc, fetch, nowMs)
    } catch {
      // Vendor egress failed for this step: retry at the next interval.
      const retryAt = nowMs + doc.interval_ms
      await store.put(SCHEDULER_NAMESPACE, key, { ...doc, next_poll_at_ms: retryAt })
      nextPoll = nextPoll === undefined ? retryAt : Math.min(nextPoll, retryAt)
      continue
    }
    if (step.kind === 'pending') {
      const updated: DevicePollDocument = {
        ...doc,
        interval_ms: step.intervalMs,
        next_poll_at_ms: step.nextPollAtMs,
      }
      await store.put(SCHEDULER_NAMESPACE, key, updated)
      nextPoll = nextPoll === undefined ? step.nextPollAtMs : Math.min(nextPoll, step.nextPollAtMs)
      continue
    }
    if (step.kind === 'terminal') {
      await registry.setStatusError(doc.state, step.message)
      await store.delete(SCHEDULER_NAMESPACE, key)
      continue
    }
    // Success: persist the credential, complete the session, drop the
    // bookkeeping. An incomplete vendor payload marks the session with
    // the recorded save-failure message.
    try {
      const result =
        doc.provider === 'kimi'
          ? await buildKimiCredential(step.payload, nowMs)
          : doc.provider === 'xai'
            ? await buildXaiCredential(step.payload, doc.token_endpoint, nowMs)
            : await buildMetaCredential(step.payload, nowMs)
      await saveAuthFile(store, result.fileName, result.document)
      await registry.complete(doc.state)
    } catch (error) {
      const message = error instanceof ExchangeError ? error.statusMessage : 'Failed to save authentication tokens'
      await registry.setStatusError(doc.state, message)
    }
    await store.delete(SCHEDULER_NAMESPACE, key)
  }
  return nextPoll
}

// ---------------------------------------------------------------------------
// Sweeps
// ---------------------------------------------------------------------------

/**
 * Drops usage records older than the retention window (oldest first).
 * Fresh records are released back to the pool at their original
 * position; unparsable stamps count as fresh.
 */
async function usageRetentionSweep(deps: AlarmDeps, limit = USAGE_SWEEP_LIMIT): Promise<void> {
  const { store, now, config } = deps
  const horizon = now() - config().usageRetentionSeconds * 1_000
  for (let index = 0; index < limit; index++) {
    const claim = await store.claim('usage', SWEEP_LEASE_MS)
    if (claim === undefined) return
    const payload = typeof claim.payload === 'string' ? claim.payload : JSON.stringify(claim.payload)
    let stamped: number
    try {
      const record: unknown = JSON.parse(payload)
      const stamp =
        typeof record === 'object' && record !== null && !Array.isArray(record)
          ? (record as Record<string, unknown>)['timestamp']
          : undefined
      stamped = typeof stamp === 'string' ? Date.parse(stamp) : Number.NaN
    } catch {
      stamped = Number.NaN
    }
    if (Number.isNaN(stamped) || stamped >= horizon) {
      // Oldest queue entry is still inside the window: nothing behind it
      // can be stale either.
      await store.release('usage', claim)
      return
    }
    await store.ack('usage', claim)
  }
}

/** Hourly purge of idle management-ban entries (S6 section 3.3.3). */
async function managementSweep(deps: AlarmDeps): Promise<number | undefined> {
  const { store, now, config } = deps
  const maintenance = asRecord(await store.get(SCHEDULER_NAMESPACE, MAINTENANCE_KEY))
  const lastSweepAtMs = maintenance === undefined ? undefined : readNumberField(maintenance, 'last_mgmt_sweep_at_ms')
  const nowMs = now()
  const nextAt =
    lastSweepAtMs === undefined ? nowMs : Math.max(nowMs, lastSweepAtMs + MANAGEMENT_SWEEP_INTERVAL_MS)
  if (lastSweepAtMs !== undefined && nowMs < nextAt) return nextAt
  const secret = config().remoteManagement.secretKey
  const service = new ManagementAuthService(store, {
    getConfig: () => ({
      ...(secret.length > 0 ? { configSecret: prepareManagementSecretSync(secret).stored } : {}),
      allowRemote: config().remoteManagement.allowRemote,
    }),
    now,
  })
  await service.sweepIdleEntries()
  await store.put(SCHEDULER_NAMESPACE, MAINTENANCE_KEY, {
    version: 1,
    last_mgmt_sweep_at_ms: nowMs,
  })
  return nowMs + MANAGEMENT_SWEEP_INTERVAL_MS
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface AlarmPassResult {
  /** Epoch ms the object asked to be woken at next. */
  readonly nextAlarmAtMs: number
}

/**
 * Runs one full alarm pass and re-arms the object. The heartbeat floor
 * guarantees the loop never goes silent even when nothing is due.
 */
export async function runAlarmPass(deps: AlarmDeps & {
  readonly alarm: { setAlarm(scheduledAtMs: number): Promise<void> }
}): Promise<AlarmPassResult> {
  const nowMs = deps.now()
  const refreshDue = await refreshPass(deps)
  const deviceDue = await devicePass(deps)
  await usageRetentionSweep(deps)
  const sweepDue = await managementSweep(deps)
  const candidates = [nowMs + IDLE_HEARTBEAT_MS]
  for (const at of [refreshDue, deviceDue, sweepDue]) {
    if (at !== undefined) candidates.push(at)
  }
  const nextAlarmAtMs = Math.max(nowMs + 1, Math.min(...candidates))
  await deps.alarm.setAlarm(nextAlarmAtMs)
  return { nextAlarmAtMs }
}
