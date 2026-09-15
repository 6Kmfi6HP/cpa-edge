/**
 * YAML subset used by the config-file state layer.
 *
 * The reference config.yaml dialect is a narrow one: block mappings, block
 * sequences (dash items with inline first keys), plain/quoted scalars and
 * `#` comments. This module covers exactly that, with two jobs:
 *
 * - read: parse bytes into plain JSON values, failing with go-yaml-shaped
 *   error strings (`yaml: did not find expected key`,
 *   `yaml: line <n>: did not find expected node content`) so the recorded
 *   `invalid_yaml` ladder replays;
 * - write: surgical edits on the ORIGINAL line array (scalar replacement,
 *   block removal, block append) so every untouched byte - comments, key
 *   order, quoting, indentation - survives persistence unchanged.
 */

import type { JsonValue } from '@cpa-edge/core'

export class YamlError extends Error {}

/** One physical line of the source document. */
interface DocLine {
  readonly indent: number
  readonly content: string
  readonly blank: boolean
  readonly comment: boolean
}

/** A mapping entry with the source line index of its key. */
interface MapEntry {
  readonly key: string
  readonly keyLine: number
  readonly value: BlockNode
}

/** Parsed block node keeping source coordinates for surgical edits. */
export type BlockNode =
  | { readonly kind: 'scalar'; readonly raw: string; readonly value: JsonValue; readonly line: number }
  | { readonly kind: 'mapping'; readonly entries: readonly MapEntry[] }
  | { readonly kind: 'sequence'; readonly items: readonly BlockNode[] }

function splitLines(text: string): DocLine[] {
  const rawLines = text.split('\n')
  const out: DocLine[] = []
  for (const raw of rawLines) {
    const withoutTabs = raw.replace(/\t/g, '  ')
    const indentMatch = /^ */.exec(withoutTabs)
    const indent = indentMatch === null ? 0 : indentMatch[0].length
    const content = withoutTabs.slice(indent)
    const blank = content.trim().length === 0
    const comment = content.trimStart().startsWith('#')
    out.push({ indent, content, blank, comment })
  }
  return out
}

/** Resolves a plain (unquoted) scalar the way go-yaml v3 does. */
function resolvePlain(text: string): JsonValue {
  const trimmed = text.trim()
  if (trimmed === '' || trimmed === '~' || trimmed === 'null' || trimmed === 'Null' || trimmed === 'NULL') return null
  if (trimmed === 'true' || trimmed === 'True' || trimmed === 'TRUE') return true
  if (trimmed === 'false' || trimmed === 'False' || trimmed === 'FALSE') return false
  if (/^-?\d+$/.test(trimmed)) {
    const n = Number(trimmed)
    if (Number.isSafeInteger(n)) return n
  }
  if (/^-?(\d+\.\d*|\.\d+)([eE][-+]?\d+)?$/.test(trimmed) || /^-?\d+[eE][-+]?\d+$/.test(trimmed)) {
    return Number(trimmed)
  }
  return trimmed
}

/** Unquotes a scalar literal if quoted; resolves it otherwise. */
function parseScalarLiteral(text: string, line: number): BlockNode {
  const trimmed = text.trim()
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    const inner = trimmed.slice(1, -1)
    let out = ''
    for (let i = 0; i < inner.length; i += 1) {
      const ch = inner[i] ?? ''
      if (ch === '\\' && i + 1 < inner.length) {
        const next = inner[i + 1] ?? ''
        if (next === 'n') out += '\n'
        else if (next === 't') out += '\t'
        else if (next === 'r') out += '\r'
        else if (next === '\\') out += '\\'
        else if (next === '"') out += '"'
        else out += next
        i += 1
        continue
      }
      out += ch
    }
    return { kind: 'scalar', raw: trimmed, value: out, line }
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    const inner = trimmed.slice(1, -1).replaceAll("''", "'")
    return { kind: 'scalar', raw: trimmed, value: inner, line }
  }
  return { kind: 'scalar', raw: trimmed, value: resolvePlain(trimmed), line }
}

/** True when the line opens a flow collection we do not accept. */
function isUnsupportedFlow(text: string): boolean {
  const trimmed = text.trim()
  return trimmed.startsWith('{') || trimmed.startsWith('[')
}

interface ParseState {
  readonly lines: readonly DocLine[]
  index: number
}

function skipIgnorable(state: ParseState, indent: number): void {
  while (state.index < state.lines.length) {
    const line = state.lines[state.index]
    if (line === undefined) break
    if (line.blank || line.comment) {
      state.index += 1
      continue
    }
    if (line.indent < indent) break
    break
  }
}

function nextContentLine(state: ParseState, indent: number): DocLine | undefined {
  while (state.index < state.lines.length) {
    const line = state.lines[state.index]
    if (line === undefined) return undefined
    if (line.blank || line.comment) {
      state.index += 1
      continue
    }
    if (line.indent < indent) return undefined
    return line
  }
  return undefined
}

/**
 * Parses the value part written on the same line as a key. Returns the
 * remainder marker: '' means the full value was inline.
 */
function parseInlineValue(text: string, line: number): { readonly node: BlockNode; readonly empty: boolean } {
  const trimmed = text.trim()
  if (trimmed === '') return { node: { kind: 'scalar', raw: '', value: null, line }, empty: true }
  return { node: parseScalarLiteral(trimmed, line), empty: false }
}

/** Splits `key: value` honoring quoted keys. */
function splitKey(content: string): { readonly key: string; readonly rest: string } | undefined {
  if (content.startsWith('"')) {
    const end = content.indexOf('"', 1)
    if (end > 0) {
      const key = content.slice(1, end)
      const after = content.slice(end + 1)
      if (after.startsWith(':')) {
        return { key, rest: after.slice(1) }
      }
    }
  }
  if (content.startsWith("'")) {
    const end = content.indexOf("'", 1)
    if (end > 0) {
      const key = content.slice(1, end)
      const after = content.slice(end + 1)
      if (after.startsWith(':')) {
        return { key, rest: after.slice(1) }
      }
    }
  }
  const colon = content.indexOf(': ')
  const trailing = content.length > 0 && content.trimEnd().endsWith(':')
  if (colon > 0) {
    const key = content.slice(0, colon).trim()
    if (key.length === 0) return undefined
    return { key, rest: content.slice(colon + 1) }
  }
  if (trailing) {
    const key = content.trimEnd().slice(0, -1).trim()
    if (key.length === 0) return undefined
    return { key, rest: '' }
  }
  return undefined
}

/**
 * Parses one block (mapping or sequence) starting at `indent`. Sequence
 * items may open with an inline key (`- name: x`) whose mapping continues on
 * deeper-indented lines, mirroring the reference config style.
 */
function parseBlock(state: ParseState, indent: number): BlockNode {
  const first = nextContentLine(state, indent)
  if (first === undefined) return { kind: 'mapping', entries: [] }
  if (first.indent > indent) return parseBlock(state, first.indent)
  if (first.content.startsWith('- ') || first.content === '-') {
    return parseSequence(state, first.indent)
  }
  return parseMapping(state, first.indent)
}

function parseSequence(state: ParseState, indent: number): BlockNode {
  const items: BlockNode[] = []
  for (;;) {
    const line = nextContentLine(state, indent)
    if (line === undefined || line.indent < indent) break
    if (line.indent > indent) {
      // Unexpected deeper content: reject the way go-yaml reports stray flow input.
      if (isUnsupportedFlow(line.content)) {
        throw new YamlError(`yaml: line ${state.index - 1}: did not find expected node content`)
      }
      break
    }
    if (!line.content.startsWith('- ') && line.content !== '-') {
      if (isUnsupportedFlow(line.content)) {
        throw new YamlError(`yaml: line ${state.index - 1}: did not find expected node content`)
      }
      break
    }
    const rest = line.content === '-' ? '' : line.content.slice(2)
    const markerIndent = indent + 2
    state.index += 1
    const inline = splitKey(rest)
    if (inline === undefined) {
      if (isUnsupportedFlow(rest)) {
        throw new YamlError(`yaml: line ${state.index - 1}: did not find expected node content`)
      }
      const parsed = parseInlineValue(rest, state.index - 1)
      if (parsed.empty) {
        const nested = nextContentLine(state, markerIndent)
        if (nested !== undefined && nested.indent >= markerIndent) {
          items.push(parseBlock(state, nested.indent))
        } else {
          items.push(parsed.node)
        }
      } else {
        items.push(parsed.node)
      }
      continue
    }
    // Inline-first-key mapping item: virtual mapping over the continuation.
    const entryLine = state.index - 1
    const firstValue = parseInlineValue(inline.rest, entryLine)
    const entries: MapEntry[] = []
    const valueNode = (): BlockNode => {
      if (!firstValue.empty) return firstValue.node
      const nested = nextContentLine(state, markerIndent)
      if (nested !== undefined && nested.indent >= markerIndent && !nested.content.startsWith('- ')) {
        return parseBlock(state, nested.indent)
      }
      if (nested !== undefined && nested.indent >= markerIndent) {
        return parseSequence(state, nested.indent)
      }
      return firstValue.node
    }
    entries.push({ key: inline.key, keyLine: entryLine, value: valueNode() })
    // Continuation entries of the same item sit deeper than the dash marker.
    for (;;) {
      const next = nextContentLine(state, markerIndent)
      if (next === undefined || next.indent < markerIndent) break
      if (next.indent > markerIndent) break
      const cont = splitKey(next.content)
      if (cont === undefined) {
        if (isUnsupportedFlow(next.content)) {
          throw new YamlError(`yaml: line ${state.index - 1}: did not find expected node content`)
        }
        break
      }
      const keyLine = state.index
      state.index += 1
      const parsed = parseInlineValue(cont.rest, keyLine)
      const entryValue = parsed.empty
        ? parseNestedOrScalar(state, markerIndent, keyLine)
        : parsed.node
      entries.push({ key: cont.key, keyLine, value: entryValue })
    }
    items.push({ kind: 'mapping', entries })
  }
  return { kind: 'sequence', items }
}

function parseNestedOrScalar(state: ParseState, indent: number, line: number): BlockNode {
  const nested = nextContentLine(state, indent + 1)
  if (nested !== undefined && nested.indent > indent) {
    return parseBlock(state, nested.indent)
  }
  if (nested !== undefined && nested.indent === indent && (nested.content.startsWith('- ') || nested.content === '-')) {
    return parseSequence(state, nested.indent)
  }
  return { kind: 'scalar', raw: '', value: null, line }
}

function parseMapping(state: ParseState, indent: number): BlockNode {
  const entries: MapEntry[] = []
  for (;;) {
    const line = nextContentLine(state, indent)
    if (line === undefined || line.indent < indent) break
    if (line.indent > indent) {
      if (isUnsupportedFlow(line.content)) {
        throw new YamlError(`yaml: line ${state.index - 1}: did not find expected node content`)
      }
      throw new YamlError(`yaml: line ${state.index - 1}: mapping values are not allowed in this context`)
    }
    if (line.content.startsWith('- ') || line.content === '-') break
    // A value token without a key (`: :`). go-yaml reports this without a
    // line number; the recorded S5 golden pins those exact bytes.
    if (line.content.startsWith(':')) {
      throw new YamlError('yaml: did not find expected key')
    }
    const split = splitKey(line.content)
    if (split === undefined) {
      if (isUnsupportedFlow(line.content)) {
        throw new YamlError(`yaml: line ${state.index - 1}: did not find expected node content`)
      }
      throw new YamlError(`yaml: line ${state.index - 1}: could not find expected ':'`)
    }
    const keyLine = state.index
    state.index += 1
    const parsed = parseInlineValue(split.rest, keyLine)
    const value = parsed.empty ? parseNestedOrScalar(state, indent, keyLine) : parsed.node
    entries.push({ key: split.key, keyLine, value })
  }
  return { kind: 'mapping', entries }
}

/** Parses a config document; throws {@link YamlError} with go-yaml wording. */
export function parseYamlDoc(text: string): BlockNode {
  const state: ParseState = { lines: splitLines(text), index: 0 }
  const first = nextContentLine(state, 0)
  if (first === undefined) return { kind: 'mapping', entries: [] }
  state.index = 0
  const node = parseBlock(state, 0)
  // Trailing garbage at root level is an error (e.g. `{{{not yaml`).
  const rest = nextContentLine(state, 0)
  if (rest !== undefined) {
    if (isUnsupportedFlow(rest.content)) {
      throw new YamlError(`yaml: line ${state.index - 1}: did not find expected node content`)
    }
    throw new YamlError('yaml: did not find expected key')
  }
  return node
}

/** Converts a parsed block node into plain JSON values. */
export function blockToValue(node: BlockNode): JsonValue {
  if (node.kind === 'scalar') return node.value
  if (node.kind === 'sequence') return node.items.map((item) => blockToValue(item))
  const record: { [key: string]: JsonValue } = {}
  for (const entry of node.entries) record[entry.key] = blockToValue(entry.value)
  return record
}

/** Parses YAML text straight into JSON values. */
export function parseYamlValue(text: string): JsonValue {
  return blockToValue(parseYamlDoc(text))
}

/** Reads a nested mapping from a parsed block. */
export function mappingEntries(node: BlockNode): readonly MapEntry[] {
  return node.kind === 'mapping' ? node.entries : []
}

// ---------------------------------------------------------------------------
// Surgical line edits (persistence path)
// ---------------------------------------------------------------------------

/** Renders a scalar for YAML output: bare when safe, double-quoted else. */
export function renderScalar(value: JsonValue): string {
  if (value === null) return '""'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return String(value)
  if (typeof value !== 'string') return '""'
  const text: string = value
  if (text === '') return '""'
  if (/^[A-Za-z0-9_./:@+=-][A-Za-z0-9_./:@+= -]*$/.test(text) && !text.includes('  ')) {
    const resolved = resolvePlain(text)
    if (typeof resolved === 'string') return text
  }
  return `"${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

/** One located mapping block: source line of its key plus the indent. */
interface BlockAnchor {
  readonly line: number
  readonly indent: number
}

/**
 * Line-oriented document editor. Every operation rewrites only the lines it
 * must touch; all other bytes are preserved verbatim - comments, key order,
 * quoting styles and blank-line placement survive persistence unchanged.
 */
export class YamlFileEditor {
  private lines: string[]

  constructor(text: string) {
    this.lines = text.split('\n')
  }

  getText(): string {
    return this.lines.join('\n')
  }

  /** Index of the line declaring `key:` at exactly `indent`. */
  private findKeyLine(key: string, indent: number): number | undefined {
    const prefix = ' '.repeat(indent)
    for (let i = 0; i < this.lines.length; i += 1) {
      const line = this.lines[i] ?? ''
      if (!line.startsWith(prefix)) continue
      const content = line.slice(indent)
      if (content.startsWith('- ')) continue
      const split = splitKey(content)
      if (split === undefined) continue
      if (split.key === key) return i
    }
    return undefined
  }

  /** Span (first..last inclusive) of the block owned by the key at `keyLine`. */
  private blockSpan(keyLine: number, indent: number): { first: number; last: number } {
    let last = keyLine
    for (let i = keyLine + 1; i < this.lines.length; i += 1) {
      const line = this.lines[i] ?? ''
      if (line.trim() === '') break
      const lineIndent = /^ */.exec(line)?.[0].length ?? 0
      if (lineIndent <= indent) break
      last = i
    }
    return { first: keyLine, last }
  }

  /** Replaces (or appends) one scalar under the mapping at `path`. */
  setScalar(path: readonly string[], key: string, value: JsonValue): void {
    const anchor = this.locateBlock(path)
    const indent = anchor === undefined ? 0 : anchor.indent + 2
    const existing = anchor === undefined ? this.findKeyLine(key, 0) : this.findKeyLine(key, anchor.indent + 2)
    if (existing !== undefined) {
      const line = this.lines[existing] ?? ''
      const content = line.slice(/^\s*/.exec(line)?.[0].length ?? 0)
      const split = splitKey(content)
      if (split === undefined) return
      const current = split.rest.trim()
      if (current.startsWith('"') && current.endsWith('"') && typeof value === 'string') {
        const escaped = value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
        this.lines[existing] = `${' '.repeat(indent)}${split.key}: "${escaped}"`
        return
      }
      this.lines[existing] = `${' '.repeat(indent)}${split.key}: ${renderScalar(value)}`
      return
    }
    this.insertInto(anchor, [`${' '.repeat(indent)}${key}: ${renderScalar(value)}`])
  }

  /** Replaces (or appends) a nested block such as a sequence list. */
  setBlock(path: readonly string[], key: string, renderedLines: readonly string[]): void {
    const anchor = this.locateBlock(path)
    const indent = anchor === undefined ? 0 : anchor.indent + 2
    const existing = anchor === undefined ? this.findKeyLine(key, 0) : this.findKeyLine(key, anchor.indent + 2)
    const block = renderedLines.map((line) => `${' '.repeat(indent)}${line}`)
    if (existing !== undefined) {
      const span = this.blockSpan(existing, indent)
      this.lines.splice(span.first, span.last - span.first + 1, `${' '.repeat(indent)}${key}:`, ...block)
      return
    }
    this.insertInto(anchor, [`${' '.repeat(indent)}${key}:`, ...block])
  }

  /** Appends rendered lines at the end of the mapping at `path` (created when absent). */
  appendNested(path: readonly string[], renderedLines: readonly string[]): void {
    const anchor = this.locateBlock(path)
    const indent = anchor === undefined ? 0 : anchor.indent + 2
    this.insertInto(anchor, renderedLines.map((line) => `${' '.repeat(indent)}${line}`))
  }

  /** Removes a key and its nested block; no-op when absent. */
  removeKey(path: readonly string[], key: string): void {
    const anchor = this.locateBlock(path)
    const indent = anchor === undefined ? 0 : anchor.indent + 2
    const at = anchor === undefined ? this.findKeyLine(key, 0) : this.findKeyLine(key, indent)
    if (at === undefined) return
    const span = this.blockSpan(at, indent)
    this.lines.splice(span.first, span.last - span.first + 1)
  }

  /**
   * Locates the mapping at `path`, creating missing intermediate blocks.
   * Returns `undefined` for the document root.
   */
  private locateBlock(path: readonly string[]): BlockAnchor | undefined {
    if (path.length === 0) return undefined
    let anchor: BlockAnchor | undefined
    let childIndent = 0
    let insertAfter = this.contentEnd()
    let created = false
    for (const key of path) {
      const at = this.findKeyLine(key, childIndent)
      if (at === undefined) {
        this.lines.splice(insertAfter + 1, 0, `${' '.repeat(childIndent)}${key}:`)
        anchor = { line: insertAfter + 1, indent: childIndent }
        insertAfter = anchor.line
        created = true
      } else {
        anchor = { line: at, indent: childIndent }
        insertAfter = created ? anchor.line : this.blockSpan(at, childIndent).last
      }
      childIndent += 2
    }
    return anchor
  }

  /** Inserts lines at the end of the mapping at `anchor` (document end when absent). */
  private insertInto(anchor: BlockAnchor | undefined, lines: readonly string[]): void {
    if (anchor === undefined) {
      let end = this.lines.length
      while (end > 0 && (this.lines[end - 1] ?? '').trim() === '') end -= 1
      this.lines.splice(end, 0, ...lines)
      return
    }
    const span = this.blockSpan(anchor.line, anchor.indent)
    this.lines.splice(span.last + 1, 0, ...lines)
  }

  private contentEnd(): number {
    let end = this.lines.length
    while (end > 0 && (this.lines[end - 1] ?? '').trim() === '') end -= 1
    return end - 1
  }

  /** Drops every blank (whitespace-only) line - the yaml round-trip artifact. */
  dropBlankLines(): void {
    this.lines = this.lines.filter((line) => line.trim() !== '')
  }

  /** True when the document ends with a newline. */
  endsWithNewline(): boolean {
    return this.lines.length === 0 || (this.lines[this.lines.length - 1] ?? '') === ''
  }

  /** Ensures the document ends with exactly one trailing newline. */
  ensureTrailingNewline(): void {
    while (this.lines.length > 0 && (this.lines[this.lines.length - 1] ?? '') === '') {
      this.lines.pop()
    }
    this.lines.push('')
  }
}

/** Renders a string list as YAML sequence lines (caller adds indentation). */
export function renderSequence(values: readonly string[], quoted: boolean): string[] {
  return values.map((value) => `- ${quoted ? `"${value}"` : renderScalar(value)}`)
}
