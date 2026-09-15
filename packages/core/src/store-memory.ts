import { CpaError } from './errors'
import { DEFAULT_RING_CAPACITY, isJsonValue } from './store'
import type { ClaimHandle, JsonValue, QueueClaim, Store, UpdateCallback } from './store'

/** Construction options for {@link MemoryStore}. */
export interface MemoryStoreOptions {
  /**
   * Clock used for lease arithmetic, in epoch milliseconds. Tests inject a
   * fixed clock for deterministic expiry behaviour; the default is
   * `Date.now`.
   */
  readonly now?: () => number
}

/** Stored document: the value plus a version that never repeats per key. */
interface StoredDocument {
  value: JsonValue | undefined
  version: number
}

/** Lifecycle state of one queue item. */
type ItemState = 'available' | 'leased'

/** One queued item; map iteration order mirrors enqueue order. */
interface QueueItem {
  readonly id: string
  readonly payload: JsonValue
  state: ItemState
  token: string | undefined
  leaseExpiresAt: number | undefined
}

/** Bookkeeping for one queue. */
interface QueueContents {
  readonly items: Map<string, QueueItem>
}

/**
 * Store implementation that keeps all state in process memory.
 *
 * Concurrency guarantee: apart from `update` callbacks, every method applies
 * its state changes synchronously before returning, so callers that interleave
 * awaited operations on a single event loop can never observe half-finished
 * state. `update` callbacks may yield to the event loop by design; the method
 * compensates with optimistic version checks - when a competing writer
 * commits while a callback is pending, the callback is retried against the
 * newer document, so silent lost updates are impossible.
 *
 * Everything is per instance and per process: separate threads, isolates or
 * machines must share a remote implementation instead. Nothing is persisted;
 * discarding the instance discards the state.
 */
export class MemoryStore implements Store {
  private readonly documents = new Map<string, Map<string, StoredDocument>>()
  private readonly queues = new Map<string, QueueContents>()
  private readonly rings = new Map<string, JsonValue[]>()
  private readonly now: () => number

  constructor(options: MemoryStoreOptions = {}) {
    this.now = options.now ?? (() => Date.now())
  }

  async get(namespace: string, key: string): Promise<JsonValue | undefined> {
    const document = this.document(
      requireName(namespace, 'namespace'),
      requireName(key, 'key'),
    )
    const value = document?.value
    return value === undefined ? undefined : structuredClone(value)
  }

  async put(namespace: string, key: string, value: JsonValue): Promise<void> {
    const name = requireName(namespace, 'namespace')
    const id = requireName(key, 'key')
    this.writeDocument(name, id, this.accept(value, 'value'))
  }

  async delete(namespace: string, key: string): Promise<boolean> {
    const name = requireName(namespace, 'namespace')
    const id = requireName(key, 'key')
    const bucket = this.documents.get(name)
    if (bucket === undefined) return false
    const existing = bucket.get(id)
    // A tombstone from an earlier delete counts as absent.
    if (existing === undefined || existing.value === undefined) return false
    // Keep a tombstone with a fresh version so an update that read the old
    // value cannot commit over the delete.
    bucket.set(id, { value: undefined, version: existing.version + 1 })
    return true
  }

  async list(namespace: string, prefix?: string): Promise<string[]> {
    const bucket = this.documents.get(requireName(namespace, 'namespace'))
    if (bucket === undefined) return []
    const keys: string[] = []
    for (const [key, document] of bucket) {
      if (document.value !== undefined && (prefix === undefined || key.startsWith(prefix))) {
        keys.push(key)
      }
    }
    return keys.sort()
  }

  async update<T extends JsonValue>(
    namespace: string,
    key: string,
    mutate: UpdateCallback<T>,
  ): Promise<T> {
    const name = requireName(namespace, 'namespace')
    const id = requireName(key, 'key')
    for (;;) {
      const before = this.document(name, id)
      const seenVersion = before?.version ?? 0
      const current = before?.value
      const next = await mutate(current === undefined ? undefined : (structuredClone(current) as T))
      const accepted = this.accept(next, 'update result')
      const latest = this.document(name, id)
      if ((latest?.version ?? 0) === seenVersion) {
        this.writeDocument(name, id, accepted)
        // Resolve with a private copy: callers must never reach the stored
        // document through the value this promise delivers.
        return structuredClone(accepted) as T
      }
      // A competing writer committed while the callback was pending; run
      // the callback again against the newer document.
    }
  }

  async enqueue(queue: string, payload: JsonValue): Promise<string> {
    const name = requireName(queue, 'queue')
    const itemPayload = this.accept(payload, 'payload')
    let contents = this.queues.get(name)
    if (contents === undefined) {
      contents = { items: new Map<string, QueueItem>() }
      this.queues.set(name, contents)
    }
    const id = crypto.randomUUID()
    contents.items.set(id, {
      id,
      payload: itemPayload,
      state: 'available',
      token: undefined,
      leaseExpiresAt: undefined,
    })
    return id
  }

  async claim(queue: string, leaseMs: number): Promise<QueueClaim | undefined> {
    const name = requireName(queue, 'queue')
    if (typeof leaseMs !== 'number' || !Number.isFinite(leaseMs) || leaseMs <= 0) {
      throw new CpaError('invalid-input', 'lease duration must be a positive number of milliseconds')
    }
    const contents = this.queues.get(name)
    if (contents === undefined) return undefined
    const now = this.now()
    // Lazy lease reclamation: lapsed leases return to the pool only once
    // someone asks for work again.
    for (const item of contents.items.values()) {
      if (
        item.state === 'leased' &&
        item.leaseExpiresAt !== undefined &&
        item.leaseExpiresAt <= now
      ) {
        item.state = 'available'
        item.token = undefined
        item.leaseExpiresAt = undefined
      }
    }
    for (const item of contents.items.values()) {
      if (item.state !== 'available') continue
      item.state = 'leased'
      const token = crypto.randomUUID()
      const leaseExpiresAt = now + leaseMs
      item.token = token
      item.leaseExpiresAt = leaseExpiresAt
      return Object.freeze({
        id: item.id,
        token,
        payload: structuredClone(item.payload),
        leaseExpiresAt,
      }) satisfies QueueClaim
    }
    return undefined
  }

  async ack(queue: string, claim: ClaimHandle): Promise<boolean> {
    const held = this.heldItem(queue, claim)
    if (held === undefined) return false
    // Finished work leaves the queue entirely.
    held.contents.items.delete(held.item.id)
    return true
  }

  async release(queue: string, claim: ClaimHandle): Promise<boolean> {
    const held = this.heldItem(queue, claim)
    if (held === undefined) return false
    held.item.state = 'available'
    held.item.token = undefined
    held.item.leaseExpiresAt = undefined
    return true
  }

  async ringAppend(ring: string, entry: JsonValue, capacity: number = DEFAULT_RING_CAPACITY): Promise<void> {
    const name = requireName(ring, 'ring')
    if (typeof capacity !== 'number' || !Number.isInteger(capacity) || capacity <= 0) {
      throw new CpaError('invalid-input', 'ring capacity must be a positive whole number')
    }
    const stored = this.accept(entry, 'entry')
    let entries = this.rings.get(name)
    if (entries === undefined) {
      entries = []
      this.rings.set(name, entries)
    }
    entries.push(stored)
    if (entries.length > capacity) entries.splice(0, entries.length - capacity)
  }

  async ringRead(ring: string, maxEntries?: number): Promise<JsonValue[]> {
    const name = requireName(ring, 'ring')
    if (
      maxEntries !== undefined &&
      (typeof maxEntries !== 'number' || !Number.isInteger(maxEntries) || maxEntries < 0)
    ) {
      throw new CpaError('invalid-input', 'entry count must be a non-negative whole number')
    }
    const entries = this.rings.get(name)
    if (entries === undefined || entries.length === 0) return []
    const limit = maxEntries === undefined ? entries.length : Math.min(maxEntries, entries.length)
    return entries.slice(entries.length - limit).map((entry) => structuredClone(entry))
  }

  /** Reads the record for one document without creating anything. */
  private document(namespace: string, key: string): StoredDocument | undefined {
    return this.documents.get(namespace)?.get(key)
  }

  /**
   * Validates that a value is genuine JSON and returns a detached copy of it.
   */
  private accept(value: JsonValue, label: string): JsonValue {
    if (!isJsonValue(value)) {
      throw new CpaError('invalid-input', `${label} must be JSON-encodable data`, { field: label })
    }
    try {
      return structuredClone(value)
    } catch (error) {
      // Exotics that slip past the guard - a proxy, a getter that turns
      // hostile on the second read - must still surface as invalid-input.
      // Stack exhaustion from pathologically deep values keeps its raw
      // RangeError, matching the documented guard behavior.
      if (error instanceof RangeError) throw error
      throw new CpaError('invalid-input', `${label} must be JSON-encodable data`, { field: label })
    }
  }

  /** Stores an already validated and detached value, bumping the key version. */
  private writeDocument(namespace: string, key: string, value: JsonValue): void {
    let bucket = this.documents.get(namespace)
    if (bucket === undefined) {
      bucket = new Map<string, StoredDocument>()
      this.documents.set(namespace, bucket)
    }
    const previous = bucket.get(key)
    bucket.set(key, { value, version: (previous?.version ?? 0) + 1 })
  }

  /**
   * Looks up the item a handle refers to, but only while that handle still
   * owns the item's lease.
   */
  private heldItem(queue: string, claim: ClaimHandle): { contents: QueueContents; item: QueueItem } | undefined {
    const contents = this.queues.get(requireName(queue, 'queue'))
    requireHandle(claim)
    if (contents === undefined) return undefined
    const item = contents.items.get(claim.id)
    if (item === undefined || item.state !== 'leased' || item.token !== claim.token) {
      return undefined
    }
    return { contents, item }
  }
}

function requireName(value: string, label: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new CpaError('invalid-input', `${label} must be a non-empty string`)
  }
  return value
}

function requireHandle(claim: ClaimHandle): void {
  // Shape-check before field access: a missing handle (null, undefined,
  // any non-object) must fail as invalid-input, never as a dereference error.
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
