/**
 * Auth-file documents (S6 3.4): Store-backed upload/list/download/delete,
 * canonical re-serialization (single-line alphabetical with a materialized
 * `disabled`; 2-space-indented for vertex imports), typed PATCH-fields
 * merging and the listing-entry shape recorded by the S5/S6 goldens.
 */

import type { JsonValue, Store } from '@cpa-edge/core'
import { goJson, goJsonIndent, ordered, type WireValue } from './gojson'
import { rfc3339Local } from './wire'
import { recentRequestBuckets } from './usage'

/** Store namespace holding one document per auth file. */
export const AUTH_FILES_NAMESPACE = 'auth'

/** Vertex-type files persist 2-space-indented; every other type single-line. */
export const VERTEX_TYPE = 'vertex'

/** Providers whose registration stamps a `last_refresh` when absent. */
const REFRESHABLE_TYPES = new Set(['claude', 'codex', 'xai', 'kimi', 'meta', 'antigravity', 'devin'])

export interface AuthFileMeta {
  createdMs: number
  modifiedMs: number
  updatedMs: number
}

/** In-memory registration metadata; the documents live in the Store. */
export class AuthFileRegistry {
  private readonly meta = new Map<string, AuthFileMeta>()

  constructor(
    private readonly store: Store,
    private readonly deriveIndex: (fileName: string, document: JsonValue) => string,
    private readonly authDir: string,
    private readonly now: () => number,
    private readonly zoneOffsetMinutes: number,
  ) {}

  /** Lists the file names currently stored, case-insensitive ascending. */
  async names(): Promise<string[]> {
    const keys = await this.store.list(AUTH_FILES_NAMESPACE)
    return keys.sort((left, right) => left.toLowerCase().localeCompare(right.toLowerCase()))
  }

  async read(name: string): Promise<{ readonly document: JsonValue } | undefined> {
    const value = await this.store.get(AUTH_FILES_NAMESPACE, name)
    if (value === undefined) return undefined
    return { document: value }
  }

  async write(name: string, document: JsonValue): Promise<void> {
    const stamp = this.now()
    const existing = this.meta.get(name)
    this.meta.set(name, {
      createdMs: existing?.createdMs ?? stamp,
      modifiedMs: stamp,
      updatedMs: stamp,
    })
    await this.store.put(AUTH_FILES_NAMESPACE, name, document)
  }

  /** Persists the raw uploaded bytes when they are not a JSON object. */
  async writeRaw(name: string, bytes: string): Promise<void> {
    const stamp = this.now()
    this.meta.set(name, { createdMs: stamp, modifiedMs: stamp, updatedMs: stamp })
    await this.store.put(AUTH_FILES_NAMESPACE, name, bytes)
  }

  async delete(name: string): Promise<boolean> {
    this.meta.delete(name)
    return this.store.delete(AUTH_FILES_NAMESPACE, name)
  }

  authIndexOf(name: string, document: JsonValue): string {
    return this.deriveIndex(name, document)
  }

  /** The canonical on-disk bytes of one document (write-path dependent). */
  serialize(document: JsonValue): string {
    if (typeof document === 'object' && document !== null && !Array.isArray(document)) {
      const record = document as { [key: string]: JsonValue }
      if (record['type'] === VERTEX_TYPE) {
        return `${goJsonIndent(document)}\n`
      }
    }
    return goJson(document)
  }

  /** Listing entry in the recorded alphabetical (gin.H) shape. */
  async entry(name: string, document: JsonValue, nowSeconds: number): Promise<WireValue> {
    const record: { [key: string]: JsonValue } =
      typeof document === 'object' && document !== null && !Array.isArray(document)
        ? { ...(document as { [key: string]: JsonValue }) }
        : {}
    const meta = this.meta.get(name) ?? { createdMs: this.now(), modifiedMs: this.now(), updatedMs: this.now() }
    const type = typeof record['type'] === 'string' ? (record['type'] as string).toLowerCase().trim() : ''
    const email = typeof record['email'] === 'string' ? (record['email'] as string) : undefined
    const clientEmail = typeof record['client_email'] === 'string' ? (record['client_email'] as string) : undefined
    const identity = email ?? clientEmail
    const disabled = record['disabled'] === true
    const provider = type === '' ? 'unknown' : type
    const lastRefresh =
      typeof record['last_refresh'] === 'string'
        ? (record['last_refresh'] as string)
        : REFRESHABLE_TYPES.has(provider)
          ? rfc3339Local(meta.createdMs, this.zoneOffsetMinutes)
          : undefined
    const bytes = this.serialize(document)
    const fields: Array<[string, WireValue]> = []
    if (identity !== undefined) {
      fields.push(['account', identity])
      fields.push(['account_type', typeof record['account_type'] === 'string' ? (record['account_type'] as string) : 'oauth'])
    }
    fields.push(['auth_index', this.authIndexOf(name, document)])
    fields.push(['cooldowns', []])
    fields.push(['created_at', rfc3339Local(meta.createdMs, this.zoneOffsetMinutes)])
    fields.push(['disabled', disabled])
    if (identity !== undefined) fields.push(['email', identity])
    fields.push(['failed', 0])
    fields.push(['id', name])
    fields.push(['label', identity ?? provider])
    if (lastRefresh !== undefined) fields.push(['last_refresh', lastRefresh])
    fields.push(['modtime', rfc3339Local(meta.modifiedMs, this.zoneOffsetMinutes)])
    fields.push(['name', name])
    for (const [key, wireKey] of [
      ['note', 'note'],
      ['priority', 'priority'],
      ['project_id', 'project_id'],
      ['weight', 'weight'],
      ['request_retry', 'request_retry'],
      ['websockets', 'websockets'],
    ] as const) {
      const value = record[key]
      if (value !== undefined) fields.push([wireKey, value as WireValue])
    }
    fields.push(['path', `${this.authDir}/${name}`])
    fields.push(['provider', provider])
    fields.push(['quota', { signals: {} }])
    fields.push(['recent_requests', recentRequestBuckets(nowSeconds)])
    fields.push(['runtime_only', false])
    fields.push(['size', bytes.length])
    fields.push(['source', 'file'])
    fields.push(['status', disabled ? 'disabled' : 'active'])
    fields.push(['status_message', ''])
    fields.push(['success', 0])
    fields.push(['type', provider])
    fields.push(['unavailable', false])
    fields.push(['updated_at', rfc3339Local(meta.updatedMs, this.zoneOffsetMinutes)])
    fields.sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
    const out: { [key: string]: WireValue } = {}
    for (const [key, value] of sorted) out[key] = value
    return out
  }
}

// ---------------------------------------------------------------------------
// PATCH-fields semantics (S6 3.4.6)
// ---------------------------------------------------------------------------

export class FieldPatchError extends Error {}

const MAX_WEIGHT = 1_000_000

/** Dashed root -> canonical underscore root, matching the metadata keys. */
function canonicalRoot(field: string): string {
  return field.replaceAll('-', '_')
}

/**
 * Applies the typed PATCH-fields merge onto a document copy. Throws
 * {@link FieldPatchError} with the recorded 400 strings.
 */
export function applyFieldPatch(
  document: { [key: string]: JsonValue },
  fields: ReadonlyArray<readonly [string, JsonValue]>,
): { [key: string]: JsonValue } {
  const out: { [key: string]: JsonValue } = { ...document }
  const seen = new Map<string, string>()
  for (const [rawField] of fields) {
    const root = rawField.split('.')[0] ?? ''
    if (root === '') throw new FieldPatchError('field name is required')
    const canonical = canonicalRoot(root)
    const previous = seen.get(canonical)
    if (previous !== undefined && previous !== rawField) {
      throw new FieldPatchError(`auth file fields "${previous}" and "${rawField}" refer to the same field`)
    }
    if (previous === undefined) seen.set(canonical, rawField)
  }
  for (const [rawField, value] of fields) {
    const segments = rawField.split('.')
    const root = segments[0] ?? ''
    const canonical = canonicalRoot(root)
    if (segments.length > 1 && (canonical === 'weight' || canonical === 'request_retry')) {
      throw new FieldPatchError(`${canonical} does not support nested fields`)
    }
    switch (canonical) {
      case 'weight': {
        if (value === null) {
          delete out['weight']
          continue
        }
        if (typeof value !== 'number' || !Number.isInteger(value)) {
          throw new FieldPatchError('weight must be an integer')
        }
        if (value > MAX_WEIGHT) throw new FieldPatchError('weight must not exceed 1000000')
        out['weight'] = value
        continue
      }
      case 'request_retry': {
        if (value === null) {
          delete out['request_retry']
          continue
        }
        if (typeof value !== 'number' || !Number.isInteger(value)) {
          throw new FieldPatchError('request_retry must be an integer or null')
        }
        out['request_retry'] = value
        continue
      }
      default:
        break
    }
    if (segments.length === 1) {
      if (value === null) delete out[canonical]
      else out[canonical] = value
      continue
    }
    // Dotted merge for nested maps (headers and unknown trees).
    const nested = { ...(typeof out[canonical] === 'object' && out[canonical] !== null && !Array.isArray(out[canonical]) ? (out[canonical] as { [key: string]: JsonValue }) : {}) }
    let cursor: { [key: string]: JsonValue } = nested
    for (let i = 1; i < segments.length - 1; i += 1) {
      const segment = canonicalRoot(segments[i] ?? '')
      const next = cursor[segment]
      cursor[segment] =
        typeof next === 'object' && next !== null && !Array.isArray(next)
          ? { ...(next as { [key: string]: JsonValue }) }
          : {}
      cursor = cursor[segment] as { [key: string]: JsonValue }
    }
    const leaf = canonicalRoot(segments[segments.length - 1] ?? '')
    if (value === null) delete cursor[leaf]
    else cursor[leaf] = value
    out[canonical] = nested
  }
  return out
}

// ---------------------------------------------------------------------------
// Name validation shared by download/upload/delete
// ---------------------------------------------------------------------------

export function checkAuthFileName(name: string): string | undefined {
  if (name === '' || name.includes('/') || name.includes('\\') || name.includes('..')) return 'invalid name'
  if (!name.endsWith('.json')) return 'name must end with .json'
  return undefined
}

/** Sanitizes a project id into the vertex file-name form. */
export function vertexFileName(projectId: string): string {
  const sanitized = projectId
    .replaceAll('/', '_')
    .replaceAll('\\', '_')
    .replaceAll(':', '_')
    .replaceAll(' ', '-')
  return `vertex-${sanitized}.json`
}
