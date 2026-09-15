/**
 * Response translation: Gemini generateContent -> OpenAI Chat Completions
 * (non-stream; spec 3.3).
 *
 * Recorded pins encoded here: the envelope template and its key order
 * (`id, object, created, model, choices, usage`), per-choice order
 * (`index, message, finish_reason, native_finish_reason`), the message
 * key order (`role, content, reasoning_content, tool_calls` with `images`
 * only when inlineData parts exist), tool_calls WITHOUT an `index` field
 * and with raw upstream argument bytes, the `model` echo of
 * `modelVersion` (literal `"model"` default; force-mapping rewrites it),
 * the usage formulas and detail members, and the finish_reason override
 * to `tool_calls` (non-stream ALSO overrides `native_finish_reason`,
 * fixture C04 - the stream direction keeps the upstream reason, C12).
 */
import { isPlainObject, rawValueAt, readArray, readNumber, readObject, readString, serializeOrdered } from './json'
import type { WireObject, WireValue } from './json'
import type { GeminiToChatContext } from './types'

/** Extracted usage counts of one usageMetadata object. */
export interface GeminiUsage {
  readonly prompt: number
  readonly candidates: number
  readonly thoughts: number
  readonly cached: number
  /** Upstream `totalTokenCount` (mirrors the counter sum on every golden). */
  readonly total: number
}

function countOf(record: Record<string, unknown>, key: string): number {
  const raw = record[key]
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0
}

const EMPTY_USAGE: GeminiUsage = Object.freeze({ prompt: 0, candidates: 0, thoughts: 0, cached: 0, total: 0 })

/** Reads a usageMetadata object into its counts. */
export function readGeminiUsage(usageMetadata: Record<string, unknown> | undefined): GeminiUsage {
  if (usageMetadata === undefined) return EMPTY_USAGE
  return {
    prompt: countOf(usageMetadata, 'promptTokenCount'),
    candidates: countOf(usageMetadata, 'candidatesTokenCount'),
    thoughts: countOf(usageMetadata, 'thoughtsTokenCount'),
    cached: countOf(usageMetadata, 'cachedContentTokenCount'),
    total: countOf(usageMetadata, 'totalTokenCount'),
  }
}

/**
 * Usage object in the recorded key order: completion_tokens (candidates +
 * thoughts), total_tokens (upstream totalTokenCount), prompt_tokens, and
 * the detail members only when their counts are positive.
 */
export function chatUsageObject(usage: GeminiUsage): WireObject {
  const out: WireObject = {
    completion_tokens: usage.candidates + usage.thoughts,
    total_tokens: usage.total,
    prompt_tokens: usage.prompt,
  }
  if (usage.thoughts > 0) {
    out['completion_tokens_details'] = { reasoning_tokens: usage.thoughts }
  }
  if (usage.cached > 0) {
    out['prompt_tokens_details'] = { cached_tokens: usage.cached }
  }
  return out
}

/** Unix seconds of an RFC3339(nano) createTime; 0 when absent/unparsable. */
export function createdSeconds(createTime: string | undefined): number {
  if (createTime === undefined || createTime.length === 0) return 0
  const parsed = Date.parse(createTime)
  return Number.isNaN(parsed) ? 0 : Math.floor(parsed / 1000)
}

/** Generated tool-call id: `<name>-<unix-nano>-<counter>` (spec 3.3). */
export function toolCallId(name: string, nowMs: number, seq: number): string {
  return `${name}-${nowMs}000000-${seq}`
}

/** The text of one part, honoring the transcribe-model fallback. */
function partText(part: Record<string, unknown>): string | undefined {
  const text = readString(part, 'text')
  if (text !== undefined) return text
  const transcription = readObject(part, 'audioTranscription')
  return transcription !== undefined ? readString(transcription, 'text') : undefined
}

/** A functionCall record read from a part (a name makes it a call). */
function callOf(part: Record<string, unknown>): Record<string, unknown> | undefined {
  const call = readObject(part, 'functionCall')
  return call !== undefined && readString(call, 'name') !== undefined ? call : undefined
}

/** Raw upstream bytes of a functionCall's `args` value; `{}` default. */
export function rawArgumentsAt(upstreamBody: string, partPath: readonly string[]): string {
  return rawValueAt(upstreamBody, [...partPath, 'functionCall', 'args']) ?? '{}'
}

/**
 * Maps one Gemini generateContent body to the chat.completion body text.
 * A body without a parseable JSON document still renders the envelope
 * with empty choices (no candidates -> `choices: []`, usage when the
 * body carries it).
 */
export function translateGeminiResponseToChatCompletion(
  upstreamBody: string,
  ctx: GeminiToChatContext,
): string {
  let parsed: Record<string, unknown> = {}
  try {
    const value: unknown = JSON.parse(upstreamBody)
    if (isPlainObject(value)) parsed = value
  } catch {
    parsed = {}
  }

  const responseId = readString(parsed, 'responseId') ?? ''
  const modelVersion = readString(parsed, 'modelVersion') ?? 'model'
  const model = ctx.forceMappingModel ?? modelVersion
  const usageMeta = readObject(parsed, 'usageMetadata')

  const choices: WireObject[] = []
  const candidates = readArray(parsed, 'candidates') ?? []
  for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
    const candidate = candidates[candidateIndex]
    if (!isPlainObject(candidate)) continue
    const content = readObject(candidate, 'content')
    const parts = content !== undefined ? (readArray(content, 'parts') ?? []) : []
    const finishReason = readString(candidate, 'finishReason')

    let textBuffer = ''
    let thoughtBuffer = ''
    let sawCall = false
    const toolCalls: WireObject[] = []
    const images: WireObject[] = []
    for (let partIndex = 0; partIndex < parts.length; partIndex++) {
      const part = parts[partIndex]
      if (!isPlainObject(part)) continue
      const path = ['candidates', String(candidateIndex), 'content', 'parts', String(partIndex)]
      const call = callOf(part)
      if (call !== undefined) {
        sawCall = true
        const name = readString(call, 'name') ?? ''
        toolCalls.push({
          id: toolCallId(name, ctx.nowMs(), ctx.nextToolCallSeq()),
          type: 'function',
          function: { name, arguments: rawArgumentsAt(upstreamBody, path) },
        })
        continue
      }
      const inline = readObject(part, 'inlineData')
      if (inline !== undefined) {
        const data = readString(inline, 'data')
        if (data !== undefined) {
          const mime = readString(inline, 'mime_type') ?? readString(inline, 'mimeType') ?? ''
          images.push({
            index: images.length,
            type: 'image_url',
            image_url: { url: `data:${mime.length > 0 ? mime : 'image/png'};base64,${data}` },
          })
        }
        continue
      }
      const text = partText(part)
      if (text === undefined) continue
      if (part['thought'] === true) thoughtBuffer += text
      else textBuffer += text
    }

    const message: WireObject = {
      role: 'assistant',
      content: textBuffer.length > 0 ? textBuffer : null,
      reasoning_content: thoughtBuffer.length > 0 ? thoughtBuffer : null,
      tool_calls: toolCalls.length > 0 ? toolCalls : null,
    }
    if (images.length > 0) message['images'] = images

    // Non-stream override: a functionCall flips BOTH finish fields to
    // `tool_calls` (fixture C04); otherwise the lowered upstream reason.
    const lowered = finishReason !== undefined ? finishReason.toLowerCase() : undefined
    const finish = sawCall ? 'tool_calls' : lowered
    const index = readNumber(candidate, 'index')
    choices.push({
      index: index !== undefined ? index : 0,
      message,
      finish_reason: finish ?? null,
      native_finish_reason: finish ?? null,
    })
  }

  const envelope: WireObject = {
    id: responseId,
    object: 'chat.completion',
    created: createdSeconds(readString(parsed, 'createTime')),
    model,
    choices,
  }
  if (usageMeta !== undefined) {
    envelope['usage'] = chatUsageObject(readGeminiUsage(usageMeta)) as WireValue
  }
  return serializeOrdered(envelope)
}
