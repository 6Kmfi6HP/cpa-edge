/**
 * Wire types for the Gemini client -> Claude Messages translation direction.
 *
 * Claude-side shapes describe what reaches the upstream wire; Gemini-side
 * shapes describe what the client sends and what the gateway emits
 * downstream. Bodies are serialized through the insertion-order serializer,
 * so the property order of every builder here is part of the contract.
 */
import type { WireObject } from './json'

export type { WireObject, WireValue } from './json'

/** Upstream path for the Messages API; `?beta=true` is always present. */
export const CLAUDE_MESSAGES_PATH = '/v1/messages?beta=true'

/**
 * Thinking capability declared on a model entry.
 *
 * - `budget`: the model declares a token-budget window.
 * - `levels`: the model understands named reasoning levels (adaptive).
 * - absent: the model is capability-less; any translated thinking
 *   configuration is stripped before the wire (recorded: S2d7-08).
 */
export type ModelThinkingCapability =
  | { readonly kind: 'budget'; readonly min: number; readonly max: number }
  | { readonly kind: 'levels'; readonly levels: readonly string[] }

/**
 * Serving configuration the translator needs beyond the request body: the
 * provider-resolved upstream model name and the model's thinking
 * capability.
 */
export interface GeminiToClaudeContext {
  /** Provider-resolved model name stamped onto the wire. */
  readonly upstreamModel: string
  /** Thinking capability of the selected model entry (absent = strip). */
  readonly thinking?: ModelThinkingCapability
}

/** Result of the Gemini -> Claude request translation. */
export interface ClaudeUpstreamRequest {
  /** Serialized upstream body (byte-exact contract surface). */
  readonly body: string
  /** Parsed form of {@link body}. */
  readonly value: WireObject
}

/**
 * Structural translation shared by the generation and token-count paths:
 * the assembled Claude messages, tools and tool_choice before the executor
 * stages (metadata, stream flag, cache breakpoints) are applied.
 */
export interface ClaudeContentAssembly {
  readonly messages: readonly { readonly role: 'user' | 'assistant'; readonly content: WireObject[] }[]
  readonly tools: WireObject[]
  readonly toolChoice: WireObject | undefined
}

/** Claude SSE frame as decoded from the upstream body. */
export interface SseFrame {
  /** `event:` name when the enclosing block carried one. */
  readonly event?: string
  /** Payload after the `data:` prefix (frames are emitted per data line). */
  readonly data: string
}

/** Downstream response-translation inputs. */
export interface ClaudeToGeminiContext {
  /**
   * Model name stamped into NON-STREAM bodies: the gateway-resolved model
   * (the executor argument), never the upstream echo. Stream chunks read
   * `modelVersion` from the upstream `message_start` instead.
   */
  readonly resolvedModel: string
  /** Epoch-milliseconds clock; every timestamp decision uses it. */
  readonly now?: () => number
}

/**
 * Downstream framing mode of a `streamGenerateContent` response, decided by
 * the `alt` query parameter: SSE framing (`alt=sse`, empty or absent) or
 * raw chunk concatenation (any other value, e.g. `alt=json`).
 */
export type DownstreamFraming = 'sse' | 'raw'
