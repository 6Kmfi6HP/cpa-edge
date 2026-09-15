/**
 * Stream translation: upstream chat SSE -> downstream Responses SSE
 * (S2d6 sections 3.4 + 4).
 *
 * The translator is a per-stream state machine. The first accepted chunk
 * (a `chat.completion.chunk` object carrying a `choices` array - EMPTY
 * accepted) emits `response.created` + `response.in_progress` with the
 * client-requested model appended after `output`. Reasoning deltas open a
 * reasoning item (lowest output index), content deltas close it and open
 * the message item, tool-call deltas open function/custom items keyed by
 * (choice index, tool index). `finish_reason` finalizes the choice's open
 * items; `[DONE]` finalizes everything and emits the terminal event -
 * SUPPRESSED when no message and no function item was ever added (the
 * stream then ends through the handler CloseError frame).
 *
 * Sequence numbers start at 1 and increment by exactly 1 per emitted
 * event; terminal error frames carry the data-frame count. Usage from any
 * chunk is captured and rendered by the terminal event in the stream
 * shape (input_tokens_details inline, output_tokens_details appended by
 * the per-chunk ensure post-step).
 */
import { decodeSseFrames } from './sse'
import type { ResponsesStreamFrame } from './sse'
import { ensureResponsesUsageDetails } from './response'
import {
  CLOSED_BEFORE_DONE_MESSAGE,
  UNEXPECTED_EOF_MESSAGE,
  closeErrorText,
  formatTerminalErrorFrame,
  statusStreamFailure,
  upstreamStreamFailure,
} from './errors'
import type { StreamFailure } from './errors'
import { isPlainObject, isValidJson, readString, serializeOrdered, sortKeysDeep, tryParseJson, wireValueOf } from './json'
import type { WireObject } from './json'
import { resolveCallName } from './tools'
import { customInputOf } from './response'
import type { ChatToResponsesStreamContext, DeclaredTool, SseFrame } from './types'
import { UPSTREAM_DONE as DONE_MARKER } from './types'

/** One translated downstream event before framing. */
export interface EmittedEvent {
  readonly event: string
  readonly data: string
}

/** Result of one translator step. */
interface StepResult {
  readonly events: readonly EmittedEvent[]
}

/** Choices the terminal-event builder echoes from the original request, in wire order. */
const ECHO_FIELDS: readonly string[] = Object.freeze([
  'instructions',
  'max_output_tokens',
  'max_tool_calls',
  'model',
  'parallel_tool_calls',
  'previous_response_id',
  'prompt_cache_key',
  'reasoning',
  'safety_identifier',
  'service_tier',
  'store',
  'temperature',
  'text',
  'tool_choice',
  'tools',
  'top_logprobs',
  'top_p',
  'truncation',
  'user',
  'metadata',
])

interface ReasoningState {
  readonly outputIndex: number
  readonly itemId: string
  open: boolean
  fullText: string
}

interface MessageState {
  readonly outputIndex: number
  readonly itemId: string
  open: boolean
  fullText: string
}

interface ToolState {
  readonly outputIndex: number
  readonly choiceIndex: number
  readonly toolIndex: number
  callId: string
  name: string
  custom: boolean
  arguments: string
  added: boolean
  open: boolean
}

interface CapturedUsage {
  promptTokens: number | undefined
  cachedTokens: number | undefined
  completionTokens: number | undefined
  reasoningTokens: number | undefined
  totalTokens: number | undefined
}

/**
 * Per-stream translation state. Feed decoded upstream data lines to
 * {@link acceptDataLine}, then close with {@link handleDone} (`[DONE]`
 * seen) or {@link handleEofFinalize} (clean EOF without `[DONE]`).
 */
export class ChatToResponsesStreamTranslator {
  readonly requestedModel: string
  private readonly resolvedModel: string
  private readonly declared: readonly DeclaredTool[]
  private readonly original: Record<string, unknown> | undefined

  private seq = 0
  private started = false
  private responseId = ''
  private createdAt = 0
  private nextOutputIndex = 0
  private finishReason: string | undefined
  private readonly choices = new Map<number, {
    reasoning: ReasoningState | undefined
    message: MessageState | undefined
    tools: Map<number, ToolState>
  }>()
  private readonly completedItems = new Map<number, WireObject>()
  private messageItemAdded = false
  private functionItemAdded = false
  terminalEmitted = false
  doneSeen = false
  private usage: CapturedUsage | undefined
  lastEventName: string | undefined

  constructor(ctx: ChatToResponsesStreamContext) {
    this.requestedModel = ctx.requestedModel.length > 0 ? ctx.requestedModel : ctx.resolvedModel
    this.resolvedModel = ctx.resolvedModel
    this.declared = ctx.tools
    const original = tryParseJson(ctx.originalBody)
    this.original = isPlainObject(original) ? original : undefined
  }

  /** Number of data frames emitted so far (equals the last sequence number). */
  get frameCount(): number {
    return this.seq
  }

  /** True once a terminal event (completed/incomplete) was emitted. */
  get isTerminalEmitted(): boolean {
    return this.terminalEmitted
  }

  /**
   * Processes one upstream data line (not `[DONE]`). Returns the events
   * it produced; the caller frames them in order.
   */
  acceptDataLine(data: string): StepResult {
    const events: EmittedEvent[] = []
    const parsed = tryParseJson(data)
    if (!isPlainObject(parsed)) return { events }

    const usage = parsed['usage']
    if (isPlainObject(usage)) this.captureUsage(usage)

    const objectField = parsed['object']
    if (objectField !== undefined && objectField !== 'chat.completion.chunk') return { events }
    const choices = parsed['choices']
    if (!Array.isArray(choices)) return { events }

    if (!this.started) {
      this.started = true
      this.responseId = readString(parsed, 'id') ?? ''
      const created = parsed['created']
      this.createdAt = typeof created === 'number' && Number.isFinite(created) ? created : 0
      this.emit(events, 'response.created', {
        type: 'response.created',
        sequence_number: 0,
        response: {
          id: this.responseId,
          object: 'response',
          created_at: this.createdAt,
          status: 'in_progress',
          background: false,
          error: null,
          output: [],
          model: this.requestedModel,
        },
      })
      this.emit(events, 'response.in_progress', {
        type: 'response.in_progress',
        sequence_number: 0,
        response: {
          id: this.responseId,
          object: 'response',
          created_at: this.createdAt,
          status: 'in_progress',
          output: [],
          model: this.requestedModel,
        },
      })
    }

    for (const entry of choices) {
      if (!isPlainObject(entry)) continue
      const choiceIndex = numberField(entry, 'index') ?? 0
      const delta = entry['delta']
      if (isPlainObject(delta)) this.acceptDelta(choiceIndex, delta, events)
      const finish = readString(entry, 'finish_reason')
      if (finish !== undefined && finish.length > 0) {
        if (this.finishReason === undefined) this.finishReason = finish
        this.finalizeChoice(choiceIndex, events)
      }
    }
    return { events }
  }

  /**
   * `[DONE]`: finalizes every open item (the silent-drop rule applies to
   * tools when no finish_reason was seen) and emits the terminal event -
   * suppressed entirely when no message and no function item was ever
   * added (S2d6 4.2 suppression; the handler then appends the CloseError
   * frame).
   */
  handleDone(): StepResult {
    this.doneSeen = true
    const events: EmittedEvent[] = []
    for (const choiceIndex of [...this.choices.keys()].sort((a, b) => a - b)) {
      this.finalizeChoice(choiceIndex, events)
    }
    if (!this.messageItemAdded && !this.functionItemAdded) return { events }
    this.emitTerminal(events)
    return { events }
  }

  /** Clean EOF without `[DONE]`: finalizes open items, emits NO terminal. */
  handleEofFinalize(): StepResult {
    const events: EmittedEvent[] = []
    for (const choiceIndex of [...this.choices.keys()].sort((a, b) => a - b)) {
      this.finalizeChoice(choiceIndex, events)
    }
    return { events }
  }

  // -------------------------------------------------------------------------

  private acceptDelta(choiceIndex: number, delta: Record<string, unknown>, events: EmittedEvent[]): void {
    const reasoning = delta['reasoning_content']
    const reasoningFallback = delta['reasoning']
    const reasoningText = typeof reasoning === 'string' ? reasoning : typeof reasoningFallback === 'string' ? reasoningFallback : undefined
    if (reasoningText !== undefined && reasoningText.length > 0) {
      const state = this.reasoningState(choiceIndex)
      if (state.justCreated) {
        this.emit(events, 'response.output_item.added', {
          type: 'response.output_item.added',
          sequence_number: 0,
          output_index: state.state.outputIndex,
          item: { id: state.state.itemId, type: 'reasoning', status: 'in_progress', summary: [] },
        })
        this.emit(events, 'response.reasoning_summary_part.added', {
          type: 'response.reasoning_summary_part.added',
          sequence_number: 0,
          item_id: state.state.itemId,
          output_index: state.state.outputIndex,
          summary_index: 0,
          part: { type: 'summary_text', text: '' },
        })
      }
      state.state.fullText += reasoningText
      this.emit(events, 'response.reasoning_summary_text.delta', {
        type: 'response.reasoning_summary_text.delta',
        sequence_number: 0,
        item_id: state.state.itemId,
        output_index: state.state.outputIndex,
        summary_index: 0,
        delta: reasoningText,
      })
    }

    const content = delta['content']
    if (typeof content === 'string' && content.length > 0) {
      this.closeReasoning(choiceIndex, events)
      const state = this.messageState(choiceIndex)
      if (state.justCreated) {
        this.messageItemAdded = true
        this.emit(events, 'response.output_item.added', {
          type: 'response.output_item.added',
          sequence_number: 0,
          output_index: state.state.outputIndex,
          item: {
            id: state.state.itemId,
            type: 'message',
            status: 'in_progress',
            content: [],
            role: 'assistant',
          },
        })
        this.emit(events, 'response.content_part.added', {
          type: 'response.content_part.added',
          sequence_number: 0,
          item_id: state.state.itemId,
          output_index: state.state.outputIndex,
          content_index: 0,
          part: { type: 'output_text', annotations: [], logprobs: [], text: '' },
        })
      }
      state.state.fullText += content
      this.emit(events, 'response.output_text.delta', {
        type: 'response.output_text.delta',
        sequence_number: 0,
        item_id: state.state.itemId,
        output_index: state.state.outputIndex,
        content_index: 0,
        delta: content,
        logprobs: [],
      })
    }

    const toolCalls = delta['tool_calls']
    if (Array.isArray(toolCalls)) {
      this.closeReasoning(choiceIndex, events)
      this.closeMessage(choiceIndex, events, 'completed')
      for (const entry of toolCalls) {
        if (!isPlainObject(entry)) continue
        this.acceptToolCallFragment(choiceIndex, entry, events)
      }
    }
  }

  private acceptToolCallFragment(choiceIndex: number, fragment: Record<string, unknown>, events: EmittedEvent[]): void {
    const choice = this.choiceState(choiceIndex)
    const toolIndex = numberField(fragment, 'index') ?? choice.tools.size
    let state = choice.tools.get(toolIndex)
    if (state === undefined) {
      state = {
        outputIndex: this.nextOutputIndex++,
        choiceIndex,
        toolIndex,
        callId: '',
        name: '',
        custom: false,
        arguments: '',
        added: false,
        open: true,
      }
      choice.tools.set(toolIndex, state)
    }
    const id = readString(fragment, 'id')
    if (id !== undefined && id.length > 0) state.callId = id
    const fn = fragment['function']
    if (isPlainObject(fn)) {
      const name = readString(fn, 'name')
      if (name !== undefined && name.length > 0) state.name = name
    }

    if (!state.added && state.callId.length > 0 && state.name.length > 0) {
      this.emitToolAdded(state, events)
    }

    const argumentsText = isPlainObject(fn) ? readString(fn, 'arguments') ?? '' : ''
    if (argumentsText.length > 0 && state.added && !state.custom) {
      this.emit(events, 'response.function_call_arguments.delta', {
        type: 'response.function_call_arguments.delta',
        sequence_number: 0,
        item_id: `fc_${state.callId}`,
        output_index: state.outputIndex,
        delta: argumentsText,
      })
    }
    state.arguments += argumentsText
  }

  private emitToolAdded(state: ToolState, events: EmittedEvent[]): void {
    const resolved = resolveCallName(state.name, this.declared)
    state.custom = resolved.custom
    state.added = true
    this.functionItemAdded = true
    if (state.callId.length === 0) {
      state.callId = `call_${this.responseId}_${state.choiceIndex}_${state.toolIndex}`
    }
    const item: WireObject = state.custom
      ? {
          id: `ctc_${state.callId}`,
          type: 'custom_tool_call',
          status: 'in_progress',
          input: '',
          call_id: state.callId,
          name: resolved.name,
        }
      : {
          id: `fc_${state.callId}`,
          type: 'function_call',
          status: 'in_progress',
          arguments: '',
          call_id: state.callId,
          name: resolved.name,
        }
    if (resolved.namespace !== undefined) item['namespace'] = resolved.namespace
    this.emit(events, 'response.output_item.added', {
      type: 'response.output_item.added',
      sequence_number: 0,
      output_index: state.outputIndex,
      item,
    })
  }

  private closeReasoning(choiceIndex: number, events: EmittedEvent[]): void {
    const choice = this.choices.get(choiceIndex)
    const state = choice?.reasoning
    if (choice === undefined || state === undefined || !state.open) return
    state.open = false
    this.emit(events, 'response.reasoning_summary_text.done', {
      type: 'response.reasoning_summary_text.done',
      sequence_number: 0,
      item_id: state.itemId,
      output_index: state.outputIndex,
      summary_index: 0,
      text: state.fullText,
    })
    this.emit(events, 'response.reasoning_summary_part.done', {
      type: 'response.reasoning_summary_part.done',
      sequence_number: 0,
      item_id: state.itemId,
      output_index: state.outputIndex,
      summary_index: 0,
      part: { type: 'summary_text', text: state.fullText },
    })
    this.emit(events, 'response.output_item.done', {
      type: 'response.output_item.done',
      item: {
        id: state.itemId,
        type: 'reasoning',
        encrypted_content: '',
        summary: [{ type: 'summary_text', text: state.fullText }],
      },
      output_index: state.outputIndex,
      sequence_number: 0,
    })
    this.completedItems.set(state.outputIndex, {
      id: state.itemId,
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: state.fullText }],
    })
  }

  private closeMessage(choiceIndex: number, events: EmittedEvent[], status: string): void {
    const choice = this.choices.get(choiceIndex)
    const state = choice?.message
    if (choice === undefined || state === undefined || !state.open) return
    state.open = false
    this.emitMessageDoneSet(state, status, events)
  }

  private emitMessageDoneSet(state: MessageState, status: string, events: EmittedEvent[]): void {
    this.emit(events, 'response.output_text.done', {
      type: 'response.output_text.done',
      sequence_number: 0,
      item_id: state.itemId,
      output_index: state.outputIndex,
      content_index: 0,
      text: state.fullText,
      logprobs: [],
    })
    this.emit(events, 'response.content_part.done', {
      type: 'response.content_part.done',
      sequence_number: 0,
      item_id: state.itemId,
      output_index: state.outputIndex,
      content_index: 0,
      part: { type: 'output_text', annotations: [], logprobs: [], text: state.fullText },
    })
    this.emit(events, 'response.output_item.done', {
      type: 'response.output_item.done',
      sequence_number: 0,
      output_index: state.outputIndex,
      item: {
        id: state.itemId,
        type: 'message',
        status,
        content: [{ type: 'output_text', annotations: [], logprobs: [], text: state.fullText }],
        role: 'assistant',
      },
    })
    this.completedItems.set(state.outputIndex, {
      id: state.itemId,
      type: 'message',
      status,
      content: [{ type: 'output_text', annotations: [], logprobs: [], text: state.fullText }],
      role: 'assistant',
    })
  }

  private finalizeChoice(choiceIndex: number, events: EmittedEvent[]): void {
    const status = this.isIncomplete() ? 'incomplete' : 'completed'
    const choice = this.choices.get(choiceIndex)
    if (choice === undefined) return
    this.closeReasoning(choiceIndex, events)
    this.closeMessage(choiceIndex, events, status)
    const finishSeen = this.finishReason !== undefined
    for (const toolIndex of [...choice.tools.keys()].sort((a, b) => a - b)) {
      const state = choice.tools.get(toolIndex)
      if (state === undefined || !state.open) continue
      if (!finishSeen && (state.arguments.length === 0 || !isValidJson(state.arguments))) {
        // Recorded finalize rule: an open tool call with empty or invalid
        // JSON arguments never synthesizes an item when no finish_reason
        // was seen.
        state.open = false
        continue
      }
      state.open = false
      if (!state.added) this.emitToolAdded(state, events)
      const resolved = resolveCallName(state.name, this.declared)
      if (state.custom) {
        this.emit(events, 'response.custom_tool_call_input.done', {
          type: 'response.custom_tool_call_input.done',
          sequence_number: 0,
          item_id: `ctc_${state.callId}`,
          output_index: state.outputIndex,
          input: customInputOf(state.arguments),
        })
        const item: WireObject = {
          id: `ctc_${state.callId}`,
          type: 'custom_tool_call',
          status,
          input: customInputOf(state.arguments),
          call_id: state.callId,
          name: resolved.name,
        }
        if (resolved.namespace !== undefined) item['namespace'] = resolved.namespace
        this.emit(events, 'response.output_item.done', {
          type: 'response.output_item.done',
          sequence_number: 0,
          output_index: state.outputIndex,
          item,
        })
        this.completedItems.set(state.outputIndex, item)
      } else {
        this.emit(events, 'response.function_call_arguments.done', {
          type: 'response.function_call_arguments.done',
          sequence_number: 0,
          item_id: `fc_${state.callId}`,
          output_index: state.outputIndex,
          arguments: state.arguments,
        })
        const item: WireObject = {
          id: `fc_${state.callId}`,
          type: 'function_call',
          status,
          arguments: state.arguments,
          call_id: state.callId,
          name: resolved.name,
        }
        if (resolved.namespace !== undefined) item['namespace'] = resolved.namespace
        this.emit(events, 'response.output_item.done', {
          type: 'response.output_item.done',
          sequence_number: 0,
          output_index: state.outputIndex,
          item,
        })
        this.completedItems.set(state.outputIndex, item)
      }
    }
  }

  private emitTerminal(events: EmittedEvent[]): void {
    const incomplete = this.isIncomplete()
    const response: WireObject = {
      id: this.responseId,
      object: 'response',
      created_at: this.createdAt,
      status: incomplete ? 'incomplete' : 'completed',
      background: false,
      error: null,
    }
    if (incomplete) {
      response['incomplete_details'] = {
        reason: this.finishReason === 'content_filter' ? 'content_filter' : 'max_output_tokens',
      }
    }
    for (const field of ECHO_FIELDS) {
      if (field === 'model') {
        response['model'] = this.requestedModel
        continue
      }
      const value = this.original?.[field]
      if (value === undefined) continue
      response[field] = sortKeysDeep(wireValueOf(value))
    }
    const output = [...this.completedItems.keys()].sort((a, b) => a - b).map((index) => this.completedItems.get(index))
    const items: WireObject[] = []
    for (const item of output) {
      if (item !== undefined) items.push(item)
    }
    if (items.length > 0) response['output'] = items
    if (this.usage !== undefined) response['usage'] = this.terminalUsage()
    this.emit(events, incomplete ? 'response.incomplete' : 'response.completed', {
      type: incomplete ? 'response.incomplete' : 'response.completed',
      sequence_number: 0,
      response,
    })
    this.terminalEmitted = true
  }

  /** Stream-path usage shape (S2d6 3.5): details inline, reasoning before total when > 0. */
  private terminalUsage(): WireObject {
    const usage = this.usage ?? { promptTokens: 0, cachedTokens: 0, completionTokens: 0, reasoningTokens: 0, totalTokens: 0 }
    const inputTokens = usage.promptTokens ?? 0
    const outputTokens = usage.completionTokens ?? 0
    const total = usage.totalTokens !== undefined && usage.totalTokens !== 0 ? usage.totalTokens : inputTokens + outputTokens
    const out: WireObject = {
      input_tokens: inputTokens,
      input_tokens_details: { cached_tokens: usage.cachedTokens ?? 0 },
      output_tokens: outputTokens,
    }
    if (usage.reasoningTokens !== undefined && usage.reasoningTokens > 0) {
      out['output_tokens_details'] = { reasoning_tokens: usage.reasoningTokens }
    }
    out['total_tokens'] = total
    return out
  }

  private captureUsage(usage: Record<string, unknown>): void {
    const details = isPlainObject(usage['prompt_tokens_details']) ? usage['prompt_tokens_details'] : undefined
    const outDetails = isPlainObject(usage['output_tokens_details']) ? usage['output_tokens_details'] : undefined
    const completionDetails = isPlainObject(usage['completion_tokens_details']) ? usage['completion_tokens_details'] : undefined
    this.usage = {
      promptTokens: numberField(usage, 'prompt_tokens'),
      cachedTokens: details !== undefined ? numberField(details, 'cached_tokens') : undefined,
      completionTokens: numberField(usage, 'completion_tokens') ?? numberField(usage, 'output_tokens'),
      reasoningTokens:
        (outDetails !== undefined ? numberField(outDetails, 'reasoning_tokens') : undefined) ??
        (completionDetails !== undefined ? numberField(completionDetails, 'reasoning_tokens') : undefined),
      totalTokens: numberField(usage, 'total_tokens'),
    }
  }

  private isIncomplete(): boolean {
    return this.finishReason === 'length' || this.finishReason === 'max_tokens' || this.finishReason === 'content_filter'
  }

  private choiceState(choiceIndex: number): {
    reasoning: ReasoningState | undefined
    message: MessageState | undefined
    tools: Map<number, ToolState>
  } {
    let choice = this.choices.get(choiceIndex)
    if (choice === undefined) {
      choice = { reasoning: undefined, message: undefined, tools: new Map<number, ToolState>() }
      this.choices.set(choiceIndex, choice)
    }
    return choice
  }

  private reasoningState(choiceIndex: number): { readonly state: ReasoningState; readonly justCreated: boolean } {
    const choice = this.choiceState(choiceIndex)
    if (choice.reasoning === undefined) {
      choice.reasoning = {
        outputIndex: this.nextOutputIndex++,
        itemId: `rs_${this.responseId}_${choiceIndex}`,
        open: true,
        fullText: '',
      }
      return { state: choice.reasoning, justCreated: true }
    }
    return { state: choice.reasoning, justCreated: false }
  }

  private messageState(choiceIndex: number): { readonly state: MessageState; readonly justCreated: boolean } {
    const choice = this.choiceState(choiceIndex)
    if (choice.message === undefined) {
      choice.message = {
        outputIndex: this.nextOutputIndex++,
        itemId: `msg_${this.responseId}_${choiceIndex}`,
        open: true,
        fullText: '',
      }
      return { state: choice.message, justCreated: true }
    }
    return { state: choice.message, justCreated: false }
  }

  /** Serializes one event, assigns its sequence number and runs the per-chunk ensure post-step. */
  private emit(events: EmittedEvent[], event: string, payload: WireObject): void {
    this.seq += 1
    payload['sequence_number'] = this.seq
    const data = ensureResponsesUsageDetails(serializeOrdered(payload))
    events.push({ event, data })
    this.lastEventName = event
  }
}

function numberField(value: Record<string, unknown>, key: string): number | undefined {
  const raw = value[key]
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined
}

// ---------------------------------------------------------------------------
// Upstream stream-error classification (S2d6 5.2)
// ---------------------------------------------------------------------------

/**
 * Classifies one upstream frame as a stream error: `event:` names of the
 * error family, payloads carrying `error`/`response.error` objects, or
 * top-level `code`+`message` pairs. Returns undefined for normal chunks.
 */
export function classifyStreamError(frame: SseFrame): StreamFailure | undefined {
  const eventName = frame.event
  if (eventName === 'error' || eventName === 'response.error' || eventName === 'response.failed') {
    return upstreamFailureOf(frame.data)
  }
  const parsed = tryParseJson(frame.data)
  if (!isPlainObject(parsed)) return undefined
  const errorObject = errorObjectOf(parsed)
  if (errorObject !== undefined) return upstreamStreamFailure(errorObject)
  if (parsed['code'] !== undefined && parsed['message'] !== undefined && !Array.isArray(parsed['choices'])) {
    return upstreamStreamFailure({ code: parsed['code'], message: parsed['message'] })
  }
  return undefined
}

function errorObjectOf(parsed: Record<string, unknown>): unknown | undefined {
  const direct = parsed['error']
  if (isPlainObject(direct)) return direct
  const response = parsed['response']
  if (isPlainObject(response)) {
    const nested = response['error']
    if (isPlainObject(nested)) return nested
  }
  return undefined
}

function upstreamFailureOf(data: string): StreamFailure {
  const parsed = tryParseJson(data)
  if (isPlainObject(parsed)) {
    const errorObject = errorObjectOf(parsed)
    if (errorObject !== undefined) return upstreamStreamFailure(errorObject)
    return upstreamStreamFailure(parsed)
  }
  const trimmed = data.trim()
  return statusStreamFailure(trimmed.length > 0 ? trimmed : UNEXPECTED_EOF_MESSAGE, 502)
}

// ---------------------------------------------------------------------------
// Pipeline (upstream frames -> downstream stream units)
// ---------------------------------------------------------------------------

/** Failure that crossed the wire before any translated frame existed. */
export class PreCommitStreamError extends Error {
  readonly failure: StreamFailure

  constructor(failure: StreamFailure) {
    super('upstream stream failed before the first translated frame')
    this.failure = failure
  }
}

export interface StreamPipelineOptions {
  readonly ctx: ChatToResponsesStreamContext
  /** Terminal failure event: `error` for normal clients, `response.failed` for Codex clients. */
  readonly failureEvent: 'error' | 'response.failed'
}

/**
 * Translates the upstream byte/text source into downstream stream units.
 * Commit rule: the caller may write SSE headers once the first unit is
 * held. Pre-commit failures throw (the facade renders a plain HTTP
 * error); post-commit failures append ONE terminal error frame and end
 * the stream. A clean close after a terminal event yields the trailing
 * `\n` end marker; a clean close without `[DONE]` finalizes open items
 * and appends the recorded `upstream stream closed before [DONE]` frame;
 * a `[DONE]` that produced no terminal event ends through the CloseError
 * frame.
 */
export async function* translateChatSseToResponsesFrames(
  source: AsyncIterable<string | Uint8Array>,
  options: StreamPipelineOptions,
): AsyncIterable<ResponsesStreamFrame> {
  const translator = new ChatToResponsesStreamTranslator(options.ctx)
  let committed = false
  try {
    for await (const frame of decodeSseFrames(source)) {
      if (translator.isTerminalEmitted) continue
      if (frame.data === DONE_MARKER) {
        for (const event of translator.handleDone().events) {
          committed = true
          yield { kind: 'event', event: event.event, data: event.data }
        }
        continue
      }
      const failure = classifyStreamError(frame)
      if (failure !== undefined) {
        if (!committed) throw new PreCommitStreamError(failure)
        yield {
          kind: 'error-frame',
          text: formatTerminalErrorFrame(options.failureEvent, failure, translator.frameCount),
        }
        return
      }
      for (const event of translator.acceptDataLine(frame.data).events) {
        committed = true
        yield { kind: 'event', event: event.event, data: event.data }
      }
    }
  } catch (error) {
    if (error instanceof PreCommitStreamError) throw error
    if (!committed) throw error
    yield {
      kind: 'error-frame',
      text: formatTerminalErrorFrame(
        options.failureEvent,
        statusStreamFailure(UNEXPECTED_EOF_MESSAGE, 500),
        translator.frameCount,
      ),
    }
    return
  }
  if (!committed) return
  if (translator.isTerminalEmitted) {
    yield { kind: 'end' }
    return
  }
  if (translator.doneSeen) {
    const lastEvent = translator.lastEventName ?? ''
    yield {
      kind: 'error-frame',
      text: formatTerminalErrorFrame(
        options.failureEvent,
        statusStreamFailure(closeErrorText(lastEvent), 502),
        translator.frameCount,
      ),
    }
    return
  }
  for (const event of translator.handleEofFinalize().events) {
    yield { kind: 'event', event: event.event, data: event.data }
  }
  yield {
    kind: 'error-frame',
    text: formatTerminalErrorFrame(
      options.failureEvent,
      statusStreamFailure(CLOSED_BEFORE_DONE_MESSAGE, 502),
      translator.frameCount,
    ),
  }
}

/** Result of the stream bootstrap (commit rule, S2d6 4.1). */
export type ResponsesStreamBootstrap =
  | {
      readonly kind: 'live'
      /** First downstream unit; SSE headers commit once it is held. */
      readonly firstFrame: ResponsesStreamFrame
      /** Remaining units of the same stream (terminal frames included). */
      readonly rest: AsyncIterable<ResponsesStreamFrame>
    }
  | {
      /**
       * The upstream (HTTP 200) closed before any translated frame - the
       * `[DONE]`-only stream: no SSE header may be committed; the facade
       * renders the pre-commit 500 `empty_stream` envelope (S2d6 5.3).
       */
      readonly kind: 'empty-stream'
    }

/** Pulls the stream until the first translated unit; empty streams gate pre-commit. */
export async function bootstrapResponsesStream(
  source: AsyncIterable<string | Uint8Array>,
  options: StreamPipelineOptions,
): Promise<ResponsesStreamBootstrap> {
  const stream = translateChatSseToResponsesFrames(source, options)[Symbol.asyncIterator]()
  const first = await stream.next()
  if (first.done === true) return { kind: 'empty-stream' }
  return {
    kind: 'live',
    firstFrame: first.value,
    rest: { [Symbol.asyncIterator]: () => stream },
  }
}
