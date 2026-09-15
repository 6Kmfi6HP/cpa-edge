/**
 * JSON helpers for byte-exact wire output in the cla2gem direction.
 *
 * Recorded behaviors this module encodes:
 *
 * - every string the GATEWAY writes into the upstream body is JSON-encoded
 *   with HTML escaping (`<` -> `\u003c`, `>` -> `\u003e`, `&` -> `\u0026`;
 *   recorded case 03: the reminder text arrives upstream escaped);
 * - client-owned values (tool arguments, tool-result blocks, tool schemas)
 *   travel as RAW bytes - their original spacing and key order survive on
 *   the wire, so the serializer splices unvalidated JSON text verbatim;
 * - the request boundary is strict (NE-LENIENT): malformed bodies are
 *   rejected instead of being read best-effort.
 */
import { CpaError } from '@cpa-edge/core'

/**
 * Unvalidated JSON text spliced verbatim into serialized output. Tool
 * arguments, tool-result payloads and schema fragments are embedded with
 * their original formatting, so they must never be re-parsed here.
 */
export class RawJson {
  readonly text: string

  constructor(text: string) {
    this.text = text
  }
}

/** Any value the ordered serializer accepts. */
export type WireValue =
  | string
  | number
  | boolean
  | null
  | RawJson
  | readonly WireValue[]
  | { readonly [key: string]: WireValue }

/** Ordered JSON object builder; key insertion order is the wire order. */
export type WireObject = { [key: string]: WireValue }

/**
 * Parses a client body under the strict request boundary (NE-LENIENT).
 * Anything that is not valid JSON is rejected with `invalid-input`.
 */
export function parseStrictJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new CpaError('invalid-input', 'Invalid request: malformed JSON body')
  }
}

/** True when the value is a JSON object (not an array, not a class instance). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** Reads a string member of a record-like value. */
export function readString(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = (value as Record<string, unknown>)[key]
  return typeof raw === 'string' ? raw : undefined
}

/** Reads an array member of a record-like value. */
export function readArray(value: unknown, key: string): readonly unknown[] | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = (value as Record<string, unknown>)[key]
  return Array.isArray(raw) ? raw : undefined
}

/** Reads an object member of a record-like value. */
export function readObject(value: unknown, key: string): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = (value as Record<string, unknown>)[key]
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  return raw as Record<string, unknown>
}

const HEX = '0123456789abcdef'

/**
 * Serializes one string with JSON escaping plus the recorded HTML escaping:
 * `<`, `>` and `&` never appear literally inside gateway-written strings.
 */
function serializeString(text: string): string {
  let out = '"'
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    switch (code) {
      case 0x22:
        out += '\\"'
        break
      case 0x26:
        out += '\\u0026'
        break
      case 0x3c:
        out += '\\u003c'
        break
      case 0x3e:
        out += '\\u003e'
        break
      case 0x5c:
        out += '\\\\'
        break
      case 0x08:
        out += '\\b'
        break
      case 0x0c:
        out += '\\f'
        break
      case 0x0a:
        out += '\\n'
        break
      case 0x0d:
        out += '\\r'
        break
      case 0x09:
        out += '\\t'
        break
      case 0x2028:
      case 0x2029:
        out +=
          '\\u' +
          HEX[(code >>> 12) & 0xf] +
          HEX[(code >>> 8) & 0xf] +
          HEX[(code >>> 4) & 0xf] +
          HEX[code & 0xf]
        break
      default:
        if (code < 0x20) {
          out += '\\u00' + HEX[(code >>> 4) & 0xf] + HEX[code & 0xf]
        } else {
          out += text[i]
        }
    }
  }
  return out + '"'
}

/**
 * Serializes a value in key-insertion order with compact separators and
 * HTML-escaped strings. `RawJson` members are spliced verbatim (client
 * bytes). Rejects values that cannot appear on a JSON wire.
 */
export function serializeOrdered(value: WireValue): string {
  if (value instanceof RawJson) return value.text
  if (value === null) return 'null'
  if (typeof value === 'string') return serializeString(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new CpaError('invalid-input', 'cannot serialize non-finite number')
    }
    return String(value)
  }
  if (Array.isArray(value)) {
    let out = '['
    for (let i = 0; i < value.length; i++) {
      if (i > 0) out += ','
      out += serializeOrdered(value[i] as WireValue)
    }
    return out + ']'
  }
  if (!isPlainObject(value)) {
    throw new CpaError('invalid-input', 'cannot serialize non-JSON value')
  }
  let out = '{'
  let first = true
  for (const key of Object.keys(value)) {
    const member = (value as Record<string, unknown>)[key]
    if (member === undefined) continue
    if (!first) out += ','
    first = false
    out += serializeString(key) + ':' + serializeOrdered(member as WireValue)
  }
  return out + '}'
}

// ---------------------------------------------------------------------------
// Raw-byte scanner (values are spliced by span, never re-serialized)
// ---------------------------------------------------------------------------

interface ValueSpan {
  readonly valueStart: number
  readonly valueEnd: number
}

/**
 * Locates the RAW text of the value at a path inside a JSON document that
 * `JSON.parse` already accepted. Path segments name object members or
 * array indices (as strings). Tool arguments, tool-result blocks and
 * schema fragments are embedded with their original spacing, so the
 * translation needs the original bytes, not a re-serialization.
 */
/** Byte offsets of one located value inside its JSON document. */
export interface RawSpan {
  readonly valueStart: number
  readonly valueEnd: number
}

/**
 * Locates the RAW byte span of the value at a path inside a JSON document
 * that `JSON.parse` already accepted. Path segments name object members or
 * array indices (as strings). Tool arguments, tool-result blocks and
 * schema fragments are embedded with their original spacing, so the
 * translation needs the original bytes, not a re-serialization.
 */
export function rawSpanAt(text: string, path: readonly string[]): RawSpan | undefined {
  return locatePath(text, path)
}

/** Raw text of the value at a path (see {@link rawSpanAt}). */
export function rawValueAt(text: string, path: readonly string[]): string | undefined {
  const span = locatePath(text, path)
  if (span === undefined) return undefined
  return text.slice(span.valueStart, span.valueEnd)
}

/** Path lookup that also exposes the enclosing object span (schema surgery). */
function locatePath(text: string, path: readonly string[]): ValueSpan | undefined {
  let cursor = skipWs(text, 0)
  let end = scanValue(text, cursor)
  for (const segment of path) {
    if (text[cursor] === '{') {
      const member = locateObjectMember(text, cursor, segment)
      if (member === undefined) return undefined
      cursor = member.valueStart
      end = member.valueEnd
      continue
    }
    if (text[cursor] === '[') {
      const element = locateArrayElement(text, cursor, segment)
      if (element === undefined) return undefined
      cursor = element.valueStart
      end = element.valueEnd
      continue
    }
    return undefined
  }
  return { valueStart: cursor, valueEnd: end }
}

function locateObjectMember(text: string, start: number, key: string): ValueSpan | undefined {
  let member = start + 1
  for (;;) {
    member = skipWs(text, member)
    if (text[member] !== '"') return undefined
    const nameEnd = scanString(text, member)
    const name = text.slice(member + 1, nameEnd - 1)
    const colon = skipWs(text, nameEnd)
    if (text[colon] !== ':') return undefined
    const valueStart = skipWs(text, colon + 1)
    const valueEnd = scanValue(text, valueStart)
    if (name === key) return { valueStart, valueEnd }
    const next = skipWs(text, valueEnd)
    if (text[next] === '}') return undefined
    if (text[next] !== ',') return undefined
    member = next + 1
  }
}

function locateArrayElement(text: string, start: number, index: string): ValueSpan | undefined {
  const wanted = Number(index)
  if (!Number.isInteger(wanted) || wanted < 0) return undefined
  let element = start + 1
  if (text[skipWs(text, element)] === ']') return undefined
  for (let at = 0; ; at++) {
    const valueStart = skipWs(text, element)
    const valueEnd = scanValue(text, valueStart)
    if (at === wanted) return { valueStart, valueEnd }
    const next = skipWs(text, valueEnd)
    if (text[next] === ']') return undefined
    if (text[next] !== ',') return undefined
    element = next + 1
  }
}

function skipWs(text: string, index: number): number {
  let i = index
  while (i < text.length) {
    const code = text.charCodeAt(i)
    if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) i++
    else break
  }
  return i
}

/** Returns the index one past the end of the JSON value starting at `index`. */
function scanValue(text: string, index: number): number {
  const start = skipWs(text, index)
  const code = text[start]
  if (code === '{' || code === '[') return scanContainer(text, start, code)
  if (code === '"') return scanString(text, start)
  let i = start
  while (i < text.length) {
    const current = text[i]
    if (
      current === ',' ||
      current === '}' ||
      current === ']' ||
      current === ' ' ||
      current === '\n' ||
      current === '\r' ||
      current === '\t'
    ) {
      break
    }
    i++
  }
  return i
}

function scanContainer(text: string, start: number, open: string): number {
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let i = start
  while (i < text.length) {
    const current = text[i]
    if (current === '"') {
      i = scanString(text, i)
      continue
    }
    if (current === '{' || current === '[') depth++
    else if (current === '}' || current === ']') {
      depth--
      if (depth === 0 && current === close) return i + 1
    }
    i++
  }
  return i
}

/** Returns the index one past the closing quote of the string at `index`. */
function scanString(text: string, index: number): number {
  let i = index + 1
  while (i < text.length) {
    const current = text[i]
    if (current === '\\') {
      i += 2
      continue
    }
    if (current === '"') return i + 1
    i++
  }
  return i
}

/** True when the text is a complete, valid JSON document. */
export function isValidJson(text: string): boolean {
  if (text.trim().length === 0) return false
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}
