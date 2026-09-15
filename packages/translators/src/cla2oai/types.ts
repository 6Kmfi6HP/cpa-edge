/**
 * Wire types and serving contexts for the Claude client -> OpenAI
 * (chat completions) upstream direction (S2d4).
 *
 * Claude-shaped values arrive as raw client bytes; the translator derives
 * ordered OpenAI bodies from them. Field order matters on every
 * serialized surface here: the upstream body and every downstream event
 * are emitted through the insertion-order serializer, so the property
 * order in these types is part of the contract.
 */
import type { WireObject } from './json'

export type { WireObject, WireValue } from './json'

/** Ordered header list: `[name, value]` pairs, original casing. */
export type HeaderList = ReadonlyArray<readonly [string, string]>

/**
 * Thinking capability of the selected model entry. openai-compat models
 * without explicit thinking configuration use
 * {@link DEFAULT_OPENAI_COMPAT_THINKING} (levels low/medium/high; disable
 * and dynamic are both disallowed - the recorded effective table).
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
 * Serving configuration the request translation needs (section 3.1).
 * `upstreamModel` is the alias-resolved upstream name; `isCompat` selects
 * the thinking->reasoning_content mapping of `is-compat: true` model
 * entries (recorded: S2d4-compat-thinking keeps an unsigned thinking
 * block).
 */
export interface Cla2OaiContext {
  /** Credential-resolved upstream model stamped onto `model`. */
  readonly upstreamModel: string
  /** Execution mode: mirrors the client `stream` truthiness rule (2.1). */
  readonly stream: boolean
  /** `is-compat` flag of the resolved model entry. */
  readonly isCompat?: boolean
  /** Thinking capability of the resolved model entry. */
  readonly thinking?: ThinkingCapability
}

/** Result of the Claude -> OpenAI request translation. */
export interface Cla2OaiUpstreamBody {
  /** Serialized upstream body (byte-exact contract surface). */
  readonly body: string
  /** Parsed form of {@link body}. */
  readonly value: WireObject
  /** Request tool objects (name restore on the response side). */
  readonly requestTools: readonly WireObject[]
}

/**
 * Reverses the model-id cloaking the Claude model list applies
 * (section 2.1): `claude-fable-5-dd-<reversed name>` decodes back to the
 * underlying model name before routing. Anything else returns unchanged.
 */
export const MODEL_CLOAK_PREFIX = 'claude-fable-5-dd-'

/** Cloaking-form model id -> the underlying model name; non-cloaked ids pass through. */
export function decodeCloakedModelId(model: string): string {
  if (!model.startsWith(MODEL_CLOAK_PREFIX)) return model
  return model.slice(MODEL_CLOAK_PREFIX.length).split('').reverse().join('')
}
