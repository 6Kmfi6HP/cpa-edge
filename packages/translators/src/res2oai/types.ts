/**
 * Wire types for the Responses client -> OpenAI chat-completions
 * translation direction (S2d6).
 *
 * Chat-side shapes describe what reaches the upstream wire; Responses-side
 * shapes describe what the client sends and what the gateway emits
 * downstream. Bodies are serialized through the insertion-order serializer,
 * so the property order of every builder here is part of the contract.
 */
import type { WireObject } from './json'

export type { WireObject, WireValue } from './json'

/** Upstream path appended to a provider base URL for chat calls. */
export const CHAT_COMPLETIONS_PATH = '/chat/completions'

/** Upstream path appended to a provider base URL for compact calls. */
export const RESPONSES_COMPACT_PATH = '/responses/compact'

/** Fixed upstream user agent of the openai-compatibility executor. */
export const OPENAI_COMPAT_USER_AGENT = 'cli-proxy-openai-compat'

/** One declared chat tool, kept for response-side name restoration. */
export interface DeclaredTool {
  /** Name stamped onto the upstream wire (namespace-qualified when applicable). */
  readonly chatName: string
  /** Name the client used (unqualified). */
  readonly originalName: string
  /** Namespace the tool was declared under, when any. */
  readonly namespace?: string
  /** True for `type: "custom"` tools (single freeform `input` argument). */
  readonly custom: boolean
}

/** Request-translation inputs beyond the client body. */
export interface ResponsesToChatContext {
  /** Provider-resolved model name stamped onto the wire (never the alias). */
  readonly upstreamModel: string
}

/** Result of the Responses -> chat request translation. */
export interface ChatUpstreamRequest {
  /** Serialized upstream body (byte-exact contract surface). */
  readonly body: string
  /** Parsed form of {@link body}. */
  readonly value: WireObject
  /** Declared tools in production order (dedup applied). */
  readonly tools: readonly DeclaredTool[]
  /** Chat-format tool entries (echo source of the non-stream response). */
  readonly chatTools: readonly WireObject[]
  /** Translated `tool_choice`, when tools were declared. */
  readonly toolChoice: WireObject | undefined
  /** Translated `max_tokens`, when the request carried `max_output_tokens`. */
  readonly maxTokens: number | undefined
  /** Translated `reasoning_effort`, when the request carried one. */
  readonly reasoningEffort: string | undefined
}

/** Non-stream response-translation inputs. */
export interface ChatToResponsesContext {
  /**
   * Model name stamped into NON-STREAM bodies: the gateway-resolved
   * upstream model, never the client alias (recorded echo quirk).
   */
  readonly resolvedModel: string
  /** Declared tools from the request translation (name restoration). */
  readonly tools: readonly DeclaredTool[]
  /** Chat-format tools produced by the request translation (echo source). */
  readonly chatTools: readonly WireObject[]
  /** Translated tool_choice echoed back in chat shape, when present. */
  readonly toolChoice: WireObject | undefined
  /** Translated max_tokens echoed back as `max_output_tokens`, when present. */
  readonly maxTokens: number | undefined
  /** Epoch-milliseconds clock; drives `created_at` synthesis. */
  readonly now: () => number
}

/** Stream-translation inputs. */
export interface ChatToResponsesStreamContext {
  /** Client-requested model alias stamped into stream events. */
  readonly requestedModel: string
  /** Gateway-resolved upstream model (fallback when the alias is absent). */
  readonly resolvedModel: string
  /** Declared tools from the request translation (name restoration). */
  readonly tools: readonly DeclaredTool[]
  /** Raw original request body; the terminal event echoes its fields. */
  readonly originalBody: string
}

/** One decoded upstream SSE data line. */
export interface SseFrame {
  /** `event:` name when the enclosing block carried one. */
  readonly event?: string
  /** Payload after the `data:` prefix. */
  readonly data: string
}

/** Marker literal that terminates an upstream chat SSE stream. */
export const UPSTREAM_DONE = '[DONE]'
