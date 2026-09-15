/**
 * JSON helpers for the byte-preserving oai2oai direction.
 *
 * The direction never re-marshals the payloads it carries: client bodies
 * and upstream replies cross the gateway with their original spacing,
 * key order and duplicates intact. Everything here therefore works on
 * RAW TEXT SPANS: a strict parse guards the request boundary (NE-LENIENT),
 * a span scanner locates the members that get rewritten, and splices
 * replace only the bytes that must change. A lenient leading-value scan
 * backs the stream path, where the recorded mock appended trailing
 * garbage after otherwise valid chunk objects (the family pin).
 */
import { CpaError } from '@cpa-edge/core'

/**
 * Parses a client body under the strict request boundary (NE-LENIENT).
 * Anything that is not valid JSON is rejected instead of being read
 * best-effort.
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

/** Serializes a string the way the wire rewrites embed it. */
export function serializeJsonString(text: string): string {
  return serializeString(text)
}

/** Serializes a value in key-insertion order. Rejects non-JSON values. */
export function serializeOrdered(value: unknown): string {
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
      out += serializeOrdered(value[i])
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
    out += serializeString(key) + ':' + serializeOrdered(member)
  }
  return out + '}'
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

// ---------------------------------------------------------------------------
// Raw span scanning (valid-JSON inputs only)
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

/** Returns the index one past the end of the container opening at `start`. */
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

/** Raw span of one object member: the value plus its key location. */
export interface MemberSpan {
  /** First byte of the key (the opening quote). */
  readonly keyStart: number
  /** First byte of the value. */
  readonly valueStart: number
  /** One past the last byte of the value. */
  readonly valueEnd: number
  /** First byte one past the value's closing token (the member's tail). */
  readonly afterValue: number
}

/**
 * Walks the members of the object that starts at `objectStart` and
 * returns the span of the LAST member named `key` - the occurrence a
 * `JSON.parse` of the same text would keep. Undefined when the object
 * carries no such member. Scanning stops at the object's closing brace,
 * so nested objects are skipped over, never descended into.
 */
export function lastMemberSpan(text: string, objectStart: number, key: string): MemberSpan | undefined {
  if (text[objectStart] !== '{') return undefined
  let cursor = skipWs(text, objectStart + 1)
  let match: MemberSpan | undefined
  for (;;) {
    if (text[cursor] === '}') return match
    if (text[cursor] !== '"') return undefined
    const keyEnd = scanString(text, cursor)
    const name = text.slice(cursor + 1, keyEnd - 1)
    const colon = skipWs(text, keyEnd)
    if (text[colon] !== ':') return undefined
    const valueStart = skipWs(text, colon + 1)
    const valueEnd = scanValue(text, valueStart)
    if (name === key) {
      match = { keyStart: cursor, valueStart, valueEnd, afterValue: skipWs(text, valueEnd) }
    }
    const next = skipWs(text, valueEnd)
    if (text[next] === '}') return match
    if (text[next] !== ',') return undefined
    cursor = skipWs(text, next + 1)
  }
}

/** Index of the closing brace of the object that starts at `objectStart`. */
function objectCloseIndex(text: string, objectStart: number): number {
  return scanContainer(text, objectStart, '{') - 1
}

/** True when the object at `objectStart` has no members. */
function objectIsEmpty(text: string, objectStart: number): boolean {
  return text[skipWs(text, objectStart + 1)] === '}'
}

/** First byte of the top-level JSON value of the text (whitespace skipped). */
export function topLevelStart(text: string): number {
  return skipWs(text, 0)
}

/**
 * Splices a replacement for the value span of one member, leaving every
 * other byte of the text untouched.
 */
export function replaceValueSpan(text: string, span: MemberSpan, replacement: string): string {
  return text.slice(0, span.valueStart) + replacement + text.slice(span.valueEnd)
}

/**
 * Appends one serialized member (`"key":value`) as the LAST member of the
 * object at `objectStart`, preserving the object's other bytes and its
 * spacing style: no space is introduced around the added comma.
 */
export function appendMember(text: string, objectStart: number, memberJson: string): string {
  const close = objectCloseIndex(text, objectStart)
  if (text[close] !== '}') return text
  const prefix = objectIsEmpty(text, objectStart) ? '' : ','
  return text.slice(0, close) + prefix + memberJson + text.slice(close)
}

// ---------------------------------------------------------------------------
// Lenient leading-value scan (the stream family pin)
// ---------------------------------------------------------------------------

/** Result of the lenient leading-value scan. */
export interface LeadingValue {
  /** Parsed leading JSON value. */
  readonly value: unknown
  /** First byte of the value inside `text`. */
  readonly start: number
  /** One past the last byte of the value inside `text`. */
  readonly end: number
}

/**
 * Parses the LEADING JSON value of a text leniently: bytes after the value
 * ends are ignored. The upstream chunk reader tolerates a data payload
 * with trailing garbage after the JSON value (the recorded mock appends a
 * stray closing brace to every SSE chunk); a text that does not start with
 * a complete JSON value returns `undefined` and takes the terminal-error
 * path.
 */
export function scanLeadingJsonValue(text: string): LeadingValue | undefined {
  const start = skipWs(text, 0)
  const end = scanValue(text, start)
  if (end <= start) return undefined
  const slice = text.slice(start, end)
  try {
    return { value: JSON.parse(slice), start, end }
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Object helpers used by the request translation
// ---------------------------------------------------------------------------

/**
 * Replaces the value of the LAST top-level member named `key` with the
 * serialized form of `nextValue`, but only when the member's current
 * value differs (the set-if-different splice). Non-string current values
 * and absent members leave the text untouched.
 */
export function setTopLevelStringIfDifferent(
  text: string,
  key: string,
  nextValue: string,
): string {
  const start = topLevelStart(text)
  const span = lastMemberSpan(text, start, key)
  if (span === undefined) return text
  const current = JSON.parse(text.slice(span.valueStart, span.valueEnd)) as unknown
  if (typeof current !== 'string' || current === nextValue) return text
  return replaceValueSpan(text, span, serializeString(nextValue))
}

/**
 * Ensures the nested flag `<key>.<flag>` is JSON `true` inside the
 * top-level object, with set-if-different semantics on raw bytes:
 * an already-true flag leaves the text untouched; a false one has its
 * value replaced in place; a missing one is appended to the innermost
 * object that exists; when the outer member is absent entirely it is
 * appended at the top level. A non-object outer member is replaced
 * wholesale (a flag path needs an object to live in).
 */
export function ensureTopLevelFlag(
  text: string,
  key: string,
  flag: string,
): string {
  const start = topLevelStart(text)
  const span = lastMemberSpan(text, start, key)
  if (span === undefined) {
    return appendMember(text, start, `${serializeString(key)}:{"${flag}":true}`)
  }
  const rawValue = text.slice(span.valueStart, span.valueEnd)
  const valueStart = topLevelStart(rawValue)
  if (rawValue[valueStart] !== '{') {
    return replaceValueSpan(text, span, `{"${flag}":true}`)
  }
  const flagSpan = lastMemberSpan(rawValue, valueStart, flag)
  if (flagSpan === undefined) {
    const updated = appendMember(rawValue, valueStart, `"${flag}":true`)
    return replaceValueSpan(text, span, updated)
  }
  const current = JSON.parse(rawValue.slice(flagSpan.valueStart, flagSpan.valueEnd)) as unknown
  if (current === true) return text
  const updated = replaceValueSpan(rawValue, flagSpan, 'true')
  return replaceValueSpan(text, span, updated)
}
