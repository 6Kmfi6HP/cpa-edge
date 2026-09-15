/**
 * The Durable Object Store (mission T2, R1): the @cpa-edge/core `Store`
 * contract implemented over one Durable Object's storage.
 *
 * Design (S7 section 2.3: the DO is the strong-consistency substrate):
 *
 * - Documents live at storage key `d:["<namespace>","<key>"]` inside a
 *   versioned record `{ v, d? }`. Queues occupy one record per name at
 *   `q:["<name>"]`, rings `r:["<name>"]` - JSON-encoded key parts make
 *   the addressing collision-free for arbitrary namespace/key strings.
 * - Every mutating operation runs its read-modify-write inside ONE
 *   critical section (`exclusive`): a single promise-queue serializes
 *   mutations, because a version check performed in JavaScript between
 *   two storage calls can interleave with another handler doing the
 *   same. Within a section, each committed write bumps the record's
 *   version by exactly one, so versions stay strictly monotonic.
 * - `update()` is the one two-phase operation: its callback runs OUTSIDE
 *   the critical section (callbacks may take arbitrarily long and the
 *   contract allows re-runs), and the version-checked commit happens
 *   inside it. A competing writer makes the check fail, and the
 *   callback re-runs against the newer document - the exact retry
 *   semantics the memory store documents.
 * - Deletions keep a versioned tombstone: an `update()` that read the
 *   pre-delete value fails its CAS and re-runs against `undefined`,
 *   exactly like the memory store.
 * - Queue leases expire lazily: a `claim()` first sweeps leases whose
 *   deadline has passed back into the available pool (persisting the
 *   sweep), then hands the oldest available item a fresh token. There
 *   are no background timers; the alarm pass never needs to touch the
 *   queues for lease purposes.
 * - Values crossing the interface are detached clones; mutation after
 *   a read or write never reaches stored state.
 *
 * The storage surface is the narrow `DoStorageLike`, satisfied by a
 * real `DurableObjectStorage` and by the test harness simulation.
 */
import { CpaError, isJsonValue, type ClaimHandle, DEFAULT_RING_CAPACITY, type JsonValue, type QueueClaim, type Store, type UpdateCallback } from '@cpa-edge/core'
import type { DoStorageLike } from './types'

/** Construction options. */
export interface DurableObjectStoreOptions {
  /** Clock for queue-lease arithmetic; defaults to `Date.now`. */
  readonly now?: () => number
}

/** Versioned document record. */
interface DocRecord {
  readonly v: number
  readonly d?: JsonValue
}

/** Lifecycle state of one queue item. */
type ItemState = 'available' | 'leased'

/** One queued item; array position mirrors enqueue order. */
interface QueueItemRecord {
  readonly id: string
  readonly payload: JsonValue
  state: ItemState
  token: string | undefined
  leaseExpiresAt: number | undefined
}

/** Versioned queue record. */
interface QueueRecord {
  readonly v: number
  readonly items: QueueItemRecord[]
}

/** Versioned ring record. */
interface RingRecord {
  readonly v: number
  readonly e: JsonValue[]
}

/** Storage key of one document. */
const docKey = (namespace: string, key: string): string => `d:${JSON.stringify([namespace, key])}`

/** Storage-key prefix covering every document of one namespace. */
const docPrefixOf = (namespace: string): string =>
  `d:${JSON.stringify([namespace]).slice(0, -1)},`

const queueKey = (name: string): string => `q:${JSON.stringify([name])}`
const ringKey = (name: string): string => `r:${JSON.stringify([name])}`

/** Parses the `["ns","key"]` part of a document storage key. */
function parseDocStorageKey(storageKey: string): readonly [string, string] | undefined {
  const encoded = storageKey.slice('d:'.length)
  try {
    const parsed: unknown = JSON.parse(encoded)
    if (!Array.isArray(parsed) || parsed.length !== 2) return undefined
    const namespace = parsed[0]
    const key = parsed[1]
    if (typeof namespace !== 'string' || typeof key !== 'string') return undefined
    return [namespace, key]
  } catch {
    return undefined
  }
}

/**
 * Store adapter over Durable Object storage. One instance belongs to one
 * DO incarnation; the storage beneath it is the durability layer, so
 * state survives eviction and instance restarts.
 */
export class DurableObjectStore implements Store {
  private readonly storage: DoStorageLike
  private readonly now: () => number
  /** Tail of the mutation queue; every critical section chains onto it. */
  private chain: Promise<void> = Promise.resolve()

  constructor(storage: DoStorageLike, options: DurableObjectStoreOptions = {}) {
    this.storage = storage
    this.now = options.now ?? (() => Date.now())
  }

  /**
   * Runs one critical section with exclusive access to every other
   * mutation on this store. Failures propagate to the caller; the queue
   * itself always continues.
   */
  private exclusive<T>(section: () => Promise<T>): Promise<T> {
    const run = this.chain.then(section, section)
    this.chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  async get(namespace: string, key: string): Promise<JsonValue | undefined> {
    const name = requireName(namespace, 'namespace')
    const id = requireName(key, 'key')
    const record = await this.readDoc(name, id)
    const value = record?.d
    return value === undefined ? undefined : detached(value)
  }

  async put(namespace: string, key: string, value: JsonValue): Promise<void> {
    const accepted = acceptValue(value, 'value')
    const storageKey = docKey(requireName(namespace, 'namespace'), requireName(key, 'key'))
    // Last writer wins - but the version still advances by exactly one
    // inside the critical section, so in-flight `update()` commits stay
    // fenced.
    await this.exclusive(async () => {
      const seenVersion = versionOf(await this.readRecord(storageKey))
      await this.storage.put(storageKey, { v: seenVersion + 1, d: accepted })
    })
  }

  async delete(namespace: string, key: string): Promise<boolean> {
    const name = requireName(namespace, 'namespace')
    const id = requireName(key, 'key')
    const storageKey = docKey(name, id)
    return this.exclusive(async () => {
      const record = await this.readDoc(name, id)
      if (record === undefined || record.d === undefined) return false
      await this.storage.put(storageKey, { v: record.v + 1 })
      return true
    })
  }

  async list(namespace: string, prefix?: string): Promise<string[]> {
    requireName(namespace, 'namespace')
    const entries = await this.storage.list({ prefix: docPrefixOf(namespace) })
    const keys: string[] = []
    for (const [storageKey, raw] of entries) {
      const parsed = parseDocStorageKey(storageKey)
      if (parsed === undefined) continue
      const [ns, key] = parsed
      if (ns !== namespace) continue
      const record = asRecord(raw)
      if (record === undefined || record.d === undefined) continue
      if (prefix !== undefined && !key.startsWith(prefix)) continue
      keys.push(key)
    }
    // Code-unit ordering of the RAW key, not the storage encoding (the
    // P0.2 portability note: remote stores may order encodings
    // differently; S6 keys stay ASCII regardless).
    return keys.sort()
  }

  async update<T extends JsonValue>(
    namespace: string,
    key: string,
    mutate: UpdateCallback<T>,
  ): Promise<T> {
    const storageKey = docKey(requireName(namespace, 'namespace'), requireName(key, 'key'))
    for (;;) {
      const record = asDocRecord(await this.readRecord(storageKey))
      const seenVersion = record?.v ?? 0
      const current = record?.d
      const next = await mutate(current === undefined ? undefined : (detached(current) as T))
      const accepted = acceptValue(next, 'update result')
      // The commit is the only part that needs exclusivity: verify the
      // version and write in one critical section, so a writer that
      // committed while the callback was pending is always detected.
      const committed = await this.exclusive(async () => {
        const currentVersion = versionOf(await this.readRecord(storageKey))
        if (currentVersion !== seenVersion) return false
        await this.storage.put(storageKey, { v: seenVersion + 1, d: accepted })
        return true
      })
      if (committed) return detached(accepted) as T
      // The record moved while the callback ran; run the callback again
      // against the newer document.
    }
  }

  async enqueue(queue: string, payload: JsonValue): Promise<string> {
    const accepted = acceptValue(payload, 'payload')
    const storageKey = queueKey(requireName(queue, 'queue'))
    const id = crypto.randomUUID()
    await this.exclusive(async () => {
      const record = await this.readQueue(storageKey)
      const seenVersion = record?.v ?? 0
      const items = [...(record?.items ?? [])]
      items.push({ id, payload: accepted, state: 'available', token: undefined, leaseExpiresAt: undefined })
      await this.storage.put(storageKey, { v: seenVersion + 1, items })
    })
    return id
  }

  async claim(queue: string, leaseMs: number): Promise<QueueClaim | undefined> {
    const storageKey = queueKey(requireName(queue, 'queue'))
    if (typeof leaseMs !== 'number' || !Number.isFinite(leaseMs) || leaseMs <= 0) {
      throw new CpaError('invalid-input', 'lease duration must be a positive number of milliseconds')
    }
    return this.exclusive(async () => {
      const record = await this.readQueue(storageKey)
      const seenVersion = record?.v ?? 0
      const items = (record?.items ?? []).map((item) => ({ ...item }))
      const now = this.now()
      let changed = false
      // Lazy lease reclamation: lapsed leases return to the pool only
      // once someone asks for work again.
      for (const item of items) {
        if (item.state === 'leased' && item.leaseExpiresAt !== undefined && item.leaseExpiresAt <= now) {
          item.state = 'available'
          item.token = undefined
          item.leaseExpiresAt = undefined
          changed = true
        }
      }
      let leased: QueueItemRecord | undefined
      for (const item of items) {
        if (item.state !== 'available') continue
        item.state = 'leased'
        item.token = crypto.randomUUID()
        item.leaseExpiresAt = now + leaseMs
        leased = item
        changed = true
        break
      }
      if (!changed) return undefined
      await this.storage.put(storageKey, { v: seenVersion + 1, items })
      if (leased === undefined) return undefined
      return Object.freeze({
        id: leased.id,
        token: leased.token ?? '',
        payload: detached(leased.payload),
        leaseExpiresAt: leased.leaseExpiresAt ?? now + leaseMs,
      }) satisfies QueueClaim
    })
  }

  async ack(queue: string, claim: ClaimHandle): Promise<boolean> {
    const storageKey = queueKey(requireName(queue, 'queue'))
    requireHandle(claim)
    return this.exclusive(async () => {
      const record = await this.readQueue(storageKey)
      if (record === undefined) return false
      const item = record.items.find((entry) => entry.id === claim.id)
      if (item === undefined || item.state !== 'leased' || item.token !== claim.token) return false
      const items = record.items.filter((entry) => entry.id !== claim.id)
      await this.storage.put(storageKey, { v: record.v + 1, items })
      return true
    })
  }

  async release(queue: string, claim: ClaimHandle): Promise<boolean> {
    const storageKey = queueKey(requireName(queue, 'queue'))
    requireHandle(claim)
    return this.exclusive(async () => {
      const record = await this.readQueue(storageKey)
      if (record === undefined) return false
      const item = record.items.find((entry) => entry.id === claim.id)
      if (item === undefined || item.state !== 'leased' || item.token !== claim.token) return false
      const items = record.items.map((entry): QueueItemRecord =>
        entry.id === claim.id
          ? { ...entry, state: 'available', token: undefined, leaseExpiresAt: undefined }
          : { ...entry },
      )
      await this.storage.put(storageKey, { v: record.v + 1, items })
      return true
    })
  }

  async ringAppend(ring: string, entry: JsonValue, capacity: number = DEFAULT_RING_CAPACITY): Promise<void> {
    const storageKey = ringKey(requireName(ring, 'ring'))
    if (typeof capacity !== 'number' || !Number.isInteger(capacity) || capacity <= 0) {
      throw new CpaError('invalid-input', 'ring capacity must be a positive whole number')
    }
    const accepted = acceptValue(entry, 'entry')
    await this.exclusive(async () => {
      const record = await this.readRing(storageKey)
      const seenVersion = record?.v ?? 0
      const entries = [...(record?.e ?? []), accepted]
      // The most recent append decides the capacity; shrinking trims
      // immediately, oldest first.
      const trimmed = entries.length > capacity ? entries.slice(entries.length - capacity) : entries
      await this.storage.put(storageKey, { v: seenVersion + 1, e: trimmed })
    })
  }

  async ringRead(ring: string, maxEntries?: number): Promise<JsonValue[]> {
    requireName(ring, 'ring')
    if (
      maxEntries !== undefined &&
      (typeof maxEntries !== 'number' || !Number.isInteger(maxEntries) || maxEntries < 0)
    ) {
      throw new CpaError('invalid-input', 'entry count must be a non-negative whole number')
    }
    const record = await this.readRecord(ringKey(ring))
    const entries = asRingRecord(record)?.e ?? []
    const limit = maxEntries === undefined ? entries.length : Math.min(maxEntries, entries.length)
    if (limit <= 0) return []
    return entries.slice(entries.length - limit).map((entry) => detached(entry))
  }

  // ---- primitives -------------------------------------------------------

  /** Reads one document record (undefined when absent). */
  private async readDoc(namespace: string, key: string): Promise<DocRecord | undefined> {
    return asDocRecord(await this.readRecord(docKey(namespace, key)))
  }

  private async readQueue(storageKey: string): Promise<QueueRecord | undefined> {
    return asQueueRecord(await this.readRecord(storageKey))
  }

  private async readRing(storageKey: string): Promise<RingRecord | undefined> {
    return asRingRecord(await this.readRecord(storageKey))
  }

  private async readRecord(storageKey: string): Promise<unknown> {
    return this.storage.get(storageKey)
  }

}

// ---------------------------------------------------------------------------
// Validation + shaping helpers (contract parity with the core store)
// ---------------------------------------------------------------------------

function requireName(value: string, label: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new CpaError('invalid-input', `${label} must be a non-empty string`)
  }
  return value
}

function requireHandle(claim: ClaimHandle): void {
  // Shape-check before field access: a missing handle must fail as
  // invalid-input, never as a dereference error.
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

/** Validates genuine-JSON data and returns a detached copy of it. */
function acceptValue(value: JsonValue, label: string): JsonValue {
  if (!isJsonValue(value)) {
    throw new CpaError('invalid-input', `${label} must be JSON-encodable data`, { field: label })
  }
  try {
    return structuredClone(value)
  } catch (error) {
    // Exotics that slip past the guard still surface as invalid-input;
    // stack exhaustion keeps its raw RangeError (documented guard
    // behavior in the core contract).
    if (error instanceof RangeError) throw error
    throw new CpaError('invalid-input', `${label} must be JSON-encodable data`, { field: label })
  }
}

function detached(value: JsonValue): JsonValue {
  try {
    return structuredClone(value)
  } catch (error) {
    if (!(error instanceof RangeError)) throw error
    // Storage reads hand back freshly deserialized objects, so the only
    // clone failure left is hostile nesting; the raw RangeError is the
    // documented guard behavior.
    return value
  }
}

/** Version of an unknown record view; absent records read as 0. */
function versionOf(raw: unknown): number {
  const record = asRecord(raw)
  const v = record?.['v']
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0
}

/** Narrows a storage record to a plain object view. */
function asRecord(raw: unknown): { [key: string]: unknown } | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  return raw as { [key: string]: unknown }
}

function asDocRecord(raw: unknown): DocRecord | undefined {
  const record = asRecord(raw)
  if (record === undefined) return undefined
  const v = record['v']
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) return undefined
  const d = record['d']
  if (d !== undefined && !isJsonValue(d)) return undefined
  return { v, ...(d === undefined ? {} : { d }) }
}

function asQueueRecord(raw: unknown): QueueRecord | undefined {
  const record = asRecord(raw)
  if (record === undefined) return undefined
  const v = record['v']
  const rawItems = record['items']
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || !Array.isArray(rawItems)) {
    return undefined
  }
  const items: QueueItemRecord[] = []
  for (const rawItem of rawItems) {
    const item = asRecord(rawItem)
    if (item === undefined) continue
    const id = item['id']
    const state = item['state']
    const token = item['token']
    const lease = item['leaseExpiresAt']
    if (typeof id !== 'string' || (state !== 'available' && state !== 'leased')) continue
    if (!('payload' in item)) continue
    if (token !== undefined && typeof token !== 'string') continue
    if (lease !== undefined && typeof lease !== 'number') continue
    items.push({
      id,
      payload: item['payload'] as JsonValue,
      state,
      token: token === undefined ? undefined : token,
      leaseExpiresAt: lease === undefined ? undefined : lease,
    })
  }
  return { v, items }
}

function asRingRecord(raw: unknown): RingRecord | undefined {
  const record = asRecord(raw)
  if (record === undefined) return undefined
  const v = record['v']
  const entries = record['e']
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || !Array.isArray(entries)) {
    return undefined
  }
  const out: JsonValue[] = []
  for (const entry of entries) {
    if (isJsonValue(entry)) out.push(entry)
  }
  return { v, e: out }
}

/** Store adapter factory bridging a DO storage surface to the core seam. */
export function createDurableObjectStore(storage: DoStorageLike, options?: DurableObjectStoreOptions): DurableObjectStore {
  return new DurableObjectStore(storage, options)
}
