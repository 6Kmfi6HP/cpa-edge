/**
 * Serverless streaming boundary (the charter's T3 review focus).
 *
 * Vercel functions have a hard wall-clock ceiling (`maxDuration`): the
 * platform freezes or kills the invocation when it expires. If an SSE
 * response were still open at that moment, the client would see the
 * connection drop mid-frame with no terminal event at all - the hang
 * this runtime must not produce.
 *
 * The mitigation (S7 pins no envelope for the boundary; this module
 * documents the chosen shape):
 *
 * - Every invocation stamps a start time. Each upstream call spends the
 *   REMAINING budget of a configured total (`maxStreamingDurationMs`,
 *   set from the deployment's `maxDuration` minus a safety margin).
 * - When the budget trips, the boundary aborts the upstream exchange:
 *   the fetch signal fires AND the response stream guard errors the
 *   stream mid-read. Facades observe exactly the mid-stream transport
 *   disconnect the goldens pin, so each family renders its OWN terminal
 *   frame (for example the recorded in-stream
 *   `{"error":{"message":"unexpected EOF",...}}` frame of the
 *   OpenAI-chat family) and the downstream response ENDS: translated
 *   prefix frames, one terminal frame, no `[DONE]`. No separate
 *   503/timeout envelope is emitted - S7 §4.2 leaves the mid-stream
 *   failure path family-owned and this runtime agrees.
 * - `maxBytes` is the deterministic twin of the same guard: the unit
 *   test forces the abort at an arbitrary byte count through the
 *   transport seam. Production leaves it unset.
 */

/** Injectable timer seam; production uses the platform timers. */
export interface TimerSeam {
  setTimeout(callback: () => void, ms: number): () => void
  clearTimeout(handle: () => void): void
}

const platformTimers: TimerSeam = {
  setTimeout(callback, ms) {
    const handle = setTimeout(callback, ms)
    return () => clearTimeout(handle)
  },
  clearTimeout(handle) {
    handle()
  },
}

/** Fetch surface the boundary wraps (the Web Standard subset in use). */
export type BoundaryFetchLike = (
  url: string,
  init?: {
    readonly method?: string
    readonly headers?: Record<string, string>
    readonly body?: string
    /** Present when the caller already owns an abort signal (unused today). */
    readonly signal?: AbortSignal
  },
) => Promise<Response>

/** Budget facts one invocation carries. */
export interface BoundaryConfig {
  /** Total streaming budget in milliseconds; `undefined` disables the guard. */
  readonly maxDurationMs?: number
  /** Test-only byte budget for the stream guard. */
  readonly maxBytes?: number
  /** Timer seam override (tests). */
  readonly timers?: TimerSeam
  /** Epoch-milliseconds clock override (tests). */
  readonly now?: () => number
}

/** Per-invocation deadline bookkeeping. */
export interface RequestDeadline {
  /** Computes the remaining budget for the next upstream call. */
  remaining(): number | undefined
}

/** Stamps the invocation start; budget arithmetic reads the clock lazily. */
export function startRequestDeadline(config: BoundaryConfig): RequestDeadline {
  const now = config.now ?? (() => Date.now())
  const startedAt = now()
  return {
    remaining() {
      if (config.maxDurationMs === undefined) return undefined
      return Math.max(0, config.maxDurationMs - (now() - startedAt))
    },
  }
}

/** Error the guard raises; facades turn it into their family terminal frame. */
class StreamBudgetError extends Error {
  constructor() {
    super('upstream streaming budget exceeded')
  }
}

/**
 * Wraps a fetch with the boundary guard. Every call gets its own abort
 * signal and stream guard: the time budget arms a timer, the byte budget
 * (when set) counts the response bytes, and whichever trips first turns
 * the response stream into a mid-stream error. A fetch that never
 * resolves before the deadline rejects through the same signal.
 */
export function createBoundaryFetch(
  fetchLike: BoundaryFetchLike,
  deadline: RequestDeadline,
  config: BoundaryConfig,
): BoundaryFetchLike {
  const timers = config.timers ?? platformTimers
  return async (url, init) => {
    const remaining = deadline.remaining()
    const controller = new AbortController()
    let tripped = false
    const trip = (): void => {
      if (tripped) return
      tripped = true
      controller.abort()
    }
    let cancelTimer: (() => void) | undefined
    if (remaining !== undefined) {
      cancelTimer = timers.setTimeout(() => trip(), remaining)
    }
    const settle = (): void => {
      if (cancelTimer !== undefined) {
        timers.clearTimeout(cancelTimer)
        cancelTimer = undefined
      }
    }
    let response: Response
    try {
      response = await fetchLike(url, { ...init, signal: controller.signal })
    } catch (error) {
      settle()
      throw error
    }
    if (response.body === null) {
      settle()
      return response
    }
    const guarded = guardStream(response.body, {
      isTripped: () => tripped,
      maxBytes: config.maxBytes,
      trip,
      onEnd: settle,
    })
    if (NULL_BODY_STATUSES.has(response.status)) {
      return new Response(null, { status: response.status, headers: response.headers })
    }
    return new Response(guarded, { status: response.status, headers: response.headers })
  }
}

const NULL_BODY_STATUSES = new Set([101, 204, 304])

interface GuardOptions {
  readonly isTripped: () => boolean
  readonly maxBytes: number | undefined
  readonly trip: () => void
  readonly onEnd: () => void
}

/**
 * Pass-through stream that enforces the budget. Bytes flow unchanged
 * until the boundary trips; then the stream errors, which is precisely
 * the observable the facades' mid-stream disconnect handling expects.
 */
function guardStream(source: ReadableStream<Uint8Array>, options: GuardOptions): ReadableStream<Uint8Array> {
  const reader = source.getReader()
  let passed = 0
  let finished = false
  const finish = (): void => {
    if (finished) return
    finished = true
    options.onEnd()
  }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (options.isTripped()) {
        finish()
        await reader.cancel().then(
          () => {},
          () => {},
        )
        controller.error(new StreamBudgetError())
        return
      }
      let chunk: ReadableStreamReadResult<Uint8Array>
      try {
        chunk = await reader.read()
      } catch (error) {
        finish()
        controller.error(error)
        return
      }
      if (chunk.done) {
        finish()
        controller.close()
        return
      }
      passed += chunk.value.byteLength
      if (options.maxBytes !== undefined && passed > options.maxBytes) {
        // Cut AT the boundary: bytes past the cap never flow downstream.
        options.trip()
        finish()
        await reader.cancel().then(
          () => {},
          () => {},
        )
        controller.error(new StreamBudgetError())
        return
      }
      controller.enqueue(chunk.value)
    },
    cancel() {
      finish()
      void reader.cancel().then(
        () => {},
        () => {},
      )
    },
  })
}
