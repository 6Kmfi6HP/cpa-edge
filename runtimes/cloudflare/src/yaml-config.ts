/**
 * Config-text parsing for the Workers runtime bootstrap (R5).
 *
 * Scope: the block-style YAML subset the reference `config.yaml`
 * language uses - nested mappings, block sequences of scalars or
 * mappings, quoted and plain scalars, comments and blank lines. This
 * mirrors the shapes every recorded config uses (S6/S7 fixtures) and
 * the same scalar resolution rules (YAML core schema: booleans, null,
 * integers, floats, strings).
 *
 * Everything outside the subset fails loudly at boot with a clear
 * error: flow collections (`[...]`, `{...}`), anchors and aliases,
 * block scalars (`|`/`>`) and tab indentation. A deployment whose
 * config needs those shapes must edit it into block style first (the
 * management facade's own writer always emits block style).
 *
 * The management facade parses its own copy with its gated parser;
 * this module exists because that parser is not part of the package's
 * exported surface. Should it ever be exported, this module can be
 * replaced by that import without any other change.
 */

/** One significant line: content with its indentation. */
interface Line {
  readonly indent: number
  readonly content: string
  readonly number: number
}

/** Error thrown on any input outside the supported subset. */
export class ConfigTextError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigTextError'
  }
}

function significantLines(text: string): Line[] {
  const out: Line[] = []
  const split = text.split('\n')
  for (let index = 0; index < split.length; index++) {
    const raw = split[index]
    if (raw === undefined) continue
    const line = index + 1
    if (raw.includes('\t')) {
      throw new ConfigTextError(`config line ${line}: tab indentation is not supported`)
    }
    let indent = 0
    while (indent < raw.length && raw.charAt(indent) === ' ') indent += 1
    const body = raw.slice(indent)
    const stripped = stripComment(body)
    if (stripped.trim().length === 0) continue
    if (stripped.trim() === '---' || stripped.trim() === '...') {
      throw new ConfigTextError(`config line ${line}: multi-document markers are not supported`)
    }
    out.push({ indent, content: stripped.trimEnd(), number: line })
  }
  return out
}

/** Removes a trailing comment that is not inside quotes. */
function stripComment(content: string): string {
  let inSingle = false
  let inDouble = false
  for (let index = 0; index < content.length; index++) {
    const ch = content.charAt(index)
    if (ch === "'" && !inDouble) inSingle = !inSingle
    else if (ch === '"' && !inSingle) inDouble = !inDouble
    else if (ch === '#' && !inSingle && !inDouble) {
      // A hash only starts a comment at the beginning or after a space.
      if (index === 0 || content.charAt(index - 1) === ' ' || content.charAt(index - 1) === '\t') {
        return content.slice(0, index)
      }
    }
  }
  return content
}

/** Splits `key: value` outside quotes; the value may be empty. */
function splitEntry(content: string, line: number): { readonly key: string; readonly rest: string } {
  if (content.startsWith('"') || content.startsWith("'")) {
    const quote = content.charAt(0)
    const end = content.indexOf(quote, 1)
    if (end > 0) {
      const key = content.slice(1, end)
      const after = content.slice(end + 1)
      if (after.startsWith(':')) return { key, rest: after.slice(1).trim() }
      throw new ConfigTextError(`config line ${line}: quoted key without a colon`)
    }
    throw new ConfigTextError(`config line ${line}: unterminated quoted key`)
  }
  for (let index = 0; index < content.length; index++) {
    if (content.charAt(index) !== ':') continue
    const next = content.charAt(index + 1)
    if (next === ' ' || index === content.length - 1) {
      const key = content.slice(0, index).trim()
      if (key.length === 0) throw new ConfigTextError(`config line ${line}: empty mapping key`)
      return { key, rest: content.slice(index + 1).trim() }
    }
  }
  throw new ConfigTextError(`config line ${line}: could not find ':' in mapping entry`)
}

/** Resolves one scalar the way the YAML core schema does. */
function resolveScalar(text: string, line: number): string | number | boolean | null {
  const trimmed = text.trim()
  if (trimmed.length === 0) return null
  if (trimmed.startsWith('&') || trimmed.startsWith('*')) {
    throw new ConfigTextError(`config line ${line}: anchors and aliases are not supported`)
  }
  if (trimmed === '|' || trimmed === '>' || trimmed.startsWith('|') || trimmed.startsWith('>')) {
    throw new ConfigTextError(`config line ${line}: block scalars are not supported`)
  }
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    throw new ConfigTextError(`config line ${line}: flow collections are not supported`)
  }
  if (trimmed.startsWith('"')) {
    if (!trimmed.endsWith('"') || trimmed.length < 2) {
      throw new ConfigTextError(`config line ${line}: unterminated double-quoted scalar`)
    }
    return unescapeDouble(trimmed.slice(1, -1))
  }
  if (trimmed.startsWith("'")) {
    if (!trimmed.endsWith("'") || trimmed.length < 2) {
      throw new ConfigTextError(`config line ${line}: unterminated single-quoted scalar`)
    }
    return trimmed.slice(1, -1).replaceAll("''", "'")
  }
  if (trimmed === '~' || trimmed === 'null' || trimmed === 'Null' || trimmed === 'NULL') return null
  if (trimmed === 'true' || trimmed === 'True' || trimmed === 'TRUE') return true
  if (trimmed === 'false' || trimmed === 'False' || trimmed === 'FALSE') return false
  if (/^-?\d+$/.test(trimmed)) {
    const parsed = Number(trimmed)
    if (Number.isSafeInteger(parsed)) return parsed
  }
  if (/^-?(\d+\.\d*|\.\d+)([eE][-+]?\d+)?$/.test(trimmed) || /^-?\d+[eE][-+]?\d+$/.test(trimmed)) {
    return Number(trimmed)
  }
  return trimmed
}

function unescapeDouble(text: string): string {
  let out = ''
  for (let index = 0; index < text.length; index++) {
    const ch = text.charAt(index)
    if (ch !== '\\' || index + 1 >= text.length) {
      out += ch
      continue
    }
    index += 1
    const escaped = text.charAt(index)
    out +=
      escaped === 'n' ? '\n'
      : escaped === 't' ? '\t'
      : escaped === 'r' ? '\r'
      : escaped === '"' ? '"'
      : escaped === '\\' ? '\\'
      : escaped
  }
  return out
}

/** True when a sequence-item remainder looks like a mapping entry. */
function looksLikeEntry(text: string): boolean {
  if (text.startsWith('"') || text.startsWith("'")) {
    const quote = text.charAt(0)
    const end = text.indexOf(quote, 1)
    if (end > 0) return text.charAt(end + 1) === ':'
    return false
  }
  for (let index = 0; index < text.length; index++) {
    if (text.charAt(index) !== ':') continue
    const next = text.charAt(index + 1)
    if (next === ' ' || index === text.length - 1) return index > 0
  }
  return false
}

/** Parses a block (mapping or sequence) starting at `start`, indented `indent`. */
function parseBlock(lines: readonly Line[], start: number, indent: number): { readonly value: unknown; readonly next: number } {
  const first = lines[start]
  if (first === undefined) return { value: null, next: start }
  if (first.content === '-' || first.content.startsWith('- ')) {
    return parseSequence(lines, start, indent)
  }
  return parseMapping(lines, start, indent)
}

function parseMapping(lines: readonly Line[], start: number, indent: number): { readonly value: Record<string, unknown>; readonly next: number } {
  const result: Record<string, unknown> = {}
  let index = start
  while (index < lines.length) {
    const line = lines[index]
    if (line === undefined) break
    if (line.indent < indent) break
    if (line.indent > indent) {
      throw new ConfigTextError(`config line ${line.number}: unexpected indentation`)
    }
    if (line.content === '-' || line.content.startsWith('- ')) {
      throw new ConfigTextError(`config line ${line.number}: sequence item inside a mapping`)
    }
    const { key, rest } = splitEntry(line.content, line.number)
    if (rest.length === 0) {
      const nextLine = lines[index + 1]
      if (nextLine !== undefined && nextLine.indent > indent) {
        const nested = parseBlock(lines, index + 1, nextLine.indent)
        result[key] = nested.value
        index = nested.next
      } else {
        result[key] = null
        index += 1
      }
      continue
    }
    const scalar = resolveScalar(rest, line.number)
    if (typeof scalar === 'string' || typeof scalar === 'number' || typeof scalar === 'boolean' || scalar === null) {
      result[key] = scalar
      index += 1
    }
  }
  return { value: result, next: index }
}

function parseSequence(lines: readonly Line[], start: number, indent: number): { readonly value: unknown[]; readonly next: number } {
  const items: unknown[] = []
  let index = start
  while (index < lines.length) {
    const line = lines[index]
    if (line === undefined) break
    if (line.indent < indent) break
    if (line.indent > indent) {
      throw new ConfigTextError(`config line ${line.number}: unexpected indentation`)
    }
    if (line.content !== '-' && !line.content.startsWith('- ')) break
    if (line.content === '-') {
      const nextLine = lines[index + 1]
      if (nextLine !== undefined && nextLine.indent > indent) {
        const nested = parseBlock(lines, index + 1, nextLine.indent)
        items.push(nested.value)
        index = nested.next
      } else {
        items.push(null)
        index += 1
      }
      continue
    }
    const rest = line.content.slice(2).trim()
    if (looksLikeEntry(rest)) {
      // A mapping item: its inline first entry plus the deeper lines
      // that follow form one mapping block.
      const virtual: Line = { indent: indent + 2, content: rest, number: line.number }
      const slice: Line[] = [virtual]
      let scan = index + 1
      while (scan < lines.length) {
        const candidate = lines[scan]
        if (candidate === undefined) break
        if (candidate.indent <= indent) break
        slice.push(candidate)
        scan += 1
      }
      const mapping = parseMapping(slice, 0, indent + 2)
      items.push(mapping.value)
      index += 1 + mapping.next
      continue
    }
    items.push(resolveScalar(rest, line.number))
    index += 1
  }
  return { value: items, next: index }
}

/**
 * Parses a whole config document. An empty text parses to an empty
 * mapping (the open gateway); a top-level sequence or scalar is a
 * config error.
 */
export function parseConfigText(text: string): Readonly<Record<string, unknown>> {
  const lines = significantLines(text)
  if (lines.length === 0) return {}
  const first = lines[0]
  if (first !== undefined && first.indent !== 0) {
    throw new ConfigTextError(`config line ${first.number}: the document must start at indentation 0`)
  }
  const parsed = parseBlock(lines, 0, 0)
  const value = parsed.value
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConfigTextError('config: the document root must be a mapping')
  }
  return value as Readonly<Record<string, unknown>>
}
