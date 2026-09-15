import { describe, expect, it } from 'vitest'
import { MemoryStore } from './store-memory'
import type { ClaimHandle, JsonValue, QueueClaim } from './store'

/** Deterministic clock: lease arithmetic without sleeping or fake timers. */
function makeClock(startAt: number): { now: () => number; advance: (ms: number) => void } {
  let current = startAt
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms
    },
  }
}

function mustClaim(claim: QueueClaim | undefined): QueueClaim {
  if (claim === undefined) throw new Error('expected a claim, got none')
  return claim
}

describe('memory queue', () => {
  it('delivers items in enqueue order', async () => {
    const store = new MemoryStore()
    await store.enqueue('usage', 'first')
    await store.enqueue('usage', 'second')
    await store.enqueue('usage', 'third')
    const first = mustClaim(await store.claim('usage', 60_000))
    const second = mustClaim(await store.claim('usage', 60_000))
    const third = mustClaim(await store.claim('usage', 60_000))
    expect([first.payload, second.payload, third.payload]).toEqual(['first', 'second', 'third'])
  })

  it('claims nothing from empty or unknown queues', async () => {
    const store = new MemoryStore()
    await expect(store.claim('nope', 60_000)).resolves.toBeUndefined()
    await store.enqueue('usage', 'only')
    const taken = mustClaim(await store.claim('usage', 60_000))
    expect(taken.payload).toBe('only')
    await expect(store.claim('usage', 60_000)).resolves.toBeUndefined()
  })

  it('keeps queues independent of documents and rings', async () => {
    const store = new MemoryStore()
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
    const store = new MemoryStore({ now: tick.now })
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
    const store = new MemoryStore({ now: tick.now })
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
    const store = new MemoryStore({ now: tick.now })
    await store.enqueue('usage', 'job')
    const taken = mustClaim(await store.claim('usage', 10))
    tick.advance(5_000)
    await expect(store.ack('usage', taken)).resolves.toBe(true)
    await expect(store.claim('usage', 10)).resolves.toBeUndefined()
  })

  it('returns released items to the pool at their original position', async () => {
    const store = new MemoryStore()
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

  it('drops acknowledged items', async () => {
    const store = new MemoryStore()
    await store.enqueue('usage', 'a')
    await store.enqueue('usage', 'b')
    const taken = mustClaim(await store.claim('usage', 60_000))
    await expect(store.ack('usage', taken)).resolves.toBe(true)
    await expect(store.ack('usage', taken)).resolves.toBe(false)
    const next = mustClaim(await store.claim('usage', 60_000))
    expect(next.payload).toBe('b')
  })

  it('returns false for well-formed but unknown handles', async () => {
    const store = new MemoryStore()
    await expect(store.ack('usage', { id: 'ghost', token: 'none' })).resolves.toBe(false)
    await expect(store.release('usage', { id: 'ghost', token: 'none' })).resolves.toBe(false)
    await expect(store.ack('missing-queue', { id: 'ghost', token: 'none' })).resolves.toBe(false)
  })

  it('rejects malformed handles, names, leases and payloads', async () => {
    const store = new MemoryStore()
    await expect(store.claim('usage', 0)).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(store.claim('usage', -1)).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(store.claim('usage', Number.POSITIVE_INFINITY)).rejects.toMatchObject({
      code: 'invalid-input',
    })
    await expect(store.claim('', 10)).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(store.ack('usage', { id: '', token: 'x' })).rejects.toMatchObject({
      code: 'invalid-input',
    })
    await expect(store.ack('usage', { id: 'x', token: '' })).rejects.toMatchObject({
      code: 'invalid-input',
    })
    await expect(store.enqueue('', 'x')).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(
      store.enqueue('usage', (() => 1) as unknown as JsonValue),
    ).rejects.toMatchObject({ code: 'invalid-input' })
  })

  it('rejects missing claim handles as invalid-input', async () => {
    const store = new MemoryStore()
    await expect(store.ack('usage', undefined as unknown as ClaimHandle)).rejects.toMatchObject({
      code: 'invalid-input',
    })
    await expect(store.ack('usage', null as unknown as ClaimHandle)).rejects.toMatchObject({
      code: 'invalid-input',
    })
    await expect(store.release('usage', undefined as unknown as ClaimHandle)).rejects.toMatchObject({
      code: 'invalid-input',
    })
    await expect(store.release('usage', null as unknown as ClaimHandle)).rejects.toMatchObject({
      code: 'invalid-input',
    })
  })

  it('detaches payloads from queue internals in both directions', async () => {
    const tick = makeClock(0)
    const store = new MemoryStore({ now: tick.now })
    const payload = { amount: 1 }
    await store.enqueue('usage', payload)
    payload.amount = 2
    const taken = mustClaim(await store.claim('usage', 10))
    expect(taken.payload).toEqual({ amount: 1 })
    const record = taken.payload as Record<string, unknown>
    record['amount'] = 99
    tick.advance(10)
    const redelivered = mustClaim(await store.claim('usage', 10))
    expect(redelivered.payload).toEqual({ amount: 1 })
  })
})
