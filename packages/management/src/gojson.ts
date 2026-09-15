/**
 * Go-compatible JSON marshaling primitives.
 *
 * The management wire contract pins two marshal regimes inherited from the
 * reference implementation: map-shaped bodies (Go `gin.H` / `map[string]T`)
 * serialize their keys in ascending byte order, and struct-shaped bodies
 * keep declaration order. `encoding/json` also HTML-escapes `<`, `>` and `&`
 * by default, which is visible in nested upstream bodies - all reproduced
 * here so the recorded golden bytes replay exactly.
 */

/** A JSON value shaped for ordered (struct-style) serialization. */
export type WireValue =
  | null
  | boolean
  | number
  | string
  | readonly WireValue[]
  | OrderedObject
  | { readonly [key: string]: WireValue }

/**
 * Object that serializes its members in the order they were added (the
 * struct regime). Plain objects serialize with sorted keys (the map regime).
 */
export class OrderedObject {
  readonly members: Array<[string, WireValue]> = []

  set(key: string, value: WireValue): this {
    this.members.push([key, value])
    return this
  }
}

/** Builds an {@link OrderedObject} from ordered pairs. */
export function ordered(pairs: ReadonlyArray<[string, WireValue]>): OrderedObject {
  const object = new OrderedObject()
  for (const [key, value] of pairs) object.set(key, value)
  return object
}

/** A plain string-keyed record in the map (alphabetical) regime. */
export type WireMap = { readonly [key: string]: WireValue }

function isPlainObject(value: WireValue): value is { [key: string]: WireValue } {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof OrderedObject)
  )
}

/** Escapes one string the way Go `encoding/json` does (HTML escaping on). */
export function escapeGoString(text: string): string {
  let out = '"'
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    const ch = text[i] ?? ''
    switch (ch) {
      case '"':
        out += '\\"'
        continue
      case '\\':
        out += '\\\\'
        continue
      case '\n':
        out += '\\n'
        continue
      case '\r':
        out += '\\r'
        continue
      case '\t':
        out += '\\t'
        continue
      default:
        break
    }
    if (code < 0x20) {
      out += `\\u${code.toString(16).padStart(4, '0')}`
      continue
    }
    if (ch === '<' || ch === '>' || ch === '&') {
      out += `\\u${code.toString(16).padStart(4, '0')}`
      continue
    }
    if (code === 0x2028 || code === 0x2029) {
      out += `\\u${code.toString(16).padStart(4, '0')}`
      continue
    }
    // Lone surrogates are replaced like Go's invalid-UTF-8 handling.
    if (code >= 0xd800 && code <= 0xdfff) {
      out += '\\ufffd'
      continue
    }
    out += ch
  }
  return `${out}"`
}

/** Encodes one number; integral values print without a decimal tail. */
function encodeNumber(value: number): string {
  if (Number.isInteger(value) && Math.abs(value) < 1e21) return String(value)
  return String(value)
}

function encodeValue(value: WireValue): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return encodeNumber(value)
  if (typeof value === 'string') return escapeGoString(value)
  if (Array.isArray(value)) {
    const parts = value.map((item) => encodeValue(item))
    return `[${parts.join(',')}]`
  }
  if (value instanceof OrderedObject) {
    const parts = value.members.map(([key, item]) => `${escapeGoString(key)}:${encodeValue(item)}`)
    return `{${parts.join(',')}}`
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort()
    const parts = keys.map((key) => `${escapeGoString(key)}:${encodeValue(value[key] ?? null)}`)
    return `{${parts.join(',')}}`
  }
  return 'null'
}

/**
 * Serializes any wire value: `OrderedObject` keeps insertion order (struct
 * regime); plain objects sort their keys (Go map regime); everything else is
 * standard compact JSON with Go string escaping.
 */
export function goJson(value: WireValue): string {
  return encodeValue(value)
}

/** Convenience wrapper for map-regime bodies (`gin.H`). */
export function ginH(fields: WireMap): string {
  return goJson(fields)
}

/** Two-space-indented Go-style JSON (Go `json.Encoder.SetIndent`). */
export function goJsonIndent(value: WireValue, indentUnit = '  '): string {
  const encode = (item: WireValue, depth: number): string => {
    if (item instanceof OrderedObject) {
      if (item.members.length === 0) return '{}'
      const pad = indentUnit.repeat(depth + 1)
      const close = indentUnit.repeat(depth)
      const parts = item.members.map(
        ([key, child]) => `${pad}${escapeGoString(key)}: ${encode(child, depth + 1)}`,
      )
      return `{\n${parts.join(',\n')}\n${close}}`
    }
    if (isPlainObject(item)) {
      const keys = Object.keys(item).sort()
      if (keys.length === 0) return '{}'
      const pad = indentUnit.repeat(depth + 1)
      const close = indentUnit.repeat(depth)
      const parts = keys.map((key) => `${pad}${escapeGoString(key)}: ${encode(item[key] ?? null, depth + 1)}`)
      return `{\n${parts.join(',\n')}\n${close}}`
    }
    if (Array.isArray(item)) {
      if (item.length === 0) return '[]'
      const pad = indentUnit.repeat(depth + 1)
      const close = indentUnit.repeat(depth)
      const parts = item.map((child) => `${pad}${encode(child, depth + 1)}`)
      return `[\n${parts.join(',\n')}\n${close}]`
    }
    return encodeValue(item)
  }
  return encode(value, 0)
}

/**
 * Parses JSON text into plain values, mapping failures to the Go
 * `encoding/json` error strings the vertex-import contract pins
 * (`invalid character 'o' in literal null (expecting 'u')`).
 */
export function parseJsonGo(
  text: string,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly message: string } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch (error) {
    return { ok: false, message: goJsonErrorMessage(text, error) }
  }
}

/**
 * Derives a Go-flavored decoder message. The exact upstream text is only
 * observable for the recorded `not json` probe (literal-null path); other
 * shapes fall back to the generic Go syntax error form.
 */
function goJsonErrorMessage(text: string, error: unknown): string {
  const message = error instanceof SyntaxError ? error.message : String(error)
  const trimmed = text.trimStart()
  const first = trimmed[0] ?? ''
  if (first === 'n' && !trimmed.startsWith('null')) {
    const offender = trimmed[1] ?? ''
    if (offender !== '' && /[a-zA-Z"0-9-]/.test(offender)) {
      return `invalid character '${offender}' in literal null (expecting 'u')`
    }
  }
  if (message.includes('Unexpected token') || message.includes('Unexpected end')) {
    const offender = first === '' ? ' ' : first
    return `invalid character '${offender}' looking for beginning of value`
  }
  return `invalid character '${first === '' ? ' ' : first}' looking for beginning of value`
}

/** Narrows unknown data to a plain JSON object (not array, not null). */
export function asPlainRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}
