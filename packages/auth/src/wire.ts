import type { JsonValue } from '@cpa-edge/core'

/**
 * Byte-parity helpers for the wire surfaces this package produces.
 *
 * The reference implementation serializes JSON with Go's `encoding/json`
 * (map keys marshaled in ascending byte order, HTML characters escaped) and
 * builds query strings with Go's `net/url`. Those formatting rules are part
 * of the recorded contract, so this module reproduces them on purpose:
 * `goJsonStringify` mirrors map marshaling, `jsonStringifyOrdered` mirrors
 * struct marshaling, and the query helpers mirror `url.Values.Encode`.
 */

/** Encodes one string the way Go's JSON encoder escapes it. */
function encodeGoString(value: string): string {
  let out = '"'
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    const ch = value[i]
    if (ch === '"') {
      out += '\\"'
    } else if (ch === '\\') {
      out += '\\\\'
    } else if (ch === '\n') {
      out += '\\n'
    } else if (ch === '\r') {
      out += '\\r'
    } else if (ch === '\t') {
      out += '\\t'
    } else if (code < 0x20) {
      out += `\\u${code.toString(16).padStart(4, '0')}`
    } else if (code === 0x26) {
      // '&'
      out += '\\u0026'
    } else if (code === 0x3c) {
      // '<'
      out += '\\u003c'
    } else if (code === 0x3e) {
      // '>'
      out += '\\u003e'
    } else if (code === 0x2028) {
      out += '\\u2028'
    } else if (code === 0x2029) {
      out += '\\u2029'
    } else {
      out += ch
    }
  }
  return `${out}"`
}

function encodeScalar(value: JsonValue): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return JSON.stringify(value)
  return encodeGoString(value)
}

function encodeValue(
  value: JsonValue,
  sortKeys: boolean,
  seen: Set<JsonValue>,
): string {
  if (value === null || typeof value !== 'object') return encodeScalar(value)
  if (seen.has(value)) throw new Error('cyclic value passed to JSON serializer')
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      let out = '['
      for (let i = 0; i < value.length; i += 1) {
        if (i > 0) out += ','
        out += encodeValue(value[i] as JsonValue, sortKeys, seen)
      }
      return `${out}]`
    }
    const record = value as { [key: string]: JsonValue }
    const keys = Object.keys(record)
    if (sortKeys) keys.sort()
    let out = '{'
    let first = true
    for (const key of keys) {
      const member = record[key]
      if (member === undefined) continue
      if (!first) out += ','
      first = false
      out += `${encodeGoString(key)}:${encodeValue(member, sortKeys, seen)}`
    }
    return `${out}}`
  } finally {
    seen.delete(value)
  }
}

/**
 * Serializes JSON the way Go marshals a map: object keys in ascending byte
 * order, `&`/`<`/`>` escaped as `\u0026`/`\u003c`/`\u003e`. This is the
 * serializer for every response body the reference builds from a map.
 */
export function goJsonStringify(value: JsonValue): string {
  return encodeValue(value, true, new Set<JsonValue>())
}

/**
 * Serializes JSON the way Go marshals a struct: keys stay in insertion
 * order. Used for outbound request bodies whose field order is contract.
 */
export function jsonStringifyOrdered(value: JsonValue): string {
  return encodeValue(value, false, new Set<JsonValue>())
}

/** True when a character survives Go's `encodeQueryComponent` untouched. */
function isQuerySafe(code: number): boolean {
  if (code >= 0x41 && code <= 0x5a) return true
  if (code >= 0x61 && code <= 0x7a) return true
  if (code >= 0x30 && code <= 0x39) return true
  if (code === 0x2d || code === 0x2e || code === 0x5f || code === 0x7e) return true
  return false
}

/** Escapes one value like Go's `url.QueryEscape` (space becomes `+`). */
export function goQueryEscape(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let out = ''
  for (const byte of bytes) {
    if (byte === 0x20) {
      out += '+'
    } else if (isQuerySafe(byte)) {
      out += String.fromCharCode(byte)
    } else {
      out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
    }
  }
  return out
}

/**
 * Encodes a parameter record the way Go's `url.Values.Encode` does: keys
 * sorted in ascending byte order, values query-escaped, pairs joined by `&`.
 */
export function goValuesEncode(values: Readonly<Record<string, string>>): string {
  const keys = Object.keys(values).sort()
  const pairs: string[] = []
  for (const key of keys) {
    const value = values[key]
    if (value === undefined) continue
    pairs.push(`${goQueryEscape(key)}=${goQueryEscape(value)}`)
  }
  return pairs.join('&')
}

/**
 * Formats a duration in whole seconds the way Go prints `time.Duration`:
 * `30m0s`, `29m59s`, `1h30m0s`, `59s`, `0s`. Values are rounded to the
 * nearest second first (half away from zero), matching the recorded
 * countdown that prints `30m0s` just after a ban is set.
 */
export function goDurationString(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h${minutes}m${seconds}s`
  if (minutes > 0) return `${minutes}m${seconds}s`
  return `${seconds}s`
}

/** RFC3339 UTC with seconds precision, the timestamp format of stored docs. */
export function formatRfc3339(ms: number): string {
  const date = new Date(ms)
  const iso = date.toISOString()
  return `${iso.slice(0, 19)}Z`
}

/** Parses an RFC3339 timestamp back into epoch milliseconds. */
export function parseRfc3339Ms(value: string): number | undefined {
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}

function isHexDigit(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x46) ||
    (code >= 0x61 && code <= 0x66)
  )
}

function validPercentEscapes(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) !== 0x25) continue
    if (i + 2 >= value.length) return false
    if (!isHexDigit(value.charCodeAt(i + 1)) || !isHexDigit(value.charCodeAt(i + 2))) {
      return false
    }
    i += 2
  }
  return true
}

function validScheme(scheme: string): boolean {
  if (scheme.length === 0) return false
  const first = scheme.charCodeAt(0)
  if (!((first >= 0x41 && first <= 0x5a) || (first >= 0x61 && first <= 0x7a))) return false
  for (let i = 1; i < scheme.length; i += 1) {
    const code = scheme.charCodeAt(i)
    const ok =
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      (code >= 0x30 && code <= 0x39) ||
      code === 0x2b ||
      code === 0x2d ||
      code === 0x2e
    if (!ok) return false
  }
  return true
}

/**
 * Approximates Go's `url.Parse` accept/reject decision closely enough for
 * the callback contract: rejects control characters, malformed percent
 * escapes, invalid schemes and invalid authority ports/brackets. On success
 * returns the query string (without the leading `?`), possibly empty.
 */
export function parseGoUrl(raw: string): { readonly query: string } | undefined {
  if (raw.length === 0) return { query: '' }
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return undefined
  }
  if (!validPercentEscapes(raw)) return undefined
  const schemeEnd = raw.indexOf(':')
  let rest = raw
  if (schemeEnd > 0) {
    const prefix = raw.slice(0, schemeEnd)
    if (!prefix.includes('/') && !prefix.includes('?') && !prefix.includes('#')) {
      if (!validScheme(prefix)) return undefined
      rest = raw.slice(schemeEnd + 1)
    } else if (prefix.includes(':') === false && prefix.length === 0) {
      return undefined
    }
  }
  if (schemeEnd === 0) return undefined
  if (rest.startsWith('//')) {
    const authorityEnd = (() => {
      for (let i = 2; i < rest.length; i += 1) {
        const ch = rest[i]
        if (ch === '/' || ch === '?' || ch === '#') return i
      }
      return rest.length
    })()
    const authority = rest.slice(2, authorityEnd)
    const atSign = authority.lastIndexOf('@')
    const host = atSign >= 0 ? authority.slice(atSign + 1) : authority
    if (host.includes('[') !== host.includes(']')) return undefined
    if (host.includes('[')) {
      const open = host.indexOf(']')
      const tail = host.slice(open + 1)
      const colon = tail.indexOf(':')
      if (colon >= 0 && !/^\d*$/.test(tail.slice(colon + 1))) return undefined
    } else {
      const colon = host.lastIndexOf(':')
      if (colon >= 0 && !/^\d*$/.test(host.slice(colon + 1))) return undefined
    }
    rest = rest.slice(authorityEnd)
  }
  const queryStart = rest.indexOf('?')
  if (queryStart < 0) return { query: '' }
  const fragmentStart = rest.indexOf('#', queryStart)
  const query = rest.slice(queryStart + 1, fragmentStart < 0 ? undefined : fragmentStart)
  return { query }
}

/** Decodes one `application/x-www-form-urlencoded` string into a record. */
export function parseFormValues(encoded: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const pair of encoded.split('&')) {
    if (pair.length === 0) continue
    const eq = pair.indexOf('=')
    const rawKey = eq < 0 ? pair : pair.slice(0, eq)
    const rawValue = eq < 0 ? '' : pair.slice(eq + 1)
    const key = rawKey.replace(/\+/g, ' ')
    try {
      const decodedKey = decodeURIComponent(key)
      const decodedValue = decodeURIComponent(rawValue.replace(/\+/g, ' '))
      const existing = out[decodedKey]
      if (existing === undefined) out[decodedKey] = decodedValue
    } catch {
      // Malformed escapes fall back to the raw text for this pair.
      out[key] = rawValue
    }
  }
  return out
}

/** Decodes a query string (leading `?` tolerated) into a record. */
export function parseQueryString(query: string): Record<string, string> {
  const trimmed = query.startsWith('?') ? query.slice(1) : query
  return parseFormValues(trimmed)
}
