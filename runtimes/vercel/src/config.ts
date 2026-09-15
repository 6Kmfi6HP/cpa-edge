/**
 * Serverless config ingestion for the Vercel runtime (S7 F6).
 *
 * There is no filesystem to watch and no config.yaml on disk; the config
 * document arrives from the environment (or, when management mutations
 * persist it, from the KV store) and every invocation rebuilds the
 * runtime from it. External-edit hot reload does not exist as a concept
 * on this platform; management-API writes are the only mutation path and
 * apply on the next invocation (S7 matrix row F6, "management-writes-
 * only").
 *
 * Two formats are accepted:
 *
 * - `CPA_CONFIG_JSON` - the YAML-shaped config document as JSON. This is
 *   the recommended source; it feeds both the gateway (the parsed
 *   record) and the management facade (YAML text re-emitted from it).
 * - `CPA_CONFIG_YAML` - block-style YAML text (the reference
 *   config.yaml dialect: block mappings, block sequences, plain or
 *   quoted scalars). The same dialect is used for KV-persisted config.
 *
 * This module also owns the proxy-url semantics the S7 vercel column
 * needs: mode resolution (own value, else global, else inherit) and the
 * fail-closed exclusion of proxy-credentialed providers from the
 * gateway's scheduling set (NE-S7-01).
 */

import type { JsonValue } from '@cpa-edge/core'

/** Every provider family that carries api-key credentials. */
export const PROVIDER_FAMILIES: readonly string[] = Object.freeze([
  'openai-compatibility',
  'gemini-api-key',
  'claude-api-key',
  'codex-api-key',
  'xai-api-key',
  'meta-api-key',
  'interactions-api-key',
  'vertex-api-key',
])

/** Resolved outbound proxy mode of one credential. */
export type ProxyMode = 'proxy' | 'direct'

/** Result of loading the config sources for one invocation. */
export interface VercelConfigSource {
  /** YAML-shaped config record (the full, unstripped document). */
  readonly record: Readonly<Record<string, unknown>>
  /** YAML text for the management facade (echo + persistence format). */
  readonly yaml: string
  /** Where the document came from; surfaces in boot diagnostics. */
  readonly origin: 'kv' | 'env-json' | 'env-yaml' | 'empty'
}

/** Options of {@link loadConfigSource}. */
export interface LoadConfigSourceOptions {
  /** Environment to read; production passes `process.env`-like records. */
  readonly env: Readonly<Record<string, string | undefined>>
  /** Reads the KV-persisted config document; absent disables the KV source. */
  readonly readKvConfig?: () => Promise<string | undefined>
}

const CONFIG_KV_NAMESPACE = 'config'
const CONFIG_KV_KEY = 'effective'

/**
 * Loads this invocation's config document. Precedence:
 * `CPA_CONFIG_FROM_KV` + a persisted document, then `CPA_CONFIG_JSON`,
 * then `CPA_CONFIG_YAML`, then an empty config.
 */
export async function loadConfigSource(
  options: LoadConfigSourceOptions,
): Promise<VercelConfigSource> {
  if (options.env['CPA_CONFIG_FROM_KV'] === '1' && options.readKvConfig !== undefined) {
    const stored = await options.readKvConfig()
    if (stored !== undefined && stored.length > 0) {
      return { record: parseBlockYaml(stored), yaml: stored, origin: 'kv' }
    }
  }
  const json = options.env['CPA_CONFIG_JSON']
  if (json !== undefined && json.trim().length > 0) {
    const record = parseJsonObjectText(json)
    return { record, yaml: emitBlockYaml(record), origin: 'env-json' }
  }
  const yaml = options.env['CPA_CONFIG_YAML']
  if (yaml !== undefined && yaml.trim().length > 0) {
    return { record: parseBlockYaml(yaml), yaml, origin: 'env-yaml' }
  }
  return { record: {}, yaml: '', origin: 'empty' }
}

/** KV address of the persisted config document (S6 store mapping). */
export function configKvAddress(): { readonly namespace: string; readonly key: string } {
  return { namespace: CONFIG_KV_NAMESPACE, key: CONFIG_KV_KEY }
}

function parseJsonObjectText(text: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`CPA_CONFIG_JSON is not valid JSON: ${String(error)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('CPA_CONFIG_JSON must hold a JSON object')
  }
  return parsed as Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Proxy-url semantics (S7 §2.1-F1 / §2.3-F1)
// ---------------------------------------------------------------------------

const PROXY_SCHEMES: readonly string[] = Object.freeze(['socks5', 'socks5h', 'http', 'https'])

/**
 * Resolves one raw proxy-url string to a mode. Empty means inherit; the
 * runtime treats inherit as direct because environment proxies do not
 * exist here (NE-S7-04). `direct`/`none` (case-insensitive) is direct.
 * A URL with a proxy scheme is proxy mode; anything else - including
 * unparseable values - is direct, mirroring the upstream fall-through
 * on parse failures (no 501 for invalid values, S7 §2.3-F1-5).
 */
export function resolveProxyMode(raw: string): ProxyMode | 'inherit' {
  const value = raw.trim()
  if (value.length === 0) return 'inherit'
  if (value.toLowerCase() === 'direct' || value.toLowerCase() === 'none') return 'direct'
  try {
    const url = new URL(value)
    if (PROXY_SCHEMES.includes(url.protocol.replace(':', '').toLowerCase())) return 'proxy'
    return 'direct'
  } catch {
    return 'direct'
  }
}

/** Reads `proxy-url` off one provider entry record. */
function entryProxyUrl(entry: Readonly<Record<string, unknown>>): string {
  const value = entry['proxy-url']
  return typeof value === 'string' ? value : ''
}

/**
 * Computes the effective mode of one provider entry: own value, else the
 * global config value, else direct.
 */
export function effectiveEntryMode(
  entry: Readonly<Record<string, unknown>>,
  globalProxyUrl: string,
): ProxyMode {
  const own = resolveProxyMode(entryProxyUrl(entry))
  if (own === 'proxy') return 'proxy'
  if (own === 'direct') return 'direct'
  if (globalProxyUrl.length > 0) return resolveProxyMode(globalProxyUrl)
  return 'direct'
}

/** Global `proxy-url` scalar of the config document. */
export function globalProxyUrl(record: Readonly<Record<string, unknown>>): string {
  const value = record['proxy-url']
  return typeof value === 'string' ? value : ''
}

/**
 * Walks the provider sections and reports which entries resolve to
 * proxy mode. Entries are keyed as `<family>[<index>]`, matching the
 * order in which the gateway's config normalizer keeps them, so callers
 * can strip by family + index without re-parsing.
 */
export function proxiedProviderIndexes(
  record: Readonly<Record<string, unknown>>,
): ReadonlyMap<string, ReadonlySet<number>> {
  const global = globalProxyUrl(record)
  const out = new Map<string, ReadonlySet<number>>()
  for (const family of PROVIDER_FAMILIES) {
    const entries = providerEntries(record, family)
    const proxied = new Set<number>()
    entries.forEach((entry, index) => {
      if (effectiveEntryMode(entry, global) === 'proxy') proxied.add(index)
    })
    if (proxied.size > 0) out.set(family, proxied)
  }
  return out
}

/** Provider entries of one family section, in document order. */
function providerEntries(
  record: Readonly<Record<string, unknown>>,
  family: string,
): readonly Readonly<Record<string, unknown>>[] {
  const section = record[family]
  if (Array.isArray(section)) {
    const out: Array<Readonly<Record<string, unknown>>> = []
    for (const item of section) {
      if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
        out.push(item as Readonly<Record<string, unknown>>)
      }
    }
    return out
  }
  return []
}

/**
 * Removes the proxy-credentialed entries from a deep copy of the config
 * record. The returned document feeds the gateway: excluded credentials
 * never reach the schedulers, so no cooldown, retry round or direct
 * egress can ever involve them (fail-closed, NE-S7-01).
 *
 * Documented side effect: models registered only under excluded
 * providers disappear from the gateway registry, hence from the
 * `/v1/models` list. S7 pins only the request-time behavior for such
 * models (501 `proxy_unavailable`); the list treatment is unpinned and
 * recorded here as this runtime's choice.
 */
export function stripProxiedProviders(
  record: Readonly<Record<string, unknown>>,
  proxied: ReadonlyMap<string, ReadonlySet<number>>,
): Record<string, unknown> {
  const out = structuredClone(record) as Record<string, unknown>
  for (const [family, indexes] of proxied) {
    const section = out[family]
    if (!Array.isArray(section)) continue
    out[family] = section.filter((_, index) => !indexes.has(index))
  }
  return out
}

// ---------------------------------------------------------------------------
// Block-YAML emit + parse (the config dialect)
// ---------------------------------------------------------------------------

/**
 * Emits block-style YAML for the config dialect: two-space mappings,
 * `- ` sequences, double-quoted strings, plain scalars for numbers and
 * booleans. The output round-trips through {@link parseBlockYaml} and
 * through the management facade's config parser.
 */
export function emitBlockYaml(value: Readonly<Record<string, unknown>>): string {
  const lines: string[] = []
  emitMapping(value, 0, lines)
  return lines.length === 0 ? '{}' : `${lines.join('\n')}\n`
}

function emitMapping(
  value: Readonly<Record<string, unknown>>,
  indent: number,
  lines: string[],
): void {
  for (const [key, member] of Object.entries(value)) {
    if (member === undefined) continue
    lines.push(`${' '.repeat(indent)}${quoteKey(key)}:${emitInline(member, indent, lines)}`)
  }
}

function emitInline(member: unknown, indent: number, lines: string[]): string {
  if (member === null) return ' null'
  if (Array.isArray(member)) {
    if (member.length === 0) return ' []'
    const nested: string[] = []
    for (const item of member) {
      if (item === undefined) continue
      nested.push(`\n${' '.repeat(indent + 2)}- ${emitScalar(item)}`)
    }
    lines.push(nested.join(''))
    return ''
  }
  if (typeof member === 'object') {
    const keys = Object.keys(member as Record<string, unknown>)
    if (keys.length === 0) return ' {}'
    const nested: string[] = []
    emitMapping(member as Readonly<Record<string, unknown>>, indent + 2, nested)
    lines.push(`\n${nested.join('\n')}`)
    return ''
  }
  return ` ${emitScalar(member)}`
}

function emitScalar(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return quoteScalar(String(value))
}

function quoteKey(key: string): string {
  return /^[A-Za-z0-9_.-]+$/.test(key) ? key : quoteScalar(key)
}

function quoteScalar(text: string): string {
  return `"${text.replace(/["\\\n\r\t]/g, (ch) => {
    switch (ch) {
      case '"':
        return '\\"'
      case '\\':
        return '\\\\'
      case '\n':
        return '\\n'
      case '\r':
        return '\\r'
      default:
        return '\\t'
    }
  })}"`
}

interface YamlLine {
  readonly indent: number
  readonly content: string
}

/**
 * Parses the block-style YAML dialect used for config text (what
 * {@link emitBlockYaml} produces, hand-edited equivalents, and the
 * config bytes the management facade persists). Flow collections and
 * anchors are out of dialect and rejected with a clear error.
 */
export function parseBlockYaml(text: string): Record<string, unknown> {
  const lines: YamlLine[] = []
  for (const raw of text.split('\n')) {
    const withoutComment = stripComment(raw)
    if (withoutComment.trim().length === 0) continue
    const indentMatch = /^ */.exec(withoutComment)
    lines.push({ indent: indentMatch === null ? 0 : indentMatch[0].length, content: withoutComment.trim() })
  }
  if (lines.length === 0) return {}
  const parsed = parseBlock(lines, 0, lines[0]?.indent ?? 0)
  if (parsed.next !== lines.length) {
    throw new Error(`yaml: could not parse line ${parsed.next + 1}`)
  }
  return parsed.value as Record<string, unknown>
}

/** Removes a trailing ` # ...` comment that sits outside quotes. */
function stripComment(raw: string): string {
  let inSingle = false
  let inDouble = false
  for (let index = 0; index < raw.length; index += 1) {
    const ch = raw[index] ?? ''
    if (ch === "'" && !inDouble) inSingle = !inSingle
    if (ch === '"' && !inSingle) inDouble = !inDouble
    if (ch === '#' && !inSingle && !inDouble && (index === 0 || /\s/.test(raw[index - 1] ?? ''))) {
      return raw.slice(0, index)
    }
  }
  return raw
}

function parseBlock(
  lines: readonly YamlLine[],
  start: number,
  indent: number,
): { value: unknown; next: number } {
  const first = lines[start]
  if (first === undefined) return { value: null, next: start }
  if (first.content === '{}' || first.content === '[]') {
    return { value: first.content === '{}' ? {} : [], next: start + 1 }
  }
  if (first.content.startsWith('- ') || first.content === '-') {
    return parseSequence(lines, start, indent)
  }
  return parseMapping(lines, start, indent)
}

function parseSequence(
  lines: readonly YamlLine[],
  start: number,
  indent: number,
): { value: unknown; next: number } {
  const out: unknown[] = []
  let index = start
  while (index < lines.length) {
    const line = lines[index]
    if (line === undefined || line.indent < indent) break
    if (line.indent > indent) throw new Error(`yaml: unexpected indent at entry ${index + 1}`)
    if (!line.content.startsWith('- ') && line.content !== '-') break
    const rest = line.content === '-' ? '' : line.content.slice(2)
    if (rest.length === 0) {
      const child = firstDeeper(lines, index + 1, indent)
      if (child !== undefined) {
        const parsed = parseBlock(lines, child.index, child.indent)
        out.push(parsed.value)
        index = parsed.next
        continue
      }
      out.push(null)
      index += 1
      continue
    }
    if (rest.includes(': ')) {
      // Nested mapping opened inline after the dash: re-parse it as a
      // mapping whose first line lost its `- ` marker.
      const virtual: YamlLine[] = [
        { indent: indent + 2, content: rest },
      ]
      let scan = index + 1
      while (scan < lines.length) {
        const candidate = lines[scan]
        if (candidate === undefined || candidate.indent <= indent) break
        virtual.push(candidate)
        scan += 1
      }
      const parsed = parseMapping(virtual, 0, indent + 2)
      out.push(parsed.value)
      index = scan
      continue
    }
    out.push(parseScalar(rest))
    index += 1
  }
  return { value: out, next: index }
}

function parseMapping(
  lines: readonly YamlLine[],
  start: number,
  indent: number,
): { value: unknown; next: number } {
  const out: Record<string, unknown> = {}
  let index = start
  while (index < lines.length) {
    const line = lines[index]
    if (line === undefined || line.indent < indent) break
    if (line.indent > indent) throw new Error(`yaml: unexpected indent at entry ${index + 1}`)
    if (line.content.startsWith('- ')) break
    const split = splitKeyValue(line.content)
    if (split === undefined) throw new Error(`yaml: could not parse line ${index + 1}`)
    const [key, inline] = split
    if (inline.length === 0) {
      const child = firstDeeper(lines, index + 1, indent)
      if (child === undefined) {
        out[key] = null
        index += 1
        continue
      }
      const parsed = parseBlock(lines, child.index, child.indent)
      out[key] = parsed.value
      index = parsed.next
      continue
    }
    if (inline === '[]') {
      out[key] = []
      index += 1
      continue
    }
    if (inline === '{}') {
      out[key] = {}
      index += 1
      continue
    }
    out[key] = parseScalar(inline)
    index += 1
  }
  return { value: out, next: index }
}

function firstDeeper(
  lines: readonly YamlLine[],
  start: number,
  indent: number,
): { index: number; indent: number } | undefined {
  const candidate = lines[start]
  if (candidate === undefined || candidate.indent <= indent) return undefined
  return { index: start, indent: candidate.indent }
}

function splitKeyValue(content: string): [string, string] | undefined {
  if (content.startsWith('"')) {
    const parsed = readQuoted(content)
    if (parsed === undefined) return undefined
    const rest = content.slice(parsed.consumed).trim()
    if (!rest.startsWith(':')) return undefined
    return [parsed.value, rest.slice(1).trim()]
  }
  const colon = content.indexOf(': ')
  const bare = content.endsWith(':') ? content.length - 1 : -1
  if (colon === -1 && bare === -1) return undefined
  const cut = bare !== -1 && (colon === -1 || bare < colon) ? bare : colon
  const key = content.slice(0, cut).trim()
  const rest = content.slice(cut + (bare === cut ? 1 : 1)).trim()
  return [key, bare === cut ? '' : rest]
}

function parseScalar(text: string): unknown {
  if (text.startsWith('"') || text.startsWith("'")) {
    const parsed = readQuoted(text)
    if (parsed === undefined) throw new Error(`yaml: unterminated quoted scalar: ${text}`)
    return parsed.value
  }
  if (text === 'null' || text === '~') return null
  if (text === 'true') return true
  if (text === 'false') return false
  if (/^-?\d+$/.test(text)) return Number(text)
  if (/^-?(\d+\.\d*|\.\d+)([eE][-+]?\d+)?$/.test(text)) return Number(text)
  return text
}

function readQuoted(text: string): { value: string; consumed: number } | undefined {
  const quote = text[0] ?? ''
  if (quote !== '"' && quote !== "'") return undefined
  let out = ''
  let index = 1
  while (index < text.length) {
    const ch = text[index] ?? ''
    if (quote === '"') {
      if (ch === '\\') {
        const next = text[index + 1] ?? ''
        if (next === 'n') out += '\n'
        else if (next === 't') out += '\t'
        else if (next === 'r') out += '\r'
        else out += next
        index += 2
        continue
      }
      if (ch === '"') return { value: out, consumed: index + 1 }
      out += ch
      index += 1
      continue
    }
    if (ch === "'") {
      if ((text[index + 1] ?? '') === "'") {
        out += "'"
        index += 2
        continue
      }
      return { value: out, consumed: index + 1 }
    }
    out += ch
    index += 1
  }
  return undefined
}
