
/**
 * Structural validation of Responses `encrypted_content` signatures.
 *
 * Codex reasoning items may carry `encrypted_content` produced by the
 * GPT thinking-signature format. The passthrough never decrypts; it only
 * checks the value's SHAPE before deciding the item may keep its
 * `id` (stateful continuation only survives when the encrypted reasoning
 * can round-trip). A value is acceptable when it carries the `gAAAA`
 * prefix, decodes as base64url, spans at least the minimum envelope
 * (73 decoded bytes: one version byte, an 8-byte stamp, a 16-byte IV, a
 * 32-byte MAC and one AES block), starts with the 0x80 version byte, and
 * the ciphertext beyond the fixed header lands on whole AES blocks.
 */
import { decodeBase64Url } from './base64'

/** Prefix every accepted encrypted-content value starts with. */
export const ENCRYPTED_CONTENT_PREFIX = 'gAAAA'

/** Fixed part of the decoded envelope: version + stamp + IV + MAC. */
const ENVELOPE_FIXED_BYTES = 1 + 8 + 16 + 32

/** Smallest accepted decoded length: the fixed header plus one AES block. */
export const MIN_DECODED_BYTES = ENVELOPE_FIXED_BYTES + 16

/** AES block size of the ciphertext section. */
const AES_BLOCK_BYTES = 16

/** Version byte the decoded envelope must start with. */
const VERSION_BYTE = 0x80

/**
 * True when `value` is a syntactically plausible encrypted-content
 * signature. Null, non-strings and whitespace-only values fail.
 */
export function isValidEncryptedContent(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  if (trimmed.length === 0) return false
  if (!trimmed.startsWith(ENCRYPTED_CONTENT_PREFIX)) return false
  // The prefix is how a valid envelope's first bytes read when encoded -
  // the WHOLE value is the base64url payload.
  const decoded = decodeBase64Url(trimmed)
  if (decoded === undefined) return false
  if (decoded.length < MIN_DECODED_BYTES) return false
  if (decoded[0] !== VERSION_BYTE) return false
  return (decoded.length - ENVELOPE_FIXED_BYTES) % AES_BLOCK_BYTES === 0
}
