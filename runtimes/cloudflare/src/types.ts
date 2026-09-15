/**
 * Shared wire and platform-adapter types of the Cloudflare Workers
 * runtime.
 *
 * The gateway pipeline below speaks the same internal request/response
 * shapes as the node runtime (the S1 routing contract is shared), while
 * every Cloudflare-specific surface (Durable Object storage, alarms,
 * WebSocket hibernation) is narrowed behind small structural interfaces
 * so the runtime can be exercised under a plain test harness without a
 * real workerd.
 */

/** Ordered header list: `[name, value]` pairs, original casing. */
export type HeaderList = ReadonlyArray<readonly [string, string]>

/** Fully-buffered inbound request as the router sees it. */
export interface GatewayRequest {
  /** Uppercase HTTP method as received. */
  readonly method: string
  /** Absolute request URL (scheme://host/path?query). */
  readonly url: string
  /** Headers in received order and casing. */
  readonly headers: HeaderList
  /** Raw request-body bytes (empty when the request has no body). */
  readonly body: Uint8Array
  /**
   * Transport-level client address; fed to the management auth gate.
   * The Workers entry resolves it from the edge's connection headers.
   */
  readonly remoteAddress?: string
}

/** Body a gateway handler may return: buffered bytes or a live stream. */
export type GatewayBody = string | ReadableStream<Uint8Array>

/** One gateway-produced response before platform emission. */
export interface GatewayResponse {
  readonly status: number
  /** Headers in emission order (Date/Content-Length are platform-added). */
  readonly headers: HeaderList
  readonly body: GatewayBody
  /**
   * Client half of an accepted WebSocket upgrade (status 101): the
   * platform Response carries it; the DO keeps the server half in
   * hibernation.
   */
  readonly webSocket?: WebSocket
}

/**
 * The storage surface the Durable Object store needs. The real
 * `DurableObjectStorage` satisfies this structurally; tests provide an
 * in-memory simulation.
 */
export interface DoStorageLike {
  get(key: string): Promise<unknown>
  put(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<boolean>
  list(options?: { readonly prefix?: string }): Promise<Map<string, unknown>>
}

/** One-shot alarm surface of a Durable Object. */
export interface DoAlarmLike {
  setAlarm(scheduledAtMs: number): Promise<void>
  getAlarm(): Promise<number | null>
  deleteAlarm(): Promise<void>
}

/**
 * WebSocket hibernation host: accepted sockets are registered with the
 * Durable Object so sessions survive eviction, and `list` lets a
 * ws-auth flip terminate them (S7 OQ-S7-05; the close code is this
 * runtime's owned choice).
 */
export interface WebSocketHost {
  accept(socket: WebSocket, tags?: readonly string[]): void
  list(tag?: string): readonly WebSocket[]
}

/** Bindings the Worker and its Durable Object receive. */
export interface CloudflareEnv {
  /** The gateway's own Durable Object namespace. */
  readonly CPA_EDGE_DO?: DurableObjectNamespace
  /** Optional KV binding holding the deployment's config.yaml text. */
  readonly CPA_CONFIG?: KVNamespace
  /** Optional plain-text binding (var or secret) with config.yaml text. */
  readonly CPA_CONFIG_YAML?: string
}

/**
 * Minimal KV read surface the config loader needs (the real
 * `KVNamespace` satisfies this; tests simulate it).
 */
export interface ConfigKvLike {
  get(key: string): Promise<string | null>
}

/** Narrowed view of `CloudflareEnv` the runtime consumes internally. */
export interface RuntimeEnvSources {
  /** Config bytes from a KV binding, when bound. */
  readonly configKv?: ConfigKvLike
  /** Config bytes from a plain-text binding, when set. */
  readonly configText?: string
}
