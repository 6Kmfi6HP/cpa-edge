/**
 * `metadata.user_id` derivation for the Claude upstream (gem2cla direction).
 *
 * The full precedence chain, in order:
 *
 * 1. a pre-existing `metadata.user_id` in the client body (non-blank) -
 *    passed through unhashed;
 * 2. a `user` field (non-blank) - passed through unhashed;
 * 3. `prompt_cache_key` - sha256 over `prompt_cache_key:<value>`;
 * 4. `session_id` / `sessionId` (first non-blank) - sha256 over
 *    `session_id:<value>`;
 * 5. `conversation.id`, a string `conversation`, or `conversation_id` (first
 *    non-blank) - sha256 over `conversation_id:<value>`;
 * 6. the first `contents` entry whose role is `user` or missing - sha256
 *    over `content:` plus its non-thought text parts joined with `\n`;
 * 7. the model seed: `model:<model>` plus `;instructions:` / `;system:` /
 *    `;systemInstruction:` / `;system_instruction:` raw values;
 * 8. the literal `unknown`.
 */
import { rawFieldText, readObject } from './json'

/** The only local hash the direction needs (Web Crypto, runtime-agnostic). */
const encoder = new TextEncoder()

/** sha256 of a UTF-8 string as lowercase hex. */
export async function sha256Hex(seed: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(seed))
  const bytes = new Uint8Array(digest)
  let hex = ''
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
  return hex
}

/** A string with content after trimming; `blank` values never qualify. */
function nonBlank(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

/**
 * Text seed of the first `contents` entry whose role is `user` or missing:
 * the non-thought text parts joined with `\n`. Entries are scanned in
 * order; an entry without text parts does not qualify.
 */
export function firstContentTextSeed(contents: readonly unknown[]): string | undefined {
  for (const entry of contents) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const role = record['role']
    if (role !== undefined && role !== 'user') continue
    const parts: string[] = []
    const rawParts = record['parts']
    if (!Array.isArray(rawParts)) return undefined
    for (const part of rawParts) {
      if (typeof part !== 'object' || part === null) continue
      const partRecord = part as Record<string, unknown>
      if (partRecord['thought'] === true) continue
      const text = partRecord['text']
      if (typeof text === 'string') parts.push(text)
    }
    if (parts.length === 0) return undefined
    return parts.join('\n')
  }
  return undefined
}

export interface DeriveUserIdInput {
  /** Parsed client request body (an object). */
  readonly request: Record<string, unknown>
  /** Raw client request body text (raw seed values keep their spacing). */
  readonly rawBody: string
  /** Provider-resolved upstream model name (model-seed prefix). */
  readonly model: string
}

/** Resolves the `metadata.user_id` value for one request. */
export async function deriveClaudeUserId(input: DeriveUserIdInput): Promise<string> {
  const metadata = readObject(input.request, 'metadata')
  const metadataId = metadata !== undefined ? nonBlank(metadata['user_id']) : undefined
  if (metadataId !== undefined) return metadataId
  const user = nonBlank(input.request['user'])
  if (user !== undefined) return user

  const cacheKey = nonBlank(input.request['prompt_cache_key'])
  if (cacheKey !== undefined) return sha256Hex(`prompt_cache_key:${cacheKey}`)

  for (const key of ['session_id', 'sessionId'] as const) {
    const session = nonBlank(input.request[key])
    if (session !== undefined) return sha256Hex(`session_id:${session}`)
  }

  const conversationId = conversationSeed(input.request)
  if (conversationId !== undefined) return sha256Hex(`conversation_id:${conversationId}`)

  const contents = input.request['contents']
  const contentText = Array.isArray(contents) ? firstContentTextSeed(contents) : undefined
  if (contentText !== undefined && contentText.length > 0) {
    return sha256Hex(`content:${contentText}`)
  }

  if (input.model.length > 0) {
    let seed = `model:${input.model}`
    for (const key of ['instructions', 'system', 'systemInstruction', 'system_instruction'] as const) {
      if (input.request[key] === undefined) continue
      const raw = rawFieldText(input.rawBody, key)
      if (raw !== undefined && raw.length > 0) seed += `;${key}:${raw}`
    }
    return sha256Hex(seed)
  }

  return 'unknown'
}

/**
 * Conversation seed sources in precedence order: `conversation.id`, a
 * string `conversation`, then `conversation_id`.
 */
function conversationSeed(request: Record<string, unknown>): string | undefined {
  const conversation = readObject(request, 'conversation')
  if (conversation !== undefined) {
    const nested = nonBlank(conversation['id'])
    if (nested !== undefined) return nested
  }
  const direct = nonBlank(request['conversation'])
  if (direct !== undefined) return direct
  return nonBlank(request['conversation_id'])
}

/** Ordered `metadata` object for the upstream body. */
export function metadataObject(userId: string): { readonly user_id: string } {
  return { user_id: userId }
}
