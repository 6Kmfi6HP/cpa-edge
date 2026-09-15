/**
 * /v1beta route parsing and model discovery (S2d2 sections 2.1, 2.4).
 *
 * The `*action` wildcard captures everything after `/v1beta/models/`: one
 * leading slash is stripped and the remainder splits on colons - exactly
 * two segments resolve to model + method, anything else is the
 * handler-written JSON 404. The models LIST normalizes every registry
 * entry (prefixed name, defaulted displayName / description /
 * supportedGenerationMethods) while the single-model GET returns the RAW
 * registry record verbatim - the recorded asymmetry.
 */
import { serializeOrdered } from './json'
import type { WireObject } from './types'

/** Query-stripped path plus its parsed query parameters. */
export interface V1BetaTarget {
  readonly pathname: string
  readonly query: URLSearchParams
}

/** Splits a raw request path into pathname + query parameters. */
export function splitV1BetaPath(path: string): V1BetaTarget {
  const question = path.indexOf('?')
  const pathname = question >= 0 ? path.slice(0, question) : path
  const query = new URLSearchParams(question >= 0 ? path.slice(question + 1) : '')
  return { pathname, query }
}

/**
 * Splits an `*action` segment on colons. Exactly two segments resolve to
 * `{model, method}` (the model is everything before the FIRST colon);
 * zero or 2+ colons leave `undefined` - the 404 case.
 */
export function parseModelMethod(action: string): { readonly model: string; readonly method: string } | undefined {
  const parts = action.split(':')
  if (parts.length !== 2) return undefined
  const model = parts[0] ?? ''
  const method = parts[1] ?? ''
  if (model.length === 0 || method.length === 0) return undefined
  return { model, method }
}

/** One entry of the global model registry. */
export interface Gem2OaiRegistryEntry {
  /** Client-facing model id (the registry key). */
  readonly id: string
  /** Raw registry field; LIST and the raw GET map show it verbatim. */
  readonly displayName?: string
  /** LIST-only field. */
  readonly description?: string
  /** LIST-only field. */
  readonly supportedGenerationMethods?: readonly string[]
}

/** Raw registry record of one entry - what the single-model GET returns. */
export function rawModelRecord(entry: Gem2OaiRegistryEntry): WireObject {
  const fields: Record<string, unknown> = {
    name: `models/${entry.id}`,
    displayName: entry.displayName ?? entry.id,
  }
  if (entry.description !== undefined) fields['description'] = entry.description
  if (entry.supportedGenerationMethods !== undefined) fields['supportedGenerationMethods'] = entry.supportedGenerationMethods
  // Go map marshal order: the raw record's keys are alphabetically sorted.
  const record: WireObject = {}
  for (const key of Object.keys(fields).sort()) record[key] = fields[key] as never
  return record
}

/** `GET /v1beta/models` body: every registry entry, registration order. */
export function renderModelsList(registry: readonly Gem2OaiRegistryEntry[]): string {
  const models: WireObject[] = []
  for (const entry of registry) {
    models.push({
      description: entry.description ?? entry.id,
      displayName: entry.displayName ?? entry.id,
      name: `models/${entry.id}`,
      supportedGenerationMethods: [...(entry.supportedGenerationMethods ?? ['generateContent'])],
    })
  }
  return serializeOrdered({ models })
}

/** Registry entry by bare id, or undefined when nothing resolves. */
export function registryEntryById(
  registry: readonly Gem2OaiRegistryEntry[],
  id: string,
): Gem2OaiRegistryEntry | undefined {
  for (const entry of registry) {
    if (entry.id === id) return entry
  }
  return undefined
}

/** Default generation-methods list applied by the LIST normalization. */
export const DEFAULT_GENERATION_METHODS: readonly string[] = Object.freeze(['generateContent'])
