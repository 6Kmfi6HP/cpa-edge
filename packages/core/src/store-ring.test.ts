import { describe, expect, it } from 'vitest'
import { MemoryStore } from './store-memory'
import { DEFAULT_RING_CAPACITY } from './store'
import type { JsonValue } from './store'

describe('memory ring buffer', () => {
  it('keeps only the most recent entries within capacity', async () => {
    const store = new MemoryStore()
    for (let i = 1; i <= 5; i += 1) {
      await store.ringAppend('logs', { seq: i }, 3)
    }
    await expect(store.ringRead('logs')).resolves.toEqual([{ seq: 3 }, { seq: 4 }, { seq: 5 }])
  })

  it('reads the newest window oldest-first', async () => {
    const store = new MemoryStore()
    for (let i = 1; i <= 5; i += 1) {
      await store.ringAppend('logs', { seq: i }, 10)
    }
    await expect(store.ringRead('logs', 2)).resolves.toEqual([{ seq: 4 }, { seq: 5 }])
  })

  it('honours a zero entry limit', async () => {
    const store = new MemoryStore()
    await store.ringAppend('logs', { seq: 1 }, 3)
    await expect(store.ringRead('logs', 0)).resolves.toEqual([])
  })

  it('trims immediately when the capacity shrinks', async () => {
    const store = new MemoryStore()
    for (let i = 1; i <= 3; i += 1) {
      await store.ringAppend('logs', { seq: i }, 3)
    }
    await store.ringAppend('logs', { seq: 4 }, 2)
    await expect(store.ringRead('logs')).resolves.toEqual([{ seq: 3 }, { seq: 4 }])
  })

  it('applies the default capacity when none is given', async () => {
    const store = new MemoryStore()
    for (let i = 0; i <= DEFAULT_RING_CAPACITY; i += 1) {
      await store.ringAppend('logs', i)
    }
    const window = await store.ringRead('logs')
    expect(window).toHaveLength(DEFAULT_RING_CAPACITY)
    expect(window[0]).toBe(1)
    expect(window[window.length - 1]).toBe(DEFAULT_RING_CAPACITY)
  })

  it('reads unknown rings as empty', async () => {
    const store = new MemoryStore()
    await expect(store.ringRead('nope')).resolves.toEqual([])
    await expect(store.ringRead('nope', 5)).resolves.toEqual([])
  })

  it('detaches appended and read entries', async () => {
    const store = new MemoryStore()
    const entry = { level: 'info' }
    await store.ringAppend('logs', entry, 3)
    entry.level = 'tampered'
    await expect(store.ringRead('logs')).resolves.toEqual([{ level: 'info' }])
    const read = await store.ringRead('logs')
    const record = read[0] as Record<string, unknown>
    record['level'] = 'scribble'
    await expect(store.ringRead('logs')).resolves.toEqual([{ level: 'info' }])
  })

  it('rejects invalid names, capacities, limits and payloads', async () => {
    const store = new MemoryStore()
    await expect(store.ringAppend('logs', {}, 0)).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(store.ringAppend('logs', {}, -1)).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(store.ringAppend('logs', {}, 1.5)).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(store.ringAppend('', {}, 3)).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(store.ringRead('logs', -1)).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(store.ringRead('logs', 1.5)).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(store.ringRead('')).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(
      store.ringAppend('logs', (() => 1) as unknown as JsonValue, 3),
    ).rejects.toMatchObject({ code: 'invalid-input' })
  })
})
