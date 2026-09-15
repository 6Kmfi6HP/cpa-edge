/**
 * Wire types and serving contexts for the OpenAI chat -> Gemini
 * (GenerateContent) direction (S2d1).
 *
 * Field order is contract material on every serialized surface here: the
 * upstream body is emitted through the insertion-order serializer with
 * raw-spliced client values, and the downstream envelopes follow the
 * recorded key order (section 3.3/3.4 of the spec).
 */
import type { WireObject, WireValue } from './json'

/** Ordered header list: `[name, value]` pairs, original casing. */
export type HeaderList = ReadonlyArray<readonly [string, string]>

/**
 * Thinking capability of the selected `models[]` entry. Config-declared
 * `gemini-api-key` models WITHOUT this block resolve as capability-known
 * but thinking-less: the executor pass strips a translated
 * `generationConfig.thinkingConfig` (leaving `generationConfig` possibly
 * `{}`) and drops a model-name thinking suffix (fixtures C07/C08). An
 * entry that declares `levels` marks the model thinking-capable and the
 * translated thinking intent survives (config-dependent path, not
 * golden-covered).
 */
export interface ThinkingCapability {
  /** Reasoning levels the model understands, ladder order. */
  readonly levels: readonly string[]
}

/**
 * Request-translation context supplied by the serving configuration.
 * Everything else derives from the request body alone.
 */
export interface ChatToGeminiContext {
  /** Upstream base model stamped onto the body `model` (suffix stripped). */
  readonly upstreamModel: string
  /**
   * Thinking intent parsed from a `alias(<suffix>)` model suffix. The
   * capability pass decides whether it reaches the wire.
   */
  readonly suffixLevel?: string
  /** Thinking capability of the selected model entry; absent = none. */
  readonly thinking?: ThinkingCapability
}

/** Upstream request produced by the translation. */
export interface GeminiUpstreamRequest {
  /** Serialized upstream body (byte-exact contract surface). */
  readonly body: string
  /** Parsed form of {@link body} (detached copy of the ordered builder). */
  readonly value: WireObject
}

/**
 * Response-translation context. The downstream `model` field mirrors the
 * upstream `modelVersion` (literal `"model"` when absent); with
 * `force-mapping` the alias replaces it on every envelope and chunk.
 */
export interface GeminiToChatContext {
  /** `force-mapping: true` rewrites the model to the client-facing alias. */
  readonly forceMappingModel?: string
  /**
   * Millisecond clock; feeds the `<name>-<unix-nano>-<counter>` tool-call
   * id digits.
   */
  readonly nowMs: () => number
  /** Monotonic tool-call sequence shared by the serving instance. */
  readonly nextToolCallSeq: () => number
}

/** One downstream stream event handed to the SSE framer. */
export type DownstreamStreamEvent =
  | { readonly kind: 'chunk'; readonly body: string }
  | { readonly kind: 'terminal-error'; readonly body: string }

/** A data-URL split into its media type and base64 payload. */
export interface DataUrlParts {
  readonly mediaType: string
  readonly data: string
}

/** Union alias re-exported for tests of the ordered builder. */
export type { WireObject, WireValue }
