/**
 * Request translation: OpenAI Chat Completions -> Claude Messages.
 *
 * The function reproduces the full recorded pipeline for this direction:
 * the translator stage (template + ordered appends, message mapping, tool
 * normalization, thinking derivation) and the executor stages that are
 * observable on the wire (model rewrite, thinking capability strip,
 * sampling-knob deletion, default cache breakpoints, `stream:true`). The
 * output body is byte-exact contract material (S2d3 sections 2.4-2.6).
 */
import { CpaError } from '@cpa-edge/core'
import { parseStrictJson, readArray, readObject, readString, rawValueAt, serializeOrdered, wireObject } from './json'
import { claudeCodeCliSystemBlocks, claudeCodeCliDateContextBlock, claudeCodeCliUserId, CLAUDE_CODE_CLI_CACHE_CONTROL } from './profile'
import { normalizeToolInputSchema, parseToolArguments, sanitizeClaudeToolId } from './schema'
import { deriveClaudeUserId, firstUserMessageText } from './userid'
import type {
  ChatToClaudeContext,
  ClaudeCodeCliIdentity,
  ClaudeUpstreamRequest,
  ModelSuffix,
  WireObject,
  WireValue,
} from './types'

/** Template default when the client sends neither max_tokens variant. */
export const CLAUDE_DEFAULT_MAX_TOKENS = 32000

/** Instruction appended for `response_format: {"type":"json_object"}`. */
export const JSON_OBJECT_INSTRUCTION =
  'You must format your entire response as valid JSON. Do not include any explanations, markdown code blocks (such as ```json), or any text outside of the JSON object.'

const JSON_SCHEMA_PREFIX =
  'You must format your entire response as valid JSON that conforms strictly to the following JSON schema:'
const JSON_SCHEMA_CLOSING =
  'Do not include any explanations, markdown code blocks (such as ```json), or any text outside of the JSON object.'

/** Effort level -> thinking token budget (ConvertLevelToBudget). */
const EFFORT_BUDGETS: Readonly<Record<string, number>> = Object.freeze({
  minimal: 512,
  low: 1024,
  medium: 8192,
  high: 24576,
  xhigh: 32768,
  max: 128000,
})

const CACHE_BREAKPOINT_LIMIT = 4

interface TranslatedMessage {
  readonly role: 'user' | 'assistant'
  content: WireObject[]
}

/** Parses a `(4096)` style model suffix. */
export function parseModelSuffix(name: string): ModelSuffix | undefined {
  const match = /^(.*)\((\d+)\)$/.exec(name)
  if (match === null) return undefined
  const base = (match[1] ?? '').trim()
  const budget = Number(match[2])
  return { base, budgetTokens: Number.isFinite(budget) ? budget : undefined }
}

/**
 * Translates one client request into the final upstream Claude body.
 *
 * @param rawBody the client's request body bytes as text
 * @param ctx serving configuration for this request (model, capabilities,
 *   fingerprint profile)
 * @returns the upstream body (serialized + parsed) and the parsed suffix
 * @throws CpaError `invalid-input` when the body is not strict JSON
 */
export async function translateChatToClaude(
  rawBody: string,
  ctx: ChatToClaudeContext,
): Promise<ClaudeUpstreamRequest> {
  const parsed: unknown = parseStrictJson(rawBody)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CpaError('invalid-input', 'Invalid request: malformed JSON body')
  }
  const request = parsed as Record<string, unknown>

  const clientModel = readString(request, 'model') ?? ''
  const suffix = parseModelSuffix(clientModel)
  const model = ctx.upstreamModel ?? (suffix !== undefined ? suffix.base : clientModel)

  const maxTokens = readMaxTokens(request)

  const systemBlocks: WireObject[] = []
  const conversational: TranslatedMessage[] = []
  const toolResultIndex = new Map<string, number>()

  const messages = readArray(request, 'messages') ?? []
  for (const message of messages) {
    if (typeof message !== 'object' || message === null) continue
    const record = message as Record<string, unknown>
    const role = record['role']

    if (role === 'system' || role === 'developer') {
      for (const block of systemContentBlocks(record['content'])) systemBlocks.push(block)
      continue
    }

    if (role === 'tool') {
      appendToolResult(conversational, toolResultIndex, record)
      continue
    }

    if (role === 'user') {
      const blocks = contentBlocks(record['content'])
      applyMessageCacheControl(blocks, record)
      appendMerged(conversational, { role: 'user', content: blocks })
      continue
    }

    if (role === 'assistant') {
      const blocks: WireObject[] = []
      const reasoning = record['reasoning_content']
      if (ctx.compat === true && typeof reasoning === 'string' && reasoning.length > 0) {
        blocks.push({ type: 'thinking', thinking: reasoning, signature: '' })
      }
      for (const block of contentBlocks(record['content'])) blocks.push(block)
      for (const block of toolCallBlocks(record['tool_calls'])) blocks.push(block)
      applyMessageCacheControl(blocks, record)
      appendMerged(conversational, { role: 'assistant', content: blocks })
    }
  }

  if (conversational.length === 0) {
    conversational.push({ role: 'user', content: [{ type: 'text', text: '' }] })
  }

  const responseFormat = readObject(request, 'response_format')
  if (responseFormat !== undefined) {
    const instruction = structuredOutputInstruction(responseFormat, rawBody)
    if (instruction !== undefined) systemBlocks.push({ type: 'text', text: instruction })
  }

  const tools = translateTools(readArray(request, 'tools') ?? [])
  const toolChoice = translateToolChoice(request['tool_choice'])
  const stopSequences = translateStop(request['stop'])

  const systemTexts = systemBlocks
    .map((block) => (typeof block['text'] === 'string' ? block['text'] : ''))
    .filter((text) => text.length > 0)

  let userId: string
  if (ctx.fingerprintProfile === 'claude-code-cli' && ctx.cliIdentity !== undefined) {
    userId = claudeCodeCliUserId(ctx.cliIdentity)
  } else {
    userId = await deriveClaudeUserId({ request, systemTexts, model })
  }

  const thinking = resolveThinking(ctx, request, suffix, maxTokens, toolChoice)

  const body: WireObject = {
    model,
    max_tokens: maxTokens,
    messages: conversational.map((message) => ({ role: message.role, content: message.content })),
    metadata: { user_id: userId },
  }
  let outputConfig: WireObject | undefined
  if (thinking !== undefined) {
    if (thinking.kind === 'outputConfig') {
      body['thinking'] = thinking.thinking
      outputConfig = { effort: thinking.effort }
    } else {
      body['thinking'] = thinking.thinking
    }
  }
  if (stopSequences !== undefined) body['stop_sequences'] = stopSequences
  body['stream'] = true
  if (outputConfig !== undefined) body['output_config'] = outputConfig
  if (systemBlocks.length > 0) body['system'] = systemBlocks
  if (tools.length > 0) body['tools'] = tools
  if (toolChoice !== undefined) body['tool_choice'] = toolChoice

  if (ctx.fingerprintProfile === 'claude-code-cli' && ctx.cliIdentity !== undefined) {
    applyClaudeCodeCliCloak(body, ctx.cliIdentity)
  }

  ensureCacheControl(body)
  enforceCacheControlLimit(body)

  return { body: serializeOrdered(body), value: body, modelSuffix: suffix }
}

function readMaxTokens(request: Record<string, unknown>): number {
  for (const key of ['max_tokens', 'max_completion_tokens'] as const) {
    const raw = request[key]
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  }
  return CLAUDE_DEFAULT_MAX_TOKENS
}

/** System/developer content -> ordered text blocks. */
function systemContentBlocks(content: unknown): WireObject[] {
  const blocks: WireObject[] = []
  if (typeof content === 'string') {
    if (content.length > 0) blocks.push({ type: 'text', text: content })
    return blocks
  }
  if (!Array.isArray(content)) return blocks
  for (const part of content) {
    if (typeof part !== 'object' || part === null) continue
    const record = part as Record<string, unknown>
    if (record['type'] !== 'text') continue
    const cacheControl = readObject(record, 'cache_control')
    if (cacheControl !== undefined) {
      blocks.push({ type: 'text', text: readString(record, 'text') ?? '', cache_control: wireObject(cacheControl) })
    } else {
      blocks.push({ type: 'text', text: readString(record, 'text') ?? '' })
    }
  }
  return blocks
}

/** User/assistant content -> converted part blocks (unknown parts dropped). */
function contentBlocks(content: unknown): WireObject[] {
  const blocks: WireObject[] = []
  if (typeof content === 'string') {
    if (content.length > 0) blocks.push({ type: 'text', text: content })
    return blocks
  }
  if (!Array.isArray(content)) return blocks
  for (const part of content) {
    if (typeof part === 'string') {
      if (part.length > 0) blocks.push({ type: 'text', text: part })
      continue
    }
    if (typeof part !== 'object' || part === null) continue
    const block = convertContentPart(part as Record<string, unknown>)
    if (block !== undefined) blocks.push(block)
  }
  return blocks
}

/** Converts one OpenAI content part to a Claude content block. */
function convertContentPart(part: Record<string, unknown>): WireObject | undefined {
  const type = part['type']
  if (type === 'text') {
    return withCacheControl({ type: 'text', text: readString(part, 'text') ?? '' }, part)
  }
  if (type === 'image_url') {
    const image = readObject(part, 'image_url')
    const url = image !== undefined ? readString(image, 'url') : undefined
    if (url === undefined) return undefined
    if (url.startsWith('data:')) {
      const dataUrl = parseDataUrl(url)
      if (dataUrl === undefined) return undefined
      return withCacheControl(
        {
          type: 'image',
          source: { type: 'base64', media_type: dataUrl.mediaType, data: dataUrl.data },
        },
        part,
      )
    }
    return withCacheControl({ type: 'image', source: { type: 'url', url } }, part)
  }
  if (type === 'file') {
    const file = readObject(part, 'file')
    const data = file !== undefined ? readString(file, 'file_data') : undefined
    if (data === undefined || !data.startsWith('data:')) return undefined
    const dataUrl = parseDataUrl(data)
    if (dataUrl === undefined) return undefined
    return withCacheControl(
      {
        type: 'document',
        source: { type: 'base64', media_type: dataUrl.mediaType, data: dataUrl.data },
      },
      part,
    )
  }
  return undefined
}

function withCacheControl(block: WireObject, part: Record<string, unknown>): WireObject {
  const cacheControl = readObject(part, 'cache_control')
  if (cacheControl === undefined) return block
  block['cache_control'] = wireObject(cacheControl)
  return block
}

interface DataUrl {
  readonly mediaType: string
  readonly data: string
}

function parseDataUrl(url: string): DataUrl | undefined {
  const comma = url.indexOf(',')
  if (comma < 0) return undefined
  const meta = url.slice(5, comma)
  const data = url.slice(comma + 1)
  const base = meta.endsWith(';base64') ? meta.slice(0, -7) : meta
  return { mediaType: base.length > 0 ? base : 'application/octet-stream', data }
}

/** Message-level cache_control lands on the last block, part-level wins. */
function applyMessageCacheControl(blocks: WireObject[], message: Record<string, unknown>): void {
  const cacheControl = readObject(message, 'cache_control')
  if (cacheControl === undefined || blocks.length === 0) return
  const last = blocks[blocks.length - 1]
  if (last !== undefined && last['cache_control'] === undefined) {
    last['cache_control'] = wireObject(cacheControl)
  }
}

/** Assistant `tool_calls` -> trailing `tool_use` blocks. */
function toolCallBlocks(toolCalls: unknown): WireObject[] {
  if (!Array.isArray(toolCalls)) return []
  const blocks: WireObject[] = []
  for (const call of toolCalls) {
    if (typeof call !== 'object' || call === null) continue
    const record = call as Record<string, unknown>
    if (record['type'] !== undefined && record['type'] !== 'function') continue
    const fn = readObject(record, 'function')
    if (fn === undefined) continue
    const name = readString(fn, 'name') ?? ''
    const id = readString(record, 'id')
    const toolUse: WireObject = {
      type: 'tool_use',
      id: id !== undefined ? sanitizeClaudeToolId(id) : crypto.randomUUID(),
      name,
      input: parseToolArguments(readString(fn, 'arguments')),
    }
    const cacheControl = readObject(record, 'cache_control') ?? readObject(fn, 'cache_control')
    if (cacheControl !== undefined) toolUse['cache_control'] = wireObject(cacheControl)
    blocks.push(toolUse)
  }
  return blocks
}

/**
 * Appends a `tool` message as a user tool_result item. Repeated ids keep
 * their first position and take content from the LAST occurrence.
 */
function appendToolResult(
  conversational: TranslatedMessage[],
  toolResultIndex: Map<string, number>,
  record: Record<string, unknown>,
): void {
  const rawId = readString(record, 'tool_call_id') ?? ''
  const id = sanitizeClaudeToolId(rawId)
  const block: WireObject = { type: 'tool_result', tool_use_id: id }
  const content = toolResultContent(record['content'])
  if (content !== undefined) block['content'] = content
  applyToolResultCacheControl(block, record)

  const existing = toolResultIndex.get(rawId)
  if (existing !== undefined) {
    const message = conversational[existing]
    if (message !== undefined) {
      const index = message.content.findIndex((item) => item['type'] === 'tool_result' && item['tool_use_id'] === id)
      const target = message.content[index]
      if (target !== undefined) {
        const updated: WireObject = { ...target }
        if (content !== undefined) updated['content'] = content
        delete updated['cache_control']
        applyToolResultCacheControl(updated, record)
        message.content[index] = updated
      }
    }
    return
  }

  toolResultIndex.set(rawId, conversational.length)
  appendMerged(conversational, { role: 'user', content: [block] })
}

function applyToolResultCacheControl(block: WireObject, record: Record<string, unknown>): void {
  const cacheControl = readObject(record, 'cache_control')
  if (cacheControl !== undefined) block['cache_control'] = wireObject(cacheControl)
}

function toolResultContent(content: unknown): WireValue | undefined {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const blocks: WireValue[] = []
    for (const part of content) {
      if (typeof part === 'string') {
        if (part.length > 0) blocks.push({ type: 'text', text: part })
        continue
      }
      if (typeof part !== 'object' || part === null) continue
      const block = convertContentPart(part as Record<string, unknown>)
      if (block !== undefined) blocks.push(block)
    }
    return blocks
  }
  if (typeof content === 'object' && content !== null) {
    const block = convertContentPart(content as Record<string, unknown>)
    return block
  }
  return undefined
}

/** Consecutive same-role merging; 0-part messages are dropped. */
function appendMerged(conversational: TranslatedMessage[], message: TranslatedMessage): void {
  if (message.content.length === 0) return
  const last = conversational[conversational.length - 1]
  if (last !== undefined && last.role === message.role) {
    if (message.role === 'assistant') {
      const textBlocks: WireObject[] = []
      const toolBlocks: WireObject[] = []
      for (const block of [...last.content, ...message.content]) {
        if (block['type'] === 'tool_use') toolBlocks.push(block)
        else textBlocks.push(block)
      }
      last.content = [...textBlocks, ...toolBlocks]
    } else {
      last.content = [...last.content, ...message.content]
    }
    return
  }
  conversational.push(message)
}

/** `tools[]` -> Claude tool objects with normalized input_schema. */
function translateTools(tools: readonly unknown[]): WireObject[] {
  const out: WireObject[] = []
  for (const entry of tools) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    if (record['type'] !== 'function') continue
    const fn = readObject(record, 'function')
    if (fn === undefined) continue
    const tool: WireObject = { name: readString(fn, 'name') ?? '' }
    const description = readString(fn, 'description')
    if (description !== undefined) tool['description'] = description
    const parameters = firstSchema(fn, record)
    if (parameters !== undefined) {
      const schema = normalizeToolInputSchema(parameters)
      if (schema !== undefined) tool['input_schema'] = schema
    }
    const cacheControl = readObject(record, 'cache_control') ?? readObject(fn, 'cache_control')
    if (cacheControl !== undefined) tool['cache_control'] = wireObject(cacheControl)
    out.push(tool)
  }
  return out
}

function firstSchema(fn: Record<string, unknown>, record: Record<string, unknown>): unknown {
  for (const source of [fn, record] as const) {
    for (const key of ['parameters', 'parametersJsonSchema'] as const) {
      const raw = source[key]
      if (typeof raw === 'object' && raw !== null) return raw
    }
  }
  return undefined
}

/** `tool_choice` mapping; `none` and unknown values are omitted. */
function translateToolChoice(raw: unknown): WireObject | undefined {
  if (raw === 'auto') return { type: 'auto' }
  if (raw === 'required') return { type: 'any' }
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  if (record['type'] !== 'function') return undefined
  const fn = readObject(record, 'function')
  const name = fn !== undefined ? readString(fn, 'name') : undefined
  if (name === undefined) return undefined
  return { type: 'tool', name }
}

/** `stop` mapping: single strings always wrap, empty arrays are omitted. */
function translateStop(raw: unknown): readonly string[] | undefined {
  if (typeof raw === 'string') return [raw]
  if (!Array.isArray(raw)) return undefined
  const stops = raw.filter((item): item is string => typeof item === 'string')
  if (raw.length === 0 || stops.length === 0) return undefined
  return stops
}

/**
 * Builds the structured-output instruction appended to the system blocks.
 * The schema JSON is embedded with its RAW client bytes (spacing included).
 */
function structuredOutputInstruction(
  responseFormat: Record<string, unknown>,
  rawBody: string,
): string | undefined {
  const type = responseFormat['type']
  if (type === 'json_object') return JSON_OBJECT_INSTRUCTION
  if (type !== 'json_schema') return undefined
  const jsonSchema = readObject(responseFormat, 'json_schema')
  const schemaObject = jsonSchema ?? responseFormat
  const name = readString(schemaObject, 'name')
  const description = readString(schemaObject, 'description')
  const lines: string[] = [JSON_SCHEMA_PREFIX]
  if (name !== undefined && name.length > 0) lines.push(`Schema Name: ${name}`)
  if (description !== undefined && description.length > 0) lines.push(`Schema Description: ${description}`)
  lines.push('JSON Schema:')
  lines.push(rawSchemaText(responseFormat, schemaObject, rawBody))
  lines.push(JSON_SCHEMA_CLOSING)
  return lines.join('\n')
}

function rawSchemaText(
  responseFormat: Record<string, unknown>,
  schemaObject: Record<string, unknown>,
  rawBody: string,
): string {
  const raw = rawValueAt(rawBody, ['response_format', 'json_schema', 'schema'])
  if (raw !== undefined) return raw
  const fallback = rawValueAt(rawBody, ['response_format', 'schema'])
  if (fallback !== undefined) return fallback
  const parsed = schemaObject['schema']
  if (parsed === undefined) return ''
  return serializeOrdered(parsed as WireValue)
}

type ThinkingResult =
  | { readonly kind: 'thinking'; readonly thinking: WireObject }
  | { readonly kind: 'outputConfig'; readonly thinking: WireObject; readonly effort: string }

/**
 * thinking-config resolution (S2d3 section 2.6): the effort (or model-suffix
 * budget) is converted first, then the model-entry capability decides
 * whether the config survives the wire. Absent capability strips it.
 */
function resolveThinking(
  ctx: ChatToClaudeContext,
  request: Record<string, unknown>,
  suffix: ModelSuffix | undefined,
  maxTokens: number,
  toolChoice: WireObject | undefined,
): ThinkingResult | undefined {
  const forced =
    toolChoice !== undefined &&
    (toolChoice['type'] === 'any' || toolChoice['type'] === 'tool')

  const rawEffort = readString(request, 'reasoning_effort')
  const effort = rawEffort !== undefined ? rawEffort.trim().toLowerCase() : ''
  const capability = ctx.thinking

  if (effort.length > 0) {
    if (effort === 'none') {
      if (capability === undefined) return undefined
      if (forced) return undefined
      return { kind: 'thinking', thinking: { type: 'disabled' } }
    }
    if (capability === undefined) return undefined
    if (capability.kind === 'levels') {
      if (forced) return undefined
      return {
        kind: 'outputConfig',
        thinking: { type: 'adaptive', display: 'summarized' },
        effort,
      }
    }
    if (effort === 'auto') {
      if (forced) return undefined
      return { kind: 'thinking', thinking: { type: 'enabled', display: 'summarized' } }
    }
    const budget = EFFORT_BUDGETS[effort]
    if (budget === undefined) return undefined
    if (forced) return undefined
    return { kind: 'thinking', thinking: budgetThinking(capability, budget, maxTokens) }
  }

  if (suffix?.budgetTokens !== undefined && capability !== undefined && !forced) {
    if (capability.kind === 'budget') {
      return { kind: 'thinking', thinking: budgetThinking(capability, suffix.budgetTokens, maxTokens) }
    }
  }
  return undefined
}

function budgetThinking(
  capability: { readonly kind: 'budget'; readonly min: number; readonly max: number } | { readonly kind: 'levels'; readonly levels: readonly string[] },
  budget: number,
  maxTokens: number,
): WireObject {
  let tokens = budget
  if (capability.kind === 'budget') {
    tokens = Math.min(Math.max(tokens, capability.min), capability.max)
  }
  const ceiling = Math.max(maxTokens - 1, 1)
  tokens = Math.min(tokens, ceiling)
  return { type: 'enabled', budget_tokens: tokens, display: 'summarized' }
}

/** CLI fingerprint profile body cloak (S2d3 case 21). */
function applyClaudeCodeCliCloak(body: WireObject, identity: ClaudeCodeCliIdentity): void {
  const system = body['system']
  if (Array.isArray(system)) {
    body['system'] = [...claudeCodeCliSystemBlocks(), ...(system as WireObject[])]
  } else {
    body['system'] = claudeCodeCliSystemBlocks()
  }
  const messages = body['messages']
  if (Array.isArray(messages)) {
    for (const message of messages as WireObject[]) {
      if (message['role'] !== 'user') continue
      const content = message['content']
      if (!Array.isArray(content)) break
      message['content'] = [claudeCodeCliDateContextBlock(identity.date), ...(content as WireObject[])]
      break
    }
  }
  const lastBlock = lastEligibleBlock(body)
  if (lastBlock !== undefined) lastBlock['cache_control'] = { ...CLAUDE_CODE_CLI_CACHE_CONTROL }
}

/** Last content block of the last eligible message (thinking-ending turns skip). */
function lastEligibleBlock(body: Readonly<WireObject>): WireObject | undefined {
  const messages = body['messages']
  if (!Array.isArray(messages)) return undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (typeof message !== 'object' || message === null) continue
    const record = message as WireObject
    const role = record['role']
    if (role !== 'user' && role !== 'assistant') continue
    const content = record['content']
    if (!Array.isArray(content) || content.length === 0) continue
    const blocks = content as WireObject[]
    const last = blocks[blocks.length - 1]
    if (last === undefined) continue
    const type = last['type']
    if (type === 'thinking' || type === 'redacted_thinking') continue
    return last
  }
  return undefined
}

/** Counts `cache_control` markers anywhere in the body. */
function countCacheMarkers(value: unknown): number {
  if (Array.isArray(value)) {
    let total = 0
    for (const item of value) total += countCacheMarkers(item)
    return total
  }
  if (typeof value !== 'object' || value === null) return 0
  const record = value as Record<string, unknown>
  let total = record['cache_control'] !== undefined ? 1 : 0
  for (const key of Object.keys(record)) {
    if (key === 'cache_control') continue
    total += countCacheMarkers(record[key])
  }
  return total
}

/**
 * Default cache breakpoints (S2d3 section 2.5 step 7): only injected when the
 * payload carries no marker at all. Tools get one only when there is no
 * cacheable system; the last system block and the last eligible message
 * block each get one.
 */
function ensureCacheControl(body: WireObject): void {
  if (countCacheMarkers(body) > 0) return
  const system = body['system']
  const tools = body['tools']

  if (!Array.isArray(system) || system.length === 0) {
    if (Array.isArray(tools) && tools.length > 0) {
      for (let i = tools.length - 1; i >= 0; i--) {
        const tool = tools[i]
        if (typeof tool !== 'object' || tool === null) continue
        const record = tool as WireObject
        if (record['defer_loading'] === true) continue
        record['cache_control'] = { type: 'ephemeral' }
        break
      }
    }
  } else {
    const blocks = system as WireObject[]
    const last = blocks[blocks.length - 1]
    if (last !== undefined) last['cache_control'] = { type: 'ephemeral' }
  }

  const lastBlock = lastEligibleBlock(body)
  if (lastBlock !== undefined && lastBlock['cache_control'] === undefined) {
    lastBlock['cache_control'] = { type: 'ephemeral' }
  }
}

/**
 * Breakpoint limit (S2d3 section 2.5 step 8): above 4 markers only each
 * section's last marker survives, sections handled system -> tools ->
 * messages.
 */
function enforceCacheControlLimit(body: WireObject): void {
  if (countCacheMarkers(body) <= CACHE_BREAKPOINT_LIMIT) return
  for (const key of ['system', 'tools', 'messages'] as const) {
    const section = body[key]
    if (!Array.isArray(section)) continue
    const holders: Record<string, unknown>[] = []
    for (const item of section) collectMarkerHolders(item, holders)
    // Keep the section's LAST breakpoint; drop every earlier one.
    for (let i = 0; i < holders.length - 1; i++) {
      const holder = holders[i]
      if (holder !== undefined) delete holder['cache_control']
    }
  }
}

/** Marker-holding objects of one section, in wire order. */
function collectMarkerHolders(value: unknown, holders: Record<string, unknown>[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectMarkerHolders(item, holders)
    return
  }
  if (typeof value !== 'object' || value === null) return
  const record = value as Record<string, unknown>
  if (record['cache_control'] !== undefined) holders.push(record)
  for (const key of Object.keys(record)) {
    if (key !== 'cache_control') collectMarkerHolders(record[key], holders)
  }
}

export { firstUserMessageText }
