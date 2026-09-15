/**
 * Local token counting for `:countTokens` (S2d2 section 3.4, ruling R-TOK).
 *
 * The count is SYNTHESIZED LOCALLY over the TRANSLATED OpenAI body - no
 * upstream request is ever emitted. Text segments are collected per
 * message (role, name, content parts), per tool call (id, type, function
 * name/description/arguments, raw parameters), per tools[] and functions[]
 * entry, plus tool_choice, response_format, input and prompt; each segment
 * is trimmed, empties drop, the rest join with newlines and the joined
 * string is tokenized with the upstream model's encoding (prefix table;
 * empty model -> cl100k_base, everything unrecognized -> o200k_base).
 */
import { getEncoding } from 'js-tiktoken'
import { rawValueAt, readObject, serializeOrdered } from './json'
import type { WireObject } from './types'

/** Tokenizer handle type without depending on js-tiktoken's type surface. */
type Tiktoken = ReturnType<typeof getEncoding>

/** Model-prefix table -> tiktoken encoding (longest prefixes first). */
const PREFIX_ENCODINGS: ReadonlyArray<readonly [string, 'o200k_base' | 'cl100k_base']> = Object.freeze([
  ['gpt-5', 'o200k_base'],
  ['gpt-4.1', 'o200k_base'],
  ['gpt-4o', 'o200k_base'],
  ['gpt-4', 'cl100k_base'],
  ['gpt-3.5', 'cl100k_base'],
  ['gpt-3', 'cl100k_base'],
  ['o1', 'o200k_base'],
  ['o3', 'o200k_base'],
  ['o4', 'o200k_base'],
])

/** Encoding of an upstream model name: '' -> cl100k_base, else per prefix, default o200k_base. */
export function encodingForUpstreamModel(model: string): 'o200k_base' | 'cl100k_base' {
  if (model === '') return 'cl100k_base'
  const lower = model.toLowerCase()
  for (const [prefix, encoding] of PREFIX_ENCODINGS) {
    if (lower.startsWith(prefix)) return encoding
  }
  return 'o200k_base'
}

// A memoized, read-only handle per encoding: constructing a tiktoken walks
// a multi-megabyte rank table, and the tokenizer itself is stateless.
const encodings = new Map<string, Tiktoken>()

function tokenizer(encoding: 'o200k_base' | 'cl100k_base'): Tiktoken {
  let cached = encodings.get(encoding)
  if (cached === undefined) {
    cached = getEncoding(encoding)
    encodings.set(encoding, cached)
  }
  return cached
}

/** Byte-exact countTokens response body. */
export function renderCountTokensResponse(totalTokens: number): string {
  return serializeOrdered({
    totalTokens,
    promptTokensDetails: [{ modality: 'TEXT', tokenCount: totalTokens }],
  })
}

/**
 * Counts the tokens of a TRANSLATED upstream body for one upstream model.
 * `rawBody` must be the serialized form of `body` - raw segments
 * (parameters, tool_choice, response_format) are sliced out of it so the
 * count sees the same bytes the wire carries.
 */
export function countTranslatedBodyTokens(body: WireObject, rawBody: string, upstreamModel: string): number {
  const segments: string[] = []
  collectBodySegments(body, rawBody, segments)
  const kept = segments.map((segment) => segment.trim()).filter((segment) => segment.length > 0)
  const joined = kept.join('\n')
  return tokenizer(encodingForUpstreamModel(upstreamModel)).encode(joined).length
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function collectBodySegments(body: WireObject, rawBody: string, out: string[]): void {
  const messages = body['messages']
  if (Array.isArray(messages)) {
    for (let index = 0; index < messages.length; index++) {
      const message = messages[index]
      if (!isRecord(message)) continue
      pushString(message['role'], out)
      pushString(message['name'], out)
      collectContent(message['content'], out)
      collectToolCalls(message['tool_calls'], rawBody, ['messages', index, 'tool_calls'], out)
    }
  }
  const tools = body['tools']
  if (Array.isArray(tools)) {
    for (let index = 0; index < tools.length; index++) {
      const entry = tools[index]
      if (!isRecord(entry)) continue
      pushString(entry['type'], out)
      const fn = entry['function']
      if (isRecord(fn)) {
        pushString(fn['name'], out)
        pushString(fn['description'], out)
        pushString(fn['arguments'], out)
        pushRaw(rawValueAt(rawBody, ['tools', index, 'function', 'parameters']), out)
      }
    }
  }
  const functions = body['functions']
  if (Array.isArray(functions)) {
    for (let index = 0; index < functions.length; index++) {
      const entry = functions[index]
      if (!isRecord(entry)) continue
      pushString(entry['name'], out)
      pushString(entry['description'], out)
      pushRaw(rawValueAt(rawBody, ['functions', index, 'parameters']), out)
    }
  }
  const toolChoice = body['tool_choice']
  if (typeof toolChoice === 'string') pushString(toolChoice, out)
  else if (toolChoice !== undefined) pushRaw(rawValueAt(rawBody, ['tool_choice']), out)
  if (body['response_format'] !== undefined) pushRaw(rawValueAt(rawBody, ['response_format']), out)
  const input = body['input']
  if (typeof input === 'string') pushString(input, out)
  else if (input !== undefined) pushRaw(rawValueAt(rawBody, ['input']), out)
  const prompt = body['prompt']
  if (typeof prompt === 'string') pushString(prompt, out)
  else if (prompt !== undefined) pushRaw(rawValueAt(rawBody, ['prompt']), out)
}

/**
 * Walks a message content value: plain strings count as themselves,
 * arrays recurse, text parts contribute their text, image parts their url,
 * audio parts their id ONLY (the audio data is never counted).
 */
function collectContent(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    out.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectContent(entry, out)
    return
  }
  if (!isRecord(value)) return
  const type = value['type']
  if (type === 'text' || type === 'input_text' || type === 'output_text') {
    pushString(value['text'], out)
    return
  }
  if (type === 'image_url') {
    const image = readObject(value, 'image_url')
    if (image !== undefined) pushString(image['url'], out)
    return
  }
  if (type === 'input_audio' || type === 'output_audio' || type === 'audio') {
    // The audio id counts; the data payload does not.
    pushString(value['id'], out)
  }
  // Other part types contribute no segment.
}

function collectToolCalls(
  raw: unknown,
  bodyText: string,
  basePath: readonly (string | number)[],
  out: string[],
): void {
  if (!Array.isArray(raw)) return
  for (let index = 0; index < raw.length; index++) {
    const call = raw[index]
    if (!isRecord(call)) continue
    pushString(call['id'], out)
    pushString(call['type'], out)
    const fn = call['function']
    if (isRecord(fn)) {
      pushString(fn['name'], out)
      pushString(fn['description'], out)
      pushString(fn['arguments'], out)
      pushRaw(rawValueAt(bodyText, [...basePath, index, 'function', 'parameters']), out)
    }
  }
}

function pushString(value: unknown, out: string[]): void {
  if (typeof value === 'string') out.push(value)
}

function pushRaw(value: string | undefined, out: string[]): void {
  if (value !== undefined) out.push(value)
}
