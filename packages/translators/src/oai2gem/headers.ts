/**
 * Upstream header assembly for the gemini-api-key executor (S2d1 2.3).
 *
 * The recorded wire pins the exact set, names and order (the Go client's
 * canonical spellings): `Host`, `User-Agent: Go-http-client/1.1`,
 * `Content-Length`, `Content-Type: application/json`, `X-Goog-Api-Key`,
 * `Accept-Encoding: gzip`. No client headers are forwarded (credential
 * `headers:` entries are the only exception, not exercised by the
 * goldens), `Authorization` is never set, and NO `Accept` header is sent -
 * stream-ness is expressed by the URL alone
 * (`:streamGenerateContent?alt=sse`).
 */
import type { HeaderList } from './types'

/** User-Agent of the recorded upstream wire (the Go transport default). */
export const GEMINI_UPSTREAM_USER_AGENT = 'Go-http-client/1.1'

/** Header input of one upstream attempt. */
export interface GeminiUpstreamHeadersInput {
  /** Credential api-key; the whole `x-goog-api-key` value (recorded). */
  readonly apiKey: string
  /** Absolute upstream URL (its host becomes the `Host` header). */
  readonly url: string
  /** Serialized upstream body (drives `Content-Length`). */
  readonly body: string
  /** Credential-level static headers, applied last (config `headers:`). */
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
 * body's UTF-8 bytes. A credential header whose name (case-insensitively)
 * matches a transport header replaces it in place; new names append.
 */
export function buildGeminiUpstreamHeaders(input: GeminiUpstreamHeadersInput): HeaderList {
  const headers: Array<[string, string]> = [
    ['Host', hostOf(input.url)],
    ['User-Agent', GEMINI_UPSTREAM_USER_AGENT],
    ['Content-Length', String(new TextEncoder().encode(input.body).length)],
    ['Content-Type', 'application/json'],
    ['X-Goog-Api-Key', input.apiKey],
    ['Accept-Encoding', 'gzip'],
  ]
  for (const name of Object.keys(input.credentialHeaders ?? {})) {
    const value = input.credentialHeaders?.[name] ?? ''
    const existing = headers.findIndex(([headerName]) => headerName.toLowerCase() === name.toLowerCase())
    if (existing >= 0) {
      headers.splice(existing, 1)
      headers.push([name, value])
      continue
    }
    headers.push([name, value])
  }
  return headers
}
