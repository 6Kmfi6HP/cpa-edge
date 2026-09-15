
/** Web-Crypto digests (the only crypto the passthrough needs). */
const encoder = new TextEncoder()

/** SHA-256 of a UTF-8 string as lowercase hex. */
export async function sha256Hex(seed: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(seed))
  return hex(new Uint8Array(digest))
}

function hex(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}
