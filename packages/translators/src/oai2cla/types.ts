/**
 * Wire types for the OpenAI Chat Completions -> Claude (Anthropic Messages)
 * translation direction.
 *
 * The Claude-side shapes describe what reaches the upstream wire; the
 * OpenAI-side shapes describe what the client may send and what the gateway
 * emits downstream. Field order matters: bodies are serialized through an
 * insertion-order serializer that reproduces the recorded key order, so the
 * property order in these types is part of the contract.
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

/**
 * Thinking capability declared on a `models[]` entry for the upstream model.
 *
 * - `budget`: the entry declares a token-budget window (`thinking.min/max`).
 * - `levels`: the entry declares the reasoning levels it understands.
 * - absent: the model is capability-less for thinking and any thinking
 *   configuration derived from the client request is stripped before the wire.
 */
export type ModelThinkingCapability =
  | { readonly kind: 'budget'; readonly min: number; readonly max: number }
  | { readonly kind: 'levels'; readonly levels: readonly string[] }

/** Model name suffix semantics, e.g. alias `cm(4096)`. */
export interface ModelSuffix {
  /** Alias/model name with the suffix removed. */
  readonly base: string
  /** Numeric suffix value, when the parentheses carried a number. */
  readonly budgetTokens?: number
}

/** Identity values injected by the `claude-code-cli` fingerprint profile. */
export interface ClaudeCodeCliIdentity {
  /** `X-Claude-Code-Session-Id` value; also embedded in metadata.user_id. */
  readonly sessionId: string
  /** Claude Code account UUID recorded in metadata.user_id. */
  readonly accountUuid: string
  /** Device fingerprint recorded in metadata.user_id. */
  readonly deviceId: string
  /** Calendar date (`YYYY-MM-DD`) stamped into the system-reminder block. */
  readonly date: string
}

/**
 * Request-translation inputs that come from the serving configuration.
 * Everything here is caller-supplied; the translator derives the rest from
 * the request body alone.
 */
export interface ChatToClaudeContext {
  /**
   * Upstream (alias-target) model name that replaces the client's `model`
   * on the wire. When omitted, the client model name is used after suffix
   * stripping.
   */
  readonly upstreamModel?: string
  /** Thinking capability of the selected model entry (absent = strip). */
  readonly thinking?: ModelThinkingCapability
  /**
   * `models[].is-compat: true`: assistant `reasoning_content` history is
   * replayed as a leading unsigned thinking block (S2d3 case 19).
   */
  readonly compat?: boolean
  /** `fingerprint-profile: claude-code-cli` wire identity (S2d3 case 21). */
  readonly fingerprintProfile?: 'claude-code-cli'
  /** Identity values for the CLI fingerprint profile. */
  readonly cliIdentity?: ClaudeCodeCliIdentity
}

/** Upstream request produced by the chat -> Claude translation. */
export interface ClaudeUpstreamRequest {
  /** Serialized upstream body (byte-exact contract surface). */
  readonly body: string
  /** Parsed form of {@link body} (detached copy of the ordered builder). */
  readonly value: WireObject
  /** Suffix parsed off the client model, when one was present. */
  readonly modelSuffix?: ModelSuffix
}

/** Upstream path for the Messages API, `?beta=true` always present. */
export const CLAUDE_MESSAGES_PATH = '/v1/messages?beta=true'

/** Claude SSE frame as decoded from the upstream body. */
export interface SseFrame {
  /** `event:` name when the enclosing block carried one. */
  readonly event?: string
  /** Payload after the `data:` prefix (frames are emitted per data line). */
  readonly data: string
}

/** Downstream response-translation inputs. */
export interface ClaudeToChatContext {
  /**
   * Model name stamped into stream chunks: the routed upstream (alias-target)
   * name the gateway requested, not the client alias.
   */
  readonly streamModel: string
  /** Server epoch in seconds, sampled when message_start arrives. */
  readonly nowSeconds?: () => number
}
