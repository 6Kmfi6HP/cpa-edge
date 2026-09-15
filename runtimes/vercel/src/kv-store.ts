/**
 * External-KV implementation of the @cpa-edge/core `Store` contract for
 * the Vercel runtime (S7 vercel column: R1).
 *
 * Substrate and consistency trade-offs vs. the in-memory and Durable
 * Object stores - these are the S7 "vercel" classifications made
 * concrete:
 *
 * - `update()` runs as an optimistic compare-and-swap loop: read the
 *   document (with its version), run the caller's callback, then
 *   conditionally write only if the version is still the observed one.
 *   A competing writer (or a delete) makes the conditional write fail
 *   and the loop re-reads and re-runs the callback. Lost updates are
 *   therefore impossible, but the callback may run any number of times
 *   and must stay pure - the core contract already requires exactly that.
 * - The remote side serializes commands per key, but reads that travel
 *   through an asynchronous replica can be stale. Stale reads surface as
 *   CAS failures, never as wrong commits; the loop absorbs them. There is
 *   no cross-key transaction: multi-document invariants are NOT atomic
 *   here (the DO store provides those; S6's per-document mapping keeps
 *   every CPA-Edge document single-key, so the contract holds).
 * - Queues are lease-based and lazy, exactly as the core contract
 *   demands: lapsed leases are reclaimed by the next `claim`, never by a
 *   background timer. Serverless invocations cannot keep timers alive,
 *   so ALL retention sweeps ride request traffic (claims, pops, ring
 *   appends). The claim walk scans the queue head-to-tail inside one
 *   atomic command; that is a documented degraded cost, not a semantic
 *   change - FIFO order and at-least-once redelivery still hold.
 * - Rings trim on append; a racing pair of appends can transiently leave
 *   one entry more than the capacity in the window until the next
 *   append's trim, because the trim is part of the append command.
 *   Reads are plain snapshots; no notification mechanism exists.
 */

import {
  CpaError,
  DEFAULT_RING_CAPACITY,
  isJsonValue,
  type ClaimHandle,
  type JsonValue,
  type QueueClaim,
  type Store,
  type UpdateCallback,
} from '@cpa-edge/core'
import {
  InMemoryKvDriver,
  type DocumentExpectation,
  type KvDriver,
  type QueueItemRecord,
} from './kv-driver'

/** Constructor options of {@link KvStore}. */
export interface KvStoreOptions {
  /** Command driver; see `RestKvDriver` for the production wiring. */
  readonly driver: KvDriver
  /** Epoch-milliseconds clock for lease arithmetic; defaults to `Date.now`. */
  readonly now?: () => number
  /** Key namespace prefix; defaults to `cpa-edge`. */
  readonly keyPrefix?: string
}

/** One queue item record as persisted through the driver. */
interface StoredQueueItem {
  readonly p: string
  readonly s: 'a' | 'l'
  readonly t: string
  readonly e: number
}

/**
 * `Store` over an external Redis-compatible KV service (or the in-memory
 * driver in tests). Nothing is cached: every method round-trips the
 * driver, so concurrent invocations on the same deployment observe each
 * other's committed state, subject to the replica-staleness note above.
 */
export class KvStore implements Store {
  private readonly driver: KvDriver
  private readonly now: () => number
  private readonly keyPrefix: string

  constructor(options: KvStoreOptions) {
    this.driver = options.driver
    this.now = options.now ?? (() => Date.now())
    this.keyPrefix = options.keyPrefix ?? 'cpa-edge'
  }

  async get(namespace: string, key: string): Promise<JsonValue | undefined> {
    const documentKey = this.documentKey(namespace, key)
    const stored = await this.driver.readDocument(documentKey)
    if (stored === null) return undefined
    return parseJsonValue(stored.value, 'stored document')
  }

  async put(namespace: string, key: string, value: JsonValue): Promise<void> {
    const accepted = acceptValue(value, 'value')
    const documentKey = this.documentKey(namespace, key)
    // Unconditional write; the version still advances inside the driver
    // so an in-flight update loop cannot commit over it unnoticed.
    await this.driver.writeDocument(documentKey, accepted, { kind: 'any' })
  }

  async delete(namespace: string, key: string): Promise<boolean> {
    return await this.driver.deleteDocument(this.documentKey(namespace, key))
  }

  async list(namespace: string, prefix?: string): Promise<string[]> {
    const scoped = requireName(namespace, 'namespace')
    const encodedPrefix = `${this.keyPrefix}:d:${encodeName(scoped)}:`
    const scanPrefix = prefix === undefined ? encodedPrefix : encodedPrefix + encodeName(prefix)
    const found = await this.driver.scanKeys(scanPrefix)
    const keys = found.map((key) => decodeName(key.slice(scanPrefix.length)))
    keys.sort()
    return keys
  }

  async update<T extends JsonValue>(
    namespace: string,
    key: string,
    mutate: UpdateCallback<T>,
  ): Promise<T> {
    const documentKey = this.documentKey(namespace, key)
    for (;;) {
      const stored = await this.driver.readDocument(documentKey)
      const current = stored === null ? undefined : parseJsonValue(stored.value, 'stored document')
      const next = await mutate(current === undefined ? undefined : (current as T))
      const accepted = acceptValue(next, 'update result')
      const expectation: DocumentExpectation =
        stored === null ? { kind: 'absent' } : { kind: 'version', version: stored.version }
      const committed = await this.driver.writeDocument(documentKey, accepted, expectation)
      if (committed) return parseJsonValue(accepted, 'update result') as T
      // Someone else committed while the callback was pending (a write,
      // a delete, or replica staleness): re-read and re-run the callback.
    }
  }

  async enqueue(queue: string, payload: JsonValue): Promise<string> {
    const queueKey = this.queueKey(queue)
    const item: StoredQueueItem = {
      p: acceptValue(payload, 'payload'),
      s: 'a',
      t: '',
      e: 0,
    }
    return await this.driver.enqueueItem(queueKey, JSON.stringify(item))
  }

  async claim(queue: string, leaseMs: number): Promise<QueueClaim | undefined> {
    const queueKey = this.queueKey(queue)
    if (typeof leaseMs !== 'number' || !Number.isFinite(leaseMs) || leaseMs <= 0) {
      throw new CpaError('invalid-input', 'lease duration must be a positive number of milliseconds')
    }
    const token = crypto.randomUUID()
    const claimed = await this.driver.claimOldest(queueKey, this.now(), leaseMs, token)
    if (claimed === null) return undefined
    const item = parseQueueItem(claimed.item)
    return Object.freeze({
      id: claimed.id,
      token,
      payload: parseJsonValue(item.p, 'queue payload'),
      leaseExpiresAt: claimed.leaseExpiresAt,
    }) satisfies QueueClaim
  }

  async ack(queue: string, claim: ClaimHandle): Promise<boolean> {
    return await this.settle(queue, claim, 'ack')
  }

  async release(queue: string, claim: ClaimHandle): Promise<boolean> {
    return await this.settle(queue, claim, 'release')
  }

  async ringAppend(ring: string, entry: JsonValue, capacity: number = DEFAULT_RING_CAPACITY): Promise<void> {
    const ringKey = this.ringKey(ring)
    if (typeof capacity !== 'number' || !Number.isInteger(capacity) || capacity <= 0) {
      throw new CpaError('invalid-input', 'ring capacity must be a positive whole number')
    }
    await this.driver.ringAppend(ringKey, acceptValue(entry, 'entry'), capacity)
  }

  async ringRead(ring: string, maxEntries?: number): Promise<JsonValue[]> {
    const ringKey = this.ringKey(ring)
    if (
      maxEntries !== undefined &&
      (typeof maxEntries !== 'number' || !Number.isInteger(maxEntries) || maxEntries < 0)
    ) {
      throw new CpaError('invalid-input', 'entry count must be a non-negative whole number')
    }
    const stored = await this.driver.ringRead(ringKey, maxEntries ?? 'all')
    return stored.map((entry) => parseJsonValue(entry, 'ring entry'))
  }

  private async settle(
    queue: string,
    claim: ClaimHandle,
    action: 'ack' | 'release',
  ): Promise<boolean> {
    requireHandle(claim)
    return await this.driver.settleClaim(this.queueKey(queue), claim.id, claim.token, action)
  }

  private documentKey(namespace: string, key: string): string {
    return `${this.keyPrefix}:d:${encodeName(requireName(namespace, 'namespace'))}:${encodeName(
      requireName(key, 'key'),
    )}`
  }

  private queueKey(queue: string): string {
    return `${this.keyPrefix}:q:${encodeName(requireName(queue, 'queue'))}`
  }

  private ringKey(ring: string): string {
    return `${this.keyPrefix}:r:${encodeName(requireName(ring, 'ring'))}`
  }
}

/** Convenience constructor over the in-memory driver (tests, local dev). */
export function createInMemoryKvStore(options: Omit<KvStoreOptions, 'driver'> = {}): KvStore {
  return new KvStore({ ...options, driver: new InMemoryKvDriver() })
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function requireName(value: string, label: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new CpaError('invalid-input', `${label} must be a non-empty string`)
  }
  return value
}

function requireHandle(claim: ClaimHandle): void {
  const handle: unknown = claim
  if (typeof handle !== 'object' || handle === null) {
    throw new CpaError('invalid-input', 'claim handle must carry a non-empty id and token')
  }
  const record = handle as Record<string, unknown>
  if (
    typeof record['id'] !== 'string' ||
    record['id'] === '' ||
    typeof record['token'] !== 'string' ||
    record['token'] === ''
  ) {
    throw new CpaError('invalid-input', 'claim handle must carry a non-empty id and token')
  }
}

/** Validates JSON-encodability and returns the serialized text. */
function acceptValue(value: JsonValue, label: string): string {
  if (!isJsonValue(value)) {
    throw new CpaError('invalid-input', `${label} must be JSON-encodable data`, { field: label })
  }
  try {
    return JSON.stringify(value)
  } catch (error) {
    if (error instanceof RangeError) throw error
    throw new CpaError('invalid-input', `${label} must be JSON-encodable data`, { field: label })
  }
}

function parseJsonValue(text: string, label: string): JsonValue {
  try {
    const parsed: unknown = JSON.parse(text)
    if (!isJsonValue(parsed)) {
      throw new CpaError('unavailable', `${label} did not hold JSON data`)
    }
    return parsed
  } catch (error) {
    if (error instanceof CpaError) throw error
    throw new CpaError('unavailable', `${label} was not valid JSON`, { cause: String(error) })
  }
}

function parseQueueItem(text: string): QueueItemRecord {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new CpaError('unavailable', 'queue item record was not valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CpaError('unavailable', 'queue item record had an unexpected shape')
  }
  const record = parsed as { [key: string]: unknown }
  if (typeof record['p'] !== 'string') {
    throw new CpaError('unavailable', 'queue item record was missing its payload')
  }
  return {
    payload: record['p'],
    state: record['s'] === 'l' ? 'leased' : 'available',
    token: typeof record['t'] === 'string' ? record['t'] : '',
    leaseExpiresAt: typeof record['e'] === 'number' ? record['e'] : 0,
  }
}

// ---------------------------------------------------------------------------
// Name encoding
// ---------------------------------------------------------------------------

/**
 * Names are opaque strings, so they travel percent-encoded inside the KV
 * key path. The encoded form never contains `:` (namespace separator),
 * glob metacharacters or the escape character itself, which keeps
 * `list()` prefix scans unambiguous: an encoded prefix can only match
 * keys of the very same namespace.
 */
const NAME_ESCAPES: Readonly<Record<string, string>> = Object.freeze({
  '%': '%25',
  ':': '%3A',
  '*': '%2A',
  '?': '%3F',
  '[': '%5B',
  ']': '%5D',
  '\\': '%5C',
})

function encodeName(name: string): string {
  return name.replace(/[%:*?\[\]]/g, (match) => NAME_ESCAPES[match] ?? match)
}

function decodeName(encoded: string): string {
  return encoded.replace(/%25|%3A|%2A|%3F|%5B|%5D|%5C/g, (match) => {
    switch (match) {
      case '%25':
        return '%'
      case '%3A':
        return ':'
      case '%2A':
        return '*'
      case '%3F':
        return '?'
      case '%5B':
        return '['
      case '%5D':
        return ']'
      default:
        return '\\'
    }
  })
}
