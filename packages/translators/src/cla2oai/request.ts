/**
 * Request translation: Claude Messages -> OpenAI Chat Completions
 * (S2d4 sections 3.1-3.3).
 *
 * Reproduces the recorded pipeline: the system block with the
 * Claude-Code attribution strip (string form becomes a one-part text
 * array), the message conversion (mid-conversation `system` turns wrap
 * as `<system-reminder>` and buffer while tool_use ids are pending,
 * assistant tool_use blocks become `tool_calls` with RAW argument bytes
 * and the sorted-map entry key order, tool_result blocks become `tool`
 * messages with the recorded result ladder and image relay, tool-result
 * alignment reorders blocks to the announced id order), the sampling
 * rules (temperature over top_p, top_k dropped, stop only non-empty,
 * stream always set), the stage-1 thinking conversion, the tools array
 * with normalized + re-serialized `input_schema`, the tool_choice
 * ladder, and the alias-resolved upstream model. The upstream body is
 * byte-exact contract material; emission order within one user message
 * is [tool results] -> [image relay] -> [buffered reminders] -> [own
 * content].
 */
import { CpaError } from '@cpa-edge/core'
import {
  RawJson,
  isPlainObject,
  parseStrictJson,
  rawValueAt,
  readString,
  serializeOrdered,
} from './json'
import type { WireObject, WireValue } from './json'
import { serializeToolParameters } from './schema'
import { convertBudgetToLevel } from './thinking'
import type { Cla2OaiContext, Cla2OaiUpstreamBody } from './types'

/** Left-trimmed prefix that marks a Claude-Code attribution block. */
const ATTRIBUTION_PREFIX = 'x-anthropic-billing-header:'

/** Wrapper text of mid-conversation system reminder turns. */
const SYSTEM_REMINDER_OPEN = '<system-reminder>'
const SYSTEM_REMINDER_CLOSE = '</system-reminder>'

/** Notice text of the tool-result image relay message. */
const IMAGE_RELAY_NOTICE = 'Images returned by the preceding tool call(s):'

/** Placeholder content of an images-only tool result (recorded). */
const IMAGE_TOOL_RESULT_PLACEHOLDER =
  '[Tool returned image content; the images follow in the next user message.]'

/** True when the text is a Claude-Code attribution block. */
function isAttributionText(text: string): boolean {
  return text.trimStart().startsWith(ATTRIBUTION_PREFIX)
}

/** True when the text has no visible content. */
function isBlankText(text: string): boolean {
  return text.trim().length === 0
}

/** Reads a finite-number member; anything else is dropped. */
function samplingNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * gjson-`String()` semantics for tool names and descriptions: absent or
 * null reads as the empty string, a string passes through, any other
 * JSON value contributes its raw JSON text.
 */
function rawStringMember(record: Record<string, unknown>, key: string): string {
  const raw = record[key]
  if (raw === undefined || raw === null) return ''
  if (typeof raw === 'string') return raw
  return JSON.stringify(raw)
}

// ---------------------------------------------------------------------------
// System block
// ---------------------------------------------------------------------------

/**
 * Builds the leading `system` message: at most one, content ALWAYS an
 * array of text parts (a bare string becomes a one-part array).
 * Attribution-prefixed and blank texts drop; nothing surviving means no
 * system message at all.
 */
export function buildSystemMessage(request: Record<string, unknown>): WireObject | undefined {
  const system = request['system']
  const texts: string[] = []
  if (typeof system === 'string') {
    texts.push(system)
  } else if (Array.isArray(system)) {
    for (const block of system) {
      if (!isPlainObject(block) || block['type'] !== 'text') continue
      if (typeof block['text'] !== 'string') continue
      texts.push(block['text'])
    }
  } else {
    return undefined
  }
  const kept = texts.filter((text) => !isBlankText(text) && !isAttributionText(text))
  if (kept.length === 0) return undefined
  return { role: 'system', content: kept.map((text) => ({ type: 'text', text })) }
}

// ---------------------------------------------------------------------------
// Content parts
// ---------------------------------------------------------------------------

/**
 * Converts one `image` block into an `image_url` part: `base64` sources
 * become `data:<media>;base64,<data>` URLs (empty media type becomes
 * `application/octet-stream`), `url` sources contribute their url, and a
 * block without any derivable URL drops (recorded: S2d4-images).
 */
export function imagePart(block: Record<string, unknown>): WireObject | undefined {
  const source = block['source']
  if (isPlainObject(source)) {
    if (source['type'] === 'base64') {
      const rawMedia = readString(source, 'media_type') ?? ''
      const media = rawMedia.length > 0 ? rawMedia : 'application/octet-stream'
      const data = readString(source, 'data') ?? ''
      return { type: 'image_url', image_url: { url: `data:${media};base64,${data}` } }
    }
    if (source['type'] === 'url') {
      const url = readString(source, 'url') ?? ''
      if (url.length > 0) return { type: 'image_url', image_url: { url } }
    }
  }
  const fallback = readString(block, 'url')
  if (fallback !== undefined && fallback.length > 0) {
    return { type: 'image_url', image_url: { url: fallback } }
  }
  return undefined
}

/** One content block paired with its position in the RAW client body. */
interface BlockRef {
  readonly block: Record<string, unknown>
  readonly position: number
}

/** Text pieces of a mid-conversation system turn, after filtering. */
function reminderTexts(content: unknown): readonly string[] {
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
 * Aligns the tool_result blocks of one user message with the tool_use
 * ids of the preceding assistant turn - only when the two id lists match
 * one-to-one; otherwise the original order survives. Each block keeps
 * its RAW-body position so byte splices keep pointing at the right
 * member.
 */
function alignToolResults(blocks: readonly BlockRef[], assistantIds: readonly string[]): BlockRef[] {
  const slots: number[] = []
  const resultIds: string[] = []
  for (let i = 0; i < blocks.length; i++) {
    const ref = blocks[i]
    if (ref === undefined) continue
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
        const moved = source === undefined ? undefined : blocks[source]
        if (moved !== undefined) pool[slot] = moved
        break
      }
    }
  }
  return pool
}

/**
 * Builds the `content` string of one tool_result block (the recorded
 * result ladder): string content passes through; array items contribute
 * their text (string items and `text` blocks, blank pieces skipped),
 * image items are extracted for the relay, and any other item
 * contributes its raw JSON; the survivors join with `\n\n`. An empty
 * join WITH images yields the placeholder; an empty join without images
 * yields the RAW JSON of the `content` member (an empty array therefore
 * renders `[]`); absent content renders `""`; non-array non-string
 * content renders `""`.
 */
function toolResultContent(
  block: Record<string, unknown>,
  basePath: readonly string[],
  rawBody: string,
): { content: string; images: WireObject[] } {
  const content = block['content']
  if (content === undefined) return { content: '', images: [] }
  if (typeof content === 'string') return { content, images: [] }
  if (!Array.isArray(content)) return { content: '', images: [] }
  const images: WireObject[] = []
  const pieces: string[] = []
  for (let k = 0; k < content.length; k++) {
    const item = content[k]
    if (typeof item === 'string') {
      if (item.trim().length > 0) pieces.push(item)
      continue
    }
    if (!isPlainObject(item)) {
      const raw = rawValueAt(rawBody, [...basePath, 'content', String(k)])
      if (raw !== undefined) pieces.push(raw)
      continue
    }
    const type = item['type']
    if (type === 'text') {
      const text = item['text']
      if (typeof text === 'string' && text.trim().length > 0) pieces.push(text)
      continue
    }
    if (type === 'image') {
      const part = imagePart(item)
      if (part !== undefined) images.push(part)
      continue
    }
    const raw = rawValueAt(rawBody, [...basePath, 'content', String(k)])
    if (raw !== undefined) pieces.push(raw)
  }
  if (pieces.length === 0 && images.length > 0) {
    return { content: IMAGE_TOOL_RESULT_PLACEHOLDER, images }
  }
  if (pieces.length === 0) {
    return { content: rawValueAt(rawBody, [...basePath, 'content']) ?? '[]', images }
  }
  return { content: pieces.join('\n\n'), images }
}

/** One `{"role":"tool",...}` message for a tool_result block. */
function toolResultMessage(toolUseId: string, content: string): WireObject {
  return { role: 'tool', tool_call_id: toolUseId, content }
}

// ---------------------------------------------------------------------------
// Message conversion
// ---------------------------------------------------------------------------

/**
 * Builds the upstream `messages` array from the Claude `messages`
 * (section 3.2). Reminders buffer while tool_use ids are pending and
 * flush at the next output-producing message - after that message's
 * tool-result messages and image relay, before its own content message;
 * trailing buffered reminders append at the end.
 */
export function buildMessages(
  request: Record<string, unknown>,
  rawBody: string,
  isCompat: boolean,
): WireObject[] {
  const outputs: WireObject[] = []
  let pendingToolUseIds: readonly string[] = []
  const bufferedReminders: string[] = []

  const messages = request['messages']
  if (!Array.isArray(messages)) return outputs

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    if (!isPlainObject(message)) continue
    const role = message['role']
    const content = message['content']
    const basePath = ['messages', String(index), 'content']

    if (role === 'system') {
      const texts = reminderTexts(content)
      if (texts.length === 0) continue
      const wrapped = `${SYSTEM_REMINDER_OPEN}\n${texts.join('\n')}\n${SYSTEM_REMINDER_CLOSE}`
      if (pendingToolUseIds.length > 0) bufferedReminders.push(wrapped)
      else outputs.push({ role: 'user', content: [{ type: 'text', text: wrapped }] })
      continue
    }

    if (role === 'user' || role === 'assistant') {
      if (typeof content === 'string') {
        // String form is preserved verbatim; the turn produces output,
        // so buffered reminders flush before it and pending ids clear.
        flushReminders(outputs, bufferedReminders)
        outputs.push({ role, content })
        pendingToolUseIds = []
        continue
      }
      if (!Array.isArray(content)) continue

      const blockRefs: BlockRef[] = []
      for (let position = 0; position < content.length; position++) {
        const block = content[position]
        if (isPlainObject(block)) blockRefs.push({ block, position })
      }

      if (role === 'assistant') {
        emitAssistantMessage(outputs, blockRefs, basePath, rawBody, bufferedReminders, isCompat)
        pendingToolUseIds = collectToolUseIds(blockRefs)
        continue
      }
      const aligned = alignToolResults(blockRefs, pendingToolUseIds)
      emitUserMessage(outputs, aligned, basePath, rawBody, bufferedReminders)
      pendingToolUseIds = []
      continue
    }
    // Unknown roles contribute nothing.
  }

  // Trailing buffered reminders (nothing follows) append at the end.
  flushReminders(outputs, bufferedReminders)
  return outputs
}

/** Emits the buffered reminder messages in FIFO order and clears them. */
function flushReminders(outputs: WireObject[], bufferedReminders: string[]): void {
  if (bufferedReminders.length === 0) return
  const wrapped = [...bufferedReminders]
  bufferedReminders.length = 0
  for (const text of wrapped) {
    outputs.push({ role: 'user', content: [{ type: 'text', text }] })
  }
}

/** tool_use ids of one assistant turn, in block order. */
function collectToolUseIds(blocks: readonly BlockRef[]): string[] {
  const ids: string[] = []
  for (const ref of blocks) {
    if (ref.block['type'] !== 'tool_use') continue
    const id = ref.block['id']
    if (typeof id === 'string' && id.length > 0) ids.push(id)
  }
  return ids
}

/**
 * Emits ONE assistant upstream message for an array-content Claude
 * assistant turn: surviving text/image parts (or the empty string),
 * `reasoning_content` (is-compat or signature-gated thinking blocks),
 * and `tool_calls` in the recorded sorted-map entry key order. The
 * emission gate drops a turn where nothing survived. Buffered reminders
 * flush before the assistant message.
 */
function emitAssistantMessage(
  outputs: WireObject[],
  blocks: readonly BlockRef[],
  basePath: readonly string[],
  rawBody: string,
  bufferedReminders: string[],
  isCompat = false,
): void {
  const parts: WireObject[] = []
  const thinkingTexts: string[] = []
  const toolCalls: WireObject[] = []
  const toolMessages: WireObject[] = []
  const relayParts: WireObject[] = []

  for (const ref of blocks) {
    const block = ref.block
    const type = block['type']
    const blockPath = [...basePath, String(ref.position)]

    if (type === 'text') {
      const text = block['text']
      if (typeof text !== 'string') continue
      if (isBlankText(text) || isAttributionText(text)) continue
      parts.push({ type: 'text', text })
      continue
    }
    if (type === 'image') {
      const part = imagePart(block)
      if (part !== undefined) parts.push(part)
      continue
    }
    if (type === 'thinking') {
      const text = block['thinking']
      if (typeof text !== 'string' || isBlankText(text)) continue
      if (!isCompat) {
        const signature = readString(block, 'signature')
        if (signature === undefined || signature.length === 0) continue
      }
      thinkingTexts.push(text)
      continue
    }
    if (type === 'tool_use') {
      const name = rawStringMember(block, 'name')
      const id = rawStringMember(block, 'id')
      // The RAW input bytes travel as a JSON STRING value (recorded:
      // "arguments":"{\"city\":\"Paris\"}"); an absent input is "{}".
      const argumentsRaw = rawValueAt(rawBody, [...blockPath, 'input']) ?? '{}'
      // Sorted-map entry key order (recorded, informative per 4.5):
      // function{arguments,name}, id, type.
      toolCalls.push({
        function: { arguments: argumentsRaw, name },
        id,
        type: 'function',
      })
      continue
    }
    if (type === 'tool_result') {
      const toolUseId = rawStringMember(block, 'tool_use_id')
      const { content, images } = toolResultContent(block, blockPath, rawBody)
      toolMessages.push(toolResultMessage(toolUseId, content))
      relayParts.push(...images)
      continue
    }
    // redacted_thinking, document and unknown blocks drop.
  }

  const produced = toolMessages.length > 0 || relayParts.length > 0 ||
    parts.length > 0 || thinkingTexts.length > 0 || toolCalls.length > 0
  if (!produced) return
  // Emission order: tool-result messages, image relay, buffered
  // reminders, then the assistant message itself.
  outputs.push(...toolMessages)
  if (relayParts.length > 0) {
    outputs.push({ role: 'user', content: [noticePart(), ...relayParts] })
  }
  flushReminders(outputs, bufferedReminders)
  if (parts.length === 0 && thinkingTexts.length === 0 && toolCalls.length === 0) return
  const assistant: WireObject = { role: 'assistant', content: parts.length > 0 ? parts : '' }
  if (thinkingTexts.length > 0) assistant['reasoning_content'] = thinkingTexts.join('\n\n')
  if (toolCalls.length > 0) assistant['tool_calls'] = toolCalls
  outputs.push(assistant)
}

/** The relay notice text part. */
function noticePart(): WireObject {
  return { type: 'text', text: IMAGE_RELAY_NOTICE }
}

/**
 * Emits one user turn: tool messages for tool_result blocks, the image
 * relay (prepended to the own content message when both exist), buffered
 * reminders, then the own content message. A turn with no surviving
 * output at all flushes nothing.
 */
function emitUserMessage(
  outputs: WireObject[],
  blocks: readonly BlockRef[],
  basePath: readonly string[],
  rawBody: string,
  bufferedReminders: string[],
): void {
  const toolMessages: WireObject[] = []
  const relayParts: WireObject[] = []
  const parts: WireObject[] = []

  for (const ref of blocks) {
    const block = ref.block
    const type = block['type']
    const blockPath = [...basePath, String(ref.position)]

    if (type === 'text') {
      const text = block['text']
      if (typeof text !== 'string') continue
      if (isBlankText(text) || isAttributionText(text)) continue
      parts.push({ type: 'text', text })
      continue
    }
    if (type === 'image') {
      const part = imagePart(block)
      if (part !== undefined) parts.push(part)
      continue
    }
    if (type === 'tool_result') {
      const toolUseId = rawStringMember(block, 'tool_use_id')
      const { content, images } = toolResultContent(block, blockPath, rawBody)
      toolMessages.push(toolResultMessage(toolUseId, content))
      relayParts.push(...images)
      continue
    }
    // thinking / redacted_thinking / tool_use / document / unknown
    // blocks drop in user content (injection guard).
  }

  const produced =
    toolMessages.length > 0 || relayParts.length > 0 || parts.length > 0
  if (!produced) return

  outputs.push(...toolMessages)
  if (relayParts.length > 0 && parts.length === 0) {
    outputs.push({ role: 'user', content: [noticePart(), ...relayParts] })
    flushReminders(outputs, bufferedReminders)
    return
  }
  if (relayParts.length > 0 && parts.length > 0) {
    // Single user turn preserved: the relay parts prepend the own
    // content; buffered reminders flush before the merged message.
    flushReminders(outputs, bufferedReminders)
    outputs.push({ role: 'user', content: [noticePart(), ...relayParts, ...parts] })
    return
  }
  flushReminders(outputs, bufferedReminders)
  outputs.push({ role: 'user', content: parts })
}

// ---------------------------------------------------------------------------
// Tools and tool_choice
// ---------------------------------------------------------------------------

/** Builds the upstream `tools` entries and the request tool list. */
export function buildTools(
  request: Record<string, unknown>,
): { readonly entries: readonly WireObject[]; readonly requestTools: readonly WireObject[] } {
  const tools = request['tools']
  if (!Array.isArray(tools)) return { entries: [], requestTools: [] }
  const entries: WireObject[] = []
  const requestTools: WireObject[] = []
  for (const tool of tools) {
    if (!isPlainObject(tool)) continue
    requestTools.push(tool as WireObject)
    const name = rawStringMember(tool, 'name')
    const description = rawStringMember(tool, 'description')
    const schema = tool['input_schema']
    const seeded = schema === undefined ? { type: 'object' } : schema
    entries.push({
      type: 'function',
      function: {
        name,
        description,
        parameters: new RawJson(serializeToolParameters(seeded)),
      },
    })
  }
  return { entries, requestTools }
}

/**
 * `tool_choice` ladder: `{"type":"auto"}` -> `"auto"`, `{"type":"any"}`
 * -> `"required"`, `{"type":"tool","name":X}` -> the function form;
 * anything else present (unrecognized or missing type) -> `"auto"`.
 */
export function buildToolChoice(choice: unknown): WireValue | undefined {
  if (choice === undefined) return undefined
  if (isPlainObject(choice)) {
    const type = choice['type']
    if (type === 'auto') return 'auto'
    if (type === 'any') return 'required'
    if (type === 'tool' && typeof choice['name'] === 'string') {
      return { type: 'function', function: { name: choice['name'] } }
    }
    return 'auto'
  }
  return 'auto'
}

// ---------------------------------------------------------------------------
// Stage-1 thinking write
// ---------------------------------------------------------------------------

/**
 * Writes the PROVISIONAL `reasoning_effort` (section 3.1 stage 1):
 * enabled+budget -> the ladder level (or the empty marker when the
 * budget converts to nothing, so stage 2 fails with the recorded 400),
 * enabled without budget -> `auto`, adaptive/auto -> the trimmed,
 * lowercased `output_config.effort` or `xhigh`, disabled -> `none`.
 */
export function applyThinkingStage1(body: WireObject, request: Record<string, unknown>): void {
  const thinking = request['thinking']
  if (typeof thinking !== 'object' || thinking === null) return
  const record = thinking as Record<string, unknown>
  const type = record['type']
  if (type === 'enabled') {
    const budget = record['budget_tokens']
    if (typeof budget === 'number' && Number.isFinite(budget)) {
      body['reasoning_effort'] = convertBudgetToLevel(budget) ?? ''
      return
    }
    body['reasoning_effort'] = 'auto'
    return
  }
  if (type === 'adaptive' || type === 'auto') {
    const outputConfig = request['output_config']
    const effort =
      isPlainObject(outputConfig) && typeof outputConfig['effort'] === 'string'
        ? outputConfig['effort'].trim().toLowerCase()
        : ''
    body['reasoning_effort'] = effort.length > 0 ? effort : 'xhigh'
    return
  }
  if (type === 'disabled') {
    body['reasoning_effort'] = 'none'
  }
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Translates one client request into the upstream OpenAI body, stage 1
 * only: the thinking config is converted but NOT yet validated or
 * clamped. Use {@link translateClaudeRequest} for the effective
 * (recorded) mapping.
 */
export function translateClaudeToOpenAI(
  rawBody: string,
  ctx: Cla2OaiContext,
): Cla2OaiUpstreamBody {
  const parsed = parseStrictJson(rawBody)
  if (!isPlainObject(parsed)) {
    throw new CpaError('invalid-input', 'Invalid request: malformed JSON body')
  }
  const request = parsed as Record<string, unknown>

  const system = buildSystemMessage(request)
  const messages = buildMessages(request, rawBody, ctx.isCompat === true)
  const upstreamMessages: WireObject[] = []
  if (system !== undefined) upstreamMessages.push(system)
  upstreamMessages.push(...messages)

  const body: WireObject = {
    model: ctx.upstreamModel,
    messages: upstreamMessages,
  }
  const maxTokens = samplingNumber(request['max_tokens'])
  if (maxTokens !== undefined) body['max_tokens'] = maxTokens
  const temperature = samplingNumber(request['temperature'])
  if (temperature !== undefined) {
    body['temperature'] = temperature
  } else {
    const topP = samplingNumber(request['top_p'])
    if (topP !== undefined) body['top_p'] = topP
  }
  if (Array.isArray(request['stop_sequences'])) {
    const stops = request['stop_sequences'].filter(
      (entry): entry is string => typeof entry === 'string',
    )
    if (stops.length > 0) body['stop'] = stops
  }
  body['stream'] = ctx.stream
  applyThinkingStage1(body, request)
  const { entries, requestTools } = buildTools(request)
  if (entries.length > 0) body['tools'] = [...entries]
  const toolChoice = buildToolChoice(request['tool_choice'])
  if (toolChoice !== undefined) body['tool_choice'] = toolChoice
  if (typeof request['user'] === 'string') body['user'] = request['user']

  return { body: serializeOrdered(body), value: body, requestTools }
}
