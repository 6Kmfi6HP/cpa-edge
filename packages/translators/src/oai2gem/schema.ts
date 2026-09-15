/**
 * Tool wiring for the oai2gem direction: the recorded identifier
 * sanitizer, the Gemini schema cleaner, and the `tools` builder
 * (functionDeclarations first, then the googleSearch / codeExecution /
 * urlContext nodes).
 *
 * Recorded facts encoded here:
 *
 * - identifiers the gateway writes for function names are sanitized
 *   (invalid characters -> `_`, a non-letter start gets a `_` prefix,
 *   length capped at 64); `get-weather` is already legal and survives
 *   unchanged (fixture C03);
 * - `parametersJsonSchema` keeps the client schema's ORIGINAL bytes while
 *   nothing needs cleaning (fixtures C03/C04/C12 pin the raw passthrough
 *   incl. the client's spacing); when the cleaner rewrites something the
 *   rewrite is surgical: untouched members keep their bytes and only the
 *   gateway-written pieces are compact (the sibling Gemini-upstream golden
 *   S2d8-04 pins the enum encoding: compact enum array plus a compact
 *   `"description":"Allowed: v1, v2, ..."` member right after it);
 * - a declaration without `parameters` carries the recorded default
 *   `{"type":"object","properties":{}}`; the `strict` member never reaches
 *   the wire (only name/description/parametersJsonSchema do).
 */
import { isPlainObject, rawValueAt, readString, scanRawObject, serializeOrdered, serializeOrderedCapped } from './json'
import { RawJson } from './json'
import type { RawObjectScan, WireObject, WireValue } from './json'

/** Longest identifier the gateway emits (sanitizer truncation bound). */
const MAX_IDENTIFIER_LENGTH = 64

/**
 * Sanitizes an identifier for the Gemini wire: characters outside
 * `[a-zA-Z0-9_.:-]` become `_`; a first character that is neither a letter
 * nor `_` prepends one after truncating to 63; the result never exceeds 64
 * characters.
 */
export function sanitizeFunctionName(name: string): string {
  let out = name.replace(/[^a-zA-Z0-9_.:-]/g, '_')
  const first = out.charAt(0)
  if (first.length > 0 && !/[a-zA-Z_]/.test(first)) {
    out = `_${out.slice(0, MAX_IDENTIFIER_LENGTH - 1)}`
  }
  return out.slice(0, MAX_IDENTIFIER_LENGTH)
}

/** Declaration-name requirement: non-empty after sanitizing. */
export function sanitizedOrEmpty(name: string): string {
  return name.trim().length > 0 ? sanitizeFunctionName(name) : ''
}

// ---------------------------------------------------------------------------
// Schema cleaning (surgical, byte-preserving for clean schemas)
// ---------------------------------------------------------------------------

/** Members the cleaner deletes wherever they appear (spec 3.1.2). */
const DROPPED_MEMBERS: ReadonlySet<string> = new Set(['nullable', 'title'])

/**
 * Constraint members the Gemini schema dialect does not accept. The
 * cleaner deletes them and folds their content into the object's
 * `description` hint (the hint byte shape is unrecorded; only the enum
 * hint is golden-pinned, by the sibling S2d8-04).
 */
const UNSUPPORTED_CONSTRAINTS: ReadonlySet<string> = new Set([
  'additionalProperties',
  'patternProperties',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'deprecated',
  'examples',
  '$schema',
  '$id',
  '$comment',
  'if',
  'then',
  'else',
])

/** `enum` / `const` hint text shared with the sibling Gemini cleaner. */
function allowedHint(values: readonly string[]): string {
  return `Allowed: ${values.join(', ')}`
}

/** True when the value is a non-empty array of strings. */
function isStringEnum(value: unknown): value is readonly string[] {
  if (!Array.isArray(value) || value.length === 0) return false
  return value.every((entry) => typeof entry === 'string')
}

/** The string-enum values of an `enum` member, or of a string `const`. */
function enumValuesOf(key: string, value: unknown): readonly string[] | undefined {
  if (key === 'enum') return isStringEnum(value) ? value : undefined
  if (key === 'const') return typeof value === 'string' ? [value] : undefined
  return undefined
}

/** One edit the object rebuild applies to a member. */
type MemberEdit =
  | { readonly kind: 'drop' }
  | { readonly kind: 'replace'; readonly replacement: string }
  | { readonly kind: 'inline'; readonly members: string }
  | { readonly kind: 'recurse' }

/** Edits of one schema object, plus the members appended to it. */
interface ObjectPlan {
  readonly edits: ReadonlyMap<string, MemberEdit>
  readonly appends: ReadonlyArray<{ readonly key: string; readonly value: string }>
  readonly changed: boolean
}

/**
 * Decides the edits for one schema object from its parsed members. A
 * member is dropped, replaced, inlined or recursed into - never two of
 * those - so the byte-level edits never overlap.
 */
function planObject(record: Record<string, unknown>): ObjectPlan {
  const edits = new Map<string, MemberEdit>()
  const appends: Array<{ key: string; value: string }> = []
  let changed = false

  let enumKey: string | undefined
  for (const key of Object.keys(record)) {
    if (DROPPED_MEMBERS.has(key)) {
      edits.set(key, { kind: 'drop' })
      changed = true
      continue
    }
    if (UNSUPPORTED_CONSTRAINTS.has(key)) {
      edits.set(key, { kind: 'drop' })
      appends.push({ key: 'description', value: `${key}: ${serializeOrdered(record[key] as WireValue)}` })
      changed = true
      continue
    }
    const values = enumValuesOf(key, record[key])
    if (values !== undefined) {
      enumKey = key
      const hint = serializeOrdered('description') + ':' + serializeOrdered(allowedHint(values))
      edits.set(key, { kind: 'replace', replacement: serializeOrdered(values) + ',' + hint })
      changed = true
      continue
    }
    if (key === 'anyOf' || key === 'oneOf') {
      const value = record[key]
      if (Array.isArray(value) && value.length === 1 && isPlainObject(value[0])) {
        edits.set(key, { kind: 'inline', members: compactMemberList(value[0]) })
        changed = true
        continue
      }
    }
  }

  if (enumKey !== undefined) {
    const type = record['type']
    if (type === undefined) {
      appends.push({ key: 'type', value: serializeOrdered('string') })
      changed = true
    } else if (typeof type !== 'string' || type !== 'string') {
      edits.set('type', { kind: 'replace', replacement: serializeOrdered('string') })
      changed = true
    }
  }
  if (record['type'] === 'array' && record['items'] === undefined) {
    appends.push({ key: 'items', value: '{}' })
    changed = true
  }
  return { edits, appends, changed }
}

/** Member list of a parsed object serialized compactly (no braces). */
function compactMemberList(record: Record<string, unknown>): string {
  const text = serializeOrderedCapped(record)
  const scan = scanRawObject(text, 0)
  if (scan === undefined) return ''
  const parts: string[] = []
  for (let i = 0; i < scan.members.length; i++) {
    const member = scan.members[i]
    if (member === undefined) continue
    parts.push(text.slice(member.keyStart, member.valueEnd))
  }
  return parts.join(',')
}

/**
 * Cleans one raw schema document for `parametersJsonSchema`. Untouched
 * subtrees keep their original bytes; when an edit applies, only the
 * edited members change (gateway-written pieces serialize compactly) and
 * everything around them survives verbatim. The recorded matrix pins the
 * no-op passthrough and the enum hint; the remaining rewrite shapes are
 * specified behavior without golden coverage (spec 7.7).
 */
export function cleanGeminiSchema(rawSchema: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawSchema)
  } catch {
    return rawSchema
  }
  return cleanNode(rawSchema, parsed, parsed)
}

/** Recursive node cleaner; returns the (possibly identical) node text. */
function cleanNode(rawText: string, parsed: unknown, root: unknown): string {
  if (Array.isArray(parsed)) return cleanArrayNode(rawText, parsed, root)
  if (isPlainObject(parsed)) return cleanObjectNode(rawText, parsed, root)
  return rawText
}

/** True for a node whose only member is a string `$ref`. */
function isBareRef(record: Record<string, unknown>): boolean {
  const keys = Object.keys(record)
  if (keys.length !== 1 || keys[0] !== '$ref') return false
  return typeof record['$ref'] === 'string'
}

/**
 * Resolves a `#/a/b` pointer inside the ROOT schema document and cleans
 * the target node. Pointers that escape the document (or use a form the
 * wire never carries) leave the member as sent.
 */
function resolveBareRef(rawText: string, pointer: string, root: unknown): string | undefined {
  if (!pointer.startsWith('#/')) return undefined
  const segments = pointer.slice(2).split('/').map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'))
  const rootText = textOfRoot(rawText, root)
  let node: unknown = root
  for (const segment of segments) {
    if (Array.isArray(node)) {
      const index = Number(segment)
      if (!Number.isInteger(index) || index < 0) return undefined
      node = node[index]
      continue
    }
    if (!isPlainObject(node)) return undefined
    node = node[segment]
  }
  if (node === undefined) return undefined
  const rawNode = rawValueAt(rootText, segments)
  if (rawNode === undefined) return undefined
  return cleanNode(rawNode, node, root)
}

/** Serialized form of the root document (the scanner needs its text). */
function textOfRoot(rawText: string, root: unknown): string {
  if (isPlainObject(root) || Array.isArray(root)) {
    try {
      return serializeOrdered(root as WireValue)
    } catch {
      return rawText
    }
  }
  return rawText
}

/** Cleans an array node, preserving raw element bytes when unchanged. */
function cleanArrayNode(rawText: string, parsed: readonly unknown[], root: unknown): string {
  const open = skipWsIndex(rawText, 0)
  if (rawText[open] !== '[') return rawText
  let changed = false
  const parts: string[] = []
  let cursor = open + 1
  let first = true
  for (let index = 0; index < parsed.length; index++) {
    const valueStart = skipWsIndex(rawText, cursor)
    const valueEnd = scanValueEnd(rawText, valueStart)
    const elementText = rawText.slice(valueStart, valueEnd)
    const cleaned = cleanNode(elementText, parsed[index], root)
    if (cleaned !== elementText) changed = true
    const separator = first ? rawText.slice(open + 1, valueStart) : rawText.slice(cursor, valueStart)
    parts.push(separator, cleaned)
    first = false
    cursor = valueEnd
  }
  if (!changed) return rawText
  const close = scanValueEnd(rawText, open)
  const suffix = rawText.slice(cursor, close - 1)
  return '[' + parts.join('') + suffix + ']'
}

/** Cleans an object node, preserving raw member bytes when unchanged. */
function cleanObjectNode(rawText: string, record: Record<string, unknown>, root: unknown): string {
  const open = skipWsIndex(rawText, 0)
  if (rawText[open] !== '{') return rawText
  if (isBareRef(record)) {
    const resolved = resolveBareRef(rawText, record['$ref'] as string, root)
    if (resolved !== undefined) return resolved
  }
  const scan = scanRawObject(rawText, open)
  if (scan === undefined) return rawText
  const plan = planObject(record)

  // Nothing planned and no nested rewrite: the object keeps its bytes.
  if (!plan.changed) {
    let nestedChanged = false
    for (const member of scan.members) {
      const value = record[member.key]
      if (value === null || typeof value !== 'object') continue
      const memberText = rawText.slice(member.valueStart, member.valueEnd)
      if (cleanNode(memberText, value, root) !== memberText) {
        nestedChanged = true
        break
      }
    }
    if (!nestedChanged) return rawText
  }

  // Rebuild: kept members keep their bytes and separators; edits land in
  // place; appended members join before the closing brace.
  const pieces: string[] = []
  let previousEnd: number | undefined
  let kept = 0
  for (const member of scan.members) {
    const edit = plan.edits.get(member.key)
    const value = record[member.key]
    if (edit !== undefined && edit.kind === 'drop') continue
    const separator = separatorTo(rawText, previousEnd, member, scan, kept === 0)
    if (edit !== undefined && edit.kind === 'replace') {
      pieces.push(separator, rawText.slice(member.keyStart, member.valueStart), edit.replacement)
    } else if (edit !== undefined && edit.kind === 'inline') {
      pieces.push(separator, edit.members)
    } else if (value !== null && typeof value === 'object') {
      const cleaned = cleanNode(rawText.slice(member.valueStart, member.valueEnd), value, root)
      pieces.push(separator, rawText.slice(member.keyStart, member.valueStart), cleaned)
    } else {
      pieces.push(separator, rawText.slice(member.keyStart, member.valueEnd))
    }
    previousEnd = member.valueEnd
    kept += 1
  }
  let out = '{' + pieces.join('')
  for (const append of plan.appends) {
    if (append.key === 'description' && record['description'] !== undefined) {
      out = replaceDescriptionMember(out, foldHint(record['description'], append.value))
      continue
    }
    out += (kept > 0 ? ',' : '') + serializeOrdered(append.key) + ':' + append.value
  }
  return out + '}'
}

/** Separator between the previous kept member and the member at hand. */
function separatorTo(
  rawText: string,
  previousEnd: number | undefined,
  member: { readonly keyStart: number },
  scan: RawObjectScan,
  isFirstKept: boolean,
): string {
  if (previousEnd === undefined) {
    const prefix = rawText.slice(scan.start + 1, member.keyStart)
    // Dropped leading members leave their bytes and commas behind; keep
    // only the whitespace after the last separator.
    return prefix.slice(prefix.lastIndexOf(',') + 1)
  }
  return rawText.slice(previousEnd, member.keyStart)
}

/** Folds an unsupported-constraint hint into a description string value. */
function foldHint(existing: unknown, hint: string): string {
  const base = typeof existing === 'string' ? existing : ''
  return serializeOrdered(base.length > 0 ? `${base} ${hint}` : hint)
}

/** Replaces (or appends) the description member of a rebuilt object text. */
function replaceDescriptionMember(objectText: string, value: string): string {
  const scan = scanRawObject(objectText, 0)
  if (scan === undefined) return objectText
  const member = scan.members.find((entry) => entry.key === 'description')
  if (member !== undefined) {
    return objectText.slice(0, member.valueStart) + value + objectText.slice(member.valueEnd)
  }
  const last = scan.members[scan.members.length - 1]
  const insertAt = last !== undefined ? last.valueEnd : scan.end - 1
  return (
    objectText.slice(0, insertAt) +
    (last !== undefined ? ',' : '') +
    serializeOrdered('description') +
    ':' +
    value +
    objectText.slice(insertAt)
  )
}

// -- tiny raw-text scanners (local; the shared ones live in json.ts) ------

function skipWsIndex(text: string, index: number): number {
  let i = index
  while (i < text.length) {
    const code = text.charCodeAt(i)
    if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) i++
    else break
  }
  return i
}

function scanValueEnd(text: string, index: number): number {
  const start = skipWsIndex(text, index)
  const code = text[start]
  if (code === undefined) return start
  if (code === '{' || code === '[') return scanContainerEnd(text, start, code)
  if (code === '"') return scanStringEnd(text, start)
  let i = start
  while (i < text.length) {
    const current = text[i]
    if (current === ',' || current === '}' || current === ']' || current === ' ' || current === '\n' || current === '\r' || current === '\t') break
    i++
  }
  return i
}

function scanContainerEnd(text: string, start: number, open: string): number {
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let i = start
  while (i < text.length) {
    const current = text[i]
    if (current === '"') {
      i = scanStringEnd(text, i)
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

function scanStringEnd(text: string, index: number): number {
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

// ---------------------------------------------------------------------------
// tools -> functionDeclarations (+ googleSearch / codeExecution / urlContext)
// ---------------------------------------------------------------------------

/** Default declaration schema when the client tool carries no parameters. */
export const DEFAULT_PARAMETERS_JSON_SCHEMA = '{"type":"object","properties":{}}'

/**
 * Builds the upstream `tools` array (spec 3.1.2): ONE `functionDeclarations`
 * node first (when any function tool exists), then one `{googleSearch}` node
 * per `google_search` entry, then `codeExecution` and `urlContext` nodes in
 * the same grouping. `parametersJsonSchema` keeps the client schema's raw
 * bytes after cleaning; `strict` never reaches the wire (only
 * name/description/parametersJsonSchema do).
 */
export function buildGeminiTools(tools: readonly unknown[], rawBody: string): WireValue[] | undefined {
  const declarations: WireValue[] = []
  const extras: Array<'googleSearch' | 'codeExecution' | 'urlContext'> = []
  for (let index = 0; index < tools.length; index++) {
    const entry = tools[index]
    if (entry === undefined || !isPlainObject(entry)) continue
    if (entry['google_search'] !== undefined) {
      extras.push('googleSearch')
      continue
    }
    if (entry['code_execution'] !== undefined) {
      extras.push('codeExecution')
      continue
    }
    if (entry['url_context'] !== undefined) {
      extras.push('urlContext')
      continue
    }
    if (entry['type'] !== 'function' || !isPlainObject(entry['function'])) continue
    const declaration = buildDeclaration(entry['function'] as Record<string, unknown>, [
      'tools',
      String(index),
      'function',
    ], rawBody)
    if (declaration !== undefined) declarations.push(declaration)
  }
  const nodes: WireValue[] = []
  if (declarations.length > 0) nodes.push({ functionDeclarations: declarations as WireValue })
  for (const kind of extras) {
    if (kind === 'googleSearch') nodes.push({ googleSearch: {} })
    else if (kind === 'codeExecution') nodes.push({ codeExecution: {} })
    else nodes.push({ urlContext: {} })
  }
  return nodes.length > 0 ? nodes : undefined
}

/**
 * Builds one function declaration from the client's `tools[i].function`
 * raw object: kept members keep their ORIGINAL bytes (key spellings,
 * spacing, value formatting - the name VALUE is replaced by the sanitized
 * name, written compactly), the `parameters`/`strict` members are dropped,
 * and `"parametersJsonSchema":<cleaned schema>` appends compactly at the
 * end (fixtures C03/C04/C12 pin the shape). A function object without a
 * raw span falls back to the compact ordered build.
 */
function buildDeclaration(
  fn: Record<string, unknown>,
  path: readonly string[],
  rawBody: string,
): WireValue | undefined {
  const name = sanitizedOrEmpty(readString(fn, 'name') ?? '')
  if (name.length === 0) return undefined
  const parameters = fn['parameters']
  const rawParameters = isPlainObject(parameters) ? rawValueAt(rawBody, [...path, 'parameters']) : undefined
  const schemaText = rawParameters !== undefined ? cleanGeminiSchema(rawParameters) : DEFAULT_PARAMETERS_JSON_SCHEMA

  const rawFunction = rawValueAt(rawBody, path)
  const scan = rawFunction !== undefined ? scanRawObject(rawFunction, 0) : undefined
  if (scan === undefined || rawFunction === undefined) {
    // Compact fallback: name, description?, parametersJsonSchema.
    const declaration: WireObject = { name }
    const description = readString(fn, 'description')
    if (description !== undefined) declaration['description'] = description
    declaration['parametersJsonSchema'] = new RawJson(schemaText) as unknown as WireValue
    return declaration
  }

  let out = '{'
  let first = true
  let nameSeen = false
  for (const member of scan.members) {
    if (member.key === 'parameters' || member.key === 'strict' || member.key === 'parametersJsonSchema') continue
    if (member.key === 'name') {
      nameSeen = true
      if (!first) out += rawFunction.slice(member.sepStart, member.keyStart)
      out += rawFunction.slice(member.keyStart, member.valueStart) + serializeOrdered(name)
      first = false
      continue
    }
    if (!first) out += rawFunction.slice(member.sepStart, member.keyStart)
    out += rawFunction.slice(member.keyStart, member.valueEnd)
    first = false
  }
  if (!nameSeen) {
    if (!first) out += ','
    out += serializeOrdered('name') + ':' + serializeOrdered(name)
    first = false
  }
  out += (first ? '' : ',') + serializeOrdered('parametersJsonSchema') + ':' + schemaText
  out += '}'
  return new RawJson(out)
}
