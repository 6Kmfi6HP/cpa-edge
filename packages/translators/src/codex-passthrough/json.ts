
/**
 * Raw-JSON splicing for the Codex passthrough (S2d9).
 *
 * The recorded upstream bodies show the reference EDITING the client's
 * request bytes in place: values are swapped inside their original spans
 * (the whitespace a client put after a colon survives), members are cut
 * out with exactly one adjacent separator, new members append at the end
 * of their object with compact separators, and array elements splice the
 * same way. This module provides that machinery: a whitespace-tolerant
 * scanner that hands back exact byte spans, splice helpers built on it,
 * and the ordered + alphabetical serializers the wire shapes need.
 *
 * The request boundary is strict (NE-LENIENT): anything that is not valid
 * JSON is rejected instead of being read best-effort.
 */
import { CpaError } from '@cpa-edge/core'

/**
 * Unvalidated JSON text spliced verbatim into serialized output. Values the
 * passthrough copies byte-for-byte (raw member tokens, error objects that
 * must keep their numeric literals) embed through this wrapper.
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
 * Parses a client body under the strict request boundary (NE-LENIENT):
 * anything that is not valid JSON is rejected with `invalid-input`.
 */
export function parseStrictJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new CpaError('invalid-input', 'Invalid request: malformed JSON body')
  }
}

/** Lenient parse for upstream-produced text (never fails the request). */
export function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** True for a JSON object (never arrays, class instances or `null`). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** Detached shallow copy of a parsed value as a serializer input. */
export function wireValueOf(value: unknown): WireValue {
  if (value instanceof RawJson) return value
  if (value === null || typeof value !== 'object') return value as WireValue
  if (Array.isArray(value)) return value.map((element) => wireValueOf(element))
  const out: WireObject = {}
  for (const key of Object.keys(value)) {
    const member = (value as Record<string, unknown>)[key]
    if (member === undefined) continue
    out[key] = wireValueOf(member)
  }
  return out
}

// ---------------------------------------------------------------------------
// Ordered + alphabetical serialization
// ---------------------------------------------------------------------------

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
 * Serializes a value in key-insertion order with compact separators -
 * the shape every gateway-built object on this route uses. `RawJson`
 * members splice their text verbatim.
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

/** Recursively reorders an object's keys lexicographically. */
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

/** Parsed-value re-marshal with alphabetical keys at every level. */
export function marshalSorted(value: unknown): string {
  return serializeOrdered(sortKeysDeep(wireValueOf(value)))
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

/** Index one past the closing quote of the string starting at `index`. */
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

/** Index one past the end of the container starting at `start`. */
function scanContainer(text: string, start: number): number {
  const open = text[start]
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

/** Index one past the end of the JSON value starting at `index`. */
function scanValue(text: string, index: number): number {
  const start = skipWs(text, index)
  const code = text[start]
  if (code === '{' || code === '[') return scanContainer(text, start)
  if (code === '"') return scanString(text, start)
  let i = start
  while (i < text.length) {
    const current = text[i]
    if (current === ',' || current === '}' || current === ']' || current === ' ' || current === '\n' || current === '\r' || current === '\t') break
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

/** One member of a raw JSON object, with the spans a splice needs. */
export interface RawMember {
  /** Parsed member name. */
  readonly key: string
  /** Span from the opening quote of the key to the value end. */
  readonly span: RawSpan
  /** Span of the value alone (leading whitespace skipped). */
  readonly valueSpan: RawSpan
}

/** One element of a raw JSON array, with the spans a splice needs. */
export interface RawElement {
  /** Span of the element value alone (leading whitespace skipped). */
  readonly span: RawSpan
}

/**
 * Scans the members of the JSON object spanning `span` inside `text`.
 * Values stay raw; only the surface is walked. Returns `undefined` when
 * the span does not hold an object.
 */
export function scanObjectMembers(text: string, span: RawSpan): readonly RawMember[] | undefined {
  let cursor = skipWs(text, span.start)
  if (text[cursor] !== '{') return undefined
  const members: RawMember[] = []
  cursor = skipWs(text, cursor + 1)
  for (;;) {
    if (text[cursor] === '}') return members
    if (text[cursor] !== '"') return undefined
    const keyStart = cursor
    const keyEnd = scanString(text, cursor)
    const key = text.slice(cursor + 1, keyEnd - 1)
    const colon = skipWs(text, keyEnd)
    if (text[colon] !== ':') return undefined
    const valueStart = skipWs(text, colon + 1)
    const valueEnd = scanValue(text, valueStart)
    if (valueEnd <= valueStart) return undefined
    members.push({ key, span: { start: keyStart, end: valueEnd }, valueSpan: { start: valueStart, end: valueEnd } })
    cursor = skipWs(text, valueEnd)
    if (text[cursor] === '}') return members
    if (text[cursor] !== ',') return undefined
    cursor = skipWs(text, cursor + 1)
  }
}

/** Scans the elements of the JSON array spanning `span` inside `text`. */
export function scanArrayElements(text: string, span: RawSpan): readonly RawElement[] | undefined {
  let cursor = skipWs(text, span.start)
  if (text[cursor] !== '[') return undefined
  const elements: RawElement[] = []
  cursor = skipWs(text, cursor + 1)
  for (;;) {
    if (text[cursor] === ']') return elements
    const valueStart = cursor
    const valueEnd = scanValue(text, valueStart)
    if (valueEnd <= valueStart) return undefined
    elements.push({ span: { start: valueStart, end: valueEnd } })
    cursor = skipWs(text, valueEnd)
    if (text[cursor] === ']') return elements
    if (text[cursor] !== ',') return undefined
    cursor = skipWs(text, cursor + 1)
  }
}

/**
 * Locates the raw span of the value at a path inside a document that
 * already parsed. Path segments walk objects (member names) and arrays
 * (decimal indices).
 */
export function rawSpanAt(text: string, path: readonly string[]): RawSpan | undefined {
  let cursor = skipWs(text, 0)
  let end = scanValue(text, cursor)
  for (const segment of path) {
    const atObject = text[cursor] === '{'
    const atArray = text[cursor] === '['
    if (!atObject && !atArray) return undefined
    if (atObject) {
      const members = scanObjectMembers(text, { start: cursor, end })
      if (members === undefined) return undefined
      const member = members.find((entry) => entry.key === segment)
      if (member === undefined) return undefined
      cursor = member.valueSpan.start
      end = member.valueSpan.end
      continue
    }
    const elements = scanArrayElements(text, { start: cursor, end })
    if (elements === undefined) return undefined
    const index = Number(segment)
    if (!Number.isInteger(index) || index < 0 || index >= elements.length) return undefined
    const element = elements[index]
    if (element === undefined) return undefined
    cursor = element.span.start
    end = element.span.end
  }
  return { start: cursor, end }
}

/** Raw text of the value at a path, or `undefined` when absent. */
export function rawValueAt(text: string, path: readonly string[]): string | undefined {
  const span = rawSpanAt(text, path)
  return span === undefined ? undefined : text.slice(span.start, span.end)
}

// ---------------------------------------------------------------------------
// Splice helpers
// ---------------------------------------------------------------------------

/**
 * Replaces the value of one member with new serialized bytes. Every other
 * byte of the object - including the whitespace between key and value -
 * is preserved.
 */
export function replaceMemberValue(text: string, member: RawMember, valueJson: string): string {
  return text.slice(0, member.valueSpan.start) + valueJson + text.slice(member.valueSpan.end)
}

/**
 * Deletes one member together with a single adjacent separator: the
 * separator AFTER the member when one follows, otherwise the separator
 * BEFORE it. Remaining bytes stay untouched.
 */
export function deleteMember(text: string, member: RawMember): string {
  const after = skipWs(text, member.span.end)
  if (text[after] === ',') {
    const separatorEnd = after + 1
    // Also take trailing whitespace so `"a": 1, "b"` does not leave a
    // double space behind; recorded deletions consume it.
    let wsEnd = separatorEnd
    while (wsEnd < text.length && /\s/.test(text[wsEnd] ?? '')) wsEnd++
    return text.slice(0, member.span.start) + text.slice(wsEnd)
  }
  let separatorStart = member.span.start - 1
  while (separatorStart > 0 && /\s/.test(text[separatorStart] ?? '')) separatorStart--
  if (text[separatorStart] === ',') {
    return text.slice(0, separatorStart) + text.slice(member.span.end)
  }
  // Sole member: cut the member and nothing else.
  return text.slice(0, member.span.start) + text.slice(member.span.end)
}

/** Deletes one array element with a single adjacent separator. */
export function deleteElement(text: string, element: RawElement): string {
  const after = skipWs(text, element.span.end)
  if (text[after] === ',') {
    let wsEnd = after + 1
    while (wsEnd < text.length && /\s/.test(text[wsEnd] ?? '')) wsEnd++
    return text.slice(0, element.span.start) + text.slice(wsEnd)
  }
  let separatorStart = element.span.start - 1
  while (separatorStart > 0 && /\s/.test(text[separatorStart] ?? '')) separatorStart--
  if (text[separatorStart] === ',') {
    return text.slice(0, separatorStart) + text.slice(element.span.end)
  }
  return text.slice(0, element.span.start) + text.slice(element.span.end)
}

/** Replaces one array element's bytes in place. */
export function replaceElement(text: string, element: RawElement, valueJson: string): string {
  return text.slice(0, element.span.start) + valueJson + text.slice(element.span.end)
}

/**
 * Appends one serialized member (`"key":value`) at the end of the JSON
 * object spanning `objectSpan` inside `text`, preserving every other byte.
 * An empty object gains its first member without a leading comma.
 */
export function appendMember(text: string, objectSpan: RawSpan, memberJson: string): string {
  const members = scanObjectMembers(text, objectSpan)
  const close = objectSpan.end - 1
  if (text[close] !== '}') return text
  const separator = members !== undefined && members.length > 0 ? ',' : ''
  return text.slice(0, close) + separator + memberJson + text.slice(close)
}

/**
 * Appends one serialized element at the end of the JSON array spanning
 * `arraySpan` inside `text` with a compact separator (recorded S2d9-04:
 * the client's own `, ` between declared tools survives, the appended
 * tool lands on a plain `,`). An empty array gains its first element
 * without a separator.
 */
export function appendElement(text: string, arraySpan: RawSpan, elementJson: string): string {
  const elements = scanArrayElements(text, arraySpan)
  const close = arraySpan.end - 1
  if (text[close] !== ']') return text
  const separator = elements !== undefined && elements.length > 0 ? ',' : ''
  return text.slice(0, close) + separator + elementJson + text.slice(close)
}

/**
 * Re-marshals one raw JSON object with alphabetically sorted keys while
 * splicing every VALUE token verbatim - numbers keep their literal text
 * (`3600` never becomes `3600.0`, `1.50` never becomes `1.5`), strings and
 * nested containers keep their bytes. This is the deterministic
 * re-serialization the gateway applies to upstream error bodies.
 */
export function remarshalSortedRaw(objectText: string): string | undefined {
  return remarshalRawSorted(objectText)
}

/** Shared raw-token remarshal; `objectText` spans one JSON object. */
function remarshalRawSorted(objectText: string): string | undefined {
  const span: RawSpan = { start: 0, end: objectText.length }
  const members = scanObjectMembers(objectText, span)
  if (members === undefined) return undefined
  const sorted = [...members].sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
  let out = '{'
  for (let i = 0; i < sorted.length; i++) {
    const member = sorted[i]
    if (member === undefined) continue
    if (i > 0) out += ','
    const valueText = objectText.slice(member.valueSpan.start, member.valueSpan.end)
    let spliced = valueText
    if (valueText.startsWith('{')) spliced = remarshalRawSorted(valueText) ?? valueText
    else if (valueText.startsWith('[')) spliced = remarshalArrayRawSorted(valueText)
    out += serializeString(member.key) + ':' + spliced
  }
  return out + '}'
}

/** Sorts every object inside a raw array, element order preserved. */
function remarshalArrayRawSorted(arrayText: string): string {
  const span: RawSpan = { start: 0, end: arrayText.length }
  const elements = scanArrayElements(arrayText, span) ?? []
  const parts: string[] = []
  for (const element of elements) {
    const valueText = arrayText.slice(element.span.start, element.span.end)
    if (valueText.startsWith('{')) parts.push(remarshalRawSorted(valueText) ?? valueText)
    else if (valueText.startsWith('[')) parts.push(remarshalArrayRawSorted(valueText))
    else parts.push(valueText)
  }
  return `[${parts.join(',')}]`
}
