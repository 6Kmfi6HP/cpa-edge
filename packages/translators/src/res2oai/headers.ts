/**
 * Upstream header assembly for the openai-compatibility executor
 * (S2d6 section 3.2).
 *
 * Client headers are NOT forwarded (recorded wire fact): the request
 * carries only the gateway-owned set - `Content-Type`, `Authorization`,
 * `User-Agent: cli-proxy-openai-compat` - plus the stream-only pair
 * `Accept: text/event-stream` and `Cache-Control: no-cache`. The
 * transport owns `Accept-Encoding: gzip`. Emission order is pinned by the
 * recorded wire log: `Host`, `User-Agent`, `Content-Length` first, the
 * remaining names in ASCII order, `Accept-Encoding` last.
 */

/** Ordered header list: `[name, value]` pairs, original casing. */
export type HeaderList = ReadonlyArray<readonly [string, string]>

export interface UpstreamHeadersInput {
  /** Credential api-key (`Authorization: Bearer <key>`). */
  readonly apiKey: string
  /** Stream mode adds `Accept` and `Cache-Control` (S2d6 3.2). */
  readonly stream: boolean
}

/** Builds the gateway-owned upstream header record. */
export function buildUpstreamHeaders(input: UpstreamHeadersInput): Record<string, string> {
  const headers: Record<string, string> = {}
  headers['Content-Type'] = 'application/json'
  headers['Authorization'] = `Bearer ${input.apiKey}`
  headers['User-Agent'] = 'cli-proxy-openai-compat'
  headers['Accept-Encoding'] = 'gzip'
  if (input.stream) {
    headers['Accept'] = 'text/event-stream'
    headers['Cache-Control'] = 'no-cache'
  }
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
 * Emission order pinned by the recorded wire log: `Host`, `User-Agent`
 * and `Content-Length` first, the remaining names in ASCII order (the
 * recorded non-stream tail `Authorization, Content-Type`; the stream tail
 * `Accept, Authorization, Cache-Control, Content-Type`), then
 * `Accept-Encoding` (transport-owned) last.
 */
export function orderUpstreamHeaders(
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

/** Header-list -> record (last occurrence wins), casing preserved. */
export function headerListToRecord(list: HeaderList): Record<string, string> {
  const record: Record<string, string> = {}
  for (const [name, value] of list) record[name] = value
  return record
}

/** Case-insensitive header read. */
export function readHeaderValue(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  const lower = name.toLowerCase()
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key]
  }
  return undefined
}
