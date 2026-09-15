/**
 * Client auth gate of the /v1/messages routes (S2d4 section 2.1).
 *
 * Five transports are accepted, tried in order until one matches a
 * configured gateway key: `Authorization: Bearer <key>` (scheme
 * case-insensitive, split on the first space, token trimmed - a non-Bearer
 * or single-token value is used VERBATIM as the key), `X-Goog-Api-Key`,
 * `X-Api-Key`, `?key=` and `?auth_token=`. No credential anywhere yields
 * the `Missing API key` 401; credentials that match nothing yield
 * `Invalid API key` - both in the plain string-`error` shape, not the
 * Claude envelope. With no keys configured the group is open.
 * `anthropic-version` / `anthropic-beta` headers are neither validated
 * nor forwarded.
 */
import type { HeaderList } from './types'

/** Result of the gateway-key gate. */
export type ClientAuthResult =
  | { readonly kind: 'ok' }
  | { readonly kind: 'missing' }
  | { readonly kind: 'invalid' }

/** Case-insensitive lookup over an ordered header list. */
function lookup(headers: HeaderList, name: string): string | undefined {
  const key = name.toLowerCase()
  for (const [headerName, value] of headers) {
    if (headerName.toLowerCase() === key) return value
  }
  return undefined
}

/**
 * `Authorization` credential: a `Bearer` scheme (case-insensitive) yields
 * the trimmed token; any other value - including a single token without a
 * space - is used VERBATIM as the key.
 */
function authorizationCredential(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const space = raw.indexOf(' ')
  if (space < 0) return raw.length > 0 ? raw : undefined
  const scheme = raw.slice(0, space)
  if (scheme.toLowerCase() === 'bearer') {
    const token = raw.slice(space + 1).trim()
    return token.length > 0 ? token : undefined
  }
  return raw.length > 0 ? raw : undefined
}

/**
 * Extracts the client credentials of all five transports, in transport
 * order. Empty values contribute nothing.
 */
export function extractClientCredentials(
  headers: HeaderList,
  query: URLSearchParams,
): readonly string[] {
  const out: string[] = []
  const authorization = authorizationCredential(lookup(headers, 'authorization'))
  if (authorization !== undefined) out.push(authorization)
  const goog = lookup(headers, 'x-goog-api-key')
  if (goog !== undefined && goog.length > 0) out.push(goog)
  const apiKey = lookup(headers, 'x-api-key')
  if (apiKey !== undefined && apiKey.length > 0) out.push(apiKey)
  const queryKey = query.get('key')
  if (queryKey !== null && queryKey.length > 0) out.push(queryKey)
  const authToken = query.get('auth_token')
  if (authToken !== null && authToken.length > 0) out.push(authToken)
  return out
}

/**
 * Runs the gate: any transport credential matching a configured key
 * passes; credentials that match nothing fail invalid; no credential at
 * all fails missing. An empty key set leaves the group open.
 */
export function authenticateClientRequest(
  headers: HeaderList,
  query: URLSearchParams,
  apiKeys: readonly string[],
): ClientAuthResult {
  if (apiKeys.length === 0) return { kind: 'ok' }
  const credentials = extractClientCredentials(headers, query)
  if (credentials.length === 0) return { kind: 'missing' }
  for (const credential of credentials) {
    if (apiKeys.includes(credential)) return { kind: 'ok' }
  }
  return { kind: 'invalid' }
}
