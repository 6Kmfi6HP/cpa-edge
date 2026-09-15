/**
 * Tool-name shortening and tool-schema normalization for the Codex wire.
 *
 * Two independent passes live here:
 *
 * - name mapping (S2d5 2.10): every tool name on the upstream body (tool
 *   declarations, `tool_choice`, history `function_call`/`custom_tool_call`
 *   items) is sanitized and, past 64 characters, shortened. The mapping is
 *   built from all names of the request; the reverse map restores original
 *   names on the way back.
 *
 * - schema normalization (S2d5 2.11, unconditional): for every function or
 *   custom tool carrying an object `parameters` (namespace tools recurse
 *   into their nested `tools`), Unicode-property `pattern` attributes and
 *   matching `patternProperties` keys are stripped - the whole parameters
 *   value re-serialized with lexicographic keys when that fires - and
 *   pure-const unions of at least eight branches rewrite to `enum` in place,
 *   a raw-byte splice that preserves every untouched byte and reuses the
 *   branch const tokens verbatim.
 */
import {
  deleteRawMember,
  isPlainObject,
  rawSpanAt,
  scanArrayElements,
  scanObjectMembers,
  serializeOrdered,
  sortKeysDeep,
} from './json'
import type { RawMember, RawSpan } from './json'
import type { WireValue } from './types'

/** Maximum tool-name length the upstream accepts. */
export const CODEX_TOOL_NAME_LIMIT = 64

/** Minimum union branches that trigger the const-union -> enum rewrite. */
export const CODEX_COMPLEX_UNION_BRANCH_THRESHOLD = 8

/** Member names whose values are user data, never schema locations. */
const USER_DATA_KEYS: ReadonlySet<string> = new Set(['description', 'default', 'enum'])

/** Allowed keys of a pure-const union branch besides the const itself. */
const BRANCH_META_KEYS: readonly string[] = ['description', 'title']

/** Detects a Unicode property escape (`\p{...}` / `\P{...}`) in a decoded string. */
function hasUnicodePropertyEscape(value: string): boolean {
  return value.includes('\\p{') || value.includes('\\P{')
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Name shortening + restoration (S2d5 2.10)
// ---------------------------------------------------------------------------

/** Replaces characters outside `[a-zA-Z0-9_-]` with `_`. */
export function sanitizeToolName(name: string): string {
  let out = ''
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i)
    const isAlnum = (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)
    out += isAlnum || name[i] === '_' || name[i] === '-' ? name[i] : '_'
  }
  return out
}

/**
 * Shortens one sanitized name past the length limit: `mcp__`-prefixed names
 * keep the prefix plus the segment after the LAST `__`, then truncate to the
 * limit; everything else truncates plainly.
 */
export function shortenSanitizedName(name: string): string {
  if (name.length <= CODEX_TOOL_NAME_LIMIT) return name
  if (name.startsWith('mcp__')) {
    const last = name.lastIndexOf('__')
    const segment = last >= 0 ? name.slice(last + 2) : name.slice(5)
    return ('mcp__' + segment).slice(0, CODEX_TOOL_NAME_LIMIT)
  }
  return name.slice(0, CODEX_TOOL_NAME_LIMIT)
}

/** Maps one original name to its upstream (sanitized + shortened) form. */
export function shortenToolName(name: string): string {
  return shortenSanitizedName(sanitizeToolName(name))
}

/** Fits a `_<n>` uniqueness suffix inside the 64-character limit. */
function uniquify(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base
  for (let n = 1; ; n++) {
    const suffix = `_${n}`
    const candidate = base.slice(0, CODEX_TOOL_NAME_LIMIT - suffix.length) + suffix
    if (!taken.has(candidate)) return candidate
  }
}

/**
 * Builds the name mapping over ALL tool names of a request, in declaration
 * order: tools, then `tool_choice`, then assistant history calls. Repeated
 * originals share one short name; distinct originals colliding after
 * shortening take `_<n>` suffixes within the limit. The returned record is
 * the reverse map (short -> original).
 */
export function buildShortNameMap(names: readonly string[]): Readonly<Record<string, string>> {
  const forward = new Map<string, string>()
  const reverse: Record<string, string> = {}
  const taken = new Set<string>()
  for (const original of names) {
    if (forward.has(original)) continue
    const short = uniquify(shortenToolName(original), taken)
    forward.set(original, short)
    taken.add(short)
    reverse[short] = original
  }
  return reverse
}

/** Looks the original name of a wire name up in the reverse map. */
export function restoreToolName(name: string, nameMap: Readonly<Record<string, string>> | undefined): string {
  if (nameMap === undefined) return name
  return nameMap[name] ?? name
}

// ---------------------------------------------------------------------------
// Schema normalization (S2d5 2.11)
// ---------------------------------------------------------------------------

interface PatternStrip {
  fired: boolean
}

/**
 * Strips schema-aware Unicode-property patterns: `pattern` members whose
 * value carries `\p{...}`/`\P{...}`, and `patternProperties` entries whose
 * KEY does. User-data members (description/default/enum values) are never
 * entered.
 */
function stripPatterns(value: unknown, state: PatternStrip): unknown {
  if (Array.isArray(value)) {
    return value.map((element) => stripPatterns(element, state))
  }
  if (!isPlainObject(value)) return value
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value)) {
    const member = (value as Record<string, unknown>)[key]
    if (key === 'patternProperties' && isPlainObject(member)) {
      const kept: Record<string, unknown> = {}
      for (const pattern of Object.keys(member)) {
        if (hasUnicodePropertyEscape(pattern)) {
          state.fired = true
          continue
        }
        kept[pattern] = stripPatterns((member as Record<string, unknown>)[pattern], state)
      }
      out[key] = kept
      continue
    }
    if (key === 'pattern' && typeof member === 'string' && hasUnicodePropertyEscape(member)) {
      state.fired = true
      continue
    }
    out[key] = USER_DATA_KEYS.has(key) ? member : stripPatterns(member, state)
  }
  return out
}

/** Primitive equality with `Object.is` semantics (numbers compare by value). */
function sameValue(left: unknown, right: unknown): boolean {
  if (typeof left === 'number' && typeof right === 'number') {
    return Number.isNaN(left) && Number.isNaN(right) ? true : left === right
  }
  if (typeof left !== typeof right) return false
  return left === right
}

interface UnionRewrite {
  /** True when the property text changed. */
  readonly changed: boolean
  /** Replacement text for the property schema object (the original when untouched). */
  readonly text: string
}

const UNTOUCHED: UnionRewrite = { changed: false, text: '' }

/** Index of the first value byte of a member inside `text`. */
function memberValueStart(text: string, member: RawMember): number {
  const colon = text.indexOf(':', member.span.start)
  let i = colon + 1
  while (i < member.span.end && /\s/.test(text[i] ?? '')) i++
  return i
}

/**
 * Applies the const-union -> enum rewrite to the RAW text of one property
 * schema object. Trigger, all required: exactly one of `oneOf`/`anyOf`, at
 * least 8 branches, every branch a pure const (only `const` plus optional
 * `description`/`title`, primitive value), all const values semantically
 * unique. A pre-existing `enum` provably equal to the const sequence (same
 * order, same values) deletes the union only; any other shape stays
 * byte-untouched. Otherwise the union is deleted and `enum` is appended
 * with the RAW const tokens, in branch order.
 */
function rewriteConstUnion(propertyRaw: string): UnionRewrite {
  const objectSpan: RawSpan = { start: 0, end: propertyRaw.length }
  const members = scanObjectMembers(propertyRaw, objectSpan)
  if (members === undefined) return UNTOUCHED
  const unionMembers = members.filter((member) => member.key === 'oneOf' || member.key === 'anyOf')
  if (unionMembers.length !== 1) return UNTOUCHED
  const unionMember = unionMembers[0]
  if (unionMember === undefined) return UNTOUCHED

  const arrayStart = memberValueStart(propertyRaw, unionMember)
  if (propertyRaw[arrayStart] !== '[') return UNTOUCHED
  const branchSpans = scanArrayElements(propertyRaw, arrayStart, unionMember.span.end)
  if (branchSpans.length < CODEX_COMPLEX_UNION_BRANCH_THRESHOLD) return UNTOUCHED

  const tokens: string[] = []
  const values: unknown[] = []
  for (const branchSpan of branchSpans) {
    const branchMembers = scanObjectMembers(propertyRaw, branchSpan)
    if (branchMembers === undefined) return UNTOUCHED
    for (const branchMember of branchMembers) {
      if (branchMember.key !== 'const' && !BRANCH_META_KEYS.includes(branchMember.key)) return UNTOUCHED
    }
    const constMember = branchMembers.find((branchMember) => branchMember.key === 'const')
    if (constMember === undefined) return UNTOUCHED
    const token = propertyRaw.slice(memberValueStart(propertyRaw, constMember), constMember.span.end).trim()
    const value = safeParse(token)
    if (value === undefined || (typeof value === 'object' && value !== null)) return UNTOUCHED
    tokens.push(token)
    values.push(value)
  }
  for (let i = 0; i < values.length; i++) {
    for (let j = i + 1; j < values.length; j++) {
      if (sameValue(values[i], values[j])) return UNTOUCHED
    }
  }

  const enumMember = members.find((member) => member.key === 'enum')
  if (enumMember !== undefined) {
    const enumRaw = propertyRaw.slice(memberValueStart(propertyRaw, enumMember), enumMember.span.end)
    const parsedEnum = safeParse(enumRaw)
    if (!Array.isArray(parsedEnum) || parsedEnum.length !== values.length) return UNTOUCHED
    for (let i = 0; i < values.length; i++) {
      if (!sameValue(parsedEnum[i], values[i])) return UNTOUCHED
    }
  }

  let updated = deleteRawMember(propertyRaw, objectSpan, unionMember)
  if (enumMember === undefined) {
    const close = updated.length - 1
    updated = updated.slice(0, close) + `,"enum":[${tokens.join(',')}]` + updated.slice(close)
  }
  return { changed: true, text: updated }
}

/**
 * Normalizes the RAW text of one tool's `parameters` value: pattern strip
 * first (an alphabetical remarshal when it fires, which also decodes any
 * `\u` escapes), then the const-union rewrite as a raw splice over every
 * property of `parameters.properties`. Returns the original text when
 * nothing fires.
 */
export function normalizeCodexParameters(raw: string): string {
  let text = raw
  const parsed = safeParse(text)
  if (parsed === undefined) return text
  const state: PatternStrip = { fired: false }
  const stripped = stripPatterns(parsed, state)
  if (state.fired) {
    text = serializeOrdered(sortKeysDeep(stripped as WireValue))
  }

  const propertiesSpan = rawSpanAt(text, ['properties'])
  if (propertiesSpan === undefined) return text
  const members = scanObjectMembers(text, propertiesSpan)
  if (members === undefined) return text
  let out = text
  // Splice from the last property backwards so earlier spans stay valid.
  for (let i = members.length - 1; i >= 0; i--) {
    const member = members[i]
    if (member === undefined) continue
    const valueStart = memberValueStart(text, member)
    const valueEnd = member.span.end
    const rewrite = rewriteConstUnion(out.slice(valueStart, valueEnd))
    if (!rewrite.changed) continue
    out = out.slice(0, valueStart) + rewrite.text + out.slice(valueEnd)
  }
  return out
}

/**
 * Runs the schema normalization over the TRANSLATED upstream body's `tools`
 * array: every function/custom tool's object `parameters` is normalized in
 * place (a raw splice in the body bytes), and any tool carrying a nested
 * `tools` array recurses. Tools without `parameters` are left untouched.
 */
export function normalizeCodexToolSchemasInBody(body: string): string {
  const toolsSpan = rawSpanAt(body, ['tools'])
  if (toolsSpan === undefined) return body
  return normalizeToolArrayElements(body, toolsSpan)
}

/** Normalizes every element of one `tools` array span, splicing in place. */
function normalizeToolArrayElements(body: string, arraySpan: RawSpan): string {
  if (body[arraySpan.start] !== '[') return body
  const elements = scanArrayElements(body, arraySpan.start, arraySpan.end)
  let out = body
  for (let i = elements.length - 1; i >= 0; i--) {
    const element = elements[i]
    if (element === undefined) continue
    out = out.slice(0, element.start) + normalizeToolObject(out.slice(element.start, element.end)) + out.slice(element.end)
  }
  return out
}

/** Normalizes one tool object: its own `parameters` plus nested `tools`. */
function normalizeToolObject(toolRaw: string): string {
  const objectSpan: RawSpan = { start: 0, end: toolRaw.length }
  const members = scanObjectMembers(toolRaw, objectSpan)
  if (members === undefined) return toolRaw
  const parsed = safeParse(toolRaw)
  if (!isPlainObject(parsed)) return toolRaw
  const type = parsed['type']
  // Members are visited from the last to the first so splices never
  // invalidate a sibling span computed earlier.
  let out = toolRaw
  for (let i = members.length - 1; i >= 0; i--) {
    const member = members[i]
    if (member === undefined) continue
    if (member.key === 'parameters' && (type === 'function' || type === 'custom')) {
      const valueStart = memberValueStart(toolRaw, member)
      const valueEnd = member.span.end
      const rawParameters = out.slice(valueStart, valueEnd)
      if (!isPlainObject(safeParse(rawParameters))) continue
      const normalized = normalizeCodexParameters(rawParameters)
      if (normalized === rawParameters) continue
      out = out.slice(0, valueStart) + normalized + out.slice(valueEnd)
      continue
    }
    if (member.key === 'tools') {
      const valueStart = memberValueStart(toolRaw, member)
      if (out[valueStart] !== '[') continue
      const nested = normalizeToolArrayElements(out, { start: valueStart, end: member.span.end })
      if (nested === out) continue
      out = nested
    }
  }
  return out
}
