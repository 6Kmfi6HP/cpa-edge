/**
 * Wire-format helpers: Go-style RFC3339 stamps, header canonicalization,
 * base64url and small JSON readers.
 */

/** Fixed +08:00 offset the recorded log lines use (oracle container TZ). */
export const RECORDED_LOG_TZ_OFFSET_MINUTES = 8 * 60

function pad(value: number, width = 2): string {
  return String(Math.abs(value)).padStart(width, '0')
}

function offsetText(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? '-' : '+'
  const hours = Math.floor(Math.abs(offsetMinutes) / 60)
  const minutes = Math.abs(offsetMinutes) % 60
  return `${sign}${pad(hours)}:${pad(minutes)}`
}

function partsInZone(ms: number, offsetMinutes: number): {
  readonly year: number
  readonly month: number
  readonly day: number
  readonly hours: number
  readonly minutes: number
  readonly seconds: number
} {
  const shifted = new Date(ms + offsetMinutes * 60_000)
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hours: shifted.getUTCHours(),
    minutes: shifted.getUTCMinutes(),
    seconds: shifted.getUTCSeconds(),
  }
}

/** Millisecond fraction in Go RFC3339Nano style (trailing zeros trimmed). */
function fractionOf(ms: number): string {
  const millis = ms % 1000
  if (millis === 0) return ''
  const digits = pad(millis, 3)
  return `.${digits.replace(/0+$/, '')}`
}

/**
 * Local-zone RFC3339 stamp of an epoch-millisecond clock value, the shape
 * the reference emits for auth-file entries, .cds record stamps and usage
 * records (Go `time.Time` JSON marshal). The zero offset renders as
 * `+00:00` because entry stamps are shape-guarded to carry an offset.
 */
export function rfc3339Local(ms: number, offsetMinutes: number): string {
  const p = partsInZone(ms, offsetMinutes)
  return (
    `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hours)}:${pad(p.minutes)}:${pad(p.seconds)}` +
    `${fractionOf(ms)}${offsetText(offsetMinutes)}`
  )
}

/** UTC RFC3339 stamp (envelope `observed_at`, .cds envelope `updated_at`). */
export function rfc3339Utc(ms: number): string {
  const p = partsInZone(ms, 0)
  return (
    `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hours)}:${pad(p.minutes)}:${pad(p.seconds)}` +
    `${fractionOf(ms)}Z`
  )
}

/** Machine-local zone offset in minutes east of UTC (Go `time.Local`). */
export function localZoneOffsetMinutes(): number {
  return -new Date().getTimezoneOffset()
}

/**
 * Parses a `[YYYY-MM-DD HH:MM:SS]` log-line stamp into Unix seconds using
 * the recorded environment's fixed +08:00 zone - the goldens pin that
 * interpretation of the recorded lines.
 */
export function parseLogStampToUnixSeconds(stamp: string, offsetMinutes = RECORDED_LOG_TZ_OFFSET_MINUTES): number {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(stamp)
  if (match === null) return 0
  const [, year, month, day, hours, minutes, seconds] = match
  const ms = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hours), Number(minutes), Number(seconds))
  return Math.floor((ms - offsetMinutes * 60_000) / 1000)
}

/** Renders a log-line `[YYYY-MM-DD HH:MM:SS]` stamp in the local zone. */
export function formatLogStamp(ms: number, offsetMinutes: number): string {
  const p = partsInZone(ms, offsetMinutes)
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hours)}:${pad(p.minutes)}:${pad(p.seconds)}`
}

/** Go `textproto.CanonicalMIMEHeaderKey`. */
export function canonicalHeaderKey(name: string): string {
  const normalized = name.toLowerCase()
  let out = ''
  let upper = true
  for (const ch of normalized) {
    if (ch === '-') {
      out += '-'
      upper = true
      continue
    }
    out += upper ? ch.toUpperCase() : ch
    upper = false
  }
  return out
}

/** Base64url without padding. */
export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  const encoded = typeof btoa === 'function' ? btoa(binary) : Buffer.from(bytes).toString('base64')
  return encoded.replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

/** Base64url decode tolerating missing padding and URL-safe alphabet. */
export function base64UrlDecode(text: string): Uint8Array {
  const base64 = text.replaceAll('-', '+').replaceAll('_', '/')
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
  const binary = typeof atob === 'function' ? atob(padded) : Buffer.from(padded, 'base64').toString('binary')
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** Raw base64 decode of a standard-alphabet string. */
export function decodeBase64(text: string): Uint8Array {
  const binary = typeof atob === 'function' ? atob(text) : Buffer.from(text, 'base64').toString('binary')
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** Raw base64 encode of bytes. */
export function encodeBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return typeof btoa === 'function' ? btoa(binary) : Buffer.from(bytes).toString('base64')
}

/** Hex of raw bytes. */
export function hexOf(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** sha256 digest as raw bytes (WebCrypto). */
export async function sha256Bytes(data: Uint8Array): Promise<Uint8Array> {
  const buffer = await crypto.subtle.digest('SHA-256', data)
  return new Uint8Array(buffer)
}

export function readStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

export function readNumberField(record: Record<string, unknown>, key: number | string): number | undefined {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
