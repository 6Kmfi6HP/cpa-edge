/**
 * JSON helpers for byte-exact wire output.
 *
 * The recorded Codex wire pins three serialization behaviors `JSON.stringify`
 * cannot express on its own: insertion-order objects, RAW byte spans for
 * values the translation copies verbatim (tool `parameters`,
 * `text.format.schema`), and splice edits that change one object member while
 * leaving every other byte untouched (the union-to-enum rewrite). This module
 * provides the scanner/serializer pair for all three, plus the strict
 * request-boundary parse (NE-LENIENT).
 */
import { CpaError } from '@cpa-edge/core'
import type { WireObject, WireValue } from './types'

/**
 * Parses a client body under the strict request boundary (NE-LENIENT):
 * anything that is not valid JSON is rejected instead of being read
 * best-effort.
 */
export function parseStrictJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new CpaError('invalid-input', 'Invalid request: malformed JSON body')
  }
}

/** Reads a string field of a record-like value. */
export function readString(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = (value as Record<string, unknown>)[key]
  return typeof raw === 'string' ? raw : undefined
}

/** Reads an array field of a record-like value. */
export function readArray(value: unknown, key: string): readonly unknown[] | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = (value as Record<string, unknown>)[key]
  return Array.isArray(raw) ? raw : undefined
}

/** Reads an object field of a record-like value. */
export function readObject(value: unknown, key: string): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = (value as Record<string, unknown>)[key]
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  return raw as Record<string, unknown>
}

/** Reads a boolean field of a record-like value. */
export function readBoolean(value: unknown, key: string): boolean | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = (value as Record<string, unknown>)[key]
  return typeof raw === 'boolean' ? raw : undefined
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
        out += '\\u' + HEX[(code >>> 12) & 0xf] + HEX[(code >>> 8) & 0xf] + HEX[(code >>> 4) & 0xf] + HEX[code & 0xf]
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

export function isPlainObject(value: unknown): value is WireObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** Serializes a value in key-insertion order. Rejects non-JSON values. */
export function serializeOrdered(value: WireValue): string {
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
 * alphabetical remarshal the pattern-strip half of the schema normalization
 * performs (S2d5 2.11).
 */
export function sortKeysDeep<T extends WireValue>(value: T): WireValue {
  if (Array.isArray(value)) return value.map((element) => sortKeysDeep(element))
  if (isPlainObject(value)) {
    const sorted: WireObject = {}
    for (const key of Object.keys(value).sort()) {
      const member = (value as Record<string, unknown>)[key]
      if (member === undefined) continue
      sorted[key] = sortKeysDeep(member as WireValue)
    }
    return sorted
  }
  return value
}

/** Detached shallow copy of a parsed JSON object as a wire object. */
export function wireObject(value: unknown): WireObject {
  const out: WireObject = {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return out
  for (const key of Object.keys(value)) {
    const member = (value as Record<string, unknown>)[key]
    if (member === undefined) continue
    out[key] = member as WireValue
  }
  return out
}

// ---------------------------------------------------------------------------
// Raw-span scanner
// ---------------------------------------------------------------------------

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
    if (current === ',' || current === '}' || current === ']' || current === ' ' || current === '\n' || current === '\r' || current === '\t') break
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

/** Half-open span of a JSON value inside its enclosing text. */
export interface RawSpan {
  readonly start: number
  /** One past the last byte of the value. */
  readonly end: number
}

/**
 * Locates the RAW text of the value at a dotted path inside a JSON document
 * that already parsed successfully. Path segments walk objects (member names)
 * and arrays (decimal indices). Returns the span so callers can splice it.
 */
export function rawSpanAt(text: string, path: readonly string[]): RawSpan | undefined {
  let cursor = skipWs(text, 0)
  let end = scanValue(text, cursor)
  for (const segment of path) {
    const atObject = text[cursor] === '{'
    const atArray = text[cursor] === '['
    if (!atObject && !atArray) return undefined
    let member: number
    if (atObject) {
      member = cursor + 1
      for (;;) {
        member = skipWs(text, member)
        if (text[member] !== '"') return undefined
        const nameEnd = scanString(text, member)
        const name = text.slice(member + 1, nameEnd - 1)
        const colon = skipWs(text, nameEnd)
        if (text[colon] !== ':') return undefined
        const valueStart = skipWs(text, colon + 1)
        const valueEnd = scanValue(text, valueStart)
        if (name === segment) {
          cursor = valueStart
          end = valueEnd
          break
        }
        member = skipWs(text, valueEnd)
        if (text[member] === '}') return undefined
        if (text[member] !== ',') return undefined
        member++
      }
    } else {
      member = skipWs(text, cursor + 1)
      let index = 0
      for (;;) {
        if (text[member] === ']') return undefined
        if (String(index) !== segment) {
          const valueEnd = scanValue(text, member)
          member = skipWs(text, valueEnd)
          if (text[member] === ']') return undefined
          if (text[member] !== ',') return undefined
          member = skipWs(text, member + 1)
          index++
          continue
        }
        const valueStart = member
        const valueEnd = scanValue(text, valueStart)
        cursor = valueStart
        end = valueEnd
        break
      }
    }
  }
  return { start: cursor, end }
}

/** RAW text of the value at a dotted path, or `undefined` when absent. */
export function rawValueAt(text: string, path: readonly string[]): string | undefined {
  const span = rawSpanAt(text, path)
  return span === undefined ? undefined : text.slice(span.start, span.end)
}

/** One member of a raw JSON object. */
export interface RawMember {
  /** Parsed member name. */
  readonly key: string
  /** Span of the whole member: opening quote of the key to value end. */
  readonly span: RawSpan
}

/**
 * Lists the members of the JSON object occupying `span` inside `text`.
 * Returns `undefined` when the span does not hold a well-formed object.
 */
export function scanObjectMembers(text: string, span: RawSpan): readonly RawMember[] | undefined {
  let cursor = skipWs(text, span.start)
  if (text[cursor] !== '{') return undefined
  const members: RawMember[] = []
  cursor = skipWs(text, cursor + 1)
  if (text[cursor] === '}') return members
  for (;;) {
    cursor = skipWs(text, cursor)
    if (text[cursor] !== '"') return undefined
    const keyStart = cursor
    const keyEnd = scanString(text, keyStart)
    const key = text.slice(keyStart + 1, keyEnd - 1)
    const colon = skipWs(text, keyEnd)
    if (text[colon] !== ':') return undefined
    const valueStart = skipWs(text, colon + 1)
    const valueEnd = scanValue(text, valueStart)
    if (valueEnd <= valueStart) return undefined
    members.push({ key, span: { start: keyStart, end: valueEnd } })
    cursor = skipWs(text, valueEnd)
    if (text[cursor] === ',') {
      cursor++
      continue
    }
    if (text[cursor] === '}') return members
    return undefined
  }
}

function isSeparator(char: string | undefined): boolean {
  return char === ' ' || char === '\n' || char === '\r' || char === '\t'
}

/**
 * Removes one member (key plus one adjacent separator) from a raw JSON
 * object, leaving every other byte untouched. A member with a successor
 * takes its trailing separator run and comma with it; a trailing member
 * takes the separator run and comma in front of it instead.
 */
export function deleteRawMember(text: string, objectSpan: RawSpan, member: RawMember): string {
  let after = member.span.end
  while (after < text.length && isSeparator(text[after])) after++
  if (text[after] === ',') {
    return text.slice(0, member.span.start) + text.slice(after + 1)
  }
  let cut = member.span.start
  while (cut > objectSpan.start && isSeparator(text[cut - 1])) cut--
  if (text[cut - 1] === ',') cut--
  return text.slice(0, cut) + text.slice(member.span.end)
}

/**
 * Lists the element spans of the JSON array whose opening bracket sits at
 * `arrayStart`; elements must end before `limit`.
 */
export function scanArrayElements(text: string, arrayStart: number, limit: number): readonly RawSpan[] {
  const spans: RawSpan[] = []
  let cursor = arrayStart + 1
  for (;;) {
    while (cursor < limit && isSeparator(text[cursor])) cursor++
    if (cursor >= limit || text[cursor] === ']') return spans
    const start = cursor
    let depth = 0
    while (cursor < limit) {
      const current = text[cursor]
      if (current === '"') {
        cursor = endOfString(text, cursor)
        continue
      }
      if (current === '{' || current === '[') {
        depth++
        cursor++
        continue
      }
      if (current === '}' || current === ']') {
        depth--
        cursor++
        if (depth === 0) break
        continue
      }
      if (current === ',' && depth === 0) break
      cursor++
    }
    spans.push({ start, end: cursor })
    while (cursor < limit && isSeparator(text[cursor])) cursor++
    if (text[cursor] === ',') {
      cursor++
      continue
    }
    return spans
  }
}

/** Index one past the closing quote of the string starting at `start`. */
function endOfString(text: string, start: number): number {
  let i = start + 1
  while (i < text.length) {
    if (text[i] === '\\') {
      i += 2
      continue
    }
    if (text[i] === '"') return i + 1
    i++
  }
  return i
}

/** Index of the first byte of a member's value (past the `name:` separator). */
export function memberValueStart(text: string, member: RawMember): number {
  const colon = text.indexOf(':', member.span.start)
  let i = colon + 1
  while (i < member.span.end && isSeparator(text[i])) i++
  return i
}
