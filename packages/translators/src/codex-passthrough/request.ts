
/**
 * Request rewrites of the Codex passthrough (S2d9 3.2 and 6).
 *
 * The passthrough EDITS the client's request bytes instead of rebuilding
 * them: existing members keep their position and the whitespace around
 * them, new members append at the end of their object with compact
 * separators, and deletions cut exactly one adjacent separator. The
 * append order is pinned by the recordings: stream, store,
 * parallel_tool_calls, include, stream_options, instructions, tools,
 * prompt_cache_key.
 *
 * `/responses` runs the full rewrite set (model alias resolution, input
 * rebuild, forced booleans, include, instructions defaulting, the
 * image-generation matrix, builtin-tool aliasing, field deletions,
 * session identity). `/responses/compact` runs the near-verbatim set:
 * the `stream` key is deleted, the model is rewritten, instructions are
 * defaulted, reasoning items are sanitized, tool schemas are normalized
 * and parallel_tool_calls follows the 3.2 rule - nothing else moves.
 */
import { normalizeCodexToolSchemasInBody } from '../oai2codex'
import { planInputItemIds } from './ids'
import type { ItemIdAction, ItemIdInput } from './ids'
import { resolveSessionIdentity } from './session'
import type { PassthroughSessionContext } from './session'
import { isValidEncryptedContent } from './signature'
import {
  appendElement,
  appendMember,
  deleteElement,
  deleteMember,
  isPlainObject,
  rawSpanAt,
  rawValueAt,
  replaceMemberValue,
  scanArrayElements,
  scanObjectMembers,
  serializeOrdered,
  tryParseJson,
  wireValueOf,
} from './json'
import type { RawMember, RawSpan, WireObject, WireValue } from './json'

/** The image-generation tool the gateway appends under the default mode. */
export const IMAGE_GENERATION_TOOL_JSON = '{"type":"image_generation","output_format":"png"}'

/** Values of `disable-image-generation` this route understands. */
export type ImageGenerationMode = 'off' | 'true' | 'all' | 'chat' | 'passthrough'

/** Builtin tool-type aliases rewritten to `web_search`. */
const WEB_SEARCH_ALIASES: ReadonlySet<string> = new Set(['web_search_preview', 'web_search_preview_2025_03_11'])

/** Members deleted from every /responses upstream body. */
const DELETED_RESPONSES_MEMBERS: readonly string[] = [
  'previous_response_id',
  'prompt_cache_retention',
  'safety_identifier',
  'generate',
  'truncation',
  'prompt_cache_options',
  'user',
  'context_management',
  'temperature',
  'top_p',
  'max_output_tokens',
  'max_completion_tokens',
]


/** Context of one passthrough request translation. */
export interface PassthroughRequestContext {
  /** Upstream model the alias resolves to (thinking suffix included). */
  readonly upstreamModel: string
  /** Native Responses-Lite dialect (3.3): fewer rewrites, parallel false. */
  readonly lite: boolean
  /** `disable-image-generation` mode; `off` is the default. */
  readonly imageMode: ImageGenerationMode
  /**
   * Thinking capability of the resolved model entry. Without it the whole
   * top-level `reasoning` object is stripped before the wire (recorded
   * S2d9-05: the mock model carries no capability and the client's
   * reasoning object never reaches the upstream).
   */
  readonly thinking?: boolean
  /** Session-identity inputs; absent disables derivation. */
  readonly session?: PassthroughSessionContext
}

/** Result of one request translation. */
export interface PassthroughUpstreamRequest {
  /** Serialized upstream body (byte-exact contract surface). */
  readonly body: string
  /** Body `prompt_cache_key` value (client value or derived UUID). */
  readonly promptCacheKey: string
  /** `Session-Id` header value (client key/header value or the same UUID). */
  readonly sessionHeaderValue: string
}

// ---------------------------------------------------------------------------
// Top-level member helpers (whitespace-tolerant, re-scanned per splice)
// ---------------------------------------------------------------------------

/** Span of the top-level JSON object inside `text`. */
function topSpan(text: string): RawSpan | undefined {
  const start = text.indexOf('{')
  if (start < 0) return undefined
  let depth = 0
  for (let i = start; i < text.length; i++) {
    const current = text[i]
    if (current === '"') {
      i = skipString(text, i)
      continue
    }
    if (current === '{') depth++
    else if (current === '}') {
      depth--
      if (depth === 0) return { start, end: i + 1 }
    }
  }
  return undefined
}

function skipString(text: string, index: number): number {
  let i = index + 1
  while (i < text.length) {
    if (text[i] === '\\') {
      i += 2
      continue
    }
    if (text[i] === '"') return i
    i++
  }
  return i
}

function membersOf(text: string): readonly RawMember[] {
  const span = topSpan(text)
  if (span === undefined) return []
  return scanObjectMembers(text, span) ?? []
}

function memberOf(text: string, key: string): RawMember | undefined {
  return membersOf(text).find((member) => member.key === key)
}

/** Replaces or appends one top-level member with compact serialized bytes. */
function setMember(text: string, key: string, valueJson: string): string {
  const member = memberOf(text, key)
  if (member === undefined) {
    const span = topSpan(text)
    if (span === undefined) return text
    return appendMember(text, span, `"${key}":${valueJson}`)
  }
  const current = text.slice(member.valueSpan.start, member.valueSpan.end)
  if (current === valueJson) return text
  return replaceMemberValue(text, member, valueJson)
}

/** Deletes one top-level member when present. */
function removeMember(text: string, key: string): string {
  const member = memberOf(text, key)
  return member === undefined ? text : deleteMember(text, member)
}

/** Sets a top-level boolean member to the compact JSON literal. */
function setBooleanMember(text: string, key: string, value: boolean): string {
  return setMember(text, key, value ? 'true' : 'false')
}

/** Rewrites the `model` member when it differs from the upstream name. */
function rewriteModel(text: string, upstreamModel: string): string {
  const member = memberOf(text, 'model')
  if (member === undefined) return text
  const modelJson = serializeOrdered(upstreamModel)
  const current = text.slice(member.valueSpan.start, member.valueSpan.end)
  if (current === modelJson) return text
  return replaceMemberValue(text, member, modelJson)
}

/** Defaults the `instructions` member to "" when absent or null. */
function defaultInstructions(text: string): string {
  const member = memberOf(text, 'instructions')
  if (member === undefined) return setMember(text, 'instructions', '""')
  if (tryParseJson(text.slice(member.valueSpan.start, member.valueSpan.end)) === null) {
    return replaceMemberValue(text, member, '""')
  }
  return text
}

/** True when the include value is exactly the forced one-element array. */
function isCanonicalInclude(valueText: string | undefined): boolean {
  if (valueText === undefined) return false
  const parsed = tryParseJson(valueText)
  return Array.isArray(parsed) && parsed.length === 1 && parsed[0] === 'reasoning.encrypted_content'
}

/** Raw token of `stream_options.reasoning_summary_delivery`, when present. */
function preservedSummaryDelivery(text: string): string | undefined {
  const valueText = rawValueAt(text, ['stream_options'])
  if (valueText === undefined) return undefined
  const parsed = tryParseJson(valueText)
  if (!isPlainObject(parsed)) return undefined
  if (parsed['reasoning_summary_delivery'] === undefined) return undefined
  const token = rawValueAt(valueText, ['reasoning_summary_delivery'])
  if (token === undefined) return undefined
  return `{"reasoning_summary_delivery":${token}}`
}

// ---------------------------------------------------------------------------
// /responses
// ---------------------------------------------------------------------------

/**
 * Applies the full /responses rewrite pipeline. The upstream call is
 * always SSE: `stream` is forced true no matter what the client asked.
 */
export async function translateResponsesPassthrough(
  rawBody: string,
  parsed: Record<string, unknown>,
  ctx: PassthroughRequestContext,
): Promise<PassthroughUpstreamRequest> {
  let text = rawBody

  text = rewriteModel(text, ctx.upstreamModel)
  text = await rebuildInput(text, { responsesRoute: true, normalizeIds: true })
  const toolsState = applyToolsMatrix(text, ctx)
  text = toolsState.text

  // stream_options leaves its original position; the preserved delivery
  // member re-enters at its slot in the append sequence.
  const deliveryJson = preservedSummaryDelivery(text)
  text = removeMember(text, 'stream_options')

  for (const key of DELETED_RESPONSES_MEMBERS) {
    text = removeMember(text, key)
  }
  const serviceTier = tryParseJson(rawValueAt(text, ['service_tier']) ?? '')
  if (serviceTier !== 'priority') text = removeMember(text, 'service_tier')
  if (ctx.thinking !== true) text = removeMember(text, 'reasoning')

  // The pinned append sequence.
  text = setBooleanMember(text, 'stream', true)
  text = setBooleanMember(text, 'store', false)
  text = setBooleanMember(text, 'parallel_tool_calls', ctx.lite !== true)
  if (isCanonicalInclude(rawValueAt(text, ['include'])) !== true) {
    text = setMember(text, 'include', '["reasoning.encrypted_content"]')
  }
  if (deliveryJson !== undefined) text = setMember(text, 'stream_options', deliveryJson)
  if (ctx.lite !== true) text = defaultInstructions(text)
  if (toolsState.createdMember) {
    text = setMember(text, 'tools', `[${IMAGE_GENERATION_TOOL_JSON}]`)
  }
  if (ctx.lite !== true && toolsState.empty) {
    text = removeMember(text, 'parallel_tool_calls')
  }

  // Shared Codex tool-schema normalization (3.2 optional rules).
  text = normalizeCodexToolSchemasInBody(text)

  // Session identity: client key verbatim, else the derived UUID appended.
  const session = await resolveSession(parsed, ctx)
  if (memberOf(text, 'prompt_cache_key') === undefined) {
    text = setMember(text, 'prompt_cache_key', serializeOrdered(session.promptCacheKey))
  }
  return { body: text, promptCacheKey: session.promptCacheKey, sessionHeaderValue: session.sessionHeaderValue }
}

// ---------------------------------------------------------------------------
// /responses/compact
// ---------------------------------------------------------------------------

/**
 * Applies the near-verbatim compact pipeline: `stream` deleted, model
 * rewritten, reasoning items sanitized, tool schemas normalized,
 * parallel_tool_calls per 3.2, instructions defaulted, the same session
 * identity attachment. No store/include forcing, no image tool, no other
 * deletions.
 */
export async function translateCompactPassthrough(
  rawBody: string,
  parsed: Record<string, unknown>,
  ctx: PassthroughRequestContext,
): Promise<PassthroughUpstreamRequest> {
  let text = rawBody

  text = rewriteModel(text, ctx.upstreamModel)
  text = await rebuildInput(text, { responsesRoute: false, normalizeIds: false })

  const toolsSpan = rawSpanAt(text, ['tools'])
  const toolsEmpty = toolsSpan === undefined || (scanArrayElements(text, toolsSpan)?.length ?? 0) === 0

  text = removeMember(text, 'stream')
  text = setBooleanMember(text, 'parallel_tool_calls', ctx.lite !== true)
  if (ctx.lite !== true) text = defaultInstructions(text)
  if (ctx.lite !== true && toolsEmpty) {
    text = removeMember(text, 'parallel_tool_calls')
  }
  text = normalizeCodexToolSchemasInBody(text)

  const session = await resolveSession(parsed, ctx)
  if (memberOf(text, 'prompt_cache_key') === undefined) {
    text = setMember(text, 'prompt_cache_key', serializeOrdered(session.promptCacheKey))
  }
  return { body: text, promptCacheKey: session.promptCacheKey, sessionHeaderValue: session.sessionHeaderValue }
}

async function resolveSession(
  parsed: Record<string, unknown>,
  ctx: PassthroughRequestContext,
): Promise<{ promptCacheKey: string; sessionHeaderValue: string }> {
  if (ctx.session === undefined) {
    const bodyKey = typeof parsed['prompt_cache_key'] === 'string' ? (parsed['prompt_cache_key'] as string) : ''
    return { promptCacheKey: bodyKey, sessionHeaderValue: bodyKey }
  }
  return resolveSessionIdentity(parsed, ctx.session)
}

// ---------------------------------------------------------------------------
// Input rebuild (3.2 input row)
// ---------------------------------------------------------------------------

interface InputRewriteOptions {
  /** The /responses route may rewrite message items (roles, breakpoints). */
  readonly responsesRoute: boolean
  /** Typed item ids are normalized (/responses only). */
  readonly normalizeIds: boolean
}

/**
 * Rewrites the top-level `input` member. A string becomes the synthesized
 * user message. An array re-splices with compact separators - the
 * recorded RawMessage-marshal shape - while each item keeps its own bytes
 * unless a rule changes it:
 *
 * - message items re-marshal compactly ONLY when the /responses rewrite
 *   applies (a `system` role or a `prompt_cache_breakpoint` part is
 *   present somewhere in the array); otherwise they pass raw, matching
 *   the recorded S2d9-05/S2d9-15 shapes;
 * - reasoning items sanitize in place: a valid `encrypted_content` keeps
 *   the item verbatim, an invalid signature and its orphan id drop as
 *   member deletions, and a non-empty `content` promotes its
 *   `reasoning_text` parts into `summary` before `content` is forced
 *   empty;
 * - every other item passes raw, with the id plan applied as an in-place
 *   value patch.
 */
async function rebuildInput(text: string, options: InputRewriteOptions): Promise<string> {
  const span = rawSpanAt(text, ['input'])
  if (span === undefined) return text
  const valueText = text.slice(span.start, span.end)

  if (valueText.startsWith('"')) {
    const parsed = tryParseJson(valueText)
    if (typeof parsed !== 'string') return text
    const synthesized = serializeOrdered([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: parsed }] },
    ])
    return text.slice(0, span.start) + synthesized + text.slice(span.end)
  }

  if (!valueText.startsWith('[')) return text
  const elements = scanArrayElements(text, span) ?? []
  const items = elements.map((element) => text.slice(element.span.start, element.span.end))

  const idPlan = options.normalizeIds === true ? await planInputItemIds(items.map(itemIdInput)) : undefined
  const rewriteMessages =
    options.responsesRoute === true && items.some((raw) => messageNeedsRewrite(raw, options))
  const rebuilt: string[] = []
  for (let index = 0; index < items.length; index++) {
    const raw = items[index] ?? '{}'
    const action = idPlan?.[index]
    if (action !== undefined && action.kind === 'drop') continue
    rebuilt.push(rebuildInputItem(raw, rewriteMessages, action))
  }
  const joined = `[${rebuilt.join(',')}]`
  return text.slice(0, span.start) + joined + text.slice(span.end)
}

/** True when one message item carries a `system` role or a breakpoint part. */
function messageNeedsRewrite(raw: string, options: InputRewriteOptions): boolean {
  const parsed = tryParseJson(raw)
  if (!isPlainObject(parsed) || parsed['type'] !== 'message') return false
  if (parsed['role'] === 'system') return true
  const content = parsed['content']
  if (!Array.isArray(content)) return false
  return content.some((part) => isPlainObject(part) && part['prompt_cache_breakpoint'] !== undefined)
}

/** Identity inputs of one raw item for the id plan. */
function itemIdInput(raw: string): ItemIdInput {
  const parsed = tryParseJson(raw)
  const record = isPlainObject(parsed) ? parsed : {}
  return {
    type: record['type'],
    id: record['id'],
    encryptedValid: isValidEncryptedContent(record['encrypted_content']),
  }
}

/** Rewrites one input item per its type. */
function rebuildInputItem(raw: string, rewriteMessages: boolean, action: ItemIdAction | undefined): string {
  const parsed = tryParseJson(raw)
  if (!isPlainObject(parsed)) return raw
  const type = parsed['type']

  if (type === 'message') {
    if (rewriteMessages !== true) return patchItemId(raw, action)
    return rebuildMessageItem(raw, parsed, action)
  }
  if (type === 'reasoning') return rebuildReasoningItem(raw, parsed, action)
  return patchItemId(raw, action)
}

/** Compact re-marshal of a message item: roles, parts, id. */
function rebuildMessageItem(raw: string, parsed: Record<string, unknown>, action: ItemIdAction | undefined): string {
  const itemSpan: RawSpan = { start: 0, end: raw.length }
  const members = scanObjectMembers(raw, itemSpan) ?? []
  const out: WireObject = {}
  for (const member of members) {
    if (member.key === 'role') {
      out['role'] = parsed['role'] === 'system' ? 'developer' : wireValueOf(parsed['role'])
      continue
    }
    if (member.key === 'content') {
      out['content'] = rebuildContentParts(parsed['content'])
      continue
    }
    if (member.key === 'id') {
      out['id'] = action !== undefined && action.kind === 'rewrite' ? action.value : wireValueOf(parsed['id'])
      continue
    }
    out[member.key] = wireValueOf(parsed[member.key])
  }
  return serializeOrdered(out)
}

/** Content parts of a message: objects keep their member order minus the
 * `prompt_cache_breakpoint` members; non-objects splice verbatim. */
function rebuildContentParts(content: unknown): WireValue {
  if (!Array.isArray(content)) return wireValueOf(content)
  return content.map((part) => {
    if (!isPlainObject(part)) return wireValueOf(part)
    const out: WireObject = {}
    for (const key of Object.keys(part)) {
      if (key === 'prompt_cache_breakpoint') continue
      out[key] = wireValueOf(part[key])
    }
    return out
  })
}

/**
 * Sanitizes one reasoning item with byte-preserving edits: a non-empty
 * `content` promotes its `reasoning_text` parts into `summary` (the
 * content value is forced `[]`, the summary value is replaced or
 * appended); an invalid `encrypted_content` drops itself, and the item id
 * drops with it (the store=false orphan rule); a valid signature keeps
 * every byte verbatim.
 */
function rebuildReasoningItem(raw: string, parsed: Record<string, unknown>, action: ItemIdAction | undefined): string {
  const encrypted = parsed['encrypted_content']
  const encryptedValid = isValidEncryptedContent(encrypted)
  const content = parsed['content']
  const contentNonEmpty = Array.isArray(content) && content.length > 0

  let out = raw
  if (contentNonEmpty) {
    const promoted = promoteReasoningParts(content)
    const summaryEmpty = !Array.isArray(parsed['summary']) || (parsed['summary'] as readonly unknown[]).length === 0
    if (summaryEmpty && promoted.length > 0) {
      out = setRawMember(out, 'summary', serializeOrdered(promoted))
    }
    out = setRawMember(out, 'content', '[]')
  }
  if (!encryptedValid) {
    if (encrypted !== undefined) {
      const member = memberOfRaw(out, 'encrypted_content')
      if (member !== undefined) out = deleteMember(out, member)
    }
    const idMember = memberOfRaw(out, 'id')
    if (idMember !== undefined) out = deleteMember(out, idMember)
    return out
  }
  return patchItemId(out, action)
}

/** `reasoning_text` parts of a content array as `summary_text` parts. */
function promoteReasoningParts(content: readonly unknown[]): readonly WireValue[] {
  const out: WireValue[] = []
  for (const part of content) {
    if (!isPlainObject(part)) continue
    if (part['type'] !== 'reasoning_text') continue
    const text = part['text']
    if (typeof text !== 'string') continue
    out.push({ type: 'summary_text', text })
  }
  return out
}

/** Sets one member of a raw item to compact bytes (replace or append). */
function setRawMember(raw: string, key: string, valueJson: string): string {
  const member = memberOfRaw(raw, key)
  if (member === undefined) {
    return appendMember(raw, { start: 0, end: raw.length }, `"${key}":${valueJson}`)
  }
  return replaceMemberValue(raw, member, valueJson)
}

function memberOfRaw(text: string, key: string): RawMember | undefined {
  return (scanObjectMembers(text, { start: 0, end: text.length }) ?? []).find((member) => member.key === key)
}

/** Applies the id plan to a raw item (in-place value patch). */
function patchItemId(raw: string, action: ItemIdAction | undefined): string {
  if (action === undefined || action.kind !== 'rewrite') return raw
  const member = memberOfRaw(raw, 'id')
  if (member === undefined) return raw
  return replaceMemberValue(raw, member, serializeOrdered(action.value))
}

// ---------------------------------------------------------------------------
// Tools + tool_choice (3.2 tools rows)
// ---------------------------------------------------------------------------

interface ToolsRewriteState {
  readonly text: string
  /** Final tools array is absent or empty. */
  readonly empty: boolean
  /** The tools member must be created at its append slot. */
  readonly createdMember: boolean
}

/**
 * Applies the builtin alias rewrite and the image-generation matrix to the
 * tools/tool_choice members. The tools array re-splices with compact
 * separators whenever anything changes, each element keeping its own bytes
 * (recorded S2d9-04: the declared function tool and the alias-rewritten
 * `web_search` entry keep their original spacing, the appended
 * image-generation tool is compact). Under `off` (the default) an
 * image-generation tool is appended whenever none is declared;
 * `true`/`all`/`chat` strip declared image tools instead; `passthrough`
 * and native Lite requests leave everything alone.
 */
function applyToolsMatrix(text: string, ctx: PassthroughRequestContext): ToolsRewriteState {
  let out = text
  const toolsSpan = rawSpanAt(out, ['tools'])

  if (toolsSpan === undefined) {
    if (ctx.imageMode === 'off' && ctx.lite !== true) {
      return { text: out, empty: false, createdMember: true }
    }
    return { text: out, empty: true, createdMember: false }
  }

  const elements = scanArrayElements(out, toolsSpan) ?? []
  const kept: string[] = []
  let changed = false
  const stripping = ctx.imageMode === 'true' || ctx.imageMode === 'all' || ctx.imageMode === 'chat'
  let declaredImageTool = false
  for (const element of elements) {
    let elementText = out.slice(element.span.start, element.span.end)
    const parsed = tryParseJson(elementText)
    const record = isPlainObject(parsed) ? parsed : undefined
    if (record !== undefined && record['type'] === 'image_generation') declaredImageTool = true
    if (stripping && record !== undefined && record['type'] === 'image_generation') {
      changed = true
      continue
    }
    const aliased = rewriteToolElementType(elementText, { start: 0, end: elementText.length })
    if (aliased !== elementText) {
      changed = true
      elementText = aliased
    }
    kept.push(elementText)
  }

  let empty: boolean
  if (ctx.imageMode === 'off' && ctx.lite !== true && !declaredImageTool) {
    kept.push(IMAGE_GENERATION_TOOL_JSON)
    changed = true
    empty = false
  } else {
    empty = kept.length === 0
  }

  if (changed) {
    const rebuilt = `[${kept.join(',')}]`
    const currentSpan = rawSpanAt(out, ['tools'])
    if (currentSpan !== undefined) {
      out = out.slice(0, currentSpan.start) + rebuilt + out.slice(currentSpan.end)
    }
  }

  out = rewriteToolChoice(out, ctx.imageMode)
  return { text: out, empty, createdMember: false }
}

/** True when a tools array element declares an image_generation tool. */
function imageToolDeclared(text: string, span: RawSpan): boolean {
  const elements = scanArrayElements(text, span) ?? []
  for (const element of elements) {
    const parsed = tryParseJson(text.slice(element.span.start, element.span.end))
    if (isPlainObject(parsed) && parsed['type'] === 'image_generation') return true
  }
  return false
}

/** Rewrites `web_search_preview*` tool types to `web_search` in place. */
function rewriteWebSearchAliases(text: string, toolsSpan: RawSpan): string {
  let out = text
  const elements = scanArrayElements(out, toolsSpan) ?? []
  for (let i = elements.length - 1; i >= 0; i--) {
    const element = elements[i]
    if (element === undefined) continue
    out = rewriteToolElementType(out, element.span)
  }
  return out
}

/** Alias-rewrites the `type` member of one tool-shaped object span. */
function rewriteToolElementType(text: string, span: RawSpan): string {
  const objectText = text.slice(span.start, span.end)
  if (!objectText.startsWith('{')) return text
  const members = scanObjectMembers(objectText, { start: 0, end: objectText.length })
  const typeMember = members?.find((member) => member.key === 'type')
  if (typeMember === undefined) return text
  const typeText = objectText.slice(typeMember.valueSpan.start, typeMember.valueSpan.end)
  const parsedType = tryParseJson(typeText)
  if (typeof parsedType !== 'string' || !WEB_SEARCH_ALIASES.has(parsedType)) return text
  const updated =
    objectText.slice(0, typeMember.valueSpan.start) + '"web_search"' + objectText.slice(typeMember.valueSpan.end)
  return text.slice(0, span.start) + updated + text.slice(span.end)
}

/**
 * Applies alias + image rules to `tool_choice`: object values have their
 * `type` alias-rewritten and their nested `tools` elements processed; a
 * tool_choice that itself names `image_generation` is deleted under the
 * strip modes.
 */
function rewriteToolChoice(text: string, mode: ImageGenerationMode): string {
  const span = rawSpanAt(text, ['tool_choice'])
  if (span === undefined) return text
  const objectText = text.slice(span.start, span.end)
  if (!objectText.startsWith('{')) return text
  const parsed = tryParseJson(objectText)
  if (!isPlainObject(parsed)) return text

  const stripping = mode === 'true' || mode === 'all' || mode === 'chat'
  if (stripping && parsed['type'] === 'image_generation') {
    const member = memberOf(text, 'tool_choice')
    return member === undefined ? text : deleteMember(text, member)
  }

  let updated = rewriteToolElementType(text, span)
  const nestedSpan = rawSpanAt(updated, ['tool_choice', 'tools'])
  if (nestedSpan !== undefined) {
    updated = rewriteWebSearchAliases(updated, nestedSpan)
    if (stripping) {
      const elements = scanArrayElements(updated, nestedSpan) ?? []
      for (let i = elements.length - 1; i >= 0; i--) {
        const element = elements[i]
        if (element === undefined) continue
        const parsedElement = tryParseJson(updated.slice(element.span.start, element.span.end))
        if (isPlainObject(parsedElement) && parsedElement['type'] === 'image_generation') {
          updated = deleteElement(updated, element)
        }
      }
    }
  }
  return updated
}
