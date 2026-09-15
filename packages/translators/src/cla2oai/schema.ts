/**
 * Tool wiring for the cla2oai direction: identifier sanitation, the
 * request-side name-restore map, the tool-argument repair pass, and the
 * schema normalization + re-serialization of `input_schema` (section 3.2).
 *
 * Recorded facts encoded here:
 *
 * - upstream tool-call ids are sanitized for Claude clients: characters
 *   outside `[a-zA-Z0-9_-]` become `_` (recorded: `call:rich:1` ->
 *   `call_rich_1`);
 * - response tool names are restored to the request's exact casing via a
 *   canonical map (trim, leading underscores stripped, lowercased;
 *   recorded: upstream `get_weather` -> request `Get_Weather`);
 * - tool arguments are repaired with a single-to-double quote fixer
 *   before parsing; a valid JSON object survives, anything else becomes
 *   `{}` (recorded: S2d4-nostream-rich);
 * - `input_schema` values are re-serialized the way the reference's
 *   JSON writer emits parsed values: alphabetically sorted keys with
 *   HTML-escaped strings, after normalization (`type:"object"` without
 *   `properties` gains `"properties":{}`; `pattern` values and
 *   `patternProperties` keys using unicode property escapes the upstream
 *   regexp engine does not support are deleted recursively; recorded:
 *   S2d4-tools-request).
 */
import { isPlainObject, readString, serializeOrdered, sortKeysDeep } from './json'
import type { WireObject, WireValue } from './json'

/**
 * Sanitizes an upstream tool-call id for the Claude wire: characters
 * outside `[a-zA-Z0-9_-]` become `_` (recorded: `call:rich:1` ->
 * `call_rich_1`).
 */
export function sanitizeClaudeToolId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_')
}

let generatedCounter = 0

/**
 * Server-generated id for an upstream tool call without one
 * (`toolu_<unix-nano>_<counter>`; wall-clock bound, deliberately not
 * golden-pinned).
 */
export function generatedToolUseId(): string {
  generatedCounter += 1
  const nanos =
    typeof performance === 'undefined'
      ? Date.now() * 1_000_000
      : Math.round((performance.timeOrigin + performance.now()) * 1_000_000)
  return `toolu_${nanos}_${generatedCounter}`
}

/** Canonical form used by the name-restore map (trim, strip `_`, lower). */
function canonicalToolName(name: string): string {
  return name.trim().replace(/^_+/, '').toLowerCase()
}

/** Reverse map built from the request's `tools[].name` (section 3.4). */
export interface ToolNameIndex {
  /** canonical(original) -> original */
  readonly byCanonical: ReadonlyMap<string, string>
}

/** Original tool objects of the request, in order. */
export function requestToolList(request: Record<string, unknown>): readonly WireObject[] {
  const tools = request['tools']
  if (!Array.isArray(tools)) return []
  const out: WireObject[] = []
  for (const tool of tools) {
    if (isPlainObject(tool)) out.push(tool as WireObject)
  }
  return out
}

/** Builds the name-restore index over the request's tools. */
export function buildToolNameIndex(tools: readonly WireObject[]): ToolNameIndex {
  const byCanonical = new Map<string, string>()
  for (const tool of tools) {
    const name = readString(tool, 'name')
    if (typeof name !== 'string') continue
    const canonical = canonicalToolName(name)
    if (!byCanonical.has(canonical)) byCanonical.set(canonical, name)
  }
  return { byCanonical }
}

/**
 * Restores an upstream tool name to the request's original casing: the
 * canonical form of both names must match (case-insensitive after trim
 * and leading-underscore strip); a name with no match survives unchanged.
 */
export function restoreToolName(index: ToolNameIndex, upstreamName: string): string {
  const canonical = index.byCanonical.get(canonicalToolName(upstreamName))
  return canonical !== undefined ? canonical : upstreamName
}

// ---------------------------------------------------------------------------
// Argument repair (FixJSON)
// ---------------------------------------------------------------------------

/**
 * Repairs single-quoted JSON the way the reference does before parsing
 * tool arguments: string DELIMITERS switch from `'` to `"`. Quotes that
 * already live inside double-quoted strings and backslash escapes are
 * left alone; a `'` delimiter closes (rather than splits) the string, so
 * apostrophes inside single-quoted values terminate it exactly as the
 * upstream repair would.
 */
export function fixJson(text: string): string {
  let out = ''
  let state: 'top' | 'double' | 'single' = 'top'
  for (let i = 0; i < text.length; i++) {
    const current = text[i]
    if (state === 'top') {
      if (current === "'") {
        state = 'single'
        out += '"'
        continue
      }
      if (current === '"') state = 'double'
      out += current
      continue
    }
    if (state === 'double') {
      if (current === '\\') {
        out += current
        const next = text[i + 1]
        if (next !== undefined) {
          out += next
          i++
        }
        continue
      }
      if (current === '"') state = 'top'
      out += current
      continue
    }
    // single-quoted string
    if (current === '\\') {
      out += current
      const next = text[i + 1]
      if (next !== undefined) {
        out += next
        i++
      }
      continue
    }
    if (current === "'") {
      state = 'top'
      out += '"'
      continue
    }
    out += current
  }
  return out
}

/**
 * Parses a tool-call `arguments` string into a raw object with the Go
 * map-marshal key order (alphabetical); `{}` when empty, invalid, or not
 * a JSON object.
 */
export function parseToolArguments(argumentsText: string | undefined): WireObject {
  if (argumentsText === undefined || argumentsText.length === 0) return {}
  try {
    const parsed: unknown = JSON.parse(fixJson(argumentsText))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    return sortKeysDeep(parsed as WireValue) as WireObject
  } catch {
    return {}
  }
}

/**
 * True when the arguments string is empty, `{}`, or a valid JSON object
 * (the finish-reason classification of section 4.2 rule 5).
 */
export function argumentsAreValidObject(argumentsText: string): boolean {
  if (argumentsText.length === 0) return true
  try {
    const parsed: unknown = JSON.parse(fixJson(argumentsText))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Schema normalization + re-serialization
// ---------------------------------------------------------------------------

/**
 * Unicode property names the upstream regexp engine accepts inside
 * `\\p{...}` / `\\pX` classes: the Unicode general categories and the
 * common script names. A `pattern` (or `patternProperties` key) naming
 * anything else is deleted from the schema.
 */
const SUPPORTED_PROPERTY_NAMES: ReadonlySet<string> = new Set([
  // Unicode general categories (one- and two-letter forms).
  'C', 'Cc', 'Cf', 'Co', 'Cs', 'L', 'Ll', 'Lm', 'Lo', 'Lt', 'Lu', 'M', 'Mc',
  'Me', 'Mn', 'N', 'Nd', 'Nl', 'No', 'P', 'Pc', 'Pd', 'Pe', 'Pf', 'Pi', 'Po',
  'Ps', 'S', 'Sc', 'Sk', 'Sm', 'So', 'Z', 'Zl', 'Zp', 'Zs',
  // Common script names of the upstream engine's tables.
  'Adlam', 'Ahom', 'Anatolian_Hieroglyphs', 'Arabic', 'Armenian', 'Avestan',
  'Balinese', 'Bamum', 'Bassa_Vah', 'Batak', 'Bengali', 'Bhaiksuki', 'Bopomofo',
  'Brahmi', 'Braille', 'Buginese', 'Buhid', 'Canadian_Aboriginal', 'Carian',
  'Caucasian_Albanian', 'Chakma', 'Cham', 'Cherokee', 'Common', 'Coptic',
  'Cuneiform', 'Cypriot', 'Cyrillic', 'Deseret', 'Devanagari', 'Dives_Akuru',
  'Dogra', 'Duployan', 'Egyptian_Hieroglyphs', 'Elbasan', 'Elymaic',
  'Ethiopic', 'Georgian', 'Glagolitic', 'Gothic', 'Grantha', 'Greek',
  'Gujarati', 'Gunjala_Gondi', 'Gurmukhi', 'Han', 'Hangul', 'Hanifi_Rohingya',
  'Hanunoo', 'Hatran', 'Hebrew', 'Hiragana', 'Imperial_Aramaic',
  'Inherited', 'Inscriptional_Pahlavi', 'Inscriptional_Parthian', 'Javanese',
  'Kaithi', 'Kannada', 'Katakana', 'Kayah_Li', 'Kharoshthi', 'Khitan_Small_Script',
  'Khmer', 'Khojki', 'Khudawadi', 'Lao', 'Latin', 'Lepcha', 'Limbu',
  'Linear_A', 'Linear_B', 'Lisu', 'Lycian', 'Lydian', 'Mahajani', 'Makasar',
  'Malayalam', 'Mandaic', 'Manichaean', 'Marchen', 'Masaram_Gondi', 'Medefaidrin',
  'Meetei_Mayek', 'Mende_Kikakui', 'Meroitic_Cursive', 'Meroitic_Hieroglyphs',
  'Miao', 'Modi', 'Mongolian', 'Mro', 'Multani', 'Myanmar', 'Nabataean',
  'Nandinagari', 'New_Tai_Lue', 'Newa', 'Nko', 'Nushu', 'Nyiakeng_Puachue_Hmong',
  'Ogham', 'Ol_Chiki', 'Old_Hungarian', 'Old_Italic', 'Old_North_Arabian',
  'Old_Permic', 'Old_Persian', 'Old_Sogdian', 'Old_South_Arabian', 'Old_Turkic',
  'Old_Uyghur', 'Oriya', 'Osage', 'Osmanya', 'Pahawh_Hmong', 'Palmyrene',
  'Pau_Cin_Hau', 'Phags_Pa', 'Phoenician', 'Psalter_Pahlavi', 'Rejang', 'Runic',
  'Samaritan', 'Saurashtra', 'Sharada', 'Shavian', 'Siddham', 'SignWriting',
  'Sinhala', 'Sogdian', 'Sora_Sompeng', 'Soyombo', 'Sundanese', 'Syloti_Nagri',
  'Syriac', 'Tagalog', 'Tagbanwa', 'Tai_Le', 'Tai_Tham', 'Tai_Viet', 'Takri',
  'Tamil', 'Tangut', 'Telugu', 'Thaana', 'Thai', 'Tibetan', 'Tifinagh',
  'Tirhuta', 'Ugaritic', 'Unknown', 'Vai', 'Wancho', 'Warang_Citi', 'Yezidi', 'Yi', 'Zanabazar_Square',
])

/**
 * True when the pattern uses a `\\p{...}` / `\\pX` escape whose property
 * name the upstream engine does not support. Bare `\\p` without a name is
 * treated as unsupported as well.
 */
export function usesUnsupportedPropertyEscape(pattern: string): boolean {
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] !== '\\' || pattern[i + 1] !== 'p') continue
    const rest = pattern.slice(i + 2)
    const braced = /^\{([^}]*)\}/.exec(rest)
    if (braced !== null) {
      if (!SUPPORTED_PROPERTY_NAMES.has(braced[1] ?? '')) return true
      i += braced[0].length + 1
      continue
    }
    const bare = /^([A-Za-z])/.exec(rest)
    if (bare === null || !SUPPORTED_PROPERTY_NAMES.has(bare[1] ?? '')) return true
    i += 1
  }
  return false
}

/**
 * Normalizes one schema value for the upstream wire (section 3.2):
 * `type:"object"` members without `properties` gain `"properties":{}`;
 * `pattern` string values and `patternProperties` keys with unsupported
 * unicode property escapes are deleted. Returns a fresh, detached value.
 */
export function normalizeObjectSchemaProperties(value: unknown): WireValue {
  if (Array.isArray(value)) {
    return value.map((element) => normalizeObjectSchemaProperties(element))
  }
  if (!isPlainObject(value)) return (value ?? null) as WireValue
  const out: { [key: string]: WireValue } = {}
  for (const key of Object.keys(value)) {
    if (key === 'pattern') {
      const pattern = value['pattern']
      if (typeof pattern === 'string' && usesUnsupportedPropertyEscape(pattern)) continue
      out['pattern'] = normalizeObjectSchemaProperties(pattern)
      continue
    }
    if (key === 'patternProperties') {
      const patternProperties = value['patternProperties']
      if (isPlainObject(patternProperties)) {
        const kept: { [key: string]: WireValue } = {}
        for (const patternKey of Object.keys(patternProperties)) {
          if (usesUnsupportedPropertyEscape(patternKey)) continue
          kept[patternKey] = normalizeObjectSchemaProperties(patternProperties[patternKey])
        }
        out['patternProperties'] = kept
        continue
      }
      out['patternProperties'] = normalizeObjectSchemaProperties(patternProperties)
      continue
    }
    const member = (value as Record<string, unknown>)[key]
    if (member === undefined) continue
    out[key] = normalizeObjectSchemaProperties(member)
  }
  if (out['type'] === 'object' && out['properties'] === undefined) {
    out['properties'] = {}
  }
  return out
}

/**
 * Re-serializes one `input_schema` for the `parameters` member: the
 * normalized schema with alphabetically sorted keys and HTML-escaped
 * strings - the recorded `{"properties":{"city":{"type":"string"}},"required":["city"],"type":"object"}` shape.
 */
export function serializeToolParameters(inputSchema: unknown): string {
  const normalized = normalizeObjectSchemaProperties(inputSchema)
  return serializeOrdered(sortKeysDeep(normalized))
}
