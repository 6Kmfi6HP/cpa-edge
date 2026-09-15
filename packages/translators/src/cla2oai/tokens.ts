/**
 * Token estimation for the cla2oai direction (rulings R-TOK; S2d4
 * sections 3.6 and 4.3).
 *
 * Two collectors, both deterministic and byte-exact contract material:
 *
 * - the `message_start` estimate (4.3): `o200k_base` over the ORIGINAL
 *   client request. The segment collector is NORMATIVE: it walks the
 *   client body independently of the request translation, so part types
 *   the translator DROPS still count (search/web/code-execution result
 *   families, tool references, generic `text` fields), while
 *   image/audio/video/redacted_thinking blocks contribute nothing
 *   (recorded values: 3 / 33 / 7 / 6);
 * - `count_tokens` (3.6): the request is translated with the same
 *   translator (stream forced to `false`), then counted LOCALLY over the
 *   translated body - per message the role, name, content pieces and
 *   tool_calls; per tools/functions entry the type, name, description
 *   and parameters; plus tool_choice, response_format, input and prompt
 *   - with the upstream model's encoding (unrecognized models like
 *   `mock-gpt-model` count with `o200k_base`; recorded value: 43). No
 *   upstream request is ever made.
 */
import { getEncoding } from 'js-tiktoken'
import { isPlainObject, rawValueAt, readObject, serializeOrdered } from './json'
import type { WireObject, WireValue } from './json'

// A memoized, read-only handle per encoding: constructing a tiktoken
// walks a multi-megabyte rank table, and the tokenizer is stateless.
type Tiktoken = ReturnType<typeof getEncoding>
const encodings = new Map<string, Tiktoken>()

function tokenizer(encoding: 'o200k_base' | 'cl100k_base'): Tiktoken {
  let cached = encodings.get(encoding)
  if (cached === undefined) {
    cached = getEncoding(encoding)
    cached = encodings.set(encoding, cached).get(encoding) as Tiktoken
  }
  return cached
}

// ---------------------------------------------------------------------------
// message_start estimate (section 4.3)
// ---------------------------------------------------------------------------

/** Pushes one segment when it is a non-empty string after trimming. */
function push(segments: string[], value: unknown): void {
  if (typeof value !== 'string') return
  const trimmed = value.trim()
  if (trimmed.length > 0) segments.push(trimmed)
}

/** Pushes a value as compacted JSON (objects and arrays the table names). */
function pushJson(segments: string[], value: unknown): void {
  if (value === undefined) return
  if (typeof value === 'string') {
    push(segments, value)
    return
  }
  push(segments, serializeOrdered(value as WireValue))
}

/** Collects the content pieces of one block per the block-type table. */
function blockSegments(segments: string[], block: Record<string, unknown>): void {
  const type = block['type']
  switch (type) {
    case 'text':
      push(segments, block['text'])
      return
    case 'thinking':
      push(segments, block['thinking'])
      return
    case 'document': {
      push(segments, block['title'])
      push(segments, block['context'])
      const source = block['source']
      if (isPlainObject(source)) {
        push(segments, source['data'])
        push(segments, source['content'])
      }
      return
    }
    case 'tool_use':
    case 'server_tool_use':
    case 'mcp_tool_use':
      push(segments, block['id'])
      push(segments, block['name'])
      pushJson(segments, block['input'])
      return
    case 'tool_result':
    case 'mcp_tool_result':
    case 'web_search_tool_result':
    case 'web_fetch_tool_result':
    case 'code_execution_tool_result':
    case 'bash_code_execution_tool_result':
    case 'text_editor_code_execution_tool_result':
      push(segments, block['tool_use_id'])
      push(segments, block['tool_call_id'])
      contentSegments(segments, block['content'])
      return
    case 'web_search_result':
    case 'search_result':
      push(segments, block['source'])
      push(segments, block['title'])
      push(segments, block['url'])
      push(segments, block['page_age'])
      contentSegments(segments, block['content'])
      return
    case 'web_fetch_result':
      push(segments, block['url'])
      push(segments, block['retrieved_at'])
      contentSegments(segments, block['content'])
      return
    case 'code_execution_result':
    case 'bash_code_execution_result':
    case 'text_editor_code_execution_result':
      push(segments, block['stdout'])
      push(segments, block['stderr'])
      push(segments, block['return_code'])
      contentSegments(segments, block['content'])
      contentSegments(segments, block['output'])
      return
    case 'tool_reference':
      push(segments, block['tool_name'])
      return
    case 'image':
    case 'input_audio':
    case 'audio':
    case 'video':
    case 'redacted_thinking':
      return
    default:
      if (type === undefined) {
        pushJson(segments, block)
        return
      }
      push(segments, block['text'])
  }
}

/** Walks a message `content` value: strings verbatim, arrays per block. */
function contentSegments(segments: string[], content: unknown): void {
  if (typeof content === 'string') {
    push(segments, content)
    return
  }
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (!isPlainObject(block)) continue
    blockSegments(segments, block)
  }
}

/**
 * Segment list of an ORIGINAL client request: system texts, then per
 * message the role plus its content pieces, then per tool the type,
 * name, description and compacted input_schema, then the tool_choice.
 */
export function claudeRequestSegments(request: Record<string, unknown>): readonly string[] {
  const segments: string[] = []
  const system = request['system']
  if (typeof system === 'string') {
    push(segments, system)
  } else if (Array.isArray(system)) {
    for (const block of system) {
      if (!isPlainObject(block) || block['type'] !== 'text') continue
      push(segments, block['text'])
    }
  }

  const messages = request['messages']
  if (Array.isArray(messages)) {
    for (const message of messages) {
      if (!isPlainObject(message)) continue
      push(segments, message['role'])
      contentSegments(segments, message['content'])
    }
  }

  const tools = request['tools']
  if (Array.isArray(tools)) {
    for (const tool of tools) {
      if (!isPlainObject(tool)) continue
      push(segments, tool['type'])
      push(segments, tool['name'])
      push(segments, tool['description'])
      if (tool['input_schema'] !== undefined) pushJson(segments, tool['input_schema'])
    }
  }

  const choice = request['tool_choice']
  if (isPlainObject(choice)) {
    push(segments, choice['type'])
    push(segments, choice['name'])
  } else if (typeof choice === 'string') {
    push(segments, choice)
  }
  return segments
}

/**
 * Input-token estimate over one client request body (section 4.3):
 * the `o200k_base` count of the trimmed, non-empty segments joined with
 * `\n`. Streamed `message_start` events carry this value byte-exactly.
 */
export function estimateClaudeInputTokens(request: Record<string, unknown>): number {
  const segments = claudeRequestSegments(request)
  return tokenizer('o200k_base').encode(segments.join('\n')).length
}

// ---------------------------------------------------------------------------
// count_tokens over the translated body (section 3.6)
// ---------------------------------------------------------------------------

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function pushString(value: unknown, out: string[]): void {
  if (typeof value === 'string') out.push(value)
}

function pushRaw(value: string | undefined, out: string[]): void {
  if (value !== undefined) out.push(value)
}

/**
 * Walks a translated message content value: strings count as
 * themselves, arrays recurse, text parts contribute their text, image
 * parts their url, audio parts their id ONLY.
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
    pushString(value['id'], out)
  }
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
 * Counts the tokens of a TRANSLATED upstream body for one upstream
 * model (section 3.6). `rawBody` must be the serialized form of `body` -
 * raw segments (parameters, tool_choice, response_format) are sliced out
 * of it so the count sees the same bytes the wire carries.
 */
export function countTranslatedBodyTokens(body: WireObject, rawBody: string, upstreamModel: string): number {
  const segments: string[] = []
  collectBodySegments(body, rawBody, segments)
  const kept = segments.map((segment) => segment.trim()).filter((segment) => segment.length > 0)
  return tokenizer(encodingForUpstreamModel(upstreamModel)).encode(kept.join('\n')).length
}

/** Byte-exact count_tokens response body: `{"input_tokens":N}` only. */
export function renderCountTokensResponse(totalTokens: number): string {
  return serializeOrdered({ input_tokens: totalTokens })
}
