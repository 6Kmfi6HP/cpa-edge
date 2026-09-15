/**
 * Request translation: Claude Messages -> Gemini generateContent.
 *
 * Reproduces the recorded pipeline for this direction (S2d8 sections 2.3,
 * 3.1 and 3.2): system-instruction handling with the Claude-Code
 * attribution strip, the 16 message/content mapping rules (reminder turns,
 * tool_use -> functionCall with raw argument bytes and the first-call
 * thought-signature sentinel, tool_result -> functionResponse with the
 * name-resolution and result-encoding ladders, image -> inline_data),
 * tool-result alignment, user-turn reordering and adjacent-user merging,
 * the trailing model-turn strip, the executor boundary turns, the
 * two-stage thinking rule, and the always-injected safetySettings.
 * The upstream body is byte-exact contract material.
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
import { buildFunctionDeclarations, requestToolList, sanitizeFunctionName } from './schema'
import type { Cla2GemContext, Cla2GemUpstreamBody } from './types'
import { THOUGHT_SIGNATURE_SENTINEL } from './types'

/** Left-trimmed prefix that marks a Claude-Code attribution block. */
const ATTRIBUTION_PREFIX = 'x-anthropic-billing-header:'

/** Wrapper text of mid-conversation system reminder turns. */
const SYSTEM_REMINDER_OPEN = '<system-reminder>'
const SYSTEM_REMINDER_CLOSE = '</system-reminder>'

/** The always-injected safetySettings block (recorded bytes). */
const SAFETY_SETTINGS: readonly WireObject[] = Object.freeze([
  Object.freeze({ category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' }),
  Object.freeze({ category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'OFF' }),
  Object.freeze({ category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'OFF' }),
  Object.freeze({ category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'OFF' }),
  Object.freeze({ category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'BLOCK_NONE' }),
])

/** One translated Gemini content turn. */
interface ContentTurn {
  role: 'user' | 'model'
  parts: WireObject[]
}

/** Per-request tool state: id -> name of every tool_use seen so far. */
interface ToolUseIndex {
  readonly namesById: Map<string, string>
  /** tool_use ids of the most recent assistant message, in order. */
  lastAssistantToolUseIds: string[]
}

/** True when the text is a Claude-Code attribution block. */
function isAttributionText(text: string): boolean {
  return text.trimStart().startsWith(ATTRIBUTION_PREFIX)
}

/** True when the text has no visible content. */
function isBlankText(text: string): boolean {
  return text.trim().length === 0
}

// ---------------------------------------------------------------------------
// System instruction
// ---------------------------------------------------------------------------

/**
 * Builds `systemInstruction`: the string form emits `{"parts":[...]}`
 * without a role, the array form emits `{"role":"user","parts":[...]}`;
 * attribution texts are stripped and an empty result omits the key.
 */
export function buildSystemInstruction(request: Record<string, unknown>): WireObject | undefined {
  const system = request['system']
  if (typeof system === 'string') {
    if (isAttributionText(system) || isBlankText(system)) return undefined
    return { parts: [{ text: system }] }
  }
  if (!Array.isArray(system)) return undefined
  const parts: WireObject[] = []
  for (const item of system) {
    if (!isPlainObject(item)) continue
    if (item['type'] !== 'text') continue
    const text = item['text']
    if (typeof text !== 'string') continue
    if (isAttributionText(text) || isBlankText(text)) continue
    parts.push({ text })
  }
  if (parts.length === 0) return undefined
  return { role: 'user', parts }
}

// ---------------------------------------------------------------------------
// Content assembly
// ---------------------------------------------------------------------------

/** Maps a Claude message role; unmapped roles drop the whole message. */
function mapMessageRole(role: unknown): 'user' | 'model' | 'system-reminder' | undefined {
  if (role === 'assistant') return 'model' as const
  if (role === 'user') return 'user' as const
  if (role === 'system' || role === 'developer') return 'system-reminder' as const
  return undefined
}

/**
 * Reorders one user-turn part list (rule 3): only when a functionResponse
 * part is followed by a text part do all text parts move ahead of all
 * non-text parts (relative order preserved inside each group - images
 * stay glued to their own functionResponse). Recorded: S2d8-06 keeps an
 * image-before-text turn untouched, S2d8-05 reorders.
 */
function reorderUserParts(parts: WireObject[]): WireObject[] {
  let sawFunctionResponse = false
  let needsReorder = false
  for (const part of parts) {
    if (part['functionResponse'] !== undefined) sawFunctionResponse = true
    else if (part['text'] !== undefined && sawFunctionResponse) {
      needsReorder = true
      break
    }
  }
  if (!needsReorder) return parts
  const texts: WireObject[] = []
  const others: WireObject[] = []
  for (const part of parts) {
    if (part['text'] !== undefined) texts.push(part)
    else others.push(part)
  }
  return [...texts, ...others]
}

/** One content block paired with its position in the RAW client body. */
interface BlockRef {
  readonly block: Record<string, unknown>
  readonly position: number
}

/**
 * Aligns the tool_result blocks of one user message with the tool_use ids
 * of the preceding assistant turn - only when the two id lists match
 * one-to-one; otherwise the original order survives. Each block keeps its
 * RAW-body position so byte splices keep pointing at the right member.
 */
function alignToolResults(blocks: readonly BlockRef[], assistantIds: readonly string[]): BlockRef[] {
  const slots: number[] = []
  const resultIds: string[] = []
  for (let i = 0; i < blocks.length; i++) {
    const ref = blocks[i]
    if (ref.block['type'] !== 'tool_result') continue
    const id = ref.block['tool_use_id']
    if (typeof id !== 'string') continue
    slots.push(i)
    resultIds.push(id)
  }
  if (slots.length === 0 || slots.length !== assistantIds.length) return [...blocks]
  const remaining = [...assistantIds]
  for (const id of resultIds) {
    const at = remaining.indexOf(id)
    if (at < 0) return [...blocks]
    remaining.splice(at, 1)
  }
  // One-to-one match confirmed: the k-th tool_result slot receives the
  // block whose id equals the k-th tool_use id of the assistant turn.
  const pool = [...blocks]
  const used = new Set<number>()
  for (let k = 0; k < slots.length; k++) {
    const wanted = assistantIds[k]
    const slot = slots[k]
    if (wanted === undefined || slot === undefined) continue
    for (let at = 0; at < slots.length; at++) {
      if (used.has(at)) continue
      if (resultIds[at] === wanted) {
        used.add(at)
        const source = slots[at]
        if (source !== undefined) pool[slot] = blocks[source]
        break
      }
    }
  }
  return pool
}

/** Extracts the base64 payload of an image source, or undefined. */
function imageInlineData(source: unknown): WireObject | undefined {
  if (!isPlainObject(source)) return undefined
  if (source['type'] !== 'base64') return undefined
  const mediaType = readString(source, 'media_type') ?? ''
  const data = readString(source, 'data') ?? ''
  if (mediaType.length === 0 || data.length === 0) return undefined
  return { inline_data: { mime_type: mediaType, data } }
}

/**
 * Encodes the `content` of a tool_result into the functionResponse result
 * value: string -> plain string; array with exactly one non-image block ->
 * that block's raw bytes; array with 2+ non-image blocks -> a raw JSON
 * array of those blocks; images-only or absent -> ""; single object -> raw
 * object bytes. Raw values keep the client's original formatting.
 */
function toolResultValue(
  block: Record<string, unknown>,
  basePath: readonly string[],
  rawBody: string,
): WireValue {
  const content = block['content']
  if (content === undefined) return ''
  if (typeof content === 'string') return content
  if (isPlainObject(content)) {
    return new RawJson(rawValueAt(rawBody, [...basePath, 'content']) ?? '{}')
  }
  if (!Array.isArray(content)) return ''
  const nonImage: Array<{ readonly raw: string }> = []
  for (let k = 0; k < content.length; k++) {
    const entry = content[k]
    if (isPlainObject(entry) && entry['type'] === 'image') continue
    const raw = rawValueAt(rawBody, [...basePath, 'content', String(k)])
    if (raw === undefined) continue
    nonImage.push({ raw })
  }
  if (nonImage.length === 1) return new RawJson(nonImage[0]?.raw ?? '')
  if (nonImage.length > 1) return new RawJson(`[${nonImage.map((entry) => entry.raw).join(',')}]`)
  return ''
}

/** Resolves the function name of a tool_result (name ladder, then sanitize). */
function resolveToolResultName(
  block: Record<string, unknown>,
  toolUseId: string,
  tools: ToolUseIndex,
): string {
  const byId = tools.namesById.get(toolUseId)
  if (byId !== undefined) return sanitizeFunctionName(byId)
  const dash = toolUseId.lastIndexOf('-')
  if (dash > 0) return sanitizeFunctionName(toolUseId.slice(0, dash))
  return sanitizeFunctionName(toolUseId)
}

/** Translates the blocks of one Claude message into Gemini parts. */
function messageParts(
  blocks: readonly BlockRef[],
  role: 'user' | 'model',
  messageIndex: number,
  rawBody: string,
  tools: ToolUseIndex,
  turnToolUseIds: string[],
): WireObject[] {
  void role
  const parts: WireObject[] = []
  let firstCallOfTurn = true
  for (const ref of blocks) {
    const block = ref.block
    const position = ref.position
    const basePath = ['messages', String(messageIndex), 'content', String(position)]
    const type = block['type']

    if (type === 'text') {
      const text = block['text']
      if (typeof text !== 'string' || text.length === 0) continue
      parts.push({ text })
      continue
    }

    if (type === 'thinking' || type === 'redacted_thinking') continue

    if (type === 'tool_use') {
      const input = block['input']
      if (!isPlainObject(input)) continue
      const name = readString(block, 'name') ?? ''
      const id = readString(block, 'id') ?? ''
      if (id.length > 0) {
        tools.namesById.set(id, name)
        turnToolUseIds.push(id)
      }
      const call: WireObject = { name: sanitizeFunctionName(name) }
      call['args'] = new RawJson(rawValueAt(rawBody, [...basePath, 'input']) ?? '{}')
      if (id.length > 0) call['id'] = id
      const part: WireObject = {}
      if (firstCallOfTurn) {
        part['thoughtSignature'] = THOUGHT_SIGNATURE_SENTINEL
        firstCallOfTurn = false
      }
      part['functionCall'] = call
      parts.push(part)
      continue
    }

    if (type === 'tool_result') {
      const toolUseId = readString(block, 'tool_use_id') ?? ''
      if (toolUseId.length === 0) continue
      const response: WireObject = { name: resolveToolResultName(block, toolUseId, tools) }
      response['response'] = { result: toolResultValue(block, basePath, rawBody) }
      response['id'] = toolUseId
      parts.push({ functionResponse: response })
      const content = block['content']
      if (Array.isArray(content)) {
        for (let k = 0; k < content.length; k++) {
          const entry = content[k]
          if (!isPlainObject(entry) || entry['type'] !== 'image') continue
          const inline = imageInlineData(entry['source'])
          if (inline !== undefined) parts.push(inline)
        }
      }
      continue
    }

    if (type === 'image') {
      const inline = imageInlineData(block['source'])
      if (inline !== undefined) parts.push(inline)
    }
  }
  return parts
}

/** Text pieces of a system/developer reminder message, after filtering. */
function reminderTexts(content: unknown): string[] {
  if (typeof content === 'string') {
    return isBlankText(content) || isAttributionText(content) ? [] : [content]
  }
  if (!Array.isArray(content)) return []
  const pieces: string[] = []
  for (const block of content) {
    if (!isPlainObject(block) || block['type'] !== 'text') continue
    const text = block['text']
    if (typeof text !== 'string') continue
    if (isBlankText(text) || isAttributionText(text)) continue
    pieces.push(text)
  }
  return pieces
}

/**
 * Builds the `contents` array from the Claude `messages`, applying rules
 * 3-7 of section 3.2 (part reordering, adjacent-user merging, tool-result
 * alignment, the trailing model-turn strip, the executor boundary turns).
 */
export function buildContents(
  request: Record<string, unknown>,
  rawBody: string,
  options: { readonly forCountTokens: boolean },
): ContentTurn[] {
  const tools: ToolUseIndex = { namesById: new Map(), lastAssistantToolUseIds: [] }
  const contents: ContentTurn[] = []
  const messages = readArray(request, 'messages') ?? []

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    if (!isPlainObject(message)) continue
    const mapped = mapMessageRole(message['role'])
    if (mapped === undefined) continue
    const content = message['content']

    if (mapped === 'system-reminder') {
      const pieces = reminderTexts(content)
      if (pieces.length === 0) continue
      appendUserTurn(contents, [
        { text: `${SYSTEM_REMINDER_OPEN}\n${pieces.join('\n')}\n${SYSTEM_REMINDER_CLOSE}` },
      ])
      continue
    }

    if (typeof content === 'string') {
      if (mapped === 'model') {
        tools.lastAssistantToolUseIds = []
        contents.push({ role: 'model', parts: [{ text: content }] })
      } else {
        appendUserTurn(contents, [{ text: content }])
      }
      continue
    }
    if (!Array.isArray(content)) continue

    const blockRefs: BlockRef[] = []
    for (let position = 0; position < content.length; position++) {
      const block = content[position]
      if (isPlainObject(block)) blockRefs.push({ block, position })
    }

    if (mapped === 'model') {
      const turnToolUseIds: string[] = []
      const parts = messageParts(blockRefs, 'model', index, rawBody, tools, turnToolUseIds)
      tools.lastAssistantToolUseIds = turnToolUseIds
      if (parts.length === 0) continue
      contents.push({ role: 'model', parts })
      continue
    }

    const blocks = alignToolResults(blockRefs, tools.lastAssistantToolUseIds)
    const parts = reorderUserParts(messageParts(blocks, 'user', index, rawBody, tools, []))
    if (parts.length === 0) continue
    appendUserTurn(contents, parts)
  }

  // Rule 6: a trailing model turn with unanswered calls is stripped whole.
  const last = contents[contents.length - 1]
  if (last !== undefined && last.role === 'model' && last.parts.some((part) => part['functionCall'] !== undefined)) {
    contents.pop()
  }

  // Rule 7: executor boundary turns (countTokens keeps the prepend only).
  const first = contents[0]
  if (first !== undefined && first.role === 'model') {
    contents.unshift({ role: 'user', parts: [{ text: '' }] })
  }
  if (!options.forCountTokens) {
    const tail = contents[contents.length - 1]
    if (tail !== undefined && tail.role === 'model' && !tail.parts.some((part) => part['functionResponse'] !== undefined)) {
      contents.push({ role: 'user', parts: [{ text: '' }] })
    }
  }
  return contents
}

/** Appends a user turn, merging into the previous one (rule 4) and reordering. */
function appendUserTurn(contents: ContentTurn[], parts: WireObject[]): void {
  const last = contents[contents.length - 1]
  if (last !== undefined && last.role === 'user') {
    last.parts = reorderUserParts([...last.parts, ...parts])
    return
  }
  contents.push({ role: 'user', parts })
}

// ---------------------------------------------------------------------------
// tool_choice
// ---------------------------------------------------------------------------

/**
 * `tool_choice` -> `toolConfig.functionCallingConfig` (section 3.1 ladder):
 * auto -> AUTO, none -> NONE, any -> ANY, a named `tool` -> ANY plus the
 * sanitized `allowedFunctionNames`; anything else omits the key.
 */
export function buildToolConfig(request: Record<string, unknown>): WireObject | undefined {
  const choice = request['tool_choice']
  let type: string | undefined
  let name: string | undefined
  if (typeof choice === 'string') {
    type = choice
  } else if (isPlainObject(choice)) {
    type = readString(choice, 'type')
    name = readString(choice, 'name')
  } else {
    return undefined
  }
  if (type === 'auto') return { functionCallingConfig: { mode: 'AUTO' } }
  if (type === 'none') return { functionCallingConfig: { mode: 'NONE' } }
  if (type === 'any') return { functionCallingConfig: { mode: 'ANY' } }
  if (type === 'tool' && name !== undefined) {
    return { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [sanitizeFunctionName(name)] } }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// generationConfig (two-stage thinking, section 3.1)
// ---------------------------------------------------------------------------

/**
 * Stage 1 (translator mapping): enabled+budget_tokens -> thinkingBudget;
 * adaptive/auto with output_config.effort -> thinkingLevel (lowercased,
 * trimmed); adaptive without effort -> the registry max when the model is
 * registered, else the level `high`.
 */
function stageOneThinking(request: Record<string, unknown>, ctx: Cla2GemContext): WireObject | undefined {
  const thinking = readObject(request, 'thinking')
  if (thinking === undefined) return undefined
  const type = thinking['type']
  if (type === 'enabled') {
    const budget = thinking['budget_tokens']
    if (typeof budget === 'number' && Number.isFinite(budget)) {
      return { thinkingConfig: { thinkingBudget: Math.trunc(budget) } }
    }
    return undefined
  }
  if (type === 'adaptive' || type === 'auto') {
    const effort = readString(readObject(request, 'output_config'), 'effort')
    if (effort !== undefined && effort.trim().length > 0) {
      return { thinkingConfig: { thinkingLevel: effort.trim().toLowerCase() } }
    }
    if (ctx.thinking?.kind === 'budget') {
      return { thinkingConfig: { thinkingBudget: ctx.thinking.max } }
    }
    return { thinkingConfig: { thinkingLevel: 'high' } }
  }
  return undefined
}

/** Reads a finite-number sampling knob; anything else is dropped. */
function samplingNumber(request: Record<string, unknown>, key: string): number | undefined {
  const raw = request[key]
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined
}

/**
 * Builds `generationConfig`: sampling knobs (numbers only) plus the
 * Stage-1 thinkingConfig, then the Stage-2 capability pass - a
 * capability-resolved model without thinking support loses
 * `thinkingConfig`, and the `generationConfig` key itself survives as an
 * empty object (recorded: S2d8-07/10 carry `"generationConfig":{}`).
 */
export function buildGenerationConfig(request: Record<string, unknown>, ctx: Cla2GemContext): WireObject | undefined {
  const config: WireObject = {}
  const temperature = samplingNumber(request, 'temperature')
  if (temperature !== undefined) config['temperature'] = temperature
  const topP = samplingNumber(request, 'top_p')
  if (topP !== undefined) config['topP'] = topP
  const topK = samplingNumber(request, 'top_k')
  if (topK !== undefined) config['topK'] = topK

  const staged = stageOneThinking(request, ctx)
  let hadThinking = false
  if (staged !== undefined) {
    hadThinking = true
    for (const key of Object.keys(staged)) {
      config[key] = staged[key] as WireValue
    }
  }
  if (ctx.thinking?.kind === 'unsupported') {
    delete config['thinkingConfig']
  }
  if (Object.keys(config).length === 0 && !hadThinking) return undefined
  return config
}

// ---------------------------------------------------------------------------
// Full translation
// ---------------------------------------------------------------------------

/**
 * Translates one client request into the upstream Gemini body.
 *
 * @param rawBody the client's request body bytes as text
 * @param ctx serving configuration for this request
 * @param options `forCountTokens` applies the section 3.2.12 body variant
 *   (tools/generationConfig/safetySettings deleted, prepend-only boundary)
 * @throws CpaError `invalid-input` when the body is not a strict JSON object
 */
export function translateClaudeToGemini(
  rawBody: string,
  ctx: Cla2GemContext,
  options: { readonly forCountTokens?: boolean } = {},
): Cla2GemUpstreamBody {
  const parsed = parseStrictJson(rawBody)
  if (!isPlainObject(parsed)) {
    throw new CpaError('invalid-input', 'Invalid request: malformed JSON body')
  }
  const request = parsed as Record<string, unknown>
  const forCountTokens = options.forCountTokens === true

  const requestTools = requestToolList(request)
  const contents = buildContents(request, rawBody, { forCountTokens })
  const systemInstruction = buildSystemInstruction(request)
  const generationConfig = buildGenerationConfig(request, ctx)
  const toolConfig = buildToolConfig(request)
  const tools = buildFunctionDeclarations(requestTools, rawBody)

  const body: WireObject = {
    contents: contents.map((turn) => ({ role: turn.role, parts: turn.parts })),
    model: ctx.upstreamModel,
  }
  if (systemInstruction !== undefined) body['systemInstruction'] = systemInstruction
  if (tools !== undefined && !forCountTokens) body['tools'] = [tools]
  if (toolConfig !== undefined && !forCountTokens) body['toolConfig'] = toolConfig
  if (generationConfig !== undefined && !forCountTokens) body['generationConfig'] = generationConfig
  if (!forCountTokens) body['safetySettings'] = [...SAFETY_SETTINGS.map((entry) => ({ ...entry }))]

  return { body: serializeOrdered(body), value: body, requestTools }
}
