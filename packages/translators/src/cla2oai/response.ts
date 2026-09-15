/**
 * Response translation: OpenAI chat completion -> Claude message
 * (S2d4 sections 3.4-3.5, 4.2-4.3).
 *
 * The non-stream envelope carries the exact recorded key order
 * id/type/role/model/content/stop_reason/stop_sequence/usage. Content
 * blocks derive from `choices[0]`: a string content becomes one text
 * block, `reasoning_content` becomes thinking blocks appended after the
 * content-derived blocks, `tool_calls` become tool_use blocks last -
 * ids sanitized (`call:rich:1` -> `call_rich_1`), names restored via the
 * request tool map (`get_weather` -> `Get_Weather`), arguments parsed
 * after the quote repair (anything else -> `{}`). The stop-reason ladder
 * and the usage cache math (120-30 -> 90/13, cache_read 30,
 * cache_creation 5) are the recorded contract. This module also carries
 * the downstream event templates and the SSE framing of the stream
 * side (section 4.2).
 */
import {
  isPlainObject,
  readArray,
  readObject,
  readString,
  serializeOrdered,
} from './json'
import type { WireObject } from './json'
import {
  argumentsAreValidObject,
  generatedToolUseId,
  parseToolArguments,
  restoreToolName,
  sanitizeClaudeToolId,
} from './schema'
import type { ToolNameIndex } from './schema'

// ---------------------------------------------------------------------------
// Shared mappers
// ---------------------------------------------------------------------------

/** OpenAI `finish_reason` -> Claude `stop_reason` (recorded table). */
export function mapFinishReasonToStopReason(finishReason: string): string {
  switch (finishReason) {
    case 'stop':
      return 'end_turn'
    case 'length':
      return 'max_tokens'
    case 'tool_calls':
      return 'tool_use'
    case 'content_filter':
      return 'end_turn'
    case 'function_call':
      return 'tool_use'
    default:
      return 'end_turn'
  }
}

/**
 * Extracts the thought texts of a `reasoning_content` value: a plain
 * string, an array of strings or objects with a `text` field, or an
 * object with a `text` field. Empty texts are skipped.
 */
export function extractReasoningTexts(reasoning: unknown): readonly string[] {
  const out: string[] = []
  if (typeof reasoning === 'string') {
    if (reasoning.length > 0) out.push(reasoning)
    return out
  }
  if (Array.isArray(reasoning)) {
    for (const entry of reasoning) collectReasoningEntry(entry, out)
    return out
  }
  if (typeof reasoning === 'object' && reasoning !== null) {
    collectReasoningEntry(reasoning, out)
  }
  return out
}

function collectReasoningEntry(entry: unknown, out: string[]): void {
  if (typeof entry === 'string') {
    if (entry.length > 0) out.push(entry)
    return
  }
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return
  const text = (entry as Record<string, unknown>)['text']
  if (typeof text === 'string' && text.length > 0) out.push(text)
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const raw = record[key]
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined
}

/**
 * `usage` -> the Claude usage object with the recorded cache math:
 * `input_tokens` = prompt_tokens minus `prompt_tokens_details.cached_tokens`
 * (clamped at 0), `output_tokens` = completion_tokens, then
 * `cache_read_input_tokens` (cached_tokens) and
 * `cache_creation_input_tokens` (cache_write_tokens, falling back to
 * cache_creation_tokens), each only when > 0. Absent usage reads as
 * `{"input_tokens":0,"output_tokens":0}`.
 */
export function extractOpenAIUsage(usage: unknown): WireObject {
  if (typeof usage !== 'object' || usage === null || Array.isArray(usage)) {
    return { input_tokens: 0, output_tokens: 0 }
  }
  const record = usage as Record<string, unknown>
  const prompt = readNumber(record, 'prompt_tokens') ?? 0
  const completion = readNumber(record, 'completion_tokens') ?? 0
  const details = readObject(record, 'prompt_tokens_details')
  const cached = details !== undefined ? readNumber(details, 'cached_tokens') ?? 0 : 0
  const cacheWrite =
    details !== undefined
      ? readNumber(details, 'cache_write_tokens') ?? readNumber(details, 'cache_creation_tokens') ?? 0
      : 0
  const out: WireObject = {
    input_tokens: Math.max(0, prompt - cached),
    output_tokens: completion,
  }
  if (cached > 0) out['cache_read_input_tokens'] = cached
  if (cacheWrite > 0) out['cache_creation_input_tokens'] = cacheWrite
  return out
}

/** One `{"type":"tool_use",...}` content block from a `tool_calls` entry. */
export function toolUseBlock(call: Record<string, unknown>, toolNames: ToolNameIndex): WireObject {
  const fn = readObject(call, 'function')
  const upstreamName = fn !== undefined ? readString(fn, 'name') ?? '' : ''
  const argumentsText = fn !== undefined ? readString(fn, 'arguments') : undefined
  const rawId = readString(call, 'id') ?? ''
  const id = rawId.length > 0 ? sanitizeClaudeToolId(rawId) : generatedToolUseId()
  return {
    type: 'tool_use',
    id,
    name: restoreToolName(toolNames, upstreamName),
    input: parseToolArguments(argumentsText),
  }
}

/** True when the entry is a tool_calls item with a usable function member. */
function isFunctionCallEntry(entry: Record<string, unknown>): boolean {
  const type = entry['type']
  return type === undefined || type === 'function'
}

// ---------------------------------------------------------------------------
// Non-stream translation
// ---------------------------------------------------------------------------

/** Context the non-stream translation needs. */
export interface OpenAIToClaudeContext {
  /** Name-restore index built from the request's tools. */
  readonly toolNames: ToolNameIndex
}

/**
 * Translates one upstream chat-completion body into the Claude message
 * envelope (recorded key order). Only `choices[0]` is considered; no
 * choices yield an empty `content` array. Throws
 * `CpaError('invalid-input', ...)` when the upstream body is not strict
 * JSON - the caller renders the failure.
 */
export function translateOpenAIResponseToClaude(
  upstreamBody: string,
  ctx: OpenAIToClaudeContext,
): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(upstreamBody)
  } catch {
    throw new Error('upstream response is not valid JSON')
  }
  const response = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {}

  const content: WireObject[] = []
  let sawToolUse = false
  const choice = firstChoice(response)
  if (choice !== undefined) {
    const message = readObject(choice, 'message')
    if (message !== undefined) {
      const messageContent = message['content']
      if (typeof messageContent === 'string') {
        if (messageContent.length > 0) content.push({ type: 'text', text: messageContent })
      } else if (Array.isArray(messageContent)) {
        appendArrayContent(content, messageContent, ctx.toolNames, (used) => {
          sawToolUse = sawToolUse || used
        })
      }
      for (const text of extractReasoningTexts(message['reasoning_content'])) {
        content.push({ type: 'thinking', thinking: text })
      }
      for (const call of readArray(message, 'tool_calls') ?? []) {
        if (!isPlainObject(call) || !isFunctionCallEntry(call)) continue
        content.push(toolUseBlock(call, ctx.toolNames))
        sawToolUse = true
      }
    }
  }

  const finish = choice !== undefined ? readString(choice, 'finish_reason') : undefined
  const stopReason =
    finish !== undefined && finish.length > 0
      ? mapFinishReasonToStopReason(finish)
      : sawToolUse
        ? 'tool_use'
        : 'end_turn'

  const envelope: WireObject = {
    id: readString(response, 'id') ?? '',
    type: 'message',
    role: 'assistant',
    model: readString(response, 'model') ?? '',
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: extractOpenAIUsage(response['usage']),
  }
  return serializeOrdered(envelope)
}

/** `choices[0]` as a record, when present and object-shaped. */
function firstChoice(response: Record<string, unknown>): Record<string, unknown> | undefined {
  const choices = readArray(response, 'choices')
  if (choices === undefined || choices.length === 0) return undefined
  const choice = choices[0]
  if (!isPlainObject(choice)) return undefined
  return choice
}

/**
 * Walks an ARRAY-form `message.content`: `text` items merge into one
 * text block per consecutive run, `reasoning` items accumulate into a
 * thinking block flushed before pending text, `tool_calls` items flush
 * the accumulators and emit tool_use blocks, other item types flush and
 * drop.
 */
function appendArrayContent(
  content: WireObject[],
  items: readonly unknown[],
  toolNames: ToolNameIndex,
  onToolUse: (used: boolean) => void,
): void {
  let pendingText: string[] = []
  let pendingThinking: string[] = []
  const flushText = (): void => {
    if (pendingText.length > 0) content.push({ type: 'text', text: pendingText.join('') })
    pendingText = []
  }
  const flushThinking = (): void => {
    if (pendingThinking.length > 0) {
      content.push({ type: 'thinking', thinking: pendingThinking.join('') })
    }
    pendingThinking = []
  }
  for (const item of items) {
    if (!isPlainObject(item)) {
      flushThinking()
      flushText()
      continue
    }
    const type = item['type']
    if (type === 'text') {
      const text = item['text']
      if (typeof text === 'string' && text.length > 0) pendingText.push(text)
      continue
    }
    if (type === 'reasoning') {
      for (const text of extractReasoningTexts(item['summary'] ?? item['text'] ?? item['content'])) {
        pendingThinking.push(text)
      }
      continue
    }
    if (type === 'tool_calls' || type === 'function_call') {
      flushThinking()
      flushText()
      const call = readObject(item, 'tool_call') ?? readObject(item, 'function_call') ?? item
      content.push(toolUseBlock(call, toolNames))
      onToolUse(true)
      continue
    }
    // Unknown item types flush and drop.
    flushThinking()
    flushText()
  }
  flushThinking()
  flushText()
}

// ---------------------------------------------------------------------------
// Downstream stream-event templates (section 4.2)
// ---------------------------------------------------------------------------

/**
 * Frames one downstream Claude stream event: exactly
 * `event: <name>\ndata: <json>\n\n` (recorded framing).
 */
export function formatClaudeEvent(name: string, data: WireObject): string {
  return `event: ${name}\ndata: ${serializeOrdered(data)}\n\n`
}

/** `message_start` event with the local input-token estimate (4.3). */
export function messageStartEvent(inputTokens: number, id: string, model: string): string {
  return formatClaudeEvent('message_start', {
    type: 'message_start',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: 0 },
    },
  })
}

/** `content_block_start` for a text or thinking block. */
export function contentBlockStartEvent(
  kind: 'text' | 'thinking',
  index: number,
): string {
  const block: WireObject = kind === 'text' ? { type: 'text', text: '' } : { type: 'thinking', thinking: '' }
  return formatClaudeEvent('content_block_start', {
    type: 'content_block_start',
    index,
    content_block: block,
  })
}

/** `content_block_start` for a tool_use block (sanitized id, mapped name). */
export function toolBlockStartEvent(index: number, id: string, name: string): string {
  return formatClaudeEvent('content_block_start', {
    type: 'content_block_start',
    index,
    content_block: { type: 'tool_use', id, name, input: {} },
  })
}

/** `content_block_delta` with a text or thinking value. */
export function contentDeltaEvent(
  kind: 'text' | 'thinking',
  index: number,
  text: string,
): string {
  const type = kind === 'text' ? 'text_delta' : 'thinking_delta'
  const key = kind === 'text' ? 'text' : 'thinking'
  return formatClaudeEvent('content_block_delta', {
    type: 'content_block_delta',
    index,
    delta: { type, [key]: text },
  })
}

/** The single buffered `input_json_delta` of a finalized tool block. */
export function inputJsonDeltaEvent(index: number, partialJson: string): string {
  return formatClaudeEvent('content_block_delta', {
    type: 'content_block_delta',
    index,
    delta: { type: 'input_json_delta', partial_json: partialJson },
  })
}

/** `content_block_stop`. */
export function contentBlockStopEvent(index: number): string {
  return formatClaudeEvent('content_block_stop', { type: 'content_block_stop', index })
}

/** `message_delta` with the mapped stop reason and the cached usage math. */
export function messageDeltaEvent(stopReason: string, usage: WireObject): string {
  return formatClaudeEvent('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage,
  })
}

/** `message_stop`. */
export function messageStopEvent(): string {
  return formatClaudeEvent('message_stop', { type: 'message_stop' })
}

/** Terminal in-stream error frame (section 4.4). */
export function streamErrorEvent(message: string): string {
  return formatClaudeEvent('error', {
    type: 'error',
    error: { type: 'api_error', message },
  })
}

// ---------------------------------------------------------------------------
// Finish-reason capture (section 4.2 rule 5)
// ---------------------------------------------------------------------------

/** Result of the finish-reason capture pass. */
export interface FinishCapture {
  /** Internal reason fed to the stop-reason mapper. */
  readonly reason: string
}

/**
 * Captures the effective internal stop reason for a finish frame:
 * `length` and `content_filter` stay verbatim; `tool_calls` maps to
 * `stop` without an announced tool block, and with announced blocks it
 * stays `tool_calls` while every announced block's arguments are empty,
 * `{}` or a valid JSON object - non-empty arguments that are not a valid
 * JSON object degrade to `length`; anything else stays verbatim.
 */
export function captureFinishReason(
  finishReason: string,
  announcedArguments: readonly string[],
): FinishCapture {
  if (finishReason === 'length' || finishReason === 'content_filter') {
    return { reason: finishReason }
  }
  if (finishReason === 'tool_calls') {
    if (announcedArguments.length === 0) return { reason: 'stop' }
    for (const args of announcedArguments) {
      if (!argumentsAreValidObject(args)) return { reason: 'length' }
    }
    return { reason: 'tool_calls' }
  }
  return { reason: finishReason }
}
