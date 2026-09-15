/**
 * Upstream header assembly for the Claude executor (S2d7 2.2).
 *
 * Wire policy for an api-key credential: CALLER-OWNED. An exact allowlist
 * of client headers is forwarded verbatim; the credential authenticates
 * via `Authorization: Bearer` on non-Anthropic bases (`x-api-key` on
 * Anthropic's own host); `Accept`, `Accept-Encoding` and `User-Agent`
 * defaults fill in only what the client left unset; `Anthropic-Version`
 * is always sent; `anthropic-beta` is emitted only when the computed beta
 * set is non-empty (Gemini clients contribute none, so it stays absent).
 * Everything else - including `x-goog-api-key` and `X-Mock-*` - is dropped.
 */
/** Default Anthropic protocol version. */
export const DEFAULT_ANTHROPIC_VERSION = '2023-06-01'

/** User-Agent fallback when the client sent none (recorded: CLIProxyAPI/v7.3.4). */
export function gatewayUserAgent(version: string): string {
  return `CLIProxyAPI/${version}`
}

const ANTHROPIC_HOSTS: readonly string[] = Object.freeze(['api.anthropic.com'])

function isAnthropicBase(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl)
    return ANTHROPIC_HOSTS.includes(url.hostname.toLowerCase())
  } catch {
    return false
  }
}

/**
 * Client headers forwarded verbatim (names matched lower-case):
 * `Accept`, `Accept-Encoding`, `User-Agent`, `X-App`,
 * `X-Client-Request-Id`, `X-Client-App`,
 * `X-Anthropic-Additional-Protection`, `anthropic-*`, `x-stainless-*`,
 * `x-claude-code-*`, `x-claude-remote-*`.
 */
function forwardedClientName(name: string): boolean {
  const lower = name.toLowerCase()
  if (lower === 'accept' || lower === 'accept-encoding' || lower === 'user-agent') return true
  if (lower === 'x-app' || lower === 'x-client-request-id' || lower === 'x-client-app') return true
  if (lower === 'x-anthropic-additional-protection') return true
  if (lower.startsWith('anthropic-')) return true
  if (lower.startsWith('x-stainless-')) return true
  if (lower.startsWith('x-claude-code-') || lower.startsWith('x-claude-remote-')) return true
  return false
}

/** Case-insensitive read of a header map. */
function pick(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  const lower = name.toLowerCase()
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key]
  }
  return undefined
}

/**
 * Sets a gateway-owned header under its canonical name, first removing any
 * case-variant twin an earlier write left behind (a caller may forward
 * `accept` or `anthropic-version` in lower case). One logical header must
 * never occupy two keys of the emitted record.
 */
function setCanonicalHeader(headers: Record<string, string>, name: string, value: string): void {
  const lower = name.toLowerCase()
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) delete headers[key]
  }
  headers[name] = value
}

export interface ClaudeUpstreamHeadersInput {
  /** Client request headers as received (any casing). */
  readonly clientHeaders: Readonly<Record<string, string>>
  /** Credential api-key. */
  readonly apiKey: string
  /** Credential `base-url`; Anthropic's own host switches the auth header. */
  readonly baseUrl: string
  /** Gateway version for the User-Agent fallback (recorded: `v7.3.4`). */
  readonly gatewayVersion?: string
  /** Credential-level static header map (applied last, then clawed back). */
  readonly credentialHeaders?: Readonly<Record<string, string>>
}

/**
 * Builds the upstream header set. The result is a plain record keyed by
 * canonical names; the facade pins the emission order separately
 * (`Host, User-Agent, Content-Length`, then the rest in ASCII order -
 * the recorded wire-log order).
 */
export function buildClaudeUpstreamHeaders(input: ClaudeUpstreamHeadersInput): Record<string, string> {
  const anthropicBase = isAnthropicBase(input.baseUrl)
  const headers: Record<string, string> = {}

  // Forwarded client headers keep the caller's name casing; gateway-set
  // headers below use canonical names.
  for (const name of Object.keys(input.clientHeaders)) {
    if (forwardedClientName(name)) headers[name] = input.clientHeaders[name] ?? ''
  }

  if (anthropicBase) {
    setCanonicalHeader(headers, 'x-api-key', input.apiKey)
  } else {
    setCanonicalHeader(headers, 'Authorization', `Bearer ${input.apiKey}`)
  }
  setCanonicalHeader(headers, 'Content-Type', 'application/json')
  setCanonicalHeader(
    headers,
    'Anthropic-Version',
    pick(input.clientHeaders, 'anthropic-version') ?? DEFAULT_ANTHROPIC_VERSION,
  )

  const callerAccept = pick(input.clientHeaders, 'accept')
  if (callerAccept !== undefined) setCanonicalHeader(headers, 'Accept', callerAccept)
  else if (!anthropicBase) setCanonicalHeader(headers, 'Accept', 'text/event-stream')

  const callerEncoding = pick(input.clientHeaders, 'accept-encoding')
  if (callerEncoding !== undefined) setCanonicalHeader(headers, 'Accept-Encoding', callerEncoding)
  else if (!anthropicBase) setCanonicalHeader(headers, 'Accept-Encoding', 'identity')

  setCanonicalHeader(
    headers,
    'User-Agent',
    pick(input.clientHeaders, 'user-agent') ?? gatewayUserAgent(input.gatewayVersion ?? 'v7.3.4'),
  )

  // Beta assembly: the allowlist may forward a client `anthropic-beta`, and
  // nothing else contributes on this surface. An empty set emits no header.
  const callerBeta = pick(input.clientHeaders, 'anthropic-beta')
  const betas = splitBeta(callerBeta).filter((beta) => beta.length > 0)
  if (betas.length > 0) setCanonicalHeader(headers, 'Anthropic-Beta', betas.join(','))

  const credentialHeaders = input.credentialHeaders ?? {}
  for (const name of Object.keys(credentialHeaders)) {
    headers[name] = credentialHeaders[name] ?? ''
  }
  // Streaming claw-back: on streaming requests to a non-Anthropic base the
  // transport negotiation is restored, so credential Accept/Accept-Encoding
  // overrides do not survive.
  if (!anthropicBase) {
    setCanonicalHeader(headers, 'Accept', callerAccept ?? 'text/event-stream')
    setCanonicalHeader(headers, 'Accept-Encoding', callerEncoding ?? 'identity')
  }
  return headers
}

function splitBeta(value: string | undefined): string[] {
  if (value === undefined) return []
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

// ---------------------------------------------------------------------------
// Emission order (pinned by the recorded wire log)
// ---------------------------------------------------------------------------

/** Go-style MIME canonicalization: `x-stainless-lang` -> `X-Stainless-Lang`. */
function canonicalHeaderName(name: string): string {
  return name
    .split('-')
    .map((part) => (part.length === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join('-')
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

/**
 * Emission order pinned by the recorded wire log: `Host`, `User-Agent`
 * and `Content-Length` first, the remaining names in ASCII order (the
 * recorded `Accept, Accept-Encoding, Anthropic-Version, Authorization,
 * Content-Type` tail).
 */
export function orderUpstreamHeaders(
  map: Readonly<Record<string, string>>,
  url: string,
  body: string,
): ReadonlyArray<readonly [string, string]> {
  const merged: Record<string, string> = {}
  for (const [name, value] of Object.entries(map)) merged[canonicalHeaderName(name)] = value
  delete merged['Host']
  const rest = Object.keys(merged)
    .filter((name) => name !== 'User-Agent' && name !== 'Content-Length')
    .sort()
    .map((name) => [name, merged[name] ?? ''] as [string, string])
  return [
    ['Host', hostOf(url)],
    ['User-Agent', merged['User-Agent'] ?? ''],
    ['Content-Length', String(new TextEncoder().encode(body).length)],
    ...rest,
  ]
}

/** Header-list -> record (last occurrence wins). */
export function headerListToRecord(list: ReadonlyArray<readonly [string, string]>): Record<string, string> {
  const record: Record<string, string> = {}
  for (const [name, value] of list) record[name] = value
  return record
}
