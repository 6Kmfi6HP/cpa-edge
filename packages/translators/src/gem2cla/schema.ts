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
 * an `input_schema` key. The `additionalProperties`/`$schema` forces apply
 * at the schema ROOT only; the `type` lowercasing walks the whole tree.
 */
export function cleanToolParameters(raw: unknown): WireValue {
  if (!isPlainObject(raw)) return {}
  const cleaned = lowercaseTypesDeep(raw) as Record<string, unknown>
  cleaned['additionalProperties'] = false
  cleaned['$schema'] = TOOL_SCHEMA_DRAFT_URI
  return sortKeysDeep(cleaned as WireObject) as WireValue
}

/** Recursively lowercases every `type` member anywhere in the schema. */
function lowercaseTypesDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(lowercaseTypesDeep)
  if (!isPlainObject(value)) return value
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value)) {
    const member = (value as Record<string, unknown>)[key]
    if (member === undefined) continue
    out[key] = key === 'type' ? lowercaseTypeValue(member) : lowercaseTypesDeep(member)
  }
  return out
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
