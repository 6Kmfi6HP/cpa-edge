
/**
 * Per-payload transforms of the passthrough stream (S2d9 4.2/4.3/4.6/4.7).
 *
 * Data payloads travel as RAW bytes: every change is an in-place splice
 * that leaves the rest of the payload untouched. The transforms are
 * model-echo injection (created/in_progress frames missing
 * `response.model` gain the client-requested alias at the end of the
 * response object), force-mapping rewrites (every `model`/`modelVersion`
 * string field becomes the alias), the `response.done` ->
 * `response.completed` rename, terminal output repair (an empty or
 * missing `response.output` is rebuilt from the recorded
 * `output_item.done` items; non-empty outputs gain missing item ids) and
 * the usage-detail defaulting every frame carrying a usage object goes
 * through. Compaction payloads skip the usage pass; `[DONE]` and non-JSON
 * payloads pass through untouched.
 */
import {
  appendMember,
  isPlainObject,
  rawSpanAt,
  scanArrayElements,
  scanObjectMembers,
  tryParseJson,
} from './json'
import type { RawSpan } from './json'

/** Marker of compaction payloads (exempt from usage-detail defaulting). */
export const COMPACTION_OBJECT = 'response.compaction'

/** Terminal success event types, after the done-rename. */
const TERMINAL_SUCCESS_TYPES: ReadonlySet<string> = new Set(['response.completed', 'response.incomplete'])

/** Event types whose response object gains the client model when absent. */
const MODEL_ECHO_TYPES: ReadonlySet<string> = new Set(['response.created', 'response.in_progress'])

/** One `output_item.done` item recorded for terminal output repair. */
export interface RecordedOutputItem {
  /** Parsed `output_index` of the done event (absent when the frame had none). */
  readonly outputIndex: number | undefined
  /** Raw item bytes AFTER the frame transforms (spliced verbatim on repair). */
  readonly raw: string
}

/** Inputs of the per-frame payload transform. */
export interface FrameTransformContext {
  /** Client-requested model (the alias) injected into created frames. */
  readonly clientModel: string | undefined
  /** Alias every model field rewrites to under force-mapping. */
  readonly forceMappingAlias?: string
  /** Terminal output repair knobs (stream and non-stream differ). */
  readonly outputRepair: { readonly rebuild: boolean; readonly hydrate: boolean }
}

/** Mutable state shared across the frames of one response. */
export interface FrameTransformState {
  /** Recorded output_item.done items, in arrival order. */
  readonly items: RecordedOutputItem[]
}

/** What the stream pipeline should do with one data payload. */
export type FrameOutcome =
  | { readonly kind: 'forward'; readonly payload: string }
  | { readonly kind: 'terminal-success'; readonly payload: string }
  | { readonly kind: 'terminal-failure'; readonly payload: string; readonly parsed: Record<string, unknown> }

/**
 * Transforms one data payload of an upstream frame. The returned payload
 * is the exact text to forward (or, for failures, the raw untouched text -
 * failure frames are never forwarded).
 */
export function transformFramePayload(
  payload: string,
  ctx: FrameTransformContext,
  state: FrameTransformState,
): FrameOutcome {
  const parsed = tryParseJson(payload)
  if (!isPlainObject(parsed)) return { kind: 'forward', payload }
  const type = typeof parsed['type'] === 'string' ? (parsed['type'] as string) : undefined

  if (type === 'error' || type === 'response.failed') {
    return { kind: 'terminal-failure', payload, parsed }
  }

  let text = payload
  let effectiveType = type
  if (type === 'response.done') {
    text = renameTypeValue(text, 'response.completed')
    effectiveType = 'response.completed'
  }

  if (ctx.forceMappingAlias !== undefined) {
    text = rewriteModelFields(text, ctx.forceMappingAlias)
  }
  if (ctx.clientModel !== undefined && effectiveType !== undefined && MODEL_ECHO_TYPES.has(effectiveType)) {
    text = injectResponseModel(text, ctx.clientModel)
  }

  const terminal =
    effectiveType !== undefined && TERMINAL_SUCCESS_TYPES.has(effectiveType)

  if (effectiveType === 'response.output_item.done') {
    const itemSpan = rawSpanAt(text, ['item'])
    if (itemSpan !== undefined) {
      state.items.push({
        outputIndex: typeof parsed['output_index'] === 'number' ? (parsed['output_index'] as number) : undefined,
        raw: text.slice(itemSpan.start, itemSpan.end),
      })
    }
  }

  if (terminal) {
    if (ctx.outputRepair.rebuild === true) {
      text = repairEmptyOutput(text, state)
    }
    if (ctx.outputRepair.hydrate === true) {
      text = hydrateOutputItemIds(text, state)
    }
  }

  text = ensureUsageDetails(text, parsed)
  if (terminal) return { kind: 'terminal-success', payload: text }
  return { kind: 'forward', payload: text }
}

// ---------------------------------------------------------------------------
// Usage-detail defaulting (4.2/4.7)
// ---------------------------------------------------------------------------

/**
 * Ensures the usage-detail members inside every usage object of a
 * payload: `response.usage` and a top-level `usage` each gain missing
 * `output_tokens_details.reasoning_tokens: 0` and
 * `input_tokens_details.cached_tokens: 0`. Compaction payloads and
 * payloads without a usage object return unchanged.
 */
export function ensureUsageDetails(payload: string, parsed: Record<string, unknown>): string {
  if (parsed['object'] === COMPACTION_OBJECT || parsed['type'] === COMPACTION_OBJECT) return payload
  let text = payload

  const topUsage = rawSpanAt(text, ['usage'])
  if (topUsage !== undefined) {
    text = ensureUsageSpan(text, topUsage)
  }
  const responseUsage = rawSpanAt(text, ['response', 'usage'])
  if (responseUsage !== undefined) {
    text = ensureUsageSpan(text, responseUsage)
  }
  return text
}

/** Ensures the two detail members inside the usage object at `span`. */
function ensureUsageSpan(text: string, span: RawSpan): string {
  const usageText = text.slice(span.start, span.end)
  const usage = tryParseJson(usageText)
  if (!isPlainObject(usage)) return text
  let updated = usageText
  updated = ensureDetailMember(updated, 'output_tokens_details', 'reasoning_tokens')
  updated = ensureDetailMember(updated, 'input_tokens_details', 'cached_tokens')
  if (updated === usageText) return text
  return text.slice(0, span.start) + updated + text.slice(span.end)
}

/**
 * Ensures `detailKey.innerKey` exists inside a usage object: a missing
 * detail object appends at the end of the usage object; a present object
 * without the inner key gains it inside.
 */
function ensureDetailMember(usageText: string, detailKey: string, innerKey: string): string {
  const usage = tryParseJson(usageText)
  if (!isPlainObject(usage)) return usageText
  const detail = usage[detailKey]
  if (detail === undefined) {
    return appendMember(usageText, { start: 0, end: usageText.length }, `"${detailKey}":{"${innerKey}":0}`)
  }
  if (!isPlainObject(detail)) return usageText
  if (detail[innerKey] !== undefined) return usageText
  const detailSpan = rawSpanAt(usageText, [detailKey])
  if (detailSpan === undefined) return usageText
  const detailText = usageText.slice(detailSpan.start, detailSpan.end)
  const updated = appendMember(detailText, { start: 0, end: detailText.length }, `"${innerKey}":0`)
  return usageText.slice(0, detailSpan.start) + updated + usageText.slice(detailSpan.end)
}

// ---------------------------------------------------------------------------
// Model echo + force-mapping (4.3)
// ---------------------------------------------------------------------------

/**
 * Appends `model` to the response object of a created/in_progress frame
 * when it is absent; present values stay verbatim.
 */
export function injectResponseModel(payload: string, model: string): string {
  const responseSpan = rawSpanAt(payload, ['response'])
  if (responseSpan === undefined) return payload
  const responseText = payload.slice(responseSpan.start, responseSpan.end)
  const response = tryParseJson(responseText)
  if (!isPlainObject(response)) return payload
  if (response['model'] !== undefined) return payload
  const updated = appendMember(responseText, { start: 0, end: responseText.length }, `"model":${JSON.stringify(model)}`)
  return payload.slice(0, responseSpan.start) + updated + payload.slice(responseSpan.end)
}

/**
 * Rewrites every `model`/`modelVersion` string member of a payload to the
 * force-mapping alias, in place (positions and spacing preserved).
 */
export function rewriteModelFields(payload: string, alias: string): string {
  return rewriteModelSpan(payload, { start: 0, end: payload.length }, alias)
}

function rewriteModelSpan(text: string, span: RawSpan, alias: string): string {
  const value = text[span.start]
  if (value === '"') return text
  if (value === '{') {
    const members = scanObjectMembers(text, span)
    if (members === undefined) return text
    let out = text
    for (let i = members.length - 1; i >= 0; i--) {
      const member = members[i]
      if (member === undefined) continue
      if (member.key === 'model' || member.key === 'modelVersion') {
        const memberText = out.slice(member.valueSpan.start, member.valueSpan.end)
        const memberValue = tryParseJson(memberText)
        if (typeof memberValue === 'string' && memberValue !== alias) {
          out = out.slice(0, member.valueSpan.start) + JSON.stringify(alias) + out.slice(member.valueSpan.end)
        }
        continue
      }
      const memberText = out.slice(member.valueSpan.start, member.valueSpan.end)
      if (memberText.startsWith('{') || memberText.startsWith('[')) {
        out = rewriteModelSpan(out, member.valueSpan, alias)
      }
    }
    return out
  }
  if (value === '[') {
    const elements = scanArrayElements(text, span)
    if (elements === undefined) return text
    let out = text
    for (let i = elements.length - 1; i >= 0; i--) {
      const element = elements[i]
      if (element === undefined) continue
      out = rewriteModelSpan(out, element.span, alias)
    }
    return out
  }
  return text
}

/** Renames the `type` member value of a payload in place. */
export function renameTypeValue(payload: string, target: string): string {
  const typeSpan = rawSpanAt(payload, ['type'])
  if (typeSpan === undefined) return payload
  const current = payload.slice(typeSpan.start, typeSpan.end)
  if (current === JSON.stringify(target)) return payload
  return payload.slice(0, typeSpan.start) + JSON.stringify(target) + payload.slice(typeSpan.end)
}

// ---------------------------------------------------------------------------
// Terminal output repair (4.6)
// ---------------------------------------------------------------------------

/**
 * Rebuilds a missing or empty `response.output` from the recorded
 * `output_item.done` items: indexed items sort by `output_index`,
 * unindexed items append in arrival order, item bytes splice verbatim.
 */
export function repairEmptyOutput(payload: string, state: FrameTransformState): string {
  const outputSpan = rawSpanAt(payload, ['response', 'output'])
  if (outputSpan === undefined) return payload
  const elements = scanArrayElements(payload, outputSpan) ?? []
  if (elements.length > 0) return payload
  if (state.items.length === 0) return payload
  const indexed = state.items
    .filter((item) => item.outputIndex !== undefined)
    .sort((left, right) => (left.outputIndex ?? 0) - (right.outputIndex ?? 0))
  const unindexed = state.items.filter((item) => item.outputIndex === undefined)
  const ordered = [...indexed, ...unindexed]
  const rebuilt = `[${ordered.map((item) => item.raw).join(',')}]`
  return payload.slice(0, outputSpan.start) + rebuilt + payload.slice(outputSpan.end)
}

/**
 * Fills missing `id` members of an existing non-empty `response.output`
 * from the recorded `output_item.done` items, matching by `output_index`.
 */
export function hydrateOutputItemIds(payload: string, state: FrameTransformState): string {
  let text = payload
  const outputSpan = rawSpanAt(text, ['response', 'output'])
  if (outputSpan === undefined) return text
  const elements = scanArrayElements(text, outputSpan) ?? []
  for (let i = elements.length - 1; i >= 0; i--) {
    const element = elements[i]
    if (element === undefined) continue
    const elementText = text.slice(element.span.start, element.span.end)
    const parsed = tryParseJson(elementText)
    if (!isPlainObject(parsed)) continue
    if (parsed['id'] !== undefined) continue
    const index = typeof parsed['output_index'] === 'number' ? (parsed['output_index'] as number) : undefined
    const match = state.items.find((item) => item.outputIndex === index)
    if (match === undefined) continue
    const matchId = itemIdOf(match.raw)
    if (matchId === undefined) continue
    const updated = appendMember(elementText, { start: 0, end: elementText.length }, `"id":${JSON.stringify(matchId)}`)
    text = text.slice(0, element.span.start) + updated + text.slice(element.span.end)
  }
  return text
}

function itemIdOf(itemRaw: string): string | undefined {
  const parsed = tryParseJson(itemRaw)
  if (!isPlainObject(parsed)) return undefined
  return typeof parsed['id'] === 'string' ? (parsed['id'] as string) : undefined
}
