import { describe, it, expect } from 'vitest'
import * as core from '@cpa-edge/core'

describe('workspace smoke (P0.1)', () => {
  it('vitest runs', () => {
    expect(true).toBe(true)
  })
  it('resolves workspace TS source packages', () => {
    expect(typeof core).toBe('object')
  })
})
