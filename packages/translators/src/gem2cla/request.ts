/**
 * Request translation: Gemini GenerateContent -> Claude Messages.
 *
 * The function reproduces the recorded pipeline for this direction: the
 * translator stage (contents mapping, system-instruction handling, tools,
 * thinking derivation, tool-call pairing) plus the executor stages that are
 * observable on the wire (model rewrite, thinking-capability strip, forced
 * tool_choice thinking deletion, sampling-knob omission, default cache
 * breakpoints, `stream:true`). The upstream body is byte-exact contract
 * material (S2d7 sections 2.2-2.4).
 */
import { CpaError } from '@cpa-edge/core'
import {
  isPlainObject,
  parseStrictJson,
  rawValueAt,
  readArray,
  readObject,
  readString,
  serializeOrdered,
} from './json'
import { RawJson } from './json'
import type { WireObject, WireValue } from './json'
import { claudeToolObject } from './schema'
import { deriveClaudeUserId, metadataObject } from './userid'
import type {
  ClaudeContentAssembly,
  ClaudeUpstreamRequest,
  GeminiToClaudeContext,
  ModelThinkingCapability,
} from './types'

/** Translator default when the client sends no `maxOutputTokens`. */
export const CLAUDE_DEFAULT_MAX_TOKENS = 32000

/** Prefix and zero padding of the request-local generated tool ids. */
export const GENERATED_TOOL_ID_PREFIX = 'toolu_gemini_'

/** Effort level -> thinking token budget (recorded level map). */
const LEVEL_BUDGETS: Readonly<Record<string, number>> = Object.freeze({
  minimal: 512,
  low: 1024,
  medium: 8192,
  high: 24576,
  xhigh: 32768,
  max: 128000,
})

/** A string with content after trimming; blank values never qualify. */
function nonBlank(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

interface TranslatedMessage {
  readonly role: 'user' | 'assistant'
  content: WireObject[]
}

/** Per-request tool-id state: the FIFO of unclaimed tool_use ids. */
interface ToolPairingState {
  pendingToolUseIds: string[]
  counter: number
}

function nextGeneratedToolId(state: ToolPairingState): string {
  state.counter += 1
  return `${GENERATED_TOOL_ID_PREFIX}${state.counter.toString().padStart(16, '0')}`
}

// ---------------------------------------------------------------------------
// Content assembly (shared by generation and token counting)
// ---------------------------------------------------------------------------

/**
 * Assembles the Claude-side content of a Gemini request: messages (with
 * system-instruction and merge rules), tools and tool_choice. Token
 * counting runs over exactly this shape.
 */
export function assembleClaudeContent(rawBody: string): ClaudeContentAssembly {
  const parsed = parseStrictJson(rawBody)
  if (!isPlainObject(parsed)) {
    throw new CpaError('invalid-input', 'Invalid request: malformed JSON body')
  }
  return assembleFromRequest(parsed, rawBody)
}

function assembleFromRequest(request: Record<string, unknown>, rawBody: string): ClaudeContentAssembly {
  const messages: TranslatedMessage[] = []
  const state: ToolPairingState = { pendingToolUseIds: [], counter: 0 }

  const systemText = systemInstructionText(request)
  if (systemText !== undefined) {
    // The system text becomes its own leading USER turn; the barrier keeps
    // the first contents turn from merging into it (recorded: S2d7-04).
    messages.push({ role: 'user', content: [{ type: 'text', text: systemText }] })
  }

  const contents = readArray(request, 'contents') ?? []
  for (let index = 0; index < contents.length; index++) {
    const turn = contents[index]
    if (!isPlainObject(turn)) continue
    const mapped = mapTurnRole(turn['role'])
    if (mapped === undefined) continue
    const blocks = turnBlocks(turn, mapped, index, rawBody, state)
    // The barrier guards ONE boundary: while the system turn is still the
    // only message, no contents turn may merge into it. From the first
    // contents message on, same-role merging resumes (S2d7 2.3).
    appendMerged(
      messages,
      { role: mapped, content: blocks },
      systemText !== undefined && messages.length === 1,
    )
  }

  const tools = translateTools(request)
  const toolChoice = translateToolChoice(request)
  return {
    messages: messages.map((message) => ({ role: message.role, content: message.content })),
    tools,
    toolChoice,
  }
}

/** Maps a Gemini turn role; unmapped roles (incl. missing) drop the turn. */
function mapTurnRole(role: unknown): 'user' | 'assistant' | undefined {
  if (role === 'model') return 'assistant'
  if (role === 'user' || role === 'assistant') return role
  if (role === 'function' || role === 'tool') return 'user'
  return undefined
}

/**
 * System instruction: ONLY the snake_case key is read. It must be an object
 * with a `parts` array; the non-thought text parts join into one block.
 * Anything else (camelCase key, plain string, no text parts) is dropped.
 */
function systemInstructionText(request: Record<string, unknown>): string | undefined {
  const instruction = readObject(request, 'system_instruction')
  if (instruction === undefined) return undefined
  const parts = readArray(instruction, 'parts')
  if (parts === undefined) return undefined
  const texts: string[] = []
  for (const part of parts) {
    if (!isPlainObject(part)) continue
    if (part['thought'] === true) continue
    const text = part['text']
    if (typeof text === 'string') texts.push(text)
  }
  if (texts.length === 0) return undefined
  return texts.join('\n')
}

/** Converts one turn's parts to Claude blocks (assistant tool blocks last). */
function turnBlocks(
  turn: Record<string, unknown>,
  mapped: 'user' | 'assistant',
  index: number,
  rawBody: string,
  state: ToolPairingState,
): WireObject[] {
  const parts = readArray(turn, 'parts') ?? []
  const blocks: WireObject[] = []
  const toolBlocks: WireObject[] = []
  for (let position = 0; position < parts.length; position++) {
    const part = parts[position]
    if (!isPlainObject(part)) continue
    if (part['thought'] === true) continue
    const basePath = ['contents', String(index), 'parts', String(position)]

    const call = readObject(part, 'functionCall')
    if (call !== undefined) {
      // functionCall parts are honored in model (assistant) turns only; a
      // functionCall inside a user turn is dropped.
      if (mapped === 'assistant') toolBlocks.push(toolUseBlock(call, basePath, rawBody, state))
      continue
    }

    const response = readObject(part, 'functionResponse')
    if (response !== undefined) {
      blocks.push(toolResultBlock(response, basePath, rawBody, state))
      continue
    }

    const text = part['text']
    if (typeof text === 'string') {
      blocks.push({ type: 'text', text })
      continue
    }

    const inline = readObject(part, 'inlineData') ?? readObject(part, 'inline_data')
    if (inline !== undefined) {
      const block = inlineDataBlock(inline)
      if (block !== undefined) blocks.push(block)
      continue
    }

    const file = readObject(part, 'fileData') ?? readObject(part, 'file_data')
    if (file !== undefined) {
      const block = fileDataBlock(file)
      if (block !== undefined) blocks.push(block)
    }
  }
  return mapped === 'assistant' ? [...blocks, ...toolBlocks] : blocks
}

/** `functionCall` -> `tool_use` with FIFO-generated ids and raw args bytes. */
function toolUseBlock(
  call: Record<string, unknown>,
  basePath: readonly string[],
  rawBody: string,
  state: ToolPairingState,
): WireObject {
  const explicit = nonBlank(call['id']) ?? nonBlank(call['call_id'])
  const id = explicit !== undefined ? explicit : nextGeneratedToolId(state)
  state.pendingToolUseIds.push(id)
  const name = typeof call['name'] === 'string' ? call['name'] : ''
  let input: WireValue = {}
  if (isPlainObject(call['args'])) {
    const raw = rawValueAt(rawBody, [...basePath, 'functionCall', 'args'])
    input = raw !== undefined ? new RawJson(raw) : (call['args'] as WireObject)
  }
  return { type: 'tool_use', id, name, input }
}

/**
 * `functionResponse` -> `tool_result`. The tool_use id resolves through the
 * explicit `id`/`call_id`, then the FIFO of pending tool_use ids, then a
 * fresh generated id. Content comes from `response.result` (stringified),
 * then the raw `response` JSON, then the skeleton's empty string.
 */
function toolResultBlock(
  response: Record<string, unknown>,
  basePath: readonly string[],
  rawBody: string,
  state: ToolPairingState,
): WireObject {
  const explicit = nonBlank(response['id']) ?? nonBlank(response['call_id'])
  let toolUseId: string
  if (explicit !== undefined) {
    const pending = state.pendingToolUseIds.indexOf(explicit)
    if (pending >= 0) state.pendingToolUseIds.splice(pending, 1)
    toolUseId = explicit
  } else {
    const oldest = state.pendingToolUseIds.shift()
    toolUseId = oldest !== undefined ? oldest : nextGeneratedToolId(state)
  }

  let content = ''
  const rawResponse = response['response']
  if (isPlainObject(rawResponse) && rawResponse['result'] !== undefined) {
    const result = rawResponse['result']
    if (typeof result === 'string') {
      content = result
    } else {
      const raw = rawValueAt(rawBody, [...basePath, 'functionResponse', 'response', 'result'])
      content = raw !== undefined ? raw : serializeOrdered(result as WireValue)
    }
  } else if (rawResponse !== undefined) {
    const raw = rawValueAt(rawBody, [...basePath, 'functionResponse', 'response'])
    if (raw !== undefined) content = unquoteIfString(raw)
    else if (typeof rawResponse === 'string') content = rawResponse
    else content = serializeOrdered(rawResponse as WireValue)
  }
  return { type: 'tool_result', tool_use_id: toolUseId, content }
}

/** Raw JSON of a string value keeps its quotes; the wire wants them gone. */
function unquoteIfString(raw: string): string {
  if (!raw.startsWith('"')) return raw
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'string' ? parsed : raw
  } catch {
    return raw
  }
}

/** `inlineData` -> image / document blocks, or a media placeholder text. */
function inlineDataBlock(inline: Record<string, unknown>): WireObject | undefined {
  const mime = mediaTypeOf(inline)
  const data = readString(inline, 'data') ?? ''
  if (mime.length === 0 || data.length === 0) return undefined
  if (mime.startsWith('image/')) {
    return { type: 'image', source: { type: 'base64', media_type: mime, data } }
  }
  if (mime.startsWith('application/') || mime.startsWith('text/')) {
    return { type: 'document', source: { type: 'base64', media_type: mime, data } }
  }
  return { type: 'text', text: `Media content: inline data (Type: ${mime})` }
}

/** `fileData` -> url-backed image / document blocks, or a file placeholder. */
function fileDataBlock(file: Record<string, unknown>): WireObject | undefined {
  const mime = mediaTypeOf(file)
  const uri = readString(file, 'fileUri') ?? readString(file, 'file_uri') ?? ''
  if (uri.length === 0) return undefined
  if (mime.startsWith('image/')) {
    return { type: 'image', source: { type: 'url', url: uri } }
  }
  if (mime.startsWith('application/') || mime.startsWith('text/')) {
    const source: WireObject = { type: 'url', url: uri }
    if (mime.length > 0) source['media_type'] = mime
    return { type: 'document', source }
  }
  return { type: 'text', text: `File: ${uri} (Type: ${mime})` }
}

function mediaTypeOf(media: Record<string, unknown>): string {
  const mime = readString(media, 'mimeType') ?? readString(media, 'mime_type') ?? ''
  return mime
}

/** Consecutive same-role merging; zero-block turns drop. */
function appendMerged(
  messages: TranslatedMessage[],
  message: TranslatedMessage,
  barrierActive: boolean,
): void {
  if (message.content.length === 0) return
  const last = messages[messages.length - 1]
  if (last !== undefined && last.role === message.role && !barrierActive) {
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
  messages.push(message)
}

// ---------------------------------------------------------------------------
// Tools and tool choice
// ---------------------------------------------------------------------------

/** `tools[].functionDeclarations[]` -> Claude tool objects (sorted keys). */
function translateTools(request: Record<string, unknown>): WireObject[] {
  const entries = readArray(request, 'tools')
  if (entries === undefined) return []
  const tools: WireObject[] = []
  for (const entry of entries) {
    if (!isPlainObject(entry)) continue
    const declarations = readArray(entry, 'functionDeclarations')
    if (declarations === undefined) continue
    for (const declaration of declarations) {
      if (!isPlainObject(declaration)) continue
      tools.push(claudeToolObject(declaration))
    }
  }
  return tools
}

/**
 * `tool_config.function_calling_config` / `toolConfig.functionCallingConfig`
 * -> `tool_choice`. AUTO -> auto, NONE -> none, ANY -> tool (exactly one
 * allowed name) or any; other or absent modes emit nothing.
 */
function translateToolChoice(request: Record<string, unknown>): WireObject | undefined {
  const config = readObject(request, 'tool_config') ?? readObject(request, 'toolConfig')
  if (config === undefined) return undefined
  const calling = readObject(config, 'function_calling_config') ?? readObject(config, 'functionCallingConfig')
  if (calling === undefined) return undefined
  const mode = calling['mode']
  if (mode === 'AUTO') return { type: 'auto' }
  if (mode === 'NONE') return { type: 'none' }
  if (mode === 'ANY') {
    const names =
      readArray(calling, 'allowedFunctionNames') ?? readArray(calling, 'allowed_function_names') ?? []
    const allowed = names.filter((name): name is string => typeof name === 'string')
    if (allowed.length === 1) {
      const only = allowed[0]
      if (only !== undefined) return { type: 'tool', name: only }
    }
    return { type: 'any' }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Generation config
// ---------------------------------------------------------------------------

/**
 * `generationConfig.maxOutputTokens` -> `max_tokens`. Numeric strings parse;
 * any other present value coerces to 0; absence keeps the 32000 default.
 */
function readMaxTokens(request: Record<string, unknown>): number {
  const config = readObject(request, 'generationConfig')
  if (config === undefined) return CLAUDE_DEFAULT_MAX_TOKENS
  const raw = config['maxOutputTokens']
  if (raw === undefined) return CLAUDE_DEFAULT_MAX_TOKENS
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.trunc(raw)
  if (typeof raw === 'string' && raw.trim().length > 0) {
    const parsed = Number(raw)
    if (Number.isFinite(parsed)) return Math.trunc(parsed)
  }
  return 0
}

/** `generationConfig.stopSequences` -> `stop_sequences` (non-empty arrays). */
function readStopSequences(request: Record<string, unknown>): readonly string[] | undefined {
  const config = readObject(request, 'generationConfig')
  if (config === undefined) return undefined
  const raw = readArray(config, 'stopSequences')
  if (raw === undefined || raw.length === 0) return undefined
  const stops = raw.filter((stop): stop is string => typeof stop === 'string')
  return stops.length > 0 ? stops : undefined
}

interface ThinkingDecision {
  readonly thinking: WireObject | undefined
  readonly outputConfig: { readonly effort: string } | undefined
}

/**
 * Thinking resolution (S2d7 2.3): the level or budget is translated first,
 * then the model-entry capability decides survival (absent capability
 * strips the block - recorded: S2d7-08), and a forced `tool_choice`
 * (`any`/`tool`) deletes whatever survived.
 */
function resolveThinking(
  request: Record<string, unknown>,
  capability: ModelThinkingCapability | undefined,
  toolChoice: WireObject | undefined,
): ThinkingDecision {
  const config = readObject(request, 'generationConfig')
  const thinkingConfig =
    config !== undefined
      ? readObject(config, 'thinkingConfig') ?? readObject(config, 'thinking_config')
      : undefined
  if (thinkingConfig === undefined) return { thinking: undefined, outputConfig: undefined }

  const rawBudget = thinkingConfig['thinkingBudget'] ?? thinkingConfig['thinking_budget']
  const rawLevel = readString(thinkingConfig, 'thinkingLevel') ?? readString(thinkingConfig, 'thinking_level')
  const level = rawLevel !== undefined ? rawLevel.trim().toLowerCase() : ''

  let thinking: WireObject | undefined
  let fromLevel = false
  if (typeof rawBudget === 'number' && Number.isFinite(rawBudget)) {
    thinking = budgetThinking(Math.trunc(rawBudget))
  } else if (level.length > 0) {
    fromLevel = true
    if (level === 'none') thinking = { type: 'disabled' }
    else if (level === 'auto') thinking = { type: 'enabled' }
    else {
      const budget = LEVEL_BUDGETS[level]
      if (budget !== undefined) thinking = { type: 'enabled', budget_tokens: budget }
    }
  }
  if (thinking === undefined) return { thinking: undefined, outputConfig: undefined }

  if (capability === undefined) {
    // Capability-less models (config-declared API-key models without
    // thinking metadata) lose the translated block entirely (S2d7-08).
    return { thinking: undefined, outputConfig: undefined }
  }
  if (capability.kind === 'levels' && fromLevel && thinking['type'] === 'enabled') {
    // Registry-known adaptive models map a level to the adaptive shape.
    if (
      toolChoice !== undefined &&
      (toolChoice['type'] === 'any' || toolChoice['type'] === 'tool')
    ) {
      return { thinking: undefined, outputConfig: undefined }
    }
    return { thinking: { type: 'adaptive' }, outputConfig: { effort: level } }
  }

  if (
    toolChoice !== undefined &&
    (toolChoice['type'] === 'any' || toolChoice['type'] === 'tool')
  ) {
    return { thinking: undefined, outputConfig: undefined }
  }
  return { thinking, outputConfig: undefined }
}

function budgetThinking(budget: number): WireObject {
  if (budget === 0) return { type: 'disabled' }
  if (budget === -1) return { type: 'enabled' }
  return { type: 'enabled', budget_tokens: budget }
}

// ---------------------------------------------------------------------------
// Full generation translation
// ---------------------------------------------------------------------------

/**
 * Translates one client request into the final upstream Claude body.
 *
 * @param rawBody the client's request body bytes as text
 * @param ctx serving configuration for this request
 * @throws CpaError `invalid-input` when the body is not a strict JSON object
 */
export async function translateGeminiToClaude(
  rawBody: string,
  ctx: GeminiToClaudeContext,
): Promise<ClaudeUpstreamRequest> {
  const parsed = parseStrictJson(rawBody)
  if (!isPlainObject(parsed)) {
    throw new CpaError('invalid-input', 'Invalid request: malformed JSON body')
  }
  const request = parsed as Record<string, unknown>
  const assembly = assembleFromRequest(request, rawBody)

  const maxTokens = readMaxTokens(request)
  const stopSequences = readStopSequences(request)
  const serviceTier = readString(request, 'service_tier')
  const thinking = resolveThinking(request, ctx.thinking, assembly.toolChoice)
  const userId = await deriveClaudeUserId({ request, rawBody, model: ctx.upstreamModel })

  const body: WireObject = {
    model: ctx.upstreamModel,
    max_tokens: maxTokens,
    messages: assembly.messages.map((message) => ({ role: message.role, content: message.content })),
    metadata: metadataObject(userId),
  }
  if (serviceTier !== undefined) body['service_tier'] = serviceTier
  if (stopSequences !== undefined) body['stop_sequences'] = stopSequences
  if (thinking.thinking !== undefined) body['thinking'] = thinking.thinking
  if (assembly.tools.length > 0) body['tools'] = assembly.tools
  if (assembly.toolChoice !== undefined) body['tool_choice'] = assembly.toolChoice
  body['stream'] = true
  if (thinking.outputConfig !== undefined) body['output_config'] = thinking.outputConfig

  injectCacheControl(body)
  return { body: serializeOrdered(body), value: body }
}

// ---------------------------------------------------------------------------
// Executor-side cache breakpoints (S2d7 3.4)
// ---------------------------------------------------------------------------

/** Counts `cache_control` markers anywhere in the body. */
function countCacheMarkers(value: unknown): number {
  if (Array.isArray(value)) {
    let total = 0
    for (const item of value) total += countCacheMarkers(item)
    return total
  }
  if (typeof value !== 'object' || value === null) return 0
  if (value instanceof RawJson) return 0
  const record = value as Record<string, unknown>
  let total = record['cache_control'] !== undefined ? 1 : 0
  for (const key of Object.keys(record)) {
    if (key === 'cache_control') continue
    total += countCacheMarkers(record[key])
  }
  return total
}

/**
 * Default cache breakpoints. This direction never emits a `system` and
 * never produces pre-existing `cache_control` blocks, so the injection
 * always runs: the last non-`defer_loading` tool and the last eligible
 * message block each get one ephemeral marker.
 */
function injectCacheControl(body: WireObject): void {
  if (countCacheMarkers(body) > 0) return
  const tools = body['tools']
  if (Array.isArray(tools)) {
    for (let i = tools.length - 1; i >= 0; i--) {
      const tool = tools[i]
      if (!isPlainObject(tool)) continue
      const record = tool as WireObject
      if (record['defer_loading'] === true) continue
      record['cache_control'] = { type: 'ephemeral' }
      break
    }
  }
  const block = lastEligibleBlock(body)
  if (block !== undefined && block['cache_control'] === undefined) {
    block['cache_control'] = { type: 'ephemeral' }
  }
}

/** Last content block of the last eligible message (thinking-ending turns skip). */
function lastEligibleBlock(body: Readonly<WireObject>): WireObject | undefined {
  const messages = body['messages']
  if (!Array.isArray(messages)) return undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!isPlainObject(message)) continue
    const record = message as WireObject
    const role = record['role']
    if (role !== 'user' && role !== 'assistant') continue
    const content = record['content']
    if (!Array.isArray(content) || content.length === 0) continue
    const blocks = content as WireObject[]
    const last = blocks[blocks.length - 1]
    if (last === undefined || !isPlainObject(last)) continue
    const type = last['type']
    if (type === 'thinking' || type === 'redacted_thinking') continue
    return last as WireObject
  }
  return undefined
}
