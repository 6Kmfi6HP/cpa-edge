/**
 * Token counting for the `:countTokens` surface (S2d7 2.5).
 *
 * Non-Anthropic base URLs never receive an upstream call: the gateway
 * counts locally with the O200k tokenizer (SPEC ruling R-TOK) over the
 * translated Claude body's segments and answers with a Gemini-shaped
 * body. Before counting, the translated request passes the shared
 * Claude token-count validator whose seven strings are public-interface
 * bytes.
 */
import { getEncoding } from 'js-tiktoken'
import { isPlainObject, serializeOrdered } from './json'
import type { WireObject, WireValue } from './types'
import type { ClaudeContentAssembly } from './types'

// ---------------------------------------------------------------------------
// Validator (shared Claude token-count request contract)
// ---------------------------------------------------------------------------

export const TOKEN_COUNT_INVALID_JSON = 'invalid Claude token count request JSON'
export const TOKEN_COUNT_NOT_OBJECT = 'Claude token count request must be a JSON object'
export const TOKEN_COUNT_MESSAGES_EMPTY = 'Claude token count request messages must be a non-empty array'
export const TOKEN_COUNT_MESSAGES_OBJECTS = 'Claude token count request messages must contain objects'
export const TOKEN_COUNT_ROLE = 'Claude token count request message role must be user or assistant'
export const TOKEN_COUNT_CONTENT = 'Claude token count request message content must be a string or array'
export const TOKEN_COUNT_BLOCKS = 'Claude token count request content blocks must be typed objects'

export type TokenCountValidation =
  | { readonly ok: true; readonly request: Record<string, unknown> }
  | { readonly ok: false; readonly message: string }

/**
 * Validates a serialized Claude token-count request. The check order is
 * contract: parse, root object, non-empty `messages` array, then per
 * message (in order) object-ness, role, content shape, and typed blocks.
 */
export function validateClaudeTokenCountRequest(text: string): TokenCountValidation {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, message: TOKEN_COUNT_INVALID_JSON }
  }
  if (!isPlainObject(parsed)) return { ok: false, message: TOKEN_COUNT_NOT_OBJECT }
  const request = parsed as Record<string, unknown>
  const messages = request['messages']
  if (!Array.isArray(messages) || messages.length === 0) {
    return { ok: false, message: TOKEN_COUNT_MESSAGES_EMPTY }
  }
  for (const message of messages) {
    if (!isPlainObject(message)) return { ok: false, message: TOKEN_COUNT_MESSAGES_OBJECTS }
    const role = message['role']
    if (role !== 'user' && role !== 'assistant') return { ok: false, message: TOKEN_COUNT_ROLE }
    const content = message['content']
    if (typeof content !== 'string' && !Array.isArray(content)) {
      return { ok: false, message: TOKEN_COUNT_CONTENT }
    }
    if (typeof content === 'string') continue
    for (const block of content) {
      if (!isPlainObject(block) || typeof block['type'] !== 'string') {
        return { ok: false, message: TOKEN_COUNT_BLOCKS }
      }
    }
  }
  return { ok: true, request }
}

// ---------------------------------------------------------------------------
// Estimation (R-TOK: O200k over the translated body's segments)
// ---------------------------------------------------------------------------

/** Lazily built O200k tokenizer (the rank table is large). */
let tokenizer: ReturnType<typeof getEncoding> | undefined

function o200k(): ReturnType<typeof getEncoding> {
  if (tokenizer === undefined) tokenizer = getEncoding('o200k_base')
  return tokenizer
}

/**
 * Segment list of a translated Claude body: system text blocks, then per
 * message the role plus every content field (text, tool ids, names and
 * inputs), then the tool names, then the tool_choice. Segments join with
 * `\n` before counting (recorded oracle: ["user","Say hello"] -> 4).
 */
export function claudeInputSegments(assembly: ClaudeContentAssembly): readonly string[] {
  const segments: string[] = []
  for (const message of assembly.messages) {
    segments.push(message.role)
    for (const block of message.content) {
      appendBlockSegments(segments, block)
    }
  }
  for (const tool of assembly.tools) {
    const name = tool['name']
    if (typeof name === 'string') segments.push(name)
  }
  if (assembly.toolChoice !== undefined) segments.push(serializeOrdered(assembly.toolChoice))
  return segments
}

function appendBlockSegments(segments: string[], block: Readonly<WireObject>): void {
  const type = block['type']
  if (type === 'text') {
    const text = block['text']
    if (typeof text === 'string') segments.push(text)
    return
  }
  if (type === 'tool_use') {
    const id = block['id']
    if (typeof id === 'string') segments.push(id)
    const name = block['name']
    if (typeof name === 'string') segments.push(name)
    segments.push(serializeOrdered((block['input'] as WireValue) ?? {}))
    return
  }
  if (type === 'tool_result') {
    const id = block['tool_use_id']
    if (typeof id === 'string') segments.push(id)
    const content = block['content']
    if (typeof content === 'string') segments.push(content)
    else if (content !== undefined) segments.push(serializeOrdered(content as WireValue))
  }
}

/** O200k token count of the joined segments. */
export function countSegments(segments: readonly string[]): number {
  return o200k().encode(segments.join('\n')).length
}

/**
 * Local token estimate over one translated content assembly (R-TOK). The
 * number is byte-exact contract material - never masked.
 */
export function estimateClaudeInputTokens(assembly: ClaudeContentAssembly): number {
  return countSegments(claudeInputSegments(assembly))
}

/** Serializes the translated content into the validated token-count request. */
export function serializeTokenCountRequest(assembly: ClaudeContentAssembly): string {
  const request: WireObject = {
    messages: assembly.messages.map((message) => ({ role: message.role, content: message.content })),
  }
  if (assembly.tools.length > 0) request['tools'] = assembly.tools
  if (assembly.toolChoice !== undefined) request['tool_choice'] = assembly.toolChoice
  return serializeOrdered(request)
}

/** Gemini-shaped countTokens body: totalTokens plus the TEXT modality detail. */
export function geminiTokenCountBody(totalTokens: number): string {
  return serializeOrdered({
    totalTokens,
    promptTokensDetails: [{ modality: 'TEXT', tokenCount: totalTokens }],
  })
}
