/**
 * Request translation: OpenAI Chat Completions -> Gemini GenerateContent
 * (spec sections 3.1, 3.2).
 *
 * The pipeline reproduces the recorded stages in order:
 *
 * 1. the translator stage - messages become `systemInstruction` +
 *    `contents` (leading-system collection, per-message part order, the
 *    synthetic functionResponse user turn, trailing-model drop), `tools`
 *    become ONE functionDeclarations node plus the googleSearch /
 *    codeExecution / urlContext nodes, sampling knobs overlay a verbatim
 *    client `generationConfig`, `reasoning_effort` becomes a
 *    thinkingConfig;
 * 2. the executor thinking pass - for config-declared thinking-less
 *    models the thinkingConfig is deleted (leaving `generationConfig`
 *    possibly `{}`, fixture C07) and a model-name thinking suffix never
 *    reaches the wire (fixture C08); an entry that declares `levels`
 *    keeps the thinking intent (config-dependent, not golden-covered);
 * 3. the boundary-turn pass - an empty user turn is prepended when the
 *    conversation opens with a model content and appended when it ends
 *    with a model content that carries no functionResponse part;
 * 4. the safetySettings injection - the five-category block is always the
 *    last top-level member.
 *
 * `tool_choice`, `stop` and the legacy `functions`/`function_call` fields
 * are intentionally dropped in this direction (spec 7.1).
 */
import { parseStrictJson, readArray, readObject, readString, rawValueAt, serializeOrdered } from './json'
import { deleteRawMember, isPlainObject, RawJson, setRawMember } from './json'
import type { WireObject, WireValue } from './json'
import { buildGeminiTools } from './schema'
import { sanitizeFunctionName } from './schema'
import type { ChatToGeminiContext, DataUrlParts, GeminiUpstreamRequest } from './types'

/** Literal thought-signature sentinel the gateway injects (fixtures C03/C10). */
export const SKIP_THOUGHT_SIGNATURE = 'skip_thought_signature_validator'

/** The always-injected safetySettings block (recorded bytes, C01). */
export const SAFETY_SETTINGS: readonly WireObject[] = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'BLOCK_NONE' },
]

/** Parsed `alias(<suffix>)` model suffix. */
export interface ModelSuffix {
  readonly base: string
  readonly suffix: string
}

/**
 * Parses a `name(<suffix>)` model suffix. The suffix carries thinking
 * intent (fixture C08: `mock-gemini-think(high)`); the base is trimmed.
 */
export function parseModelSuffix(name: string): ModelSuffix | undefined {
  const match = /^(.*)\(([^()]*)\)$/.exec(name)
  if (match === null) return undefined
  return { base: (match[1] ?? '').trim(), suffix: match[2] ?? '' }
}

/** Base model name of a possibly suffixed upstream/alias name. */
export function stripModelSuffix(name: string): string {
  const parsed = parseModelSuffix(name)
  return parsed !== undefined ? parsed.base : name
}

// ---------------------------------------------------------------------------
// Data-URL + media helpers
// ---------------------------------------------------------------------------

/** Splits a `data:<meta>,<payload>` URL; `base64` markers are not special. */
export function parseDataUrl(url: string): DataUrlParts | undefined {
  if (!url.startsWith('data:')) return undefined
  const comma = url.indexOf(',')
  if (comma < 0) return undefined
  const meta = url.slice(5, comma)
  const data = url.slice(comma + 1)
  const base = meta.endsWith(';base64') ? meta.slice(0, -7) : meta
  return { mediaType: base.length > 0 ? base : 'application/octet-stream', data }
}

/** Recorded mime map of `input_audio.format` (spec 3.1.1). */
const AUDIO_FORMAT_MIME: Readonly<Record<string, string>> = Object.freeze({
  '': 'audio/wav',
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  aac: 'audio/aac',
  webm: 'audio/webm',
  pcm16: 'audio/pcm',
  g711_ulaw: 'audio/basic',
  g711_alaw: 'audio/basic',
})

/** Extension-derived mime table for `file.filename` parts. */
const EXTENSION_MIME: Readonly<Record<string, string>> = Object.freeze({
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  aac: 'audio/aac',
  webm: 'video/webm',
  mp4: 'video/mp4',
  mpeg: 'video/mpeg',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
})

function mimeForFilename(filename: string): string {
  const dot = filename.lastIndexOf('.')
  const extension = dot >= 0 ? filename.slice(dot + 1).toLowerCase() : ''
  return EXTENSION_MIME[extension] ?? 'application/octet-stream'
}

// ---------------------------------------------------------------------------
// Message translation
// ---------------------------------------------------------------------------

/** One translated content node. */
interface ContentNode {
  readonly role: 'user' | 'model'
  readonly parts: WireValue[]
}

/** Texts a system/developer message contributes (string or array form). */
function systemTexts(content: unknown): string[] {
  if (typeof content === 'string') return [content]
  if (!Array.isArray(content)) return []
  const out: string[] = []
  for (const part of content) {
    if (typeof part !== 'object' || part === null) continue
    const record = part as Record<string, unknown>
    if (record['type'] !== 'text') continue
    const text = record['text']
    if (typeof text === 'string' && text.length > 0) out.push(text)
  }
  return out
}

/** User/assistant content -> parts (unknown part types are dropped). */
function contentParts(content: unknown, role: 'user' | 'model'): WireValue[] {
  const out: WireValue[] = []
  if (typeof content === 'string') {
    out.push({ text: content })
    return out
  }
  if (!Array.isArray(content)) return out
  for (const part of content) {
    if (typeof part !== 'object' || part === null) continue
    const record = part as Record<string, unknown>
    const type = record['type']
    if (type === 'text') {
      const text = record['text']
      if (typeof text === 'string' && text.length > 0) out.push({ text })
      continue
    }
    if (role === 'user') {
      const converted = userMediaPart(record)
      if (converted !== undefined) out.push(converted)
      continue
    }
    if (type === 'image_url') {
      const converted = assistantImagePart(record)
      if (converted !== undefined) out.push(converted)
    }
  }
  return out
}

/** One user media part (image_url / video_url / file / input_audio). */
function userMediaPart(record: Record<string, unknown>): WireValue | undefined {
  const type = record['type']
  if (type === 'image_url') {
    const image = readObject(record, 'image_url')
    const url = image !== undefined ? readString(image, 'url') : undefined
    if (url === undefined) return undefined
    const parsed = parseDataUrl(url)
    if (parsed === undefined) return undefined
    // The literal sentinel rides on user image parts (fixture C10).
    return {
      inlineData: { mime_type: parsed.mediaType, data: parsed.data },
      thoughtSignature: SKIP_THOUGHT_SIGNATURE,
    }
  }
  if (type === 'video_url') {
    const video = readObject(record, 'video_url')
    const url = video !== undefined ? readString(video, 'url') : undefined
    if (url === undefined) return undefined
    const parsed = parseDataUrl(url)
    if (parsed === undefined) return undefined
    return { inlineData: { mime_type: parsed.mediaType, data: parsed.data } }
  }
  if (type === 'file') {
    const file = readObject(record, 'file')
    if (file === undefined) return undefined
    const filename = readString(file, 'filename')
    const fileData = readString(file, 'file_data')
    if (filename === undefined || fileData === undefined) return undefined
    const parsed = parseDataUrl(fileData)
    if (parsed === undefined) return undefined
    return { inlineData: { mime_type: mimeForFilename(filename), data: parsed.data } }
  }
  if (type === 'input_audio') {
    const audio = readObject(record, 'input_audio')
    if (audio === undefined) return undefined
    const data = readString(audio, 'data')
    const format = readString(audio, 'format') ?? ''
    if (data === undefined) return undefined
    const mime = AUDIO_FORMAT_MIME[format.trim().toLowerCase()] ?? `audio/${format}`
    return { inlineData: { mime_type: mime, data } }
  }
  return undefined
}

/** Assistant image parts: inlineData without the user-side sentinel. */
function assistantImagePart(record: Record<string, unknown>): WireValue | undefined {
  const image = readObject(record, 'image_url')
  const url = image !== undefined ? readString(image, 'url') : undefined
  if (url === undefined) return undefined
  const parsed = parseDataUrl(url)
  if (parsed === undefined) return undefined
  return { inlineData: { mime_type: parsed.mediaType, data: parsed.data } }
}

/** Thought-signature lookup chain of an assistant tool_call (spec 3.1.1). */
function toolCallSignature(call: Record<string, unknown>): string {
  const fn = readObject(call, 'function')
  const nested = readObject(readObject(call, 'extra_content'), 'google')
  const fnNested = fn !== undefined ? readObject(readObject(fn, 'extra_content'), 'google') : undefined
  for (const source of [nested, fnNested]) {
    if (source !== undefined) {
      const value = readString(source, 'thought_signature')
      if (value !== undefined) return value
    }
  }
  for (const key of ['thoughtSignature', 'thought_signature']) {
    const value = readString(call, key)
    if (value !== undefined) return value
  }
  return SKIP_THOUGHT_SIGNATURE
}

/** Content of one tool message, with its message index for raw splicing. */
interface ToolResult {
  readonly content: unknown
  readonly messageIndex: number
}

/** Tool message contents, first occurrence per tool_call_id. */
function collectToolResults(messages: readonly unknown[]): Map<string, ToolResult> {
  const results = new Map<string, ToolResult>()
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    if (typeof message !== 'object' || message === null) continue
    const record = message as Record<string, unknown>
    if (record['role'] !== 'tool') continue
    const id = readString(record, 'tool_call_id')
    if (id === undefined || id.length === 0) continue
    if (!results.has(id)) results.set(id, { content: record['content'], messageIndex: index })
  }
  return results
}

/**
 * Tool message content -> raw `response.result` text: a string content is
 * embedded as a JSON string built from the member's RAW bytes (quotes
 * and escapes included - fixture C03 pins the resulting double encoding);
 * object/array content splices the CLIENT's raw member bytes; anything
 * else (or a missing tool message) falls back to the recorded `{}`
 * default (spec 3.1.1).
 */
function toolResultText(result: ToolResult | undefined, rawBody: string): string {
  if (result === undefined) return '{}'
  const raw = rawValueAt(rawBody, ['messages', String(result.messageIndex), 'content'])
  if (raw === undefined) return '{}'
  if (typeof result.content === 'string') return serializeOrdered(raw)
  if (isPlainObject(result.content) || Array.isArray(result.content)) return raw
  return '{}'
}

/**
 * Builds the translated Gemini body (serialized + parsed). Throws
 * `invalid-input` for malformed JSON (NE-LENIENT); a valid JSON document
 * that is not an object translates as an empty request.
 */
export function translateChatToGemini(rawBody: string, ctx: ChatToGeminiContext): GeminiUpstreamRequest {
  const parsed = parseStrictJson(rawBody)
  const request: Record<string, unknown> = isPlainObject(parsed) ? parsed : {}
  const messages = readArray(request, 'messages') ?? []
  const toolResults = collectToolResults(messages)

  const contents: ContentNode[] = []
  const systemTextsBuffer: string[] = []
  let conversationStarted = false

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    if (typeof message !== 'object' || message === null) continue
    const record = message as Record<string, unknown>
    const role = record['role']

    if (role === 'system' || role === 'developer') {
      if (!conversationStarted) {
        systemTextsBuffer.push(...systemTexts(record['content']))
        continue
      }
      // A system message after the conversation start becomes user text.
      const texts = systemTexts(record['content'])
      if (texts.length > 0) contents.push({ role: 'user', parts: texts.map((text) => ({ text })) })
      continue
    }

    conversationStarted = true
    if (role === 'tool') continue // consumed via the synthetic turn only

    if (role === 'assistant') {
      const parts: WireValue[] = []
      const reasoning = readString(record, 'reasoning_content')
      if (reasoning !== undefined && reasoning.length > 0) {
        parts.push({ text: reasoning, thought: true, thoughtSignature: SKIP_THOUGHT_SIGNATURE })
      }
      parts.push(...contentParts(record['content'], 'model'))
      const responses: WireValue[] = []
      const toolCalls = readArray(record, 'tool_calls') ?? []
      for (const call of toolCalls) {
        if (typeof call !== 'object' || call === null) continue
        const callRecord = call as Record<string, unknown>
        if (callRecord['type'] !== 'function') continue
        const fn = readObject(callRecord, 'function')
        const rawName = fn !== undefined ? readString(fn, 'name') : undefined
        const name = rawName !== undefined ? sanitizeFunctionName(rawName) : ''
        if (name.length === 0) continue
        const argumentsText = fn !== undefined ? readString(fn, 'arguments') : undefined
        const args: WireValue =
          argumentsText !== undefined && argumentsText.trim().length > 0
            ? (new RawJson(argumentsText) as unknown as WireValue)
            : {}
        parts.push({ functionCall: { name, args }, thoughtSignature: toolCallSignature(callRecord) })
        const id = readString(callRecord, 'id')
        if (id !== undefined && id.length > 0 && rawName !== undefined && rawName.length > 0) {
          responses.push({
            functionResponse: {
              name,
              response: { result: new RawJson(toolResultText(toolResults.get(id), rawBody)) as unknown as WireValue },
            },
          })
        }
      }
      if (parts.length > 0) contents.push({ role: 'model', parts })
      if (responses.length > 0) contents.push({ role: 'user', parts: responses })
      continue
    }

    if (role === 'user') {
      const parts = contentParts(record['content'], 'user')
      if (parts.length > 0) contents.push({ role: 'user', parts })
      continue
    }
    // Unknown roles are dropped (never forwarded).
  }

  // A lone system/developer message (len == 1) becomes a normal user
  // content instead of a systemInstruction (spec 3.1.1).
  if (systemTextsBuffer.length > 0 && messages.length === 1) {
    contents.push({ role: 'user', parts: systemTextsBuffer.map((text) => ({ text })) })
    systemTextsBuffer.length = 0
  }

  // Trailing model content is dropped (only the last one).
  const last = contents[contents.length - 1]
  if (last !== undefined && last.role === 'model') contents.pop()

  // Executor boundary turns (spec 3.2 step 8): an empty user turn wraps a
  // conversation that opens with a model content, and one that ends with a
  // model content carrying no functionResponse part.
  const emptyUserTurn = (): ContentNode => ({ role: 'user', parts: [{ text: '' }] })
  const first = contents[0]
  if (first !== undefined && first.role === 'model') contents.unshift(emptyUserTurn())
  const tail = contents[contents.length - 1]
  if (tail !== undefined && tail.role === 'model' && !tail.parts.some((part) => isFunctionResponse(part))) {
    contents.push(emptyUserTurn())
  }

  const body: WireObject = {
    contents: contents.map((node) => ({ role: node.role, parts: node.parts })),
    model: ctx.upstreamModel,
  }

  const generationConfig = buildGenerationConfig(request, rawBody, ctx)
  if (generationConfig !== undefined) body['generationConfig'] = new RawJson(generationConfig) as unknown as WireValue
  if (systemTextsBuffer.length > 0) {
    body['systemInstruction'] = { role: 'user', parts: systemTextsBuffer.map((text) => ({ text })) }
  }
  const tools = buildGeminiTools(readArray(request, 'tools') ?? [], rawBody)
  if (tools !== undefined) body['tools'] = tools
  body['safetySettings'] = [...SAFETY_SETTINGS]

  return { body: serializeOrdered(body), value: body }
}

/** True when a part is a functionResponse payload. */
function isFunctionResponse(part: WireValue): boolean {
  return typeof part === 'object' && part !== null && !Array.isArray(part) && 'functionResponse' in part
}

// ---------------------------------------------------------------------------
// generationConfig overlay (verbatim client object + mapped knobs)
// ---------------------------------------------------------------------------

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Builds the raw `generationConfig` text. The client's own
 * `generationConfig` object is copied verbatim first; mapped knobs then
 * overwrite members in place (existing keys keep their byte position) and
 * new keys append in the spec's mapping order. Gateway-written values are
 * compact. The thinking capability pass runs last: a thinking-less model
 * loses its thinkingConfig (C07) and a suffix intent never lands (C08).
 */
function buildGenerationConfig(
  request: Record<string, unknown>,
  rawBody: string,
  ctx: ChatToGeminiContext,
): string | undefined {
  const clientConfig = readObject(request, 'generationConfig')
  const text = clientConfig !== undefined ? rawValueAt(rawBody, ['generationConfig']) : undefined

  const sets: Array<[string, string]> = []
  const temperature = readFiniteNumber(request['temperature'])
  if (temperature !== undefined) sets.push(['temperature', serializeOrdered(temperature)])
  const topP = readFiniteNumber(request['top_p'])
  if (topP !== undefined) sets.push(['topP', serializeOrdered(topP)])
  const topK = readFiniteNumber(request['top_k'])
  if (topK !== undefined) sets.push(['topK', serializeOrdered(topK)])
  const maxTokens = readFiniteNumber(request['max_tokens']) ?? readFiniteNumber(request['max_completion_tokens'])
  if (maxTokens !== undefined) sets.push(['maxOutputTokens', serializeOrdered(maxTokens)])
  const n = readFiniteNumber(request['n'])
  if (n !== undefined && n > 1) sets.push(['candidateCount', serializeOrdered(n)])

  const responseFormat = readObject(request, 'response_format')
  if (responseFormat !== undefined) {
    const type = responseFormat['type']
    if (type === 'json_object' || type === 'json_schema') {
      sets.push(['responseMimeType', serializeOrdered('application/json')])
      if (type === 'json_schema') {
        const schemaRaw = rawValueAt(rawBody, ['response_format', 'json_schema', 'schema'])
        if (schemaRaw !== undefined) sets.push(['responseJsonSchema', schemaRaw])
      }
    }
  }

  const modalities = readArray(request, 'modalities')
  if (modalities !== undefined) {
    const mapped: string[] = []
    for (const item of modalities) {
      if (typeof item !== 'string') continue
      const lower = item.toLowerCase()
      if (lower === 'text') mapped.push('TEXT')
      else if (lower === 'image') mapped.push('IMAGE')
    }
    if (mapped.length > 0) sets.push(['responseModalities', serializeOrdered(mapped)])
  }

  const imageConfig = readObject(request, 'image_config')
  if (imageConfig !== undefined) {
    const aspectRatio = readString(imageConfig, 'aspect_ratio')
    const imageSize = readString(imageConfig, 'image_size')
    if (aspectRatio !== undefined || imageSize !== undefined) {
      const config: WireObject = {}
      if (aspectRatio !== undefined) config['aspectRatio'] = aspectRatio
      if (imageSize !== undefined) config['imageSize'] = imageSize
      sets.push(['imageConfig', serializeOrdered(config)])
    }
  }

  const effort = readString(request, 'reasoning_effort')
  const level = effort !== undefined ? effort.trim().toLowerCase() : ''
  if (level.length > 0) {
    sets.push([
      'thinkingConfig',
      level === 'auto' ? '{"thinkingBudget":-1}' : serializeOrdered({ thinkingLevel: level }),
    ])
  }

  const hasCapability = ctx.thinking !== undefined && ctx.thinking.levels.length > 0
  if (hasCapability && level.length === 0 && ctx.suffixLevel !== undefined && ctx.suffixLevel.length > 0) {
    sets.push(['thinkingConfig', serializeOrdered({ thinkingLevel: ctx.suffixLevel })])
  }

  if (sets.length === 0 && text === undefined) return undefined
  let out = text ?? '{}'
  for (const [key, value] of sets) out = setRawMember(out, key, value)
  if (!hasCapability) {
    // Capability pass (spec 3.2 step 2): thinking-less config-declared
    // models lose the thinkingConfig member; the (possibly empty)
    // generationConfig object stays (fixture C07).
    out = deleteRawMember(out, 'thinkingConfig')
  }
  return out
}
