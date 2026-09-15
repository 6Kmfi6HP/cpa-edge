/**
 * Request translation: Responses body -> chat completions body
 * (S2d6 section 3.1).
 *
 * The output is built from a fixed template (`model`, `messages`,
 * `stream`); every other field appends at the end only when the
 * translation produces it: `response_format`, `max_tokens`, `tools`,
 * `parallel_tool_calls`, `tool_choice`, `reasoning_effort` (the executor
 * appends `stream_options` for streams). Everything the client sends
 * outside the whitelist - temperature, top_p, user, store, metadata, ... -
 * drops.
 *
 * The `input` array walks a state machine: reasoning items buffer a
 * summary string that attaches to the next assistant message; consecutive
 * function/custom tool calls buffer into ONE assistant message; outputs
 * pair with pending calls (explicit id, name match or FIFO); messages
 * that arrive while outputs are still awaited defer until the tool block
 * closes; orphan outputs become user messages; an assistant message can
 * absorb a following tool-call flush.
 */
import { isPlainObject, isValidJson, parseStrictJson, rawValueAt, serializeOrdered, sortKeysDeep } from './json'
import type { WireObject, WireValue } from './json'
import { RawJson } from './json'
import { chatToolCallEntry, collectToolSources, customToolArguments, serializeChatTools, translateToolChoice, translateToolDeclarations } from './tools'
import type { DeclaredTool } from './types'
import type { ChatUpstreamRequest, ResponsesToChatContext } from './types'

/** Placeholder the reference emits when a reasoning item has no usable summary text. */
export const REASONING_UNAVAILABLE = '[reasoning unavailable]'

/**
 * Translates a Responses request body into the chat upstream body.
 * Throws `invalid-input` when the body is not strict JSON (NE-LENIENT).
 */
export function translateResponsesToChat(body: string, ctx: ResponsesToChatContext): ChatUpstreamRequest {
  const parsed = parseStrictJson(body)
  const record = isPlainObject(parsed) ? parsed : {}
  const stream = record['stream'] === true

  const topLevelTools = Array.isArray(record['tools']) ? (record['tools'] as readonly unknown[]) : undefined
  const input = Array.isArray(record['input']) ? (record['input'] as readonly unknown[]) : undefined

  const { chatTools, declared } = translateToolDeclarations(collectToolSources(input ?? [], topLevelTools))
  const toolChoice = chatTools.length > 0 ? translateToolChoice(record['tool_choice'], declared) : undefined
  const responseFormat = translateResponseFormat(record, body)
  const maxTokens = readMaxOutputTokens(record)
  const effort = translateReasoningEffort(record['reasoning'])
  const parallelToolCalls =
    chatTools.length > 0 && record['parallel_tool_calls'] !== undefined
      ? (record['parallel_tool_calls'] as WireValue)
      : undefined

  const messages = assembleMessages(body, record, input)

  const wire: WireObject = { model: ctx.upstreamModel, messages, stream }
  if (responseFormat !== undefined) wire['response_format'] = responseFormat
  if (maxTokens !== undefined) wire['max_tokens'] = maxTokens
  if (chatTools.length > 0) wire['tools'] = new RawJson(serializeChatTools(chatTools))
  if (parallelToolCalls !== undefined) wire['parallel_tool_calls'] = parallelToolCalls
  if (toolChoice !== undefined) wire['tool_choice'] = toolChoice
  if (effort !== undefined) wire['reasoning_effort'] = effort

  const serialized = serializeOrdered(wire)
  return {
    body: serialized,
    value: JSON.parse(serialized) as WireObject,
    tools: declared,
    chatTools,
    toolChoice,
    maxTokens,
    reasoningEffort: effort,
  }
}

// ---------------------------------------------------------------------------
// Field-level rules
// ---------------------------------------------------------------------------

/**
 * `text.format` -> `response_format`: `text` and `json_object` map to the
 * bare type object; `json_schema` copies name/description/strict/schema
 * verbatim in that order; every other type drops the field.
 */
export function translateResponseFormat(record: Record<string, unknown>, bodyText: string): WireObject | undefined {
  const text = record['text']
  if (!isPlainObject(text)) return undefined
  const format = text['format']
  if (!isPlainObject(format)) return undefined
  const type = format['type']
  if (type === 'text') return { type: 'text' }
  if (type === 'json_object') return { type: 'json_object' }
  if (type === 'json_schema') {
    const jsonSchema: WireObject = {}
    for (const field of ['name', 'description', 'strict', 'schema']) {
      if (format[field] === undefined) continue
      const raw = rawValueAt(bodyText, ['text', 'format', 'json_schema', field])
      jsonSchema[field] = raw !== undefined ? new RawJson(raw) : (format[field] as WireValue)
    }
    return { type: 'json_schema', json_schema: jsonSchema }
  }
  return undefined
}

/** `max_output_tokens` -> `max_tokens` (finite numbers only). */
function readMaxOutputTokens(record: Record<string, unknown>): number | undefined {
  const raw = record['max_output_tokens']
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined
  return raw
}

/** `reasoning.effort` -> `reasoning_effort`: trimmed, lowercased; empty drops. */
export function translateReasoningEffort(reasoning: unknown): string | undefined {
  if (!isPlainObject(reasoning)) return undefined
  const effort = reasoning['effort']
  if (typeof effort !== 'string') return undefined
  const normalized = effort.trim().toLowerCase()
  return normalized.length > 0 ? normalized : undefined
}

// ---------------------------------------------------------------------------
// Message assembly
// ---------------------------------------------------------------------------

/**
 * Assembles the `messages` array: the instructions system message first
 * (when the request carries one), then the input-derived messages in item
 * order under the adjacency rules.
 */
function assembleMessages(
  bodyText: string,
  record: Record<string, unknown>,
  input: readonly unknown[] | undefined,
): WireObject[] {
  const messages: WireObject[] = []
  if (record['instructions'] !== undefined) {
    messages.push({ role: 'system', content: instructionsText(bodyText, record['instructions']) })
  }
  if (typeof record['input'] === 'string') {
    messages.push({ role: 'user', content: record['input'] })
    return messages
  }
  if (input === undefined) return messages

  const assembler = new MessageAssembler()
  const items = normalizeItems(input)
  for (let index = 0; index < items.length; index++) {
    const item = items[index]
    if (item === undefined) continue
    assembler.accept(item, bodyText, index)
  }
  for (const message of assembler.finish()) messages.push(message)
  return messages
}

/** Instructions content: strings pass through, other values keep their raw JSON text. */
function instructionsText(bodyText: string, value: unknown): string {
  if (typeof value === 'string') return value
  const raw = rawValueAt(bodyText, ['instructions'])
  return raw ?? JSON.stringify(value)
}

/**
 * Pre-processing pass (recorded `NormalizeResponsesToolCallOutputs`):
 * output items missing a call id pair with the nearest preceding unmatched
 * tool call - by function-name match when the output carries a name, FIFO
 * otherwise. Outputs with explicit ids stay untouched (their ids decide
 * awaited vs orphan downstream).
 */
function normalizeItems(input: readonly unknown[]): readonly Record<string, unknown>[] {
  const items: Record<string, unknown>[] = []
  for (const entry of input) {
    items.push(isPlainObject(entry) ? { ...entry } : {})
  }
  const calls: Array<{ name: string; matched: boolean }> = []
  for (const item of items) {
    const type = typeof item['type'] === 'string' ? (item['type'] as string) : ''
    if (type === 'function_call' || type === 'custom_tool_call') {
      calls.push({ name: typeof item['name'] === 'string' ? (item['name'] as string) : '', matched: false })
      continue
    }
    if (type !== 'function_call_output' && type !== 'custom_tool_call_output') continue
    if (extractCallId(item) !== undefined) continue
    const outputName = typeof item['name'] === 'string' ? (item['name'] as string) : undefined
    let paired = -1
    for (let i = calls.length - 1; i >= 0; i--) {
      const candidate = calls[i]
      if (candidate === undefined || candidate.matched) continue
      if (outputName !== undefined && candidate.name !== outputName) continue
      paired = i
      break
    }
    if (paired >= 0) {
      const call = calls[paired]
      if (call !== undefined) {
        call.matched = true
        item['call_id'] = itemCallIds(items, paired)
      }
    }
  }
  return items
}

/** Call id of the Nth tool-call item (pre-processing order). */
function itemCallIds(items: readonly Record<string, unknown>[], callIndex: number): string {
  let seen = -1
  for (const item of items) {
    const type = typeof item['type'] === 'string' ? (item['type'] as string) : ''
    if (type !== 'function_call' && type !== 'custom_tool_call') continue
    seen += 1
    if (seen === callIndex) return extractCallId(item) ?? ''
  }
  return ''
}

/**
 * Call-id extraction order: `call_id`, `tool_call_id`, `callId`, then
 * `id` (ids that start with `fco_` never count).
 */
function extractCallId(item: Record<string, unknown>): string | undefined {
  for (const key of ['call_id', 'tool_call_id', 'callId']) {
    const value = item[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  const id = item['id']
  if (typeof id === 'string' && id.length > 0 && !id.startsWith('fco_')) return id
  return undefined
}

/**
 * Streaming message assembler: buffers reasoning and tool calls, defers
 * messages that would break tool-call adjacency, and merges tool-call
 * flushes into a preceding plain assistant message.
 */
class MessageAssembler {
  private readonly out: WireObject[] = []
  private readonly deferred: WireObject[] = []
  private pendingReasoning: string | undefined
  private pendingCalls: WireObject[] = []
  private readonly awaiting = new Set<string>()
  private mergeableAssistantIndex: number | undefined

  /** Processes one input item; messages accumulate until {@link finish}. */
  accept(item: Record<string, unknown>, bodyText: string, itemIndex: number): void {
    const type = typeof item['type'] === 'string' ? (item['type'] as string) : ''
    const role = typeof item['role'] === 'string' ? (item['role'] as string) : undefined

    if (type === 'function_call' || type === 'custom_tool_call') {
      const callId = extractCallId(item) ?? ''
      const name = typeof item['name'] === 'string' ? (item['name'] as string) : ''
      const namespace = typeof item['namespace'] === 'string' ? (item['namespace'] as string) : undefined
      const chatName =
        namespace !== undefined && namespace.length > 0
          ? namespace.endsWith('__')
            ? namespace + name
            : `${namespace}__${name}`
          : name
      const argumentsText =
        type === 'custom_tool_call'
          ? customToolArguments(typeof item['input'] === 'string' ? (item['input'] as string) : '')
          : typeof item['arguments'] === 'string'
            ? (item['arguments'] as string)
            : ''
      this.pendingCalls.push(sortKeysDeep(chatToolCallEntry(callId, chatName, argumentsText)))
      if (callId.length > 0) this.awaiting.add(callId)
      return
    }

    // Every non-tool-call item flushes buffered tool calls first.
    this.flushToolCalls()

    if (type === 'reasoning') {
      const summary = reasoningSummaryText(item)
      this.pendingReasoning = this.pendingReasoning === undefined ? summary : this.pendingReasoning + summary
      return
    }

    if (type === 'function_call_output' || type === 'custom_tool_call_output') {
      this.acceptToolOutput(item, bodyText, itemIndex)
      return
    }

    if (type === 'message' || (type === '' && role !== undefined)) {
      this.acceptMessage(item)
      return
    }

    if (type === 'additional_tools') return
    // Unknown item types (web_search_call, file_search_call, ...) drop and
    // break assistant-message mergeability.
    this.mergeableAssistantIndex = undefined
  }

  /** Flushes buffered state at the end of input. */
  finish(): readonly WireObject[] {
    this.flushToolCalls()
    this.flushPendingReasoning()
    this.flushDeferred()
    return this.out
  }

  private acceptToolOutput(item: Record<string, unknown>, bodyText: string, itemIndex: number): void {
    const callId = extractCallId(item) ?? ''
    const custom = item['type'] === 'custom_tool_call_output'
    const content = custom
      ? customOutputContent(item['output'])
      : functionOutputContent(item, bodyText, itemIndex)
    if (callId.length > 0 && this.awaiting.has(callId)) {
      this.awaiting.delete(callId)
      this.emit({ role: 'tool', tool_call_id: callId, content })
      if (this.awaiting.size === 0) this.flushDeferred()
      return
    }
    if (content === '' || (Array.isArray(content) && content.length === 0)) return
    this.emit({ role: 'user', content })
  }

  private acceptMessage(item: Record<string, unknown>): void {
    const role = typeof item['role'] === 'string' ? (item['role'] as string) : ''
    const chatRole = role === 'developer' ? 'user' : role
    const message: WireObject = { role: chatRole, content: messageContent(item) }
    if (chatRole === 'assistant') {
      const own = typeof item['reasoning_content'] === 'string' ? (item['reasoning_content'] as string) : undefined
      const reasoning = combineReasoning(this.pendingReasoning, own)
      this.pendingReasoning = undefined
      if (reasoning !== undefined && reasoning.length > 0) message['reasoning_content'] = reasoning
    } else {
      this.flushPendingReasoning()
    }
    const landed = this.emit(message)
    this.mergeableAssistantIndex =
      landed && chatRole === 'assistant' && !Array.isArray(message['tool_calls']) ? this.out.length - 1 : undefined
  }

  private flushToolCalls(): void {
    if (this.pendingCalls.length === 0) return
    const calls = this.pendingCalls
    this.pendingCalls = []
    const mergeIndex = this.mergeableAssistantIndex
    const mergeTarget = mergeIndex !== undefined ? this.out[mergeIndex] : undefined
    if (mergeIndex !== undefined && mergeTarget !== undefined) {
      mergeTarget['tool_calls'] = calls
      if (this.pendingReasoning !== undefined) {
        const existing = mergeTarget['reasoning_content']
        mergeTarget['reasoning_content'] = combineReasoning(
          this.pendingReasoning,
          typeof existing === 'string' ? existing : undefined,
        )
      }
      this.pendingReasoning = undefined
    } else {
      const message: WireObject = { role: 'assistant', tool_calls: calls }
      if (this.pendingReasoning !== undefined) {
        message['reasoning_content'] = this.pendingReasoning
        this.pendingReasoning = undefined
      }
      this.emit(message)
    }
    this.mergeableAssistantIndex = undefined
  }

  private flushPendingReasoning(): void {
    if (this.pendingReasoning === undefined) return
    this.emit({ role: 'assistant', content: '', reasoning_content: this.pendingReasoning })
    this.pendingReasoning = undefined
    this.mergeableAssistantIndex = undefined
  }

  /** Emits a message directly, or defers it while tool outputs are awaited. */
  private emit(message: WireObject): boolean {
    if (this.awaiting.size > 0) {
      this.deferred.push(message)
      return false
    }
    this.out.push(message)
    return true
  }

  private flushDeferred(): void {
    if (this.awaiting.size > 0 || this.deferred.length === 0) return
    for (const message of this.deferred) this.out.push(message)
    this.deferred.length = 0
  }
}

/** Joins a buffered reasoning string with a message's own, dropping duplicates. */
function combineReasoning(pending: string | undefined, own: string | undefined): string | undefined {
  if (pending === undefined) return own
  if (own === undefined || own === '') return pending
  if (pending === own) return pending
  return `${pending}\n\n${own}`
}

/** Concatenated summary texts of a reasoning item; empty becomes the recorded placeholder. */
function reasoningSummaryText(item: Record<string, unknown>): string {
  let text = ''
  const summary = item['summary']
  if (Array.isArray(summary)) {
    for (const part of summary) {
      if (!isPlainObject(part)) continue
      if (part['type'] !== undefined && part['type'] !== 'summary_text') continue
      const value = part['text']
      if (typeof value === 'string') text += value
    }
  }
  return text.length > 0 ? text : REASONING_UNAVAILABLE
}

/** Chat content of a `message` item: strings stay strings, arrays map to parts, the rest is []. */
function messageContent(item: Record<string, unknown>): WireObject[] | string {
  const content = item['content']
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return []
  const parts: WireObject[] = []
  for (const entry of content) {
    const part = messagePart(entry)
    if (part !== undefined) parts.push(part)
  }
  return parts
}

function messagePart(entry: unknown): WireObject | undefined {
  if (!isPlainObject(entry)) return undefined
  const type = typeof entry['type'] === 'string' ? (entry['type'] as string) : ''
  if (type === 'input_image') return imagePart(entry)
  if (type === 'input_text' || type === 'output_text' || type === '') {
    return { type: 'text', text: partText(entry) }
  }
  // Every other part type (input_file, ...) drops.
  return undefined
}

function imagePart(entry: Record<string, unknown>): WireObject {
  const imageUrl: WireObject = { url: imageUrlOf(entry) }
  const detail = normalizeImageDetail(detailOf(entry))
  if (detail !== undefined) imageUrl['detail'] = detail
  return { type: 'image_url', image_url: imageUrl }
}

function imageUrlOf(entry: Record<string, unknown>): string {
  const direct = entry['image_url']
  if (typeof direct === 'string') return direct
  if (isPlainObject(direct) && typeof direct['url'] === 'string') return direct['url'] as string
  return ''
}

function detailOf(entry: Record<string, unknown>): unknown {
  const own = entry['detail']
  if (own !== undefined) return own
  const embedded = entry['image_url']
  if (isPlainObject(embedded)) return embedded['detail']
  return undefined
}

/** `auto`/`low`/`high` stay, `original` maps to `high`, everything else drops. */
function normalizeImageDetail(detail: unknown): string | undefined {
  if (typeof detail !== 'string' || detail.length === 0) return undefined
  if (detail === 'auto' || detail === 'low' || detail === 'high') return detail
  if (detail === 'original') return 'high'
  return undefined
}

function partText(entry: Record<string, unknown>): string {
  const text = entry['text']
  if (typeof text === 'string') return text
  if (text === undefined || text === null) return ''
  return JSON.stringify(text)
}

// ---------------------------------------------------------------------------
// Tool-output content extraction
// ---------------------------------------------------------------------------

/**
 * Content of a `function_call_output` (recorded `setFunctionCallOutputContent`
 * semantics): non-JSON strings pass through; JSON values that parse into
 * an array carrying image parts map to chat parts; everything else becomes
 * the RAW JSON text of the output member.
 */
function functionOutputContent(
  item: Record<string, unknown>,
  bodyText: string,
  itemIndex: number,
): string | readonly WireObject[] {
  const output = item['output']
  if (typeof output === 'string') {
    if (!isValidJson(output)) return output
    const parsed = parseStrictJson(output)
    if (Array.isArray(parsed) && arrayHasImagePart(parsed)) return chatParts(parsed)
    return output
  }
  if (Array.isArray(output) || isPlainObject(output)) {
    if (Array.isArray(output) && arrayHasImagePart(output)) return chatParts(output)
    return rawOutputText(bodyText, itemIndex) ?? JSON.stringify(output)
  }
  if (output === undefined || output === null) return ''
  return rawOutputText(bodyText, itemIndex) ?? JSON.stringify(output)
}

/**
 * Content of a `custom_tool_call_output`: the flattened text of string or
 * array-of-parts outputs; image arrays fall back to the structured parts
 * rule of function outputs.
 */
function customOutputContent(output: unknown): string | readonly WireObject[] {
  if (typeof output === 'string') return output
  if (Array.isArray(output)) {
    if (arrayHasImagePart(output)) return chatParts(output)
    const texts: string[] = []
    for (const entry of output) {
      if (isPlainObject(entry) && typeof entry['text'] === 'string') texts.push(entry['text'] as string)
    }
    return texts.join('\n')
  }
  if (output === undefined || output === null) return ''
  return JSON.stringify(output)
}

/** Raw member bytes of an input item's `output` field, original spacing kept. */
function rawOutputText(bodyText: string, itemIndex: number): string | undefined {
  return rawValueAt(bodyText, ['input', String(itemIndex), 'output'])
}

function arrayHasImagePart(values: readonly unknown[]): boolean {
  return values.some((value) => {
    if (!isPlainObject(value)) return false
    const type = value['type']
    return type === 'image_url' || type === 'input_image'
  })
}

/** Chat-side parts of a tool-output array: text parts and image parts. */
function chatParts(values: readonly unknown[]): readonly WireObject[] {
  const parts: WireObject[] = []
  for (const entry of values) {
    if (typeof entry === 'string') {
      parts.push({ type: 'text', text: entry })
      continue
    }
    if (!isPlainObject(entry)) continue
    const type = entry['type']
    if (type === 'text' || type === 'input_text' || type === 'output_text') {
      parts.push({ type: 'text', text: partText(entry) })
      continue
    }
    if (type === 'image_url' || type === 'input_image') {
      parts.push({ type: 'image_url', image_url: { url: imagePartUrl(entry) } })
    }
  }
  return parts
}

function imagePartUrl(entry: Record<string, unknown>): string {
  const direct = entry['image_url']
  if (typeof direct === 'string') return direct
  if (isPlainObject(direct) && typeof direct['url'] === 'string') return direct['url'] as string
  if (typeof entry['url'] === 'string') return entry['url'] as string
  return ''
}

export type { DeclaredTool }
