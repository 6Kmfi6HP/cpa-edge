/**
 * Wire types and serving contexts for the OpenAI chat-completions client
 * -> OpenAI-compatibility upstream direction (the S1 chat seam).
 *
 * This direction is a byte-preserving passthrough: the client body keeps
 * its own bytes end to end (only the `model` string and, on streams, the
 * `stream_options.include_usage` flag are rewritten in place), and the
 * upstream reply crosses back the same way. The types below describe the
 * few structures that cross the translation boundary.
 */

/** A JSON value crossing the translation boundary. */
export type WireValue =
  | string
  | number
  | boolean
  | null
  | readonly WireValue[]
  | { readonly [key: string]: WireValue }

/** Ordered JSON object builder; key insertion order is the wire order. */
export type WireObject = { [key: string]: WireValue }

/** Ordered header list: `[name, value]` pairs, original casing. */
export type HeaderList = ReadonlyArray<readonly [string, string]>

/** One decoded upstream SSE block: a `data:` payload with its `event:` name. */
export interface SseFrame {
  /** `event:` name when the enclosing block carried one (unused on the wire). */
  readonly event?: string
  /** Payload after the `data:` prefix. */
  readonly data: string
}

/** Request-translation context: what the executor rewrites, and nothing else. */
export interface ChatPassthroughContext {
  /** Upstream (alias-target) model stamped onto `model`. */
  readonly upstreamModel: string
  /** `true` when the client asked for a streamed reply. */
  readonly stream: boolean
}

/** Result of the passthrough request translation. */
export interface ChatPassthroughRequest {
  /** Rewritten body bytes (the client bytes plus the in-place splices). */
  readonly body: string
}

/** Response-translation context (the force-mapping model rewrite). */
export interface ChatResponseContext {
  /**
   * `force-mapping: true` rewrites the response `model` field back to the
   * client-facing alias; absent leaves the upstream bytes untouched.
   */
  readonly forceMappingModel?: string
}

/**
 * One translated stream event handed to the downstream framer. `chunk`
 * carries re-framed data bytes, `terminal-error` ends the stream with a
 * plain `data:` error frame (no `[DONE]` after it), `done` ends it with
 * the `[DONE]` terminator.
 */
export type DownstreamStreamEvent =
  | { readonly kind: 'chunk'; readonly body: string }
  | { readonly kind: 'terminal-error'; readonly body: string; readonly status: number }
  | { readonly kind: 'done' }
