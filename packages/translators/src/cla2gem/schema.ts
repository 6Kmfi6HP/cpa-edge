/**
 * Tool wiring for the cla2gem direction: identifier sanitization, the
 * Gemini schema cleaning (enum hint), and the functionDeclarations
 * builder.
 *
 * Recorded facts encoded here:
 *
 * - identifiers the gateway writes for function names, calls, responses
 *   and forced-name lists are sanitized (invalid characters -> `_`, a
 *   non-letter start gets a `_` prefix, length capped at 64);
 * - `parametersJsonSchema` keeps the client schema's ORIGINAL bytes for
 *   untouched members; the only recorded rewrite is the enum hint: the
 *   enum array value is re-serialized compactly and a compact
 *   `"description":"Allowed: v1, v2, ..."` member is appended right after
 *   it (case 04: `["celsius", "fahrenheit"]` -> `["celsius","fahrenheit"],`
 *   plus the hint);
 * - a tool without an `input_schema` never reaches the wire.
 */
import { isPlainObject, rawSpanAt, rawValueAt, readArray, readString, serializeOrdered } from './json'
import { RawJson } from './json'
import type { WireObject } from './json'

/** Longest identifier the gateway emits (sanitizer truncation bound). */
const MAX_IDENTIFIER_LENGTH = 64

/**
 * Sanitizes an identifier for the Gemini wire: characters outside
 * `[a-zA-Z0-9_.:-]` become `_`; a first character that is neither a letter
 * nor `_` prepends one after truncating to 63; the result never exceeds 64
 * characters. Applied to declaration names, call names, response names and
 * forced-name entries.
 */
export function sanitizeFunctionName(name: string): string {
  let out = name.replace(/[^a-zA-Z0-9_.:-]/g, '_')
  const first = out.charAt(0)
  if (first.length > 0 && !/[a-zA-Z_]/.test(first)) {
    out = `_${out.slice(0, MAX_IDENTIFIER_LENGTH - 1)}`
  }
  return out.slice(0, MAX_IDENTIFIER_LENGTH)
}

/**
 * Sanitizes a generated Claude tool id: characters outside `[a-zA-Z0-9_-]`
 * become `_` (recorded: `get weather-1` -> `get_weather-1`).
 */
export function sanitizeClaudeToolId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_')
}

/**
 * Canonical form used by the response-side name restore: lowercased with
 * leading underscores trimmed.
 */
function canonicalToolName(name: string): string {
  return name.toLowerCase().replace(/^_+/, '')
}

/** Reverse-sanitization map built from the request's tools. */
export interface ToolNameIndex {
  /** sanitize(original) -> original */
  readonly bySanitized: ReadonlyMap<string, string>
  /** canonical(original) -> original */
  readonly byCanonical: ReadonlyMap<string, string>
  /** declaration names in request order (sanitized). */
  readonly declarationNames: readonly string[]
}

/** Original tool objects of the request, in order. */
export function requestToolList(request: Record<string, unknown>): readonly WireObject[] {
  const tools = readArray(request, 'tools')
  if (tools === undefined) return []
  const out: WireObject[] = []
  for (const tool of tools) {
    if (isPlainObject(tool)) out.push(tool as WireObject)
  }
  return out
}

/** Builds the name-restore index over the request's tools. */
export function buildToolNameIndex(tools: readonly WireObject[]): ToolNameIndex {
  const bySanitized = new Map<string, string>()
  const byCanonical = new Map<string, string>()
  const declarationNames: string[] = []
  for (const tool of tools) {
    const name = readString(tool, 'name')
    if (typeof name !== 'string') continue
    const sanitized = sanitizeFunctionName(name)
    declarationNames.push(sanitized)
    if (!bySanitized.has(sanitized)) bySanitized.set(sanitized, name)
    const canonical = canonicalToolName(name)
    if (!byCanonical.has(canonical)) byCanonical.set(canonical, name)
  }
  return { bySanitized, byCanonical, declarationNames }
}

/**
 * Restores an upstream function name to the request's original tool name:
 * first via the sanitized-name index, then via the canonical index; a name
 * with no match survives unchanged.
 */
export function restoreToolName(index: ToolNameIndex, upstreamName: string): string {
  const direct = index.bySanitized.get(upstreamName)
  if (direct !== undefined) return direct
  const canonical = index.byCanonical.get(canonicalToolName(upstreamName))
  if (canonical !== undefined) return canonical
  return upstreamName
}

// ---------------------------------------------------------------------------
// Schema cleaning (enum hint)
// ---------------------------------------------------------------------------

/** One byte-level rewrite of a schema document: enum compaction + hint. */
interface Rewrite {
  /** Span of the enum member's value inside the raw schema text. */
  readonly start: number
  readonly end: number
  /** Compact replacement for the enum value. */
  readonly value: string
  /** Compact hint member inserted immediately after the enum value. */
  readonly inserted: string
}

/**
 * Walks a parsed schema and records every enum rewrite as a byte span.
 * Objects with an `enum` member whose value is a non-empty array of
 * strings get the hint; anything else is left untouched.
 */
function collectRewrites(value: unknown, prefix: readonly string[], out: Rewrite[], rawText: string): void {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      collectRewrites(value[i], [...prefix, String(i)], out, rawText)
    }
    return
  }
  if (!isPlainObject(value)) return
  const members = value as Record<string, unknown>
  for (const key of Object.keys(members)) {
    collectRewrites(members[key], [...prefix, key], out, rawText)
  }
  const enumValue = members['enum']
  if (!Array.isArray(enumValue) || enumValue.length === 0) return
  if (!enumValue.every((entry) => typeof entry === 'string')) return
  const span = rawSpanAt(rawText, [...prefix, 'enum'])
  if (span === undefined) return
  const values = enumValue as readonly string[]
  out.push({
    start: span.valueStart,
    end: span.valueEnd,
    value: serializeOrdered(values),
    inserted: `,"description":"Allowed: ${values.join(', ')}"`,
  })
}

/**
 * Cleans one raw client schema for `parametersJsonSchema`: the original
 * bytes are preserved except that every string-enum member's value is
 * re-serialized compactly and the allowed-values hint is appended right
 * after it. Overlapping nested rewrites are applied from the inside out.
 */
export function cleanGeminiSchema(rawSchema: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawSchema)
  } catch {
    return rawSchema
  }
  const rewrites: Rewrite[] = []
  collectRewrites(parsed, [], rewrites, rawSchema)
  if (rewrites.length === 0) return rawSchema
  // Deepest (longest) span first keeps outer splices from shifting inner
  // offsets; the outer enum value itself contains the inner rewrite only
  // when an enum lives inside another enum's array, which the type rule
  // already excludes.
  rewrites.sort((left, right) => right.start - left.start || right.end - left.end)
  let out = rawSchema
  for (const rewrite of rewrites) {
    if (rewrite.start < 0) continue
    out = out.slice(0, rewrite.start) + rewrite.value + rewrite.inserted + out.slice(rewrite.end)
  }
  return out
}

// ---------------------------------------------------------------------------
// functionDeclarations
// ---------------------------------------------------------------------------

/**
 * Builds the `tools` array of the upstream body: ONE wrapper object whose
 * `functionDeclarations` collects every declared tool (recorded shape:
 * `tools:[{"functionDeclarations":[...]}]`). Tools without an
 * `input_schema` are skipped entirely.
 */
export function buildFunctionDeclarations(
  tools: readonly WireObject[],
  rawBody: string,
): WireObject | undefined {
  const declarations: WireObject[] = []
  for (let index = 0; index < tools.length; index++) {
    const tool = tools[index]
    if (tool === undefined) continue
    const schema = tool['input_schema']
    if (!isPlainObject(schema)) continue
    const declaration: WireObject = {}
    const name = readString(tool, 'name')
    declaration['name'] = sanitizeFunctionName(typeof name === 'string' ? name : '')
    const description = tool['description']
    if (typeof description === 'string') declaration['description'] = description
    const raw = rawValueAt(rawBody, ['tools', String(index), 'input_schema'])
    const cleaned = raw !== undefined ? cleanGeminiSchema(raw) : serializeOrdered(schema)
    declaration['parametersJsonSchema'] = new RawJson(cleaned)
    declarations.push(declaration)
  }
  if (declarations.length === 0) return undefined
  return { functionDeclarations: declarations }
}
