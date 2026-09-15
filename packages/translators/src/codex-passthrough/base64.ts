
/**
 * Minimal base64url decoder (RFC 4648 section 5, with `=` padding
 * accepted). Decoder input stays latin-1; no platform APIs are used.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

const REVERSE = new Int8Array(128).fill(-1)
for (let i = 0; i < ALPHABET.length; i++) {
  REVERSE[ALPHABET.charCodeAt(i)] = i
}

/**
 * Decodes base64url text to bytes. Returns `undefined` for any character
 * outside the alphabet (padding included) or a length that cannot describe
 * whole bytes.
 */
export function decodeBase64Url(text: string): Uint8Array | undefined {
  let length = text.length
  while (length > 0 && text[length - 1] === '=') length--
  const rem = length % 4
  if (rem === 1) return undefined
  const byteLength = Math.floor(length / 4) * 3 + (rem === 0 ? 0 : rem === 2 ? 1 : 2)
  const out = new Uint8Array(byteLength)
  let outIndex = 0
  let buffer = 0
  let bits = 0
  for (let i = 0; i < length; i++) {
    const code = text.charCodeAt(i)
    const value = code < 128 ? REVERSE[code] ?? -1 : -1
    if (value < 0) return undefined
    buffer = (buffer << 6) | value
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[outIndex] = (buffer >> bits) & 0xff
      outIndex++
    }
  }
  return out
}
