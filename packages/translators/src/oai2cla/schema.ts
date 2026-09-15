/**
 * Tool schema and tool-id normalization for the Claude upstream.
 */
import { readObject } from './json'
import { sortKeysDeep } from './json'
import type { WireObject, WireValue } from './types'

/**
 * Normalizes a function `parameters` schema for the Claude wire
 * (NormalizeClaudeToolInputSchema, S2d3 section 2.4):
 *
 * - the root is forced to `{"type":"object"}`;
 * - `properties` is ensured (empty when absent);
 * - root-level `anyOf` / `oneOf` / `allOf` arrays are flattened into
 *   `properties` (each variant becomes a property named after its array
 *   index - the reference flattens them but the generated property names
 *   are not recorded in any golden; see the module reply notes);
 * - the result is re-serialized with lexicographic key order.
 */
export function normalizeToolInputSchema(raw: unknown): WireValue | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const source = raw as Record<string, unknown>
  const normalized: WireObject = {}

  for (const key of Object.keys(source)) {
    if (key === 'type') continue
    if (key === 'properties') continue
    if (key === 'anyOf' || key === 'oneOf' || key === 'allOf') continue
    const member = source[key]
    if (member === undefined) continue
    normalized[key] = member as WireValue
  }

  normalized['type'] = 'object'

  const properties: WireObject = {}
  const declared = readObject(source, 'properties')
  if (declared !== undefined) {
    for (const key of Object.keys(declared)) {
      const member = declared[key]
      if (member === undefined) continue
      properties[key] = member as WireValue
    }
  }
  for (const combiner of ['anyOf', 'oneOf', 'allOf'] as const) {
    const variants = source[combiner]
    if (!Array.isArray(variants)) continue
    for (let i = 0; i < variants.length; i++) {
      properties[`${combiner}_${i}`] = variants[i] as WireValue
    }
  }
  normalized['properties'] = properties

  return sortKeysDeep(normalized)
}

/**
 * Sanitizes a tool id for the Claude wire: characters outside
 * `[a-zA-Z0-9_-]` become `_`.
 */
export function sanitizeClaudeToolId(id: string): string {
  let out = ''
  for (let i = 0; i < id.length; i++) {
    const code = id.charCodeAt(i)
    const isAlnum = (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)
    out += isAlnum || id[i] === '_' || id[i] === '-' ? id[i] : '_'
  }
  return out
}

/**
 * Parses assistant `tool_calls[].function.arguments`: only a JSON object
 * string is accepted; anything else (invalid JSON, non-object JSON, absent,
 * non-string) collapses to `{}`.
 */
export function parseToolArguments(raw: unknown): WireObject {
  if (typeof raw !== 'string' || raw.length === 0) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    return parsed as WireObject
  } catch {
    return {}
  }
}
