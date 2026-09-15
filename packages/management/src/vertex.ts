/**
 * Vertex service-account private-key normalization (S5 vertex/import):
 * PEM parsing, PKCS#8 -> PKCS#1 re-encoding and the error-message family
 * the import ladder pins. Pure Web Standard byte work.
 */

import { decodeBase64, encodeBase64 } from './wire'

export class ServiceAccountError extends Error {}

/** Extracts the armored payload of a PEM block; errors reference markers. */
function extractPem(text: string): { readonly label: string; readonly base64: string } {
  const beginMatch = /^-----BEGIN ([A-Z0-9 ]+)-----\s*\n/.exec(text)
  if (beginMatch === null) {
    throw new ServiceAccountError('private_key is not valid pem: missing pem markers')
  }
  const endMatch = /\n-----END ([A-Z0-9 ]+)-----\s*$/.exec(text)
  if (endMatch === null) {
    throw new ServiceAccountError('private_key is not valid pem: missing pem markers')
  }
  const label = beginMatch[1] ?? ''
  if (label !== (endMatch[1] ?? '')) {
    throw new ServiceAccountError('private_key is not valid pem: missing pem markers')
  }
  const body = text.slice(beginMatch[0].length, text.length - endMatch[0].length)
  const base64 = body.replaceAll(/\s+/g, '')
  if (base64 === '') {
    throw new ServiceAccountError('private_key is not valid pem: private_key base64 payload empty')
  }
  let decoded: Uint8Array
  try {
    decoded = decodeBase64(base64)
  } catch {
    throw new ServiceAccountError('private_key is not valid pem: illegal base64 data')
  }
  if (decoded.length === 0) {
    throw new ServiceAccountError('private_key is not valid pem: private_key base64 payload empty')
  }
  return { label, base64 }
}

/** Minimal DER reader: sequential tag/length/value traversal. */
class DerReader {
  offset = 0

  constructor(private readonly bytes: Uint8Array) {}

  readTag(): number {
    if (this.offset >= this.bytes.length) throw new ServiceAccountError('private_key pem decode failed')
    const tag = this.bytes[this.offset] ?? 0
    this.offset += 1
    return tag
  }

  readLength(): number {
    if (this.offset >= this.bytes.length) throw new ServiceAccountError('private_key pem decode failed')
    const first = this.bytes[this.offset] ?? 0
    this.offset += 1
    if ((first & 0x80) === 0) return first
    const count = first & 0x7f
    if (count === 0 || count > 4 || this.offset + count > this.bytes.length) {
      throw new ServiceAccountError('private_key pem decode failed')
    }
    let value = 0
    for (let i = 0; i < count; i += 1) {
      value = value * 256 + (this.bytes[this.offset + i] ?? 0)
    }
    this.offset += count
    return value
  }

  readBytes(tag: number): Uint8Array {
    const actual = this.readTag()
    if (actual !== tag) throw new ServiceAccountError('private_key pem decode failed')
    const length = this.readLength()
    if (this.offset + length > this.bytes.length) throw new ServiceAccountError('private_key pem decode failed')
    const out = this.bytes.slice(this.offset, this.offset + length)
    this.offset += length
    return out
  }

  readInt(): Uint8Array {
    return this.readBytes(0x02)
  }

  skip(tag: number): void {
    const actual = this.readTag()
    if (actual !== tag) throw new ServiceAccountError('private_key pem decode failed')
    const length = this.readLength()
    this.offset += length
    if (this.offset > this.bytes.length) throw new ServiceAccountError('private_key pem decode failed')
  }
}

function derLengthBytes(length: number): number[] {
  if (length < 0x80) return [length]
  const bytes: number[] = []
  let value = length
  while (value > 0) {
    bytes.unshift(value & 0xff)
    value = Math.floor(value / 256)
  }
  return [0x80 | bytes.length, ...bytes]
}

function derInteger(bytes: Uint8Array): number[] {
  let start = 0
  while (start < bytes.length - 1 && bytes[start] === 0x00) start += 1
  let trimmed = bytes.slice(start)
  if ((trimmed[0] ?? 0) & 0x80) {
    trimmed = new Uint8Array([0x00, ...trimmed])
  }
  return [0x02, ...derLengthBytes(trimmed.length), ...Array.from(trimmed)]
}

/**
 * Parses the private key PEM and returns the canonical PKCS#1
 * `RSAPrivateKey` DER. Accepted inputs: PKCS#8 (`PRIVATE KEY`, unwrapped to
 * its inner key) and native PKCS#1 (`RSA PRIVATE KEY`); everything else
 * rejects with the recorded error family.
 */
export function normalizePrivateKeyPem(pem: string): { readonly der: Uint8Array; readonly kind: 'pkcs1' | 'pkcs8' } {
  const { label, base64 } = extractPem(pem)
  const der = decodeBase64(base64)
  if (label === 'PRIVATE KEY') {
    const reader = new DerReader(der)
    reader.skip(0x30)
    const version = reader.readInt()
    if (version.length > 1 || (version[0] ?? 0) > 0) {
      throw new ServiceAccountError('private_key invalid pkcs8: unsupported version')
    }
    reader.skip(0x30)
    const inner = reader.readBytes(0x04)
    return { der: parseRsaPrivateKey(inner), kind: 'pkcs8' }
  }
  if (label === 'RSA PRIVATE KEY') {
    return { der: parseRsaPrivateKey(der), kind: 'pkcs1' }
  }
  throw new ServiceAccountError('private_key uses unsupported format')
}

/** Parses an `RSAPrivateKey` DER (nine INTEGERs) and re-encodes canonically. */
function parseRsaPrivateKey(der: Uint8Array): Uint8Array {
  const reader = new DerReader(der)
  reader.skip(0x30)
  const integers: Uint8Array[] = []
  for (let i = 0; i < 9; i += 1) {
    integers.push(reader.readInt())
  }
  const modulus = integers[1]
  if (modulus === undefined || modulus.length < 96) {
    throw new ServiceAccountError('private_key invalid rsa: key too small')
  }
  const body: number[] = []
  for (const value of integers) {
    body.push(...derInteger(value))
  }
  return new Uint8Array([0x30, ...derLengthBytes(body.length), ...body])
}

/** Renders a DER payload as a 64-column PEM block. */
export function renderPem(label: string, der: Uint8Array): string {
  const base64 = encodeBase64(der)
  const lines: string[] = []
  for (let i = 0; i < base64.length; i += 64) {
    lines.push(base64.slice(i, i + 64))
  }
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`
}

/** Full import-path normalization: PEM in, PKCS#1 PEM out. */
export function reEncodePrivateKey(pem: string): string {
  const { der } = normalizePrivateKeyPem(pem)
  return renderPem('RSA PRIVATE KEY', der)
}
