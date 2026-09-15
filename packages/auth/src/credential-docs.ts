import { isJsonValue, type JsonValue, type Store } from '@cpa-edge/core'
import { sha256Hex } from './crypto-util'

/**
 * Auth-file document models (S3 §3.2 / S6 §3.4).
 *
 * One credential is one Store document in namespace `auth`, keyed by the
 * auth-file name. JSON field names are public interface. Loading rules:
 * only `*.json` keys (case-insensitive), `type` selects the provider
 * (trimmed; missing reads as `unknown` and synthesizes nothing),
 * `type: gemini` in any casing is silently skipped (v7.3.4 has no
 * Gemini-CLI credential support), invalid `weight` values drop the whole
 * file, and saves always materialize `disabled`.
 */

/** Store namespace holding one document per auth file. */
export const AUTH_FILES_NAMESPACE = 'auth'

/** Highest valid credential weight; larger values are file-level invalid. */
export const MAX_CREDENTIAL_WEIGHT = 1_000_000

/** Sanitizes an identifier for file names: unsafe chars become `_`. */
export function sanitizeFileToken(value: string): string {
  return value.replace(/[^A-Za-z0-9-_.@]/g, '_')
}

/** Lowercases, then maps non-alphanumerics to `-` (Codex plan tags). */
export function sanitizePlanTag(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '-')
}

function requiresHashFallback(identifier: string): boolean {
  const sanitized = sanitizeFileToken(identifier)
  return sanitized !== identifier || sanitized.length > 160
}

/** First 8 hex chars of SHA-256, the short digest used in file names. */
export async function shortHash(text: string): Promise<string> {
  return (await sha256Hex(text)).slice(0, 8)
}

/** Builds the Claude auth-file name from identity fields. */
export async function claudeFileName(input: {
  readonly organizationUuid?: string
  readonly accountUuid?: string
  readonly email: string
}): Promise<string> {
  const uuid = input.organizationUuid ?? input.accountUuid
  if (uuid === undefined || uuid.length === 0) return `claude-${input.email}.json`
  const hash = await shortHash(uuid)
  return `claude-${hash}-${input.email}.json`
}

/** Builds the Codex auth-file name; the plan tag is optional. */
export async function codexFileName(input: {
  readonly accountId?: string
  readonly email: string
  readonly plan?: string
}): Promise<string> {
  const plan = input.plan === undefined || input.plan.length === 0 ? '' : `-${sanitizePlanTag(input.plan)}`
  const account = input.accountId
  if (account === undefined || account.length === 0) {
    return `codex-${input.email}${plan}.json`
  }
  const hash = await shortHash(account)
  return `codex-${hash}-${input.email}${plan}.json`
}

/** Antigravity: `antigravity.json` when no email is known. */
export function antigravityFileName(email?: string): string {
  if (email === undefined || email.length === 0) return 'antigravity.json'
  return `antigravity-${email}.json`
}

/**
 * Devin: identifier is user_name, else user_id, else `user-<hash8>` of the
 * session token; unsafe chars become `_`, and a hash fallback replaces an
 * identifier whose sanitized form changed or exceeded 160 chars.
 */
export async function devinFileName(input: {
  readonly userName?: string
  readonly userId?: string
  readonly sessionToken: string
}): Promise<string> {
  const identifier = input.userName ?? input.userId ?? `user-${await shortHash(input.sessionToken)}`
  if (requiresHashFallback(identifier)) {
    return `devin-user-${await shortHash(input.sessionToken)}.json`
  }
  return `devin-${sanitizeFileToken(identifier)}.json`
}

/** Kimi files are stamped with the login time in unix milliseconds. */
export function kimiFileName(nowMs: number): string {
  return `kimi-${nowMs}.json`
}

/** xAI: sanitized email, else sanitized `sub`, else a unix-ns stamp. */
export function xaiFileName(input: {
  readonly email?: string
  readonly sub?: string
  readonly nowMs: number
}): string {
  if (input.email !== undefined && input.email.length > 0) {
    return `xai-${sanitizeFileToken(input.email)}.json`
  }
  if (input.sub !== undefined && input.sub.length > 0) {
    return `xai-${sanitizeFileToken(input.sub)}.json`
  }
  return `xai--${(input.nowMs * 1_000_000).toString()}.json`
}

/** Meta: sanitized email plus an 8-hex digest of the access token. */
export async function metaFileName(input: {
  readonly email?: string
  readonly accessToken: string
}): Promise<string> {
  const hash = await shortHash(input.accessToken)
  const email = input.email === undefined || input.email.length === 0 ? 'unknown' : input.email
  return `meta-${sanitizeFileToken(email)}-${hash}.json`
}

/** Vertex: `vertex-<sanitized project>.json`, created only by import. */
export function vertexFileName(projectId: string): string {
  return `vertex-${sanitizeFileToken(projectId)}.json`
}

/**
 * Reason a candidate auth file is not loaded as a credential; synthesizer
 * behavior for each reason is documented, never silently ignored.
 */
export type AuthFileSkipReason = 'not-json-key' | 'not-object' | 'gemini' | 'invalid-weight'

/** A successfully parsed auth file. */
export interface LoadedAuthFile {
  /** Store key (= auth-file name). */
  readonly name: string
  /** Normalized provider (`type` trimmed and lowercased; `unknown` if absent). */
  readonly provider: string
  readonly document: Record<string, JsonValue>
  readonly disabled: boolean
  /** Effective scheduling weight (invalid values never reach here). */
  readonly weight: number
  readonly proxyUrl: string
  /** Prefix with `/` trimmed; emptied when it contains inner slashes. */
  readonly prefix: string
  /** Free-form label; falls back to email, then project_id. */
  readonly label: string
}

/** Parse outcome: loaded credential or the reason it was skipped. */
export type ParseAuthFileResult =
  | { readonly ok: true; readonly file: LoadedAuthFile }
  | { readonly ok: false; readonly reason: AuthFileSkipReason }

function parseWeight(value: JsonValue | undefined): number | 'invalid' {
  if (value === undefined) return 1
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 'invalid'
    if (value < 0 || value > MAX_CREDENTIAL_WEIGHT) return 'invalid'
    return value
  }
  if (typeof value === 'string') {
    if (value.trim().length === 0) return 1
    const parsed = Number(value.trim())
    if (Number.isNaN(parsed) || !Number.isFinite(parsed)) return 'invalid'
    if (parsed < 0 || parsed > MAX_CREDENTIAL_WEIGHT) return 'invalid'
    return parsed
  }
  return 'invalid'
}

/**
 * Applies the file-store parse rules to one candidate: key must end with
 * `.json` (case-insensitive), the document must be a JSON object, the
 * `gemini` type is skipped silently in any casing, and the weight (number
 * or numeric string) must fall in 0..1_000_000. A credential with weight
 * `<= 0` stays loaded - exclusion from scheduling is S4's concern.
 */
export function parseAuthFileDocument(name: string, value: JsonValue | undefined): ParseAuthFileResult {
  if (!name.toLowerCase().endsWith('.json')) return { ok: false, reason: 'not-json-key' }
  if (value === undefined || typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'not-object' }
  }
  if (!isJsonValue(value)) return { ok: false, reason: 'not-object' }
  const document = value as Record<string, JsonValue>
  const rawType = document['type']
  const provider = (typeof rawType === 'string' ? rawType : '').trim().toLowerCase()
  if (provider === 'gemini' || provider === 'gemini-cli') {
    return { ok: false, reason: 'gemini' }
  }
  const weight = parseWeight(document['weight'])
  if (weight === 'invalid') return { ok: false, reason: 'invalid-weight' }
  const disabled = document['disabled'] === true
  const proxyUrl = typeof document['proxy_url'] === 'string' ? document['proxy_url'] : ''
  const rawPrefix = typeof document['prefix'] === 'string' ? document['prefix'] : ''
  const trimmedPrefix = rawPrefix.replace(/^\/+|\/+$/g, '')
  const prefix = trimmedPrefix.includes('/') ? '' : trimmedPrefix
  const email = typeof document['email'] === 'string' ? document['email'] : ''
  const projectId = typeof document['project_id'] === 'string' ? document['project_id'] : ''
  const explicitLabel = typeof document['label'] === 'string' ? document['label'] : ''
  const label = explicitLabel.length > 0 ? explicitLabel : email.length > 0 ? email : projectId
  return {
    ok: true,
    file: {
      name,
      provider: provider.length > 0 ? provider : 'unknown',
      document,
      disabled,
      weight,
      proxyUrl,
      prefix,
      label,
    },
  }
}

/**
 * Reads and parses every credential document in the `auth` namespace,
 * skipping files per the load rules. Provider `unknown` entries are kept
 * for management display but never synthesize credentials (S6 §3.4).
 */
export async function listAuthFiles(store: Store): Promise<readonly LoadedAuthFile[]> {
  const keys = await store.list(AUTH_FILES_NAMESPACE)
  const loaded: LoadedAuthFile[] = []
  for (const key of keys) {
    const value = await store.get(AUTH_FILES_NAMESPACE, key)
    const parsed = parseAuthFileDocument(key, value)
    if (parsed.ok && parsed.file.provider !== 'unknown') loaded.push(parsed.file)
  }
  return loaded
}

/**
 * Saves one credential: materializes `disabled` into the persisted JSON
 * (false when absent) and writes the document through the Store.
 */
export async function saveAuthFile(
  store: Store,
  name: string,
  document: Record<string, JsonValue>,
): Promise<void> {
  const next: { [key: string]: JsonValue } = { ...document }
  if (next['disabled'] === undefined) next['disabled'] = false
  await store.put(AUTH_FILES_NAMESPACE, name, next)
}

/** Deletes one credential document. */
export async function deleteAuthFile(store: Store, name: string): Promise<boolean> {
  return await store.delete(AUTH_FILES_NAMESPACE, name)
}

/** Reads the refresh secret of a credential: `refresh_token`, the camelCase
 * `refreshToken` metadata spelling, or Meta's `dca_token`. */
export function refreshSecretOf(document: Record<string, JsonValue>): string | undefined {
  const snake = document['refresh_token']
  if (typeof snake === 'string' && snake.length > 0) return snake
  const camel = document['refreshToken']
  if (typeof camel === 'string' && camel.length > 0) return camel
  return undefined
}

/** Meta flavor of refresh detection: the stored DCA token instead. */
export function metaDcaTokenOf(document: Record<string, JsonValue>): string | undefined {
  const token = document['dca_token']
  return typeof token === 'string' && token.length > 0 ? token : undefined
}

/** True when the credential carries material a refresh can use. */
export function isRefreshableCredential(
  provider: string,
  document: Record<string, JsonValue>,
): boolean {
  if (provider === 'meta') return metaDcaTokenOf(document) !== undefined
  return refreshSecretOf(document) !== undefined
}
