/**
 * Response translation: OpenAI chat completion -> Gemini
 * generateContent envelope (S2d2 section 3.2, non-stream).
 *
 * Choices overlay into a single candidate: parts merge in choice order
 * (reasoning texts first, then the message content, then one functionCall
 * part per tool call), `index` reflects the LAST choice and the finish
 * reason follows the recorded map. The envelope key order is
 * candidates, model, usageMetadata; the model is the upstream response's
 * own unless the model entry forces mapping back to the client alias.
 */
import { parseStrictJson, readArray, readObject, readString, serializeOrdered, sortKeysDeep } from './json'
import type { OpenAIToGeminiContext, WireObject, WireValue } from './types'

/** OpenAI `finish_reason` -> Gemini `finishReason` (recorded table). */
export function mapFinishReason(finishReason: string): string {
  switch (finishReason) {
    case 'stop':
      return 'STOP'
    case 'length':
      return 'MAX_TOKENS'
    case 'tool_calls':
      return 'STOP'
    case 'content_filter':
      return 'SAFETY'
    default:
      return 'STOP'
  }
}

/**
 * Extracts the thought texts of a `reasoning_content` value: a plain
 * string, an array of strings or objects with a `text` field, or an object
 * with a `text` field. Objects without a text field produce nothing.
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

/**
 * Parses a tool-call `arguments` string into a raw object with
 * alphabetically sorted keys (Go map-marshal shape); `{}` when empty or
 * invalid.
 */
export function parseToolArguments(argumentsText: string | undefined): WireObject {
  if (argumentsText === undefined || argumentsText.length === 0) return {}
  try {
    const parsed: unknown = JSON.parse(argumentsText)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    return sortKeysDeep(parsed as WireValue) as WireObject
  } catch {
    return {}
  }
}

/** One `{"functionCall":{...}}` part for an assistant tool call. */
export function functionCallPart(call: Record<string, unknown>): WireObject {
  const fn = readObject(call, 'function')
  const name = fn !== undefined ? readString(fn, 'name') ?? '' : ''
  const argumentsText = fn !== undefined ? readString(fn, 'arguments') : undefined
  const functionCall: WireObject = { name, args: parseToolArguments(argumentsText) }
  const id = readString(call, 'id')
  if (id !== undefined && id.length > 0) functionCall['id'] = id
  return { functionCall }
}

/** `usage` -> `usageMetadata`, inner keys in the recorded order. */
export function usageMetadata(usage: unknown): WireObject | undefined {
  if (typeof usage !== 'object' || usage === null || Array.isArray(usage)) return undefined
  const record = usage as Record<string, unknown>
  const prompt = readNumber(record, 'prompt_tokens') ?? readNumber(record, 'input_tokens')
  const completion = readNumber(record, 'completion_tokens') ?? readNumber(record, 'output_tokens')
  const total =
    readNumber(record, 'total_tokens') ??
    (prompt !== undefined || completion !== undefined ? (prompt ?? 0) + (completion ?? 0) : undefined)
  const thoughts = reasoningTokens(record)
  const cached = cachedTokens(record)

  const out: WireObject = {}
  if (prompt !== undefined) out['promptTokenCount'] = prompt
  if (completion !== undefined) out['candidatesTokenCount'] = completion
  if (total !== undefined) out['totalTokenCount'] = total
  if (thoughts !== undefined && thoughts > 0) out['thoughtsTokenCount'] = thoughts
  if (cached !== undefined && cached > 0) out['cachedContentTokenCount'] = cached
  return Object.keys(out).length > 0 ? out : undefined
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const raw = record[key]
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined
}

function reasoningTokens(usage: Record<string, unknown>): number | undefined {
  const completion = readObject(usage, 'completion_tokens_details')
  if (completion !== undefined) {
    const value = readNumber(completion, 'reasoning_tokens')
    if (value !== undefined) return value
  }
  const output = readObject(usage, 'output_tokens_details')
  if (output !== undefined) return readNumber(output, 'reasoning_tokens')
  return undefined
}

function cachedTokens(usage: Record<string, unknown>): number | undefined {
  const prompt = readObject(usage, 'prompt_tokens_details')
  if (prompt !== undefined) {
    const value = readNumber(prompt, 'cached_tokens')
    if (value !== undefined) return value
  }
  const input = readObject(usage, 'input_tokens_details')
  if (input !== undefined) return readNumber(input, 'cached_tokens')
  return undefined
}

/**
 * Translates one upstream chat-completion body into the Gemini
 * non-stream envelope. Throws `CpaError('invalid-input', ...)` when the
 * upstream body is not strict JSON (the caller renders the failure).
 */
export function translateOpenAIResponseToGeminiNonStream(
  upstreamBody: string,
  ctx: OpenAIToGeminiContext,
): string {
  const parsed = parseStrictJson(upstreamBody)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return serializeOrdered(nonceEnvelope(ctx))
  }
  const response = parsed as Record<string, unknown>

  const parts: WireObject[] = []
  let index = 0
  let finishReason: string | undefined

  for (const choice of readArray(response, 'choices') ?? []) {
    if (typeof choice !== 'object' || choice === null || Array.isArray(choice)) continue
    const record = choice as Record<string, unknown>
    const choiceIndex = record['index']
    if (typeof choiceIndex === 'number' && Number.isFinite(choiceIndex)) index = choiceIndex
    const rawFinish = readString(record, 'finish_reason')
    if (rawFinish !== undefined && rawFinish.length > 0) finishReason = mapFinishReason(rawFinish)

    const message = readObject(record, 'message')
    if (message === undefined) continue
    for (const text of extractReasoningTexts(message['reasoning_content'])) {
      parts.push({ thought: true, text })
    }
    const content = readString(message, 'content')
    if (content !== undefined && content.length > 0) parts.push({ text: content })
    for (const call of readArray(message, 'tool_calls') ?? []) {
      if (typeof call !== 'object' || call === null || Array.isArray(call)) continue
      const callRecord = call as Record<string, unknown>
      const type = callRecord['type']
      if (typeof type === 'string' && type !== 'function') continue
      parts.push(functionCallPart(callRecord))
    }
  }

  const candidate: WireObject = { content: { parts, role: 'model' }, index }
  if (finishReason !== undefined) candidate['finishReason'] = finishReason

  const envelope: WireObject = {
    candidates: [candidate],
    model: ctx.forceMappingModel ?? readString(response, 'model') ?? '',
  }
  const usage = usageMetadata(response['usage'])
  if (usage !== undefined) envelope['usageMetadata'] = usage
  return serializeOrdered(envelope)
}

function nonceEnvelope(ctx: OpenAIToGeminiContext): WireObject {
  return {
    candidates: [{ content: { parts: [], role: 'model' }, index: 0 }],
    model: ctx.forceMappingModel ?? ctx.streamModel,
  }
}
