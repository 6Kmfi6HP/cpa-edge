/**
 * Stream pipeline: upstream Gemini SSE -> downstream chat.completion.chunk
 * frames (spec 3.4, 4).
 *
 * Recorded pins encoded here:
 *
 * - the upstream usage filter: a payload whose `candidates[0]` carries a
 *   `finishReason` is kept verbatim; otherwise its `usageMetadata` is
 *   renamed to `cpaUsageMetadata` and hidden from the client - so a
 *   usage-only chunk produces NO frame (C14) and a terminal chunk whose
 *   candidate 0 did not finish hides the usage even when candidate 1 did
 *   (C23);
 * - one downstream chunk per candidate, in candidate order, each frame's
 *   `choices[0].index` mirroring the candidate index; the usage object is
 *   built once per upstream chunk and appears IDENTICALLY on every
 *   candidate's frame (C22);
 * - `delta.role` becomes `assistant` exactly on chunks whose candidate
 *   carries payload parts (reset per chunk: C11 frame 3 and C22 terminal
 *   frames carry null; C19/C21 carry assistant on every text frame);
 * - `finish_reason`/`native_finish_reason` ride a frame ONLY when the
 *   payload's usage survives the filter AND the candidate's finishReason
 *   is known (this or an earlier chunk); the value is `tool_calls` when
 *   the candidate saw any functionCall (stream keeps `native` at the
 *   lowered upstream reason - the C12 asymmetry vs C04), `max_tokens` for
 *   MAX_TOKENS, else `stop`;
 * - `id`/`model` come from the CURRENT chunk's `responseId`/`modelVersion`
 *   (defaults `""`/`"model"`); `created` is sticky from the last chunk
 *   that carried a parseable `createTime`.
 */
import { isPlainObject, readArray, readObject, readString, serializeOrdered } from './json'
import type { WireObject, WireValue } from './json'
import { chatUsageObject, createdSeconds, rawArgumentsAt, readGeminiUsage, toolCallId } from './response'
import { decodeUpstreamDataLines } from './sse'
import type { DownstreamStreamEvent, GeminiToChatContext } from './types'

/** Per-candidate stream state, keyed by candidate index. */
interface CandidateState {
  finishReason: string | undefined
  sawToolCall: boolean
  toolCallCount: number
}

function newState(): CandidateState {
  return { finishReason: undefined, sawToolCall: false, toolCallCount: 0 }
}

/**
 * Stateful upstream-chunk translator. One instance per stream; every
 * upstream chunk maps to one downstream chunk object per candidate.
 */
export class GeminiChunkTranslator {
  private readonly ctx: GeminiToChatContext
  private readonly states = new Map<number, CandidateState>()
  private created = 0

  constructor(ctx: GeminiToChatContext) {
    this.ctx = ctx
  }

  private stateOf(index: number): CandidateState {
    const existing = this.states.get(index)
    if (existing !== undefined) return existing
    const created = newState()
    this.states.set(index, created)
    return created
  }

  /**
   * Translates one (already usage-filtered) upstream payload into zero or
   * more downstream chunk bodies. `usageKept` says the payload's
   * `usageMetadata` survived the filter; `usageMeta` is that metadata.
   */
  translateChunk(
    parsed: Record<string, unknown>,
    rawPayload: string,
    usageKept: boolean,
    usageMeta: Record<string, unknown> | undefined,
  ): readonly string[] {
    const createTime = readString(parsed, 'createTime')
    if (createTime !== undefined && createTime.length > 0) {
      const seconds = createdSeconds(createTime)
      if (seconds > 0) this.created = seconds
    }
    const responseId = readString(parsed, 'responseId') ?? ''
    const modelVersion = readString(parsed, 'modelVersion') ?? 'model'
    const model = this.ctx.forceMappingModel ?? modelVersion

    const usage =
      usageKept && usageMeta !== undefined
        ? (chatUsageObject(readGeminiUsage(usageMeta)) as WireValue)
        : undefined

    const candidates = readArray(parsed, 'candidates')
    if (candidates === undefined) return []
    const frames: string[] = []
    for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
      const candidate = candidates[candidateIndex]
      if (!isPlainObject(candidate)) continue
      const index = typeof candidate['index'] === 'number' && Number.isFinite(candidate['index']) ? candidate['index'] : 0
      const state = this.stateOf(index)
      const finishReason = readString(candidate, 'finishReason')
      if (finishReason !== undefined && finishReason.length > 0) state.finishReason = finishReason
      const content = readObject(candidate, 'content')
      const parts = content !== undefined ? (readArray(content, 'parts') ?? []) : []

      const delta = this.deltaOf(index, candidateIndex, parts, state, rawPayload)
      const carriesFinish = usage !== undefined && state.finishReason !== undefined
      const lowered = state.finishReason !== undefined ? state.finishReason.toLowerCase() : undefined
      const finish = carriesFinish
        ? state.sawToolCall
          ? 'tool_calls'
          : state.finishReason === 'MAX_TOKENS'
            ? 'max_tokens'
            : 'stop'
        : null
      const native = carriesFinish ? lowered ?? null : null

      const chunk: WireObject = {
        id: responseId,
        object: 'chat.completion.chunk',
        created: this.created,
        model,
        choices: [
          {
            index,
            delta: delta as WireValue,
            finish_reason: finish,
            native_finish_reason: native,
          },
        ],
      }
      if (usage !== undefined) chunk['usage'] = usage
      frames.push(serializeOrdered(chunk))
    }
    return frames
  }

  /** Builds one candidate's delta from the chunk's parts. */
  private deltaOf(
    candidateKey: number,
    candidateIndex: number,
    parts: readonly unknown[],
    state: CandidateState,
    rawPayload: string,
  ): WireObject {
    let textBuffer = ''
    let thoughtBuffer = ''
    let hasPayload = false
    const toolCalls: WireObject[] = []
    const images: WireObject[] = []
    for (let partIndex = 0; partIndex < parts.length; partIndex++) {
      const part = parts[partIndex]
      if (!isPlainObject(part)) continue
      const path = ['candidates', String(candidateIndex), 'content', 'parts', String(partIndex)]
      const call = readObject(part, 'functionCall')
      const callName = call !== undefined ? readString(call, 'name') : undefined
      if (callName !== undefined) {
        state.sawToolCall = true
        hasPayload = true
        toolCalls.push({
          id: toolCallId(callName, this.ctx.nowMs(), this.ctx.nextToolCallSeq()),
          index: state.toolCallCount,
          type: 'function',
          function: { name: callName, arguments: rawArgumentsAt(rawPayload, path) },
        })
        state.toolCallCount += 1
        continue
      }
      const inline = readObject(part, 'inlineData')
      if (inline !== undefined) {
        const data = readString(inline, 'data')
        if (data !== undefined) {
          const mime = readString(inline, 'mime_type') ?? readString(inline, 'mimeType') ?? ''
          hasPayload = true
          images.push({
            index: images.length,
            type: 'image_url',
            image_url: { url: `data:${mime.length > 0 ? mime : 'image/png'};base64,${data}` },
          })
        }
        continue
      }
      const text = partTextOf(part)
      if (text === undefined) continue // pure thoughtSignature parts skip
      hasPayload = true
      if (part['thought'] === true) thoughtBuffer += text
      else textBuffer += text
    }
    const delta: WireObject = {
      role: hasPayload ? 'assistant' : null,
      content: textBuffer.length > 0 ? textBuffer : null,
      reasoning_content: thoughtBuffer.length > 0 ? thoughtBuffer : null,
      tool_calls: toolCalls.length > 0 ? toolCalls : null,
    }
    if (images.length > 0) delta['images'] = images
    void candidateKey
    return delta
  }
}

/** The text of one part, honoring the transcribe-model fallback. */
function partTextOf(part: Record<string, unknown>): string | undefined {
  const text = readString(part, 'text')
  if (text !== undefined) return text
  const transcription = readObject(part, 'audioTranscription')
  return transcription !== undefined ? readString(transcription, 'text') : undefined
}

// ---------------------------------------------------------------------------
// Usage filter (executor stream-loop stage, spec 4.4)
// ---------------------------------------------------------------------------

/**
 * Applies the recorded usage filter to one parsed upstream payload: a
 * `candidates[0].finishReason` keeps the payload verbatim; otherwise the
 * `usageMetadata` member is renamed to `cpaUsageMetadata` (hidden from the
 * translated frames). Returns whether the visible usage survived.
 */
export function filterUpstreamUsage(parsed: Record<string, unknown>): boolean {
  const candidates = readArray(parsed, 'candidates')
  const first = candidates?.[0]
  const finishReason = isPlainObject(first) ? readString(first, 'finishReason') : undefined
  const kept = finishReason !== undefined && finishReason.length > 0
  if (kept) return true
  if (parsed['usageMetadata'] !== undefined) {
    const hidden = parsed['usageMetadata']
    delete parsed['usageMetadata']
    parsed['cpaUsageMetadata'] = hidden
  }
  return false
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

/**
 * Translates an upstream Gemini SSE source into downstream stream events.
 * Each `data:` payload is usage-filtered, then mapped to one chunk object
 * per candidate (candidate order). Non-object payloads are skipped;
 * transport failures propagate so the caller can pick the pre-commit
 * plain error or the post-commit terminal frame.
 */
export async function* translateGeminiStreamToChatChunks(
  source: AsyncIterable<string | Uint8Array>,
  ctx: GeminiToChatContext,
): AsyncIterable<DownstreamStreamEvent> {
  const translator = new GeminiChunkTranslator(ctx)
  for await (const line of decodeUpstreamDataLines(source)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(line.data)
    } catch {
      continue // non-JSON payloads produce no downstream frame
    }
    if (!isPlainObject(parsed)) continue
    const record = parsed
    const kept = filterUpstreamUsage(record)
    const usageMeta = kept ? readObject(record, 'usageMetadata') : undefined
    for (const body of translator.translateChunk(record, line.data, kept, usageMeta)) {
      yield { kind: 'chunk', body }
    }
  }
}
