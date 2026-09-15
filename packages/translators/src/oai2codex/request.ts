/**
 * Request translation: OpenAI Chat Completions -> Codex (Responses API).
 *
 * Reproduces the full recorded pipeline for this direction: the translator
 * stage (message -> `input` items, tool flattening, `text` mapping,
 * two-phase `reasoning` construction) and the executor stages that are
 * observable on the wire (capability-gated reasoning strip, image-tool
 * injection, `store:false`, `parallel_tool_calls:true`, session-identity
 * `prompt_cache_key`, tool-schema normalization). The output body is
 * byte-exact contract material (S2d5 sections 2.3, 3.1-3.3).
 */
import { CpaError } from '@cpa-edge/core'
import { parseStrictJson, rawValueAt, readArray, readObject, readString, serializeDocument, wireObject } from './json'
import type { DocumentValue } from './json'
import { RawJson } from './json'
import { deriveCodexSessionId, truncateRunes } from './session'
import { buildShortNameMap, normalizeCodexToolSchemasInBody, shortenToolName } from './tools'
import type { ChatToCodexContext, CodexUpstreamRequest, WireObject } from './types'

/** Instruction truncation for the identity root (runes). */
const IDENTITY_INSTRUCTION_RUNES = 50

/** The image tool injected under default config, appended LAST in `tools`. */
export const CODEX_IMAGE_GENERATION_TOOL: Readonly<WireObject> = Object.freeze({
  type: 'image_generation',
  output_format: 'png',
})

/** Model-name suffix that suppresses the image-tool injection. */
const NO_IMAGE_TOOL_MODEL_SUFFIX = 'spark'

/** Effort default when the client omits `reasoning_effort`. */
const DEFAULT_REASONING_EFFORT = 'medium'

/**
 * Translates one client request into the final upstream Codex body.
 *
 * @param rawBody the client's request-body bytes as text
 * @param ctx serving configuration (resolved model, capability, session)
 * @returns the upstream body (serialized + parsed), the session identity
 *   values and the tool-name reverse map
 * @throws CpaError `invalid-input` when the body is not strict JSON
 */
export async function translateChatToCodex(
  rawBody: string,
  ctx: ChatToCodexContext,
): Promise<CodexUpstreamRequest> {
  const parsed: unknown = parseStrictJson(rawBody)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CpaError('invalid-input', 'Invalid request: malformed JSON body')
  }
  const request = parsed as Record<string, unknown>

  const messages = readArray(request, 'messages') ?? []
  const tools = readArray(request, 'tools') ?? []

  const nameMap = buildShortNameMap(collectAllToolNames(request, tools))
  const customOnly = customOnlyNames(tools)

  const translation = translateInput(messages, customOnly, nameMap)
  const translatedTools = translateTools(tools, rawBody, nameMap)
  const toolChoice = translateToolChoice(request['tool_choice'], nameMap, customOnly)
  const text = translateText(request, rawBody)
  const reasoning = translateReasoning(request, ctx.thinking === true)

  const injectImage =
    ctx.disableImageGeneration !== true &&
    !translatedTools.declaresImageTool &&
    !ctx.upstreamModel.endsWith(NO_IMAGE_TOOL_MODEL_SUFFIX)
  const finalToolCount = translatedTools.tools.length + (injectImage ? 1 : 0)

  const identity = await sessionIdentity(request, translation, ctx)

  const body: Record<string, DocumentValue> = {}
  body['instructions'] = ''
  body['stream'] = true
  if (reasoning !== undefined) body['reasoning'] = reasoning
  if (finalToolCount > 0) body['parallel_tool_calls'] = true
  body['include'] = ['reasoning.encrypted_content']
  body['model'] = ctx.upstreamModel
  body['input'] = translation.items
  if (text !== undefined) body['text'] = text
  if (translatedTools.tools.length > 0) {
    body['tools'] = injectImage
      ? [...translatedTools.tools, CODEX_IMAGE_GENERATION_TOOL]
      : translatedTools.tools
  }
  if (toolChoice !== undefined) body['tool_choice'] = toolChoice
  body['store'] = false
  if (translatedTools.tools.length === 0 && injectImage) {
    // The injected tool CREATES the `tools` key after `store` (recorded).
    body['tools'] = [CODEX_IMAGE_GENERATION_TOOL]
  }
  if (identity.promptCacheKey.length > 0) body['prompt_cache_key'] = identity.promptCacheKey

  const serialized = normalizeCodexToolSchemasInBody(serializeDocument(body as DocumentValue))
  return {
    body: serialized,
    value: wireObject(JSON.parse(serialized)),
    promptCacheKey: identity.promptCacheKey,
    sessionHeaderValue: identity.sessionHeaderValue,
    nameMap,
  }
}

// ---------------------------------------------------------------------------
// Session identity (S2d5 2.9)
// ---------------------------------------------------------------------------

interface SessionResolution {
  readonly promptCacheKey: string
  readonly sessionHeaderValue: string
}

/**
 * Session precedence: (1) client body `prompt_cache_key` verbatim for BOTH
 * the body field and the `Session-Id` header; (2) client session header for
 * the `Session-Id` header with a DERIVED body value; (3) one derived UUID
 * for both.
 */
async function sessionIdentity(
  request: Record<string, unknown>,
  translation: InputTranslation,
  ctx: ChatToCodexContext,
): Promise<SessionResolution> {
  const bodyKey = readString(request, 'prompt_cache_key')
  const apiKey = ctx.session?.apiKey ?? ''
  const clientSessionId = ctx.session?.clientSessionId
  if (bodyKey !== undefined && bodyKey.length > 0) {
    return { promptCacheKey: bodyKey, sessionHeaderValue: bodyKey }
  }
  const derived = await deriveCodexSessionId({
    apiKey,
    instructions: translation.instructionTexts.map((text) => truncateRunes(text, IDENTITY_INSTRUCTION_RUNES)),
    userParts: translation.firstUserParts,
    clientSessionId,
  })
  return {
    promptCacheKey: derived,
    sessionHeaderValue: clientSessionId !== undefined && clientSessionId.length > 0 ? clientSessionId : derived,
  }
}

// ---------------------------------------------------------------------------
// Messages -> input items (S2d5 3.1)
// ---------------------------------------------------------------------------

interface PendingCall {
  readonly custom: boolean
  consumed: boolean
}

interface InputTranslation {
  readonly items: readonly WireObject[]
  /** System/developer message texts, conversation order (identity input). */
  readonly instructionTexts: readonly string[]
  /** Canonical parts of the FIRST user message (identity input). */
  readonly firstUserParts: readonly WireObject[]
}

function translateInput(
  messages: readonly unknown[],
  customOnly: ReadonlySet<string>,
  nameMap: Readonly<Record<string, string>>,
): InputTranslation {
  const items: WireObject[] = []
  const instructionTexts: string[] = []
  let firstUserParts: WireObject[] | undefined

  const pending = new Map<string, PendingCall>()
  const seenIds = new Set<string>()
  const ambiguousIds = new Set<string>()
  // call_id -> emitted item, so duplicate ids can drop their items later.
  const callItems = new Map<string, WireObject>()

  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const message = messages[messageIndex]
    if (typeof message !== 'object' || message === null) continue
    const record = message as Record<string, unknown>
    const role = record['role']
    if (typeof role !== 'string') continue

    if (role === 'system' || role === 'developer') {
      pending.clear()
      const parts = messageParts(record['content'], false)
      instructionTexts.push(partsText(parts))
      items.push({ type: 'message', role: 'developer', content: parts })
      continue
    }

    if (role === 'tool') {
      appendToolOutput(record, items, pending, ambiguousIds)
      continue
    }

    // Any other role resets the pending call set.
    pending.clear()

    const isAssistant = role === 'assistant'
    const parts = messageParts(record['content'], !isAssistant)
    if (!isAssistant && firstUserParts === undefined && role === 'user') {
      firstUserParts = parts
    }
    if (isAssistant) {
      // Assistant items with zero content parts are dropped (tool-call
      // carriers); the call items below are emitted regardless.
      if (parts.length > 0) items.push({ type: 'message', role, content: parts })
      appendAssistantCalls(record, messageIndex, items, pending, seenIds, ambiguousIds, callItems, customOnly, nameMap)
      continue
    }
    items.push({ type: 'message', role, content: parts })
  }

  return {
    items: items.filter((item) => {
      const callId = typeof item['call_id'] === 'string' ? (item['call_id'] as string) : undefined
      return callId === undefined || !ambiguousIds.has(callId)
    }),
    instructionTexts,
    firstUserParts: firstUserParts ?? [],
  }
}

/** Joins the text of a message's parts (identity instruction input). */
function partsText(parts: readonly WireObject[]): string {
  let out = ''
  for (const part of parts) {
    if (part['type'] === 'input_text' && typeof part['text'] === 'string') out += part['text']
  }
  return out
}

/** Content -> message parts; multimodal parts are user-role-only. */
function messageParts(content: unknown, multimodal: boolean): WireObject[] {
  const parts: WireObject[] = []
  if (typeof content === 'string') {
    if (content.length > 0) parts.push(textPart(content, multimodal))
    return parts
  }
  if (!Array.isArray(content)) return parts
  for (const element of content) {
    if (typeof element === 'string') {
      if (element.length > 0) parts.push(textPart(element, multimodal))
      continue
    }
    if (typeof element !== 'object' || element === null) continue
    const part = convertMessagePart(element as Record<string, unknown>, multimodal)
    if (part !== undefined) parts.push(part)
  }
  return parts
}

function textPart(text: string, multimodal: boolean): WireObject {
  return { type: multimodal ? 'input_text' : 'output_text', text }
}

/** One OpenAI content part -> one Responses content part. */
function convertMessagePart(part: Record<string, unknown>, multimodal: boolean): WireObject | undefined {
  const type = part['type']
  if (type === 'text') {
    return textPart(readString(part, 'text') ?? '', multimodal)
  }
  if (!multimodal) return undefined
  if (type === 'image_url') {
    const image = readObject(part, 'image_url')
    const url = image !== undefined ? readString(image, 'url') : undefined
    if (url === undefined) return undefined
    return { type: 'input_image', image_url: url }
  }
  if (type === 'file') {
    const file = readObject(part, 'file')
    const data = file !== undefined ? readString(file, 'file_data') : undefined
    if (data === undefined) return undefined
    const out: WireObject = { type: 'input_file', file_data: data }
    const filename = file !== undefined ? readString(file, 'filename') : undefined
    if (filename !== undefined) out['filename'] = filename
    return out
  }
  if (type === 'input_audio') {
    const data = readString(part, 'data')
    if (data === undefined) return undefined
    const out: WireObject = { type: 'input_audio', data }
    const format = readString(part, 'format')
    if (format !== undefined) out['format'] = format
    return out
  }
  return undefined
}

/** Assistant `tool_calls` -> separate call items, in array order. */
function appendAssistantCalls(
  record: Record<string, unknown>,
  messageIndex: number,
  items: WireObject[],
  pending: Map<string, PendingCall>,
  seenIds: Set<string>,
  ambiguousIds: Set<string>,
  callItems: Map<string, WireObject>,
  customOnly: ReadonlySet<string>,
  nameMap: Readonly<Record<string, string>>,
): void {
  const calls = record['tool_calls']
  if (!Array.isArray(calls)) return
  for (let callIndex = 0; callIndex < calls.length; callIndex++) {
    const call = calls[callIndex]
    if (typeof call !== 'object' || call === null) continue
    const callRecord = call as Record<string, unknown>
    if (callRecord['type'] !== undefined && callRecord['type'] !== 'function') continue
    const fn = readObject(callRecord, 'function')
    if (fn === undefined) continue
    const name = readString(fn, 'name') ?? ''
    const custom = customOnly.has(name)
    const shortName = shortenToolName(name)

    const rawId = readString(callRecord, 'id')
    let id: string
    if (rawId === undefined) {
      const base = `call_missing_${messageIndex}_${callIndex}`
      id = base
      let n = 1
      while (seenIds.has(id)) id = `${base}_${n++}`
    } else {
      id = rawId
      if (seenIds.has(id)) {
        // Duplicate id: the call items and matching outputs are dropped.
        ambiguousIds.add(id)
        continue
      }
    }
    seenIds.add(id)

    const arguments_ = readString(fn, 'arguments') ?? ''
    const item: WireObject = custom
      ? { type: 'custom_tool_call', call_id: id, name: shortName, input: arguments_ }
      : { type: 'function_call', call_id: id, name: shortName, arguments: arguments_ }
    items.push(item)
    callItems.set(id, item)
    pending.set(id, { custom, consumed: false })
  }
}

/** `tool` message -> function_call_output / custom_tool_call_output item. */
function appendToolOutput(
  record: Record<string, unknown>,
  items: WireObject[],
  pending: Map<string, PendingCall>,
  ambiguousIds: Set<string>,
): void {
  const callId = readString(record, 'tool_call_id')
  if (callId === undefined || callId.length === 0) return
  if (ambiguousIds.has(callId)) return
  const call = pending.get(callId)
  if (call === undefined || call.consumed) return
  call.consumed = true
  const output = toolOutputContent(record['content'])
  const item: WireObject = { type: call.custom ? 'custom_tool_call_output' : 'function_call_output', call_id: callId }
  if (output !== undefined) item['output'] = output
  items.push(item)
}

/**
 * Tool-message content: strings pass verbatim unless they are a JSON-encoded
 * array containing image parts (then parsed into parts); arrays map to parts;
 * anything else serializes as raw JSON text.
 */
function toolOutputContent(content: unknown): DocumentValue | undefined {
  if (typeof content === 'string') {
    const parsed = safeJsonParse(content)
    if (Array.isArray(parsed) && arrayHasImagePart(parsed)) {
      return parsed.map((element) => outputPart(element)).filter((part): part is WireObject => part !== undefined)
    }
    return content
  }
  if (Array.isArray(content)) {
    return content.map((element) => outputPart(element)).filter((part): part is WireObject => part !== undefined)
  }
  if (typeof content === 'object' && content !== null) {
    return new RawJson(JSON.stringify(content))
  }
  if (content === undefined || content === null) return undefined
  return new RawJson(JSON.stringify(content))
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function arrayHasImagePart(values: readonly unknown[]): boolean {
  return values.some(
    (value) =>
      typeof value === 'object' &&
      value !== null &&
      ((value as Record<string, unknown>)['type'] === 'image_url' ||
        (value as Record<string, unknown>)['type'] === 'input_image'),
  )
}

/** One tool-output content element -> one Responses part. */
function outputPart(element: unknown): WireObject | undefined {
  if (typeof element === 'string') {
    return element.length > 0 ? { type: 'input_text', text: element } : undefined
  }
  if (typeof element !== 'object' || element === null) return undefined
  const part = element as Record<string, unknown>
  const type = part['type']
  if (type === 'text' || type === 'input_text' || type === 'output_text') {
    return { type: 'input_text', text: readString(part, 'text') ?? '' }
  }
  if (type === 'image_url' || type === 'input_image') {
    const image = readObject(part, 'image_url')
    const url =
      typeof part['image_url'] === 'string'
        ? (part['image_url'] as string)
        : image !== undefined
          ? readString(image, 'url')
          : undefined
    if (url === undefined && readString(part, 'file_id') === undefined && (image !== undefined ? readString(image, 'file_id') : undefined) === undefined) {
      return undefined
    }
    const out: WireObject = { type: 'input_image' }
    if (url !== undefined) out['image_url'] = url
    const fileId = readString(part, 'file_id') ?? (image !== undefined ? readString(image, 'file_id') : undefined)
    if (fileId !== undefined) out['file_id'] = fileId
    const detail = readString(part, 'detail') ?? (image !== undefined ? readString(image, 'detail') : undefined)
    if (detail !== undefined) out['detail'] = detail
    return out
  }
  if (type === 'file') {
    const file = readObject(part, 'file')
    if (file === undefined) return undefined
    const out: WireObject = { type: 'input_file' }
    const fileId = readString(file, 'file_id')
    if (fileId !== undefined) out['file_id'] = fileId
    const data = readString(file, 'file_data')
    if (data !== undefined) out['file_data'] = data
    const url = readString(file, 'file_url')
    if (url !== undefined) out['file_url'] = url
    const filename = readString(file, 'filename')
    if (filename !== undefined) out['filename'] = filename
    return out
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Tools + tool_choice (S2d5 3.2)
// ---------------------------------------------------------------------------

/** Names of custom tools that no function tool also declares. */
function customOnlyNames(tools: readonly unknown[]): Set<string> {
  const functionNames = new Set<string>()
  const customNames: string[] = []
  for (const entry of tools) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const name = declaredToolName(record)
    if (name === undefined) continue
    if (record['type'] === 'function') functionNames.add(name)
    if (record['type'] === 'custom') customNames.push(name)
  }
  const customOnly = new Set<string>()
  for (const name of customNames) {
    if (!functionNames.has(name)) customOnly.add(name)
  }
  return customOnly
}

/** Client-facing name of one tool declaration (function or custom). */
function declaredToolName(record: Record<string, unknown>): string | undefined {
  if (record['type'] === 'function') {
    const fn = readObject(record, 'function')
    return fn !== undefined ? readString(fn, 'name') : undefined
  }
  if (record['type'] === 'custom') return readString(record, 'name')
  return undefined
}

interface TranslatedTools {
  readonly tools: readonly WireObject[]
  /** The client already declared an `image_generation` tool. */
  readonly declaresImageTool: boolean
}

/** `tools[]` -> flattened Codex tool objects, client order preserved. */
function translateTools(
  tools: readonly unknown[],
  rawBody: string,
  nameMap: Readonly<Record<string, string>>,
): TranslatedTools {
  const out: WireObject[] = []
  let declaresImageTool = false
  for (let index = 0; index < tools.length; index++) {
    const entry = tools[index]
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const type = record['type']
    if (typeof type !== 'string' || type.length === 0) continue
    if (type === 'image_generation') declaresImageTool = true

    if (type === 'function') {
      const fn = readObject(record, 'function')
      if (fn === undefined) {
        out.push({ type: 'function' })
        continue
      }
      const tool: WireObject = { type: 'function', name: shortenToolName(readString(fn, 'name') ?? '') }
      const description = readString(fn, 'description')
      if (description !== undefined) tool['description'] = description
      const rawParameters = rawValueAt(rawBody, ['tools', String(index), 'function', 'parameters'])
      if (rawParameters !== undefined) tool['parameters'] = new RawJson(rawParameters)
      tool['strict'] = typeof fn['strict'] === 'boolean' ? fn['strict'] : false
      out.push(tool)
      continue
    }

    if (type === 'custom') {
      const tool: WireObject = {}
      for (const key of Object.keys(record)) {
        const member = record[key]
        if (member === undefined) continue
        if (key === 'name') tool['name'] = shortenToolName(typeof member === 'string' ? member : '')
        else tool[key] = member as DocumentValue
      }
      out.push(tool)
      continue
    }

    // Built-ins and any other non-empty type pass through verbatim.
    out.push(wireObject(record))
  }
  return { tools: out, declaresImageTool }
}

/** `tool_choice` mapping (4 variants, S2d5 3.2). */
export function translateToolChoice(
  raw: unknown,
  nameMap: Readonly<Record<string, string>>,
  customOnly: ReadonlySet<string>,
): DocumentValue | undefined {
  if (typeof raw === 'string') return raw
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  const type = record['type']
  if (typeof type !== 'string' || type.length === 0) return undefined
  if (type === 'function' || type === 'custom') {
    const name =
      type === 'function'
        ? readString(readObject(record, 'function'), 'name')
        : readString(record, 'name')
    const resolved = name !== undefined && name.length > 0 ? name : undefined
    const switched = type === 'function' && resolved !== undefined && customOnly.has(resolved)
    const out: WireObject = { type: switched ? 'custom' : type }
    if (resolved !== undefined) out['name'] = shortenToolName(resolved)
    return out
  }
  return wireObject(record)
}

// ---------------------------------------------------------------------------
// text (response_format) + reasoning (S2d5 3.3, 2.3)
// ---------------------------------------------------------------------------

/** `response_format` / `text.verbosity` -> the `text` object. */
function translateText(request: Record<string, unknown>, rawBody: string): WireObject | undefined {
  const responseFormat = request['response_format']
  const verbosityObject = readObject(request, 'text')
  const verbosity = verbosityObject !== undefined ? readString(verbosityObject, 'verbosity') : undefined
  if (responseFormat === undefined && verbosityObject === undefined) return undefined

  const text: WireObject = {}
  const format = translateTextFormat(responseFormat, rawBody)
  if (format !== undefined) text['format'] = format
  if (verbosity !== undefined) text['verbosity'] = verbosity
  return Object.keys(text).length > 0 ? text : undefined
}

function translateTextFormat(responseFormat: unknown, rawBody: string): WireObject | undefined {
  if (typeof responseFormat !== 'object' || responseFormat === null || Array.isArray(responseFormat)) return undefined
  const record = responseFormat as Record<string, unknown>
  const type = record['type']
  if (type === 'text') return { type: 'text' }
  if (type === 'json_schema') {
    const jsonSchema = readObject(record, 'json_schema')
    if (jsonSchema === undefined) return undefined
    const format: WireObject = { type: 'json_schema' }
    const name = readString(jsonSchema, 'name')
    if (name !== undefined) format['name'] = name
    if (typeof jsonSchema['strict'] === 'boolean') format['strict'] = jsonSchema['strict']
    const rawSchema = rawValueAt(rawBody, ['response_format', 'json_schema', 'schema'])
    if (rawSchema !== undefined) format['schema'] = new RawJson(rawSchema)
    return format
  }
  return undefined
}

/**
 * Two-phase reasoning construction: the translator always sets
 * `reasoning.effort` (client value verbatim; `"medium"` when absent, `""`
 * when empty) and adds `summary:"auto"` for non-empty non-`"none"` efforts.
 * The capability strip then removes the whole object for models without
 * thinking support (the codex-api-key default).
 */
export function translateReasoning(request: Record<string, unknown>, thinkingCapability: boolean): WireObject | undefined {
  if (!thinkingCapability) return undefined
  const raw = request['reasoning_effort']
  const effort = typeof raw === 'string' ? raw : DEFAULT_REASONING_EFFORT
  const reasoning: WireObject = { effort }
  if (effort.length > 0 && effort !== 'none') reasoning['summary'] = 'auto'
  return reasoning
}

/** All tool names of the request, in mapping order: tools, tool_choice, history. */
function collectAllToolNames(request: Record<string, unknown>, tools: readonly unknown[]): string[] {
  const names: string[] = []
  for (const entry of tools) {
    if (typeof entry !== 'object' || entry === null) continue
    const name = declaredToolName(entry as Record<string, unknown>)
    if (name !== undefined) names.push(name)
  }
  const toolChoice = request['tool_choice']
  if (typeof toolChoice === 'object' && toolChoice !== null) {
    const record = toolChoice as Record<string, unknown>
    const name =
      record['type'] === 'function'
        ? readString(readObject(record, 'function'), 'name')
        : readString(record, 'name')
    if (typeof name === 'string') names.push(name)
  }
  const messages = readArray(request, 'messages') ?? []
  for (const message of messages) {
    if (typeof message !== 'object' || message === null) continue
    const calls = (message as Record<string, unknown>)['tool_calls']
    if (!Array.isArray(calls)) continue
    for (const call of calls) {
      if (typeof call !== 'object' || call === null) continue
      const name = readString(readObject(call as Record<string, unknown>, 'function'), 'name')
      if (typeof name === 'string') names.push(name)
    }
  }
  return names
}
