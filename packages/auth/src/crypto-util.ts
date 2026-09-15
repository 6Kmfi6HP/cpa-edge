/**
 * Cryptographic primitives used by the OAuth flows. Everything goes through
 * the Web Crypto surface (`crypto.subtle`, `crypto.getRandomValues`) so the
 * package stays runtime-agnostic.
 */

/** Lowercase hex of a byte array. */
export function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}

/** Base64url without padding. */
export function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  const base64 = btoa(binary)
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Cryptographically random bytes; the only randomness source in this package. */
export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return bytes
}

/** Random bytes rendered as lowercase hex (e.g. OAuth state values). */
export function randomHex(byteCount: number): string {
  return toHex(randomBytes(byteCount))
}

/** SHA-256 of a UTF-8 string, hex-encoded. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return toHex(new Uint8Array(digest))
}

/** SHA-256 of a UTF-8 string, base64url-encoded without padding (S256 challenges). */
export async function sha256Base64Url(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return toBase64Url(new Uint8Array(digest))
}

/** PKCE pair for the S256 method: verifier plus base64url(SHA-256(verifier)). */
export interface PkcePair {
  readonly verifier: string
  readonly challenge: string
}

// RFC 7636 "unreserved" characters the verifier may consist of.
const VERIFIER_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'

/**
 * Generates a PKCE verifier/challenge pair. The verifier length is 64
 * characters, inside the 43-128 window RFC 7636 requires.
 */
export async function generatePkcePair(): Promise<PkcePair> {
  const bytes = randomBytes(64)
  let verifier = ''
  for (let i = 0; i < bytes.length; i += 1) {
    verifier += VERIFIER_ALPHABET[bytes[i] as number % VERIFIER_ALPHABET.length]
  }
  const challenge = await sha256Base64Url(verifier)
  return { verifier, challenge }
}

/**
 * Compares two strings in time independent of their content. The length
 * comparison is upfront on purpose: lengths are not treated as secret here.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder()
  const left = encoder.encode(a)
  const right = encoder.encode(b)
  if (left.length !== right.length) return false
  let diff = 0
  for (let i = 0; i < left.length; i += 1) {
    diff |= (left[i] as number) ^ (right[i] as number)
  }
  return diff === 0
}

/**
 * Decodes the payload segment of a JWT without verifying any signature.
 * Returns `undefined` for malformed tokens.
 */
export function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split('.')
  if (parts.length < 2) return undefined
  const payload = parts[1]
  if (payload.length === 0) return undefined
  const base64 = payload.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=')
  try {
    const binary = atob(padded)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    return parsed as Record<string, unknown>
  } catch {
    return undefined
  }
}
