/**
 * S2d7 golden contract — Gemini client → Claude (Anthropic Messages) upstream.
 *
 * Spec source of truth: spec/sections/S2d7-gem2cla.md (admitted). Goldens: the 31 recorded
 * fixture cases under tests/fixtures/S2d7/ — oracle wire transcripts of CLIProxyAPI v7.3.4
 * against the deterministic claude mock (RECORDABLE-LOCALLY per R-FIXTURE; transcripts only,
 * no upstream source text). Rulings applied: R-SSE (downstream stream bodies compare as
 * DECODED event sequences, never transport chunk boundaries), R-TOK (countTokens numerics are
 * byte-exact and NEVER masked), NE-LENIENT (fixtures replay well-formed request bodies only;
 * the inventory self-check rejects a fixture whose body is not valid JSON). R-ORDER is
 * recorded here as NOT APPLICABLE: this surface accumulates upstream `input_json_delta`
 * silently and emits at most one frame per content block, so no run of adjacent,
 * interchangeably-ordered delta frames exists — every frame is order-pinned. R-404/R-BCRYPT
 * touch surfaces this suite never exercises (routing edge cases, management secrets).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * ADAPTER INTERFACE — what the `@cpa-edge/translators/gem2cla` direction module MUST
 * export. The suite dynamically imports the package and turns green-to-red once the
 * export ships; while the package is still a skeleton every case test SKIPS with the
 * reason below. The harness holds its own structural mirror of these types; the package
 * should export the real ones. All shapes are runtime-checked by the suite.
 *
 *   export function createGem2ClaService(options: Gem2ClaServiceOptions): Gem2ClaService
 *
 *   type HeaderList = ReadonlyArray<readonly [string, string]>   // ordered, original casing
 *
 *   interface Gem2ClaModelEntry {
 *     name: string                    // upstream model name stamped onto the wire
 *     alias?: string                  // client-facing alias; ONLY the alias routes (S2d7-22)
 *     thinking?: { min?: number; max?: number; levels?: readonly string[] }
 *   }
 *
 *   interface Gem2ClaCredential {
 *     apiKey: string                  // sent as `Authorization: Bearer <apiKey>` (recorded)
 *     baseUrl: string                // e.g. "http://host.docker.internal:21002"
 *     models: readonly Gem2ClaModelEntry[]
 *   }
 *
 *   interface Gem2ClaServiceOptions {
 *     apiKeys: readonly string[]      // gateway keys: `x-goog-api-key` OR `Authorization: Bearer`
 *     credentials: readonly Gem2ClaCredential[] // claude-api-key entries, config order
 *     gatewayVersion: string          // default upstream User-Agent: `CLIProxyAPI/${gatewayVersion}`
 *     store: Store                   // from @cpa-edge/core; ALL persistent state (cooldowns)
 *     now?: () => number             // epoch-ms clock; MUST be used for every timing decision
 *     requestRetry?: number          // 0 in every S2d7 fixture (single attempt)
 *     transientErrorCooldownSeconds?: number // -1 in every fixture; does NOT disable the 429 cooldown
 *   }
 *
 *   interface Gem2ClaRequest {
 *     method: string                 // 'POST'
 *     path: string                   // '/v1beta/models/{model}:{action}[?alt=…]'
 *     headers: HeaderList            // client headers, recorded order + casing
 *     body: string                   // exact request-body bytes (well-formed JSON per NE-LENIENT)
 *   }
 *
 *   interface Gem2ClaUpstreamRequest {
 *     method: string                 // 'POST'
 *     url: string                    // absolute: `${baseUrl}/v1/messages?beta=true` (beta ALWAYS)
 *     headers: HeaderList            // emission ORDER is pinned (see "Comparison rules")
 *     body: string                   // ALWAYS carries "stream":true, even for :generateContent
 *   }
 *
 *   interface Gem2ClaUpstreamResponse {
 *     status: number
 *     headers: HeaderList
 *     body: ReadableStream<Uint8Array> // 2xx: SSE bytes; otherwise raw bytes.
 *                                      // A rejected read mid-body models an upstream disconnect.
 *   }
 *
 *   type Gem2ClaUpstreamSender =
 *     (request: Gem2ClaUpstreamRequest) => Promise<Gem2ClaUpstreamResponse>
 *
 *   interface Gem2ClaResponse {
 *     status: number
 *     headers: HeaderList            // must carry the direction-owned subset (see below)
 *     body: string | ReadableStream<Uint8Array>
 *   }
 *
 *   interface Gem2ClaService {
 *     handleV1beta(request: Gem2ClaRequest, send: Gem2ClaUpstreamSender): Promise<Gem2ClaResponse>
 *   }
 *
 * The facade covers the whole pinned direction pipeline for the /v1beta generation surface:
 * the gateway-key gate (missing key → 401 `{"error":"Missing API key"}`, zero upstream
 * calls — S2d7-00; invalid key → the S1 `{"error":"Invalid API key"}` shape, not
 * fixture-pinned here), alias-only model resolution (the verbatim upstream name is NOT
 * routable → 400 model_not_found, zero upstream calls — S2d7-22), path dispatch across
 * `:generateContent` / `:streamGenerateContent` / `:countTokens` with `alt` normalization
 * (absent/empty/`sse`/`$alt` → SSE framing; any other value → raw concatenation — S2d7-18),
 * request translation (spec §2.3), executor post-processing (§2.2: provider-model rewrite,
 * max_tokens default 32000, metadata.user_id sha256, forced upstream streaming,
 * cache_control injection, sampling strip, thinking strip for models without capability
 * metadata — S2d7-08), response mapping incl. the raw-args splice cascade (§3.6 —
 * S2d7-13/21 reproduce the recorded DEGRADED byte shapes, they must not be "fixed"),
 * downstream framing (§4 incl. the terminal `event: error` frame — S2d7-11), and error
 * semantics (§5: verbatim upstream status+body pass-through, the 502 validator families,
 * the 400 countTokens validation family, the pre-commit 500 `empty_stream` gate, and the
 * 429 → credential rate-limit cooldown whose envelope carries `Retry-After: 1`).
 * `:countTokens` counts locally over the translated body with js-tiktoken o200k_base
 * (R-TOK; recorded N=4 in S2d7-12) and must NOT call `send` (S2d7-12/25).
 * A mid-stream upstream transport failure surfaces the pinned terminal message
 * "unexpected EOF" regardless of the transport error's own text (§4.4).
 * OUT of scope here (owned by S1/the runtime, asserted by no fixture in this suite):
 * the CORS header block, `Date`, `X-Cpa-Trace-Id`, `Connection`, `Transfer-Encoding`,
 * downstream `Content-Length`, and R-404 routing semantics.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * HARNESS SEMANTICS
 *
 * • Per case the harness builds a fresh service + fresh MemoryStore. The clock is frozen
 *   (`now()` returns a constant) so the 429 rate-limit cooldown of the composed case stays
 *   deterministic: the follow-up request always lands inside the 1s window and the pinned
 *   literals `Retry-After: 1` / `"reset_seconds":1` / `"reset_time":"1s"` compare
 *   byte-exact (same decision the S2d3 suite made for its scripted-429 cooldown case).
 * • S2d7-19 recorded only the post-429 delta, so the harness composes it from two steps:
 *   step 1 replays the S2d7-10 fixture (the recorded 429 that starts the cooldown) and
 *   step 2 replays S2d7-19's own request. Both steps share ONE service + Store, so the
 *   cooldown state persists between them; step 2 also pins "no upstream call while
 *   cooling". Every other case is single-step.
 * • The mock upstream is played from each fixture's own mock-response.json
 *   (`control_file` + `script_sse` +, for error mode, the embedded `reply`): `[eventName,
 *   data]` pairs are emitted as `event: <name>\ndata: <python-json>\n\n` frames; a
 *   `["RAW", text]` entry emits the raw text verbatim (the malformed-variant line of
 *   S2d7-29); `mode:"error"` replies with the recorded status and the reply body embedded
 *   in the fixture (`{"type": "error", …}` rate-limit JSON — the bytes S2d7-10 pins
 *   verbatim downstream); `mode:"disconnect"` hard-aborts the stream after `after` frames
 *   (a rejected read). Script `message.model` values echo the model read from the
 *   translated upstream body, so a mis-translated model breaks the downstream
 *   `modelVersion` too, not just the wire compare.
 * • Upstream calls are captured; at the end of a case the captured sequence must equal the
 *   recorded upstream.jsonl lines of the replayed steps (count + bytes). The countTokens,
 *   auth-401, unknown-model and cooldown-step fixtures therefore also pin "no upstream
 *   call is made".
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * COMPARISON RULES
 *
 * Upstream wire (primary gold):
 *   - method, url (baseUrl + recorded path), body: byte-exact. The body bytes pin the
 *     always-`"stream":true` clause, max_tokens, the message/tool key order, the sha256
 *     user_id, cache_control placement, the `toolu_gemini_%016d` counter and the raw-args
 *     splice — all without sub-structure assertions.
 *   - headers: the full ordered list, names case-preserved, in the recorded order
 *     `Host, User-Agent, [Content-Length], Accept, Accept-Encoding, Anthropic-Version,
 *     Authorization, Content-Type`. `Content-Length` is excluded from the ordered compare
 *     (transport-derived; if the adapter emits it, it must equal the body byte length).
 *     `Authorization` is redacted in the recordings; the adapter's value must start with
 *     "Bearer " and is then normalized to "<redacted>" (spec §2.2 pins the scheme, not the
 *     key). The recording-only `ts`/`type` fields of upstream.jsonl are never compared.
 *
 * Downstream (per step):
 *   - status: exact. Non-SSE bodies (JSON envelopes, the alt=json raw concatenation of
 *     S2d7-18): byte-exact after masking.
 *   - SSE bodies compare as DECODED event sequences per R-SSE: the ordered list of
 *     `{event, data}` pairs per `\n\n`-separated block. Every ordinary frame must have NO
 *     event name; the §4.4 terminal failure frame is the only one carrying
 *     `event: "error"` with the pinned "unexpected EOF" payload. No `[DONE]` marker exists
 *     on this surface (frame equality pins that implicitly).
 *   - headers: only the direction-owned subset is asserted: `Content-Type` (exact),
 *     `Cache-Control` (exact `no-cache` on SSE commits, absent otherwise — this pins
 *     "no SSE headers before commit" for the 429/500/502 cases), `Retry-After` (exact when
 *     the recording has one, absent otherwise). Absence is asserted, not forgiven.
 *
 * MASKS — applied identically to recorded and produced bytes, derived from each case's
 * meta.yaml `dynamic_fields` (unknown entries fail the suite loudly so new volatility
 * must be added consciously):
 *   - `Date`, `X-Cpa-Trace-Id`, `mock wire log ts field`: never reach a compared surface
 *     (not asserted downstream; not part of the upstream request); declared for completeness.
 *   - `createTime`: `"createTime":"<RFC3339>"` in downstream JSON bodies and SSE data
 *     frames → `"createTime":"<CREATE_TIME>"`.
 *   - upstream Host port: trailing `:port` of the upstream `Host` header value → `:<PORT>`.
 * Deliberately NOT masked (each is deterministic; masking would weaken a recorded pin):
 *   - `metadata.user_id` sha256 derivations (spec §3.3, byte-pinned by the wire body).
 *   - generated `toolu_gemini_%016d` ids (request-local counter starting at 1; spec §3.5
 *     declares them stable and byte-pinnable — S2d7-06).
 *   - cooldown `Retry-After` / `reset_seconds` / `reset_time` (spec §5.1 pins the literals
 *     `1` / `1` / `"1s"`; the frozen clock makes them deterministic — see HARNESS SEMANTICS).
 *   - `totalTokens` (R-TOK: byte-exact NUMERICALLY, never masked — S2d7-12's recorded 4).
 */

import { readdir, readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { MemoryStore } from '@cpa-edge/core'
import type { Store } from '@cpa-edge/core'

// ─── Adapter load (skip-with-explanation until the real export ships) ────────────────

const ADAPTER_MODULE = '@cpa-edge/translators/gem2cla'
const ADAPTER_EXPORT = 'createGem2ClaService'

/** Structural mirror of the adapter interface documented in the header. */
type HeaderList = ReadonlyArray<readonly [string, string]>

interface ModelEntry {
  readonly name: string
  readonly alias?: string
  readonly thinking?: { readonly min?: number; readonly max?: number; readonly levels?: readonly string[] }
}

interface CredentialConfig {
  readonly apiKey: string
  readonly baseUrl: string
  readonly models: readonly ModelEntry[]
}

interface ServiceOptions {
  readonly apiKeys: readonly string[]
  readonly credentials: readonly CredentialConfig[]
  readonly gatewayVersion: string
  readonly store: Store
  readonly now: () => number
  readonly requestRetry: number
  readonly transientErrorCooldownSeconds: number
}

interface SurfaceRequest {
  readonly method: string
  readonly path: string
  readonly headers: HeaderList
  readonly body: string
}

interface UpstreamRequest {
  readonly method: string
  readonly url: string
  readonly headers: HeaderList
  readonly body: string
}

interface UpstreamResponse {
  readonly status: number
  readonly headers: HeaderList
  readonly body: ReadableStream<Uint8Array>
}

type UpstreamSender = (request: UpstreamRequest) => Promise<UpstreamResponse>

interface SurfaceResponse {
  readonly status: number
  readonly headers: HeaderList
  readonly body: string | ReadableStream<Uint8Array>
}

interface SurfaceService {
  handleV1beta(request: SurfaceRequest, send: UpstreamSender): Promise<SurfaceResponse>
}

type AdapterFactory = (options: ServiceOptions) => SurfaceService

interface AdapterLoadResult {
  readonly factory?: AdapterFactory
  readonly skipReason?: string
}

async function loadAdapter(): Promise<AdapterLoadResult> {
  try {
    const imported = (await import(ADAPTER_MODULE)) as Record<string, unknown>
    const candidate = imported[ADAPTER_EXPORT]
    if (typeof candidate === 'function') {
      return { factory: candidate as AdapterFactory }
    }
    return {
      skipReason: `\`${ADAPTER_MODULE}\` does not export \`${ADAPTER_EXPORT}(options)\` yet. ` +
        'All 31 S2d7 golden cases SKIP until the gem2cla adapter ships; the required interface is documented in the header of this file.',
    }
  } catch (error) {
    return { skipReason: `import of \`${ADAPTER_MODULE}\` failed: ${String(error)}` }
  }
}

const adapterLoad = await loadAdapter()
const adapterFactory = adapterLoad.factory
const suite = adapterFactory ? describe : describe.skip
const suiteTitle = adapterFactory
  ? 'S2d7 — gem2cla golden contract (recorded fixtures)'
  : `S2d7 — gem2cla golden contract (SKIPPED: ${adapterLoad.skipReason ?? 'adapter unavailable'})`

// ─── Fixture access ───────────────────────────────────────────────────────────────────

const FIXTURE_ROOT = new URL('../fixtures/S2d7/', import.meta.url)
const GATEWAY_VERSION = 'v7.3.4'
const GATEWAY_API_KEYS: readonly string[] = ['oracle-local-key-1']
const FROZEN_NOW_MS = 1_789_494_944_000

/** Recording-instance credential set, transcribed from the meta.yaml config fragments. */
const DEFAULT_CREDENTIALS: readonly CredentialConfig[] = [
  {
    apiKey: 'mock-claude-key',
    baseUrl: 'http://host.docker.internal:21002',
    models: [{ name: 'claude-mock-model', alias: 'cm' }],
  },
]

const EXPECTED_CASES = [
  'S2d7-00-auth-401',
  'S2d7-01-nonstream-minimal',
  'S2d7-02-stream-sse',
  'S2d7-03-stream-noalt',
  'S2d7-04-system-snake',
  'S2d7-05-system-camel',
  'S2d7-06-tools-roundtrip',
  'S2d7-07-genconfig-sampling',
  'S2d7-08-thinking-level',
  'S2d7-09-inline-media',
  'S2d7-10-upstream-429',
  'S2d7-11-disconnect',
  'S2d7-12-counttokens',
  'S2d7-13-tool-stream',
  'S2d7-14-errstream',
  'S2d7-15-maxtokens',
  'S2d7-16-roleless-dropped',
  'S2d7-17-role-merge',
  'S2d7-18-alt-json',
  'S2d7-19-cooldown-after-429',
  'S2d7-20-errstream-nonstream',
  'S2d7-21-tool-nonstream',
  'S2d7-22-verbatim-model',
  'S2d7-23-tool-stream-valid-args',
  'S2d7-24-tool-nonstream-valid-args',
  'S2d7-25-counttokens-validation',
  'S2d7-26-empty-stream',
  'S2d7-27-missing-message-start',
  'S2d7-28-missing-message-delta',
  'S2d7-29-malformed-stream',
  'S2d7-30-stream-empty-200',
] as const

type CaseId = (typeof EXPECTED_CASES)[number]

/**
 * S2d7-19 recorded only the post-429 delta, so its replay is composed: the recorded 429
 * of S2d7-10 starts the credential cooldown (step 1), then S2d7-19's own request lands
 * inside the cooldown window (step 2, same service + Store).
 */
const COMPOSED_STEPS: Readonly<Record<string, readonly string[]>> = {
  'S2d7-19-cooldown-after-429': ['S2d7-10-upstream-429', 'S2d7-19-cooldown-after-429'],
}

const V1BETA_PATH_RE = /^\/v1beta\/models\/[^:/?]+:(generateContent|streamGenerateContent|countTokens)(?:\?.*)?$/

const fixtureCaseDirs = (await readdir(FIXTURE_ROOT, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()

function caseFile(caseId: string, name: string): URL {
  return new URL(`${caseId}/${name}`, FIXTURE_ROOT)
}

async function readFixtureText(caseId: string, name: string): Promise<string> {
  // Fixture recorders preserve raw wire line terminators (CRLF in request heads and
  // response heads). Every compared surface (bodies, SSE frame blocks, header values) is
  // CR-free after this normalization — verified across all 31 recorded cases — so
  // terminators are normalized on read and never enter a byte comparison.
  const raw = await readFile(caseFile(caseId, name), 'utf8')
  return raw.replaceAll('\r\n', '\n')
}

async function readFixtureJson<T>(caseId: string, name: string): Promise<T> {
  return JSON.parse(await readFixtureText(caseId, name)) as T
}

// ─── Fixture file parsers (request.http / downstream.md / meta.yaml / mock-response.json)

function parseRequestHttp(text: string): SurfaceRequest {
  const boundary = text.indexOf('\n\n')
  const head = boundary === -1 ? text : text.slice(0, boundary)
  let rest = boundary === -1 ? '' : text.slice(boundary + 2)
  // The recorder separates the request head from the body with one extra blank line.
  while (rest.startsWith('\n')) rest = rest.slice(1)
  const body = rest.endsWith('\n') ? rest.slice(0, -1) : rest
  const lines = head.split('\n')
  const requestLine = lines[0] ?? ''
  const parts = requestLine.split(' ')
  const headers: Array<[string, string]> = []
  for (const line of lines.slice(1)) {
    const separator = line.indexOf(': ')
    if (separator <= 0) continue
    headers.push([line.slice(0, separator), line.slice(separator + 2)])
  }
  return { method: parts[0] ?? '', path: parts[1] ?? '', headers, body }
}

interface RecordedResponse {
  readonly status: number
  readonly headers: HeaderList
  readonly body: string
}

function parseDownstreamMarkdown(text: string): RecordedResponse {
  const lines = text.split('\n')
  const fencedSection = (marker: string, section: string): string[] => {
    const markerIndex = lines.findIndex((line) => line.startsWith(marker))
    if (markerIndex === -1) throw new Error(`downstream.md is missing the ${section} section`)
    let cursor = markerIndex + 1
    while (cursor < lines.length && !(lines[cursor] ?? '').startsWith('```')) cursor += 1
    cursor += 1
    const content: string[] = []
    while (cursor < lines.length && !(lines[cursor] ?? '').startsWith('```')) {
      content.push(lines[cursor] ?? '')
      cursor += 1
    }
    if (cursor >= lines.length) throw new Error(`downstream.md ${section} fence is never closed`)
    return content
  }
  const headLines = fencedSection('### Response head', 'response head')
  const bodyLines = fencedSection('### Body', 'body')
  const statusLine = headLines[0] ?? ''
  if (!statusLine.startsWith('HTTP/1.1 ')) throw new Error('downstream.md response head has no status line')
  const status = Number(statusLine.split(' ')[1])
  const headers: Array<[string, string]> = []
  for (const line of headLines.slice(1)) {
    if (line.trim() === '') continue
    const separator = line.indexOf(': ')
    if (separator <= 0) continue
    headers.push([line.slice(0, separator), line.slice(separator + 2)])
  }
  return { status, headers, body: bodyLines.join('\n') }
}

interface CaseMeta {
  readonly case: string
  readonly dynamic_fields: readonly string[]
  readonly upstream_wire_delta_lines: number
  readonly stream: boolean
}

// ─── Masking (meta.yaml dynamic_fields → normalization) ──────────────────────────────

interface MaskProfile {
  readonly createTime: boolean
  readonly port: boolean
}

const CREATE_TIME_RE = /"createTime":"[^"]*"/g
const PORT_SUFFIX_RE = /:\d+$/

function maskProfile(caseId: string, dynamicFields: readonly string[]): MaskProfile {
  const profile = { createTime: false, port: false }
  for (const field of dynamicFields) {
    if (field === 'Date' || field === 'X-Cpa-Trace-Id') {
      continue // response-head values; never asserted on any compared surface
    }
    if (field === 'mock wire log ts field') {
      continue // recording-only upstream.jsonl fields, excluded from the wire compare
    }
    if (field === 'createTime') {
      profile.createTime = true
      continue
    }
    if (field === 'upstream Host header port (21002)') {
      profile.port = true
      continue
    }
    throw new Error(
      `S2d7[${caseId}]: unrecognized meta.yaml dynamic_fields entry ${JSON.stringify(field)} — ` +
        'extend the mask table in tests/contract/s2d7-gem2cla.test.ts consciously',
    )
  }
  return profile
}

function normalizeBodyText(text: string, mask: MaskProfile): string {
  return mask.createTime ? text.replace(CREATE_TIME_RE, '"createTime":"<CREATE_TIME>"') : text
}

function normalizeHeaderValue(name: string, value: string, mask: MaskProfile): string {
  if (name.toLowerCase() === 'host' && mask.port) return value.replace(PORT_SUFFIX_RE, ':<PORT>')
  return value
}

// ─── Mock upstream transport (played from each fixture's mock-response.json) ─────────

interface MockControl {
  readonly mode?: string
  readonly variant?: string
  readonly status?: number
  readonly after?: number
  readonly error_body?: unknown
  readonly raw_body?: string
}

/** One `script_sse` entry: `[eventName, data]`, or `["RAW", rawText]` for raw wire lines. */
type MockScriptEntry = readonly [string, unknown]

/** Scripted non-SSE reply of an error-mode fixture (S2d7-10 embeds its 429 here). */
interface MockReply {
  readonly status?: number
  readonly body?: unknown
}

interface MockFile {
  readonly control_file: MockControl
  readonly script_sse?: readonly unknown[]
  readonly reply?: MockReply
}

/**
 * The claude mock's built-in error body, used when an error-mode fixture embeds no
 * `reply` (S2d7-10 does embed it, recorded verbatim downstream): the mock serializes with
 * Python `json.dumps` spacing, and the gateway passes the bytes through untouched.
 */
const RATE_LIMIT_ERROR_BODY: unknown = {
  type: 'error',
  error: { type: 'rate_limit_error', message: 'mock rate limit' },
}

const RECORDED_UPSTREAM_MODEL = 'claude-mock-model'

function parseScriptEntries(raw: unknown, caseId: string): readonly MockScriptEntry[] {
  if (!Array.isArray(raw)) {
    throw new Error(`S2d7[${caseId}]: mock-response.json script_sse must be an array`)
  }
  const entries: MockScriptEntry[] = []
  for (const item of raw) {
    if (!Array.isArray(item) || item.length !== 2) {
      throw new Error(
        `S2d7[${caseId}]: script_sse entries must be [eventName, data] or ["RAW", text] pairs`,
      )
    }
    const name = item[0]
    if (typeof name !== 'string') {
      throw new Error(`S2d7[${caseId}]: script_sse entry names must be strings`)
    }
    entries.push([name, item[1]])
  }
  return entries
}

/** Serializes like Python's json.dumps defaults — the mock's recorded byte style. */
function pythonJson(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return value === null ? 'null' : String(value)
  }
  if (Array.isArray(value)) return `[${value.map(pythonJson).join(', ')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}: ${pythonJson(entry)}`).join(', ')}}`
  }
  throw new Error(`mock upstream cannot serialize value of type ${typeof value}`)
}

/** The mock echoes the request model in `message_start`; mis-translation must propagate. */
function echoModel(value: unknown, model: string): unknown {
  if (typeof value === 'string') return value.split(RECORDED_UPSTREAM_MODEL).join(model)
  if (Array.isArray(value)) return value.map((item) => echoModel(item, model))
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) out[key] = echoModel(entry, model)
    return out
  }
  return value
}

/** Lenient model read: a non-JSON translated body must fail in the wire compare, not here. */
function translatedModel(body: string): string {
  try {
    const parsed = JSON.parse(body) as { model?: unknown }
    return typeof parsed.model === 'string' ? parsed.model : RECORDED_UPSTREAM_MODEL
  } catch {
    return RECORDED_UPSTREAM_MODEL
  }
}

/** Demand-driven byte stream: every pull hands out one chunk; the read after the last chunk errors (disconnect) or closes. */
function scriptedByteStream(
  chunks: readonly Uint8Array[],
  options: { readonly abortAfter?: number } = {},
): ReadableStream<Uint8Array> {
  let served = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const index = served
      served += 1
      if (options.abortAfter !== undefined && index >= options.abortAfter) {
        controller.error(new Error('mock upstream: connection reset mid-stream'))
        return
      }
      const chunk = chunks[index]
      if (chunk === undefined) {
        controller.close()
        return
      }
      controller.enqueue(chunk)
    },
  })
}

interface MockResponseSpec {
  readonly status: number
  readonly headers: HeaderList
  readonly body: ReadableStream<Uint8Array>
}

const encoder = new TextEncoder()

function buildMockResponse(
  control: MockControl,
  reply: MockReply | undefined,
  script: readonly MockScriptEntry[],
  upstreamRequest: UpstreamRequest,
): MockResponseSpec {
  const mode = control.mode ?? 'happy'
  if (mode === 'error') {
    const status = control.status ?? reply?.status ?? 500
    const bodyText =
      control.raw_body !== undefined
        ? control.raw_body
        : pythonJson(control.error_body ?? reply?.body ?? RATE_LIMIT_ERROR_BODY)
    return { status, headers: [['Content-Type', 'application/json']], body: scriptedByteStream([encoder.encode(bodyText)]) }
  }
  const model = translatedModel(upstreamRequest.body)
  const chunks: Uint8Array[] = []
  for (const [name, data] of script) {
    if (name === 'RAW') {
      const text = typeof data === 'string' ? data : pythonJson(data)
      chunks.push(encoder.encode(`${text}\n\n`))
      continue
    }
    chunks.push(encoder.encode(`event: ${name}\ndata: ${pythonJson(echoModel(data, model))}\n\n`))
  }
  const abortAfter = mode === 'disconnect' ? (control.after ?? chunks.length) : undefined
  return {
    status: 200,
    headers: [['Content-Type', 'text/event-stream']],
    body: scriptedByteStream(chunks, { abortAfter }),
  }
}

// ─── Comparison helpers ──────────────────────────────────────────────────────────────

function headerValue(headers: HeaderList, name: string): string | undefined {
  const key = name.toLowerCase()
  for (const [headerName, value] of headers) {
    if (headerName.toLowerCase() === key) return value
  }
  return undefined
}

async function readResponseBody(body: SurfaceResponse['body']): Promise<string> {
  if (typeof body === 'string') return body
  if (body !== null && typeof body === 'object' && typeof body.getReader === 'function') {
    const reader = (body as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()
    let out = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      out += decoder.decode(value, { stream: true })
    }
    return out + decoder.decode()
  }
  throw new Error('adapter response body must be a string or a web ReadableStream (see adapter interface in the header)')
}

interface SseFrame {
  readonly event: string | undefined
  readonly data: string
}

/**
 * R-SSE decoder: the ordered list of `{event, data}` blocks. Ordinary frames carry no
 * event name; the §4.4 terminal failure frame is the only one with `event: error`.
 */
function decodeSseFrames(body: string): SseFrame[] {
  const frames: SseFrame[] = []
  for (const block of body.split('\n\n')) {
    let event: string | undefined
    const dataLines: string[] = []
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice('event: '.length)
      else if (line.startsWith('data: ')) dataLines.push(line.slice('data: '.length))
    }
    if (event === undefined && dataLines.length === 0) continue
    frames.push({ event, data: dataLines.join('\n') })
  }
  return frames
}

interface RecordedUpstreamLine {
  readonly method: string
  readonly path: string
  readonly headers: Record<string, string>
  readonly body: string
}

interface CapturedUpstreamCall {
  readonly step: number
  readonly call: UpstreamRequest
}

function assertUpstreamWire(
  recorded: RecordedUpstreamLine,
  captured: CapturedUpstreamCall,
  mask: MaskProfile,
  baseUrl: string,
  caseId: string,
): void {
  const context = `S2d7[${caseId}] step ${captured.step + 1} upstream wire`
  expect(captured.call.method, `${context}: method`).toBe(recorded.method)
  expect(captured.call.url, `${context}: url (baseUrl + recorded path)`).toBe(`${baseUrl.replace(/\/$/, '')}${recorded.path}`)

  const expectedPairs: Array<[string, string]> = []
  for (const [name, value] of Object.entries(recorded.headers)) {
    if (name.toLowerCase() === 'content-length') continue // transport-derived; checked for consistency below
    expectedPairs.push([name, normalizeHeaderValue(name, value, mask)])
  }
  const actualPairs: Array<[string, string]> = []
  let actualContentLength: string | undefined
  for (const [name, value] of captured.call.headers) {
    if (name.toLowerCase() === 'content-length') {
      actualContentLength = value
      continue
    }
    if (name.toLowerCase() === 'authorization') {
      expect(value.startsWith('Bearer '), `${context}: Authorization must carry the Bearer scheme`).toBe(true)
      actualPairs.push([name, '<redacted>'])
      continue
    }
    actualPairs.push([name, normalizeHeaderValue(name, value, mask)])
  }
  expect(actualPairs, `${context}: header list (order + names + values)`).toEqual(expectedPairs)
  if (actualContentLength !== undefined) {
    expect(actualContentLength, `${context}: Content-Length must match the body byte length`).toBe(
      String(encoder.encode(captured.call.body).length),
    )
  }
  expect(normalizeBodyText(captured.call.body, mask), `${context}: translated body bytes`).toBe(
    normalizeBodyText(recorded.body, mask),
  )
}

async function assertDownstreamStep(
  response: SurfaceResponse,
  expected: RecordedResponse,
  mask: MaskProfile,
  caseId: string,
  step: number,
): Promise<void> {
  const context = `S2d7[${caseId}] step ${step} downstream`
  const body = await readResponseBody(response.body)
  expect(response.status, `${context}: status`).toBe(expected.status)

  const expectedContentType = headerValue(expected.headers, 'content-type')
  expect(expectedContentType, `${context}: fixture must record Content-Type`).toBeDefined()
  expect(headerValue(response.headers, 'content-type'), `${context}: Content-Type`).toBe(expectedContentType)

  // Cache-Control: `no-cache` exactly on SSE commits (S2d7 §4.1), absent otherwise —
  // this pins "no SSE headers before commit" for the 429/500/502 cases.
  const expectedCacheControl = headerValue(expected.headers, 'cache-control')
  const actualCacheControl = headerValue(response.headers, 'cache-control')
  if (expectedCacheControl === undefined) {
    expect(actualCacheControl, `${context}: Cache-Control must be absent outside SSE commits`).toBeUndefined()
  } else {
    expect(actualCacheControl, `${context}: Cache-Control`).toBe(expectedCacheControl)
  }

  const expectedRetryAfter = headerValue(expected.headers, 'retry-after')
  const actualRetryAfter = headerValue(response.headers, 'retry-after')
  if (expectedRetryAfter === undefined) {
    expect(actualRetryAfter, `${context}: Retry-After must be absent when the recording has none`).toBeUndefined()
  } else {
    expect(actualRetryAfter, `${context}: Retry-After (pinned cooldown literal)`).toBe(expectedRetryAfter)
  }

  if (expectedContentType === 'text/event-stream') {
    const expectedFrames = decodeSseFrames(expected.body).map((frame) => ({
      event: frame.event,
      data: normalizeBodyText(frame.data, mask),
    }))
    const actualFrames = decodeSseFrames(body).map((frame) => ({
      event: frame.event,
      data: normalizeBodyText(frame.data, mask),
    }))
    expect(actualFrames, `${context}: decoded SSE event sequence (R-SSE; event names + data bytes, in order)`).toEqual(
      expectedFrames,
    )
  } else {
    expect(normalizeBodyText(body, mask), `${context}: body bytes`).toBe(normalizeBodyText(expected.body, mask))
  }
}

// ─── Case runner ─────────────────────────────────────────────────────────────────────

interface StepPlan {
  readonly caseId: string
  readonly request: SurfaceRequest
  readonly expected: RecordedResponse
  readonly control: MockControl
  readonly reply: MockReply | undefined
  readonly script: readonly MockScriptEntry[]
  readonly recordedUpstream: readonly RecordedUpstreamLine[]
  readonly mask: MaskProfile
}

async function loadStep(caseId: string): Promise<StepPlan> {
  const meta = await readFixtureJson<CaseMeta>(caseId, 'meta.yaml')
  const mockFile = await readFixtureJson<MockFile>(caseId, 'mock-response.json')
  const request = parseRequestHttp(await readFixtureText(caseId, 'request.http'))
  const expected = parseDownstreamMarkdown(await readFixtureText(caseId, 'downstream.md'))
  const upstreamText = await readFixtureText(caseId, 'upstream.jsonl')
  const recordedUpstream = upstreamText
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as RecordedUpstreamLine)
  return {
    caseId,
    request,
    expected,
    control: mockFile.control_file,
    reply: mockFile.reply,
    script: parseScriptEntries(mockFile.script_sse ?? [], caseId),
    recordedUpstream,
    mask: maskProfile(caseId, meta.dynamic_fields),
  }
}

async function replayCase(caseId: CaseId): Promise<void> {
  if (adapterFactory === undefined) throw new Error('adapter factory missing')
  const stepCaseIds = COMPOSED_STEPS[caseId] ?? [caseId]
  const steps: StepPlan[] = []
  for (const stepCaseId of stepCaseIds) steps.push(await loadStep(stepCaseId))

  const service = adapterFactory({
    apiKeys: GATEWAY_API_KEYS,
    credentials: DEFAULT_CREDENTIALS,
    gatewayVersion: GATEWAY_VERSION,
    store: new MemoryStore({ now: () => FROZEN_NOW_MS }),
    now: () => FROZEN_NOW_MS,
    requestRetry: 0,
    transientErrorCooldownSeconds: -1,
  })
  if (typeof service.handleV1beta !== 'function') {
    throw new Error(`${ADAPTER_EXPORT}() must return an object with a handleV1beta(request, send) method`)
  }

  const captured: CapturedUpstreamCall[] = []
  let currentStep = 0
  const send: UpstreamSender = async (call) => {
    const step = steps[currentStep]
    if (step === undefined) throw new Error('harness bug: no step plan for the current step')
    captured.push({ step: currentStep, call })
    return buildMockResponse(step.control, step.reply, step.script, call)
  }

  for (let index = 0; index < steps.length; index += 1) {
    currentStep = index
    const step = steps[index]
    if (step === undefined) throw new Error('unreachable: step index out of range')
    const response = await service.handleV1beta(step.request, send)
    await assertDownstreamStep(response, step.expected, step.mask, step.caseId, index + 1)
  }

  const expectedTotal = steps.reduce((sum, step) => sum + step.recordedUpstream.length, 0)
  expect(captured.length, `S2d7[${caseId}]: upstream call count (cooldown/auth/countTokens steps must not call upstream)`).toBe(
    expectedTotal,
  )
  let cursor = 0
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]
    if (step === undefined) throw new Error('unreachable: step index out of range')
    for (const recorded of step.recordedUpstream) {
      const capturedCall = captured[cursor]
      expect(capturedCall, `S2d7[${caseId}]: missing upstream call ${cursor + 1}`).toBeDefined()
      if (capturedCall !== undefined) {
        expect(capturedCall.step, `S2d7[${caseId}]: upstream call ${cursor + 1} must belong to step ${index + 1}`).toBe(index)
        assertUpstreamWire(recorded, capturedCall, step.mask, DEFAULT_CREDENTIALS[0]?.baseUrl ?? '', step.caseId)
      }
      cursor += 1
    }
  }
}

// ─── Suites ──────────────────────────────────────────────────────────────────────────

describe('S2d7 fixture inventory (harness self-check, adapter-independent)', () => {
  it('exposes exactly the 31 admitted golden cases, each internally consistent', async () => {
    expect([...fixtureCaseDirs]).toEqual([...EXPECTED_CASES].sort())
    for (const caseId of EXPECTED_CASES) {
      const meta = await readFixtureJson<CaseMeta>(caseId, 'meta.yaml')
      const mockFile = await readFixtureJson<MockFile>(caseId, 'mock-response.json')
      expect(meta.case, `${caseId}: meta.case echoes the directory name`).toBe(caseId)
      maskProfile(caseId, meta.dynamic_fields) // fails loudly on unknown dynamic fields
      parseScriptEntries(mockFile.script_sse ?? [], caseId)
      if ((mockFile.control_file.mode ?? 'happy') !== 'error') {
        expect(mockFile.script_sse, `${caseId}: non-error mock controls must embed their event script`).toBeDefined()
      } else {
        expect(
          mockFile.reply?.body !== undefined || mockFile.control_file.error_body !== undefined,
          `${caseId}: error-mode mock controls must embed a reply body`,
        ).toBe(true)
      }

      const request = parseRequestHttp(await readFixtureText(caseId, 'request.http'))
      const contentLength = Number(headerValue(request.headers, 'content-length'))
      expect(contentLength, `${caseId}: parsed body length matches the recorded Content-Length`).toBe(
        new TextEncoder().encode(request.body).length,
      )
      expect(request.method, `${caseId}: route method`).toBe('POST')
      expect(request.path, `${caseId}: /v1beta generation surface path`).toMatch(V1BETA_PATH_RE)
      expect(() => JSON.parse(request.body), `${caseId}: request body is well-formed JSON (NE-LENIENT)`).not.toThrow()

      const upstreamText = await readFixtureText(caseId, 'upstream.jsonl')
      const upstreamLines = upstreamText.split('\n').filter((line) => line.trim() !== '')
      expect(upstreamLines.length, `${caseId}: upstream.jsonl line count matches meta.upstream_wire_delta_lines`).toBe(
        meta.upstream_wire_delta_lines,
      )
      for (const line of upstreamLines) {
        const recorded = JSON.parse(line) as RecordedUpstreamLine
        expect(recorded.method, `${caseId}: recorded upstream method`).toBe('POST')
        expect(recorded.path, `${caseId}: recorded upstream path carries ?beta=true (S2d7 §2.2)`).toBe(
          '/v1/messages?beta=true',
        )
        expect(recorded.headers['Anthropic-Version'], `${caseId}: recorded Anthropic-Version`).toBe('2023-06-01')
        expect(recorded.headers.Authorization, `${caseId}: recorded Authorization is redacted in the wire log`).toBe(
          '<redacted>',
        )
      }

      const recorded = parseDownstreamMarkdown(await readFixtureText(caseId, 'downstream.md'))
      expect(headerValue(recorded.headers, 'content-type'), `${caseId}: fixture must record Content-Type`).toBeDefined()
      if (caseId === 'S2d7-19-cooldown-after-429') {
        // The composed cooldown case: its own delta is zero-call, and the composition must
        // have the recorded 429 trigger as its first step.
        expect(meta.upstream_wire_delta_lines, `${caseId}: cooldown delta records no upstream call`).toBe(0)
        expect(COMPOSED_STEPS[caseId]?.[0], `${caseId}: composed replay starts from the recorded 429 case`).toBe(
          'S2d7-10-upstream-429',
        )
      }
    }
  })
})

suite(suiteTitle, () => {
  for (const caseId of EXPECTED_CASES) {
    it(`${caseId} — replays recorded steps: upstream wire byte-exact, downstream surface byte-exact`, async () => {
      await replayCase(caseId)
    })
  }
})
