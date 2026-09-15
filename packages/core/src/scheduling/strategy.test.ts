import { describe, expect, it } from 'vitest'
import { CpaError } from '../errors'
import {
  MAX_CREDENTIAL_WEIGHT,
  highestReadyPriority,
  legacyWebsocketTierView,
  mixedSegmentAt,
  normalizeSelectionStrategy,
  orderMixedProviders,
  pickFirst,
  pickRoundRobinSuccessor,
  pickSmoothWeighted,
  rotateCandidateList,
  shardWebsocketView,
  tierView,
  validateCredentialWeight,
} from './strategy'
import type { SchedulingCandidate } from './strategy'

// Recorded S4-01 ascending order: key-1 < key-3 < key-2.
const RR_ORDER = ['2add2ed9fa51', '922ad5b89d42', '9d9fdb184163'] as const

function candidate(id: string, overrides: Partial<SchedulingCandidate> = {}): SchedulingCandidate {
  return {
    id,
    priority: 0,
    websocketEnabled: false,
    ready: true,
    weight: 1,
    ...overrides,
  }
}

describe('strategy names and weights', () => {
  it('normalizes aliases and falls back to round-robin', () => {
    expect(normalizeSelectionStrategy(undefined)).toBe('round-robin')
    expect(normalizeSelectionStrategy('round-robin')).toBe('round-robin')
    expect(normalizeSelectionStrategy('weighted-round-robin')).toBe('weighted-round-robin')
    expect(normalizeSelectionStrategy('weightedroundrobin')).toBe('weighted-round-robin')
    expect(normalizeSelectionStrategy('wrr')).toBe('weighted-round-robin')
    expect(normalizeSelectionStrategy('fill-first')).toBe('fill-first')
    expect(normalizeSelectionStrategy('fillfirst')).toBe('fill-first')
    expect(normalizeSelectionStrategy('ff')).toBe('fill-first')
    expect(normalizeSelectionStrategy('nonsense')).toBe('round-robin')
  })

  it('rejects weights above the bound with the recorded message (S4-19)', () => {
    expect(() =>
      validateCredentialWeight('openai-compatibility[0].api-key-entries[0].weight', 1_000_001),
    ).toThrowError(
      new CpaError(
        'invalid-input',
        'openai-compatibility[0].api-key-entries[0].weight: weight must not exceed 1000000',
      ),
    )
    expect(() => validateCredentialWeight('a[0].weight', 1_000_000)).not.toThrow()
    expect(() => validateCredentialWeight('a[0].weight', -3)).not.toThrow()
    expect(() => validateCredentialWeight('a[0].weight', 1.5)).toThrowError(
      new CpaError('invalid-input', 'a[0].weight: weight must be an integer'),
    )
    expect(MAX_CREDENTIAL_WEIGHT).toBe(1_000_000)
  })
})

describe('round-robin', () => {
  it('walks the successor of the last pick in ascending order with wrap (S4-01)', () => {
    const sweeps: string[] = []
    let last: string | undefined
    for (let i = 0; i < 6; i += 1) {
      const pick = pickRoundRobinSuccessor([...RR_ORDER], last)
      expect(pick).toBeDefined()
      sweeps.push(pick as string)
      last = pick
    }
    // key-1, key-3, key-2, key-1, key-3, key-2
    expect(sweeps).toEqual([
      '2add2ed9fa51',
      '922ad5b89d42',
      '9d9fdb184163',
      '2add2ed9fa51',
      '922ad5b89d42',
      '9d9fdb184163',
    ])
  })

  it('starts at the smallest ID and handles empty sets', () => {
    expect(pickRoundRobinSuccessor([...RR_ORDER], undefined)).toBe('2add2ed9fa51')
    expect(pickRoundRobinSuccessor([], 'x')).toBeUndefined()
  })

  it('picks the smallest ID repeatedly when the last pick is the largest', () => {
    expect(pickRoundRobinSuccessor([...RR_ORDER], '9d9fdb184163')).toBe('2add2ed9fa51')
  })
})

describe('fill-first', () => {
  it('always picks the smallest-ID candidate (S4-02)', () => {
    expect(pickFirst([...RR_ORDER])).toBe('2add2ed9fa51')
    expect(pickFirst([])).toBeUndefined()
  })
})

describe('smooth weighted round-robin', () => {
  it('reproduces the recorded 3:1 sequence A A B A A A B A (S4-03)', () => {
    const candidates = [
      { id: 'a', weight: 3 },
      { id: 'b', weight: 1 },
    ]
    const picks: (string | undefined)[] = []
    let currents: Readonly<Record<string, number>> = {}
    for (let i = 0; i < 8; i += 1) {
      const step = pickSmoothWeighted(candidates, currents)
      picks.push(step.winner)
      currents = step.currents
    }
    expect(picks).toEqual(['a', 'a', 'b', 'a', 'a', 'a', 'b', 'a'])
  })

  it('breaks ties toward the earlier ID', () => {
    const step = pickSmoothWeighted(
      [
        { id: 'a', weight: 1 },
        { id: 'b', weight: 1 },
      ],
      {},
    )
    expect(step.winner).toBe('a')
  })

  it('excludes zero and negative weights while the strategy is active', () => {
    const step = pickSmoothWeighted(
      [
        { id: 'a', weight: 0 },
        { id: 'b', weight: -1 },
      ],
      {},
    )
    expect(step.winner).toBeUndefined()
    const mixed = pickSmoothWeighted(
      [
        { id: 'a', weight: 3 },
        { id: 'b', weight: 0 },
        { id: 'c', weight: 1 },
      ],
      {},
    )
    expect(mixed.winner).toBe('a')
    expect(Object.keys(mixed.currents)).toEqual(['a', 'c'])
  })
})

describe('priority tiers', () => {
  it('participates only the highest tier that has a ready credential', () => {
    const pool = [
      candidate('low', { priority: -5 }),
      candidate('high-a', { priority: 0 }),
      candidate('high-b', { priority: 0, ready: false }),
      candidate('mid', { priority: 1, ready: false }),
    ]
    expect(highestReadyPriority(pool)).toBe(0)
    expect(tierView(pool, 0).map((entry) => entry.id)).toEqual(['high-a'])
    expect(tierView(pool, -5).map((entry) => entry.id)).toEqual(['low'])
  })

  it('reports undefined when nothing is ready', () => {
    expect(highestReadyPriority([candidate('a', { ready: false })])).toBeUndefined()
  })
})

describe('websocket transport preference', () => {
  const codexPool = [
    candidate('ws-low', { priority: -5, websocketEnabled: true }),
    candidate('plain-high', { priority: 0 }),
  ]

  it('shard path searches ws-enabled credentials across ALL tiers (S4-21)', () => {
    const { view, preferred } = shardWebsocketView(codexPool, {
      downstreamWebSocket: true,
      pinnedAuthId: '',
      provider: 'codex',
    })
    expect(preferred).toBe(true)
    expect(view.map((entry) => entry.id)).toEqual(['ws-low'])
  })

  it('shard path covers codex AND xai', () => {
    for (const provider of ['codex', 'xai']) {
      const { preferred } = shardWebsocketView(codexPool, {
        downstreamWebSocket: true,
        pinnedAuthId: '',
        provider,
      })
      expect(preferred).toBe(true)
    }
    const other = shardWebsocketView(codexPool, {
      downstreamWebSocket: true,
      pinnedAuthId: '',
      provider: 'gemini',
    })
    expect(other.preferred).toBe(false)
  })

  it('never applies while a credential is pinned or the request is plain HTTP', () => {
    expect(
      shardWebsocketView(codexPool, { downstreamWebSocket: true, pinnedAuthId: 'ws-low', provider: 'codex' })
        .preferred,
    ).toBe(false)
    expect(shardWebsocketView(codexPool, { downstreamWebSocket: false, pinnedAuthId: '', provider: 'codex' })
      .preferred).toBe(false)
  })

  it('falls back to the all-credentials view when no ws credential is ready', () => {
    const noWs = [
      candidate('plain-high', { priority: 0 }),
      candidate('plain-low', { priority: -5 }),
    ]
    const { view, preferred } = shardWebsocketView(noWs, {
      downstreamWebSocket: true,
      pinnedAuthId: '',
      provider: 'codex',
    })
    expect(preferred).toBe(false)
    expect(view).toHaveLength(2)
  })

  it('legacy path filters codex only, inside the collapsed highest tier', () => {
    const tier = tierView(codexPool, 0)
    expect(legacyWebsocketTierView(tier, { downstreamWebSocket: true, pinnedAuthId: '', provider: 'xai' })).toBe(tier)
    // No ws credential in the highest tier: fall back to the unfiltered tier.
    expect(
      legacyWebsocketTierView(tier, { downstreamWebSocket: true, pinnedAuthId: '', provider: 'codex' }),
    ).toBe(tier)
    const wsTier = [
      candidate('plain-a', { priority: 0 }),
      candidate('ws-b', { priority: 0, websocketEnabled: true }),
    ]
    expect(
      legacyWebsocketTierView(wsTier, { downstreamWebSocket: true, pinnedAuthId: '', provider: 'codex' }).map(
        (entry) => entry.id,
      ),
    ).toEqual(['ws-b'])
  })
})

describe('mixed provider rotation', () => {
  it('orders segments by registered count DESC then name ASC', () => {
    const ordered = orderMixedProviders([
      { name: 'openai-compatible-mock-openai-mx', registeredCount: 1, readyCount: 1 },
      { name: 'gemini', registeredCount: 3, readyCount: 2 },
      { name: 'codex', registeredCount: 3, readyCount: 0 },
    ])
    expect(ordered.map((segment) => segment.name)).toEqual([
      'codex',
      'gemini',
      'openai-compatible-mock-openai-mx',
    ])
  })

  it('maps the cursor modulo the total ready weight onto segments (S4-18)', () => {
    const segments = [
      { name: 'gemini', registeredCount: 1, readyCount: 1 },
      { name: 'openai-compatible-mock-openai-mx', registeredCount: 1, readyCount: 1 },
    ]
    expect([0, 1, 2, 3, 4].map((cursor) => mixedSegmentAt(segments, cursor)?.name)).toEqual([
      'gemini',
      'openai-compatible-mock-openai-mx',
      'gemini',
      'openai-compatible-mock-openai-mx',
      'gemini',
    ])
  })

  it('skips segments without ready credentials', () => {
    const segments = [
      { name: 'empty', registeredCount: 5, readyCount: 0 },
      { name: 'full', registeredCount: 1, readyCount: 2 },
    ]
    expect(mixedSegmentAt(segments, 0)?.name).toBe('full')
    expect(mixedSegmentAt(segments, 1)?.name).toBe('full')
    expect(mixedSegmentAt([{ name: 'x', registeredCount: 1, readyCount: 0 }], 0)).toBeUndefined()
  })

  it('weights segments by their ready counts', () => {
    const segments = [
      { name: 'two', registeredCount: 2, readyCount: 2 },
      { name: 'one', registeredCount: 1, readyCount: 1 },
    ]
    expect([0, 1, 2, 3].map((cursor) => mixedSegmentAt(segments, cursor)?.name)).toEqual([
      'two',
      'two',
      'one',
      'two',
    ])
  })
})

describe('candidate list rotation (model pools)', () => {
  it('rotates by the offset with preserved relative order (S4-13)', () => {
    const pool = ['mock-pool-1', 'mock-pool-2']
    expect(rotateCandidateList(pool, 0)).toEqual(['mock-pool-1', 'mock-pool-2'])
    expect(rotateCandidateList(pool, 1)).toEqual(['mock-pool-2', 'mock-pool-1'])
    expect(rotateCandidateList(pool, 2)).toEqual(['mock-pool-1', 'mock-pool-2'])
    expect(rotateCandidateList(pool, 3)).toEqual(['mock-pool-2', 'mock-pool-1'])
    expect(rotateCandidateList([], 1)).toEqual([])
  })
})
