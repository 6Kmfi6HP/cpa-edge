/**
 * KV Store contract tests (mission R5): the external-KV adapter against
 * the core Store contract, with the CAS and degradation semantics the
 * S7 vercel column pins:
 *
 * - update() is an optimistic CAS loop: a competing writer between the
 *   read and the conditional write must make the callback re-run
 *   against the newer document, and concurrent updaters must never
 *   lose an increment;
 * - queue leases are reclaimed lazily by the next claim (no background
 *   timers exist on this substrate - the documented degraded
 *   semantics), takeovers hand out fresh tokens, and stale handles
 *   read as false;
 * - rings trim on append (the sweep rides request traffic).
 */

import { describe, expect, it } from 'vitest'
import { CpaError, DEFAULT_RING_CAPACITY, type Store } from '@cpa-edge/core'
import { InMemoryKvDriver } from './kv-driver'
import { KvStore } from './kv-store'

function makeClock(startAt: number): { now: () => number; advance: (ms: number) => void } {
  let current = startAt
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms
    },
  }
}

function mustClaim<T>(claim: T | undefined): T {
  if (claim === undefined) throw new Error('expected a claim, got none')
  return claim
}

function newStore(clock?: { now: () => number }): KvStore {
  return new KvStore({ driver: new InMemoryKvDriver(), ...(clock === undefined ? {} : { now: clock.now }) })
}

describe('kv store: documents', () => {
  it('round-trips values and reads absences as undefined', async () => {
    const store = newStore()
    await expect(store.get('config', 'effective')).resolves.toBeUndefined()
    await store.put('config', 'effective', { port: 8317, on: true })
    await expect(store.get('config', 'effective')).resolves.toEqual({ port: 8317, on: true })
    await expect(store.delete('config', 'effective')).resolves.toBe(true)
    await expect(store.delete('config', 'effective')).resolves.toBe(false)
    await expect(store.get('config', 'effective')).resolves.toBeUndefined()
  })

  it('delivers detached copies: mutation after write or read never leaks', async () => {
    const store = newStore()
    const shared: number[] = [1, 2, 3]
    await store.put('ns', 'k', { list: shared })
    shared.push(4)
    await expect(store.get('ns', 'k')).resolves.toEqual({ list: [1, 2, 3] })
    const read = (await store.get('ns', 'k')) as { list: number[] }
    read.list.push(99)
    await expect(store.get('ns', 'k')).resolves.toEqual({ list: [1, 2, 3] })
  })

  it('rejects non-JSON values and bad names with invalid-input', async () => {
    const store = newStore()
    const circular: Record<string, unknown> = {}
    circular['self'] = circular
    await expect(store.put('ns', 'k', circular as never)).rejects.toMatchObject({
      code: 'invalid-input',
    })
    await expect(store.put('', 'k', 1)).rejects.toBeInstanceOf(CpaError)
    await expect(store.put('ns', '', 1)).rejects.toBeInstanceOf(CpaError)
    await expect(store.get('ns', '')).rejects.toMatchObject({ code: 'invalid-input' })
  })

  it('lists keys ascending by code unit, prefix-scoped, namespaces separate', async () => {
    const store = newStore()
    await store.put('ns', 'b', 1)
    await store.put('ns', 'a', 1)
    await store.put('ns', 'aa', 1)
    await store.put('other', 'z', 1)
    await expect(store.list('ns')).resolves.toEqual(['a', 'aa', 'b'])
    await expect(store.list('ns', 'a')).resolves.toEqual(['a', 'aa'])
    await expect(store.list('absent')).resolves.toEqual([])
  })

  it('keeps namespaces with separator-like names distinct under prefix scans', async () => {
    const store = newStore()
    await store.put('a', 'b', 1)
    await store.put('a:b', 'c', 2)
    await expect(store.list('a')).resolves.toEqual(['b'])
    await expect(store.list('a:b')).resolves.toEqual(['c'])
  })

  it('preserves keys holding glob metacharacters through the scan', async () => {
    const store = newStore()
    await store.put('ns', 'wild*card', 1)
    await store.put('ns', 'plain', 2)
    await expect(store.list('ns')).resolves.toEqual(['plain', 'wild*card'])
    await expect(store.get('ns', 'wild*card')).resolves.toBe(1)
  })
})

describe('kv store: optimistic CAS updates', () => {
  it('runs the callback again when a competing writer commits mid-flight', async () => {
    let armed = false
    let hookRuns = 0
    const driver = new InMemoryKvDriver({
      hook: async (operation) => {
        if (operation !== 'writeDocument' || !armed) return
        hookRuns += 1
        if (hookRuns === 1) {
          // The store read version 1; slip a competing write in before
          // its conditional write lands.
          await driver.writeDocument('cpa-edge:d:ns:k', '"competing"', { kind: 'any' })
        }
      },
    })
    const store = new KvStore({ driver })
    await store.put('ns', 'k', 'base')
    armed = true
    let callbackRuns = 0
    const committed = await store.update<string>('ns', 'k', (current) => {
      callbackRuns += 1
      return `${current as string}-mine`
    })
    expect(callbackRuns).toBe(2)
    expect(committed).toBe('competing-mine')
    await expect(store.get('ns', 'k')).resolves.toBe('competing-mine')
  })

  it('never loses concurrent increments (no silent lost updates)', async () => {
    const store = newStore()
    await store.put('counters', 'hits', 0)
    const updates: Array<Promise<number>> = []
    for (let round = 0; round < 8; round += 1) {
      updates.push(store.update<number>('counters', 'hits', (current) => (current ?? 0) + 1))
    }
    await Promise.all(updates)
    await expect(store.get('counters', 'hits')).resolves.toBe(8)
  })

  it('treats an update of an absent key as create-once (CAS on absence)', async () => {
    const store = newStore()
    const committed = await store.update<number>('ns', 'fresh', () => 42)
    expect(committed).toBe(42)
  })

  it('rejects an update over a document deleted mid-flight and re-runs against the delete', async () => {
    let armed = false
    let hookRuns = 0
    let sawAbsent = false
    const driver = new InMemoryKvDriver({
      hook: async (operation) => {
        if (operation !== 'writeDocument' || !armed) return
        hookRuns += 1
        if (hookRuns === 1) {
          await driver.deleteDocument('cpa-edge:d:ns:k')
        }
      },
    })
    const store = new KvStore({ driver })
    await store.put('ns', 'k', 'base')
    armed = true
    const committed = await store.update('ns', 'k', (current) => {
      if (current === undefined) sawAbsent = true
      return 'recreated'
    })
    expect(sawAbsent).toBe(true)
    expect(committed).toBe('recreated')
  })

  it('rejects non-JSON update results and surfaces callback errors unchanged', async () => {
    const store = newStore()
    await store.put('ns', 'k', 1)
    const circular: Record<string, unknown> = {}
    circular['self'] = circular
    await expect(
      store.update('ns', 'k', () => circular as never),
    ).rejects.toMatchObject({ code: 'invalid-input' })
    class Boom extends Error {}
    await expect(store.update('ns', 'k', () => { throw new Boom('stop') })).rejects.toBeInstanceOf(Boom)
    await expect(store.get('ns', 'k')).resolves.toBe(1)
  })
})

describe('kv store: queue (degraded, lease-lazy semantics)', () => {
  it('delivers items in enqueue order', async () => {
    const store = newStore()
    await store.enqueue('usage', 'first')
    await store.enqueue('usage', 'second')
    await store.enqueue('usage', 'third')
    const ids = [
      mustClaim(await store.claim('usage', 60_000)),
      mustClaim(await store.claim('usage', 60_000)),
      mustClaim(await store.claim('usage', 60_000)),
    ]
    expect(ids.map((claim) => claim.payload)).toEqual(['first', 'second', 'third'])
  })

  it('claims nothing from empty or unknown queues and validates the lease duration', async () => {
    const store = newStore()
    await expect(store.claim('nope', 60_000)).resolves.toBeUndefined()
    await store.enqueue('usage', 'only')
    const taken = mustClaim(await store.claim('usage', 60_000))
    expect(taken.payload).toBe('only')
    await expect(store.claim('usage', 60_000)).resolves.toBeUndefined()
    await expect(store.claim('usage', 0)).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(store.claim('usage', Number.NaN)).rejects.toMatchObject({ code: 'invalid-input' })
  })

  it('keeps queues independent of documents and rings sharing a name', async () => {
    const store: Store = newStore()
    await store.put('usage', 'stored', 1)
    await store.ringAppend('usage', 'ring-entry')
    await store.enqueue('usage', 'queued')
    await expect(store.list('usage')).resolves.toEqual(['stored'])
    expect(mustClaim(await store.claim('usage', 60_000)).payload).toBe('queued')
    await expect(store.ringRead('usage')).resolves.toEqual(['ring-entry'])
  })

  it('reclaims lapsed leases lazily on the next claim, with a fresh token', async () => {
    const tick = makeClock(1_000)
    const store = newStore(tick)
    const itemId = await store.enqueue('usage', 'job')
    const first = mustClaim(await store.claim('usage', 100))
    expect(first.id).toBe(itemId)
    expect(first.leaseExpiresAt).toBe(1_100)
    // Degraded semantics: nothing runs in the background. The lapsed
    // item stays invisible until the next claim call reclaims it.
    await expect(store.claim('usage', 100)).resolves.toBeUndefined()
    tick.advance(100)
    const second = mustClaim(await store.claim('usage', 100))
    expect(second.id).toBe(itemId)
    expect(second.token).not.toBe(first.token)
    expect(second.leaseExpiresAt).toBe(1_200)
  })

  it('rejects stale handles after a takeover and keeps release positions', async () => {
    const tick = makeClock(0)
    const store = newStore(tick)
    await store.enqueue('usage', 'first')
    await store.enqueue('usage', 'second')
    const first = mustClaim(await store.claim('usage', 10))
    tick.advance(10)
    const second = mustClaim(await store.claim('usage', 10))
    expect(second.id).toBe(first.id)
    await expect(store.ack('usage', first)).resolves.toBe(false)
    await expect(store.release('usage', first)).resolves.toBe(false)
    // Release returns the item to the pool at its ORIGINAL position.
    await expect(store.release('usage', second)).resolves.toBe(true)
    const reclaimed = mustClaim(await store.claim('usage', 10))
    expect(reclaimed.id).toBe(first.id)
    expect(reclaimed.payload).toBe('first')
    await expect(store.ack('usage', reclaimed)).resolves.toBe(true)
    const tail = mustClaim(await store.claim('usage', 10))
    expect(tail.payload).toBe('second')
  })

  it('validates claim handles before touching the driver', async () => {
    const store = newStore()
    await store.enqueue('usage', 'job')
    await expect(store.ack('usage', null as never)).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(
      store.ack('usage', { id: '', token: '' }),
    ).rejects.toMatchObject({ code: 'invalid-input' })
  })

  it('delivers detached queue payloads', async () => {
    const store = newStore()
    const payload = { list: [1] }
    await store.enqueue('usage', payload)
    payload.list.push(2)
    const taken = mustClaim(await store.claim('usage', 60_000))
    expect(taken.payload).toEqual({ list: [1] })
  })
})

describe('kv store: rings (trim rides append traffic)', () => {
  it('appends and reads the window oldest-first with capacity trims', async () => {
    const store = newStore()
    for (let index = 1; index <= 12; index += 1) {
      await store.ringAppend('logs', { n: index }, 10)
    }
    await expect(store.ringRead('logs')).resolves.toEqual([
      { n: 3 },
      { n: 4 },
      { n: 5 },
      { n: 6 },
      { n: 7 },
      { n: 8 },
      { n: 9 },
      { n: 10 },
      { n: 11 },
      { n: 12 },
    ])
    await expect(store.ringRead('logs', 2)).resolves.toEqual([{ n: 11 }, { n: 12 }])
    await expect(store.ringRead('absent')).resolves.toEqual([])
  })

  it('applies the default capacity and shrinks immediately', async () => {
    const store = newStore()
    for (let index = 0; index < DEFAULT_RING_CAPACITY + 5; index += 1) {
      await store.ringAppend('window', index)
    }
    const full = await store.ringRead('window')
    expect(full).toHaveLength(DEFAULT_RING_CAPACITY)
    expect(full[0]).toBe(5)
    await store.ringAppend('window', 'cap-3', 3)
    await expect(store.ringRead('window')).resolves.toEqual([1003, 1004, 'cap-3'])
    await expect(store.ringRead('window', 1)).resolves.toEqual(['cap-3'])
    await expect(store.ringRead('window', 0)).resolves.toEqual([])
  })

  it('validates capacity and entry inputs', async () => {
    const store = newStore()
    await expect(store.ringAppend('r', 1, 0)).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(store.ringAppend('r', 1, 1.5)).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(store.ringRead('r', -1)).rejects.toMatchObject({ code: 'invalid-input' })
    const circular: Record<string, unknown> = {}
    circular['self'] = circular
    await expect(store.ringAppend('r', circular as never)).rejects.toMatchObject({
      code: 'invalid-input',
    })
  })
})

describe('kv store: driver transport failures', () => {
  it('surfaces unavailable on REST failures instead of silent misses', async () => {
    const driver = new InMemoryKvDriver({ failingOperations: ['readDocument'] })
    const store = new KvStore({ driver })
    await expect(store.get('ns', 'k')).rejects.toMatchObject({ code: 'unavailable' })
  })
})
