/**
 * Session / prompt-cache identity for the Codex upstream (S2d5 section 2.9).
 *
 * Observable contract (all pinned by recordings): every request carries BOTH
 * a body `prompt_cache_key` and a `Session-Id` header; with no client session
 * signal the two are the SAME value; the value is STABLE across identical
 * requests (same api key + system + first user message); assistant content
 * never enters the identity; a client body `prompt_cache_key` or session
 * header passes through verbatim. The derivation itself mirrors the
 * documented chain - caller-scope SHA-256, canonical-JSON identity root,
 * `ctx:v1` prefix, SHA-1 UUID v5 under the OID namespace - but exact-UUID
 * mirroring is explicitly OPTIONAL (spec section 7, question 1): contract
 * tests mask the value.
 */
import { serializeOrdered } from './json'
import type { WireObject, WireValue } from './types'

const encoder = new TextEncoder()

/** SHA-256 of a UTF-8 string as lowercase hex (Web Crypto, no Node APIs). */
export async function sha256Hex(seed: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(seed))
  return hex(new Uint8Array(digest))
}

function hex(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}

/** UUID v5 namespace of the registered OID tree (6ba7b810-...430c8). */
const OID_NAMESPACE: readonly number[] = Object.freeze([
  0x6b, 0xa7, 0xb8, 0x10, 0x9d, 0xad, 0x11, 0xd1, 0x80, 0xb4, 0x00, 0xc0, 0x4f, 0xd4, 0x30, 0xc8,
])

/** UUIDv5 name component of the derived codex session. */
const DERIVED_SESSION_NAME = 'cli-proxy-api\0codex\0derived-session\0'

/** Fallback seed prefix for conversations with no user content. */
const NO_USER_FALLBACK_PREFIX = 'cli-proxy-api:codex:prompt-cache:'

/** Caller-scope seed prefix (the null byte separates prefix from key). */
const CALLER_SCOPE_PREFIX = 'cli-proxy-api:caller-scope:v1\0'

/** Canonical identity-root version tag. */
const ROOT_VERSION = 'cpa-session-root-v1'

/**
 * Source-format tag of the identity root. The reference's internal format
 * identifier for OpenAI chat clients is not wire-observable (the UUID is
 * masked in every comparison), so the exact literal is not contract
 * material; this one is stable across requests.
 */
const ROOT_FORMAT = 'openai'

/** Derives the caller-scope hash over the client api key. */
export async function callerScopeHash(apiKey: string): Promise<string> {
  return sha256Hex(CALLER_SCOPE_PREFIX + apiKey)
}

/** Formats 16 bytes as a lowercase hyphenated UUID. */
function formatUuid(bytes: readonly number[]): string {
  const hexText = hex(Uint8Array.from(bytes))
  return `${hexText.slice(0, 8)}-${hexText.slice(8, 12)}-${hexText.slice(12, 16)}-${hexText.slice(16, 20)}-${hexText.slice(20)}`
}

/** Builds a UUIDv5 (SHA-1) over `name` under the OID namespace. */
export async function uuidV5(name: string): Promise<string> {
  const seed = new Uint8Array(OID_NAMESPACE.length + name.length)
  seed.set(OID_NAMESPACE, 0)
  seed.set(encoder.encode(name), OID_NAMESPACE.length)
  const digest = await crypto.subtle.digest('SHA-1', seed)
  const bytes = Array.from(new Uint8Array(digest).slice(0, 16))
  // version 5
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50
  // RFC 4122 variant
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  return formatUuid(bytes)
}

/** Truncates a text to its first `limit` runes (Unicode code points). */
export function truncateRunes(text: string, limit: number): string {
  const runes = Array.from(text)
  return runes.length <= limit ? text : runes.slice(0, limit).join('')
}

/** Inputs of the identity-root derivation. */
export interface CodexSessionIdentityInput {
  /** Downstream api key (Bearer token) - caller-scope seed. */
  readonly apiKey: string
  /**
   * System/developer message texts of the request, in conversation order,
   * each already truncated to 50 runes.
   */
  readonly instructions: readonly string[]
  /** Canonical content parts of the FIRST user message, in part order. */
  readonly userParts: readonly WireValue[]
  /** Client session-header value when one was present (root field). */
  readonly clientSessionId?: string
}

/**
 * Serializes the canonical identity root. Fields follow the recorded chain
 * ({version, format, caller_scope, instructions, [session], user}); member
 * order is the insertion order of the builder.
 */
function canonicalRoot(input: CodexSessionIdentityInput, callerScope: string): string {
  const root: WireObject = {
    version: ROOT_VERSION,
    format: ROOT_FORMAT,
    caller_scope: callerScope,
    instructions: [...input.instructions],
  }
  if (input.clientSessionId !== undefined) root['session'] = input.clientSessionId
  root['user'] = [...input.userParts]
  return serializeOrdered(root)
}

/**
 * Derives the session UUID (the `prompt_cache_key` / `Session-Id` value) for
 * a request that carried no client session signal. With no user content the
 * root is empty and the identity falls back to a UUIDv5 over the api key.
 */
export async function deriveCodexSessionId(input: CodexSessionIdentityInput): Promise<string> {
  const callerScope = await callerScopeHash(input.apiKey)
  if (input.userParts.length === 0) {
    return uuidV5(NO_USER_FALLBACK_PREFIX + input.apiKey)
  }
  const rootDigest = await sha256Hex(canonicalRoot(input, callerScope))
  return uuidV5(DERIVED_SESSION_NAME + 'ctx:v1:' + rootDigest)
}
