/**
 * Wire types for the Claude client -> Gemini (gemini-api-key) translation
 * direction (S2d8).
 *
 * Claude-side shapes describe the client request and the downstream
 * Messages body/events; Gemini-side shapes describe the upstream
 * generateContent wire. Bodies are serialized through the
 * insertion-order serializer, so the property order of every builder here
 * is part of the contract. The upstream top-level key order is pinned by
 * recordings: contents, model, systemInstruction, tools, toolConfig,
 * generationConfig, safetySettings.
 */
import type { WireObject } from './json'

export type { WireObject, WireValue } from './json'

/**
 * Thinking capability of the resolved model entry, as the executor
 * capability pass sees it (S2d8 section 3.1, thinking row).
 *
 * - `unsupported`: capability info resolved, thinking unsupported - the
 *   Stage-2 pass deletes `generationConfig.thinkingConfig` (recorded:
 *   S2d8-07/10 keep `"generationConfig":{}`).
 * - `budget`: resolved with a token-budget window; adaptive requests
 *   without an effort map to the registry max.
 * - `levels`: resolved with named levels.
 * - absent: user-defined/unresolved model - the Stage-1 configuration is
 *   kept verbatim and the upstream validates it.
 */
export type Cla2GemThinkingCapability =
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'budget'; readonly min: number; readonly max: number }
  | { readonly kind: 'levels'; readonly levels: readonly string[] }

/** Serving configuration the request translation needs. */
export interface Cla2GemContext {
  /** Credential-resolved upstream model stamped onto the wire. */
  readonly upstreamModel: string
  /**
   * Capability of the resolved model entry; absent means user-defined or
   * unresolved (the Stage-2 strip never runs).
   */
  readonly thinking?: Cla2GemThinkingCapability
}

/** Result of the Claude -> Gemini request translation. */
export interface Cla2GemUpstreamBody {
  /** Serialized upstream body (byte-exact contract surface). */
  readonly body: string
  /** Parsed form of {@link body}. */
  readonly value: WireObject
  /** Request tool objects (name restore on the response side). */
  readonly requestTools: readonly WireObject[]
}

/** Downstream response-translation input (non-stream). */
export interface GeminiResponseContext {
  /** Original client request text (raw bytes, for raw-argument splicing). */
  readonly upstreamBody: string
  /** Name-restore index built from the request's tools. */
  readonly toolNames: import('./schema').ToolNameIndex
}

/** Default id/model of the stream `message_start` template (recorded). */
export const DEFAULT_STREAM_MESSAGE_ID = 'msg_1nZdL29xx5MUA1yADyHTEsnR8uuvGzszyY'
export const DEFAULT_STREAM_MODEL = 'claude-3-5-sonnet-20241022'

/** Fixed sentinel stamped on the first synthesized functionCall of a turn. */
export const THOUGHT_SIGNATURE_SENTINEL = 'skip_thought_signature_validator'
