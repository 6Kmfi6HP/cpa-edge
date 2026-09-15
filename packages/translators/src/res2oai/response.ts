/**
 * Response translation: chat completions body -> Responses body,
 * non-stream (S2d6 section 3.3).
 *
 * The output is built from a fixed template (`id`, `object`, `created_at`,
 * `status`, `background`, `error`, `incomplete_details`) and every echoed
 * field appends after it. The echo source is the TRANSLATED chat request -
 * not the original Responses request - so `model` carries the resolved
 * upstream name and `tools`/`tool_choice` echo the chat shapes (asymmetric
 * with the stream terminal event, which echoes the original request).
 *
 * The usage block is built in translator order and then post-processed by
 * {@link ensureResponsesUsageDetails}, which appends the two missing
 * detail objects AFTER `total_tokens` (output_tokens_details first) -
 * the recorded sjson append artifact.
 */
import { isPlainObject, readObject, readString, scanObjectMembers, serializeOrdered, sortKeysDeep, tryParseJson } from './json'
import type { WireObject } from './json'
import { appendObjectMember } from './json'
import { resolveCallName } from './tools'
import type { ChatToResponsesContext, DeclaredTool } from './types'

/** Marker of compaction payloads (exempt from usage-detail ensuring). */
export const COMPACTION_OBJECT = 'response.compaction'

/**
 * Translates a chat completions upstream body into the Responses wire
 * body. Upstream text that is not valid JSON reads as an empty document
 * (the reference parses best-effort), yielding a synthesized id and no
 * output items.
 */
export function translateChatToResponses(upstreamBody: string, ctx: ChatToResponsesContext): string {
  const parsed = tryParseJson(upstreamBody)
  const record = isPlainObject(parsed) ? parsed : {}

  const upstreamId = readString(record, 'id') ?? ''
  const responseId = upstreamId.length > 0 ? upstreamId : `resp_${ctx.now().toString(16)}_0`
  const createdRaw = readNumber(record, 'created')
  const createdAt = createdRaw !== undefined && createdRaw !== 0 ? createdRaw : Math.floor(ctx.now() / 1000)

  const choices = Array.isArray(record['choices']) ? (record['choices'] as readonly unknown[]) : []
  const firstChoice = isPlainObject(choices[0]) ? (choices[0] as Record<string, unknown>) : undefined
  const finishReason = firstChoice !== undefined ? readString(firstChoice, 'finish_reason') : undefined
  const incomplete = finishReason === 'length' || finishReason === 'max_tokens' || finishReason === 'content_filter'

  const out: WireObject = {
    id: responseId,
    object: 'response',
    created_at: createdAt,
    status: incomplete ? 'incomplete' : 'completed',
    background: false,
    error: null,
    incomplete_details: incomplete
      ? { reason: finishReason === 'content_filter' ? 'content_filter' : 'max_output_tokens' }
      : null,
  }
  if (ctx.maxTokens !== undefined) out['max_output_tokens'] = ctx.maxTokens
  out['model'] = ctx.resolvedModel
  if (ctx.toolChoice !== undefined) out['tool_choice'] = sortKeysDeep(ctx.toolChoice)
  if (ctx.chatTools.length > 0) out['tools'] = sortKeysDeep([...ctx.chatTools]) as WireObject[]

  const output = buildOutputItems(responseId, choices, incomplete, ctx.tools)
  if (output.length > 0) out['output'] = output

  const usage = buildUsage(record)
  if (usage !== undefined) out['usage'] = usage

  return ensureResponsesUsageDetails(serializeOrdered(out))
}

// ---------------------------------------------------------------------------
// Output items
// ---------------------------------------------------------------------------

function buildOutputItems(
  responseId: string,
  choices: readonly unknown[],
  incomplete: boolean,
  declared: readonly DeclaredTool[],
): WireObject[] {
  const items: WireObject[] = []
  const itemStatus = incomplete ? 'incomplete' : 'completed'

  const first = choices[0]
  if (isPlainObject(first)) {
    const message = readObject(first, 'message')
    const reasoning = message !== undefined ? reasoningText(message) : undefined
    if (reasoning !== undefined && reasoning.length > 0) {
      items.push({
        id: `rs_${responseId.startsWith('resp_') ? responseId.slice('resp_'.length) : responseId}`,
        type: 'reasoning',
        encrypted_content: '',
        summary: [{ type: 'summary_text', text: reasoning }],
      })
    }
  }

  for (let choiceIndex = 0; choiceIndex < choices.length; choiceIndex++) {
    const choice = choices[choiceIndex]
    if (!isPlainObject(choice)) continue
    const message = readObject(choice, 'message')
    if (message === undefined) continue
    const content = message['content']
    if (typeof content === 'string') {
      if (content.length > 0) {
        items.push(messageItem(responseId, choiceIndex, itemStatus, content))
      }
    } else if (content !== undefined && content !== null) {
      items.push(messageItem(responseId, choiceIndex, itemStatus, JSON.stringify(content)))
    }
    const toolCalls = message['tool_calls']
    if (!Array.isArray(toolCalls)) continue
    for (let callIndex = 0; callIndex < toolCalls.length; callIndex++) {
      const call = toolCalls[callIndex]
      if (!isPlainObject(call)) continue
      const callId = readString(call, 'id') ?? `call_${responseId}_${choiceIndex}_${callIndex}`
      const argumentsText = toolCallArguments(call)
      const resolved = resolveCallName(toolCallName(call), declared)
      if (resolved.custom) {
        items.push({
          id: `ctc_${callId}`,
          type: 'custom_tool_call',
          status: itemStatus,
          input: customInputOf(argumentsText),
          call_id: callId,
          name: resolved.name,
        })
      } else {
        const item: WireObject = {
          id: `fc_${callId}`,
          type: 'function_call',
          status: itemStatus,
          arguments: argumentsText,
          call_id: callId,
          name: resolved.name,
        }
        if (resolved.namespace !== undefined) item['namespace'] = resolved.namespace
        items.push(item)
      }
    }
  }
  return items
}

function messageItem(responseId: string, choiceIndex: number, status: string, text: string): WireObject {
  return {
    id: `msg_${responseId}_${choiceIndex}`,
    type: 'message',
    status,
    content: [{ type: 'output_text', annotations: [], logprobs: [], text }],
    role: 'assistant',
  }
}

/** `reasoning_content` with the recorded `reasoning` fallback. */
function reasoningText(message: Record<string, unknown>): string | undefined {
  const direct = readString(message, 'reasoning_content')
  if (direct !== undefined) return direct
  const fallback = message['reasoning']
  return typeof fallback === 'string' ? fallback : undefined
}

function toolCallName(call: Record<string, unknown>): string {
  const embedded = readObject(call, 'function')
  return (embedded !== undefined ? readString(embedded, 'name') : undefined) ?? ''
}

function toolCallArguments(call: Record<string, unknown>): string {
  const embedded = readObject(call, 'function')
  return (embedded !== undefined ? readString(embedded, 'arguments') : undefined) ?? ''
}

/** Custom tool input: the `input` member of parsed arguments, else the raw arguments. */
export function customInputOf(argumentsText: string): string {
  const parsed = tryParseJson(argumentsText)
  if (isPlainObject(parsed) && typeof parsed['input'] === 'string') return parsed['input'] as string
  return argumentsText
}

// ---------------------------------------------------------------------------
// Usage (translator order; details appended by the ensure post-step)
// ---------------------------------------------------------------------------

/**
 * Translates the upstream usage object in translator order: `input_tokens`,
 * `input_tokens_details.cached_tokens` (when the upstream has it),
 * `output_tokens`, `output_tokens_details.reasoning_tokens` (when the
 * upstream has it), `total_tokens`. A usage object with NONE of the three
 * base fields is copied verbatim instead.
 */
function buildUsage(record: Record<string, unknown>): WireObject | undefined {
  const usage = readObject(record, 'usage')
  if (usage === undefined) return undefined
  const prompt = readNumber(usage, 'prompt_tokens')
  const completion = readNumber(usage, 'completion_tokens') ?? readNumber(usage, 'output_tokens')
  const total = readNumber(usage, 'total_tokens')
  if (prompt === undefined && completion === undefined && total === undefined) {
    return usage
  }
  const out: WireObject = {}
  if (prompt !== undefined) out['input_tokens'] = prompt
  const cached = readNumber(readObject(usage, 'prompt_tokens_details'), 'cached_tokens')
  if (cached !== undefined) out['input_tokens_details'] = { cached_tokens: cached }
  if (completion !== undefined) out['output_tokens'] = completion
  const reasoning = reasoningTokensOf(usage)
  if (reasoning !== undefined) out['output_tokens_details'] = { reasoning_tokens: reasoning }
  if (total !== undefined) out['total_tokens'] = total
  return out
}

function reasoningTokensOf(usage: Record<string, unknown>): number | undefined {
  const direct = readNumber(readObject(usage, 'output_tokens_details'), 'reasoning_tokens')
  if (direct !== undefined) return direct
  return readNumber(readObject(usage, 'completion_tokens_details'), 'reasoning_tokens')
}

// ---------------------------------------------------------------------------
// EnsureResponsesUsageDetails (executor post-step, S2d6 2.4 / 3.3 / 3.5)
// ---------------------------------------------------------------------------

/**
 * Appends `usage.output_tokens_details.reasoning_tokens: 0` and then
 * `usage.input_tokens_details.cached_tokens: 0` (in that order) whenever a
 * usage object exists - top-level or under `response` - and lacks them.
 * Compaction payloads (`"object":"response.compaction"`) are exempt. All
 * other bytes of the body survive untouched.
 */
export function ensureResponsesUsageDetails(body: string): string {
  const parsed = tryParseJson(body)
  if (!isPlainObject(parsed)) return body
  if (readString(parsed, 'object') === COMPACTION_OBJECT) return body

  const members = scanObjectMembers(body)
  if (members === undefined) return body
  const topUsage = members.find((member) => member.name === 'usage')
  if (topUsage !== undefined) {
    return ensureInSpan(body, topUsage.valueStart, topUsage.valueEnd)
  }
  const responseMember = members.find((member) => member.name === 'response')
  if (responseMember === undefined) return body
  const responseText = body.slice(responseMember.valueStart, responseMember.valueEnd)
  const responseMembers = scanObjectMembers(responseText)
  if (responseMembers === undefined) return body
  const nestedUsage = responseMembers.find((member) => member.name === 'usage')
  if (nestedUsage === undefined) return body
  const base = responseMember.valueStart + nestedUsage.valueStart
  const end = responseMember.valueStart + nestedUsage.valueEnd
  return ensureInSpan(body, base, end)
}

/** Ensures the two detail members inside the usage object spanning [start, end). */
function ensureInSpan(body: string, start: number, end: number): string {
  const usageText = body.slice(start, end)
  const usage = tryParseJson(usageText)
  if (!isPlainObject(usage)) return body
  let updated = usageText
  updated = ensureDetail(updated, 'output_tokens_details', 'reasoning_tokens')
  updated = ensureDetail(updated, 'input_tokens_details', 'cached_tokens')
  if (updated === usageText) return body
  return body.slice(0, start) + updated + body.slice(end)
}

/**
 * Ensures `detailKey.innerKey` exists inside a usage object: a missing
 * detail object appends at the end of the usage object; a present object
 * without the inner key gains it inside.
 */
function ensureDetail(usageText: string, detailKey: string, innerKey: string): string {
  const usage = tryParseJson(usageText)
  if (!isPlainObject(usage)) return usageText
  const detail = usage[detailKey]
  if (detail === undefined) {
    return appendObjectMember(usageText, `"${detailKey}":{"${innerKey}":0}`)
  }
  if (!isPlainObject(detail)) return usageText
  if (detail[innerKey] !== undefined) return usageText
  const members = scanObjectMembers(usageText)
  if (members === undefined) return usageText
  const member = members.find((entry) => entry.name === detailKey)
  if (member === undefined) return usageText
  const detailText = usageText.slice(member.valueStart, member.valueEnd)
  const updatedDetail = appendObjectMember(detailText, `"${innerKey}":0`)
  return usageText.slice(0, member.valueStart) + updatedDetail + usageText.slice(member.valueEnd)
}

function readNumber(value: unknown, key: string): number | undefined {
  if (!isPlainObject(value)) return undefined
  const raw = value[key]
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined
}
