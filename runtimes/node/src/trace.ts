/**
 * Trace-id family (S1 §2): the runtime owns trace emission; translator
 * facades never do. A facade-set `X-Cpa-Trace-Id` value is replaced so
 * the format stays gateway-controlled.
 */
import type { GatewayBody } from './types'

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

/**
 * Selector-envelope markers: the one resolved-model answer family the
 * recorded goldens never trace. The facades render the model-cooldown
 * and auth-unavailable answers without an upstream call and without a
 * trace header of their own, and the route layer must not add one on
 * top (R-TRACE scopes the header to executor-routed responses).
 */
const SELECTOR_ENVELOPE_MARKERS: readonly string[] = Object.freeze([
  // OpenAI-shaped cooldown body: {"error":{"code":"model_cooldown",...
  '"code":"model_cooldown"',
  // Claude-shaped cooldown body: ...,"message":"All credentials for model ...
  '"message":"All credentials for model ',
  // Codex auth-unavailable selection error (the S2d9-18 shape).
  '"auth_unavailable: no auth available',
])

/**
 * True when a facade-produced body is a selector envelope (model
 * cooldown / auth unavailable). Stream bodies never are: the SSE commit
 * path is executor-routed by construction.
 */
export function isSelectorEnvelope(body: GatewayBody): boolean {
  if (typeof body !== 'string') return false
  return SELECTOR_ENVELOPE_MARKERS.some((marker) => body.includes(marker))
}
