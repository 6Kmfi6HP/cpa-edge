/**
 * JSON helpers for byte-exact wire output.
 *
 * `JSON.stringify` keeps object insertion order but cannot reproduce two
 * details the recorded upstream wire pins: string escaping without HTML
 * entity escaping (the reference emits `<system-reminder>` literally) and
 * lexicographic key re-serialization for tool schemas. This module provides
 * a small serializer for both, plus a span scanner that recovers the RAW
 * bytes of a nested value - the structured-output instruction embeds the
 * client's schema JSON verbatim, spacing included.
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

function isPlainObject(value: unknown): value is WireObject {
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
 * tool `input_schema` normalization (S2d3 section 2.4).
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

/**
 * Locates the RAW text of the value at a dotted path inside a JSON document
 * that `JSON.parse` already accepted. The structured-output instruction
 * embeds the client's `response_format.json_schema.schema` bytes verbatim,
 * so the translation needs the original spacing, not a re-serialization.
 */
export function rawValueAt(text: string, path: readonly string[]): string | undefined {
  let cursor = skipWs(text, 0)
  let end = scanValue(text, cursor)
  for (let depth = 0; depth < path.length; depth++) {
    if (text[cursor] !== '{') return undefined
    const key = path[depth]
    let member = cursor + 1
    for (;;) {
      member = skipWs(text, member)
      if (text[member] !== '"') return undefined
      const nameEnd = scanString(text, member)
      const name = text.slice(member + 1, nameEnd - 1)
      const colon = skipWs(text, nameEnd)
      if (text[colon] !== ':') return undefined
      const valueStart = skipWs(text, colon + 1)
      const valueEnd = scanValue(text, valueStart)
      if (name === key) {
        cursor = valueStart
        end = valueEnd
        break
      }
      member = skipWs(text, valueEnd)
      if (text[member] === '}') return undefined
      if (text[member] !== ',') return undefined
      member++
    }
  }
  return text.slice(cursor, end)
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
