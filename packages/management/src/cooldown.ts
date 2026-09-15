/**
 * Cooldown sidecar persistence (S6 3.4.4): `.cds` documents in the Store
 * `cooldown` namespace, written when `save-cooldown-status` is true, sorted
 * by model, with the zero-valued quota block rendered when no quota was
 * observed. Restored state feeds `isCooling` (the request layer's 503
 * decision, S4 policy).
 */

import type { JsonValue, Store } from '@cpa-edge/core'
import { goJsonIndent, ordered, type WireValue } from './gojson'
import { rfc3339Local, rfc3339Utc, localZoneOffsetMinutes } from './wire'

export const COOLDOWN_NAMESPACE = 'cooldown'

/** Cooldown record minus the stamped `updated_at`. */
export interface CooldownRecordInput {
  readonly authId: string
  readonly provider: string
  readonly model?: string
  readonly status: string
  readonly nextRetryAfter: string
  readonly reason: string
  readonly lastError: { readonly message: string; readonly retryable: boolean; readonly httpStatus: number }
  readonly quota?: { readonly exceeded: boolean; readonly nextRecoverAt: string; readonly observedAt: string }
}

interface SidecarRecord {
  readonly provider: string
  readonly authId: string
  readonly model?: string
  readonly status: string
  readonly nextRetryAfter: string
  readonly reason: string
  readonly quota: { readonly exceeded: boolean; readonly next_recover_at: string; readonly observed_at: string }
  readonly lastError: { readonly message: string; readonly retryable: boolean; readonly httpStatus: number }
  readonly updatedAt: string
  readonly nextRetryAfterMs: number
}

/** Zero-valued quota block rendered when no quota was observed. */
function quotaBlock(record: CooldownRecordInput): WireValue {
  if (record.quota !== undefined) {
    return {
      exceeded: record.quota.exceeded,
      next_recover_at: record.quota.nextRecoverAt,
      observed_at: record.quota.observedAt,
    }
  }
  return { exceeded: false, next_recover_at: '0001-01-01T00:00:00Z', observed_at: '0001-01-01T00:00:00Z' }
}

/** Parses an RFC3339 stamp to epoch milliseconds (0 when unparsable). */
function parseStampMs(text: string): number {
  const ms = Date.parse(text)
  return Number.isNaN(ms) ? 0 : ms
}

/** Sidecar file name: auth id with `:` turned into `_`, plus `.cds`. */
export function sidecarName(authId: string): string {
  return `${authId.replaceAll(':', '_')}.cds`
}

/**
 * Cooldown sidecar store: merge-on-write, read-on-demand. The in-memory
 * cache mirrors the Store so a restart over the same Store restores the
 * same state lazily.
 */
export class CooldownSidecars {
  private readonly docs = new Map<string, { records: SidecarRecord[]; provider: string }>()

  constructor(
    private readonly store: Store,
    private readonly now: () => number,
  ) {}

  /** Merges one record into its auth's sidecar (records keyed by model). */
  async record(input: CooldownRecordInput): Promise<void> {
    const name = sidecarName(input.authId)
    const existing = await this.load(name)
    const stamp = this.now()
    const entry: SidecarRecord = {
      provider: input.provider,
      authId: input.authId,
      ...(input.model !== undefined ? { model: input.model } : {}),
      status: input.status,
      nextRetryAfter: input.nextRetryAfter,
      reason: input.reason,
      quota: {
        exceeded: input.quota?.exceeded ?? false,
        next_recover_at: input.quota?.nextRecoverAt ?? '0001-01-01T00:00:00Z',
        observed_at: input.quota?.observedAt ?? '0001-01-01T00:00:00Z',
      },
      lastError: input.lastError,
      updatedAt: rfc3339Local(stamp, localZoneOffsetMinutes()),
      nextRetryAfterMs: parseStampMs(input.nextRetryAfter),
    }
    const key = input.model ?? ''
    const records = existing.records.filter((record) => (record.model ?? '') !== key)
    records.push(entry)
    records.sort((left, right) => {
      const leftKey = left.model ?? ''
      const rightKey = right.model ?? ''
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
    })
    await this.persist(name, { records, provider: input.provider })
  }

  /** All sidecars with their serialized bytes (2-space indent + newline). */
  async list(): Promise<ReadonlyArray<{ name: string; authId: string; content: string }>> {
    const keys = await this.store.list(COOLDOWN_NAMESPACE)
    const out: Array<{ name: string; authId: string; content: string }> = []
    for (const key of keys.sort()) {
      const doc = await this.load(key)
      if (doc.records.length === 0) continue
      out.push({ name: key, authId: doc.records[0]?.authId ?? '', content: this.render(key, doc) })
    }
    return out
  }

  /** True while the credential (or one of its models) is still cooling. */
  async isCooling(authId: string, model?: string): Promise<boolean> {
    const doc = await this.load(sidecarName(authId))
    const now = this.now()
    for (const record of doc.records) {
      if (model !== undefined && (record.model ?? '') !== model) continue
      if (record.status === 'cooling' && record.nextRetryAfterMs > now) return true
    }
    return false
  }

  private async load(name: string): Promise<{ records: SidecarRecord[]; provider: string }> {
    const cached = this.docs.get(name)
    if (cached !== undefined) return cached
    const raw = await this.store.get(COOLDOWN_NAMESPACE, name)
    let doc: { records: SidecarRecord[]; provider: string }
    if (raw === undefined || typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      doc = { records: [], provider: '' }
    } else {
      const record = raw as { [key: string]: JsonValue }
      const provider = typeof record['provider'] === 'string' ? (record['provider'] as string) : ''
      const stored = Array.isArray(record['records']) ? (record['records'] as JsonValue[]) : []
      const records: SidecarRecord[] = stored
        .filter((item): item is { [key: string]: JsonValue } => typeof item === 'object' && item !== null && !Array.isArray(item))
        .map((item) => {
          const lastError = (item['last_error'] ?? {}) as { [key: string]: JsonValue }
          const quota = (item['quota'] ?? {}) as { [key: string]: JsonValue }
          const nextRetryAfter = typeof item['next_retry_after'] === 'string' ? (item['next_retry_after'] as string) : ''
          const entry: SidecarRecord = {
            provider: typeof item['provider'] === 'string' ? (item['provider'] as string) : provider,
            authId: typeof item['auth_id'] === 'string' ? (item['auth_id'] as string) : '',
            ...(typeof item['model'] === 'string' ? { model: item['model'] as string } : {}),
            status: typeof item['status'] === 'string' ? (item['status'] as string) : '',
            nextRetryAfter,
            reason: typeof item['reason'] === 'string' ? (item['reason'] as string) : '',
            quota: {
              exceeded: quota['exceeded'] === true,
              next_recover_at: typeof quota['next_recover_at'] === 'string' ? (quota['next_recover_at'] as string) : '0001-01-01T00:00:00Z',
              observed_at: typeof quota['observed_at'] === 'string' ? (quota['observed_at'] as string) : '0001-01-01T00:00:00Z',
            },
            lastError: {
              message: typeof lastError['message'] === 'string' ? (lastError['message'] as string) : '',
              retryable: lastError['retryable'] === true,
              httpStatus: typeof lastError['http_status'] === 'number' ? (lastError['http_status'] as number) : 0,
            },
            updatedAt: typeof item['updated_at'] === 'string' ? (item['updated_at'] as string) : '',
            nextRetryAfterMs: parseStampMs(nextRetryAfter),
          }
          return entry
        })
      doc = { records, provider }
    }
    this.docs.set(name, doc)
    return doc
  }

  private render(name: string, doc: { records: SidecarRecord[]; provider: string }): string {
    const authId = doc.records[0]?.authId ?? ''
    const provider = doc.records[0]?.provider ?? doc.provider
    const records = doc.records.map((record) =>
      ordered([
        ['provider', record.provider],
        ['auth_id', record.authId],
        ...(record.model !== undefined ? ([['model', record.model]] as Array<[string, WireValue]>) : []),
        ['status', record.status],
        ['next_retry_after', record.nextRetryAfter],
        ['reason', record.reason],
        ['quota', record.quota],
        ['last_error', ordered([
          ['message', record.lastError.message],
          ['retryable', record.lastError.retryable],
          ['http_status', record.lastError.httpStatus],
        ])],
        ['updated_at', record.updatedAt],
      ]),
    )
    const envelope = ordered([
      ['version', 1],
      ['auth_id', authId],
      ['provider', provider],
      ['updated_at', rfc3339Utc(this.now())],
      ['records', records],
    ])
    void name
    return `${goJsonIndent(envelope)}\n`
  }

  private async persist(name: string, doc: { records: SidecarRecord[]; provider: string }): Promise<void> {
    this.docs.set(name, doc)
    const rendered = JSON.parse(this.render(name, doc)) as JsonValue
    await this.store.put(COOLDOWN_NAMESPACE, name, rendered)
  }
}

export { quotaBlock }
