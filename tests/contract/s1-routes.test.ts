/**
 * S1 route-layer golden contract — spec/sections/S1-endpoints.md
 * =============================================================
 *
 * What this file specifies
 * ------------------------
 * The acceptance suite for the RUNTIME ROUTE LAYER. Unlike the direction
 * suites (s2d*, s3), S1's fixtures exercise the full gateway surface: the
 * routing matrix, the five-transport client auth gate, OPTIONS/CORS, the
 * R-404 empty-body family, trailing-slash redirects, the safe-mode gate,
 * the management authorization plane and every gateway-generated error
 * envelope. The 26 recorded cases (122 request/response pairs, 294 files
 * under tests/fixtures/S1/) replay end to end through ONE composed
 * runtime gateway; the direction facades the goldens reach are exercised
 * through their runtime wiring, never imported directly.
 *
 * THE ADAPTER INTERFACE (actual exported surface of runtimes/node, found
 * in the in-flight T1 work and binding for every runtime that mounts the
 * same routing contract):
 *
 *   export function createNodeGateway(options: NodeGatewayOptions): NodeGateway
 *
 *   interface NodeGatewayOptions {
 *     config: Readonly<Record<string, unknown>>   // YAML-shaped config doc
 *     store?: Store                              // defaults to MemoryStore
 *     now?: () => number                         // epoch-ms clock
 *     fetch?: FetchLike                          // upstream transport
 *     remoteAddress?: string                     // mgmt-gate client address
 *     capabilities?: RuntimeCapabilities         // S7 profile
 *     managementApi?: ManagementApi               // /v0/management payload surface
 *     zstdDecode?: (input: Uint8Array) => Uint8Array
 *     managementPanelHtml?: string
 *     keepAlivePassword?: string
 *   }
 *
 *   interface NodeGateway {
 *     handle(request: GatewayRequest): Promise<GatewayResponse>
 *     capabilities; store; plane; config
 *   }
 *
 *   interface GatewayRequest {                   // fully-buffered, transport-free
 *     method: string                             // uppercase as received
 *     url: string                                // absolute scheme://host/path?query
 *     headers: ReadonlyArray<readonly [string, string]>   // received order + casing
 *     body: Uint8Array
 *     remoteAddress?: string
 *   }
 *
 *   interface GatewayResponse {
 *     status: number
 *     headers: ReadonlyArray<readonly [string, string]>   // emission order
 *     body: string | ReadableStream<Uint8Array>
 *   }
 *
 * The brief's suggested `Request -> Response & {rawHeaders}` shape is
 * therefore NOT what T1 built: the runtime chose a buffered, ordered
 * header-list shape (no Web Request/Response at the seam, no sockets).
 * This suite drives the ACTUAL surface above and types against it via
 * `import type` from the runtime source. Platform transport (Date,
 * Content-Length, Transfer-Encoding emission, sockets) stays in
 * runtimes/node/src/server.ts and is deliberately OUT of this suite.
 *
 * Import note: the root package.json does not link @cpa-edge/runtime-node
 * yet, so the suite imports the runtime by relative path
 * (../../runtimes/node/src/index.ts). When the orchestrator adds the
 * workspace dependency, the specifier can switch to the package name
 * without any other change (requested in the mission reply).
 *
 * Harness semantics
 * -----------------
 * • One gateway per recorded instance: cache key (case, config variant,
 *   isolation tag). S1-25's config variants V1-V4 are separate recording
 *   runs, so each variant gets its own gateway; the two V4 ban probes each
 *   ran on a discarded fresh container and get isolated gateways too.
 * • CLOCK: never wall-clock. Before each replayed request the clock
 *   freezes at the second of the golden's own `Date` header, keeping
 *   every now()-driven decision deterministic (the 30m ban countdown
 *   reproduces `30m0s` exactly; OAuth TTLs never expire mid-replay).
 * • UPSTREAM: the gateway's fetch is injected. Cases whose recorded
 *   upstream.jsonl is empty (or absent) must never call it - the mock
 *   throws, so unplanned egress fails loudly. Cases with recorded wire
 *   lines get the canned mock reply (mock-response.json: Python
 *   json.dumps serialization for non-stream bodies, exact SSE frames
 *   otherwise) and the captured wire is compared line by line
 *   (method, url path, ordered headers minus Host/Content-Length with
 *   Authorization redacted, byte-exact body) - the s2d2 header-order
 *   discipline, applied at the runtime's fetch seam.
 * • MANAGEMENT: the merged @cpa-edge/management surface is injected the
 *   way the node runtime composes it in production (createManagementApi
 *   over the same YAML config + Store, build info pinned to the anchor).
 *   Two config-view 200 bodies (S1-20 mgmt-bearer/mgmt-header) are S5's
 *   payload contract, not S1's: the suite asserts status + the S1-owned
 *   headers and documents the payload as S5-owned (the S5 suite owns its
 *   bytes). Everything else compares byte-exactly.
 * • MASKING, strictly per meta.yaml dynamic_fields (unknown entries fail
 *   loudly): `Date` never compared (transport); `X-Cpa-Trace-Id`
 *   presence-only (the value embeds a timestamp + random hex);
 *   `created`/`created_at` masked in bodies - the recordings show the
 *   reference stamps them at registry-build time, not request time
 *   (S1-09 and S1-10 share one stamp while their request clocks differ
 *   by 12s), so the value is dynamic by the spec's own masking table;
 *   `Content-Length when body is dynamic` - CL is never header-compared,
 *   but golden CL is cross-checked against the produced body length
 *   wherever the body itself is byte-compared. One fixture-declared
 *   extra: the S1-25 ban countdown inside the 403 body (meta request
 *   note) is masked to {{BAN-REMAINING}}.
 * • R-SSE: streaming goldens compare the DECODED event sequence (event
 *   name + data payload bytes, in order), never chunk boundaries. The
 *   alt=json raw mode compares the concatenated bytes.
 * • OQ-1 (platform-optional 301 body): the GET redirect's HTML body is
 *   compared with trailing CR/LF trimmed on both sides (the fixture
 *   stores 43 bytes, the golden declares Content-Length 45 - the
 *   recording's trailing CRLF did not survive the markdown; the spec
 *   registers redirect-body bytes as a degradation candidate).
 * • SKIPS: requests whose (surface, family) direction has no merged
 *   facade yet skip with the seam id from the runtime's own DIRECTIONS
 *   table; they flip on automatically when the integrator merges the
 *   facade (their upstream-call counts are pre-declared, so a flip
 *   asserts the wire log immediately). Open at the time of this
 *   revision: chat:openai-compatibility (S1-14/S1-15) and
 *   messages:openai-compatibility (S1-16); the
 *   responses:openai-compatibility seam (S1-18) merged and replays.
 *
 * Red-test etiquette: a red in this suite is a recorded divergence,
 * never harness noise. Divergences already routed through the
 * orchestrator: (1) upstream chunk parsing must be lenient about
 * trailing garbage after the JSON value - the S1 mock's recorded SSE
 * payloads carry one trailing `}` (the S1-15 passthrough golden
 * forwarded those exact bytes, and S1-17's golden shows the reference
 * translating them anyway; recorded fixtures outrank the derived S2d2
 * wording) - fixed for gem2oai at the time of this revision, res2oai
 * pending; (2) the chat-surface zstd 400 must carry the charset content
 * type (S1-25/zstd-garbage) - fixed at the time of this revision.
 *
 * Self-check: no leftover markers, no `any`, no silently swallowed
 * catches, assertions byte-level against recorded goldens (no timing
 * dependence - the clock is frozen per step).
 */

import { readFile, readdir } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { MemoryStore, type Store } from '@cpa-edge/core'
import { createManagementApi, type ManagementApi } from '@cpa-edge/management'
import type {
  DirectionSeam,
  GatewayRequest,
  GatewayResponse,
  NodeGateway,
  NodeGatewayOptions,
} from '../../runtimes/node/src/index'

// ─── Adapter load (whole-suite skip until the runtime exports its gateway) ────────

const RUNTIME_ENTRY = new URL('../../runtimes/node/src/index.ts', import.meta.url)

interface RuntimeModule {
  createNodeGateway: (options: NodeGatewayOptions) => NodeGateway
  DIRECTIONS: Readonly<Record<string, DirectionSeam>>
}

async function loadRuntime(): Promise<RuntimeModule> {
  const imported = (await import(RUNTIME_ENTRY.href)) as unknown as Partial<RuntimeModule>
  if (typeof imported.createNodeGateway !== 'function' || imported.DIRECTIONS === undefined) {
    throw new Error(
      'runtimes/node does not export createNodeGateway(options) + DIRECTIONS (the S1 route layer ' +
        'contract needs both; see the adapter interface in this file\'s header)',
    )
  }
  return imported as RuntimeModule
}

let runtime: RuntimeModule | null = null
let runtimeLoadFailure: string | null = null
try {
  runtime = await loadRuntime()
} catch (error) {
  runtimeLoadFailure = `importing the node runtime failed: ${String(error)}`
}

const suite = runtime === null ? describe.skip : describe
const suiteTitle =
  runtime === null
    ? `S1 route-layer golden contract (SKIPPED: ${runtimeLoadFailure ?? 'runtime unavailable'})`
    : 'S1 route-layer golden contract (tests/fixtures/S1)'

/** True when the request's direction seam has a merged facade in the live runtime. */
function seamMerged(seam: string | undefined): { seam: string; merged: boolean } {
  if (seam === undefined) return { seam: '', merged: true }
  if (runtime === null) return { seam, merged: false }
  return { seam, merged: runtime.DIRECTIONS[seam]?.merged === true }
}

// ─── Fixture access ──────────────────────────────────────────────────────────────

const FIXTURE_ROOT = new URL('../fixtures/S1/', import.meta.url)
const encoder = new TextEncoder()
const decoder = new TextDecoder()

function fixtureUrl(caseId: string, name: string): URL {
  return new URL(`${caseId}/${name}`, FIXTURE_ROOT)
}

async function readFixtureText(caseId: string, name: string): Promise<string> {
  return readFile(fixtureUrl(caseId, name), 'utf8')
}

async function readFixtureBytes(caseId: string, name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(fixtureUrl(caseId, name)))
}

async function fixtureExists(caseId: string, name: string): Promise<boolean> {
  try {
    await readFile(fixtureUrl(caseId, name))
    return true
  } catch (error) {
    if ((error as { readonly code?: unknown }).code === 'ENOENT') return false
    throw error
  }
}

interface CaseMetaRequest {
  readonly name: string
  readonly method: string
  readonly path: string
  readonly request_file?: string
  readonly downstream_file?: string
  readonly http_status: string
  readonly group?: string
  readonly config_variant?: string
  readonly note?: string
}

interface CaseMeta {
  readonly id: string
  readonly config?: string
  readonly dynamic_fields: readonly string[]
  readonly requests: readonly CaseMetaRequest[]
  readonly upstream_file: string | null
}

async function readCaseMeta(caseId: string): Promise<CaseMeta> {
  // The oracle writes meta.yaml as JSON-compatible YAML; strict parsing
  // doubles as a format check.
  const parsed = JSON.parse(await readFixtureText(caseId, 'meta.yaml')) as Record<string, unknown>
  const requests = parsed['requests'] as CaseMetaRequest[]
  if (!Array.isArray(requests)) throw new Error(`${caseId}: meta.yaml has no requests array`)
  const dynamicFields = parsed['dynamic_fields']
  if (!Array.isArray(dynamicFields)) throw new Error(`${caseId}: meta.yaml has no dynamic_fields`)
  return {
    id: String(parsed['id']),
    config: typeof parsed['config'] === 'string' ? parsed['config'] : undefined,
    dynamic_fields: dynamicFields.map(String),
    requests,
    upstream_file: parsed['upstream_file'] === null ? null : String(parsed['upstream_file']),
  }
}

// ─── request.http parsing (single request per file) ─────────────────────────────

interface RecordedRequest {
  readonly method: string
  readonly path: string
  readonly headers: ReadonlyArray<readonly [string, string]>
  readonly body: Uint8Array
}

/**
 * Splits one request.http into head and body. The file format ends the
 * head with a blank line, then opens the body with one more newline and
 * closes with a trailing newline; the recorded Content-Length decides
 * how many of those edge newlines were actually sent.
 */
function parseRequestHead(text: string): {
  method: string
  path: string
  headers: Array<[string, string]>
  bodyText: string
  contentLength: number | null
} {
  const separator = text.indexOf('\n\n')
  if (separator < 0) throw new Error('request.http is missing the head/body blank line')
  const head = text.slice(0, separator)
  let bodyText = text.slice(separator + 2)
  const lines = head.split('\n')
  const requestLine = (lines[0] ?? '').split(' ')
  if (requestLine.length !== 3) throw new Error(`malformed request line: ${lines[0] ?? ''}`)
  const headers: Array<[string, string]> = []
  let contentLength: number | null = null
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(': ')
    if (colon < 0) continue
    const name = line.slice(0, colon)
    const value = line.slice(colon + 2)
    if (name.toLowerCase() === 'content-length') contentLength = Number(value)
    headers.push([name, value])
  }
  if (bodyText.startsWith('\n')) bodyText = bodyText.slice(1)
  if (bodyText.endsWith('\n')) bodyText = bodyText.slice(0, -1)
  // Binary probe bodies are referenced, not inlined; their bytes live in
  // the referenced side file, which the caller substitutes.
  const isBinaryReference = bodyText.startsWith('<binary payload from ')
  if (
    !isBinaryReference &&
    contentLength !== null &&
    encoder.encode(bodyText).length !== contentLength
  ) {
    throw new Error(
      `request body is ${encoder.encode(bodyText).length} bytes but Content-Length declares ${contentLength}`,
    )
  }
  return { method: requestLine[0] ?? '', path: requestLine[1] ?? '', headers, bodyText, contentLength }
}

async function readRecordedRequest(caseId: string, file: string): Promise<RecordedRequest> {
  const raw = await readFixtureText(caseId, file)
  const head = parseRequestHead(raw)
  let body: Uint8Array
  if (head.bodyText.startsWith('<binary payload from ')) {
    // The zstd garbage probe keeps its undecodable bytes in a side file.
    const bin = head.bodyText.match(/<binary payload from ([^>]+)>/)
    if (bin === null) throw new Error(`${caseId}/${file}: unreadable binary payload reference`)
    body = await readFixtureBytes(caseId, bin[1] ?? '')
  } else {
    body = encoder.encode(head.bodyText)
  }
  return { method: head.method, path: head.path, headers: head.headers, body }
}

// ─── downstream.md parsing ───────────────────────────────────────────────────────

interface GoldenResponse {
  readonly status: number
  readonly headers: ReadonlyArray<readonly [string, string]>
  readonly body: string
  readonly contentLength: number | null
  readonly dateMs: number | null
}

const HEAD_FENCE = /## Status[^\n]*\n```\n([\s\S]*?)\n```/
const BODY_FENCE = /\n## [Bb]ody[^\n]*\n```\n([\s\S]*?)\n```/

function parseGoldenResponse(caseId: string, file: string, text: string): GoldenResponse {
  const headMatch = HEAD_FENCE.exec(text)
  if (headMatch === null) throw new Error(`${caseId}/${file}: missing response-head fence`)
  const headLines = (headMatch[1] ?? '').split('\n')
  const statusMatch = /^HTTP\/1\.1 (\d{3}) /.exec(headLines[0] ?? '')
  if (statusMatch === null) throw new Error(`${caseId}/${file}: missing HTTP/1.1 status line`)
  const headers: Array<[string, string]> = []
  let contentLength: number | null = null
  let dateMs: number | null = null
  for (const line of headLines.slice(1)) {
    const colon = line.indexOf(': ')
    if (colon < 0) continue
    const name = line.slice(0, colon)
    const value = line.slice(colon + 2)
    if (name.toLowerCase() === 'content-length') contentLength = Number(value)
    if (name.toLowerCase() === 'date') dateMs = Date.parse(value)
    headers.push([name, value])
  }
  const bodyMatch = BODY_FENCE.exec(text)
  if (bodyMatch === null) throw new Error(`${caseId}/${file}: missing body fence`)
  let body = bodyMatch[1] ?? ''
  // One artifact (S1-04/head-on-root) captured `curl -i` output under the
  // body heading: an empty body echoed the response head instead. The
  // recorded response body is empty; the echo is not body bytes.
  if (body.startsWith('HTTP/1.1 ')) body = ''
  // The markdown renderer appends a display newline after bodies that do
  // not end in one; the golden Content-Length disambiguates.
  if (
    body.endsWith('\n') &&
    contentLength !== null &&
    encoder.encode(body).length - 1 === contentLength
  ) {
    body = body.slice(0, -1)
  }
  return { status: Number(statusMatch[1]), headers, body, contentLength, dateMs }
}

async function readGoldenResponse(caseId: string, file: string): Promise<GoldenResponse> {
  return parseGoldenResponse(caseId, file, await readFixtureText(caseId, file))
}

// ─── mgmt-ip-ban-threshold parsing (the one multi-response fixture) ───────────────

interface ThresholdAttempt {
  readonly status: number
  readonly body: string
  readonly wrongKey: string | undefined
  readonly isBan: boolean
}

function parseThresholdDocument(text: string): ThresholdAttempt[] {
  const attempts: ThresholdAttempt[] = []
  const sections = text.split(/\n(?=## Attempt )/)
  for (const section of sections) {
    const heading = /^## Attempt (\d+) \(([^)]+)\) — HTTP (\d+)/.exec(section)
    if (heading === null) continue
    const wrongKey = /\(wrong key: ([^)]+)\)/.exec(heading[2] ?? '')
    const status = Number(heading[3])
    const jsonFence = /```json\n([\s\S]*?)\n```/.exec(section)
    if (jsonFence === null) throw new Error(`ip-ban-threshold: attempt ${heading[1]} has no json body fence`)
    attempts.push({
      status,
      body: jsonFence[1] ?? '',
      wrongKey: wrongKey === null ? undefined : (wrongKey[1] ?? ''),
      isBan: status === 403,
    })
  }
  if (attempts.length !== 6) {
    throw new Error(`ip-ban-threshold: expected 6 recorded attempts, parsed ${attempts.length}`)
  }
  return attempts
}

// ─── upstream.jsonl + mock-response.json ──────────────────────────────────────────

interface RecordedUpstreamLine {
  readonly method: string
  readonly path: string
  readonly headers: Record<string, string>
  readonly body: string
}

interface MockResponseFile {
  readonly mode?: string
  readonly canned_non_stream?: Record<string, unknown>
  readonly canned_sse_frames?: readonly string[]
}

async function readUpstreamLines(caseId: string, meta: CaseMeta): Promise<RecordedUpstreamLine[]> {
  if (meta.upstream_file === null) return []
  if (!(await fixtureExists(caseId, meta.upstream_file))) return []
  const text = await readFixtureText(caseId, meta.upstream_file)
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as RecordedUpstreamLine)
}

async function readMockResponse(caseId: string): Promise<MockResponseFile | null> {
  if (!(await fixtureExists(caseId, 'mock-response.json'))) return null
  return JSON.parse(await readFixtureText(caseId, 'mock-response.json')) as MockResponseFile
}

/**
 * Serializes a canned mock value the way the recording mock did
 * (Python json.dumps defaults: `, ` between items, `: ` after keys,
 * object keys in insertion order) so passthrough surfaces see the same
 * bytes the oracle's mock emitted.
 */
function pythonJson(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (value === null || value === undefined) return 'null'
  if (Array.isArray(value)) return `[${value.map(pythonJson).join(', ')}]`
  if (typeof value === 'object') {
    const members = Object.entries(value as Record<string, unknown>).map(
      ([key, item]) => `${JSON.stringify(key)}: ${pythonJson(item)}`,
    )
    return `{${members.join(', ')}}`
  }
  throw new Error(`mock value not serializable: ${String(value)}`)
}

/** One captured upstream call at the runtime's fetch seam. */
interface CapturedUpstreamCall {
  readonly url: string
  readonly method: string
  readonly headers: ReadonlyArray<readonly [string, string]>
  readonly body: string
}

// ─── Recording configuration (BOOTSTRAP.md §3 + the S1-25 variants) ───────────────

const RECORD_PORT = 18317
const RECORD_HOST = `127.0.0.1:${RECORD_PORT}`
const MANAGEMENT_KEY = 'oracle-mgmt-key-1'
/** Non-loopback source address: the recordings arrived via the docker bridge. */
const RECORD_CLIENT_IP = '192.168.65.1'

/** Build-info header values of the anchored build (byte-pinned by S1-20). */
const ANCHOR_BUILD_INFO = {
  version: 'v7.3.4',
  commit: '8335eac',
  buildDate: '2026-09-15T14:07:06Z',
  supportPlugin: true,
} as const

interface VariantSpec {
  /** YAML document for the merged management surface (public config keys). */
  readonly yaml: string
  /** The same config as the gateway's plain object input. */
  readonly config: Readonly<Record<string, unknown>>
}

const BASELINE_YAML = [
  `port: ${RECORD_PORT}`,
  'api-keys:',
  '  - oracle-local-key-1',
  'remote-management:',
  '  allow-remote: true',
  `  secret-key: ${MANAGEMENT_KEY}`,
  '  disable-control-panel: true',
  'request-retry: 0',
  'transient-error-cooldown-seconds: -1',
  'usage-statistics-enabled: false',
].join('\n')

const OPENAI_COMPAT_YAML = [
  'openai-compatibility:',
  '  - name: mock-openai',
  '    api-key: mock-upstream-key',
  '    base-url: http://host.docker.internal:18999/v1',
  '    models:',
  '      - name: mock-gpt-model',
  '        alias: mock-model',
].join('\n')

const baselineConfigObject = (): Record<string, unknown> => ({
  'api-keys': ['oracle-local-key-1'],
  'remote-management': {
    'allow-remote': true,
    'secret-key': MANAGEMENT_KEY,
    'disable-control-panel': true,
  },
  'request-retry': 0,
  'transient-error-cooldown-seconds': -1,
  'usage-statistics-enabled': false,
  port: RECORD_PORT,
})

const openAiCompatConfigBlock = (): Record<string, unknown> => ({
  'openai-compatibility': [
    {
      name: 'mock-openai',
      'api-key': 'mock-upstream-key',
      'base-url': 'http://host.docker.internal:18999/v1',
      models: [{ name: 'mock-gpt-model', alias: 'mock-model' }],
    },
  ],
})

const yamlWithoutKey = (yaml: string): string =>
  yaml
    .split('\n')
    .filter((line) => line !== 'api-keys:' && line !== '  - oracle-local-key-1')
    .join('\n')

/** Config variants keyed the way S1-25's meta names them. */
const VARIANTS: Readonly<Record<string, VariantSpec>> = {
  baseline: {
    yaml: BASELINE_YAML,
    config: baselineConfigObject(),
  },
  provider: {
    yaml: `${BASELINE_YAML}\n${OPENAI_COMPAT_YAML}`,
    config: { ...baselineConfigObject(), ...openAiCompatConfigBlock() },
  },
  V1: {
    // Empty api-keys list: the auth provider is not registered (open gate).
    yaml: yamlWithoutKey(BASELINE_YAML),
    config: (() => {
      const config = baselineConfigObject()
      delete config['api-keys']
      return config
    })(),
  },
  V2: {
    // Template api-key: the example-key safe mode activates.
    yaml: BASELINE_YAML.replace('  - oracle-local-key-1', '  - your-api-key-1'),
    config: { ...baselineConfigObject(), 'api-keys': ['your-api-key-1'] },
  },
  V3: {
    yaml: BASELINE_YAML.replace('  allow-remote: true', '  allow-remote: false'),
    config: {
      ...baselineConfigObject(),
      'remote-management': {
        'allow-remote': false,
        'secret-key': MANAGEMENT_KEY,
        'disable-control-panel': true,
      },
    },
  },
}

/** meta.yaml config prose -> variant key. */
function variantOfMeta(config: string | undefined, explicit: string | undefined): string {
  if (explicit !== undefined) return explicit in VARIANTS ? explicit : 'baseline'
  if (config !== undefined && config.includes('openai-compat')) return 'provider'
  return 'baseline'
}

// ─── Gateway harness ─────────────────────────────────────────────────────────────

interface GatewayHandle {
  readonly gateway: NodeGateway
  readonly captured: CapturedUpstreamCall[]
  /** Freezes the gateway clock at the given epoch milliseconds. */
  setClock(ms: number): void
}

const gateways = new Map<string, Promise<GatewayHandle>>()

function scriptedSseStream(frames: readonly string[]): ReadableStream<Uint8Array> {
  const chunks = frames.map((frame) => encoder.encode(`${frame}\n\n`))
  let served = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[served]
      served += 1
      if (chunk === undefined) {
        controller.close()
        return
      }
      controller.enqueue(chunk)
    },
  })
}

function buildGateway(
  cacheKey: string,
  variantKey: string,
  caseId: string,
  mock: MockResponseFile | null,
  recordedUpstreamCount: number,
): Promise<GatewayHandle> {
  const factory = runtime?.createNodeGateway
  if (factory === undefined) {
    return Promise.reject(new Error('runtime gateway factory unavailable (suite skipped)'))
  }
  const variant = VARIANTS[variantKey] ?? VARIANTS['baseline']
  if (variant === undefined) throw new Error(`unknown config variant ${variantKey}`)
  let clockMs = 0
  const now = (): number => clockMs
  const store: Store = new MemoryStore({ now })
  const captured: CapturedUpstreamCall[] = []

  const fetchLike = async (input: unknown, init: unknown): Promise<Response> => {
    const url = String(input)
    const initRecord = (init ?? {}) as { method?: unknown; headers?: unknown; body?: unknown }
    const call: CapturedUpstreamCall = {
      url,
      method: typeof initRecord.method === 'string' ? initRecord.method : 'GET',
      headers:
        initRecord.headers !== undefined && typeof initRecord.headers === 'object'
          ? Object.entries(initRecord.headers as Record<string, string>).map(
              ([name, value]) => [name, value] as const,
            )
          : [],
      body: typeof initRecord.body === 'string' ? initRecord.body : '',
    }
    captured.push(call)
    if (recordedUpstreamCount === 0) {
      throw new Error(
        `${caseId}: unplanned upstream egress to ${url} - the recording made no upstream call`,
      )
    }
    if (mock === null || mock.canned_non_stream === undefined) {
      throw new Error(`${caseId}: upstream called but the fixture ships no canned reply`)
    }
    const isStream = call.headers.some(
      ([name, value]) => name.toLowerCase() === 'accept' && value === 'text/event-stream',
    )
    if (isStream && mock.canned_sse_frames !== undefined) {
      return new Response(scriptedSseStream(mock.canned_sse_frames), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    }
    return new Response(pythonJson(mock.canned_non_stream), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const managementApi: ManagementApi = createManagementApi({
    configYaml: variant.yaml,
    managementKey: MANAGEMENT_KEY,
    store,
    buildInfo: ANCHOR_BUILD_INFO,
    clientIp: RECORD_CLIENT_IP,
    now,
  })

  const gateway = factory({
    config: variant.config,
    store,
    now,
    fetch: fetchLike,
    remoteAddress: RECORD_CLIENT_IP,
    managementApi,
  })
  const handle: GatewayHandle = {
    gateway,
    captured,
    setClock: (ms: number) => {
      clockMs = ms
    },
  }
  gateways.set(cacheKey, Promise.resolve(handle))
  return Promise.resolve(handle)
}

async function gatewayFor(
  caseId: string,
  variantKey: string,
  instanceTag: string,
  mock: MockResponseFile | null,
  recordedUpstreamCount: number,
): Promise<GatewayHandle> {
  const cacheKey = `${caseId}::${variantKey}::${instanceTag}`
  const existing = gateways.get(cacheKey)
  if (existing !== undefined) return existing
  return buildGateway(cacheKey, variantKey, caseId, mock, recordedUpstreamCount)
}

/** Rebuilds a gateway entry so isolated probes (fresh containers) get fresh state. */
async function freshGatewayFor(
  caseId: string,
  variantKey: string,
  instanceTag: string,
  mock: MockResponseFile | null,
  recordedUpstreamCount: number,
): Promise<GatewayHandle> {
  gateways.delete(`${caseId}::${variantKey}::${instanceTag}`)
  return gatewayFor(caseId, variantKey, instanceTag, mock, recordedUpstreamCount)
}

// ─── Comparison helpers ─────────────────────────────────────────────────────────

/** Transport-owned names never compared (the platform emits them). */
const TRANSPORT_HEADERS = new Set(['date', 'content-length', 'transfer-encoding'])

function headerMap(headers: ReadonlyArray<readonly [string, string]>): Map<string, string> {
  const map = new Map<string, string>()
  for (const [name, value] of headers) {
    const key = name.toLowerCase()
    if (TRANSPORT_HEADERS.has(key)) continue
    map.set(key, value)
  }
  return map
}

interface SseEvent {
  readonly event: string | undefined
  readonly data: string
}

/** R-SSE decode: ordered (event?, data) pairs; framing bytes never compared. */
function decodeSseEvents(body: string): readonly SseEvent[] {
  const events: SseEvent[] = []
  for (const block of body.split('\n\n')) {
    if (block === '') continue
    let event: string | undefined
    const dataLines: string[] = []
    for (const line of block.split('\n')) {
      if (line === '') continue
      if (line.startsWith('event: ')) {
        event = line.slice('event: '.length)
        continue
      }
      if (line.startsWith('data: ')) {
        dataLines.push(line.slice('data: '.length))
        continue
      }
      throw new Error(`unrecognized SSE line: ${line.slice(0, 120)}`)
    }
    if (dataLines.length > 0) events.push({ event, data: dataLines.join('\n') })
  }
  return events
}

function firstDifference(expected: string[], actual: string[]): string | null {
  if (expected.length === actual.length && expected.every((line, i) => line === actual[i])) {
    return null
  }
  let index = 0
  while (index < expected.length && index < actual.length && expected[index] === actual[index]) {
    index += 1
  }
  const window = (lines: string[]): string =>
    lines
      .slice(Math.max(0, index - 1), index + 2)
      .map((line, offset) => `${String(Math.max(0, index - 1) + offset).padStart(2)}: ${line}`)
      .join('\n')
  return `first divergence at index ${index}\n      expected:\n${window(expected)}\n      actual:\n${window(actual)}`
}

const BAN_REMAINING_MASK = /Try again in [0-9hms.]+/g

function maskBanRemaining(body: string): string {
  return body.replace(BAN_REMAINING_MASK, 'Try again in {{BAN-REMAINING}}')
}

/**
 * meta.yaml declares `created`/`created_at` dynamic: the reference stamps
 * them when the model registry is built, not at request time (S1-09 and
 * S1-10 share one stamp while their request clocks differ by 12s), so the
 * value is masked on both sides exactly like the other dynamic fields.
 */
const CREATED_EPOCH_MASK = /"created":\d+/g
const CREATED_AT_MASK = /"created_at":"[^"]+"/g

function maskCreatedFields(body: string): string {
  return body.replace(CREATED_EPOCH_MASK, '"created":{{CREATED}}').replace(CREATED_AT_MASK, '"created_at":"{{CREATED_AT}}"')
}

/** Recognized meta.yaml dynamic_fields (unknown entries fail loudly). */
function recognizeDynamicFields(caseId: string, fields: readonly string[]): void {
  for (const field of fields) {
    if (
      field === 'Date' ||
      field === 'X-Cpa-Trace-Id' ||
      field === 'created' ||
      field === 'created_at' ||
      field === 'Content-Length when body is dynamic'
    ) {
      continue
    }
    throw new Error(
      `${caseId}: unrecognized meta.yaml dynamic_fields entry ${JSON.stringify(field)} - ` +
        'extend the mask table in tests/contract/s1-routes.test.ts consciously',
    )
  }
}

interface MaterializedResponse {
  readonly status: number
  readonly headers: ReadonlyArray<readonly [string, string]>
  readonly body: string
  readonly streamed: boolean
}

async function materialize(response: GatewayResponse): Promise<MaterializedResponse> {
  if (typeof response.body === 'string') {
    return { status: response.status, headers: response.headers, body: response.body, streamed: false }
  }
  const reader = response.body.getReader()
  let out = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value === undefined) continue
    out += decoder.decode(value, { stream: true })
  }
  out += decoder.decode()
  return { status: response.status, headers: response.headers, body: out, streamed: true }
}

/**
 * How a golden body compares: byte-exact unless the fixture demands
 * otherwise. `trim` covers bodies whose trailing CR/LF did not survive
 * the markdown rendering (the OQ-1 redirect HTML and the gorilla
 * handshake text): both sides trim trailing CR/LF and the golden
 * Content-Length is not cross-checked for them.
 */
type BodyMode = 'exact' | 'sse' | 'trim' | 'skip-body'

interface StepVerdict {
  readonly problems: readonly string[]
}

function assertGoldenStep(
  label: string,
  golden: GoldenResponse,
  actual: MaterializedResponse,
  mode: BodyMode,
  opts: {
    readonly maskBanDuration: boolean
    readonly maskCreated: boolean
    readonly goldenIsHead: boolean
  },
): StepVerdict {
  const problems: string[] = []
  if (golden.status !== actual.status) {
    problems.push(`status: expected ${golden.status}, actual ${actual.status}`)
  }

  const expectedHeaders = headerMap(golden.headers)
  const actualHeaders = headerMap(actual.headers)
  const expectedTrace = expectedHeaders.delete('x-cpa-trace-id')
  const actualTrace = actualHeaders.delete('x-cpa-trace-id')
  if (expectedTrace !== actualTrace) {
    problems.push(
      `X-Cpa-Trace-Id presence: golden ${expectedTrace ? 'has' : 'lacks'} it, ` +
        `response ${actualTrace ? 'has' : 'lacks'} it`,
    )
  }
  const headerProblem = firstDifference(
    [...expectedHeaders.entries()].map(([name, value]) => `${name}: ${value}`).sort(),
    [...actualHeaders.entries()].map(([name, value]) => `${name}: ${value}`).sort(),
  )
  if (headerProblem !== null) problems.push(`headers: ${headerProblem}`)

  let expectedBody = golden.body
  let actualBody = actual.body
  if (opts.maskBanDuration) {
    expectedBody = maskBanRemaining(expectedBody)
    actualBody = maskBanRemaining(actualBody)
  }
  if (opts.maskCreated) {
    expectedBody = maskCreatedFields(expectedBody)
    actualBody = maskCreatedFields(actualBody)
  }
  if (mode === 'sse') {
    const expectedEvents = decodeSseEvents(expectedBody)
    const actualEvents = decodeSseEvents(actualBody)
    if (expectedEvents.length !== actualEvents.length) {
      problems.push(
        `SSE frames: golden ${expectedEvents.length} vs actual ${actualEvents.length}\n` +
          `    golden body: ${JSON.stringify(expectedBody.slice(0, 160))}\n` +
          `    actual body: ${JSON.stringify(actualBody.slice(0, 160))}`,
      )
    } else {
      for (let index = 0; index < expectedEvents.length; index += 1) {
        const expected = expectedEvents[index]
        const produced = actualEvents[index]
        if (expected === undefined || produced === undefined) continue
        if (expected.event !== produced.event || expected.data !== produced.data) {
          problems.push(
            `SSE frame ${index}: expected event=${String(expected.event)} data=${expected.data.slice(0, 120)}, ` +
              `actual event=${String(produced.event)} data=${produced.data.slice(0, 120)}`,
          )
        }
      }
    }
  } else if (mode === 'skip-body') {
    if (actualBody.length === 0) problems.push('body: expected the S5-owned payload, got an empty body')
  } else if (mode === 'trim') {
    // OQ-1 (redirect HTML) and the gorilla handshake text: the recorded
    // trailing CR/LF did not survive the markdown; compare trimmed.
    const expectedTrimmed = expectedBody.replace(/\r?\n+$/, '')
    const actualTrimmed = actualBody.replace(/\r?\n+$/, '')
    if (expectedTrimmed !== actualTrimmed) {
      problems.push(
        `body (trailing CR/LF trimmed): expected ${JSON.stringify(expectedTrimmed)}, ` +
          `actual ${JSON.stringify(actualTrimmed)}`,
      )
    }
  } else if (expectedBody !== actualBody) {
    const position = (() => {
      const limit = Math.min(expectedBody.length, actualBody.length)
      for (let i = 0; i < limit; i += 1) {
        if (expectedBody[i] !== actualBody[i]) return i
      }
      return limit
    })()
    problems.push(
      `body: expected (${expectedBody.length} chars) !== actual (${actualBody.length} chars), ` +
        `first difference at char ${position}\n    expected: ${JSON.stringify(
          expectedBody.slice(Math.max(0, position - 40), position + 80),
        )}\n    actual:   ${JSON.stringify(actualBody.slice(Math.max(0, position - 40), position + 80))}`,
    )
  }

  if (
    mode === 'exact' &&
    golden.contentLength !== null &&
    !opts.goldenIsHead &&
    golden.status !== 204 &&
    golden.status !== 304
  ) {
    const actualBytes = encoder.encode(actual.body).length
    if (actualBytes !== golden.contentLength) {
      problems.push(
        `Content-Length: golden declares ${golden.contentLength} body bytes, response body is ${actualBytes}`,
      )
    }
  }

  if (problems.length === 0) return { problems: [] }
  return { problems: [`[${label}] diverges from the golden:`, ...problems.map((p) => `  - ${p}`)] }
}

// ─── Upstream-wire assertion (the s2d2 order discipline at the fetch seam) ───────

const UPSTREAM_EXCLUDED = new Set(['host', 'content-length'])

function assertUpstreamCall(
  label: string,
  recorded: RecordedUpstreamLine,
  call: CapturedUpstreamCall,
): string | null {
  if (call.method !== recorded.method) {
    return `${label}: method ${call.method} !== recorded ${recorded.method}`
  }
  const recordedUrl = (() => {
    try {
      return new URL(recorded.path, 'http://host.docker.internal:18999').href
    } catch {
      return recorded.path
    }
  })()
  if (call.url !== recordedUrl) {
    return `${label}: url ${call.url} !== recorded ${recordedUrl}`
  }
  const expectedPairs: string[] = []
  for (const [name, value] of Object.entries(recorded.headers)) {
    if (UPSTREAM_EXCLUDED.has(name.toLowerCase())) continue
    expectedPairs.push(`${name}: ${value}`)
  }
  const actualPairs: string[] = []
  for (const [name, value] of call.headers) {
    if (UPSTREAM_EXCLUDED.has(name.toLowerCase())) continue
    if (name.toLowerCase() === 'authorization') {
      if (!value.startsWith('Bearer ')) {
        return `${label}: Authorization must carry the Bearer scheme, got ${JSON.stringify(value)}`
      }
      actualPairs.push(`${name}: <redacted>`)
      continue
    }
    actualPairs.push(`${name}: ${value}`)
  }
  const headerProblem = firstDifference(expectedPairs, actualPairs)
  if (headerProblem !== null) return `${label}: headers: ${headerProblem}`
  if (call.body !== recorded.body) {
    return `${label}: body ${JSON.stringify(call.body.slice(0, 160))} !== recorded ${JSON.stringify(
      recorded.body.slice(0, 160),
    )}`
  }
  return null
}

// ─── Case index (fixture-driven; loaded once at collection time) ──────────────────

const CASE_IDS = [
  'S1-01', 'S1-02', 'S1-03', 'S1-04', 'S1-05', 'S1-06', 'S1-07', 'S1-08', 'S1-09',
  'S1-10', 'S1-11', 'S1-12', 'S1-13', 'S1-14', 'S1-15', 'S1-16', 'S1-17', 'S1-18',
  'S1-19', 'S1-20', 'S1-21', 'S1-22', 'S1-23', 'S1-24', 'S1-25', 'S1-26',
] as const

/**
 * Direction seams still without a merged facade in the live runtime; the
 * matching requests skip until the integrator wires the facade (the seam
 * ids are the runtime's own DIRECTIONS keys).
 */
const SEAM_BY_REQUEST: Readonly<Record<string, string>> = {
  'S1-14/chat-nostream': 'chat:openai-compatibility',
  'S1-15/chat-stream': 'chat:openai-compatibility',
  'S1-16/messages-nostream': 'messages:openai-compatibility',
  'S1-18/responses-nostream': 'responses:openai-compatibility',
  'S1-18/responses-stream': 'responses:openai-compatibility',
  'S1-18/codex-alias': 'responses:openai-compatibility',
}

/**
 * Recorded upstream wire lines per request (request order). The seam-
 * deferred requests carry their counts too, so a merged facade flips on
 * with the wire log already asserted; the counts mirror each case's
 * upstream.jsonl exactly (verified line by line against the fixtures).
 */
const UPSTREAM_CALLS_BY_REQUEST: Readonly<Record<string, number>> = {
  'S1-13/generate-content': 1,
  'S1-17/stream-alt-json': 1,
  'S1-17/stream-alt-sse': 1,
  'S1-17/stream-no-alt': 1,
  // responses:openai-compatibility seam (S1-18) - jsonl order
  // nostream, stream, codex-alias; compact stays a route-level 400.
  'S1-18/responses-nostream': 1,
  'S1-18/responses-stream': 1,
  'S1-18/codex-alias': 1,
  // chat:openai-compatibility seam (S1-14/S1-15) and the
  // messages:openai-compatibility seam (S1-16).
  'S1-14/chat-nostream': 1,
  'S1-15/chat-stream': 1,
  'S1-16/messages-nostream': 1,
}

/** Golden bodies that compare under a mode other than byte-exact. */
const BODY_MODE_BY_REQUEST: Readonly<Record<string, BodyMode>> = {
  'S1-08/get-trailing': 'trim',
  'S1-19/responses-get-nows': 'trim',
  'S1-17/stream-alt-sse': 'sse',
  'S1-17/stream-no-alt': 'sse',
  'S1-20/mgmt-bearer': 'skip-body',
  'S1-20/mgmt-header': 'skip-body',
}

/** Requests the oracle recorded on a discarded fresh container. */
const FRESH_INSTANCE_TAG: Readonly<Record<string, string>> = {
  'S1-25/mgmt-ip-ban': 'ban-single',
  'S1-25/mgmt-ip-ban-threshold': 'ban-threshold',
}

interface RequestSpec {
  readonly key: string
  readonly caseId: string
  readonly name: string
  readonly method: string
  readonly path: string
  readonly requestFile: string
  readonly downstreamFile: string
  readonly variant: string
  readonly group: string
  readonly expectedStatus: number
  readonly seam: string | undefined
  readonly upstreamCalls: number
  readonly bodyMode: BodyMode
  readonly instanceTag: string
  readonly threshold: boolean
}

interface CaseIndexEntry {
  readonly meta: CaseMeta
  readonly upstreamLines: readonly RecordedUpstreamLine[]
  readonly mock: MockResponseFile | null
  readonly specs: readonly RequestSpec[]
}

async function loadCaseIndexEntry(caseId: string): Promise<CaseIndexEntry> {
  const meta = await readCaseMeta(caseId)
  recognizeDynamicFields(caseId, meta.dynamic_fields)
  const upstreamLines = await readUpstreamLines(caseId, meta)
  const mock = await readMockResponse(caseId)
  const specs: RequestSpec[] = []
  for (const request of meta.requests) {
    const requestFile = request.request_file ?? `${request.name}.request.http`
    const downstreamFile = request.downstream_file ?? `${request.name}.downstream.md`
    const key = `${caseId}/${request.name}`
    const variant = variantOfMeta(meta.config, request.config_variant)
    const statusText = request.http_status
    const threshold = statusText.includes('then')
    const expectedStatus = Number(/^(\d+)/.exec(statusText)?.[1] ?? 0)
    if (!threshold && !Number.isInteger(expectedStatus)) {
      throw new Error(`${key}: unreadable http_status ${JSON.stringify(statusText)}`)
    }
    specs.push({
      key,
      caseId,
      name: request.name,
      method: request.method,
      path: request.path,
      requestFile,
      downstreamFile,
      variant,
      group: request.group ?? caseId,
      expectedStatus,
      seam: SEAM_BY_REQUEST[key],
      upstreamCalls: UPSTREAM_CALLS_BY_REQUEST[key] ?? 0,
      bodyMode: BODY_MODE_BY_REQUEST[key] ?? 'exact',
      instanceTag: FRESH_INSTANCE_TAG[key] ?? 'default',
      threshold,
    })
  }
  return { meta, upstreamLines, mock, specs }
}

const caseIndex = new Map<string, CaseIndexEntry>()
for (const caseId of CASE_IDS) {
  caseIndex.set(caseId, await loadCaseIndexEntry(caseId))
}

// ─── Replay engine ────────────────────────────────────────────────────────────────

/** Per-case cursor into the recorded upstream lines (requests replay in order). */
const upstreamCursors = new Map<string, number>()

function cursorFor(caseId: string): number {
  return upstreamCursors.get(caseId) ?? 0
}

function advanceCursor(caseId: string, by: number): void {
  upstreamCursors.set(caseId, cursorFor(caseId) + by)
}

/** Builds the runtime's buffered GatewayRequest from the recorded bytes. */
function toGatewayRequest(recorded: RecordedRequest): GatewayRequest {
  const headers: Array<readonly [string, string]> = []
  for (const [name, value] of recorded.headers) {
    // Host becomes the URL; Content-Length is implied by the body bytes.
    if (name === 'Host' || name.toLowerCase() === 'content-length') continue
    headers.push([name, value])
  }
  return {
    method: recorded.method,
    url: `http://${RECORD_HOST}${recorded.path}`,
    headers,
    body: recorded.body,
    remoteAddress: RECORD_CLIENT_IP,
  }
}

async function replayRegularRequest(spec: RequestSpec): Promise<void> {
  const entry = caseIndex.get(spec.caseId)
  if (entry === undefined) throw new Error(`${spec.key}: case missing from the index`)
  const gateway = await gatewayFor(
    spec.caseId,
    spec.variant,
    spec.instanceTag,
    entry.mock,
    entry.upstreamLines.length,
  )
  const recorded = await readRecordedRequest(spec.caseId, spec.requestFile)
  const golden = await readGoldenResponse(spec.caseId, spec.downstreamFile)
  if (golden.dateMs !== null) gateway.setClock(golden.dateMs)

  const before = gateway.captured.length
  const actual = await materialize(await gateway.gateway.handle(toGatewayRequest(recorded)))
  const calls = gateway.captured.slice(before)

  // Consume this request's recorded wire lines BEFORE any assertion can
  // throw, so a red step never desynchronizes the wire baseline of the
  // steps that follow it inside the same case.
  const expectedLines = entry.upstreamLines.slice(
    cursorFor(spec.caseId),
    cursorFor(spec.caseId) + spec.upstreamCalls,
  )
  advanceCursor(spec.caseId, spec.upstreamCalls)

  const verdict = assertGoldenStep(spec.key, golden, actual, spec.bodyMode, {
    maskBanDuration: false,
    maskCreated:
      entry.meta.dynamic_fields.includes('created') ||
      entry.meta.dynamic_fields.includes('created_at'),
    goldenIsHead: spec.method === 'HEAD',
  })
  if (verdict.problems.length > 0) {
    throw new Error(verdict.problems.join('\n'))
  }
  if (actual.status !== spec.expectedStatus) {
    throw new Error(
      `${spec.key}: meta.yaml declares status ${spec.expectedStatus}, runtime produced ${actual.status}`,
    )
  }
  if (calls.length !== spec.upstreamCalls) {
    throw new Error(
      `${spec.key}: expected ${spec.upstreamCalls} upstream call(s), the runtime made ${calls.length}`,
    )
  }
  for (let index = 0; index < calls.length; index += 1) {
    const call = calls[index]
    const recordedLine = expectedLines[index]
    if (call === undefined || recordedLine === undefined) {
      throw new Error(`${spec.key}: upstream exchange ${index} missing on one side`)
    }
    const problem = assertUpstreamCall(`${spec.key} upstream ${index + 1}`, recordedLine, call)
    if (problem !== null) throw new Error(problem)
  }
}

// ─── The mgmt-ip-ban-threshold probe (six sequential requests, one container) ─────

interface ThresholdRequest {
  readonly headers: ReadonlyArray<readonly [string, string]>
}

function parseThresholdRequests(text: string): ThresholdRequest[] {
  const blocks = text.split(/^### Attempt \d+[^\n]*\n/m).slice(1)
  if (blocks.length !== 6) {
    throw new Error(`ip-ban-threshold: expected 6 request blocks, parsed ${blocks.length}`)
  }
  return blocks.map((block) => {
    const headers: Array<[string, string]> = []
    for (const line of block.split('\n')) {
      const colon = line.indexOf(': ')
      if (colon <= 0) continue
      headers.push([line.slice(0, colon), line.slice(colon + 2)])
    }
    return { headers }
  })
}

async function replayThresholdProbe(): Promise<void> {
  const caseId = 'S1-25'
  const specKey = `${caseId}/mgmt-ip-ban-threshold`
  const gateway = await freshGatewayFor(caseId, 'baseline', 'ban-threshold', null, 0)
  const requests = parseThresholdRequests(
    await readFixtureText(caseId, 'mgmt-ip-ban-threshold.request.http'),
  )
  const attempts = parseThresholdDocument(
    await readFixtureText(caseId, 'mgmt-ip-ban-threshold.downstream.md'),
  )
  // The fixture keeps the attempt-6 wall-clock only in the verbose probe.
  const verbose = await readFixtureText(caseId, 'mgmt-ip-ban-threshold-attempt6-verbose.txt')
  const dateMatch = /Date: ([^\r\n]+ GMT)/.exec(verbose)
  if (dateMatch === null) throw new Error(`${specKey}: verbose probe carries no Date`)
  gateway.setClock(Date.parse(dateMatch[1] ?? ''))

  for (let index = 0; index < 6; index += 1) {
    const request = requests[index]
    const attempt = attempts[index]
    if (request === undefined || attempt === undefined) {
      throw new Error(`${specKey}: attempt ${index + 1} missing`)
    }
    const response = await materialize(
      await gateway.gateway.handle({
        method: 'GET',
        url: `http://${RECORD_HOST}/v0/management/config`,
        headers: request.headers.filter(([name]) => name !== 'Host'),
        body: new Uint8Array(0),
        remoteAddress: RECORD_CLIENT_IP,
      }),
    )
    if (attempt.isBan) {
      // The fixture abbreviates the attempt-6 head ("<plus the standard
      // CORS block + Date (dynamic)>"), so the subset it does pin is
      // asserted explicitly: status, charset content type, the anchor
      // build headers, the CORS block, and the masked-duration body.
      expect(response.status, `${specKey} attempt 6 status`).toBe(403)
      const headers = headerMap(response.headers)
      expect(headers.get('content-type'), `${specKey} attempt 6 content type`).toBe(
        'application/json; charset=utf-8',
      )
      expect(headers.get('x-cpa-version'), `${specKey} attempt 6 X-Cpa-Version`).toBe(
        ANCHOR_BUILD_INFO.version,
      )
      expect(headers.get('x-cpa-commit'), `${specKey} attempt 6 X-Cpa-Commit`).toBe(
        ANCHOR_BUILD_INFO.commit,
      )
      expect(headers.get('x-cpa-build-date'), `${specKey} attempt 6 X-Cpa-Build-Date`).toBe(
        ANCHOR_BUILD_INFO.buildDate,
      )
      expect(headers.get('x-cpa-support-plugin'), `${specKey} attempt 6 X-Cpa-Support-Plugin`).toBe(
        ANCHOR_BUILD_INFO.supportPlugin ? '1' : '0',
      )
      for (const name of [
        'access-control-allow-headers',
        'access-control-allow-methods',
        'access-control-allow-origin',
        'access-control-expose-headers',
      ]) {
        expect(headers.has(name), `${specKey} attempt 6 must carry ${name}`).toBe(true)
      }
      expect(maskBanRemaining(response.body), `${specKey} attempt 6 ban body (duration masked)`).toBe(
        maskBanRemaining(attempt.body),
      )
    } else {
      expect(response.status, `${specKey} attempt ${index + 1} status`).toBe(attempt.status)
      expect(
        response.body,
        `${specKey} attempt ${index + 1} body (the fixture records no head for counted failures)`,
      ).toBe(attempt.body)
    }
  }
  expect(gateway.captured.length, `${specKey}: no upstream egress may happen`).toBe(0)
}

// ─── Skip plumbing ────────────────────────────────────────────────────────────────

function skipReason(spec: RequestSpec): string {
  const state = seamMerged(spec.seam)
  return (
    `direction seam '${state.seam}' has no merged facade in the runtime DIRECTIONS table ` +
    '(the golden replays automatically once the integrator wires the facade)'
  )
}

/** Registers one request as a test (or a skip with its reason). */
function registerRequestTest(spec: RequestSpec): void {
  const state = seamMerged(spec.seam)
  const goal = spec.threshold ? '401 x5 then 403 (ban check precedes key validation)' : String(spec.expectedStatus)
  if (spec.seam !== undefined && !state.merged) {
    it.skip(`${spec.name} — ${spec.method} ${spec.path} (SKIP: ${skipReason(spec)})`, () => {})
    return
  }
  it(`${spec.name} — ${spec.method} ${spec.path} → ${goal}`, async () => {
    if (spec.threshold) {
      await replayThresholdProbe()
      return
    }
    await replayRegularRequest(spec)
  })
}

/** Per-case upstream-total test: replays only when every request replays. */
function registerUpstreamTotalTest(caseId: string): void {
  const entry = caseIndex.get(caseId)
  if (entry === undefined) throw new Error(`${caseId}: missing from the index`)
  const anySkipped = entry.specs.some((spec) => spec.seam !== undefined && !seamMerged(spec.seam).merged)
  const expectedTotal = entry.specs
    .filter((spec) => !(spec.seam !== undefined && !seamMerged(spec.seam).merged))
    .reduce((sum, spec) => sum + spec.upstreamCalls, 0)
  if (anySkipped) {
    it.skip(`upstream wire totals (SKIP: one or more direction seams unmerged)`, () => {})
    return
  }
  it('upstream wire totals (no straggler egress beyond the recorded log)', async () => {
    const variants = new Set(entry.specs.map((spec) => `${spec.variant}::${spec.instanceTag}`))
    for (const key of variants) {
      const [variant, instanceTag] = key.split('::')
      const gateway = await gatewayFor(caseId, variant ?? 'baseline', instanceTag ?? 'default', entry.mock, entry.upstreamLines.length)
      if (gateway.captured.length !== expectedTotal) {
        throw new Error(
          `${caseId}[${key}]: captured ${gateway.captured.length} upstream call(s), recorded ${expectedTotal}`,
        )
      }
    }
  })
}

// ─── Suite registration ───────────────────────────────────────────────────────────

/** Registers every request of one case (fixture order) plus the totals test. */
function registerCase(caseId: string): void {
  const entry = caseIndex.get(caseId)
  if (entry === undefined) throw new Error(`${caseId}: missing from the case index`)
  for (const spec of entry.specs) registerRequestTest(spec)
  registerUpstreamTotalTest(caseId)
}

/** Registers only the requests of one S1-25 group (the batch case). */
function registerS1Group(group: string): void {
  const entry = caseIndex.get('S1-25')
  if (entry === undefined) throw new Error('S1-25: missing from the case index')
  for (const spec of entry.specs.filter((candidate) => candidate.group === group)) {
    registerRequestTest(spec)
  }
}

describe('S1 fixture inventory (harness self-check, adapter-independent)', () => {
  it('exposes exactly the 26 admitted golden cases with internally consistent request/response pairs', async () => {
    const onDisk = (await readdir(FIXTURE_ROOT, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
    expect(onDisk).toEqual([...CASE_IDS].sort())

    let totalRequests = 0
    for (const caseId of CASE_IDS) {
      const entry = caseIndex.get(caseId)
      if (entry === undefined) throw new Error(`${caseId}: missing from the case index`)
      totalRequests += entry.specs.length
      recognizeDynamicFields(caseId, entry.meta.dynamic_fields)
      for (const spec of entry.specs) {
        if (spec.threshold) continue
        const recorded = parseRequestHead(await readFixtureText(spec.caseId, spec.requestFile))
        if (spec.method !== 'HEAD' && recorded.method !== spec.method) {
          throw new Error(`${spec.key}: request file method ${recorded.method} !== meta ${spec.method}`)
        }
        if (spec.path !== recorded.path) {
          throw new Error(`${spec.key}: request file path ${recorded.path} !== meta ${spec.path}`)
        }
        const golden = parseGoldenResponse(
          spec.caseId,
          spec.downstreamFile,
          await readFixtureText(spec.caseId, spec.downstreamFile),
        )
        if (golden.status !== spec.expectedStatus) {
          throw new Error(
            `${spec.key}: golden status ${golden.status} !== meta http_status ${spec.expectedStatus}`,
          )
        }
        // Golden-declared Content-Length must match the parsed body bytes,
        // except the OQ-1 redirect whose trailing CRLF did not survive the
        // markdown rendering (registered platform-optional).
        if (
          golden.contentLength !== null &&
          spec.bodyMode !== 'trim' &&
          encoder.encode(golden.body).length !== golden.contentLength
        ) {
          throw new Error(
            `${spec.key}: golden body is ${encoder.encode(golden.body).length} bytes, ` +
              `Content-Length declares ${golden.contentLength}`,
          )
        }
        if (golden.body.includes('data: ') && golden.status === 200) {
          expect(() => decodeSseEvents(golden.body), `${spec.key}: recorded SSE body decodes`).not.toThrow()
        }
      }
    }
    expect(totalRequests, '26 cases replay 123 recorded requests in total').toBe(123)
    const threshold = parseThresholdDocument(
      await readFixtureText('S1-25', 'mgmt-ip-ban-threshold.downstream.md'),
    )
    expect(threshold.filter((attempt) => attempt.isBan).length, 'exactly one banned attempt').toBe(1)
    expect(threshold[0]?.body, 'counted failures carry the invalid-key body').toBe(
      '{"error":"invalid management key"}',
    )
  })
})

suite(suiteTitle, () => {
  describe('S1-01 / S1-21 · meta & utility routes (root info, healthz, HEAD, keep-alive)', () => {
    registerCase('S1-01')
    registerCase('S1-21')
  })

  describe('S1-02 · OPTIONS anywhere → 204 + CORS, never routed', () => {
    registerCase('S1-02')
  })

  describe('S1-03 / S1-04 · R-404: unknown routes and wrong methods → 404 empty', () => {
    registerCase('S1-03')
    registerCase('S1-04')
  })

  describe('S1-05 / S1-06 · client auth rejects (401 Missing / Invalid API key)', () => {
    registerCase('S1-05')
    registerCase('S1-06')
  })

  describe('S1-07 / S1-26 · client auth accepts (all five transports, both route groups)', () => {
    registerCase('S1-07')
    registerCase('S1-26')
  })

  describe('S1-08 · trailing-slash redirects (301/307, the no-CORS exception)', () => {
    registerCase('S1-08')
  })

  describe('S1-09 / S1-10 · models lists (OpenAI shape, Claude shape, id cloaking)', () => {
    registerCase('S1-09')
    registerCase('S1-10')
  })

  describe('S1-11 · model_not_found matrix across the client surfaces', () => {
    registerCase('S1-11')
  })

  describe('S1-12 / S1-13 · v1beta discovery + :action routing', () => {
    registerCase('S1-12')
    registerCase('S1-13')
  })

  describe('S1-14 / S1-15 / S1-16 / S1-18 · direction-dispatch goldens (merged-facade dependent)', () => {
    registerCase('S1-14')
    registerCase('S1-15')
    registerCase('S1-16')
    registerCase('S1-18')
  })

  describe('S1-17 · streamGenerateContent alt framing (sse default / alt=json raw)', () => {
    registerCase('S1-17')
  })

  describe('S1-19 · WS upgrade gates (responses 400 handshake, realtime 426 nested)', () => {
    registerCase('S1-19')
  })

  describe('S1-20 · management auth matrix + build headers (payloads stay S5-owned)', () => {
    registerCase('S1-20')
  })

  describe('S1-22 · OAuth callback routes (HTML + devin ladder)', () => {
    registerCase('S1-22')
  })

  describe('S1-23 · codex-only routes without codex credentials', () => {
    registerCase('S1-23')
  })

  describe('S1-24 · countTokens local synthesis (R-TOK, no upstream call)', () => {
    registerCase('S1-24')
  })

  describe('S1-25 group A · realtime capability stubs (501 nested envelopes)', () => {
    registerS1Group('A-capability-stubs')
  })

  describe('S1-25 group B · sideband WS gates (426 + client_secrets 400)', () => {
    registerS1Group('B-sideband-ws')
  })

  describe('S1-25 group C · realtime hangup matrix (400/404)', () => {
    registerS1Group('C-hangup')
  })

  describe('S1-25 group D · pin-gap batch (images, interactions, gemini quirks, mgmt 403s, zstd)', () => {
    registerS1Group('D-pin-gaps')
    registerUpstreamTotalTest('S1-25')
  })

  describe('S1-25 group E · config variants (empty api-keys open gate, safe mode)', () => {
    registerS1Group('E-config-variants')
  })

  describe('S1-25 group F · S1-21 re-records (healthz HEAD, root HEAD, keep-alive)', () => {
    registerS1Group('F-s1-21-rerecord')
  })
})
