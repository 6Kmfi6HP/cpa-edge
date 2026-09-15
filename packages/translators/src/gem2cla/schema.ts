/**
 * Tool schema and tool-object normalization for the Claude upstream
 * (gem2cla direction).
 *
 * Recorded wire rules (S2d7-06): a function declaration's `parameters` (or
 * `parametersJsonSchema`) becomes `input_schema` with
 *
 * - `additionalProperties` forced to `false` (unless already exactly false),
 * - `$schema` set or overwritten to the draft-07 URI,
 * - every `type` value anywhere in the schema lowercased,
 * - keys re-serialized in lexicographic order.
 *
 * The whole tool object is emitted with sorted keys (`description`,
 * `input_schema`, `name`); the executor's cache breakpoint is appended after
 * that serialization, so `cache_control` lands last.
 */
import { isPlainObject, sortKeysDeep } from './json'
import type { WireObject, WireValue } from './types'

/** Draft URI the reference stamps onto every tool schema. */
export const TOOL_SCHEMA_DRAFT_URI = 'http://json-schema.org/draft-07/schema#'

/** Lowercases one `type` value: strings directly, arrays element-wise. */
function lowercaseTypeValue(value: unknown): WireValue {
  if (typeof value === 'string') return value.toLowerCase()
  if (Array.isArray(value)) {
    return value.map((element) =>
      typeof element === 'string' ? element.toLowerCase() : (element as WireValue),
    )
  }
  return value as WireValue
}

/**
 * Cleans one function declaration's parameter schema. A non-object (or
 * absent) schema yields `{}` - declarations without parameters still carry
 * an `input_schema` key.
 */
export function cleanToolParameters(raw: unknown): WireValue {
  if (!isPlainObject(raw)) return {}
  const source = raw as Record<string, unknown>
  const cleaned: WireObject = {}
  for (const key of Object.keys(source)) {
    const member = source[key]
    if (member === undefined) continue
    if (key === 'type') {
      cleaned['type'] = lowercaseTypeValue(member)
      continue
    }
    if (key === 'additionalProperties' || key === '$schema') continue
    cleaned[key] = member as WireValue
  }
  // Forced at the schema root only; nested property schemas keep their shape
  // apart from the recursive type lowercasing above. A pre-existing exact
  // `false` stays false, every other value is overwritten.
  cleaned['additionalProperties'] = false
  cleaned['$schema'] = TOOL_SCHEMA_DRAFT_URI
  return sortKeysDeep(cleaned) as WireValue
}

/**
 * Builds one Claude tool object from a function declaration: sorted keys
 * `description` (when present), `input_schema`, `name`.
 */
export function claudeToolObject(declaration: Record<string, unknown>): WireObject {
  const tool: WireObject = { name: '' }
  const description = declaration['description']
  if (typeof description === 'string') tool['description'] = description
  tool['input_schema'] = cleanToolParameters(
    declaration['parameters'] !== undefined
      ? declaration['parameters']
      : declaration['parametersJsonSchema'],
  )
  tool['name'] = typeof declaration['name'] === 'string' ? declaration['name'] : ''
  return sortKeysDeep(tool) as WireObject
}
