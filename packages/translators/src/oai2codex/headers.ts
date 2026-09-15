/**
 * Upstream header assembly for the Codex executor (S2d5 section 2.2).
 *
 * Application order: fixed gateway headers first, then the client-header
 * whitelist, then a credential's static `headers` map, then the codex-tui
 * cloaking pair LAST (it overrides `User-Agent` and `Originator`
 * unconditionally, so caller values survive only with
 * `disable-codex-cloaking`). The emission order is pinned separately by
 * {@link orderCodexUpstreamHeaders} to match the recorded wire.
 */
import { CODEX_ORIGINATOR, CODEX_USER_AGENT } from './types'

/** Ordered header list: `[name, value]` pairs, original casing. */
export type HeaderList = ReadonlyArray<readonly [string, string]>

/** Client headers forwarded to the codex upstream (names matched lower-case). */
const FORWARDED_CLIENT_NAMES: ReadonlySet<string> = new Set([
  'x-codex-beta-features',
  'version',
  'x-codex-turn-metadata',
  'x-codex-turn-state',
  'x-client-request-id',
  'x-codex-window-id',
  'thread-id',
  'session-id',
  'x-openai-internal-codex-responses-lite',
  'originator',
])

/** User-Agent fallback when cloaking is off and the client sent none. */
export function gatewayUserAgent(version: string): string {
  return `CLIProxyAPI/${version}`
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
 * case-variant twin an earlier write left behind: one logical header must
 * never occupy two keys, or a transport serializing the map would emit it
 * twice.
 */
function setCanonicalHeader(headers: Record<string, string>, name: string, value: string): void {
  const lower = name.toLowerCase()
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) delete headers[key]
  }
  headers[name] = value
}

export interface CodexUpstreamHeadersInput {
  /** Client request headers as received (any casing). */
  readonly clientHeaders: Readonly<Record<string, string>>
  /** Credential api-key (`Authorization: Bearer <key>`). */
  readonly apiKey: string
  /** Session identity stamped onto `Session-Id` and the body. */
  readonly sessionId: string
  /** `codex.disable-codex-cloaking: true` keeps caller UA/Originator. */
  readonly disableCodexCloaking?: boolean
  /** Gateway version for the User-Agent fallback when cloaking is off. */
  readonly gatewayVersion?: string
  /** Credential-level static `headers` map (applied after the whitelist). */
  readonly credentialHeaders?: Readonly<Record<string, string>>
}

/**
 * Builds the upstream header set (a plain record; emission order is applied
 * separately). Everything the client sends outside the whitelist - cookies,
 * Accept, Content-Type, arbitrary headers - is dropped.
 */
export function buildCodexUpstreamHeaders(input: CodexUpstreamHeadersInput): Record<string, string> {
  const headers: Record<string, string> = {}

  setCanonicalHeader(headers, 'Content-Type', 'application/json')
  setCanonicalHeader(headers, 'Authorization', `Bearer ${input.apiKey}`)
  setCanonicalHeader(headers, 'Accept', 'text/event-stream')
  setCanonicalHeader(headers, 'Connection', 'Keep-Alive')
  // The recorded wire always carries gzip here (the reference transport
  // negotiates compression unconditionally); mirroring it keeps the header
  // list byte-comparable.
  setCanonicalHeader(headers, 'Accept-Encoding', 'gzip')
  setCanonicalHeader(headers, 'Session-Id', input.sessionId)

  for (const name of Object.keys(input.clientHeaders)) {
    if (FORWARDED_CLIENT_NAMES.has(name.toLowerCase())) headers[name] = input.clientHeaders[name] ?? ''
  }

  for (const name of Object.keys(input.credentialHeaders ?? {})) {
    const value = (input.credentialHeaders ?? {})[name]
    if (value !== undefined) headers[name] = value
  }

  if (input.disableCodexCloaking === true) {
    const callerOriginator = pick(input.clientHeaders, 'originator')
    if (callerOriginator !== undefined && callerOriginator.length > 0) {
      setCanonicalHeader(headers, 'Originator', callerOriginator)
    }
    setCanonicalHeader(headers, 'User-Agent', pick(input.clientHeaders, 'user-agent') ?? gatewayUserAgent(input.gatewayVersion ?? 'v7.3.4'))
    return headers
  }

  // Cloaking LAST: overrides both headers unconditionally.
  setCanonicalHeader(headers, 'User-Agent', CODEX_USER_AGENT)
  setCanonicalHeader(headers, 'Originator', CODEX_ORIGINATOR)
  return headers
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

/**
 * Emission order pinned by the recorded wire log: `Host`, `User-Agent` and
 * `Content-Length` first, the remaining names in ASCII order, and
 * `Accept-Encoding` (transport-owned) last.
 */
export function orderCodexUpstreamHeaders(map: Readonly<Record<string, string>>, url: string, body: string): HeaderList {
  const merged: Record<string, string> = {}
  for (const [name, value] of Object.entries(map)) merged[name] = value
  delete merged['Host']
  const rest = Object.keys(merged)
    .filter((name) => name !== 'User-Agent' && name !== 'Content-Length' && name !== 'Accept-Encoding')
    .sort()
    .map((name) => [name, merged[name] ?? ''] as [string, string])
  return [
    ['Host', hostOf(url)],
    ['User-Agent', merged['User-Agent'] ?? ''],
    ['Content-Length', String(new TextEncoder().encode(body).length)],
    ...rest,
    ['Accept-Encoding', merged['Accept-Encoding'] ?? ''],
  ]
}
