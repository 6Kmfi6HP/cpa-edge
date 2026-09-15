/**
 * Usage accounting (S6 section 3.5): record normalization and serialization
 * in the recorded 27-key order, the error-event envelope, the recent-request
 * bucket window, and the Store queue plumbing behind the pop endpoints.
 */

import type { JsonValue, Store } from '@cpa-edge/core'
import { ordered, type OrderedObject, type WireValue } from './gojson'
import { rfc3339Local, localZoneOffsetMinutes } from './wire'

/** Completion facts handed to `recordUsage` (camelCase mirror of 3.5.1). */
export interface UsageCompletion {
  readonly source: string
  readonly authIndex: string
  readonly clientIp: string
  readonly xForwardedFor: string
  readonly userAgent: string
  readonly requestId: string
  readonly sessionId: string
  readonly parentSessionId?: string
  readonly accessTokenSha256?: string
  readonly latencyMs: number
  readonly ttftMs: number
  readonly tokens: {
    readonly inputTokens: number
    readonly outputTokens: number
    readonly reasoningTokens: number
    readonly cachedTokens: number
    readonly cacheReadTokens: number
    readonly cacheReadTokensPresent: boolean
    readonly cacheCreationTokens: number
    readonly totalTokens: number
  }
  readonly accounting: {
    readonly quality: string
    readonly totalTokens: number
    readonly inputTokens: {
      readonly totalTokens: number
      readonly uncachedTokens: number
      readonly cacheReadTokens: number
      readonly cacheWriteTokens: number
    }
    readonly outputTokens: {
      readonly totalTokens: number
      readonly nonReasoningTokens: number
      readonly reasoningTokens: number
    }
    readonly unclassifiedTokens: number
  }
  readonly generate: boolean
  readonly stream: boolean
  readonly downstreamStatus: number
  readonly failBody?: string
  readonly responseHeaders: ReadonlyArray<readonly [string, string]>
  readonly provider: string
  readonly executorType: string
  readonly model: string
  readonly alias?: string
  readonly endpoint: string
  readonly authType: string
  readonly apiKey: string
  readonly reasoningEffort: string
  readonly serviceTier?: string
}

/** Error-event facts handed to `publishError` (S6 3.5.2 minus timestamp). */
export interface ErrorEventInput {
  readonly provider: string
  readonly model: string
  readonly authId: string
  readonly authIndex: string
  readonly statusCode: number
  readonly body: string
  readonly code?: string
  readonly retryable?: boolean
  readonly authStatus?: {
    readonly status: string
    readonly statusMessage: string
    readonly disabled: boolean
    readonly unavailable: boolean
    readonly nextRetryAfter?: string
    readonly quota?: JsonValue
    readonly model?: {
      readonly name: string
      readonly status: string
      readonly statusMessage: string
      readonly unavailable: boolean
      readonly nextRetryAfter?: string
      readonly quota?: JsonValue
    }
  }
}

/** Canonicalizes a session id into the canonical UUID form (v4 shape kept). */
function canonicalSessionId(value: string): string {
  const hex = value.replaceAll('-', '').toLowerCase()
  if (hex.length !== 32 || /[^0-9a-f]/.test(hex)) return value
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function orUnknown(value: string): string {
  const trimmed = value.trim()
  return trimmed === '' ? 'unknown' : trimmed
}

/** Response headers -> canonical-cased map of value arrays, keys sorted. */
export function responseHeadersMap(headers: ReadonlyArray<readonly [string, string]>): WireValue {
  const map = new Map<string, string[]>()
  for (const [rawName, value] of headers) {
    const name = canonicalHeaderLocal(rawName)
    const list = map.get(name) ?? []
    list.push(value)
    map.set(name, list)
  }
  const out: { [key: string]: WireValue } = {}
  for (const name of [...map.keys()].sort()) {
    out[name] = [...(map.get(name) ?? [])]
  }
  return out
}

function canonicalHeaderLocal(name: string): string {
  let out = ''
  let upper = true
  for (const ch of name.toLowerCase()) {
    if (ch === '-') {
      out += '-'
      upper = true
      continue
    }
    out += upper ? ch.toUpperCase() : ch
    upper = false
  }
  return out
}

/**
 * Normalizes and serializes one usage record. Every field lands in the
 * recorded order; `omitempty` fields (access_token_sha256,
 * parent_session_id) drop when empty, `failed` derives from the downstream
 * status, and empty identity fields fall back to `"unknown"`.
 */
export function serializeUsageRecord(completion: UsageCompletion, timestampMs: number): OrderedObject {
  const failed = completion.downstreamStatus >= 400
  const model = orUnknown(completion.model)
  const alias = (completion.alias ?? '').trim() === '' ? model : (completion.alias ?? '')
  const failBody = (completion.failBody ?? '').trim()
  const parent = (completion.parentSessionId ?? '').trim()
  const sha = (completion.accessTokenSha256 ?? '').trim()
  const tier = (completion.serviceTier ?? '').trim()
  const sessionId = canonicalSessionId(completion.sessionId)
  const members: Array<[string, WireValue]> = [
    ['timestamp', rfc3339Local(timestampMs, localZoneOffsetMinutes())],
    ['latency_ms', completion.latencyMs],
    ['ttft_ms', completion.ttftMs],
    ['source', completion.source],
    ['auth_index', completion.authIndex],
    ...((sha === '' ? [] : [['access_token_sha256', sha]] as Array<[string, WireValue]>)),
    ['client_ip', completion.clientIp],
    ['x_forwarded_for', completion.xForwardedFor],
    ['user_agent', completion.userAgent],
    [
      'tokens',
      ordered([
        ['input_tokens', completion.tokens.inputTokens],
        ['output_tokens', completion.tokens.outputTokens],
        ['reasoning_tokens', completion.tokens.reasoningTokens],
        ['cached_tokens', completion.tokens.cachedTokens],
        ['cache_read_tokens', completion.tokens.cacheReadTokens],
        ['cache_read_tokens_present', completion.tokens.cacheReadTokensPresent],
        ['cache_creation_tokens', completion.tokens.cacheCreationTokens],
        ['total_tokens', completion.tokens.totalTokens],
      ]),
    ],
    ['failed', failed],
    ['generate', completion.generate],
    ['stream', completion.stream],
    ['fail', ordered([['status_code', failed ? completion.downstreamStatus : 200], ['body', failed ? failBody : '']])],
    ['response_headers', responseHeadersMap(completion.responseHeaders)],
    ['accounting_version', 2],
    [
      'token_breakdown',
      ordered([
        ['schema_version', 2],
        ['quality', completion.accounting.quality],
        ['total_tokens', completion.accounting.totalTokens],
        [
          'input',
          ordered([
            ['total_tokens', completion.accounting.inputTokens.totalTokens],
            ['uncached_tokens', completion.accounting.inputTokens.uncachedTokens],
            ['cache_read_tokens', completion.accounting.inputTokens.cacheReadTokens],
            ['cache_write_tokens', completion.accounting.inputTokens.cacheWriteTokens],
          ]),
        ],
        [
          'output',
          ordered([
            ['total_tokens', completion.accounting.outputTokens.totalTokens],
            ['non_reasoning_tokens', completion.accounting.outputTokens.nonReasoningTokens],
            ['reasoning_tokens', completion.accounting.outputTokens.reasoningTokens],
          ]),
        ],
        ['unclassified_tokens', completion.accounting.unclassifiedTokens],
      ]),
    ],
    ['provider', orUnknown(completion.provider)],
    ['executor_type', orUnknown(completion.executorType)],
    ['model', model],
    ['alias', alias],
    ['endpoint', completion.endpoint],
    ['auth_type', orUnknown(completion.authType)],
    ['api_key', completion.apiKey],
    ['request_id', completion.requestId],
    ['session_id', sessionId],
    ...((parent === '' ? [] : [['parent_session_id', canonicalSessionId(parent)]] as Array<[string, WireValue]>)),
    ['reasoning_effort', completion.reasoningEffort],
    ['service_tier', tier === '' ? 'default' : tier],
  ]
  return ordered(members)
}

/** Serialized error event; `omitempty` fields drop when absent. */
export function serializeErrorEvent(event: ErrorEventInput, timestampMs: number): OrderedObject {
  const status = event.authStatus
  const members: Array<[string, WireValue]> = [
    ['timestamp', rfc3339Local(timestampMs, localZoneOffsetMinutes())],
    ['provider', event.provider],
    ['model', event.model],
    ['auth_id', event.authId],
    ['auth_index', event.authIndex],
    ['status_code', event.statusCode],
    ['body', event.body],
  ]
  if (event.code !== undefined && event.code !== '') members.push(['code', event.code])
  if (event.retryable !== undefined) members.push(['retryable', event.retryable])
  if (status !== undefined) {
    const statusMembers: Array<[string, WireValue]> = [
      ['status', status.status],
      ['status_message', status.statusMessage],
      ['disabled', status.disabled],
      ['unavailable', status.unavailable],
    ]
    if (status.nextRetryAfter !== undefined) statusMembers.push(['next_retry_after', status.nextRetryAfter])
    if (status.quota !== undefined) statusMembers.push(['quota', status.quota])
    if (status.model !== undefined) {
      const modelMembers: Array<[string, WireValue]> = [
        ['name', status.model.name],
        ['status', status.model.status],
        ['status_message', status.model.statusMessage],
        ['unavailable', status.model.unavailable],
      ]
      if (status.model.nextRetryAfter !== undefined) modelMembers.push(['next_retry_after', status.model.nextRetryAfter])
      if (status.model.quota !== undefined) modelMembers.push(['quota', status.model.quota])
      statusMembers.push(['model', ordered(modelMembers)])
    }
    members.push(['auth_status', ordered(statusMembers)])
  }
  return ordered(members)
}

// ---------------------------------------------------------------------------
// Recent-request buckets (S6 3.6.4)
// ---------------------------------------------------------------------------

export const BUCKET_WINDOW_SECONDS = 600
export const BUCKET_COUNT = 20

export interface RecentRequestBucket {
  readonly time: string
  readonly success: number
  readonly failed: number
}

function hhmm(seconds: number): string {
  const date = new Date(seconds * 1000)
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${hours}:${minutes}`
}

/**
 * The fixed 20-bucket window ending at the bucket containing `nowSeconds`:
 * bucket id `floor(unix/600)`, slot `id mod 20`, zero-filled snapshots
 * oldest to newest with wall-clock labels.
 */
export function recentRequestBuckets(nowSeconds: number): RecentRequestBucket[] {
  const currentBucket = Math.floor(nowSeconds / BUCKET_WINDOW_SECONDS)
  const out: RecentRequestBucket[] = []
  for (let slot = BUCKET_COUNT - 1; slot >= 0; slot -= 1) {
    const bucketId = currentBucket - slot
    const start = bucketId * BUCKET_WINDOW_SECONDS
    const end = start + BUCKET_WINDOW_SECONDS
    out.push({
      time: `${hhmm(start)}-${hhmm(end)}`,
      success: 0,
      failed: 0,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Queue plumbing
// ---------------------------------------------------------------------------

export const USAGE_QUEUE = 'usage'
export const ERRORS_RING = 'errors'

/** One live subscriber to the usage or errors channel. */
export interface ChannelSubscriber {
  readonly channel: 'usage' | 'errors'
  deliver(payload: string): void
}

/**
 * Pops up to `count` records oldest-first and destructively. Records whose
 * bytes are not valid JSON surface as JSON strings, matching the pop
 * envelope.
 */
export async function popUsageRecords(store: Store, count: number): Promise<JsonValue[]> {
  const out: JsonValue[] = []
  for (let i = 0; i < count; i += 1) {
    const claim = await store.claim(USAGE_QUEUE, 30_000)
    if (claim === undefined) break
    await store.ack(USAGE_QUEUE, claim)
    const text = typeof claim.payload === 'string' ? claim.payload : JSON.stringify(claim.payload)
    try {
      out.push(JSON.parse(text) as JsonValue)
    } catch {
      out.push(text)
    }
  }
  return out
}
