/**
 * Tool translation for the res2oai direction (S2d6 section 3.1.2).
 *
 * Request side: Responses tool declarations (top-level `tools` plus every
 * `additional_tools` input item) become chat `function` tools. `custom`
 * tools gain the fixed single-`input` parameter schema; `namespace` tools
 * contribute their children under qualified names. Production dedups by
 * chat name, first occurrence wins - so the response side can restore
 * original names unambiguously.
 *
 * Response side: upstream tool-call names resolve back through the same
 * declared set. Flat names win over namespace collisions; a name that
 * matches several qualified children stays as-is.
 */
import { RawJson, isPlainObject, readArray, readObject, readString, serializeOrdered, sortKeysDeep } from './json'
import type { WireObject } from './json'
import type { DeclaredTool } from './types'

/** Fixed parameter schema stamped onto `custom` tools. */
export const CUSTOM_TOOL_PARAMETERS: WireObject = {
  type: 'object',
  properties: { input: { type: 'string' } },
  required: ['input'],
}

/** Serializes one chat tool entry with the recorded (sorted) key order. */
export function serializeChatTool(tool: WireObject): string {
  return serializeOrdered(sortKeysDeep(tool))
}

/** Serializes the whole translated `tools` array with sorted keys. */
export function serializeChatTools(tools: readonly WireObject[]): string {
  return serializeOrdered(tools.map((tool) => sortKeysDeep(tool)))
}

/** Qualifies a child name under a namespace (double-underscore style). */
export function qualifyToolName(namespace: string, name: string): string {
  if (namespace.endsWith('__')) return namespace + name
  return `${namespace}__${name}`
}

interface ToolSource {
  readonly record: Record<string, unknown>
  readonly namespace: string | undefined
}

/** Collects the tool sources of a request: top-level tools first, then additional_tools items. */
export function collectToolSources(input: readonly unknown[], topLevelTools: readonly unknown[] | undefined): readonly ToolSource[] {
  const sources: ToolSource[] = []
  for (const tool of topLevelTools ?? []) {
    if (isPlainObject(tool)) sources.push({ record: tool, namespace: undefined })
  }
  for (const item of input) {
    if (!isPlainObject(item)) continue
    if (readString(item, 'type') !== 'additional_tools') continue
    for (const tool of readArray(item, 'tools') ?? []) {
      if (isPlainObject(tool)) sources.push({ record: tool, namespace: undefined })
    }
  }
  return sources
}

/**
 * Translates every tool source into chat tools. Returns the deduplicated
 * chat entries plus the declaration metadata used by response-side name
 * restoration. Tool sources with no usable name still produce a tool
 * (empty name), mirroring the reference's gjson fallbacks.
 */
export function translateToolDeclarations(sources: readonly ToolSource[]): {
  readonly chatTools: readonly WireObject[]
  readonly declared: readonly DeclaredTool[]
} {
  const chatTools: WireObject[] = []
  const declared: DeclaredTool[] = []
  const seen = new Set<string>()
  for (const source of sources) {
    const type = readString(source.record, 'type') ?? ''
    if (type === 'function' || type === '' || type === 'custom') {
      const produced = produceTool(source.record, source.namespace, type === 'custom')
      if (!seen.has(produced.declaration.chatName)) {
        seen.add(produced.declaration.chatName)
        chatTools.push(produced.chatTool)
        declared.push(produced.declaration)
      }
      continue
    }
    if (type === 'namespace') {
      const namespace = readString(source.record, 'name') ?? ''
      for (const child of readArray(source.record, 'tools') ?? []) {
        if (!isPlainObject(child)) continue
        const childType = readString(child, 'type') ?? ''
        if (childType !== 'function' && childType !== '' && childType !== 'custom') continue
        const produced = produceTool(child, source.namespace ?? namespace, childType === 'custom')
        if (!seen.has(produced.declaration.chatName)) {
          seen.add(produced.declaration.chatName)
          chatTools.push(produced.chatTool)
          declared.push(produced.declaration)
        }
      }
    }
    // Every other tool type (web_search, file_search, ...) drops.
  }
  return { chatTools, declared }
}

interface ProducedTool {
  readonly chatTool: WireObject
  readonly declaration: DeclaredTool
}

function produceTool(record: Record<string, unknown>, namespace: string | undefined, custom: boolean): ProducedTool {
  const embedded = readObject(record, 'function')
  const name = readString(record, 'name') ?? (embedded !== undefined ? readString(embedded, 'name') : undefined) ?? ''
  const description =
    readString(record, 'description') ??
    (embedded !== undefined ? readString(embedded, 'description') : undefined) ??
    ''
  const chatName = namespace !== undefined && namespace !== '' && !alreadyQualified(namespace, name) ? qualifyToolName(namespace, name) : name
  const parameters =
    readObject(record, 'parameters') ??
    readObject(record, 'parametersJsonSchema') ??
    readObject(record, 'input_schema') ??
    (embedded !== undefined ? readObject(embedded, 'parameters') : undefined) ??
    (embedded !== undefined ? readObject(embedded, 'parametersJsonSchema') : undefined)
  const chatTool: WireObject = {
    type: 'function',
    function: {
      name: chatName,
      description,
      parameters: (custom ? CUSTOM_TOOL_PARAMETERS : (parameters ?? {})) as WireObject,
    },
  }
  const declaration: DeclaredTool = {
    chatName,
    originalName: name,
    namespace: namespace !== undefined && namespace !== '' ? namespace : undefined,
    custom,
  }
  return { chatTool, declaration }
}

/** Children already carrying `mcp__` or the full namespace stay untouched. */
function alreadyQualified(namespace: string, name: string): boolean {
  if (name.startsWith('mcp__')) return true
  if (name === namespace) return true
  if (namespace.length > 0 && name.startsWith(`${namespace}__`)) return true
  return false
}

/**
 * Resolves a `tool_choice` value: non-object values pass through
 * verbatim; `function`/`custom` objects map onto the chat function-choice
 * shape with the name resolved against the declared set (namespace
 * qualification first, then declaration canonicalization).
 */
export function translateToolChoice(value: unknown, declared: readonly DeclaredTool[]): WireObject | undefined {
  if (!isPlainObject(value)) return value === undefined ? undefined : (value as WireObject)
  const type = readString(value, 'type')
  if (type !== 'function' && type !== 'custom') return value as WireObject
  const embedded = readObject(value, 'function')
  const rawName =
    (embedded !== undefined ? readString(embedded, 'name') : undefined) ??
    readString(value, 'name') ??
    ''
  const namespace =
    (embedded !== undefined ? readString(embedded, 'namespace') : undefined) ?? readString(value, 'namespace')
  const name =
    namespace !== undefined && namespace !== '' ? qualifyToolName(namespace, rawName) : canonicalToolName(rawName, declared)
  return { type: 'function', function: { name } }
}

/**
 * Canonicalizes a tool-choice name against the declared tools: exact chat
 * names pass through; a bare child name resolves to its unique qualified
 * declaration; ambiguous or unknown names stay as-is.
 */
function canonicalToolName(name: string, declared: readonly DeclaredTool[]): string {
  for (const tool of declared) {
    if (tool.chatName === name) return name
  }
  const matches = declared.filter((tool) => tool.originalName === name && tool.chatName !== name)
  if (matches.length === 1 && matches[0] !== undefined) return matches[0].chatName
  return name
}

export interface ResolvedCallName {
  readonly name: string
  readonly namespace: string | undefined
  readonly custom: boolean
}

/**
 * Restores a chat tool-call name to its declared Responses form: exact
 * chat matches first (flat wins), then a unique qualified child match
 * (restores `name` + `namespace`), otherwise the call name stays as-is.
 */
export function resolveCallName(chatName: string, declared: readonly DeclaredTool[]): ResolvedCallName {
  for (const tool of declared) {
    if (tool.chatName === chatName) {
      return { name: tool.originalName, namespace: tool.namespace, custom: tool.custom }
    }
  }
  const matches = declared.filter((tool) => tool.originalName === chatName)
  if (matches.length === 1 && matches[0] !== undefined) {
    const tool = matches[0]
    return { name: tool.originalName, namespace: tool.namespace, custom: tool.custom }
  }
  return { name: chatName, namespace: undefined, custom: false }
}

/**
 * Serializes one buffered assistant tool-call entry with the recorded
 * sorted key order: `{"function":{"arguments":...,"name":...},"id":...,
 * "type":"function"}`. `arguments` is a plain string (raw client bytes for
 * function calls, the wrapped `{"input":...}` JSON for custom calls).
 */
export function chatToolCallEntry(callId: string, name: string, argumentsText: string): WireObject {
  return {
    id: callId,
    type: 'function',
    function: { name, arguments: argumentsText },
  }
}

/** Wraps a custom tool-call freeform input as the single-argument JSON body. */
export function customToolArguments(input: string): string {
  return JSON.stringify({ input })
}
