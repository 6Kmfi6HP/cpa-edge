/**
 * `metadata.user_id` derivation for the Claude upstream (DeriveClaudeUserID
 * chain, S2d3 section 2.4).
 *
 * Priority: caller `metadata.user_id` -> caller `user` (both verbatim) ->
 * sha256 over a seed string. The seed is taken from the first field that is
 * present: `prompt_cache_key:<v>`, then the first user-message text
 * (`content:<text>`), then `model:<model>` with instruction/system suffixes.
 * When nothing is present the literal `unknown` is used. The conversation-id
 * seeds exist on the Claude client surface only; this direction has no
 * conversation state, so that chain link never fires here.
 */
import type { WireObject } from './types'

const encoder = new TextEncoder()

async function sha256Hex(seed: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(seed))
  const bytes = new Uint8Array(digest)
  let hex = ''
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
  return hex
}

/** First user-message text: string content, or text parts joined with `\n`. */
export function firstUserMessageText(messages: readonly unknown[]): string | undefined {
  for (const message of messages) {
    if (typeof message !== 'object' || message === null) continue
    const record = message as Record<string, unknown>
    if (record['role'] !== 'user') continue
    const content = record['content']
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      const parts: string[] = []
      for (const part of content) {
        if (typeof part === 'object' && part !== null) {
          const text = (part as Record<string, unknown>)['text']
          if (typeof text === 'string') parts.push(text)
        }
      }
      if (parts.length > 0) return parts.join('\n')
      return undefined
    }
    return undefined
  }
  return undefined
}

export interface DeriveUserIdInput {
  /** Parsed client request body (an object). */
  readonly request: Record<string, unknown>
  /** System block texts in translation order (for the model-seed suffix). */
  readonly systemTexts: readonly string[]
  /** Model name used for the model seed (upstream/alias-target name). */
  readonly model: string
}

/**
 * Resolves the `metadata.user_id` value. Callers pass the pieces the
 * translator already extracted so the seed never depends on translation
 * order.
 */
export async function deriveClaudeUserId(input: DeriveUserIdInput): Promise<string> {
  const metadata = input.request['metadata']
  const metadataId = read(metadata, 'user_id')
  if (metadataId !== undefined) return metadataId
  const user = input.request['user']
  if (typeof user === 'string' && user.length > 0) return user

  const cacheKey = input.request['prompt_cache_key']
  if (typeof cacheKey === 'string' && cacheKey.length > 0) {
    return sha256Hex(`prompt_cache_key:${cacheKey}`)
  }

  const contentText = firstUserMessageText(readArray(input.request, 'messages') ?? [])
  if (contentText !== undefined && contentText.length > 0) {
    return sha256Hex(`content:${contentText}`)
  }

  if (input.model.length > 0) {
    let seed = `model:${input.model}`
    const instructions = input.request['instructions']
    if (typeof instructions === 'string' && instructions.length > 0) {
      seed += `;instructions:${instructions}`
    }
    if (input.systemTexts.length > 0) seed += `;system:${input.systemTexts.join('\n')}`
    return sha256Hex(seed)
  }

  return 'unknown'
}

function read(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = (value as Record<string, unknown>)[key]
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined
}

function readArray(value: unknown, key: string): readonly unknown[] {
  if (typeof value !== 'object' || value === null) return []
  const raw = (value as Record<string, unknown>)[key]
  return Array.isArray(raw) ? raw : []
}

/** Builds the ordered metadata object for the upstream body. */
export function metadataObject(userId: string): WireObject {
  return { user_id: userId }
}
