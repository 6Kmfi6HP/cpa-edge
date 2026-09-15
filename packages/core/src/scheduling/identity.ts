/**
 * Credential identity derivations for config-synthesized api-key credentials.
 *
 * Two stable identifiers come out of this module:
 *
 * - the credential (auth) ID `<kind>:<12 hex>` - rotation order is defined
 *   over its ascending byte order, so the derivation is client-observable
 *   through which credential serves which request;
 * - the `auth_index` - 16 lowercase hex characters used as the stable
 *   observability identity on management, usage and plugin surfaces.
 *
 * Both are pure functions of their inputs (plus SHA-256 via WebCrypto). The
 * recorded values that pin this contract live in the S4 fixtures
 * (S4-01/S4-07/S4-20); the tests reproduce them byte for byte.
 */

/** Families of config-synthesized api-key credentials. */
export type ApiKeyCredentialFamily =
  | 'openai-compatibility'
  | 'gemini'
  | 'interactions'
  | 'claude'
  | 'codex'
  | 'xai'
  | 'meta'
  | 'vertex'

/** Identity-relevant fields of one config credential entry. */
export interface CredentialEntryParts {
  readonly apiKey?: string | undefined
  readonly baseUrl?: string | undefined
  readonly proxyUrl?: string | undefined
  readonly prefix?: string | undefined
  /** Extra upstream headers of the entry; folded into one sorted string. */
  readonly headers?: Readonly<Record<string, string>> | undefined
}

/** The stable credential ID plus the inputs it was derived from. */
export interface CredentialIdentity {
  /** Full credential ID: `<kind>:<12 hex>`, optionally `-N` when repeated. */
  readonly id: string
  /** The kind prefix, e.g. `gemini:apikey`. */
  readonly kind: string
  /** Raw 12-hex identity digest (before any `-N` disambiguation). */
  readonly digest: string
}

/**
 * Serializes an entry's header overrides into one string with keys in
 * ascending byte order. The exact separator is not pinned by any recorded
 * fixture; `key=value` pairs joined with `&` is the convention chosen here.
 * Swap this function (or its constant) if a future recording pins the bytes.
 */
export function formatSortedHeaders(headers: Readonly<Record<string, string>>): string {
  const keys = Object.keys(headers).sort()
  const pairs: string[] = []
  for (const key of keys) {
    pairs.push(`${key}=${headers[key] ?? ''}`)
  }
  return pairs.join('&')
}

/** Hashes `kind` plus each part; every part is NUL-prefixed and trimmed. */
export async function stableCredentialDigest(kind: string, parts: readonly string[]): Promise<string> {
  const payload = new TextEncoder().encode(
    kind +
      parts
        .map((part) => `\0${part.trim()}`)
        .join(''),
  )
  const bytes = await crypto.subtle.digest('SHA-256', payload)
  const hex = Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')
  return hex.slice(0, 12)
}

/**
 * Kind string for an `openai-compatibility` entry: the family name plus the
 * lowercased provider name, or the bare family name when the name is blank.
 */
export function openAiCompatibilityKind(name: string | undefined): string {
  const trimmed = (name ?? '').trim()
  if (trimmed === '') return 'openai-compatibility'
  return `openai-compatibility:${trimmed.toLowerCase()}`
}

/**
 * Part list of one family entry. `openai-compatibility` entries carry three
 * parts; `vertex` entries drop prefix and headers; the remaining families
 * carry five parts (api-key, base-url, proxy-url, prefix, sorted headers).
 */
function entryParts(family: ApiKeyCredentialFamily, entry: CredentialEntryParts): string[] {
  const apiKey = entry.apiKey ?? ''
  const baseUrl = entry.baseUrl ?? ''
  const proxyUrl = entry.proxyUrl ?? ''
  if (family === 'openai-compatibility') return [apiKey, baseUrl, proxyUrl]
  if (family === 'vertex') return [apiKey, baseUrl, proxyUrl]
  const prefix = entry.prefix ?? ''
  const headers = formatSortedHeaders(entry.headers ?? {})
  return [apiKey, baseUrl, proxyUrl, prefix, headers]
}

/** Kind string for one family (`interactions` reuses the gemini part list). */
function familyKind(family: ApiKeyCredentialFamily, providerName: string | undefined): string {
  switch (family) {
    case 'openai-compatibility':
      return openAiCompatibilityKind(providerName)
    case 'gemini':
      return 'gemini:apikey'
    case 'interactions':
      return 'gemini-interactions:apikey'
    case 'claude':
      return 'claude:apikey'
    case 'codex':
      return 'codex:apikey'
    case 'xai':
      return 'xai:apikey'
    case 'meta':
      return 'meta:apikey'
    case 'vertex':
      return 'vertex:apikey'
  }
}

/** Computes the raw `<kind>:<12 hex>` identity of one config entry. */
export async function deriveCredentialIdentity(
  family: ApiKeyCredentialFamily,
  entry: CredentialEntryParts,
  providerName?: string,
): Promise<CredentialIdentity> {
  const kind = familyKind(family, providerName)
  const digest = await stableCredentialDigest(kind, entryParts(family, entry))
  return { id: `${kind}:${digest}`, kind, digest }
}

/**
 * Identity of the single credential synthesized for an `openai-compatibility`
 * provider that lists no `api-key-entries`: only the base-url takes part.
 */
export async function deriveEntrylessCompatibilityIdentity(
  baseUrl: string,
  providerName?: string,
): Promise<CredentialIdentity> {
  const kind = openAiCompatibilityKind(providerName)
  const digest = await stableCredentialDigest(kind, [baseUrl])
  return { id: `${kind}:${digest}`, kind, digest }
}

/**
 * Issuer of disambiguated credential IDs: identical derivations from the
 * same generator receive a `-N` counter suffix (`-2`, `-3`, ...), matching a
 * monotonically increasing occurrence counter. No fixture pins the first
 * suffix value; the counter form chosen here starts the suffix at 2 so the
 * plain form stays reserved for the first credential. Create one generator
 * per synthesis run - it holds per-instance state only.
 */
export class StableIdGenerator {
  private readonly seen = new Map<string, number>()

  /** Registers an identity and returns its unique ID. */
  issue(identity: CredentialIdentity): string {
    const count = (this.seen.get(identity.digest) ?? 0) + 1
    this.seen.set(identity.digest, count)
    if (count === 1) return identity.id
    return `${identity.id}-${count}`
  }
}

/**
 * Family literals eligible for the base-url+api-key seed form of
 * `auth_index`. Vertex has no case in the upstream switch, so
 * `vertex-api-key` credentials never use this form.
 */
export const AUTH_INDEX_FAMILIES: readonly string[] = Object.freeze([
  'gemini-api-key',
  'interactions-api-key',
  'codex-api-key',
  'xai-api-key',
  'claude-api-key',
  'meta-api-key',
  'openai-compatibility',
])

/** Inputs of the `auth_index` seed, in the order they are consulted. */
export interface AuthIndexSeedInput {
  /** Plugin-provided seed attribute, when the credential came from a plugin. */
  readonly pluginSeed?: string | undefined
  /**
   * Effective file path of a file-backed credential (attributes `path` /
   * `source`, else the file name, else the auth ID), already absolutized by
   * the caller. Only consulted while it ends in `.json`; config-synthesized
   * sources (`config:<name>[<token>]`) never match.
   */
  readonly filePath?: string | undefined
  /** Auth type or lowercased provider paired with `filePath`. */
  readonly fileKind?: string | undefined
  /** Family literal when the credential is an api-key credential. */
  readonly familyLiteral?: string | undefined
  readonly baseUrl?: string | undefined
  readonly apiKey?: string | undefined
  /** Full credential ID, used by the fallback seed. */
  readonly authId: string
}

/**
 * Chooses the seed string for the `auth_index`, in this order: plugin seed
 * attribute, `.json` file path, api-key family literal, `id:` fallback.
 */
export function authIndexSeed(input: AuthIndexSeedInput): string {
  const pluginSeed = input.pluginSeed
  if (pluginSeed !== undefined && pluginSeed !== '') {
    return `auth_index_seed:${pluginSeed}`
  }
  const filePath = input.filePath
  if (filePath !== undefined && filePath !== '' && filePath.endsWith('.json')) {
    if (input.fileKind !== undefined && input.fileKind !== '') {
      return `${input.fileKind}:${filePath}`
    }
  }
  const family = input.familyLiteral
  const apiKey = input.apiKey
  if (
    family !== undefined &&
    apiKey !== undefined &&
    apiKey !== '' &&
    (AUTH_INDEX_FAMILIES as readonly string[]).includes(family)
  ) {
    return `${family}:${input.baseUrl ?? ''}+${apiKey}`
  }
  return `id:${input.authId}`
}

/** Hashes a seed to the 16-hex-char `auth_index`. */
export async function authIndexFromSeed(seed: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(seed))
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16)
}

/** Derives the `auth_index` of one credential. */
export async function deriveAuthIndex(input: AuthIndexSeedInput): Promise<string> {
  return authIndexFromSeed(authIndexSeed(input))
}

/**
 * Sorts credential IDs the way every rotation order does: ascending byte
 * order (lexicographic UTF-16 code-unit order over the ASCII IDs).
 */
export function ascendingCredentialOrder<T extends { readonly id: string }>(entries: readonly T[]): T[] {
  return [...entries].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
}
