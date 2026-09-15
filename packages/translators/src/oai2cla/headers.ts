/**
 * Upstream header assembly for the Claude executor (S2d3 section 2.3).
 *
 * Default wire policy for an api-key credential with no fingerprint profile
 * and no confirmed Claude Code client is CALLER-OWNED: an exact allowlist of
 * client headers is forwarded, the credential authenticates via `Bearer` on
 * non-Anthropic bases (`x-api-key` on Anthropic's own host), and the
 * transport defaults (`Accept`, `Accept-Encoding`, `User-Agent`) fill in
 * only what the client left unset. Credentials may declare a static
 * `headers` map, but on this always-streaming direction the streaming
 * transport negotiation is restored afterwards (the claw-back), so a
 * configured `Accept`/`Accept-Encoding` override does not survive.
 *
 * The `claude-code-cli` fingerprint profile leaves caller-owned mode and
 * emits the Claude Code CLI identity instead (recorded case 21).
 */
import {
  CLAUDE_CODE_CLI_APP,
  CLAUDE_CODE_CLI_BETAS,
  CLAUDE_CODE_CLI_STAINLESS_HEADERS,
  CLAUDE_CODE_CLI_TIMEOUT_SECONDS,
  CLAUDE_CODE_CLI_USER_AGENT,
  claudeCodeCliBetas,
} from './profile'
import type { ClaudeCodeCliIdentity, WireObject } from './types'

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
 * Client headers forwarded verbatim (names are matched lower-case):
 * everything else - including `X-Mock-*` - is dropped.
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

export interface ClaudeUpstreamHeadersInput {
  /** Client request headers as received (any casing). */
  readonly clientHeaders: Readonly<Record<string, string>>
  /** Credential api-key. */
  readonly apiKey: string
  /** Credential `base-url`; Anthropic's own host switches the auth header. */
  readonly baseUrl: string
  /** Gateway version for the User-Agent fallback (recorded: `v7.3.4`). */
  readonly gatewayVersion?: string
  /** Credential-level static `headers` map (applied last, then clawed back). */
  readonly credentialHeaders?: Readonly<Record<string, string>>
  /** `fingerprint-profile: claude-code-cli` on the credential. */
  readonly fingerprintProfile?: 'claude-code-cli'
  /** Identity values for the CLI profile. */
  readonly cliIdentity?: ClaudeCodeCliIdentity
  /** Translated upstream body (managed-beta strip reads its thinking/model). */
  readonly body?: Readonly<WireObject>
  /** Body-lifted `betas` (Claude-surface field; chat clients never send it). */
  readonly bodyBetas?: readonly string[]
  /** Per-request CLI retry counter (`X-Stainless-Retry-Count`). */
  readonly retryCount?: number
}

/**
 * Builds the upstream header set. The result is a plain record; the
 * executor adds `Host`, `Content-Length` and transport-owned headers.
 * Header order is not contract material (the wire log is a map).
 */
export function buildClaudeUpstreamHeaders(input: ClaudeUpstreamHeadersInput): Record<string, string> {
  const anthropicBase = isAnthropicBase(input.baseUrl)
  const headers: Record<string, string> = {}

  // Forwarded client headers keep the caller's name casing (the reference
  // copies them verbatim); gateway-set headers below use canonical names.
  for (const name of Object.keys(input.clientHeaders)) {
    if (forwardedClientName(name)) headers[name] = input.clientHeaders[name] ?? ''
  }

  if (anthropicBase) {
    headers['x-api-key'] = input.apiKey
  } else {
    headers['Authorization'] = `Bearer ${input.apiKey}`
  }
  headers['Content-Type'] = 'application/json'
  headers['Anthropic-Version'] = pick(input.clientHeaders, 'anthropic-version') ?? DEFAULT_ANTHROPIC_VERSION

  if (input.fingerprintProfile === 'claude-code-cli') {
    applyCliProfileHeaders(headers, input)
    return headers
  }

  const callerAccept = pick(input.clientHeaders, 'accept')
  if (callerAccept !== undefined) headers['Accept'] = callerAccept
  else if (!anthropicBase) headers['Accept'] = 'text/event-stream'

  const callerEncoding = pick(input.clientHeaders, 'accept-encoding')
  if (callerEncoding !== undefined) headers['Accept-Encoding'] = callerEncoding
  else if (!anthropicBase) headers['Accept-Encoding'] = 'identity'

  headers['User-Agent'] =
    pick(input.clientHeaders, 'user-agent') ?? gatewayUserAgent(input.gatewayVersion ?? 'v7.3.4')

  const callerBeta = pick(input.clientHeaders, 'anthropic-beta')
  const betas = mergeBetas(callerBeta, input.bodyBetas ?? [])
  if (betas.length > 0) headers['Anthropic-Beta'] = betas.join(',')

  const credentialHeaders = input.credentialHeaders ?? {}
  for (const name of Object.keys(credentialHeaders)) {
    headers[name] = credentialHeaders[name] ?? ''
  }
  // Claw-back (S2d3 2.3): on streaming requests to a non-Anthropic base the
  // transport negotiation is restored, so credential Accept/Accept-Encoding
  // overrides do not survive this direction.
  if (!anthropicBase) {
    headers['Accept'] = callerAccept ?? 'text/event-stream'
    headers['Accept-Encoding'] = callerEncoding ?? 'identity'
  }
  return headers
}

function mergeBetas(callerBeta: string | undefined, extraBetas: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const beta of [...splitBeta(callerBeta), ...extraBetas]) {
    if (beta.length === 0 || seen.has(beta)) continue
    seen.add(beta)
    out.push(beta)
  }
  return out
}

function splitBeta(value: string | undefined): string[] {
  if (value === undefined) return []
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

function applyCliProfileHeaders(headers: Record<string, string>, input: ClaudeUpstreamHeadersInput): void {
  headers['User-Agent'] = CLAUDE_CODE_CLI_USER_AGENT
  headers['Accept'] = 'text/event-stream'
  headers['Accept-Encoding'] = 'identity'
  headers['Connection'] = 'keep-alive'
  headers['X-App'] = CLAUDE_CODE_CLI_APP
  headers['Anthropic-Dangerous-Direct-Browser-Access'] = 'true'
  if (input.cliIdentity !== undefined) {
    headers['X-Claude-Code-Session-Id'] = input.cliIdentity.sessionId
  }
  for (const [name, value] of Object.entries(CLAUDE_CODE_CLI_STAINLESS_HEADERS)) {
    if (name === 'X-Stainless-Retry-Count' && input.retryCount !== undefined) {
      headers[name] = String(input.retryCount)
      continue
    }
    headers[name] = value
  }
  headers['X-Stainless-Timeout'] = String(CLAUDE_CODE_CLI_TIMEOUT_SECONDS)

  const betas = input.body !== undefined ? claudeCodeCliBetas(input.body) : CLAUDE_CODE_CLI_BETAS
  headers['Anthropic-Beta'] = mergeBetas(betas.join(','), [pick(input.clientHeaders, 'anthropic-beta') ?? ''])
    .filter((beta) => beta.length > 0)
    .join(',')

  const callerVersion = pick(input.clientHeaders, 'anthropic-version')
  if (callerVersion !== undefined) headers['Anthropic-Version'] = callerVersion
}
