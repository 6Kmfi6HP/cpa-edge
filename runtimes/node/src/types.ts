/**
 * Wire-level request/response types of the node runtime gateway.
 *
 * The runtime is the platform adapter: it owns sockets, HTTP framing,
 * routing and the trace family. Translation lives in the workspace
 * packages and is reached only through their exported facades.
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
   * Transport-level client address. Feeds management auth decisions when
   * the gateway was built with `managementRemoteAddress` unset; contract
   * and unit tests inject `127.0.0.1` to mirror loopback deployments.
   */
  readonly remoteAddress?: string
}

/** Response payload handed back by a handler. */
export type GatewayBody = string | ReadableStream<Uint8Array>

/** One gateway-produced response before platform emission. */
export interface GatewayResponse {
  readonly status: number
  /** Headers in emission order (Date/Content-Length are platform-added). */
  readonly headers: HeaderList
  readonly body: GatewayBody
}

/** Immutable constants describing this build of the gateway. */
export interface GatewayBuildInfo {
  readonly version: string
  readonly commit: string
  readonly buildDate: string
}
