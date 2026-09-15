/**
 * Key-value driver seam for the Vercel runtime store (S7 vercel column).
 *
 * The store in `kv-store.ts` speaks this narrow driver interface; two
 * implementations exist:
 *
 * - `RestKvDriver` - a Redis-compatible REST client (the Vercel KV /
 *   Upstash wire protocol: one HTTPS POST per command, bearer token,
 *   `{"result": ...}` replies). Production deployments configure it from
 *   `KV_REST_API_URL` + `KV_REST_API_TOKEN`; the platform runs the
 *   Redis-compatible service, this runtime never embeds one.
 * - `InMemoryKvDriver` - the same command semantics over local maps; the
 *   unit tests run the full Store contract against it and use its
 *   operation hook to simulate competing writers.
 *
 * Atomicity notes (documented substrate facts, S7 §2.3-F5b style):
 *
 * - Document writes carry an internal monotonic version. `writeDocument`
 *   is a single conditional command on the remote side, so
 *   read-then-conditionally-write loops behave like real CAS: a lost
 *   race is reported as `false` and the caller retries.
 * - Queue mutations (enqueue, claim, settle) and ring appends are single
 *   conditional/atomic commands as well; the driver never composes a
 *   multi-command transaction.
 * - Reads may be stale when the Redis-compatible service fronts an
 *   asynchronous replica; the store layer treats every read as advisory
 *   and re-reads after any failed conditional write.
 */

import { CpaError } from '@cpa-edge/core'

/** Stored document: the driver-internal version plus the JSON value text. */
export interface KvDocument {
  /** Monotonic per-key version; never reused for the same key. */
  readonly version: number
  /** Stored value as serialized JSON. */
  readonly value: string
}

/** Conditional-write expectation for {@link KvDriver.writeDocument}. */
export type DocumentExpectation =
  /** Commit regardless of the current version (last writer wins). */
  | { readonly kind: 'any' }
  /** Commit only when no document exists (first write after a delete). */
  | { readonly kind: 'absent' }
  /** Commit only over the exact observed version (optimistic CAS). */
  | { readonly kind: 'version'; readonly version: number }

/** Outcome of an atomic oldest-item claim. */
export interface KvClaimedItem {
  /** Item id as issued by `enqueueItem`. */
  readonly id: string
  /** Stored item JSON (the queue record, not the payload). */
  readonly item: string
  /** Lease deadline in epoch milliseconds. */
  readonly leaseExpiresAt: number
}

/**
 * The full command surface the KV store needs. Implementations must keep
 * every operation atomic on the remote side (single command or single
 * server-side script) and must surface transport failures as exceptions -
 * never as silent misses.
 */
export interface KvDriver {
  /** Reads one document; `null` when the key holds nothing. */
  readDocument(key: string): Promise<KvDocument | null>
  /**
   * Writes one document under the given expectation and reports whether
   * the write committed. The stored version always advances by one on
   * commit, so a successful CAS can never resurrect an older state.
   */
  writeDocument(
    key: string,
    value: string,
    expectation: DocumentExpectation,
  ): Promise<boolean>
  /** Removes one document; `false` when the key was already absent. */
  deleteDocument(key: string): Promise<boolean>
  /**
   * Lists every key sharing the literal `prefix`. Implementations must
   * tolerate cursor-based iteration internally; duplicates must not be
   * returned twice in one call.
   */
  scanKeys(prefix: string): Promise<string[]>
  /**
   * Appends one queue item record and resolves with the new item id.
   * Ids never repeat for the same queue.
   */
  enqueueItem(queueKey: string, item: string): Promise<string>
  /**
   * Atomically claims the oldest item whose state is available or whose
   * lease expired at or before `nowMs`. A claimed item keeps its queue
   * position and receives the given fresh lease token.
   */
  claimOldest(
    queueKey: string,
    nowMs: number,
    leaseMs: number,
    token: string,
  ): Promise<KvClaimedItem | null>
  /**
   * Acknowledges or releases a claimed item, but only while the given
   * token still owns the lease. `false` means the handle went stale.
   */
  settleClaim(
    queueKey: string,
    id: string,
    token: string,
    action: 'ack' | 'release',
  ): Promise<boolean>
  /** Appends one ring entry and trims the window to `capacity`, oldest first out. */
  ringAppend(ringKey: string, entry: string, capacity: number): Promise<void>
  /** Reads ring entries, oldest first; `max === 'all'` reads the whole window. */
  ringRead(ringKey: string, max: number | 'all'): Promise<string[]>
}

// ---------------------------------------------------------------------------
// REST driver (Redis-compatible KV over HTTPS)
// ---------------------------------------------------------------------------

/** Transport seam for tests; mirrors the Web Standard `fetch` subset used. */
export type KvFetch = (
  url: string,
  init: { readonly method: string; readonly headers: Record<string, string>; readonly body: string },
) => Promise<{ readonly status: number; readonly text: () => Promise<string> }>

/** Constructor options of {@link RestKvDriver}. */
export interface RestKvDriverOptions {
  /** Base URL of the Redis-compatible REST endpoint (`KV_REST_API_URL`). */
  readonly url: string
  /** Bearer token (`KV_REST_API_TOKEN`). */
  readonly token: string
  /** Injectable transport; defaults to the global `fetch`. */
  readonly fetch?: KvFetch
}

/**
 * Redis-compatible REST driver. Every mutating operation below maps to a
 * single command (plain or server-side script), which is what makes the
 * optimistic CAS in the store layer sound: the remote side serializes
 * commands per key.
 */
export class RestKvDriver implements KvDriver {
  private readonly options: RestKvDriverOptions

  constructor(options: RestKvDriverOptions) {
    if (typeof options.url !== 'string' || options.url === '') {
      throw new CpaError('invalid-input', 'KV REST URL must be a non-empty string')
    }
    if (typeof options.token !== 'string' || options.token === '') {
      throw new CpaError('invalid-input', 'KV REST token must be a non-empty string')
    }
    this.options = options
  }

  private async run(args: readonly string[]): Promise<unknown> {
    const transport: KvFetch =
      this.options.fetch ??
      ((url: string, init: { method: string; headers: Record<string, string>; body: string }) =>
        fetch(url, init))
    let response: { readonly status: number; readonly text: () => Promise<string> }
    try {
      response = await transport(this.options.url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.options.token}` },
        body: JSON.stringify(args),
      })
    } catch (error) {
      throw new CpaError('unavailable', 'KV transport failed', {
        cause: String(error),
      })
    }
    if (response.status !== 200) {
      throw new CpaError('unavailable', `KV endpoint answered ${response.status}`)
    }
    let payload: unknown
    try {
      payload = JSON.parse(await response.text())
    } catch (error) {
      throw new CpaError('unavailable', 'KV reply was not JSON', { cause: String(error) })
    }
    if (typeof payload !== 'object' || payload === null || !('result' in payload)) {
      throw new CpaError('unavailable', 'KV reply missing the result field')
    }
    return (payload as { result: unknown }).result
  }

  async readDocument(key: string): Promise<KvDocument | null> {
    const result = await this.run(['GET', key])
    if (result === null || result === undefined) return null
    if (typeof result !== 'string') {
      throw new CpaError('unavailable', 'KV document reply was not a string')
    }
    const envelope = parseEnvelope(result)
    return { version: envelope.v, value: envelope.value }
  }

  async writeDocument(
    key: string,
    value: string,
    expectation: DocumentExpectation,
  ): Promise<boolean> {
    const expected =
      expectation.kind === 'any' ? '*' : expectation.kind === 'absent' ? '-' : String(expectation.version)
    const result = await this.run([WRITE_SCRIPT, '1', key, expected, value])
    return result === 1 || result === 'OK'
  }

  async deleteDocument(key: string): Promise<boolean> {
    const result = await this.run(['DEL', key])
    return Number(result) > 0
  }

  async scanKeys(prefix: string): Promise<string[]> {
    const seen = new Set<string>()
    let cursor = '0'
    // Bounded cursor walk; a fresh cursor means the scan restarted and
    // everything relevant has been observed already.
    let guard = 0
    do {
      const page = await this.run(['SCAN', cursor, 'MATCH', `${globEscape(prefix)}*`, 'COUNT', '500'])
      if (!Array.isArray(page) || page.length !== 2) {
        throw new CpaError('unavailable', 'KV scan reply had an unexpected shape')
      }
      const [next, keys] = page as [unknown, unknown]
      if (typeof next !== 'string' && typeof next !== 'number') {
        throw new CpaError('unavailable', 'KV scan cursor had an unexpected shape')
      }
      cursor = String(next)
      if (!Array.isArray(keys)) {
        throw new CpaError('unavailable', 'KV scan keys had an unexpected shape')
      }
      for (const key of keys) {
        if (typeof key === 'string') seen.add(key)
      }
      guard += 1
    } while (cursor !== '0' && guard < 64)
    return [...seen]
  }

  async enqueueItem(queueKey: string, item: string): Promise<string> {
    const result = await this.run([ENQUEUE_SCRIPT, '1', queueKey, item])
    if (typeof result !== 'string') {
      throw new CpaError('unavailable', 'KV enqueue reply had an unexpected shape')
    }
    return result
  }

  async claimOldest(
    queueKey: string,
    nowMs: number,
    leaseMs: number,
    token: string,
  ): Promise<KvClaimedItem | null> {
    const result = await this.run([
      CLAIM_SCRIPT,
      '1',
      queueKey,
      String(Math.trunc(nowMs)),
      String(Math.trunc(leaseMs)),
      token,
    ])
    if (result === null || result === undefined) return null
    if (!Array.isArray(result) || result.length !== 3) {
      throw new CpaError('unavailable', 'KV claim reply had an unexpected shape')
    }
    const [id, item, expires] = result as [unknown, unknown, unknown]
    if (typeof id !== 'string' || typeof item !== 'string') {
      throw new CpaError('unavailable', 'KV claim reply had an unexpected shape')
    }
    return { id, item, leaseExpiresAt: Number(expires) }
  }

  async settleClaim(
    queueKey: string,
    id: string,
    token: string,
    action: 'ack' | 'release',
  ): Promise<boolean> {
    const result = await this.run([SETTLE_SCRIPT, '1', queueKey, id, token, action])
    return Number(result) === 1
  }

  async ringAppend(ringKey: string, entry: string, capacity: number): Promise<void> {
    await this.run([RING_APPEND_SCRIPT, '1', ringKey, entry, String(capacity)])
  }

  async ringRead(ringKey: string, max: number | 'all'): Promise<string[]> {
    const args =
      max === 'all' ? ['LRANGE', ringKey, '0', '-1'] : ['LRANGE', ringKey, String(-max), '-1']
    const result = await this.run(args)
    if (!Array.isArray(result)) {
      throw new CpaError('unavailable', 'KV ring reply had an unexpected shape')
    }
    const out: string[] = []
    for (const entry of result) {
      if (typeof entry !== 'string') {
        throw new CpaError('unavailable', 'KV ring entry was not a string')
      }
      out.push(entry)
    }
    return out
  }
}

/** Document envelope persisted by the REST driver: `{v, value}`. */
interface StoredEnvelope {
  readonly v: number
  readonly value: string
}

function parseEnvelope(text: string): StoredEnvelope {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new CpaError('unavailable', 'KV document envelope was not valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CpaError('unavailable', 'KV document envelope had an unexpected shape')
  }
  const record = parsed as { [key: string]: unknown }
  if (typeof record['v'] !== 'number' || typeof record['value'] !== 'string') {
    throw new CpaError('unavailable', 'KV document envelope was missing fields')
  }
  return { v: record['v'], value: record['value'] }
}

/** Escapes the glob metacharacters a MATCH pattern would otherwise honor. */
function globEscape(prefix: string): string {
  return prefix.replace(/([*?\[\]])/g, (match) => `\${match}`)
}

/**
 * Server-side write script. ARGV[1] encodes the expectation ('*' any,
 * '-' absent, else the exact version); ARGV[2] is the value JSON. The
 * stored version always moves to `current + 1`.
 */
const WRITE_SCRIPT = [
  'local cur = redis.call("GET", KEYS[1])',
  'local ver = 0',
  'if cur then',
  '  local env = cjson.decode(cur)',
  '  ver = tonumber(env["v"]) or 0',
  '  if ARGV[1] == "-" then return 0 end',
  '  if ARGV[1] ~= "*" and ver ~= tonumber(ARGV[1]) then return 0 end',
  'else',
  '  if ARGV[1] ~= "-" and ARGV[1] ~= "*" then return 0 end',
  'end',
  'redis.call("SET", KEYS[1], cjson.encode({v = ver + 1, value = ARGV[2]}))',
  'return 1',
].join('\n')

/**
 * Server-side enqueue: one hash per queue; field `seq` is the id counter,
 * field `i<n>` the item record. Atomic, so ids are gapless per queue.
 */
const ENQUEUE_SCRIPT = [
  'local n = redis.call("HINCRBY", KEYS[1], "seq", 1)',
  'local id = "i" .. n',
  'redis.call("HSET", KEYS[1], id, ARGV[1])',
  'return id',
].join('\n')

/**
 * Server-side claim: walks ids oldest-first inside one atomic command,
 * reclaims lapsed leases on the way, and re-leases the first eligible
 * item with the caller-supplied token. `seq` bounds the walk; the scan
 * cost is the documented degraded semantics of this substrate.
 */
const CLAIM_SCRIPT = [
  'local seq = tonumber(redis.call("HGET", KEYS[1], "seq") or "0")',
  'local now = tonumber(ARGV[1])',
  'local lease = tonumber(ARGV[2])',
  'for i = 1, seq do',
  '  local id = "i" .. i',
  '  local raw = redis.call("HGET", KEYS[1], id)',
  '  if raw then',
  '    local item = cjson.decode(raw)',
  '    local state = item["s"]',
  '    local expires = tonumber(item["e"]) or 0',
  '    if state == "a" or (state == "l" and expires <= now) then',
  '      local next = {p = item["p"], s = "l", t = ARGV[3], e = now + lease}',
  '      redis.call("HSET", KEYS[1], id, cjson.encode(next))',
  '      return {id, cjson.encode(next), tostring(now + lease)}',
  '    end',
  '  end',
  'end',
  'return nil',
].join('\n')

/**
 * Server-side settle: ack removes the item, release returns it to the
 * available pool with its original position. Both refuse stale tokens.
 */
const SETTLE_SCRIPT = [
  'local raw = redis.call("HGET", KEYS[1], ARGV[1])',
  'if not raw then return 0 end',
  'local item = cjson.decode(raw)',
  'if item["s"] ~= "l" or item["t"] ~= ARGV[2] then return 0 end',
  'if ARGV[3] == "ack" then',
  '  redis.call("HDEL", KEYS[1], ARGV[1])',
  '  return 1',
  'end',
  'local next = {p = item["p"], s = "a", t = "", e = 0}',
  'redis.call("HSET", KEYS[1], ARGV[1], cjson.encode(next))',
  'return 1',
].join('\n')

/** Server-side ring append: push then trim to capacity in one command. */
const RING_APPEND_SCRIPT = [
  'redis.call("RPUSH", KEYS[1], ARGV[1])',
  'redis.call("LTRIM", KEYS[1], -tonumber(ARGV[2]), -1)',
  'return 1',
].join('\n')

// ---------------------------------------------------------------------------
// In-memory driver (tests, local dev)
// ---------------------------------------------------------------------------

/** Hook fired before each driver operation; tests inject contention here. */
export type DriverHook = (operation: string) => Promise<void> | void

/** Constructor options of {@link InMemoryKvDriver}. */
export interface InMemoryKvDriverOptions {
  /** Optional per-operation hook, e.g. to inject a competing writer. */
  readonly hook?: DriverHook
  /** Optional failure injection: named operations reject once when armed. */
  readonly failingOperations?: readonly string[]
}

/**
 * Local implementation of the driver command semantics. Behavior mirrors
 * the REST driver exactly, including the version envelope, so the Store
 * contract tests exercise the real code paths.
 */
export class InMemoryKvDriver implements KvDriver {
  private readonly documents = new Map<string, { version: number; value: string }>()
  private readonly queues = new Map<string, { seq: number; items: Map<string, string> }>()
  private readonly rings = new Map<string, string[]>()
  private readonly hook: DriverHook | undefined
  private readonly failing: readonly string[]

  constructor(options: InMemoryKvDriverOptions = {}) {
    this.hook = options.hook
    this.failing = options.failingOperations ?? []
  }

  private async gate(operation: string): Promise<void> {
    if (this.failing.includes(operation)) {
      throw new CpaError('unavailable', `injected failure during ${operation}`)
    }
    await this.hook?.(operation)
  }

  async readDocument(key: string): Promise<KvDocument | null> {
    await this.gate('readDocument')
    const found = this.documents.get(key)
    return found === undefined ? null : { version: found.version, value: found.value }
  }

  async writeDocument(
    key: string,
    value: string,
    expectation: DocumentExpectation,
  ): Promise<boolean> {
    await this.gate('writeDocument')
    const current = this.documents.get(key)
    if (current !== undefined) {
      if (expectation.kind === 'absent') return false
      if (expectation.kind === 'version' && expectation.version !== current.version) return false
      this.documents.set(key, { version: current.version + 1, value })
      return true
    }
    if (expectation.kind === 'version') return false
    this.documents.set(key, { version: 1, value })
    return true
  }

  async deleteDocument(key: string): Promise<boolean> {
    await this.gate('deleteDocument')
    return this.documents.delete(key)
  }

  async scanKeys(prefix: string): Promise<string[]> {
    await this.gate('scanKeys')
    const out: string[] = []
    for (const key of this.documents.keys()) {
      if (key.startsWith(prefix)) out.push(key)
    }
    return out
  }

  private queue(queueKey: string): { seq: number; items: Map<string, string> } {
    let found = this.queues.get(queueKey)
    if (found === undefined) {
      found = { seq: 0, items: new Map<string, string>() }
      this.queues.set(queueKey, found)
    }
    return found
  }

  async enqueueItem(queueKey: string, item: string): Promise<string> {
    await this.gate('enqueueItem')
    const queue = this.queue(queueKey)
    queue.seq += 1
    const id = `i${queue.seq}`
    queue.items.set(id, item)
    return id
  }

  async claimOldest(
    queueKey: string,
    nowMs: number,
    leaseMs: number,
    token: string,
  ): Promise<KvClaimedItem | null> {
    await this.gate('claimOldest')
    const queue = this.queue(queueKey)
    for (const [id, raw] of queue.items) {
      const item = parseItem(raw)
      if (item.state === 'available' || (item.state === 'leased' && item.leaseExpiresAt <= nowMs)) {
        const leaseExpiresAt = nowMs + leaseMs
        const next = serializeItem({ payload: item.payload, state: 'leased', token, leaseExpiresAt })
        queue.items.set(id, next)
        return { id, item: next, leaseExpiresAt }
      }
    }
    return null
  }

  async settleClaim(
    queueKey: string,
    id: string,
    token: string,
    action: 'ack' | 'release',
  ): Promise<boolean> {
    await this.gate('settleClaim')
    const queue = this.queue(queueKey)
    const raw = queue.items.get(id)
    if (raw === undefined) return false
    const item = parseItem(raw)
    if (item.state !== 'leased' || item.token !== token) return false
    if (action === 'ack') {
      queue.items.delete(id)
      return true
    }
    queue.items.set(
      id,
      serializeItem({ payload: item.payload, state: 'available', token: '', leaseExpiresAt: 0 }),
    )
    return true
  }

  async ringAppend(ringKey: string, entry: string, capacity: number): Promise<void> {
    await this.gate('ringAppend')
    let ring = this.rings.get(ringKey)
    if (ring === undefined) {
      ring = []
      this.rings.set(ringKey, ring)
    }
    ring.push(entry)
    if (ring.length > capacity) ring.splice(0, ring.length - capacity)
  }

  async ringRead(ringKey: string, max: number | 'all'): Promise<string[]> {
    await this.gate('ringRead')
    const ring = this.rings.get(ringKey)
    if (ring === undefined) return []
    const count = max === 'all' ? ring.length : Math.min(max, ring.length)
    return ring.slice(ring.length - count)
  }
}

/** Queue item record stored by both drivers. */
export interface QueueItemRecord {
  readonly payload: string
  readonly state: 'available' | 'leased'
  readonly token: string
  readonly leaseExpiresAt: number
}

function serializeItem(record: QueueItemRecord): string {
  // Short state codes match the store's enqueue encoding and the REST
  // driver's server-side scripts ('a' available, 'l' leased).
  return JSON.stringify({
    p: record.payload,
    s: record.state === 'leased' ? 'l' : 'a',
    t: record.token,
    e: record.leaseExpiresAt,
  })
}

function parseItem(text: string): QueueItemRecord {
  const parsed: unknown = JSON.parse(text)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CpaError('unavailable', 'queue item record had an unexpected shape')
  }
  const record = parsed as { [key: string]: unknown }
  if (typeof record['p'] !== 'string' || typeof record['s'] !== 'string') {
    throw new CpaError('unavailable', 'queue item record was missing fields')
  }
  return {
    payload: record['p'],
    state: record['s'] === 'l' ? 'leased' : 'available',
    token: typeof record['t'] === 'string' ? record['t'] : '',
    leaseExpiresAt: typeof record['e'] === 'number' ? record['e'] : 0,
  }
}
