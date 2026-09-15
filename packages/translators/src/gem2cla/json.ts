/**
 * JSON helpers for byte-exact wire output in the gem2cla direction.
 *
 * Three recorded behaviors drive this module:
 *
 * - tool-call arguments travel as RAW client bytes (spacing included), both
 *   in requests (`functionCall.args`) and in responses (accumulated
 *   `input_json_delta` fragments), so the serializer must be able to splice
 *   unvalidated JSON text into otherwise ordered output;
 * - tool schemas are re-serialized with lexicographic key order;
 * - the client request boundary is strict (NE-LENIENT): malformed bodies are
 *   rejected instead of being read best-effort.
 */
import { CpaError } from '@cpa-edge/core'

/**
 * Unvalidated JSON text spliced verbatim into serialized output. The
 * recorded wire never re-parses tool arguments, so invalid fragments must
 * flow through byte-for-byte (the corrupted-chunk cascade depends on it).
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

/** Serializes one string with JSON escaping; `<`, `>`, `&` stay literal. */
function serializeString(text: string): string {
  let out = '"'
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    switch (code) {
      case 0x22:
        out += '\\"'
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
 * Serializes a value in key-insertion order. `RawJson` members are spliced
 * verbatim. Rejects values that cannot appear on a JSON wire.
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

/**
 * Recursively re-serializes a value with keys in lexicographic order - the
 * tool `input_schema` and tool-object normalization (recorded wire order).
 * `RawJson` leaves pass through untouched.
 */
export function sortKeysDeep(value: WireValue): WireValue {
  if (value instanceof RawJson) return value
  if (Array.isArray(value)) return value.map((element) => sortKeysDeep(element))
  if (!isPlainObject(value)) return value
  const sorted: WireObject = {}
  for (const key of Object.keys(value).sort()) {
    const member = (value as Record<string, unknown>)[key]
    if (member === undefined) continue
    sorted[key] = sortKeysDeep(member as WireValue)
  }
  return sorted
}

/**
 * Locates the RAW text of the value at a path inside a JSON document that
 * `JSON.parse` already accepted. Path segments name object members or array
 * indices (as strings). Tool arguments and user-id seed fields are embedded
 * with their original spacing, so the translation needs the original bytes,
 * not a re-serialization.
 */
export function rawValueAt(text: string, path: readonly string[]): string | undefined {
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
  return text.slice(cursor, end)
}

interface ValueSpan {
  readonly valueStart: number
  readonly valueEnd: number
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

/**
 * Reads one root-level field of a parsed body as its RAW JSON text: string
 * values are unquoted, everything else keeps its original bytes. User-id
 * seed fields embed the client's raw value this way.
 */
export function rawFieldText(text: string, key: string): string | undefined {
  const raw = rawValueAt(text, [key])
  if (raw === undefined) return undefined
  if (raw.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(raw)
      return typeof parsed === 'string' ? parsed : raw
    } catch {
      return raw
    }
  }
  return raw
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

/** Detached plain-object copy of a parsed value (non-objects become {}). */
export function wireObject(value: unknown): WireObject {
  const out: WireObject = {}
  if (!isPlainObject(value)) return out
  for (const key of Object.keys(value)) {
    const member = (value as Record<string, unknown>)[key]
    if (member === undefined) continue
    out[key] = member as WireValue
  }
  return out
}
