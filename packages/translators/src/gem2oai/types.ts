/**
 * Wire types and serving contexts for the Gemini client -> OpenAI
 * (chat completions) upstream direction (S2d2).
 *
 * Gemini-shaped values arrive as raw client bytes; the translator derives
 * ordered OpenAI bodies from them. Field order matters on every serialized
 * surface here: the upstream body is emitted through an insertion-order
 * serializer that reproduces the recorded key order, so the property order
 * in these types is part of the contract.
 */

/** A JSON value crossing the translation boundary. */
export type WireValue =
  | string
  | number
  | boolean
  | null
  | readonly WireValue[]
  | { readonly [key: string]: WireValue }

/** Ordered JSON object builder: key insertion order is the wire order. */
export type WireObject = { [key: string]: WireValue }

/** Ordered header list: `[name, value]` pairs, original casing. */
export type HeaderList = ReadonlyArray<readonly [string, string]>

/**
 * Thinking capability of the selected model entry. openai-compat models
 * without explicit thinking configuration use
 * {@link DEFAULT_OPENAI_COMPAT_THINKING} (levels low/medium/high, dynamic and
 * disable both disallowed).
 */
export interface ThinkingCapability {
  /** Reasoning levels the model understands, ladder order. */
  readonly levels: readonly string[]
  /** `none` maps to the lowest level when disable is not allowed. */
  readonly disableAllowed?: boolean
}

/** Capability applied to openai-compat models without explicit thinking config. */
export const DEFAULT_OPENAI_COMPAT_THINKING: ThinkingCapability = Object.freeze({
  levels: Object.freeze(['low', 'medium', 'high']),
})

/**
 * Request-translation inputs supplied by the serving configuration. The
 * translator derives everything else from the request body alone.
 */
export interface GeminiToOpenAIContext {
  /** Upstream (alias-target) model stamped onto `model`. */
  readonly upstreamModel: string
  /** `true` for `:streamGenerateContent`, `false` otherwise. */
  readonly stream: boolean
  /** Thinking capability of the selected model entry. */
  readonly thinking?: ThinkingCapability
}

/** Upstream request produced by the Gemini -> OpenAI translation. */
export interface GeminiUpstreamRequest {
  /** Serialized upstream body (byte-exact contract surface). */
  readonly body: string
  /** Parsed form of {@link body} (detached copy of the ordered builder). */
  readonly value: WireObject
}

/** One decoded upstream SSE block: a `data:` payload with its `event:` name. */
export interface SseFrame {
  /** `event:` name when the enclosing block carried one. */
  readonly event?: string
  /** Payload after the `data:` prefix. */
  readonly data: string
}

/** Downstream framing mode selected by the `alt` parameter (section 4.1). */
export type DownstreamFraming = 'sse' | 'raw'

/** Translated stream event handed to the downstream framer. */
export type DownstreamStreamEvent =
  | { readonly kind: 'chunk'; readonly body: string }
  | { readonly kind: 'terminal-error'; readonly body: string; readonly status: number }

/** Context of the response (stream and non-stream) translation. */
export interface OpenAIToGeminiContext {
  /**
   * Model stamped into translated envelopes. Non-stream: the upstream
   * response `model` field. Stream: each upstream chunk's `model` field.
   */
  readonly streamModel: string
  /** `force-mapping: true` rewrites the model to the client-facing alias. */
  readonly forceMappingModel?: string
}
