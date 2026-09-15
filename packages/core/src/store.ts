/**
 * Storage contracts shared by every CPA-Edge package and runtime.
 *
 * The interface is intentionally schema-free: values are plain JSON and
 * callers layer their own document shapes on top. Three families of state are
 * covered because the rest of the platform maps onto them:
 *
 * - documents - namespaced key-value records (configuration, credentials,
 *   usage counters);
 * - queues - at-least-once work queues with lease-based claiming (usage
 *   flushing, retry batches);
 * - rings - bounded append-only windows (recent log entries).
 *
 * Names (namespaces, keys, queue names, ring names) are opaque non-empty
 * strings; implementations reject anything else with the `invalid-input`
 * error code. Values crossing this interface are detached copies: mutating a
 * value after writing it - or after reading it - never changes stored state.
 * All methods are asynchronous so remote implementations fit the same
 * contract.
 */

/** Scalar values a JSON document can hold. */
export type JsonPrimitive = string | number | boolean | null

/**
 * Any value that survives a JSON round-trip unchanged. Objects are described
 * through index signatures, so document shapes work best as type aliases
 * rather than interfaces (interfaces receive no implicit index signature).
 */
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue }

/**
 * Narrows unknown data to genuine JSON: rejects functions, symbols, bigints,
 * `undefined`, `NaN`, infinities, class instances and cyclic references.
 * Repeated references to the same object stay valid as long as no cycle forms.
 *
 * `-0` is accepted on purpose: in-memory stores preserve the sign, while
 * JSON-serializing backends normalize it to `0`, so callers must not rely
 * on telling the two apart. Nesting depth is likewise left unchecked: a
 * value deep enough to exhaust the runtime's recursion limits fails with a
 * raw `RangeError` rather than an `invalid-input` error.
 */
export function isJsonValue(value: unknown): value is JsonValue {
  return checkJson(value, new Set<object>())
}

function checkJson(value: unknown, ancestors: Set<object>): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object') return false
  const node: object = value
  if (ancestors.has(node)) return false
  ancestors.add(node)
  try {
    if (Array.isArray(node)) {
      // The iterator reports holes as `undefined`, which fails the check, so
      // the elements need their own pass.
      for (const element of node) {
        if (!checkJson(element, ancestors)) return false
      }
      // Arrays can carry named own properties beyond their elements; those
      // obey the same rules as object members. Object.values lists the
      // elements too, which merely re-checks them.
      for (const member of Object.values(node)) {
        if (!checkJson(member, ancestors)) return false
      }
      return true
    }
    const prototype = Object.getPrototypeOf(node)
    if (prototype !== Object.prototype && prototype !== null) return false
    const record = node as Record<string, unknown>
    for (const member of Object.values(record)) {
      if (!checkJson(member, ancestors)) return false
    }
    return true
  } finally {
    ancestors.delete(node)
  }
}

/**
 * Computes the next document state from the current one. The store may run
 * the callback several times when competing writers commit while it is
 * pending, so it must stay pure: derive the result from `current` alone and
 * avoid outside side effects. Throwing aborts the update and the error
 * reaches the caller unchanged.
 */
export type UpdateCallback<T> = (current: T | undefined) => T | Promise<T>

/** Proof that a caller owns a queue item: the item id plus its lease token. */
export interface ClaimHandle {
  /** Item identifier issued by `enqueue` and echoed by `claim`. */
  readonly id: string
  /** Lease token; only the current claimant of the item knows it. */
  readonly token: string
}

/** A claimed queue item, ready for a worker to process. */
export interface QueueClaim extends ClaimHandle {
  /** Enqueued payload, as a detached copy. */
  readonly payload: JsonValue
  /** Epoch milliseconds at or after which the lease may pass to another claimant. */
  readonly leaseExpiresAt: number
}

/** Ring capacity applied when an append does not state one. */
export const DEFAULT_RING_CAPACITY = 1_000

/**
 * Persistence surface of the platform. Runtimes provide implementations;
 * every other package consumes this interface only.
 */
export interface Store {
  /** Reads one document. Resolves `undefined` when the key holds no value. */
  get(namespace: string, key: string): Promise<JsonValue | undefined>

  /**
   * Writes one document unconditionally (last writer wins), replacing any
   * previous value. The value must be JSON-encodable; implementations reject
   * anything else with `invalid-input`.
   */
  put(namespace: string, key: string, value: JsonValue): Promise<void>

  /**
   * Removes one document. Resolves `true` when a value was deleted, `false`
   * when the key was already absent.
   */
  delete(namespace: string, key: string): Promise<boolean>

  /**
   * Lists the document keys of one namespace, ascending by code unit,
   * optionally limited to keys starting with `prefix`. Absent namespaces read
   * as empty.
   */
  list(namespace: string, prefix?: string): Promise<string[]>

  /**
   * Atomic read-modify-write of one document. The callback receives the
   * current value (`undefined` when absent) and returns the replacement.
   * When a competing writer commits while the callback is pending, the
   * callback is re-run against the newer value; the update finishes only once
   * its result is committed against the very value the callback last saw.
   * Concurrent writers therefore never discard each other's changes
   * silently, at the cost of the callback possibly running more than once.
   * Resolves with the committed value.
   */
  update<T extends JsonValue>(namespace: string, key: string, mutate: UpdateCallback<T>): Promise<T>

  /**
   * Appends work to a queue and resolves with the new item id. Queue names
   * are independent of document namespaces and ring names.
   */
  enqueue(queue: string, payload: JsonValue): Promise<string>

  /**
   * Takes the oldest available item under a lease lasting `leaseMs`
   * milliseconds. Lease expiry is evaluated lazily here: items whose lease
   * has lapsed become claimable again on the next `claim` call - there are no
   * background timers. A takeover hands the item a fresh token, which makes
   * the previous holder's handle stale. Resolves `undefined` when nothing is
   * available.
   */
  claim(queue: string, leaseMs: number): Promise<QueueClaim | undefined>

  /**
   * Marks a claimed item as done and removes it from the queue. Resolves
   * `false` when the handle is stale (someone else took the item over) or
   * unknown; a lapsed lease alone does not invalidate a claim - only a newer
   * claim does. Treat `false` as "this work may have been redelivered".
   */
  ack(queue: string, claim: ClaimHandle): Promise<boolean>

  /**
   * Returns a claimed item to the available pool immediately, keeping its
   * original enqueue position. Same staleness rules as `ack`.
   */
  release(queue: string, claim: ClaimHandle): Promise<boolean>

  /**
   * Appends an entry to a bounded ring and trims the window to `capacity`
   * entries, dropping the oldest first. The most recent append decides the
   * capacity; shrinking trims immediately.
   */
  ringAppend(ring: string, entry: JsonValue, capacity?: number): Promise<void>

  /**
   * Reads up to `maxEntries` of the most recent ring entries, oldest first.
   * Without a limit the whole window is returned. Unknown rings read as
   * empty.
   */
  ringRead(ring: string, maxEntries?: number): Promise<JsonValue[]>
}
