/**
 * Test harness for the Cloudflare runtime: a Durable Object simulator
 * that satisfies the same narrow structural interfaces the production
 * code consumes (`DoStorageLike`, `DoAlarmLike`, `WebSocketHost`,
 * `RuntimeEnvSources`). Tests never touch a real workerd - the
 * semantics exercised here are the ones the runtime itself defines over
 * those interfaces (per-key atomic storage, one-shot alarms, tagged
 * hibernation sockets).
 *
 * This module is test support only; it is not exported from the
 * package index and the Worker entry never imports it.
 */

/** In-memory Durable Object storage: string keys, per-key atomicity. */
export class SimulatedDoStorage {
  private readonly map = new Map<string, unknown>()
  readonly puts: string[] = []

  async get(key: string): Promise<unknown> {
    return this.map.get(key)
  }

  async put(key: string, value: unknown): Promise<void> {
    this.puts.push(key)
    this.map.set(key, structuredClone(value))
  }

  async delete(key: string): Promise<boolean> {
    return this.map.delete(key)
  }

  async list(options?: { readonly prefix?: string }): Promise<Map<string, unknown>> {
    const out = new Map<string, unknown>()
    const prefix = options?.prefix
    for (const [key, value] of [...this.map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (prefix !== undefined && !key.startsWith(prefix)) continue
      out.set(key, value)
    }
    return out
  }

  /** Number of stored keys (test assertions). */
  get size(): number {
    return this.map.size
  }
}

/** One-shot alarm surface recording every (re)arm. */
export class SimulatedAlarm {
  private current: number | null = null
  readonly armedAt: number[] = []

  async setAlarm(scheduledAtMs: number): Promise<void> {
    this.armedAt.push(scheduledAtMs)
    this.current = scheduledAtMs
  }

  async getAlarm(): Promise<number | null> {
    return this.current
  }

  async deleteAlarm(): Promise<void> {
    this.current = null
  }

  /** Last armed time (test assertions). */
  lastArmed(): number | null {
    return this.current
  }
}

/** A live hibernated socket as the tests see it. */
export interface FakeSocket {
  close(code?: number, reason?: string): void
  readonly closedWith: { code: number; reason: string } | undefined
}

/** Builds one fake hibernated socket that records its close call. */
export function makeFakeSocket(): FakeSocket {
  let closedWith: { code: number; reason: string } | undefined
  return {
    close(code?: number, reason?: string) {
      closedWith = { code: code ?? 1005, reason: reason ?? '' }
    },
    get closedWith() {
      return closedWith
    },
  }
}

/** Hibernation host recording accepted sockets and their tags. */
export class SimulatedWebSocketHost {
  readonly accepted: Array<{ socket: FakeSocket; tags: readonly string[] }> = []

  accept(socket: WebSocket, tags?: readonly string[]): void {
    // The production call passes real WebSocket halves; the simulated
    // host only records them and offers a fake close surface for the
    // termination assertions.
    this.accepted.push({ socket: socket as unknown as FakeSocket, tags: tags ?? [] })
  }

  list(tag?: string): readonly WebSocket[] {
    return this.accepted
      .filter((entry) => tag === undefined || entry.tags.includes(tag))
      .map((entry) => entry.socket as unknown as WebSocket)
  }
}

/** Deterministic clock with manual advancement. */
export function makeClock(startAt: number): { now: () => number; advance: (ms: number) => void } {
  let current = startAt
  return {
    now: () => current,
    advance: (ms) => {
      current += ms
    },
  }
}

/** Config KV source simulation. */
export function makeFakeKv(values: Readonly<Record<string, string>>): { get(key: string): Promise<string | null> } {
  return {
    get: (key) => Promise.resolve(values[key] ?? null),
  }
}
