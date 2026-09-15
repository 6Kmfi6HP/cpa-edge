/**
 * Response translation: Gemini generateContent -> Claude Messages.
 *
 * Two consumers share this module: the non-stream mapping (section 3.4)
 * renders one message JSON body; the SSE state machine (section 3.5)
 * turns each upstream chunk into a concatenated run of Claude events.
 * Recorded pins encoded here: the exact event templates and field order,
 * the literal `message_start` defaults, the input-token estimate
 * injection into the first `message_start`, the tool id restoration
 * (`<sanitized name>-<counter>`), the usage formulas (input = prompt -
 * cached, output = candidates + thoughts), the final-events gate
 * (usageMetadata AND a `finishReason` substring AND content), the
 * per-chunk usageMetadata filter, the HasContent-gated `message_stop`,
 * and the raw-splice of upstream argument bytes.
 */
import { isPlainObject, rawValueAt, readArray, readObject, readString, serializeOrdered } from './json'
import { RawJson } from './json'
import type { WireObject, WireValue } from './json'
import { restoreToolName, sanitizeClaudeToolId, sanitizeFunctionName } from './schema'
import type { ToolNameIndex } from './schema'
import { DEFAULT_STREAM_MESSAGE_ID, DEFAULT_STREAM_MODEL } from './types'

/** Input context of every response translation. */
export interface GeminiToClaudeContext {
  /** Raw upstream response bytes (argument values are spliced verbatim). */
  readonly upstreamBody: string
  /** Name-restore index built from the request's tools. */
  readonly toolNames: ToolNameIndex
}

/** Frame of one downstream SSE event: `event: <name>\ndata: <json>\n\n\n`. */
export function formatClaudeEvent(name: string, payload: string): string {
  return `event: ${name}\ndata: ${payload}\n\n\n`
}

/** Reads the first candidate object of a Gemini response, if any. */
function firstCandidate(parsed: Record<string, unknown>): Record<string, unknown> | undefined {
  const candidates = readArray(parsed, 'candidates')
  const first = candidates?.[0]
  return isPlainObject(first) ? first : undefined
}

/** Reads the parts array of the first candidate, if any. */
function candidateParts(parsed: Record<string, unknown>): readonly unknown[] | undefined {
  const candidate = firstCandidate(parsed)
  if (candidate === undefined) return undefined
  const content = readObject(candidate, 'content')
  const parts = content === undefined ? undefined : readArray(content, 'parts')
  return parts
}

/** Reads a thought signature in either spelling. */
function partSignature(part: Record<string, unknown>): string | undefined {
  return readString(part, 'thoughtSignature') ?? readString(part, 'thought_signature')
}

// ---------------------------------------------------------------------------
// Usage formulas (section 3.4)
// ---------------------------------------------------------------------------

/** Extracted usage counts of one usageMetadata object. */
export interface GeminiUsage {
  readonly prompt: number
  readonly candidates: number
  readonly thoughts: number
  readonly cached: number
}

function countOf(record: Record<string, unknown>, key: string): number {
  const raw = record[key]
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0
}

/** Reads a usageMetadata object into its four counts. */
export function readGeminiUsage(usageMetadata: Record<string, unknown> | undefined): GeminiUsage {
  if (usageMetadata === undefined) {
    return { prompt: 0, candidates: 0, thoughts: 0, cached: 0 }
  }
  return {
    prompt: countOf(usageMetadata, 'promptTokenCount'),
    candidates: countOf(usageMetadata, 'candidatesTokenCount'),
    thoughts: countOf(usageMetadata, 'thoughtsTokenCount'),
    cached: countOf(usageMetadata, 'cachedContentTokenCount'),
  }
}

/** Usage object in wire key order; cache_read only when cached > 0. */
export function claudeUsageObject(usage: GeminiUsage): WireObject {
  const input = Math.max(0, usage.prompt - usage.cached)
  const output = usage.candidates + usage.thoughts
  const out: WireObject = { input_tokens: input, output_tokens: output }
  if (usage.cached > 0) out['cache_read_input_tokens'] = usage.cached
  return out
}

/** Stop-reason ladder: tool_use > MAX_TOKENS > end_turn. */
export function claudeStopReason(sawFunctionCall: boolean, finishReason: string | undefined): string {
  if (sawFunctionCall) return 'tool_use'
  if (finishReason === 'MAX_TOKENS') return 'max_tokens'
  return 'end_turn'
}

// ---------------------------------------------------------------------------
// Non-stream mapping (section 3.4)
// ---------------------------------------------------------------------------

/**
 * Argument value of a functionCall at a part path, re-serialized compactly
 * (recordings pin compact downstream argument values; the REQUEST side is
 * where raw client bytes survive). Missing arguments render `{}`.
 */
function argsValueAt(body: string, partPath: readonly string[]): WireValue {
  const call = readCallAt(body, partPath)
  if (call === undefined || call['args'] === undefined) return {}
  return serializeOrdered(call['args'] as WireValue)
}

/** Parsed functionCall object at a part path, or undefined. */
function readCallAt(body: string, partPath: readonly string[]): Record<string, unknown> | undefined {
  const callSpan = rawValueAt(body, [...partPath, 'functionCall'])
  if (callSpan === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(callSpan)
    if (!isPlainObject(parsed)) return undefined
    return parsed
  } catch {
    return undefined
  }
}

/**
 * Compact argument text of a functionCall at a part path (the streamed
 * `partial_json` payload), or undefined when the call carries no args.
 */
function argsTextAt(body: string, partPath: readonly string[]): string | undefined {
  const call = readCallAt(body, partPath)
  if (call === undefined || call['args'] === undefined) return undefined
  return serializeOrdered(call['args'] as WireValue)
}

/**
 * Translates one Gemini generateContent JSON body into the Claude
 * message body. The template and its field order are recorded:
 * id, type, role, model, content, stop_reason, stop_sequence, usage.
 * A body without a parseable JSON document renders the empty template
 * (the upstream is consumed best-effort on this side; no validation
 * family exists for this direction).
 */
export function translateGeminiResponseToClaude(ctx: GeminiToClaudeContext): string {
  const body = ctx.upstreamBody
  let parsed: Record<string, unknown> = {}
  try {
    const value: unknown = JSON.parse(body)
    if (isPlainObject(value)) parsed = value
  } catch {
    parsed = {}
  }

  const responseId = readString(parsed, 'responseId') ?? ''
  const modelVersion = readString(parsed, 'modelVersion') ?? ''
  const candidate = firstCandidate(parsed)
  const finishReason = candidate === undefined ? undefined : readString(candidate, 'finishReason')
  const usageMeta = readObject(parsed, 'usageMetadata')

  const blocks: WireObject[] = []
  let textBuffer = ''
  let thinkingBuffer = ''
  let pendingSignature: string | undefined
  let mode: 'none' | 'text' | 'thinking' = 'none'
  let sawFunctionCall = false
  let callCounter = 0

  const parts = candidateParts(parsed) ?? []
  const flush = () => {
    if (mode === 'text' && textBuffer.length > 0) {
      blocks.push({ type: 'text', text: textBuffer })
    }
    if (mode === 'thinking' && thinkingBuffer.length > 0) {
      const block: WireObject = { type: 'thinking', thinking: thinkingBuffer }
      if (pendingSignature !== undefined) block['signature'] = pendingSignature
      blocks.push(block)
    }
    if (mode === 'thinking' && thinkingBuffer.length === 0 && pendingSignature !== undefined) {
      const last = blocks[blocks.length - 1]
      if (last !== undefined && last['type'] === 'thinking' && last['signature'] === undefined) {
        last['signature'] = pendingSignature
      }
    }
    textBuffer = ''
    thinkingBuffer = ''
    pendingSignature = undefined
    mode = 'none'
  }

  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]
    if (!isPlainObject(part)) continue
    const partPath = ['candidates', '0', 'content', 'parts', String(index)]
    const call = readObject(part, 'functionCall')
    if (call !== undefined) {
      flush()
      sawFunctionCall = true
      callCounter += 1
      const upstreamName = readString(call, 'name') ?? ''
      const restored = restoreToolName(ctx.toolNames, upstreamName)
      const block: WireObject = {
        type: 'tool_use',
        id: sanitizeClaudeToolId(`${restored}-${callCounter}`),
        name: restored,
      }
      block['input'] = argsValueAt(body, partPath)
      blocks.push(block)
      continue
    }
    const text = part['text']
    const signature = partSignature(part)
    const thought = part['thought'] === true
    if (typeof text === 'string' && text.length > 0 && (thought || signature !== undefined)) {
      if (mode !== 'thinking') {
        flush()
        mode = 'thinking'
      }
      thinkingBuffer += text
      if (signature !== undefined && signature.length > 0) pendingSignature = signature
      continue
    }
    if (typeof text === 'string' && text.length > 0) {
      if (mode !== 'text') {
        flush()
        mode = 'text'
      }
      textBuffer += text
      continue
    }
    if (signature !== undefined && signature.length > 0) {
      // Signature-only part: keep the signature for the open thinking block.
      if (mode === 'thinking') pendingSignature = signature
    }
  }
  flush()

  const message: WireObject = {
    id: responseId,
    type: 'message',
    role: 'assistant',
    model: modelVersion,
    content: blocks,
    stop_reason: claudeStopReason(sawFunctionCall, finishReason),
    stop_sequence: null,
  }
  const usage = readGeminiUsage(usageMeta)
  const inputTokens = Math.max(0, usage.prompt - usage.cached)
  const outputTokens = usage.candidates + usage.thoughts
  const seenUsage = usageMeta !== undefined
  if (seenUsage || inputTokens > 0 || outputTokens > 0) {
    message['usage'] = claudeUsageObject(usage)
  }
  return serializeOrdered(message)
}

// ---------------------------------------------------------------------------
// Stream state machine (section 3.5)
// ---------------------------------------------------------------------------

/**
 * Per-request stream translation. Feed each decoded upstream data line
 * through {@link translateChunk}; every call returns the concatenated
 * events of that chunk (one downstream write). At stream end call
 * {@link handleStreamEnd} (the synthetic `[DONE]` pass) and, for a
 * post-commit transport failure, {@link handleTransportFailure}.
 */
export class GeminiToClaudeStreamTranslator {
  private readonly inputTokens: number
  private readonly toolNames: ToolNameIndex
  /** Raw text of the chunk being translated (argument bytes are spliced). */
  private currentChunk = ''
  private messageStartSent = false
  private mode: 'none' | 'text' | 'thinking' | 'tool' = 'none'
  private index = -1
  private toolCounter = 0
  private hasContent = false
  private sawFunctionCall = false
  private finalFired = false

  constructor(input: {
    /** o200k estimate of the ORIGINAL client request (ruling S2d8-1). */
    readonly inputTokens: number
    /** Name-restore index built from the request's tools. */
    readonly toolNames: ToolNameIndex
  }) {
    this.inputTokens = input.inputTokens
    this.toolNames = input.toolNames
  }

  /** Translates one upstream `data:` payload into its downstream events. */
  translateChunk(data: string): string {
    let parsed: Record<string, unknown>
    try {
      const value: unknown = JSON.parse(data)
      if (!isPlainObject(value)) return ''
      parsed = value
    } catch {
      return ''
    }

    // Section 3.5.9: mid-stream usage updates never reach the gate.
    const hasFinish = data.includes('finishReason')
    if (!hasFinish) delete parsed['usageMetadata']
    this.currentChunk = data

    let out = ''
    if (!this.messageStartSent) {
      this.messageStartSent = true
      const id = readString(parsed, 'responseId') ?? DEFAULT_STREAM_MESSAGE_ID
      const model = readString(parsed, 'modelVersion') ?? DEFAULT_STREAM_MODEL
      const message: WireObject = {
        id,
        type: 'message',
        role: 'assistant',
        content: [],
        model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: this.inputTokens, output_tokens: 0 },
      }
      out += formatClaudeEvent(
        'message_start',
        serializeOrdered({ type: 'message_start', message }),
      )
    }

    const parts = candidateParts(parsed) ?? []
    for (let position = 0; position < parts.length; position++) {
      const part = parts[position]
      if (!isPlainObject(part)) continue
      const partPath = ['candidates', '0', 'content', 'parts', String(position)]
      const call = readObject(part, 'functionCall')
      if (call !== undefined) {
        out += this.onFunctionCall(call, partPath)
        continue
      }
      const text = part['text']
      const signature = partSignature(part)
      const thought = part['thought'] === true
      if (typeof text === 'string' && text.length > 0 && (thought || signature !== undefined)) {
        out += this.onThinkingText(text, signature)
        continue
      }
      if (typeof text === 'string' && text.length > 0) {
        out += this.onPlainText(text)
        continue
      }
      if (signature !== undefined && signature.length > 0 && this.mode === 'thinking') {
        out += this.onSignature(signature)
      }
    }

    const usageMeta = readObject(parsed, 'usageMetadata')
    if (!this.finalFired && usageMeta !== undefined && hasFinish && this.hasContent) {
      this.finalFired = true
      if (this.mode !== 'none') {
        out += formatClaudeEvent(
          'content_block_stop',
          serializeOrdered({ type: 'content_block_stop', index: this.index }),
        )
        this.mode = 'none'
      }
      const candidate = firstCandidate(parsed)
      const finishReason = candidate === undefined ? undefined : readString(candidate, 'finishReason')
      const delta: WireObject = {
        stop_reason: claudeStopReason(this.sawFunctionCall, finishReason),
        stop_sequence: null,
      }
      out += formatClaudeEvent(
        'message_delta',
        serializeOrdered({
          type: 'message_delta',
          delta,
          usage: claudeUsageObject(readGeminiUsage(usageMeta)),
        }),
      )
    }
    return out
  }

  /**
   * The synthetic `[DONE]` pass: `message_stop` only when at least one
   * content event was emitted. The open block, if any, stays open (the
   * recorded disconnect stream ends a text block without a stop event).
   */
  handleStreamEnd(): string {
    if (!this.hasContent) return ''
    return formatClaudeEvent('message_stop', serializeOrdered({ type: 'message_stop' }))
  }

  /**
   * Post-commit transport failure: the `[DONE]` pass, then exactly ONE
   * terminal `event: error` frame (two-newline framing) with the pinned
   * `unexpected EOF` message. HTTP stays 200.
   */
  handleTransportFailure(message: string): string {
    return this.handleStreamEnd() + formatTerminalErrorEvent(message)
  }

  private onPlainText(text: string): string {
    let out = ''
    if (this.mode !== 'text') {
      out += this.closeOpenBlock()
      this.index += 1
      out += formatClaudeEvent(
        'content_block_start',
        serializeOrdered({
          type: 'content_block_start',
          index: this.index,
          content_block: { type: 'text', text: '' },
        }),
      )
      this.mode = 'text'
      this.hasContent = true
    }
    out += formatClaudeEvent(
      'content_block_delta',
      serializeOrdered({
        type: 'content_block_delta',
        index: this.index,
        delta: { type: 'text_delta', text },
      }),
    )
    return out
  }

  private onThinkingText(text: string, signature: string | undefined): string {
    let out = ''
    if (this.mode !== 'thinking') {
      out += this.closeOpenBlock()
      this.index += 1
      out += formatClaudeEvent(
        'content_block_start',
        serializeOrdered({
          type: 'content_block_start',
          index: this.index,
          content_block: { type: 'thinking', thinking: '' },
        }),
      )
      this.mode = 'thinking'
      this.hasContent = true
    }
    out += formatClaudeEvent(
      'content_block_delta',
      serializeOrdered({
        type: 'content_block_delta',
        index: this.index,
        delta: { type: 'thinking_delta', thinking: text },
      }),
    )
    if (signature !== undefined && signature.length > 0) out += this.onSignature(signature)
    return out
  }

  private onSignature(signature: string): string {
    return formatClaudeEvent(
      'content_block_delta',
      serializeOrdered({
        type: 'content_block_delta',
        index: this.index,
        delta: { type: 'signature_delta', signature },
      }),
    )
  }

  private onFunctionCall(call: Record<string, unknown>, partPath: readonly string[]): string {
    const name = readString(call, 'name') ?? ''
    if (name.length === 0 && this.mode === 'tool') {
      // Follow-up call with an empty name: an argument delta of the open
      // tool block (native Gemini streaming shape). partial_json carries
      // the compact re-serialized argument bytes as a string value.
      const argsText = argsTextAt(this.currentChunk, partPath)
      if (argsText === undefined) return ''
      this.hasContent = true
      return formatClaudeEvent(
        'content_block_delta',
        serializeOrdered({
          type: 'content_block_delta',
          index: this.index,
          delta: { type: 'input_json_delta', partial_json: argsText },
        }),
      )
    }
    let out = this.closeOpenBlock()
    this.index += 1
    this.toolCounter += 1
    const id = `${sanitizeFunctionName(name)}-${this.toolCounter}`
    const restored = restoreToolName(this.toolNames, name)
    out += formatClaudeEvent(
      'content_block_start',
      serializeOrdered({
        type: 'content_block_start',
        index: this.index,
        content_block: { type: 'tool_use', id, name: restored, input: {} },
      }),
    )
    this.mode = 'tool'
    this.hasContent = true
    this.sawFunctionCall = true
    const argsText = argsTextAt(this.currentChunk, partPath)
    if (argsText !== undefined) {
      out += formatClaudeEvent(
        'content_block_delta',
        serializeOrdered({
          type: 'content_block_delta',
          index: this.index,
          delta: { type: 'input_json_delta', partial_json: argsText },
        }),
      )
    }
    return out
  }

  private closeOpenBlock(): string {
    if (this.mode === 'none') return ''
    const event = formatClaudeEvent(
      'content_block_stop',
      serializeOrdered({ type: 'content_block_stop', index: this.index }),
    )
    this.mode = 'none'
    return event
  }
}

/** Terminal `event: error` frame of a broken stream (two newlines). */
export function formatTerminalErrorEvent(message: string): string {
  const payload = serializeOrdered({
    type: 'error',
    error: { type: 'api_error', message },
  })
  return `event: error\ndata: ${payload}\n\n`
}
