/**
 * Trace-id family (S1 §2): the runtime owns trace emission; translator
 * facades never do. A facade-set `X-Cpa-Trace-Id` value is replaced so
 * the format stays gateway-controlled.
 */

/** Wire-cased header name (recorded casing, not the uppercase constant). */
export const TRACE_HEADER = 'X-Cpa-Trace-Id'

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

function stamp(now: Date): string {
  return (
    String(now.getFullYear()) +
    pad2(now.getMonth() + 1) +
    pad2(now.getDate()) +
    pad2(now.getHours()) +
    pad2(now.getMinutes()) +
    pad2(now.getSeconds())
  )
}

function randomHex32(): string {
  const bytes = new Uint8Array(4)
  crypto.getRandomValues(bytes)
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}

/**
 * Format `<yyyyMMddHHmmss>-<credential index>-<request id>` (recorded
 * shape; the VALUE is a masked dynamic field in every fixture).
 */
export function newTraceId(credentialIndex: number, now: Date): string {
  return `${stamp(now)}-${credentialIndex}-${randomHex32()}`
}
