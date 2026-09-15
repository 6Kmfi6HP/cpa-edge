/**
 * Wire types for the OpenAI Chat Completions -> Codex (Responses API)
 * translation direction.
 *
 * The Codex-side shapes describe what reaches the upstream wire; the
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
 * Upstream base URL a codex-api-key entry uses when its config omits
 * `base-url` (chatgpt.com backend, S2d5 section 2.2).
 */
export const CODEX_DEFAULT_BASE_URL = 'https://chatgpt.com/backend-api/codex'

/** Path appended to the base URL for Responses-API calls. */
export const CODEX_RESPONSES_PATH = '/responses'

/** Cloaked User-Agent the codex executor sends with cloaking enabled. */
export const CODEX_USER_AGENT =
  'codex-tui/0.154.0 (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; 0.154.0)'

/** Cloaked Originator header value. */
export const CODEX_ORIGINATOR = 'codex-tui'

/** Sessions inputs the facade derives from the client request. */
export interface CodexSessionContext {
  /** Downstream api key (Bearer token) - seeds the caller-scope hash. */
  readonly apiKey: string
  /** Value of a client session header (Session-Id, X-Session-ID, ...), if any. */
  readonly clientSessionId?: string
}

/** Request-translation inputs that come from the serving configuration. */
export interface ChatToCodexContext {
  /** Resolved upstream model name stamped onto the wire (never the alias). */
  readonly upstreamModel: string
  /**
   * Thinking capability of the resolved model entry. Absent (the default for
   * codex-api-key models declared in `models[]` without `thinking` support)
   * strips the whole `reasoning` object before the wire (S2d5 2.3).
   */
  readonly thinking?: boolean
  /** Session-identity inputs; absent disables derivation (empty identity). */
  readonly session?: CodexSessionContext
  /** `codex.disable-image-generation` - suppresses the injected image tool. */
  readonly disableImageGeneration?: boolean
}

/** Result of the chat -> Codex request translation. */
export interface CodexUpstreamRequest {
  /** Serialized upstream body (byte-exact contract surface). */
  readonly body: string
  /** Parsed form of {@link body}. */
  readonly value: WireObject
  /** `prompt_cache_key` body value (client value or derived session UUID). */
  readonly promptCacheKey: string
  /** `Session-Id` header value (client value or the same derived UUID). */
  readonly sessionHeaderValue: string
  /** Shortened -> original tool-name map for response-side restoration. */
  readonly nameMap: Readonly<Record<string, string>>
}

/** Downstream response-translation inputs. */
export interface CodexToChatContext {
  /**
   * Model name stamped into stream chunks before `response.created` arrives:
   * the resolved upstream (alias-target) name, not the client alias.
   */
  readonly streamModel: string
  /** Shortened -> original tool-name map from the request translation. */
  readonly nameMap?: Readonly<Record<string, string>>
  /** Epoch-seconds clock; used only when the upstream omits `created_at`. */
  readonly nowSeconds?: () => number
}

/** One decoded upstream SSE data line with its raw bytes. */
export interface CodexSseFrame {
  /** `event:` name when the enclosing block carried one (never read). */
  readonly event?: string
  /** Payload after the `data:` prefix, raw bytes preserved. */
  readonly data: string
}
