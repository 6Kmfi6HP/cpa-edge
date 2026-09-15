/**
 * Session affinity: sticky credential bindings per (provider, session,
 * model) with a TTL, refreshed on success and dropped on
 * credential-attributed failures.
 *
 * The registry keeps every binding in the Store; lookups expire lazily at
 * read time (no background timers). Bindings outrank priority tiers: an
 * established binding is kept even when a higher-priority credential is
 * available.
 */
import type { JsonValue, Store } from '../store'

/** Default binding retention (`routing.session-affinity-ttl` default: 1h). */
export const DEFAULT_SESSION_AFFINITY_TTL_MS = 60 * 60 * 1000

/** Bindings shorter than one second are floored to one second. */
export const MIN_SESSION_AFFINITY_TTL_MS = 1_000

/** Store namespace holding one binding document per cache key. */
export const SESSION_AFFINITY_NAMESPACE = 'cpa-scheduling-affinity'

/** One stored binding. */
export interface SessionBinding {
  readonly authId: string
  /** Epoch milliseconds after which the binding lapses. */
  readonly expiresAt: number
}

/** Everything the identity extraction needs from one request. */
export interface SessionRequestInput {
  /** Downstream headers, keys compared ASCII-case-insensitively. */
  readonly headers: Readonly<Record<string, string>>
  /** Parsed request body, when there is one. */
  readonly body?: unknown
  /** Execution-layer session reference (e.g. a subagent's parent session). */
  readonly executionSessionId?: string | undefined
  /** First user message content, used by the last-resort hash fallback. */
  readonly firstMessage?: string | undefined
}

function readHeader(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  const lowered = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowered && value !== '') return value
  }
  return undefined
}

function readStringField(body: unknown, key: string): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const value = (body as Record<string, unknown>)[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

function readNestedString(body: unknown, outer: string, inner: string): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const nested = (body as Record<string, unknown>)[outer]
  if (typeof nested !== 'object' || nested === null) return undefined
  return readStringField(nested, inner)
}

/**
 * Extracts the session identity of a request, consulting the sources in
 * their recorded priority order:
 *
 * 1. `X-Claude-Code-Session-Id` header
 * 2. body `metadata.user_id` (Claude Code)
 * 3. `Session-Id` header
 * 4. `X-Http-Session-Id` header
 * 5. `X-Session-ID` / `X-Session-Affinity` / `X-Slot-Session-Id` headers
 * 6. `X-Conversation-Id` / `X-Thread-Id` / `X-Client-Request-Id` headers
 * 7. body `cachedContent` (Gemini)
 * 8. body `thread_id` (OpenAI)
 * 9. body `session_id` / `sessionId`
 * 10. body `prompt_cache_key`
 * 11. body `conversation.id` / `conversation_id` / `chat_id`
 * 12. execution-session metadata
 *
 * When no source yields an identity, the first user message is hashed into
 * a stable fallback identity so repeated identical prompts still stick.
 * Resolves `undefined` only when there is neither a session nor a message.
 */
export async function extractSessionIdentity(request: SessionRequestInput): Promise<string | undefined> {
  const headers = request.headers
  const body = request.body
  const claudeCodeSession = readHeader(headers, 'X-Claude-Code-Session-Id')
  if (claudeCodeSession !== undefined) return claudeCodeSession
  const metadataUserId = readNestedString(body, 'metadata', 'user_id')
  if (metadataUserId !== undefined) return metadataUserId
  const fromHeaders = [
    'Session-Id',
    'X-Http-Session-Id',
    'X-Session-ID',
    'X-Session-Affinity',
    'X-Slot-Session-Id',
    'X-Conversation-Id',
    'X-Thread-Id',
    'X-Client-Request-Id',
  ]
  for (const header of fromHeaders) {
    const value = readHeader(headers, header)
    if (value !== undefined) return value
  }
  const bodyFields = [
    'cachedContent',
    'thread_id',
    'session_id',
    'sessionId',
    'prompt_cache_key',
    'conversation_id',
    'chat_id',
  ]
  for (const field of bodyFields) {
    const value = readStringField(body, field)
    if (value !== undefined) return value
  }
  const conversationId = readNestedString(body, 'conversation', 'id')
  if (conversationId !== undefined) return conversationId
  if (request.executionSessionId !== undefined && request.executionSessionId !== '') {
    return request.executionSessionId
  }
  const firstMessage = request.firstMessage
  if (firstMessage !== undefined && firstMessage !== '') {
    return firstMessageHash(firstMessage)
  }
  return undefined
}

/** Stable fallback identity of a first message (sha256, 16 hex chars). */
export async function firstMessageHash(message: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(message))
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16)
}

/**
 * Base model key of a cache entry: the model without its thinking suffix
 * (`alias(budget)` / `model(level)` - the trailing parenthesized group).
 */
export function baseModelKey(model: string): string {
  const open = model.lastIndexOf('(')
  if (open > 0 && model.endsWith(')')) {
    return model.slice(0, open)
  }
  return model
}

/** Cache key of one affinity binding: `provider :: session-id :: model`. */
export function sessionCacheKey(provider: string, sessionId: string, model: string): string {
  return `${provider} :: ${sessionId} :: ${baseModelKey(model)}`
}

/**
 * Parses a Go duration string (`1h30m`, `90s`, `500ms`, `1.5h`) into
 * milliseconds; `undefined` when the text is not a duration.
 */
export function parseGoDurationMs(text: string): number | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  const match = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:ns|us|µs|ms|s|m|h))+$/.exec(trimmed)
  if (match === null) return undefined
  const unitMs: Record<string, number> = {
    ns: 1e-6,
    us: 1e-3,
    'µs': 1e-3,
    ms: 1,
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
  }
  const part = /([+-]?(?:\d+(?:\.\d*)?|\.\d+))(ns|us|µs|ms|s|m|h)/g
  let negative = false
  let total = 0
  let current: RegExpExecArray | null
  while ((current = part.exec(trimmed)) !== null) {
    const rawValue = current[1]
    const unitKey = current[2]
    if (rawValue === undefined || unitKey === undefined) return undefined
    const unit = unitMs[unitKey]
    if (unit === undefined) return undefined
    const value = Number(rawValue)
    if (Number.isNaN(value)) return undefined
    if (value < 0) negative = true
    total += Math.abs(value) * unit
  }
  return negative ? -Math.round(total) : Math.round(total)
}

/**
 * Normalizes the configured affinity TTL: values in `(0, 1s)` floor to
 * one second; non-positive values fall back to the default retention.
 */
export function normalizeSessionAffinityTtlMs(ms: number): number {
  if (ms <= 0) return DEFAULT_SESSION_AFFINITY_TTL_MS
  return Math.max(ms, MIN_SESSION_AFFINITY_TTL_MS)
}

function toBinding(value: JsonValue | undefined): SessionBinding | undefined {
  if (value === undefined || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const authId = record['authId']
  const expiresAt = record['expiresAt']
  if (typeof authId !== 'string' || typeof expiresAt !== 'number') return undefined
  return { authId, expiresAt }
}

/** Store-backed sticky-binding registry. */
export class SessionAffinityRegistry {
  private readonly store: Store
  private readonly now: () => number

  constructor(store: Store, now: () => number) {
    this.store = store
    this.now = now
  }

  /**
   * Looks up a live binding by its exact cache key; expired bindings read
   * as absent.
   */
  async get(cacheKey: string): Promise<SessionBinding | undefined> {
    const binding = toBinding(await this.store.get(SESSION_AFFINITY_NAMESPACE, cacheKey))
    if (binding === undefined || binding.expiresAt <= this.now()) return undefined
    return binding
  }

  /** Binds a cache key to a credential until `now + ttlMs`. */
  async bind(cacheKey: string, authId: string, ttlMs: number): Promise<void> {
    const expiresAt = this.now() + ttlMs
    await this.store.put(SESSION_AFFINITY_NAMESPACE, cacheKey, { authId, expiresAt })
  }

  /** Refreshes a binding's TTL after a successful request. */
  async refresh(cacheKey: string, authId: string, ttlMs: number): Promise<void> {
    const expiresAt = this.now() + ttlMs
    await this.store.update<JsonValue>(SESSION_AFFINITY_NAMESPACE, cacheKey, (current) => {
      const binding = toBinding(current)
      // Compare-and-set: only the bound credential extends its binding.
      if (binding === undefined || binding.authId !== authId) {
        return current === undefined ? ({ authId, expiresAt } as JsonValue) : current
      }
      return { authId, expiresAt }
    })
  }

  /**
   * Drops a binding, but only while it still names `authId`
   * (compare-and-delete): a credential-attributed failure must not unbind a
   * newer binding established by a concurrent request. The tombstone keeps
   * the deletion atomic; readers treat it as absent.
   */
  async unbind(cacheKey: string, authId: string): Promise<boolean> {
    let removed = false
    await this.store.update<JsonValue>(SESSION_AFFINITY_NAMESPACE, cacheKey, (current) => {
      const binding = toBinding(current)
      if (binding !== undefined && binding.authId === authId) {
        removed = true
        return { authId, expiresAt: 0 }
      }
      return current === undefined ? ({ authId, expiresAt: 0 } as JsonValue) : current
    })
    return removed
  }

  /**
   * Longest-common-prefix lookup: among the live bindings of the same
   * provider and model, the stored session id that is a prefix of the
   * incoming session id with the greatest length. Recorded upstream calls
   * this LCP prefix matching; the exact threshold is unrecorded, so a
   * stored id must be a strict prefix of at least one character.
   */
  async longestPrefixLookup(
    provider: string,
    sessionId: string,
    model: string,
  ): Promise<SessionBinding | undefined> {
    if (sessionId === '') return undefined
    const keys = await this.store.list(SESSION_AFFINITY_NAMESPACE)
    let bestKey: string | undefined
    let bestLength = 0
    for (const key of keys) {
      const segments = key.split(' :: ')
      if (segments.length !== 3) continue
      if (segments[0] !== provider || segments[2] !== baseModelKey(model)) continue
      const storedId = segments[1] ?? ''
      if (storedId === '' || storedId.length >= sessionId.length) continue
      if (sessionId.startsWith(storedId) && storedId.length > bestLength) {
        bestKey = key
        bestLength = storedId.length
      }
    }
    if (bestKey === undefined) return undefined
    return this.get(bestKey)
  }
}
