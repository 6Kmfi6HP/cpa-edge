
/**
 * Test-only reader for the oracle-recorded S2d9 goldens
 * (tests/fixtures/S2d9, RECIPES layout). Runtime code never imports this
 * module; the vitest suites use it to replay recorded cases.
 */
import { existsSync, readFileSync } from 'node:fs'

export const FIXTURE_ROOT = 'tests/fixtures/S2d9'

/** Ordered client request of one recorded case. */
export interface RecordedRequest {
  readonly method: string
  readonly path: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}

/** One upstream wire record (a line of upstream.jsonl). */
export interface RecordedUpstream {
  readonly method: string
  readonly path: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}

/** Downstream response of one recorded case (status + exact body bytes). */
export interface RecordedDownstream {
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
  /** Exact byte stream for SSE cases (already decoded from the chunked log). */
  readonly stream: string | undefined
}

/** Scripted mock behavior of one recorded case. */
export interface RecordedMock {
  readonly mode: string
  /** Scripted SSE reply bytes (happy / in-stream-error / disconnect cases). */
  readonly sseScript: string | undefined
  /** Split write schedule of the slow-chunks case (bytes, in order). */
  readonly writes: readonly string[] | undefined
  /** Scripted HTTP-level error (status + body + content type). */
  readonly httpError: { readonly status: number; readonly contentType: string; readonly body: string } | undefined
  /** Canned compact reply bytes. */
  readonly compactReply: string | undefined
}

export interface RecordedCase {
  readonly id: string
  readonly request: RecordedRequest
  readonly upstream: readonly RecordedUpstream[]
  readonly downstream: RecordedDownstream
  readonly mock: RecordedMock
  /** Client sent a body `prompt_cache_key` (literal compare; else masked). */
  readonly clientPromptCacheKey: boolean
  /** Recorded config fragment facts the replay needs. */
  readonly config: {
    readonly apiKeys: readonly string[]
    readonly credentials: readonly {
      readonly apiKey: string
      readonly baseUrl: string
      readonly models: readonly { readonly name: string; readonly alias: string; readonly forceMapping?: boolean }[]
    }[]
  }
}

/** Reads one fixture case; throws when a required file is missing. */
export function readCase(id: string): RecordedCase {
  const dir = `${FIXTURE_ROOT}/${id}`
  const meta = parseJsonFile(`${dir}/meta.yaml`)
  const request = parseRequestFile(readText(`${dir}/request.http`))
  const downstream = parseDownstreamFile(readText(`${dir}/downstream.md`))
  const upstream = parseUpstreamFile(readText(`${dir}/upstream.jsonl`))
  const mock = parseMockFile(`${dir}/mock-response.json`)
  const clientPromptCacheKey =
    typeof request.body === 'string' && request.body.includes('"prompt_cache_key"')

  const configFragment = typeof meta['config_fragment'] === 'string' ? (meta['config_fragment'] as string) : ''
  const apiKeyMatch = /api-key: "([^"]+)"/.exec(configFragment)
  const baseUrlMatch = /base-url: "([^"]+)"/.exec(configFragment)
  const models: Array<{ name: string; alias: string; forceMapping?: boolean }> = []
  const modelRegex = /- name: "([^"]+)"\s*\n\s+alias: "([^"]+)"(?:\s*\n\s+force-mapping: true)?/g
  let modelMatch: RegExpExecArray | null
  while ((modelMatch = modelRegex.exec(configFragment)) !== null) {
    const entry: { name: string; alias: string; forceMapping?: boolean } = {
      name: modelMatch[1] ?? '',
      alias: modelMatch[2] ?? '',
    }
    if (/\n\s+force-mapping: true/.test(modelMatch[0])) entry.forceMapping = true
    models.push(entry)
  }
  const apiKeysMatch = /api-keys:\s*\n((?:\s+- "[^"]+"\s*\n?)+)/.exec(configFragment)

  return {
    id,
    request,
    upstream,
    downstream,
    mock,
    clientPromptCacheKey,
    config: {
      apiKeys:
        apiKeysMatch === null
          ? ['oracle-local-key-1']
          : [...(apiKeysMatch[1] ?? '').matchAll(/"([^"]+)"/g)].map((found) => found[1] ?? ''),
      credentials: [
        {
          apiKey: apiKeyMatch?.[1] ?? 'mock-codex-key-1',
          baseUrl: baseUrlMatch?.[1] ?? 'http://host.docker.internal:20003',
          models: models.length > 0 ? models : [{ name: 'mock-codex-upstream', alias: 'codex-mock' }],
        },
      ],
    },
  }
}

function parseJsonFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {}
  const parsed: unknown = JSON.parse(readText(path))
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
}

function readText(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
}

function parseRequestFile(text: string): RecordedRequest {
  const boundary = text.indexOf('\n\n')
  const head = boundary === -1 ? text : text.slice(0, boundary)
  let rest = boundary === -1 ? '' : text.slice(boundary + 2)
  while (rest.startsWith('\n')) rest = rest.slice(1)
  const body = rest.endsWith('\n') ? rest.slice(0, -1) : rest
  const lines = head.split('\n')
  const requestLine = lines[0] ?? ''
  const parts = requestLine.split(' ')
  const headers: Record<string, string> = {}
  for (const line of lines.slice(1)) {
    const separator = line.indexOf(': ')
    if (separator <= 0) continue
    headers[line.slice(0, separator)] = line.slice(separator + 2)
  }
  return { method: parts[0] ?? '', path: parts[1] ?? '', headers, body }
}

function parseUpstreamFile(text: string): readonly RecordedUpstream[] {
  const records: RecordedUpstream[] = []
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue
    const parsed = JSON.parse(line) as Record<string, unknown>
    records.push({
      method: typeof parsed['method'] === 'string' ? (parsed['method'] as string) : '',
      path: typeof parsed['path'] === 'string' ? (parsed['path'] as string) : '',
      headers:
        typeof parsed['headers'] === 'object' && parsed['headers'] !== null
          ? (parsed['headers'] as Record<string, string>)
          : {},
      body: typeof parsed['body'] === 'string' ? (parsed['body'] as string) : '',
    })
  }
  return records
}

function parseDownstreamFile(text: string): RecordedDownstream {
  const statusMatch = /## Status line\nHTTP\/1\.1 (\d+)/.exec(text)
  const status = statusMatch === null ? 0 : Number(statusMatch[1])
  const headers: Record<string, string> = {}
  const headerMatch = /## Response headers[^\n]*\n([\s\S]*?)\n\n/.exec(text)
  if (headerMatch !== null) {
    for (const line of (headerMatch[1] ?? '').split('\n')) {
      const separator = line.indexOf(': ')
      if (separator <= 0) continue
      headers[line.slice(0, separator)] = line.slice(separator + 2)
    }
  }
  const bodyMatch = /## Body(?: \/ byte stream)?[^\n]*\n```\n([\s\S]*?)\n```/.exec(text)
  // The fenced body is the exact bytes plus ONE trailing newline.
  const body = bodyMatch === null ? '' : stripOneTrailingNewline(bodyMatch[1] ?? '')
  const stream = text.includes('chunked framing preserved') ? body : undefined
  return { status, headers, body, stream }
}

function stripOneTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text.slice(0, -1) : text
}

function parseMockFile(path: string): RecordedMock {
  if (!existsSync(path)) return { mode: 'none', sseScript: undefined, writes: undefined, httpError: undefined, compactReply: undefined }
  const parsed = parseJsonFile(path)
  const mode = typeof parsed['mode'] === 'string' ? (parsed['mode'] as string) : ''
  const sseScript = typeof parsed['sse_script_exact_bytes'] === 'string' ? (parsed['sse_script_exact_bytes'] as string) : undefined
  const writesRaw = parsed['writes']
  const writes =
    typeof writesRaw === 'object' && writesRaw !== null && Array.isArray((writesRaw as { writes?: unknown })['writes'])
      ? ((writesRaw as { writes: Array<{ bytes?: unknown }> })['writes'] ?? []).map((write) =>
          typeof write['bytes'] === 'string' ? (write['bytes'] as string) : '',
        )
      : undefined
  const httpErrorRaw = parsed['http_error']
  const httpError =
    typeof httpErrorRaw === 'object' && httpErrorRaw !== null
      ? (() => {
          const error = httpErrorRaw as { status?: unknown; content_type?: unknown; body?: unknown }
          return {
            status: typeof error['status'] === 'number' ? (error['status'] as number) : 500,
            contentType: typeof error['content_type'] === 'string' ? (error['content_type'] as string) : 'application/json',
            body: typeof error['body'] === 'string' ? (error['body'] as string) : '',
          }
        })()
      : undefined
  const compactReply =
    typeof parsed['compact_reply_exact_bytes'] === 'string' ? (parsed['compact_reply_exact_bytes'] as string) : undefined
  return { mode, sseScript, writes, httpError, compactReply }
}
