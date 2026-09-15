/**
 * Request translation: Gemini generateContent body -> OpenAI chat
 * completions body (S2d2 section 3.1).
 *
 * The translator stage builds the ordered upstream body from a fixed
 * template (`model`, `messages`, generation-config keys, `stream`,
 * `service_tier`, `tools`, `tool_choice`), maps contents to messages with
 * the recorded part rules (thought parts dropped and thought-only turns
 * dropped entirely, text-only turns concatenated, function calls becoming
 * `tool_calls` with deterministic sha256 ids, function responses emitting
 * separate `tool` messages with FIFO id reuse), and converts the thinking
 * config to a first-pass `reasoning_effort`. The composed entry point then
 * runs the stage-2 thinking pipeline, whose EFFECTIVE mapping is the
 * recorded contract (section 3.3).
 */
import { CpaError } from '@cpa-edge/core'
import {
  parseStrictJson,
  rawValueAt,
  readArray,
  readObject,
  readString,
  serializeOrdered,
  sortKeysDeep,
} from './json'
import { applyRequestThinking, convertBudgetToLevel, extractSourceThinkingConfig } from './thinking'
import { DEFAULT_OPENAI_COMPAT_THINKING } from './types'
import type { GeminiToOpenAIContext, GeminiUpstreamRequest, WireObject, WireValue } from './types'

const encoder = new TextEncoder()

/** sha256 of a UTF-8 string as lowercase hex (Web Crypto only). */
export async function sha256Hex(seed: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(seed))
  const bytes = new Uint8Array(digest)
  let hex = ''
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
  return hex
}

/**
 * Deterministic tool-call id: `call_` + the first 12 sha256 bytes (24 hex
 * chars) of `<kind>|<turnIndex>|<partIndex>|<name>|<raw>`. The raw payload
 * bytes are the client's own, spacing included. The turn index counts
 * every client turn, including thought-only turns that are dropped later.
 */
export async function deriveToolCallId(
  kind: 'call' | 'response',
  turnIndex: number,
  partIndex: number,
  name: string,
  raw: string,
): Promise<string> {
  const digest = await sha256Hex(`${kind}|${turnIndex}|${partIndex}|${name}|${raw}`)
  return `call_${digest.slice(0, 24)}`
}

function requireObject(parsed: unknown): Record<string, unknown> {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CpaError('invalid-input', 'Invalid request: malformed JSON body')
  }
  return parsed as Record<string, unknown>
}

/** Reads the first string among alternative keys. */
function firstString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const raw = record[key]
    if (typeof raw === 'string') return raw
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Translates one client request into the upstream body, stage 1 only: the
 * thinking config is converted but NOT yet validated or clamped. Use
 * {@link translateGeminiRequest} for the effective (recorded) mapping.
 */
export async function translateGeminiToOpenAI(
  rawBody: string,
  ctx: GeminiToOpenAIContext,
): Promise<GeminiUpstreamRequest> {
  const request = requireObject(parseStrictJson(rawBody))
  const body = await buildBody(request, rawBody, ctx)
  return { body: serializeOrdered(body), value: body }
}

/**
 * Translates one client request into the final upstream body: stage 1 plus
 * the stage-2 thinking pipeline. Throws `CpaError('invalid-input', ...)`
 * with the recorded wire message for unknown thinking levels and
 * unconvertible budgets.
 */
export async function translateGeminiRequest(
  rawBody: string,
  ctx: GeminiToOpenAIContext,
): Promise<GeminiUpstreamRequest> {
  const request = requireObject(parseStrictJson(rawBody))
  const body = await buildBody(request, rawBody, ctx)
  applyRequestThinking(body, request, ctx.thinking ?? DEFAULT_OPENAI_COMPAT_THINKING)
  return { body: serializeOrdered(body), value: body }
}

/** Executor injection: streaming bodies carry `stream_options` last. */
export function withStreamOptions(body: WireObject): void {
  body['stream_options'] = { include_usage: true }
}

// ---------------------------------------------------------------------------
// Body assembly
// ---------------------------------------------------------------------------

async function buildBody(
  request: Record<string, unknown>,
  rawBody: string,
  ctx: GeminiToOpenAIContext,
): Promise<WireObject> {
  const messages: WireObject[] = []

  const system = readObject(request, 'systemInstruction') ?? readObject(request, 'system_instruction')
  if (system !== undefined) {
    const parts = systemParts(system['parts'])
    if (parts.length > 0) messages.push({ role: 'system', content: parts })
  }

  const callQueues = new Map<string, string[]>()
  const contents = readArray(request, 'contents') ?? []
  for (let turnIndex = 0; turnIndex < contents.length; turnIndex++) {
    const content = contents[turnIndex]
    if (!isRecord(content)) continue
    // Turn order is part of the wire contract: awaiting in sequence keeps
    // the emitted message order deterministic.
    await appendTurn(messages, callQueues, content, turnIndex, rawBody)
  }

  const body: WireObject = {
    model: ctx.upstreamModel,
    messages,
    ...generationConfigKeys(request),
  }
  // reasoning_effort is the last generation-config-derived key; `stream`
  // follows it, then service_tier / tools / tool_choice (recorded order).
  applyThinkingStage1(body, request)
  body['stream'] = ctx.stream

  const serviceTier = request['service_tier']
  if (typeof serviceTier === 'string') body['service_tier'] = serviceTier

  const tools = translateTools(readArray(request, 'tools') ?? [])
  if (tools.length > 0) body['tools'] = tools

  const toolChoice = translateToolChoice(request['toolConfig'])
  if (toolChoice !== undefined) body['tool_choice'] = toolChoice

  return body
}

/** generationConfig -> sampling keys, in the recorded wire order. */
function generationConfigKeys(request: Record<string, unknown>): WireObject {
  const config = readObject(request, 'generationConfig')
  const out: WireObject = {}
  if (config === undefined) return out

  const temperature = config['temperature']
  if (typeof temperature === 'number' && Number.isFinite(temperature)) out['temperature'] = temperature

  const maxOutputTokens = config['maxOutputTokens']
  if (typeof maxOutputTokens === 'number' && Number.isFinite(maxOutputTokens)) {
    out['max_tokens'] = Math.trunc(maxOutputTokens)
  }

  const topP = config['topP']
  if (typeof topP === 'number' && Number.isFinite(topP)) out['top_p'] = topP

  const topK = config['topK']
  if (typeof topK === 'number' && Number.isFinite(topK)) out['top_k'] = Math.trunc(topK)

  const stopSequences = config['stopSequences']
  if (Array.isArray(stopSequences)) {
    const stop = stopSequences.filter((entry): entry is string => typeof entry === 'string')
    if (stop.length > 0) out['stop'] = stop
  }

  const candidateCount = config['candidateCount']
  if (typeof candidateCount === 'number' && Number.isFinite(candidateCount)) {
    out['n'] = Math.trunc(candidateCount)
  }

  const responseModalities = config['responseModalities']
  if (Array.isArray(responseModalities)) {
    const modalities = responseModalities
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.toLowerCase())
      .filter((entry) => entry === 'text' || entry === 'image' || entry === 'audio')
    if (modalities.length > 0) out['modalities'] = modalities
  }

  return out
}

/**
 * Stage-1 thinking write: the level is lowercased+trimmed verbatim, the
 * budget is converted to its ladder level. An unconvertible budget writes
 * an empty effort so the stage-2 pass still sees the key and fails with
 * the recorded 400.
 */
function applyThinkingStage1(body: WireObject, request: Record<string, unknown>): void {
  const config = extractSourceThinkingConfig(request)
  if (config.level !== undefined) {
    body['reasoning_effort'] = config.level
    return
  }
  if (config.budget !== undefined) {
    body['reasoning_effort'] = convertBudgetToLevel(config.budget) ?? ''
  }
}

// ---------------------------------------------------------------------------
// contents[] -> messages[]
// ---------------------------------------------------------------------------

/** One rendered turn part, before the text-only/content-array decision. */
type RenderedPart =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'media'; readonly value: WireObject }

async function appendTurn(
  messages: WireObject[],
  callQueues: Map<string, string[]>,
  content: Record<string, unknown>,
  turnIndex: number,
  rawBody: string,
): Promise<void> {
  const parts = readArray(content, 'parts') ?? []
  if (parts.length > 0 && parts.every((part) => isRecord(part) && part['thought'] === true)) {
    // A turn whose parts are all thought parts is dropped entirely.
    return
  }

  const rawRole = readString(content, 'role') ?? ''
  const role = rawRole === 'model' ? 'assistant' : rawRole

  const rendered: RenderedPart[] = []
  const toolCalls: WireObject[] = []

  for (let partIndex = 0; partIndex < parts.length; partIndex++) {
    const part = parts[partIndex]
    if (!isRecord(part)) continue
    if (part['thought'] === true) continue

    const functionCall = readObject(part, 'functionCall')
    if (functionCall !== undefined) {
      toolCalls.push(await functionCallEntry(callQueues, functionCall, turnIndex, partIndex, rawBody))
      continue
    }

    const functionResponse = readObject(part, 'functionResponse')
    if (functionResponse !== undefined) {
      // Separate tool message, emitted immediately (before this turn's own).
      messages.push(await toolResultMessage(callQueues, functionResponse, turnIndex, partIndex, rawBody))
      continue
    }

    const text = readString(part, 'text')
    if (text !== undefined) {
      rendered.push({ kind: 'text', text })
      continue
    }

    const inline = readObject(part, 'inlineData') ?? readObject(part, 'inline_data')
    if (inline !== undefined) {
      const value = inlineDataPart(inline)
      if (value !== undefined) rendered.push({ kind: 'media', value })
      continue
    }

    const file = readObject(part, 'fileData') ?? readObject(part, 'file_data')
    if (file !== undefined) {
      const value = fileDataRendered(file)
      if (value !== undefined) rendered.push(value)
    }
  }

  const message: WireObject = { role }
  if (rendered.every((part) => part.kind === 'text') && rendered.length > 0) {
    message['content'] = rendered.map((part) => (part.kind === 'text' ? part.text : '')).join('')
  } else if (rendered.length > 0) {
    message['content'] = rendered.map((part) =>
      part.kind === 'text' ? { type: 'text', text: part.text } : part.value,
    )
  } else {
    message['content'] = ''
  }
  if (toolCalls.length > 0) message['tool_calls'] = toolCalls
  messages.push(message)
}

/** Explicit-id alternatives on functionCall / functionResponse nodes. */
function explicitId(node: Record<string, unknown>): string | undefined {
  return firstString(node, ['id', 'call_id', 'callId'])
}

async function functionCallEntry(
  callQueues: Map<string, string[]>,
  functionCall: Record<string, unknown>,
  turnIndex: number,
  partIndex: number,
  rawBody: string,
): Promise<WireObject> {
  const name = readString(functionCall, 'name') ?? ''
  const argsRaw =
    rawValueAt(rawBody, ['contents', turnIndex, 'parts', partIndex, 'functionCall', 'args']) ?? '{}'
  const id = explicitId(functionCall) ?? (await deriveToolCallId('call', turnIndex, partIndex, name, argsRaw))
  queue(callQueues, name).push(id)
  return {
    id,
    type: 'function',
    function: { name, arguments: argsRaw },
  }
}

async function toolResultMessage(
  callQueues: Map<string, string[]>,
  functionResponse: Record<string, unknown>,
  turnIndex: number,
  partIndex: number,
  rawBody: string,
): Promise<WireObject> {
  const name = readString(functionResponse, 'name') ?? ''
  const response = functionResponse['response']
  const responseRaw =
    rawValueAt(rawBody, ['contents', turnIndex, 'parts', partIndex, 'functionResponse', 'response']) ?? 'null'

  const declared = explicitId(functionResponse)
  let toolCallId: string
  if (declared !== undefined) {
    removeQueued(callQueues, name, declared)
    toolCallId = declared
  } else {
    const entries = callQueues.get(name)
    const queued = entries !== undefined && entries.length > 0 ? entries.shift() : undefined
    toolCallId = queued ?? (await deriveToolCallId('response', turnIndex, partIndex, name, responseRaw))
  }

  // Content: the response's `content` member when the object carries one,
  // else the whole response value, JSON-stringified (Go map marshal order).
  let payload: unknown = response
  if (isRecord(response) && 'content' in response) payload = response['content']
  const content = serializeOrdered(sortKeysDeep((payload ?? null) as WireValue))

  return { role: 'tool', tool_call_id: toolCallId, content }
}

function queue(callQueues: Map<string, string[]>, name: string): string[] {
  let entries = callQueues.get(name)
  if (entries === undefined) {
    entries = []
    callQueues.set(name, entries)
  }
  return entries
}

/** Removes the first occurrence of an explicit response id from the name queue. */
function removeQueued(callQueues: Map<string, string[]>, name: string, id: string): void {
  const entries = callQueues.get(name)
  if (entries === undefined) return
  const index = entries.indexOf(id)
  if (index >= 0) entries.splice(index, 1)
}

// ---------------------------------------------------------------------------
// Media parts
// ---------------------------------------------------------------------------

/**
 * Normalizes an inline-data mime before classification: media families and
 * recognized document types (pdf/txt/csv/json/xml) pass through; empty or
 * unrecognized mimes become `application/octet-stream` and land in the
 * file branch with the bare `document` filename.
 */
function normalizedMime(mime: string): string {
  const lower = mime.toLowerCase()
  if (lower.startsWith('image/') || lower.startsWith('audio/') || lower.startsWith('video/')) {
    return mime
  }
  for (const hint of ['pdf', 'txt', 'csv', 'json', 'xml'] as const) {
    if (lower.includes(hint)) return mime
  }
  return 'application/octet-stream'
}

function inlineDataPart(inline: Record<string, unknown>): WireObject | undefined {
  const data = readString(inline, 'data')
  if (data === undefined || data.length === 0) return undefined
  const mime = normalizedMime(readString(inline, 'mimeType') ?? readString(inline, 'mime_type') ?? '')
  const lower = mime.toLowerCase()
  if (lower.startsWith('image/')) {
    return { type: 'image_url', image_url: { url: `data:${mime};base64,${data}` } }
  }
  if (lower.startsWith('audio/')) {
    return { type: 'input_audio', input_audio: { data, format: audioFormat(lower) } }
  }
  if (lower.startsWith('video/')) {
    return { type: 'video_url', video_url: { url: `data:${mime};base64,${data}` } }
  }
  return { type: 'file', file: { filename: fileFilename(lower), file_data: data } }
}

function audioFormat(mime: string): string {
  const subtype = mime.slice('audio/'.length)
  switch (subtype) {
    case 'wav':
    case 'wave':
    case 'x-wav':
      return 'wav'
    case 'flac':
      return 'flac'
    case 'opus':
    case 'ogg':
      return 'opus'
    case 'pcm':
    case 'l16':
      return 'pcm16'
    default:
      return 'mp3'
  }
}

/** Filename derived from the (normalized) mime for file parts. */
function fileFilename(mime: string): string {
  if (mime.includes('pdf')) return 'document.pdf'
  if (mime.includes('txt')) return 'document.txt'
  if (mime.includes('csv')) return 'document.csv'
  if (mime.includes('json')) return 'document.json'
  if (mime.includes('xml')) return 'document.xml'
  if (mime.includes('video')) return 'video'
  return 'document'
}

function fileDataRendered(file: Record<string, unknown>): RenderedPart | undefined {
  const uri = readString(file, 'fileUri') ?? readString(file, 'file_uri')
  if (uri === undefined || uri.length === 0) return undefined
  const mime = readString(file, 'mimeType') ?? readString(file, 'mime_type') ?? ''
  const lower = mime.toLowerCase()
  if (lower.startsWith('image/')) {
    return { kind: 'media', value: { type: 'image_url', image_url: { url: uri } } }
  }
  if (lower.startsWith('video/')) {
    return { kind: 'media', value: { type: 'video_url', video_url: { url: uri } } }
  }
  if (lower.startsWith('application/') || lower.startsWith('text/')) {
    return { kind: 'media', value: { type: 'file', file: { filename: fileFilename(lower), file_url: uri } } }
  }
  const suffix = mime.length > 0 ? ` (Type: ${mime})` : ''
  return { kind: 'text', text: `File: ${uri}${suffix}` }
}

// ---------------------------------------------------------------------------
// tools / toolConfig
// ---------------------------------------------------------------------------

function translateTools(tools: readonly unknown[]): WireObject[] {
  const out: WireObject[] = []
  for (const entry of tools) {
    if (!isRecord(entry)) continue
    const declarations = readArray(entry, 'functionDeclarations')
    if (declarations === undefined) continue
    for (const declaration of declarations) {
      if (!isRecord(declaration)) continue
      const parameters = readObject(declaration, 'parameters') ?? readObject(declaration, 'parametersJsonSchema')
      const function_: WireObject = {
        name: readString(declaration, 'name') ?? '',
        description: readString(declaration, 'description') ?? '',
      }
      if (parameters !== undefined) function_['parameters'] = parameters as unknown as WireValue
      out.push({ type: 'function', function: function_ })
    }
  }
  return out
}

function translateToolChoice(toolConfig: unknown): WireValue | undefined {
  const config = readObject(toolConfig, 'functionCallingConfig')
  if (config === undefined) return undefined
  const mode = readString(config, 'mode')
  if (mode === 'NONE') return 'none'
  if (mode === 'AUTO') return 'auto'
  if (mode === 'ANY') {
    const allowed = readArray(config, 'allowedFunctionNames')
    const names = allowed !== undefined ? allowed.filter((entry): entry is string => typeof entry === 'string') : []
    if (names.length === 1) return { type: 'function', function: { name: names[0] ?? '' } }
    return 'required'
  }
  return undefined
}

// ---------------------------------------------------------------------------
// system instruction
// ---------------------------------------------------------------------------

function systemParts(parts: unknown): WireObject[] {
  const out: WireObject[] = []
  if (!Array.isArray(parts)) return out
  for (const part of parts) {
    if (!isRecord(part)) continue
    if (part['thought'] === true) continue

    const text = readString(part, 'text')
    if (text !== undefined) {
      out.push({ type: 'text', text })
      continue
    }
    const inline = readObject(part, 'inlineData') ?? readObject(part, 'inline_data')
    if (inline !== undefined) {
      const value = inlineDataPart(inline)
      if (value !== undefined) out.push(value)
      continue
    }
    const file = readObject(part, 'fileData') ?? readObject(part, 'file_data')
    if (file !== undefined) {
      const rendered = fileDataRendered(file)
      if (rendered !== undefined) out.push(rendered.kind === 'text' ? { type: 'text', text: rendered.text } : rendered.value)
    }
  }
  return out
}
