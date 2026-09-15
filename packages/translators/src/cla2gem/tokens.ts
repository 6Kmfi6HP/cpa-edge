/**
 * Input-token estimation for the cla2gem direction (R-TOK, S2d8 3.5.2).
 *
 * `message_start.usage.input_tokens` of a streamed response is rewritten
 * with an `o200k_base` BPE count over the ORIGINAL client request. The
 * segment collector mirrors the reference's block-type table: system
 * texts, per message the role plus every content field the table names,
 * then the tools and the tool_choice. Segments are trimmed, empty pieces
 * drop, and the survivors join with `\n` before counting. The value is
 * byte-exact contract material - never masked (ruling S2d8-1).
 */
import { getEncoding } from 'js-tiktoken'
import { isPlainObject, serializeOrdered } from './json'
import type { WireValue } from './json'

/** Lazily built O200k tokenizer (the rank table is large). */
let tokenizer: ReturnType<typeof getEncoding> | undefined

function o200k(): ReturnType<typeof getEncoding> {
  if (tokenizer === undefined) tokenizer = getEncoding('o200k_base')
  return tokenizer
}

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
  const compact = serializeOrdered(value as WireValue)
  push(segments, compact)
}

/** Reads the `text`/`thinking` value of a block (table: text/thinking rows). */
function textLikeSegments(segments: string[], block: Record<string, unknown>, key: string): void {
  push(segments, block[key])
}

/** Collects the content pieces of one block per the block-type table. */
function blockSegments(segments: string[], block: Record<string, unknown>): void {
  const type = block['type']
  switch (type) {
    case 'text':
      textLikeSegments(segments, block, 'text')
      return
    case 'thinking':
      textLikeSegments(segments, block, 'thinking')
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
 * message the role plus its content pieces, then per tool the type, name,
 * description and compacted input_schema, then the tool_choice type and
 * name. Segments are trimmed; empty pieces drop.
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

/** O200k token count of the joined segments. */
export function countSegments(segments: readonly string[]): number {
  return o200k().encode(segments.join('\n')).length
}

/**
 * Input-token estimate over one client request body (R-TOK). Streamed
 * `message_start` events carry this value byte-exactly (ruling S2d8-1).
 */
export function estimateClaudeInputTokens(request: Record<string, unknown>): number {
  return countSegments(claudeRequestSegments(request))
}
