/**
 * Log window (S6 3.6): ring `logs` (capacity 1000) as the backing window,
 * the `GET/DELETE /v0/management/logs` semantics (tail reads, limit
 * validation, cursor mechanics, alphabetical response keys) and the
 * recorded log-line format.
 */

import type { JsonValue, Store } from '@cpa-edge/core'
import { base64UrlDecode, base64UrlEncode, formatLogStamp, parseLogStampToUnixSeconds, sha256Bytes } from './wire'

export const LOGS_RING = 'logs'
export const LOG_RING_CAPACITY = 1000

export interface LogLineEntryInput {
  readonly line: string
  readonly level: string
  readonly timestamp: string
  readonly requestId: string
}

export interface LogRingEntryInput extends LogLineEntryInput {}

/** Appends one entry to the ring (capacity 1000). */
export async function appendLogRing(store: Store, entry: LogLineEntryInput): Promise<void> {
  const value: { [key: string]: JsonValue } = {
    line: entry.line,
    level: entry.level,
    timestamp: entry.timestamp,
    request_id: entry.requestId,
  }
  await store.ringAppend(LOGS_RING, value, LOG_RING_CAPACITY)
}

/** Reads the whole window, oldest first. */
export async function readLogRing(store: Store): Promise<LogRingEntryInput[]> {
  const values = await store.ringRead(LOGS_RING)
  return values.map((value) => {
    const record = (typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}) as {
      [key: string]: JsonValue
    }
    return {
      line: typeof record['line'] === 'string' ? (record['line'] as string) : '',
      level: typeof record['level'] === 'string' ? (record['level'] as string) : '',
      timestamp: typeof record['timestamp'] === 'string' ? (record['timestamp'] as string) : '',
      requestId: typeof record['request_id'] === 'string' ? (record['request_id'] as string) : '',
    }
  })
}

/** Renders one ring entry in the recorded line format (3.6.3). */
export function formatRingLine(entry: LogLineEntryInput, source: string): string {
  const level = entry.level === 'warning' ? 'warn' : entry.level
  const padded = `${level} `.slice(0, 5)
  const requestId = entry.requestId === '' ? '--------' : entry.requestId
  return `[${entry.timestamp}] [${requestId}] [${padded}] [${source}] ${entry.line}`
}

/** Parses the line-prefix `[YYYY-MM-DD HH:MM:SS` into Unix seconds. */
export function lineTimestampSeconds(line: string): number {
  const match = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]/.exec(line)
  if (match === null) return 0
  return parseLogStampToUnixSeconds(match[1] ?? '')
}

/** Cursor document carried through the `next-cursor` field. */
export interface LogsCursor {
  readonly v: number
  readonly file: string
  readonly offset: number
  readonly size: number
  readonly modTime: number
  readonly modTimeUnixNano: number
  readonly latestTimestamp: number
  readonly fingerprint: string
}

const MAIN_LOG = 'main.log'
const encoder = new TextEncoder()

/** Cursor fingerprint over the window boundary bytes (3.6.2). */
async function fingerprintOf(window: string, boundary: number): Promise<string> {
  const bytes = encoder.encode(window)
  const head = bytes.slice(0, Math.min(4096, Math.max(0, boundary)))
  const tailStart = Math.max(0, Math.min(bytes.length, boundary))
  const tail = bytes.slice(Math.max(0, bytes.length - 4096))
  const material = encoder.encode(`log-cursor-v1:${boundary}:${new TextDecoder().decode(head)}:${tailStart}:${new TextDecoder().decode(tail)}`)
  const digest = await sha256Bytes(material)
  return base64UrlEncode(digest.slice(0, 12))
}

/** Builds the opaque base64url cursor for the current window. */
export async function buildCursor(
  windowBytes: number,
  latestTimestamp: number,
  nowMs: number,
): Promise<string> {
  const cursor: LogsCursor = {
    v: 1,
    file: MAIN_LOG,
    offset: windowBytes,
    size: windowBytes,
    modTime: Math.floor(nowMs / 1000),
    modTimeUnixNano: nowMs * 1_000_000,
    latestTimestamp,
    fingerprint: await fingerprintOf('', 0),
  }
  return base64UrlEncode(encoder.encode(JSON.stringify(cursor)))
}

/** Decodes + validates a cursor; invalid cursors answer `undefined`. */
export function decodeCursor(text: string): LogsCursor | undefined {
  let parsed: unknown
  try {
    const bytes = base64UrlDecode(text)
    parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const record = parsed as Record<string, unknown>
  if (record['v'] !== 1) return undefined
  const file = typeof record['file'] === 'string' ? (record['file'] as string) : ''
  if (file !== MAIN_LOG && !/^main\.log(\.\d+)?$/.test(file) && !/^main-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.log(\.gz)?$/.test(file)) {
    return undefined
  }
  const offset = typeof record['offset'] === 'number' ? (record['offset'] as number) : -1
  const size = typeof record['size'] === 'number' ? (record['size'] as number) : -1
  if (offset < 0 || size < 0) return undefined
  const fingerprint = typeof record['fingerprint'] === 'string' ? (record['fingerprint'] as string) : ''
  if (fingerprint === '') return undefined
  return {
    v: 1,
    file,
    offset,
    size,
    modTime: typeof record['modTime'] === 'number' ? (record['modTime'] as number) : 0,
    modTimeUnixNano: typeof record['modTimeUnixNano'] === 'number' ? (record['modTimeUnixNano'] as number) : 0,
    latestTimestamp: typeof record['latestTimestamp'] === 'number' ? (record['latestTimestamp'] as number) : 0,
    fingerprint,
  }
}

/** Formats a wall-clock stamp for a ring line emitted now. */
export function stampFor(nowMs: number, zoneOffsetMinutes: number): string {
  return formatLogStamp(nowMs, zoneOffsetMinutes)
}
