
/**
 * Upstream header assembly for the Codex passthrough (S2d9 3.2).
 *
 * Application order mirrors the recorded wire: gateway-owned fixed
 * headers first, then the client-header whitelist, then the credential's
 * `headers` map (whose `$name` values copy that client header), and the
 * codex-tui cloaking pair LAST (it overrides `User-Agent` and
 * `Originator` unconditionally, so caller values survive only with
 * `disable-codex-cloaking`). The RESOLVED `Session-Id` (client body key,
 * else client session header, else the derived UUID) always wins over the
 * whitelist copy. Header names re-cast to the canonical MIME form the
 * reference's HTTP stack writes (e.g. a client
 * `X-OpenAI-Internal-Codex-Responses-Lite` travels as
 * `X-Openai-Internal-Codex-Responses-Lite`).
 */

/** Ordered header list: `[name, value]` pairs, canonical casing. */
export type HeaderList = ReadonlyArray<readonly [string, string]>

/** Cloaked User-Agent the codex executor sends with cloaking enabled. */
export const CODEX_USER_AGENT =
  'codex-tui/0.154.0 (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; 0.154.0)'

/** Cloaked Originator header value. */
export const CODEX_ORIGINATOR = 'codex-tui'

/** Client headers forwarded to the codex upstream (matched lower-case). */
const FORWARDED_CLIENT_NAMES: readonly string[] = [
  'version',
  'x-codex-turn-metadata',
  'x-codex-turn-state',
  'x-client-request-id',
  'x-codex-window-id',
  'thread-id',
  'x-openai-internal-codex-responses-lite',
  'x-codex-beta-features',
  'originator',
]

export interface PassthroughUpstreamHeadersInput {
  /** Client request headers as received (any casing). */
  readonly clientHeaders: Readonly<Record<string, string>>
  /** Credential api-key (`Authorization: Bearer <key>`). */
  readonly apiKey: string
  /** Resolved session identity stamped onto `Session-Id`. */
  readonly sessionId: string
  /** `text/event-stream` for /responses, `application/json` for compact. */
  readonly accept: 'text/event-stream' | 'application/json'
  /** `codex.disable-codex-cloaking: true` keeps the caller UA/Originator. */
  readonly disableCodexCloaking?: boolean
  /** Gateway version for the User-Agent fallback when cloaking is off. */
  readonly gatewayVersion?: string
  /** Credential-level static `headers` map. */
  readonly credentialHeaders?: Readonly<Record<string, string>>
}

/**
 * Re-casts a header name the way the reference's HTTP stack does: the
 * first letter of every dash-separated word upper-case, the rest
 * lower-case.
 */
export function canonicalHeaderName(name: string): string {
  let out = ''
  let upperNext = true
  for (let i = 0; i < name.length; i++) {
    const current = name.charAt(i)
    if (current === '-') {
      out += '-'
      upperNext = true
      continue
    }
    out += upperNext === true ? current.toUpperCase() : current.toLowerCase()
    upperNext = false
  }
  return out
}

/** Case-insensitive header read. */
function pick(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  const lower = name.toLowerCase()
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key]
  }
  return undefined
}

/**
 * Builds the upstream header set as a plain record (emission order is
 * applied separately). Everything the client sends outside the whitelist
 * - cookies, Accept, arbitrary headers - is dropped; the client's own
 * Authorization never reaches the upstream.
 */
export function buildPassthroughUpstreamHeaders(input: PassthroughUpstreamHeadersInput): Record<string, string> {
  const headers: Record<string, string> = {}

  headers['Content-Type'] = 'application/json'
  headers['Authorization'] = `Bearer ${input.apiKey}`
  headers['Accept'] = input.accept
  headers['Connection'] = 'Keep-Alive'
  // The reference transport negotiates compression unconditionally; the
  // recorded upstream wire always carries this pair.
  headers['Accept-Encoding'] = 'gzip'
  headers['Session-Id'] = input.sessionId

  for (const name of FORWARDED_CLIENT_NAMES) {
    const value = pick(input.clientHeaders, name)
    if (value === undefined) continue
    headers[canonicalHeaderName(name)] = value
  }

  for (const [name, rawValue] of Object.entries(input.credentialHeaders ?? {})) {
    if (rawValue === undefined) continue
    if (rawValue.startsWith('$')) {
      const copied = pick(input.clientHeaders, rawValue.slice(1))
      if (copied === undefined) continue
      headers[canonicalHeaderName(name)] = copied
      continue
    }
    headers[canonicalHeaderName(name)] = rawValue
  }

  if (input.disableCodexCloaking === true) {
    const callerOriginator = pick(input.clientHeaders, 'originator')
    const credentialOriginator = pick(input.credentialHeaders ?? {}, 'originator')
    if (callerOriginator !== undefined && callerOriginator.length > 0) {
      headers['Originator'] = callerOriginator
    } else if (credentialOriginator === undefined) {
      // API-key credentials send no Originator unless the client or the
      // credential configuration supplied one.
      delete headers['Originator']
    }
    const callerAgent = pick(input.clientHeaders, 'user-agent')
    headers['User-Agent'] =
      callerAgent !== undefined && callerAgent.length > 0 ? callerAgent : gatewayUserAgent(input.gatewayVersion)
    return headers
  }

  // Cloaking LAST: overrides both headers unconditionally.
  headers['User-Agent'] = CODEX_USER_AGENT
  headers['Originator'] = CODEX_ORIGINATOR
  return headers
}

/** User-Agent fallback when cloaking is off and the client sent none. */
export function gatewayUserAgent(version: string | undefined): string {
  return `CLIProxyAPI/${version ?? 'v7.3.4'}`
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

/**
 * Emission order pinned by the recorded wire: `Host`, `User-Agent` and
 * `Content-Length` first, the remaining names in ASCII order, and
 * `Accept-Encoding` (transport-owned) last.
 */
export function orderPassthroughUpstreamHeaders(
  map: Readonly<Record<string, string>>,
  url: string,
  body: string,
): HeaderList {
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

/** HeaderList -> plain record (last value wins, original casing kept). */
export function headerListToRecord(list: HeaderList): Record<string, string> {
  const record: Record<string, string> = {}
  for (const [name, value] of list) record[name] = value
  return record
}

/** Case-insensitive single-header read from a header list. */
export function readHeaderValue(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  return pick(headers, name)
}
