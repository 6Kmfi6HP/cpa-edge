/**
 * JSON helpers for byte-exact wire output in the res2oai direction
 * (S2d6: OpenAI Responses client -> OpenAI chat-completions upstream).
 *
 * Four recorded behaviors drive this module:
 *
 * - translated request and response bodies are built from fixed templates
 *   where new fields append at the end, so the serializer must preserve
 *   key insertion order (and refuse anything that is not JSON data);
 * - several fields travel as RAW client bytes: tool-call arguments, tool
 *   schemas and the compact-passthrough body keep their original spacing,
 *   so unvalidated JSON text must splice through verbatim;
 * - echoed field values re-marshal with alphabetically sorted keys (Go map
 *   marshaling on the reference), both for request tools and for terminal
 *   stream echoes;
 * - the client request boundary is strict (NE-LENIENT): malformed bodies
 *   are rejected instead of being read best-effort.
 */
import { CpaError } from '@cpa-edge/core'

/**
 * Unvalidated JSON text spliced verbatim into serialized output. Tool
 * arguments and compact-passthrough members keep their original bytes, so
 * invalid fragments must flow through untouched.
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

/** Lenient parse for upstream-produced text (the reference reads upstreams best-effort). */
export function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
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
 * Serializes a value in key-insertion order. `RawJson` members splice
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
 * recorded echo order for marshaled maps (request tool entries, response
 * tool echoes, terminal-event request echoes). `RawJson` leaves pass
 * through untouched.
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
 * Re-marshals a parsed value compact with sorted keys at every level - the
 * recorded sanitizer / echo behavior for error objects and request-field
 * echoes on the stream path.
 */
export function marshalSorted(value: unknown): string {
  return serializeOrdered(sortKeysDeep(wireValueOf(value)))
}

/** Narrows a parsed value to a serializer input without copying. */
export function wireValueOf(value: unknown): WireValue {
  if (isPlainObject(value)) return value as unknown as WireObject
  if (Array.isArray(value)) return value as unknown as readonly WireValue[]
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value
  }
  throw new CpaError('invalid-input', 'cannot marshal non-JSON value')
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

// ---------------------------------------------------------------------------
// Raw-text scanning (compact passthrough + usage-detail splicing)
// ---------------------------------------------------------------------------

interface ValueSpan {
  readonly valueStart: number
  readonly valueEnd: number
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
 * Locates the RAW text of the value at a path inside a JSON document that
 * `JSON.parse` already accepted. Path segments name object members or
 * array indices (as strings). Tool arguments and echoed fields embed the
 * original bytes, not a re-serialization.
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

/** One member of a scanned JSON object, with its raw spans. */
export interface RawMember {
  /** Member name as parsed from the key. */
  readonly name: string
  /** First byte of the key (opening quote). */
  readonly keyStart: number
  /** First byte of the value. */
  readonly valueStart: number
  /** One past the last byte of the value. */
  readonly valueEnd: number
}

/**
 * Scans the members of the JSON object at the start of `text` (after
 * optional whitespace). Returns undefined when the text does not open an
 * object. Only the surface is scanned; values stay raw.
 */
export function scanObjectMembers(text: string): readonly RawMember[] | undefined {
  const open = skipWs(text, 0)
  if (text[open] !== '{') return undefined
  const members: RawMember[] = []
  let cursor = open + 1
  for (;;) {
    cursor = skipWs(text, cursor)
    if (text[cursor] === '}') return members
    if (text[cursor] !== '"') return undefined
    const nameEnd = scanString(text, cursor)
    const name = text.slice(cursor + 1, nameEnd - 1)
    const colon = skipWs(text, nameEnd)
    if (text[colon] !== ':') return undefined
    const valueStart = skipWs(text, colon + 1)
    const valueEnd = scanValue(text, valueStart)
    members.push({ name, keyStart: cursor, valueStart, valueEnd })
    const next = skipWs(text, valueEnd)
    if (text[next] === '}') return members
    if (text[next] !== ',') return undefined
    cursor = next + 1
  }
}

/**
 * Appends one serialized member (`"key":value`) to the end of the JSON
 * object carried by `objectText`, preserving the object's other bytes.
 * An empty object gains its first member without a leading comma.
 */
export function appendObjectMember(objectText: string, memberJson: string): string {
  const close = scanContainer(objectText, skipWs(objectText, 0), '{') - 1
  if (objectText[close] !== '}') return objectText
  const inner = objectText.slice(skipWs(objectText, 0) + 1, close).trim()
  const prefix = inner.length === 0 ? '' : ','
  return objectText.slice(0, close) + prefix + memberJson + objectText.slice(close)
}

/**
 * Raw text form of a member value: strings are unquoted, every other value
 * keeps its raw bytes. Non-string text fields (instructions, effort
 * sources) embed the client's raw value this way.
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
