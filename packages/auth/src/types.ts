import type { JsonValue } from '@cpa-edge/core'

/**
 * Minimal subset of the global `fetch` signature the OAuth/device flows
 * need. Keeping the parameter surface this narrow lets tests replay
 * scripted vendor responses without a network and keeps the package
 * portable across runtimes that provide the Web Standard `fetch`.
 */
export type FetchLike = (url: string, init?: FetchInit) => Promise<Response>

/** Options accepted by {@link FetchLike} calls. */
export interface FetchInit {
  readonly method?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: string
  /** Aborts the call (refresh attempts enforce a 30 s timeout). */
  readonly signal?: AbortSignal
}

/** Epoch-milliseconds clock; tests inject a steppable fake. */
export type Clock = () => number

/** Asynchronous sleep; poll loops depend on it so tests can advance time. */
export type SleepFn = (ms: number) => Promise<void>

/**
 * Transport-neutral decision handed to a runtime: the HTTP status, the
 * byte-exact body, and any extra headers the surface requires. Runtimes own
 * routing and add the global CORS block; nothing here emits it.
 */
export interface AuthResponse {
  readonly status: number
  readonly body: string
  readonly headers?: Readonly<Record<string, string>>
}

/** Reads a string field out of an untrusted JSON object. */
export function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

/** Reads a nested plain object out of untrusted JSON. */
export function readObject(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = record[key]
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/** Narrows unknown parsed JSON to a plain object (not array, not null). */
export function asPlainObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/** Reads a numeric field, accepting the JSON number only. */
export function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Type alias used for documents this package writes into the Store. */
export type Document = { readonly [key: string]: JsonValue }
