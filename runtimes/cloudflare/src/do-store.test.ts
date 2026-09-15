/**
 * Store-contract tests for the Durable Object Store (mission T2, R6):
 * the @cpa-edge/core Store semantics exercised over the simulated DO
 * storage, using the same patterns as the memory store's own suite -
 * CAS retry under competing writers, queue lease lazy expiry, ring
 * overwrite - plus the DO-specific guarantees (versioned tombstones
 * fence stale writers, every mutation is a compare-and-swap).
 */
import { describe, expect, it } from 'vitest'
import { CpaError, DEFAULT_RING_CAPACITY, type ClaimHandle, type QueueClaim, type Store } from '@cpa-edge/core'
import { DurableObjectStore } from './do-store'
import { makeClock, SimulatedDoStorage } from './harness'

function newStore(storage: SimulatedDoStorage, now?: () => number): DurableObjectStore {
  return new DurableObjectStore(storage, now === undefined ? {} : { now })
}

function mustClaim(claim: QueueClaim | undefined): QueueClaim {
  if (claim === undefined) throw new Error('expected a claim, got none')
  return claim
}

describe('durable object store: documents', () => {
  it('round-trips values and reads absent keys as undefined', async () => {
    const store = newStore(new SimulatedDoStorage())
    await store.put('config', 'effective', { 'ws-auth': true })
    await expect(store.get('config', 'effective')).resolves.toEqual({ 'ws-auth': true })
    await expect(store.get('config', 'missing')).resolves.toBeUndefined()
  })

  it('stores JSON-null values distinctly from absent keys', async () => {
    const store = newStore(new SimulatedDoStorage())
    await store.put('ns', 'k', null)
    await expect(store.get('ns', 'k')).resolves.toBeNull()
    await expect(store.get('ns', 'other')).resolves.toBeUndefined()
  })

  it('delivers detached copies: mutation after read or write never reaches storage', async () => {
    const store = newStore(new SimulatedDoStorage())
    const value = { items: [1] }
    await store.put('ns', 'k', value)
    value.items.push(2)
    await expect(store.get('ns', 'k')).resolves.toEqual({ items: [1] })
    const read = await store.get('ns', 'k')
    if (typeof read === 'object' && read !== null) {
      ;(read as Record<string, unknown>)['items'] = 'tampered'
    }
    await expect(store.get('ns', 'k')).resolves.toEqual({ items: [1] })
  })

  it('rejects non-JSON values with invalid-input', async () => {
    const store = newStore(new SimulatedDoStorage())
    const bad = { fn: () => 1 } as unknown as never
    await expect(store.put('ns', 'k', bad)).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(store.put('', 'k', 1)).rejects.toBeInstanceOf(CpaError)
    await expect(store.put('ns', '', 1)).rejects.toBeInstanceOf(CpaError)
    await expect(store.get('', 'k')).rejects.toBeInstanceOf(CpaError)
  })

  it('delete reports presence and reads as absent afterwards', async () => {
    const store = newStore(new SimulatedDoStorage())
    await store.put('ns', 'k', 1)
    await expect(store.delete('ns', 'k')).resolves.toBe(true)
    await expect(store.delete('ns', 'k')).resolves.toBe(false)
    await expect(store.get('ns', 'k')).resolves.toBeUndefined()
  })

  it('lists namespace keys ascending by code unit, with optional prefix', async () => {
    const store = newStore(new SimulatedDoStorage())
    await store.put('ns', 'b', 1)
    await store.put('ns', 'a', 2)
    await store.put('ns', 'a-2', 3)
    await store.put('ns', 'B', 4)
    await store.put('other', 'a', 5)
    await store.delete('ns', 'b')
    await expect(store.list('ns')).resolves.toEqual(['B', 'a', 'a-2'])
    await expect(store.list('ns', 'a')).resolves.toEqual(['a', 'a-2'])
    await expect(store.list('empty')).resolves.toEqual([])
  })

  it('keeps names with special characters collision-free across namespaces', async () => {
    const store = newStore(new SimulatedDoStorage())
    // ["ns","a"] vs ["ns","a-b"] etc. must never collide in storage keys.
    await store.put('ns', 'a', 1)
    await store.put('ns', 'a-b', 2)
    await store.put('ns"a', 'a', 3)
    await store.put('ns', 'a"b', 4)
    await expect(store.get('ns', 'a')).resolves.toBe(1)
    await expect(store.get('ns', 'a-b')).resolves.toBe(2)
    await expect(store.get('ns"a', 'a')).resolves.toBe(3)
    await expect(store.get('ns', 'a"b')).resolves.toBe(4)
    await expect(store.list('ns')).resolves.toEqual(['a', 'a"b', 'a-b'])
  })

  it('re-runs the update callback when a competing writer commits first', async () => {
    const store = newStore(new SimulatedDoStorage())
    await store.put('ns', 'k', { count: 0 })
    let releaseGate!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    let calls = 0
    const slow = store.update<{ count: number }>('ns', 'k', async (current) => {
      calls += 1
      if (calls === 1) await gate
      return { count: (current?.count ?? 0) + 1 }
    })
    const fast = store.update<{ count: number }>('ns', 'k', (current) => ({
      count: (current?.count ?? 0) + 1,
    }))
    await fast
    await expect(store.get('ns', 'k')).resolves.toEqual({ count: 1 })
    releaseGate()
    await expect(slow).resolves.toEqual({ count: 2 })
    expect(calls).toBe(2)
  })

  it('keeps every change when 50 writers interleave', async () => {
    const store = newStore(new SimulatedDoStorage())
    await store.put('ns', 'counter', 0)
    let calls = 0
    const writes = Array.from({ length: 50 }, () =>
      store.update<number>('ns', 'counter', async (current) => {
        calls += 1
        await Promise.resolve()
        return (current ?? 0) + 1
      }),
    )
    const committed = await Promise.all(writes)
    expect([...committed].sort((a, b) => a - b)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1))
    await expect(store.get('ns', 'counter')).resolves.toBe(50)
    expect(calls).toBeGreaterThanOrEqual(99)
  })

  it('propagates callback failures without changing the value', async () => {
    const store = newStore(new SimulatedDoStorage())
    await store.put('ns', 'k', { count: 5 })
    await expect(
      store.update('ns', 'k', () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    await expect(store.get('ns', 'k')).resolves.toEqual({ count: 5 })
  })

  it('update on an absent key starts from undefined', async () => {
    const store = newStore(new SimulatedDoStorage())
    await expect(store.update('ns', 'k', (current) => ({ seeded: current === undefined }))).resolves.toEqual({
      seeded: true,
    })
  })

  it('a tombstone fences a stale writer: update re-runs against undefined after a delete', async () => {
    const store = newStore(new SimulatedDoStorage())
    await store.put('ns', 'k', { v: 1 })
    let calls = 0
    let releaseGate!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    const slow = store.update<{ v: number }>('ns', 'k', async (current) => {
      calls += 1
      if (calls === 1) await gate
      return { v: (current?.v ?? 0) + 1 }
    })
    await store.delete('ns', 'k')
    releaseGate()
    // The slow writer re-ran against the tombstone (undefined) and
    // committed AFTER the delete - the same semantics the memory store
    // documents for a delete racing an update.
    await expect(slow).resolves.toEqual({ v: 1 })
    expect(calls).toBe(2)
  })

  it('a stale writer cannot commit over a delete-and-recreate sequence (no ABA)', async () => {
    const store = newStore(new SimulatedDoStorage())
    await store.put('ns', 'k', 'first')
    let releaseGate!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    let calls = 0
    const slow = store.update('ns', 'k', async (current) => {
      calls += 1
      if (calls === 1) await gate
      return `writer-saw-${String(current)}`
    })
    // While the slow writer holds its v1 snapshot: delete, then
    // recreate the key. Versions never repeat, so the stale commit must
    // fail and re-run against the recreated value.
    await store.delete('ns', 'k')
    await store.put('ns', 'k', 'recreated')
    releaseGate()
    await expect(slow).resolves.toBe('writer-saw-recreated')
    expect(calls).toBe(2)
    await expect(store.get('ns', 'k')).resolves.toBe('writer-saw-recreated')
  })

  it('concurrent puts both land: last writer wins, versions stay monotonic', async () => {
    const storage = new SimulatedDoStorage()
    const store = newStore(storage)
    const first = store.put('ns', 'k', 'first')
    const second = store.put('ns', 'k', 'second')
    await Promise.all([first, second])
    await expect(store.get('ns', 'k')).resolves.toBe('second')
    // Both writes committed: the CAS machinery ran twice for one key.
    expect(storage.puts.filter((key) => key.startsWith('d:'))).toHaveLength(2)
  })
})

describe('durable object store: queues', () => {
  it('delivers items in enqueue order', async () => {
    const store = newStore(new SimulatedDoStorage())
    await store.enqueue('usage', 'first')
    await store.enqueue('usage', 'second')
    await store.enqueue('usage', 'third')
    const first = mustClaim(await store.claim('usage', 60_000))
    const second = mustClaim(await store.claim('usage', 60_000))
    const third = mustClaim(await store.claim('usage', 60_000))
    expect([first.payload, second.payload, third.payload]).toEqual(['first', 'second', 'third'])
  })

  it('claims nothing from empty or unknown queues', async () => {
    const store = newStore(new SimulatedDoStorage())
    await expect(store.claim('nope', 60_000)).resolves.toBeUndefined()
    await store.enqueue('usage', 'only')
    const taken = mustClaim(await store.claim('usage', 60_000))
    expect(taken.payload).toBe('only')
    await expect(store.claim('usage', 60_000)).resolves.toBeUndefined()
  })

  it('keeps queues independent of documents and rings', async () => {
    const store = newStore(new SimulatedDoStorage())
    await store.put('usage', 'stored', 1)
    await store.ringAppend('usage', 'ring-entry')
    await store.enqueue('usage', 'queued')
    await expect(store.list('usage')).resolves.toEqual(['stored'])
    const taken = mustClaim(await store.claim('usage', 60_000))
    expect(taken.payload).toBe('queued')
    await expect(store.ringRead('usage')).resolves.toEqual(['ring-entry'])
  })

  it('hands lapsed leases back on the next claim with a fresh token', async () => {
    const tick = makeClock(1_000)
    const store = newStore(new SimulatedDoStorage(), tick.now)
    const itemId = await store.enqueue('usage', 'job')
    const first = mustClaim(await store.claim('usage', 100))
    expect(first.id).toBe(itemId)
    expect(first.leaseExpiresAt).toBe(1_100)
    await expect(store.claim('usage', 100)).resolves.toBeUndefined()
    tick.advance(100)
    const second = mustClaim(await store.claim('usage', 100))
    expect(second.id).toBe(itemId)
    expect(second.token).not.toBe(first.token)
    expect(second.leaseExpiresAt).toBe(1_200)
  })

  it('rejects stale handles after a takeover', async () => {
    const tick = makeClock(0)
    const store = newStore(new SimulatedDoStorage(), tick.now)
    await store.enqueue('usage', 'job')
    const first = mustClaim(await store.claim('usage', 10))
    tick.advance(10)
    const second = mustClaim(await store.claim('usage', 10))
    await expect(store.ack('usage', first)).resolves.toBe(false)
    await expect(store.release('usage', first)).resolves.toBe(false)
    await expect(store.ack('usage', second)).resolves.toBe(true)
    await expect(store.claim('usage', 10)).resolves.toBeUndefined()
  })

  it('accepts a late ack while nobody else has claimed', async () => {
    const tick = makeClock(0)
    const store = newStore(new SimulatedDoStorage(), tick.now)
    await store.enqueue('usage', 'job')
    const taken = mustClaim(await store.claim('usage', 10))
    tick.advance(5_000)
    await expect(store.ack('usage', taken)).resolves.toBe(true)
    await expect(store.claim('usage', 10)).resolves.toBeUndefined()
  })

  it('returns released items to the pool at their original position', async () => {
    const store = newStore(new SimulatedDoStorage())
    await store.enqueue('usage', 'a')
    await store.enqueue('usage', 'b')
    const taken = mustClaim(await store.claim('usage', 60_000))
    expect(taken.payload).toBe('a')
    await expect(store.release('usage', taken)).resolves.toBe(true)
    const again = mustClaim(await store.claim('usage', 60_000))
    expect(again.payload).toBe('a')
    expect(again.token).not.toBe(taken.token)
    await expect(store.ack('usage', taken)).resolves.toBe(false)
    const second = mustClaim(await store.claim('usage', 60_000))
    expect(second.payload).toBe('b')
    await expect(store.claim('usage', 60_000)).resolves.toBeUndefined()
  })

  it('validates lease durations and handle shapes', async () => {
    const store = newStore(new SimulatedDoStorage())
    await expect(store.claim('usage', 0)).rejects.toBeInstanceOf(CpaError)
    await expect(store.claim('usage', Number.NaN)).rejects.toBeInstanceOf(CpaError)
    await expect(store.claim('', 1_000)).rejects.toBeInstanceOf(CpaError)
    await expect(store.ack('usage', {} as unknown as ClaimHandle)).rejects.toBeInstanceOf(CpaError)
    await expect(store.ack('usage', { id: 'x', token: '' } as unknown as ClaimHandle)).rejects.toBeInstanceOf(
      CpaError,
    )
    await expect(store.enqueue('', 1)).rejects.toBeInstanceOf(CpaError)
    await expect(store.enqueue('usage', undefined as never)).rejects.toBeInstanceOf(CpaError)
  })

  it('supports concurrent claims without double-leasing an item', async () => {
    const store = newStore(new SimulatedDoStorage())
    await store.enqueue('usage', 'one')
    await store.enqueue('usage', 'two')
    const claims = await Promise.all([store.claim('usage', 60_000), store.claim('usage', 60_000)])
    const payloads = claims.map((claim) => claim?.payload).sort()
    expect(payloads).toEqual(['one', 'two'])
    await expect(store.claim('usage', 60_000)).resolves.toBeUndefined()
  })
})

describe('durable object store: rings', () => {
  it('appends and reads back oldest-first within capacity', async () => {
    const store = newStore(new SimulatedDoStorage())
    for (let index = 1; index <= DEFAULT_RING_CAPACITY + 5; index++) {
      await store.ringAppend('logs', { line: `line-${index}` })
    }
    const entries = await store.ringRead('logs')
    expect(entries).toHaveLength(DEFAULT_RING_CAPACITY)
    expect(entries[0]).toEqual({ line: 'line-6' })
    expect(entries[entries.length - 1]).toEqual({ line: `line-${DEFAULT_RING_CAPACITY + 5}` })
  })

  it('shrinks immediately when a smaller capacity arrives', async () => {
    const store = newStore(new SimulatedDoStorage())
    for (let index = 1; index <= 10; index++) {
      await store.ringAppend('logs', index)
    }
    await store.ringAppend('logs', 11, 3)
    await expect(store.ringRead('logs')).resolves.toEqual([9, 10, 11])
  })

  it('reads the last N entries and validates the limit', async () => {
    const store = newStore(new SimulatedDoStorage())
    for (let index = 1; index <= 6; index++) {
      await store.ringAppend('logs', index)
    }
    await expect(store.ringRead('logs', 2)).resolves.toEqual([5, 6])
    await expect(store.ringRead('logs', 0)).resolves.toEqual([])
    await expect(store.ringRead('unknown')).resolves.toEqual([])
    await expect(store.ringAppend('logs', 1, 0)).rejects.toBeInstanceOf(CpaError)
    await expect(store.ringRead('logs', -1)).rejects.toBeInstanceOf(CpaError)
    await expect(store.ringAppend('', 1)).rejects.toBeInstanceOf(CpaError)
  })

  it('delivers detached ring copies', async () => {
    const store = newStore(new SimulatedDoStorage())
    await store.ringAppend('logs', { deep: { value: 1 } })
    const entries = await store.ringRead('logs')
    if (typeof entries[0] === 'object' && entries[0] !== null) {
      ;((entries[0] as Record<string, unknown>)['deep'] as Record<string, unknown>)['value'] = 99
    }
    await expect(store.ringRead('logs')).resolves.toEqual([{ deep: { value: 1 } }])
  })
})

describe('durable object store: satisfies the core Store interface structurally', () => {
  it('is assignable to the interface and behaves through it', async () => {
    const store: Store = newStore(new SimulatedDoStorage())
    await store.put('ns', 'k', 'v')
    await expect(store.get('ns', 'k')).resolves.toBe('v')
    await expect(store.list('ns')).resolves.toEqual(['k'])
    await expect(store.delete('ns', 'k')).resolves.toBe(true)
  })
})
