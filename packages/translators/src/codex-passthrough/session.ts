
/**
 * Session / prompt-cache identity for the Codex passthrough (S2d9 3.2).
 *
 * Recorded contract: every upstream request carries BOTH a body
 * `prompt_cache_key` and a `Session-Id` header; a client body
 * `prompt_cache_key` is used verbatim for both places; a client
 * `Session-Id` header (with no body key) is forwarded verbatim while the
 * body key is derived; with neither signal one derived UUID fills both
 * places and stays stable across identical requests. The derivation chain
 * is the shared Codex session identity (caller-scope SHA-256 over the
 * gateway key, canonical identity root, `ctx:v1` prefix, SHA-1 UUID v5);
 * the exact UUID value is masked in every recording, so only the MUSTs -
 * presence, equality, stability, verbatim passthrough - are contract.
 */
import { deriveCodexSessionId, truncateRunes } from '../oai2codex'
import { isPlainObject } from './json'

/** Instructions text cap of the identity root (per the shared chain). */
const IDENTITY_INSTRUCTION_RUNES = 50

export interface PassthroughSessionContext {
  /** Downstream gateway key (Bearer token) - caller-scope seed. */
  readonly apiKey: string
  /** Client `Session-Id`-family header value, when one was present. */
  readonly clientSessionId?: string
}

/** The resolved identity values of one request. */
export interface SessionResolution {
  /** Body `prompt_cache_key` value (client value or derived UUID). */
  readonly promptCacheKey: string
  /** Upstream `Session-Id` header value (client key/header value or the same UUID). */
  readonly sessionHeaderValue: string
}

/**
 * Resolves the session identity of a passthrough request. `parsed` is the
 * strict-parsed request body; the identity inputs derive from the
 * `instructions` field plus system/developer input items (truncated to 50
 * runes each) and the canonical parts of the FIRST user message.
 */
export async function resolveSessionIdentity(
  parsed: Record<string, unknown>,
  ctx: PassthroughSessionContext,
): Promise<SessionResolution> {
  const bodyKey = typeof parsed['prompt_cache_key'] === 'string' ? (parsed['prompt_cache_key'] as string) : undefined
  if (bodyKey !== undefined && bodyKey.length > 0) {
    return { promptCacheKey: bodyKey, sessionHeaderValue: bodyKey }
  }
  const derived = await deriveCodexSessionId({
    apiKey: ctx.apiKey,
    instructions: identityInstructions(parsed),
    userParts: identityUserParts(parsed),
    clientSessionId: ctx.clientSessionId,
  })
  return {
    promptCacheKey: derived,
    sessionHeaderValue:
      ctx.clientSessionId !== undefined && ctx.clientSessionId.length > 0 ? ctx.clientSessionId : derived,
  }
}

/** Instruction texts feeding the identity root, in conversation order. */
function identityInstructions(parsed: Record<string, unknown>): readonly string[] {
  const texts: string[] = []
  const instructions = parsed['instructions']
  if (typeof instructions === 'string' && instructions.length > 0) {
    texts.push(truncateRunes(instructions, IDENTITY_INSTRUCTION_RUNES))
  }
  for (const text of systemItemTexts(parsed)) {
    texts.push(truncateRunes(text, IDENTITY_INSTRUCTION_RUNES))
  }
  return texts
}

/** Joined text parts of `system`/`developer` message items, in order. */
function systemItemTexts(parsed: Record<string, unknown>): readonly string[] {
  const out: string[] = []
  const input = parsed['input']
  if (!Array.isArray(input)) return out
  for (const raw of input) {
    if (!isPlainObject(raw)) continue
    const role = raw['role']
    if (role !== 'system' && role !== 'developer') continue
    out.push(partsText(raw['content']))
  }
  return out
}

/** Canonical parts of the FIRST user message item (empty when none). */
function identityUserParts(parsed: Record<string, unknown>): readonly unknown[] {
  const input = parsed['input']
  if (typeof input === 'string') {
    return [{ type: 'input_text', text: input }]
  }
  if (!Array.isArray(input)) return []
  for (const raw of input) {
    if (!isPlainObject(raw)) continue
    if (raw['role'] !== 'user') continue
    const content = raw['content']
    if (typeof content === 'string') return [{ type: 'input_text', text: content }]
    if (Array.isArray(content)) return content
  }
  return []
}

/** Joined text of a message content (string or part array). */
function partsText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const texts: string[] = []
  for (const part of content) {
    if (isPlainObject(part) && typeof part['text'] === 'string') texts.push(part['text'] as string)
  }
  return texts.join('\n')
}
