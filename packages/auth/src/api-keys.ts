import type { AuthResponse } from './types'

/**
 * Inbound client API-key authentication for the proxied routes.
 *
 * The decision logic mirrors the recorded reference behavior: a fixed
 * extraction order over five credential sources, exact-string matching
 * against the configured key set, two byte-exact 401 bodies, an open mode
 * when no key is configured, and a template-key safe mode that seals the
 * proxy surface. Runtimes call `authenticateClientRequest` from their
 * middleware; nothing here touches HTTP routing.
 */

/** Template values that put the server into example-key safe mode. */
export const TEMPLATE_API_KEYS: readonly string[] = [
  'your-api-key-1',
  'your-api-key-2',
  'your-api-key-3',
]

/** Header emitted (Go-canonical casing) on safe-mode 403 responses. */
export const SAFE_MODE_HEADER = 'X-Cpa-Safe-Mode'

/** Fixed body of the safe-mode 403 response (byte-exact, key order recorded). */
export const SAFE_MODE_PROXY_BODY =
  '{"error":"unsafe_example_api_key","message":"Proxy API endpoints are disabled because api-keys contains template values. Open /management.html?safe-mode=configure, update api-keys in Management, then retry."}'

/** 401 body when no credential is present in any source. */
export const MISSING_API_KEY_BODY = '{"error":"Missing API key"}'

/** 401 body when at least one credential is present but none matches. */
export const INVALID_API_KEY_BODY = '{"error":"Invalid API key"}'

/** Headers a runtime should consult, lowercased names. */
export interface ClientAuthHeaders {
  readonly authorization?: string
  readonly 'x-goog-api-key'?: string
  readonly 'x-api-key'?: string
}

/** Names of the five credential sources, in precedence order. */
export type CredentialSource =
  | 'authorization'
  | 'x-goog-api-key'
  | 'x-api-key'
  | 'query-key'
  | 'query-auth_token'

/** One credential candidate extracted from a request. */
export interface CredentialCandidate {
  readonly source: CredentialSource
  readonly value: string
}

/**
 * Extracts the token from an `Authorization` header value: `Bearer <token>`
 * (prefix case-insensitive, single-space split, remainder trimmed) yields
 * the token; anything else is the candidate verbatim.
 */
export function extractBearerToken(authorization: string): string {
  const space = authorization.indexOf(' ')
  if (space <= 0) return authorization
  const scheme = authorization.slice(0, space).toLowerCase()
  if (scheme !== 'bearer') return authorization
  return authorization.slice(space + 1).trim()
}

/**
 * Collects the credential candidates of one request in extraction order.
 * A source contributes a candidate only when it carries a non-empty value.
 */
export function extractCredentialCandidates(
  headers: ClientAuthHeaders,
  url: string,
): CredentialCandidate[] {
  const candidates: CredentialCandidate[] = []
  const authorization = headers.authorization
  if (authorization !== undefined && authorization.length > 0) {
    const token = extractBearerToken(authorization)
    if (token.length > 0) candidates.push({ source: 'authorization', value: token })
  }
  const googKey = headers['x-goog-api-key']
  if (googKey !== undefined && googKey.length > 0) {
    candidates.push({ source: 'x-goog-api-key', value: googKey })
  }
  const apiKey = headers['x-api-key']
  if (apiKey !== undefined && apiKey.length > 0) {
    candidates.push({ source: 'x-api-key', value: apiKey })
  }
  let query: URLSearchParams | undefined
  try {
    query = new URL(url).searchParams
  } catch {
    query = undefined
  }
  if (query !== undefined) {
    const keyParam = query.get('key')
    if (keyParam !== null && keyParam.length > 0) {
      candidates.push({ source: 'query-key', value: keyParam })
    }
    const authTokenParam = query.get('auth_token')
    if (authTokenParam !== null && authTokenParam.length > 0) {
      candidates.push({ source: 'query-auth_token', value: authTokenParam })
    }
  }
  return candidates
}

/**
 * Normalizes the configured key list at load or hot-reload: trims
 * whitespace, drops empty strings and removes duplicates. An empty result
 * unregisters the key provider and therefore enables open mode.
 */
export function normalizeApiKeys(keys: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of keys) {
    const key = raw.trim()
    if (key.length === 0 || seen.has(key)) continue
    seen.add(key)
    out.push(key)
  }
  return out
}

/** Result of scanning the configured keys for template values. */
export interface SafeModeDetection {
  readonly active: boolean
  /** Offending template keys, in configuration order. */
  readonly keys: readonly string[]
}

/**
 * Detects example-key safe mode: active when any configured top-level key
 * equals one of the template values. The comparison runs against the
 * normalized (trimmed, de-duplicated) key set, the same set credential
 * matching uses, so a padded template value still seals the proxy.
 * Re-evaluated whenever the key list changes (hot reload included);
 * stateless by construction.
 */
export function detectSafeMode(keys: readonly string[]): SafeModeDetection {
  const offending: string[] = []
  const seen = new Set<string>()
  for (const key of normalizeApiKeys(keys)) {
    if (!TEMPLATE_API_KEYS.includes(key)) continue
    if (seen.has(key)) continue
    seen.add(key)
    offending.push(key)
  }
  return { active: offending.length > 0, keys: offending }
}

/**
 * Builds the HTML warning page served on `GET /` and `GET /management.html`
 * while safe mode is active. `GET /management.html?safe-mode=configure` is
 * exempt (runtime concern).
 */
export function safeModePageHtml(keys: readonly string[]): string {
  const items = keys.map((key) => `<li><code>${key}</code></li>`).join('')
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Example API key detected</title><style>body{margin:0;font-family:Arial,sans-serif;background:#f6f8fa;color:#1f2328}.wrap{max-width:760px;margin:12vh auto;padding:0 24px}.panel{background:#fff;border:1px solid #d0d7de;border-radius:8px;padding:28px;box-shadow:0 8px 24px rgba(140,149,159,.2)}h1{margin:0 0 12px;font-size:28px;line-height:1.25}p{font-size:16px;line-height:1.55}code{background:#f6f8fa;border:1px solid #d0d7de;border-radius:4px;padding:2px 5px}.keys{margin:16px 0;padding-left:22px}.actions{margin-top:24px}.button{display:inline-block;border-radius:6px;background:#0969da;color:#fff;text-decoration:none;font-weight:600;padding:10px 16px}.button:hover{background:#0759b8}</style></head><body><main class="wrap"><section class="panel"><h1>Example API key detected</h1><p>Proxy API endpoints are disabled because the top-level <code>api-keys</code> configuration still contains template values.</p><p>Replace these values before using the proxy:</p><ul class="keys">${items}</ul><p>Set strong random API keys, then retry the proxy endpoint.</p><div class="actions"><a class="button" href="/management.html?safe-mode=configure">Open Management</a></div></section></main></body></html>`
}

/** Successful client authentication; `open` marks the unconfigured mode. */
export interface ClientAuthSuccess {
  readonly ok: true
  /** True when no key provider is configured and the request is allowed. */
  readonly open: boolean
  /** Matched key; empty in open mode. */
  readonly apiKey: string
  /** Winning source name; empty in open mode. */
  readonly source: string
}

/** Failed client authentication; `body` is byte-exact. */
export interface ClientAuthFailure extends AuthResponse {
  readonly ok: false
  readonly status: 401 | 403
}

export type ClientAuthResult = ClientAuthSuccess | ClientAuthFailure

export interface ClientAuthInput {
  /** Configured top-level api-keys, as written in the config. */
  readonly apiKeys: readonly string[]
  /** Lowercased request headers relevant to key extraction. */
  readonly headers: ClientAuthHeaders
  /** Full request URL; the query feeds sources 4 and 5. */
  readonly url: string
}

/**
 * Evaluates one request against the client key set.
 *
 * Order: safe mode seals proxy paths first; an empty normalized key set
 * means open mode (allowed, no principal); otherwise the first candidate
 * that equals a configured key wins, no candidate at all is "Missing API
 * key", and a candidate present without a match is "Invalid API key".
 */
export function authenticateClientRequest(input: ClientAuthInput): ClientAuthResult {
  const safeMode = detectSafeMode(input.apiKeys)
  if (safeMode.active) {
    return {
      ok: false,
      status: 403,
      body: SAFE_MODE_PROXY_BODY,
      headers: { [SAFE_MODE_HEADER]: 'example-api-key' },
    }
  }
  const configured = normalizeApiKeys(input.apiKeys)
  if (configured.length === 0) {
    return { ok: true, open: true, apiKey: '', source: '' }
  }
  const candidates = extractCredentialCandidates(input.headers, input.url)
  if (candidates.length === 0) {
    return { ok: false, status: 401, body: MISSING_API_KEY_BODY }
  }
  const keySet = new Set(configured)
  for (const candidate of candidates) {
    if (keySet.has(candidate.value)) {
      return { ok: true, open: false, apiKey: candidate.value, source: candidate.source }
    }
  }
  return { ok: false, status: 401, body: INVALID_API_KEY_BODY }
}
