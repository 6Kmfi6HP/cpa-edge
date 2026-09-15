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
 * Anything that is not valid JSON is rejected with `invalid-input`;
 * valid JSON that nests deeper than {@link MAX_JSON_DEPTH} containers is
 * rejected the same way (mirroring Go's `encoding/json` decoder).
 */
export function parseStrictJson(text: string): unknown {
  assertWithinJsonDepth(text)
  try {
    return JSON.parse(text)
  } catch {
    throw new CpaError('invalid-input', 'Invalid request: malformed JSON body')
  }
}

/** Maximum container nesting this direction accepts (Go's encoding/json cap). */
export const MAX_JSON_DEPTH = 10_000

/** Shared message of the depth cap (parse-time rejections and the backstop). */
const DEPTH_MESSAGE = `JSON nesting exceeds the maximum depth of ${MAX_JSON_DEPTH} levels`

/**
 * Parse-time depth cap: counts container nesting of RAW text with an
 * iterative scan (strings are skipped verbatim), so the check itself never
 * recurses and cannot exhaust the stack it guards. Over-deep documents are
 * rejected with `invalid-input` before any recursive walk or
 * re-serialization of the parsed value can run.
 */
export function assertWithinJsonDepth(text: string): void {
  let depth = 0
  let index = 0
  while (index < text.length) {
    const current = text[index]
    if (current === '"') {
      index = scanString(text, index)
      continue
    }
    if (current === '{' || current === '[') {
      depth += 1
      if (depth > MAX_JSON_DEPTH) throw new CpaError('invalid-input', DEPTH_MESSAGE)
    } else if (current === '}' || current === ']') {
      depth -= 1
    }
    index += 1
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

/**
 * Compact serialization for the re-serialized positions - values that
 * arrived as parsed JSON and are re-written by the gateway (the request
 * estimator's tool input/input_schema, the downstream tool_use input).
 * The parse-time cap rejects documents deeper than {@link MAX_JSON_DEPTH};
 * this backstop additionally converts the stack-exhaustion `RangeError`
 * that a runtime with a smaller recursion budget would raise into the same
 * `invalid-input` error, so no `RangeError` escapes the translation.
 */
export function serializeOrderedCapped(value: unknown): string {
  try {
    return serializeOrdered(value as WireValue)
  } catch (error) {
    if (error instanceof RangeError) throw new CpaError('invalid-input', DEPTH_MESSAGE)
    throw error
  }
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

/** One member of a scanned raw JSON object. */
export interface RawMember {
  /** Member key (already unescaped). */
  readonly key: string
  /** Byte offset of the key's opening quote. */
  readonly keyStart: number
  /** Byte offset where the member value starts. */
  readonly valueStart: number
  /** Byte offset one past the member value. */
  readonly valueEnd: number
  /**
   * Byte offset where the member's separator (comma plus whitespace)
   * starts; equals `objectStart + 1` when the member is first and has no
   * separator.
   */
  readonly sepStart: number
  /** True when a comma precedes this member. */
  readonly hasSep: boolean
}

/** Member list of a scanned raw JSON object (offsets into the same text). */
export interface RawObjectScan {
  /** Offset of the opening brace. */
  readonly start: number
  /** Offset one past the closing brace. */
  readonly end: number
  readonly members: readonly RawMember[]
}

/**
 * Scans one raw JSON object (the `{` sits at `objectStart`) into its
 * member spans, preserving every original byte. Object member surgery
 * (tool declarations) needs the exact member/separator spans.
 */
export function scanRawObject(text: string, objectStart: number): RawObjectScan | undefined {
  if (text[objectStart] !== '{') return undefined
  const members: RawMember[] = []
  let cursor = skipWs(text, objectStart + 1)
  if (text[cursor] === '}') return { start: objectStart, end: cursor + 1, members }
  let hasSep = false
  let sepStart = objectStart + 1
  for (;;) {
    const keyStart = cursor
    if (text[keyStart] !== '"') return undefined
    const keyEnd = scanString(text, keyStart)
    const key = text.slice(keyStart + 1, keyEnd - 1)
    const colon = skipWs(text, keyEnd)
    if (text[colon] !== ':') return undefined
    const valueStart = skipWs(text, colon + 1)
    const valueEnd = scanValue(text, valueStart)
    members.push({ key, keyStart, valueStart, valueEnd, sepStart, hasSep })
    const next = skipWs(text, valueEnd)
    if (text[next] === '}') return { start: objectStart, end: next + 1, members }
    if (text[next] !== ',') return undefined
    sepStart = next
    hasSep = true
    cursor = skipWs(text, next + 1)
  }
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
