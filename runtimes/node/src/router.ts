/**
 * Declarative route table and matcher (S1 §3).
 *
 * Semantics pinned by S1:
 * - only the registered method answers; anything else falls to R-404
 *   (empty 404, never 405),
 * - `HEAD` is registered for `/healthz` alone,
 * - trailing-slash redirects fire in BOTH directions whenever the
 *   alternative path has a route for the same method, and are emitted
 *   before the middleware chain (no CORS, no auth),
 * - one wildcard route exists: `POST|GET /v1beta/models/*action`.
 */
import type { GatewayResponse, HeaderList } from './types'
import { trailingSlashRedirectBody } from './envelopes'

/** Auth family a route belongs to. */
export type RouteGroup =
  | 'public' // meta + callbacks: no client auth
  | 'client' // /v1, /v1beta, /openai/v1, /backend-api/codex groups
  | 'realtime' // /v1/realtime* with the secret-aware gate
  | 'realtime-standard' // realtime control endpoints, key-only gate
  | 'management' // /v0/management/* (availability-gated)
  | 'keep-alive' // TUI-mode local password

/** One registered route. */
export interface RouteEntry {
  readonly method: string
  /** Path pattern: literal segments, `:name` params, trailing `*name`. */
  readonly pattern: string
  readonly group: RouteGroup
  /** Stable id used by the dispatch table (handler lookup). */
  readonly id: string
}

/**
 * The full route inventory (S1 §3.1-3.9). The order does not matter for
 * matching (patterns are mutually exclusive) except `:param` routes
 * after exact ones with the same prefix - the matcher checks exact
 * segments first.
 */
export const ROUTES: readonly RouteEntry[] = [
  // 3.1 meta
  { method: 'GET', pattern: '/', group: 'public', id: 'root' },
  { method: 'GET', pattern: '/healthz', group: 'public', id: 'healthz' },
  { method: 'HEAD', pattern: '/healthz', group: 'public', id: 'healthz' },
  { method: 'GET', pattern: '/management.html', group: 'public', id: 'management-panel' },
  { method: 'GET', pattern: '/keep-alive', group: 'keep-alive', id: 'keep-alive' },
  // 3.8 OAuth callbacks
  { method: 'GET', pattern: '/anthropic/callback', group: 'public', id: 'callback-anthropic' },
  { method: 'GET', pattern: '/codex/callback', group: 'public', id: 'callback-codex' },
  { method: 'GET', pattern: '/antigravity/callback', group: 'public', id: 'callback-antigravity' },
  { method: 'GET', pattern: '/devin/callback', group: 'public', id: 'callback-devin' },
  { method: 'GET', pattern: '/callback', group: 'public', id: 'callback-devin' },
  // 3.9 management (availability-gated; oauth-callback sits outside the key gate)
  { method: 'GET', pattern: '/v0/management/oauth-callback', group: 'public', id: 'mgmt-oauth-callback' },
  { method: 'POST', pattern: '/v0/management/oauth-callback', group: 'public', id: 'mgmt-oauth-callback' },
  { method: 'GET', pattern: '/v0/management/anthropic-auth-url', group: 'management', id: 'mgmt-auth-url' },
  { method: 'GET', pattern: '/v0/management/codex-auth-url', group: 'management', id: 'mgmt-auth-url' },
  { method: 'GET', pattern: '/v0/management/antigravity-auth-url', group: 'management', id: 'mgmt-auth-url' },
  { method: 'GET', pattern: '/v0/management/kimi-auth-url', group: 'management', id: 'mgmt-auth-url' },
  { method: 'GET', pattern: '/v0/management/xai-auth-url', group: 'management', id: 'mgmt-auth-url' },
  { method: 'GET', pattern: '/v0/management/devin-auth-url', group: 'management', id: 'mgmt-auth-url' },
  { method: 'GET', pattern: '/v0/management/meta-auth-url', group: 'management', id: 'mgmt-auth-url' },
  { method: 'GET', pattern: '/v0/management/get-auth-status', group: 'management', id: 'mgmt-get-auth-status' },
  { method: 'DELETE', pattern: '/v0/management/oauth-session', group: 'management', id: 'mgmt-oauth-session' },
  { method: 'GET', pattern: '/v0/management/*path', group: 'management', id: 'mgmt-rest' },
  { method: 'PUT', pattern: '/v0/management/*path', group: 'management', id: 'mgmt-rest' },
  { method: 'POST', pattern: '/v0/management/*path', group: 'management', id: 'mgmt-rest' },
  { method: 'PATCH', pattern: '/v0/management/*path', group: 'management', id: 'mgmt-rest' },
  { method: 'DELETE', pattern: '/v0/management/*path', group: 'management', id: 'mgmt-rest' },
  // 3.2 OpenAI-compatible surface
  { method: 'GET', pattern: '/v1/models', group: 'client', id: 'models-list' },
  { method: 'POST', pattern: '/v1/chat/completions', group: 'client', id: 'chat-completions' },
  { method: 'POST', pattern: '/v1/completions', group: 'client', id: 'completions' },
  { method: 'POST', pattern: '/v1/messages', group: 'client', id: 'messages' },
  { method: 'POST', pattern: '/v1/messages/count_tokens', group: 'client', id: 'messages-count-tokens' },
  { method: 'POST', pattern: '/v1/responses', group: 'client', id: 'responses' },
  { method: 'GET', pattern: '/v1/responses', group: 'client', id: 'responses-ws' },
  { method: 'POST', pattern: '/v1/responses/compact', group: 'client', id: 'responses-compact' },
  { method: 'POST', pattern: '/v1/images/generations', group: 'client', id: 'images-generations' },
  { method: 'POST', pattern: '/v1/images/edits', group: 'client', id: 'images-edits' },
  { method: 'POST', pattern: '/v1/videos', group: 'client', id: 'videos-create' },
  { method: 'POST', pattern: '/v1/videos/generations', group: 'client', id: 'videos-create' },
  { method: 'POST', pattern: '/v1/videos/edits', group: 'client', id: 'videos-create' },
  { method: 'POST', pattern: '/v1/videos/extensions', group: 'client', id: 'videos-create' },
  { method: 'GET', pattern: '/v1/videos/:request_id', group: 'client', id: 'videos-retrieve' },
  { method: 'POST', pattern: '/v1/alpha/search', group: 'client', id: 'alpha-search' },
  // 3.7 live/realtime surface (special auth, nested envelopes)
  { method: 'POST', pattern: '/v1/live', group: 'client', id: 'live-call' },
  { method: 'GET', pattern: '/v1/live/:call_id', group: 'client', id: 'live-sideband' },
  { method: 'GET', pattern: '/v1/realtime', group: 'realtime', id: 'realtime-ws' },
  { method: 'POST', pattern: '/v1/realtime', group: 'realtime', id: 'realtime-call' },
  { method: 'POST', pattern: '/v1/realtime/calls', group: 'realtime', id: 'realtime-call' },
  { method: 'GET', pattern: '/v1/realtime/calls/:call_id', group: 'realtime', id: 'realtime-calls-sideband' },
  { method: 'POST', pattern: '/v1/realtime/calls/:call_id/hangup', group: 'realtime-standard', id: 'realtime-hangup' },
  { method: 'POST', pattern: '/v1/realtime/calls/:call_id/accept', group: 'realtime-standard', id: 'realtime-sip-accept' },
  { method: 'POST', pattern: '/v1/realtime/calls/:call_id/reject', group: 'realtime-standard', id: 'realtime-sip-reject' },
  { method: 'POST', pattern: '/v1/realtime/calls/:call_id/refer', group: 'realtime-standard', id: 'realtime-sip-refer' },
  { method: 'POST', pattern: '/v1/realtime/client_secrets', group: 'realtime-standard', id: 'realtime-client-secrets' },
  { method: 'POST', pattern: '/v1/realtime/sessions', group: 'realtime-standard', id: 'realtime-sessions' },
  { method: 'POST', pattern: '/v1/realtime/transcription_sessions', group: 'realtime-standard', id: 'realtime-transcription-sessions' },
  { method: 'GET', pattern: '/v1/realtime/translations', group: 'realtime', id: 'realtime-translations-stub' },
  { method: 'POST', pattern: '/v1/realtime/translations', group: 'realtime', id: 'realtime-translations-stub' },
  { method: 'POST', pattern: '/v1/realtime/translations/client_secrets', group: 'realtime-standard', id: 'realtime-translations-client-secrets' },
  // 3.4 Gemini-compatible surface
  { method: 'GET', pattern: '/v1beta/models', group: 'client', id: 'v1beta-models-list' },
  { method: 'GET', pattern: '/v1beta/models/*action', group: 'client', id: 'v1beta-models-action' },
  { method: 'POST', pattern: '/v1beta/models/*action', group: 'client', id: 'v1beta-models-action' },
  { method: 'POST', pattern: '/v1beta/interactions', group: 'client', id: 'v1beta-interactions' },
  // 3.5 Codex CLI direct routes
  { method: 'GET', pattern: '/backend-api/codex/responses', group: 'client', id: 'responses-ws' },
  { method: 'POST', pattern: '/backend-api/codex/responses', group: 'client', id: 'responses' },
  { method: 'POST', pattern: '/backend-api/codex/responses/compact', group: 'client', id: 'responses-compact' },
  { method: 'POST', pattern: '/backend-api/codex/alpha/search', group: 'client', id: 'alpha-search' },
  // 3.6 OpenAI-native video surface
  { method: 'POST', pattern: '/openai/v1/videos', group: 'client', id: 'openai-videos-create' },
  { method: 'GET', pattern: '/openai/v1/videos/:video_id', group: 'client', id: 'openai-videos-retrieve' },
  { method: 'GET', pattern: '/openai/v1/videos/:video_id/content', group: 'client', id: 'openai-videos-content' },
]

/** Match result of one (method, pathname) lookup. */
export interface RouteMatch {
  readonly entry: RouteEntry
  /** Wildcard/param captures, keyed by name. */
  readonly params: Readonly<Record<string, string>>
}

/** Compares one literal/param segment; returns false on mismatch. */
function segmentMatches(expected: string, actual: string, params: Record<string, string>): boolean {
  if (expected === '') return actual === ''
  if (expected.startsWith(':')) {
    if (actual === '') return false
    params[expected.slice(1)] = actual
    return true
  }
  return expected === actual
}

/**
 * Matches a pattern against a pathname. `:name` segments capture one
 * segment; a trailing `*name` captures the remaining path WITH its
 * leading slash and requires at least that slash (gin wildcard
 * semantics - `/v1beta/models` never matches `/v1beta/models/*action`).
 */
function matchPattern(pattern: string, pathname: string): Record<string, string> | undefined {
  const params: Record<string, string> = {}
  if (pattern.indexOf('*') < 0) {
    const patternParts = pattern.split('/')
    const pathParts = pathname.split('/')
    if (patternParts.length !== pathParts.length) return undefined
    for (let index = 0; index < patternParts.length; index++) {
      const expected = patternParts[index]
      const actual = pathParts[index]
      if (expected === undefined || actual === undefined) return undefined
      if (!segmentMatches(expected, actual, params)) return undefined
    }
    return params
  }
  const wildcardIndex = pattern.indexOf('*')
  const prefix = pattern.slice(0, wildcardIndex - 1)
  if (!pathname.startsWith(prefix) || pathname.length <= prefix.length) return undefined
  if (pathname.charAt(prefix.length) !== '/') return undefined
  const name = pattern.slice(wildcardIndex + 1)
  params[name.length > 0 ? name : 'wildcard'] = pathname.slice(prefix.length)
  return params
}

/** First route matching (method, pathname); exact entries win over wildcards. */
export function matchRoute(method: string, pathname: string): RouteMatch | undefined {
  let wildcardMatch: RouteMatch | undefined
  for (const entry of ROUTES) {
    if (entry.method !== method) continue
    const params = matchPattern(entry.pattern, pathname)
    if (params === undefined) continue
    const match: RouteMatch = { entry, params }
    if (!entry.pattern.includes('*')) return match
    if (wildcardMatch === undefined) wildcardMatch = match
  }
  return wildcardMatch
}

/** Whether ANY route answers (method, pathname) - the redirect predicate. */
export function routeExists(method: string, pathname: string): boolean {
  return matchRoute(method, pathname) !== undefined
}

export type RedirectDecision =
  | { readonly redirect: true; readonly status: 301 | 307; readonly location: string }
  | { readonly redirect: false }

/**
 * Trailing-slash redirect evaluation (S1 §5). Fires only when the
 * alternative path has a route for the same method; emitted before the
 * middleware chain so the response carries no CORS block.
 */
export function evaluateRedirect(method: string, pathname: string, query: string): RedirectDecision {
  const to = (location: string, status: 301 | 307): RedirectDecision => ({
    redirect: true,
    status,
    location: query.length > 0 ? `${location}?${query}` : location,
  })
  if (pathname.length > 1 && pathname.endsWith('/')) {
    const trimmed = pathname.slice(0, -1)
    if (routeExists(method, trimmed)) {
      return to(trimmed, method === 'GET' ? 301 : 307)
    }
    return { redirect: false }
  }
  if (!pathname.endsWith('/') && routeExists(method, `${pathname}/`)) {
    return to(`${pathname}/`, method === 'GET' ? 301 : 307)
  }
  return { redirect: false }
}

/** Builds the pre-middleware redirect response (no CORS, S1 §5). */
export function redirectResponse(status: 301 | 307, location: string, method: string): GatewayResponse {
  const headers: Array<readonly [string, string]> = [['Location', location]]
  let body = ''
  if (status === 301 && method === 'GET') {
    headers.push(['Content-Type', 'text/html; charset=utf-8'])
    body = trailingSlashRedirectBody(location)
  }
  return { status, headers, body }
}

/** OPTIONS anywhere: 204, CORS block, never routed (S1 §2). */
export function optionsResponse(): GatewayResponse {
  return { status: 204, headers: [], body: '' }
}

/** Case-insensitive first-value lookup over an ordered header list. */
export function headerValue(headers: HeaderList, name: string): string | undefined {
  const lower = name.toLowerCase()
  for (const [headerName, value] of headers) {
    if (headerName.toLowerCase() === lower) return value
  }
  return undefined
}
