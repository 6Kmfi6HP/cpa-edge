/**
 * Upstream header assembly for the gemini-api-key executor (S2d8 2.2).
 *
 * The recorded wire pins the exact set and order:
 * `Host`, `User-Agent: Go-http-client/1.1`, `Content-Length`,
 * `Content-Type: application/json`, `x-goog-api-key`, `Accept-Encoding: gzip`.
 * No client headers are forwarded (credential `custom-headers` are the
 * only exception, not exercised by the goldens), `Authorization` is never
 * set, and NO `Accept` header is sent - stream-ness is expressed by the
 * URL alone (`:streamGenerateContent?alt=sse`).
 */
/** User-Agent of the recorded upstream wire (Go default client). */
export const GEMINI_UPSTREAM_USER_AGENT = 'Go-http-client/1.1'

/** Ordered header list: `[name, value]` pairs, wire order. */
export type HeaderList = ReadonlyArray<readonly [string, string]>

/** Header input of one upstream attempt. */
export interface GeminiUpstreamHeadersInput {
  /** Credential api-key (sent as `x-goog-api-key`). */
  readonly apiKey: string
  /** Absolute upstream URL (its host becomes the `Host` header). */
  readonly url: string
  /** Serialized upstream body (drives `Content-Length`). */
  readonly body: string
  /** Credential-level static headers, applied last (config `custom-headers`). */
  readonly credentialHeaders?: Readonly<Record<string, string>>
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

/**
 * Builds the ordered upstream header list. `Content-Length` counts the
 * body's UTF-8 bytes (the recorded wire logs match the sent bytes).
 */
export function buildGeminiUpstreamHeaders(input: GeminiUpstreamHeadersInput): HeaderList {
  const headers: Array<[string, string]> = [
    ['Host', hostOf(input.url)],
    ['User-Agent', GEMINI_UPSTREAM_USER_AGENT],
    ['Content-Length', String(new TextEncoder().encode(input.body).length)],
    ['Content-Type', 'application/json'],
    ['x-goog-api-key', input.apiKey],
    ['Accept-Encoding', 'gzip'],
  ]
  for (const name of Object.keys(input.credentialHeaders ?? {})) {
    const value = input.credentialHeaders?.[name] ?? ''
    const existing = headers.findIndex(([headerName]) => headerName.toLowerCase() === name.toLowerCase())
    if (existing >= 0) headers.splice(existing, 1)
    headers.push([name, value])
  }
  return headers
}

/** Header-list -> record (last occurrence wins). */
export function headerListToRecord(list: HeaderList): Record<string, string> {
  const record: Record<string, string> = {}
  for (const [name, value] of list) record[name] = value
  return record
}
