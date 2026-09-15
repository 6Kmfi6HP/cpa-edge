
import { describe, it } from 'vitest'
import { serializeOrdered } from './json'

function deepObj(n: number): Record<string, unknown> {
  let v: Record<string, unknown> = { leaf: 1 }
  for (let i = 0; i < n; i++) v = { a: v }
  return v
}

describe('depth probe 2 (temporary)', () => {
  it('narrow the limit', () => {
    for (const n of [8500, 9000, 9500, 9800, 10000, 10200, 10500, 11000, 12000, 13000, 14000]) {
      try {
        serializeOrdered(deepObj(n))
        console.log(`obj depth ${n}: OK`)
      } catch (e) {
        console.log(`obj depth ${n}: THROWS ${(e as Error).constructor.name}`)
      }
    }
  })
})
