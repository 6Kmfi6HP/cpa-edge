import { describe, expect, it } from 'vitest'
import { MemoryStore } from './store-memory'
import type { JsonValue } from './store'

describe('memory documents', () => {
  it('stores and reads values per namespace', async () => {
    const store = new MemoryStore()
    await store.put('auth', 'primary', { token: 'abc' })
    await expect(store.get('auth', 'primary')).resolves.toEqual({ token: 'abc' })
  })

  it('reads absent keys as undefined', async () => {
    const store = new MemoryStore()
    await expect(store.get('auth', 'missing')).resolves.toBeUndefined()
  })

  it('separates namespaces and overwrites on put', async () => {
    const store = new MemoryStore()
    await store.put('a', 'k', 1)
    await store.put('b', 'k', 2)
    await expect(store.get('a', 'k')).resolves.toBe(1)
    await expect(store.get('b', 'k')).resolves.toBe(2)
    await store.put('a', 'k', 3)
    await expect(store.get('a', 'k')).resolves.toBe(3)
  })

  it('reports whether delete removed anything', async () => {
    const store = new MemoryStore()
    await store.put('ns', 'k', true)
    await expect(store.delete('ns', 'k')).resolves.toBe(true)
    await expect(store.delete('ns', 'k')).resolves.toBe(false)
    await expect(store.get('ns', 'k')).resolves.toBeUndefined()
  })

  it('lists keys sorted and filtered by prefix', async () => {
    const store = new MemoryStore()
    await store.put('ns', 'user:02', 2)
    await store.put('ns', 'user:01', 1)
    await store.put('ns', 'session:9', 9)
    await store.put('other', 'user:03', 3)
    await expect(store.list('ns')).resolves.toEqual(['session:9', 'user:01', 'user:02'])
    await expect(store.list('ns', 'user:')).resolves.toEqual(['user:01', 'user:02'])
    await expect(store.list('ns', 'nothing:')).resolves.toEqual([])
    await expect(store.list('missing')).resolves.toEqual([])
  })

  it('stops listing deleted keys', async () => {
    const store = new MemoryStore()
    await store.put('ns', 'k', 1)
    await store.delete('ns', 'k')
    await expect(store.list('ns')).resolves.toEqual([])
  })

  it('rejects empty names', async () => {
    const store = new MemoryStore()
    await expect(store.get('', 'k')).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(store.get('ns', '')).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(store.put('', 'k', 1)).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(store.delete('ns', '')).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(store.list('')).rejects.toMatchObject({ code: 'invalid-input' })
  })

  it('rejects values JSON cannot encode', async () => {
    const store = new MemoryStore()
    await expect(store.put('ns', 'fn', (() => 1) as unknown as JsonValue)).rejects.toMatchObject({
      code: 'invalid-input',
    })
    await expect(
      store.put('ns', 'hole', { gap: undefined } as unknown as JsonValue),
    ).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(store.put('ns', 'nan', Number.NaN)).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(store.put('ns', 'inf', Number.POSITIVE_INFINITY)).rejects.toMatchObject({
      code: 'invalid-input',
    })
    await expect(store.put('ns', 'date', new Date() as unknown as JsonValue)).rejects.toMatchObject({
      code: 'invalid-input',
    })
    await expect(store.put('ns', 'bigint', 10n as unknown as JsonValue)).rejects.toMatchObject({
      code: 'invalid-input',
    })
    const cyclic: { self: unknown } = { self: null }
    cyclic.self = cyclic
    await expect(store.put('ns', 'cycle', cyclic as unknown as JsonValue)).rejects.toMatchObject({
      code: 'invalid-input',
    })
  })

  it('accepts repeated references that do not form a cycle', async () => {
    const store = new MemoryStore()
    const shared = { flag: true }
    await store.put('ns', 'dag', { first: shared, second: shared })
    await expect(store.get('ns', 'dag')).resolves.toEqual({ first: { flag: true }, second: { flag: true } })
  })

  it('rejects non-JSON values hidden in array extra properties', async () => {
    const store = new MemoryStore()
    const smuggled: unknown = ['legit']
    ;(smuggled as Record<string, unknown>)['extra'] = () => 'nope'
    await expect(store.put('ns', 'k', smuggled as JsonValue)).rejects.toMatchObject({
      code: 'invalid-input',
    })
  })

  it('reports values that pass the guard but fail the commit clone', async () => {
    const store = new MemoryStore()
    const proxied = new Proxy({ amount: 1 }, {}) as unknown as JsonValue
    await expect(store.put('ns', 'proxy', proxied)).rejects.toMatchObject({
      code: 'invalid-input',
    })
    let reads = 0
    const delayed: Record<string, unknown> = {}
    Object.defineProperty(delayed, 'amount', {
      enumerable: true,
      get() {
        reads += 1
        if (reads > 1) throw new Error('getter explodes when read again')
        return 1
      },
    })
    await expect(store.put('ns', 'delayed', delayed as unknown as JsonValue)).rejects.toMatchObject({
      code: 'invalid-input',
    })
    expect(reads).toBe(2)
    await expect(store.get('ns', 'proxy')).resolves.toBeUndefined()
    await expect(store.get('ns', 'delayed')).resolves.toBeUndefined()
  })

  it('detaches stored values from callers in both directions', async () => {
    const store = new MemoryStore()
    const input = { items: [1, 2] }
    await store.put('ns', 'k', input)
    input.items.push(3)
    await expect(store.get('ns', 'k')).resolves.toEqual({ items: [1, 2] })
    const readback = await store.get('ns', 'k')
    if (typeof readback !== 'object' || readback === null || Array.isArray(readback)) {
      throw new Error('expected an object document')
    }
    ;(readback as Record<string, unknown>)['items'] = 'tampered'
    await expect(store.get('ns', 'k')).resolves.toEqual({ items: [1, 2] })
  })
})

describe('memory update', () => {
  it('creates the key when absent and resolves with the committed value', async () => {
    const store = new MemoryStore()
    const committed = await store.update<{ visits: number }>('ns', 'k', (current) => {
      expect(current).toBeUndefined()
      return { visits: 1 }
    })
    expect(committed).toEqual({ visits: 1 })
    await expect(store.get('ns', 'k')).resolves.toEqual({ visits: 1 })
  })

  it('re-runs the callback when a competing writer commits first', async () => {
    const store = new MemoryStore()
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
    await expect(store.get('ns', 'k')).resolves.toEqual({ count: 2 })
  })

  it('keeps every change when many writers interleave', async () => {
    const store = new MemoryStore()
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
    // Each writer committed exactly one distinct successor value.
    expect([...committed].sort((a, b) => a - b)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1))
    await expect(store.get('ns', 'counter')).resolves.toBe(50)
    // All writers started from the same version, so only one first attempt
    // could commit; every other writer re-ran its callback at least once.
    expect(calls).toBeGreaterThanOrEqual(99)
  })

  it('propagates callback failures without changing the value', async () => {
    const store = new MemoryStore()
    await store.put('ns', 'k', { count: 5 })
    await expect(
      store.update<{ count: number }>('ns', 'k', () => {
        throw new Error('callback exploded')
      }),
    ).rejects.toThrow('callback exploded')
    await expect(store.get('ns', 'k')).resolves.toEqual({ count: 5 })
  })

  it('notices a delete that happened while the callback was pending', async () => {
    const store = new MemoryStore()
    await store.put('ns', 'k', { count: 1 })
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
    await store.delete('ns', 'k')
    releaseGate()
    await slow
    expect(calls).toBe(2)
    await expect(store.get('ns', 'k')).resolves.toEqual({ count: 1 })
  })

  it('hands the callback a detached copy of the current value', async () => {
    const store = new MemoryStore()
    await store.put('ns', 'k', { items: [1] })
    await expect(
      store.update<{ items: number[] }>('ns', 'k', (current) => {
        if (current === undefined) throw new Error('value expected')
        current.items.push(2)
        throw new Error('aborted after scribbling')
      }),
    ).rejects.toThrow('aborted after scribbling')
    await expect(store.get('ns', 'k')).resolves.toEqual({ items: [1] })
  })

  it('resolves with a detached copy of the committed value', async () => {
    const store = new MemoryStore()
    const committed = await store.update<{ items: number[] }>('ns', 'k', () => ({ items: [1] }))
    committed.items.push(2)
    ;(committed as Record<string, unknown>)['items'] = 'tampered'
    await expect(store.get('ns', 'k')).resolves.toEqual({ items: [1] })
  })

  it('resolves with a detached copy after a contented retry as well', async () => {
    const store = new MemoryStore()
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
    releaseGate()
    const committed = await slow
    expect(calls).toBe(2)
    expect(committed).toEqual({ count: 2 })
    ;(committed as Record<string, unknown>)['count'] = 99
    await expect(store.get('ns', 'k')).resolves.toEqual({ count: 2 })
  })

  it('reports update results that pass the guard but fail the commit clone', async () => {
    const store = new MemoryStore()
    await store.put('ns', 'k', { count: 0 })
    await expect(
      store.update<JsonValue>('ns', 'k', () => new Proxy({ count: 1 }, {}) as unknown as JsonValue),
    ).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(store.get('ns', 'k')).resolves.toEqual({ count: 0 })
  })
})
