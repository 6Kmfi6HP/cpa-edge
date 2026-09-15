/**
 * S2d8 golden contract — Claude (Anthropic Messages) client → Gemini upstream.
 *
 * Spec source of truth: spec/sections/S2d8-cla2gem.md (admitted). Goldens: the 18 recorded
 * fixture cases under tests/fixtures/S2d8/ — oracle wire transcripts of CLIProxyAPI v7.3.4
 * (commit 8335eac…) against the deterministic gemini mock (RECORDABLE-LOCALLY per R-FIXTURE;
 * transcripts only, no upstream source text). Rulings applied: R-SSE (downstream stream bodies
 * compare as DECODED event sequences — here frame name + data bytes + the pinned 3/2-newline
 * framing — never transport chunk boundaries), R-TOK + S2d8-1 (message_start.usage.input_tokens
 * is an o200k_base estimate of the ORIGINAL client request bytes, asserted byte-exactly and
 * UNMASKED; the recorded values are 4/9/32/4/4/4 across the six stream goldens), NE-LENIENT
 * (fixtures replay well-formed bodies only; the inventory self-check JSON-validates every
 * request body), R-FIXTURE, R-404 (route surface declared, no fixture exercises method/path
 * mismatches). R-ORDER is recorded here as NOT APPLICABLE: this surface emits at most one
 * delta frame per upstream part, so no run of interchangeably-ordered adjacent frames exists —
 * every frame is order-pinned. R-BCRYPT never touches this surface.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * ADAPTER INTERFACE — what the `@cpa-edge/translators/cla2gem` direction module MUST
 * export. The suite dynamically imports the package and turns green-to-red once the export
 * ships; while the package is still a skeleton every case test SKIPS with the reason below.
 * The harness holds its own structural mirror of these types; the package should export the
 * real ones. All shapes are runtime-checked by the suite.
 *
 *   export function createCla2GemService(options: Cla2GemServiceOptions): Cla2GemService
 *
 *   type HeaderList = ReadonlyArray<readonly [string, string]>   // ordered, original casing
 *
 *   interface Cla2GemModelEntry {
 *     name: string                    // upstream model name (alias target)
 *     alias?: string                  // client-facing alias; ONLY the alias routes (§3.1
 *   }                                 // routing note — the upstream name is NOT routable)
 *
 *   interface Cla2GemCredential {
 *     apiKey: string                  // sent as `X-Goog-Api-Key: <apiKey>` (recorded)
 *     baseUrl: string                 // e.g. "http://host.docker.internal:19001"; trailing
 *                                     // "/" trimmed (§2.2)
 *     models: readonly Cla2GemModelEntry[]
 *   }
 *
 *   interface Cla2GemServiceOptions {
 *     credentials: readonly Cla2GemCredential[] // gemini-api-key entries, config order
 *     store: Store                    // from @cpa-edge/core; ALL persistent state
 *                                     // (rotation/cooldown) flows through it
 *     now?: () => number              // epoch-ms clock; MUST be used for every timing decision
 *     requestRetry?: number           // 0 in every S2d8 fixture (single attempt)
 *     transientErrorCooldownSeconds?: number // -1 in every S2d8 fixture; note this does NOT
 *                                     // disable the ~1s 429 rate-limit cooldown (§4.2) — no
 *                                     // golden observes it (single-step replays; S4 owns it)
 *   }
 *
 *   interface Cla2GemRequest {
 *     method: string                  // 'POST'
 *     path: string                    // '/v1/messages' | '/v1/messages/count_tokens'
 *     headers: HeaderList             // client headers, recorded order + casing
 *     body: string                    // exact request-body bytes; well-formed JSON per
 *                                     // NE-LENIENT — STRICT boundary: malformed/non-JSON
 *                                     // bodies are rejected with the §2.1 400 shape and
 *                                     // zero upstream dispatch (spec'd, not golden-pinned)
 *   }
 *
 *   interface Cla2GemUpstreamRequest {
 *     method: string                  // 'POST'
 *     url: string                     // `${baseUrl}/v1beta/models/<resolved-model>:<action>`
 *                                     //   :generateContent | :streamGenerateContent?alt=sse
 *                                     //   | :countTokens  — `?alt=sse` is constant for
 *                                     //   streamed /v1/messages requests (§2.2)
 *     headers: HeaderList             // pinned order: Host, User-Agent, [Content-Length],
 *                                     // Content-Type, X-Goog-Api-Key, Accept-Encoding.
 *                                     // User-Agent is the literal `Go-http-client/1.1`
 *                                     // (recorded wire compatibility). `Authorization` and
 *                                     // `Accept` are NEVER carried (§2.2, incl. streams).
 *     body: string
 *   }
 *
 *   interface Cla2GemUpstreamResponse {
 *     status: number
 *     headers: HeaderList
 *     body: ReadableStream<Uint8Array> // 2xx: SSE or JSON bytes; non-2xx: raw error bytes.
 *                                       // A rejected read mid-body models an upstream
 *                                       // disconnect.
 *   }
 *
 *   type Cla2GemUpstreamSender =
 *     (request: Cla2GemUpstreamRequest) => Promise<Cla2GemUpstreamResponse>
 *
 *   interface Cla2GemResponse {
 *     status: number
 *     headers: HeaderList             // must carry the direction-owned subset (see below)
 *     body: string | ReadableStream<Uint8Array>
 *   }
 *
 *   interface Cla2GemService {
 *     handleMessages(
 *       request: Cla2GemRequest,
 *       send: Cla2GemUpstreamSender,
 *     ): Promise<Cla2GemResponse>     // dispatches on request.path across both routes
 *   }
 *
 * The facade covers the whole pinned direction pipeline: alias-only model resolution and the
 * alias→upstream-name rewrite (§3.1), request translation with the byte-encoding MUSTs (§3.2:
 * HTML escaping, raw client-byte passthrough for tool args/tool_result raw values/schema,
 * functionCall/functionResponse key orders, reminder turn, merge/reorder/align rules, boundary
 * user turns, the two-stage thinking rule whose executor capability strip is golden-pinned by
 * S2d8-07/10, safetySettings injection, the count_tokens body variant), the upstream
 * header/URL policy (§2.2), non-stream response mapping (§3.4: template order, id/model
 * omission → template defaults, tool_use id restoration, stop_reason ladder, usage formulas
 * including cached/thoughts and the usage-key deletion), the stream state machine (§3.5:
 * literal-default message_start, js-tiktoken o200k_base input estimate per R-TOK/S2d8-1,
 * block transitions, final-events gate, message_stop HasContent gate, per-chunk usage
 * stripping, the terminal error event with the pinned `unexpected EOF`), error semantics
 * (§4: status passthrough + Claude envelope with numeric-code-skipping message extraction,
 * pre-commit plain-JSON errors, no Retry-After), and count_tokens end-to-end (§3.6: a REAL
 * upstream `:countTokens` call with the stripped body).
 * OUT of scope here (owned by S1/the runtime, asserted by no fixture in this suite): gateway
 * API-key auth, the CORS block, `Date`, `X-Cpa-Trace-Id`, `Connection`, `Transfer-Encoding`,
 * downstream `Content-Length`, R-404 routing, and SSE keep-alive heartbeats (default OFF;
 * the byte compare forbids stray frames).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * HARNESS SEMANTICS
 *
 * • Per case the harness builds a fresh service + fresh MemoryStore. The clock is frozen
 *   (`now()` returns a constant inside the recording window); no golden observes cooldown
 *   state because every case is a single-step replay.
 * • The mock upstream is played from each case's meta.yaml `mock_control` (this fixture set
 *   embeds its mock controls in meta.yaml instead of a separate mock-response.json):
 *   `canned_nonstream` / `canned_count` serve one JSON 200 body; `canned_stream` serves one
 *   `data: <json>\n\n` SSE frame per chunk (the gemini mock's alt=sse wire has no event
 *   names); `mode:"error"` serves `status` + `error_body`; `mode:"slow"` adds an inter-chunk
 *   delay (pins that no heartbeat frames appear while waiting); `mode:"disconnect"` aborts
 *   the read after `after` chunks — the rejection text deliberately differs from the pinned
 *   terminal message, so the adapter must surface `unexpected EOF` regardless of the
 *   transport error's own text (§4.2).
 * • Mock serialization uses Python `json.dumps` spacing (", " / ": ") — the mock fleet's
 *   recorded byte style, proven by the S2d3 verbatim-429 passthrough goldens. The goldens
 *   show the gateway RE-SERIALIZES parsed values compactly downstream (S2d8-04 `input`,
 *   S2d8-11 `partial_json` are compact while the mock serves spaced JSON), so a byte-faithful
 *   adapter must compact; passing the mock's spaced bytes through fails the compare by design.
 * • Upstream calls are captured; at the end of a case the captured sequence must equal the
 *   recorded upstream.jsonl lines (count + bytes). The count_tokens case therefore pins that
 *   a REAL upstream call is made (no local synthesis), and every error case pins the exact
 *   single attempt.
 * • The recorded wire (upstream.jsonl / downstream.md) is AUTHORITATIVE over the metas'
 *   `expected_upstream` / `expected_downstream_body` fields, which this suite never reads:
 *   gate round-1 finding B1 (S2d8-07/10) showed those meta fields can carry pre-strip
 *   expectations while the recorded wire pins the capability-stripped shape.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * COMPARISON RULES
 *
 * Upstream wire (primary gold):
 *   - method, url (baseUrl + recorded path, including the constant `?alt=sse` on stream
 *     calls), body: byte-exact. The body bytes pin the §2.3 top-level key order, the
 *     safetySettings 5-category block, HTML escaping, raw client-byte passthrough, the
 *     functionCall/functionResponse key orders, inline_data placement, and the alias rewrite.
 *   - headers: the full ordered list, names case-preserved, in the recorded order
 *     `Host, User-Agent, [Content-Length], Content-Type, X-Goog-Api-Key, Accept-Encoding`.
 *     `Content-Length` is excluded from the ordered compare (transport-derived; if the adapter
 *     emits it, it must equal the body byte length). `X-Goog-Api-Key` is redacted in the
 *     recordings; the adapter's value must equal the credential key and is then normalized to
 *     "<redacted>". `Authorization` and `Accept` must be ABSENT on every call, stream or not.
 *     The recording-only `ts`/`type`/`credential`/`response_status` fields of upstream.jsonl
 *     are never part of the wire request.
 *
 * Downstream:
 *   - status: exact. Non-SSE bodies (message JSON, error envelopes, count_tokens): byte-exact.
 *     This pins the §3.4 template field order, the id/model omission rule, the stop_reason
 *     ladder, the usage formulas (incl. cache_read_input_tokens and the usage-key deletion),
 *     and the §4/§4.1 error envelopes.
 *   - SSE bodies compare as DECODED event sequences per R-SSE: the ordered list of frames
 *     `{event, data, tail}` where `tail` is the framing terminator (3 newlines for every
 *     ordinary event, 2 newlines for the single terminal error event — §3.5/§4.2). The
 *     decoder rejects any other framing, which pins the 3-newline rule and the absence of
 *     `[DONE]`/heartbeat/stray lines without a separate assertion.
 *   - headers: only the direction-owned subset is asserted: `Content-Type` (exact),
 *     `Cache-Control` (exact `no-cache` on SSE commits, absent otherwise — pins "no SSE
 *     headers before the first translated chunk" for the S2d8-18 pre-commit 500), and
 *     `Retry-After` (absent — the gemini executor attaches none). Absence is asserted, not
 *     forgiven.
 *
 * MASKS — applied identically to recorded and produced bytes, derived from each case's
 * meta.yaml `dynamic_fields` (unknown entries fail the suite loudly so new volatility must be
 * added consciously):
 *   - `Date`, `X-Cpa-Trace-Id`, downstream `Content-Length`: response-head values owned by
 *     S1/the runtime; never asserted on any compared surface.
 *   - upstream Host port: trailing `:port` of the upstream `Host` header value → `:<PORT>`
 *     (worker-local mock port 19001; the reference port 18317 appears only in the never
 *     compared client-request Host).
 *   - `content_block.id` digits in STREAM tool_use events → `<name>-<digits>` is masked to
 *     `<name>-<N>` (the reference's counter is process-scoped; ruling S2d8-2 accepts the
 *     mask while the shape stays asserted). The regex anchors on the `"content_block"`
 *     wrapper key, so the LITERAL-DEFAULT message id (`msg_1nZd…`) and the deterministic
 *     NON-STREAM tool_use ids (`get_weather-1`, a per-response counter) are NOT masked.
 * Deliberately NOT masked (each is deterministic; masking would weaken a recorded pin):
 *   - `message_start.usage.input_tokens` — the o200k_base estimate is asserted byte-exactly
 *     per R-TOK/S2d8-1 (4/9/32/4/4/4 across the stream goldens).
 *   - the terminal transport-error message `unexpected EOF` (recorded; the adapter must
 *     produce it regardless of its transport's own error text).
 */

import { readdir, readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { MemoryStore } from '@cpa-edge/core'
import type { Store } from '@cpa-edge/core'

// ─── Adapter load (skip-with-explanation until the real export ships) ────────────────

const ADAPTER_MODULE = '@cpa-edge/translators/cla2gem'
const ADAPTER_EXPORT = 'createCla2GemService'

/** Structural mirror of the adapter interface documented in the header. */
type HeaderList = ReadonlyArray<readonly [string, string]>

interface ModelEntry {
  readonly name: string
  readonly alias?: string
}

interface CredentialConfig {
  readonly apiKey: string
  readonly baseUrl: string
  readonly models: readonly ModelEntry[]
}

interface ServiceOptions {
  readonly credentials: readonly CredentialConfig[]
  readonly store: Store
  readonly now: () => number
  readonly requestRetry: number
  readonly transientErrorCooldownSeconds: number
}

interface MessagesRequest {
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

interface MessagesResponse {
  readonly status: number
  readonly headers: HeaderList
  readonly body: string | ReadableStream<Uint8Array>
}

interface MessagesService {
  handleMessages(request: MessagesRequest, send: UpstreamSender): Promise<MessagesResponse>
}

type AdapterFactory = (options: ServiceOptions) => MessagesService

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
        'All 18 S2d8 golden cases SKIP until the cla2gem adapter ships; the required interface is documented in the header of this file.',
    }
  } catch (error) {
    return { skipReason: `import of \`${ADAPTER_MODULE}\` failed: ${String(error)}` }
  }
}

const adapterLoad = await loadAdapter()
const adapterFactory = adapterLoad.factory
const suite = adapterFactory ? describe : describe.skip
const suiteTitle = adapterFactory
  ? 'S2d8 — cla2gem golden contract (recorded fixtures)'
  : `S2d8 — cla2gem golden contract (SKIPPED: ${adapterLoad.skipReason ?? 'adapter unavailable'})`

// ─── Fixture access ───────────────────────────────────────────────────────────────────

const FIXTURE_ROOT = new URL('../fixtures/S2d8/', import.meta.url)
const FROZEN_NOW_MS = 1_789_504_384_000
const CLIENT_ROUTE = '/v1/messages'
const COUNT_ROUTE = '/v1/messages/count_tokens'
const RECORDED_UPSTREAM_MODEL = 'gemini-mock-model'

/** Recording-instance credential set, transcribed from the meta.yaml config fragments. */
const DEFAULT_CREDENTIALS: readonly CredentialConfig[] = [
  {
    apiKey: 'mock-gem-key',
    baseUrl: 'http://host.docker.internal:19001',
    models: [{ name: RECORDED_UPSTREAM_MODEL, alias: 'gm' }],
  },
]

const EXPECTED_CASES = [
  'S2d8-01-nostream-basic',
  'S2d8-02-nostream-alias',
  'S2d8-03-nostream-system-array',
  'S2d8-04-nostream-tool-call',
  'S2d8-05-nostream-tool-history',
  'S2d8-06-nostream-image',
  'S2d8-07-nostream-thinking',
  'S2d8-08-nostream-maxtokens',
  'S2d8-09-stream-basic',
  'S2d8-10-stream-thinking',
  'S2d8-11-stream-tool-call',
  'S2d8-12-stream-empty',
  'S2d8-13-count-tokens',
  'S2d8-14-err-429',
  'S2d8-15-err-400',
  'S2d8-16-slow-chunks',
  'S2d8-17-disconnect',
  'S2d8-18-stream-error-before-first-chunk',
] as const

type CaseId = (typeof EXPECTED_CASES)[number]

const UPSTREAM_PATH_RE = new RegExp(
  `^/v1beta/models/${RECORDED_UPSTREAM_MODEL}:(generateContent|streamGenerateContent\\?alt=sse|countTokens)$`,
)

/** §2.3 top-level body key order; recorded bodies must list their keys in this order. */
const BODY_KEY_ORDER = [
  'contents',
  'model',
  'systemInstruction',
  'tools',
  'toolConfig',
  'generationConfig',
  'safetySettings',
] as const

const RECORDED_HEADER_ORDER = [
  'Host',
  'User-Agent',
  'Content-Length',
  'Content-Type',
  'X-Goog-Api-Key',
  'Accept-Encoding',
] as const

const fixtureCaseDirs = (await readdir(FIXTURE_ROOT, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()

function caseFile(caseId: string, name: string): URL {
  return new URL(`${caseId}/${name}`, FIXTURE_ROOT)
}

async function readFixtureText(caseId: string, name: string): Promise<string> {
  // The S2d8 recordings are LF-only; the terminator normalization is defensive and keeps
  // every compared surface CR-free regardless of recorder variance.
  const raw = await readFile(caseFile(caseId, name), 'utf8')
  return raw.replaceAll('\r\n', '\n')
}

async function readFixtureJson<T>(caseId: string, name: string): Promise<T> {
  return JSON.parse(await readFixtureText(caseId, name)) as T
}

// ─── Fixture file parsers (request.http / downstream.md) ─────────────────────────────

function parseRequestHttp(text: string): MessagesRequest {
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

/**
 * S2d8 downstream.md convention: each section is a fenced block holding the exact bytes
 * (`## Status + headers`, then `## body` for JSON bodies or `## full SSE byte stream` for
 * streams). The recorder terminates the byte payload with one extra newline before the
 * closing fence, so the parser strips exactly one trailing newline — pinned against every
 * recorded Content-Length by the inventory self-check.
 */
function fencedSection(text: string, marker: string, caseId: string): string {
  const markerIndex = text.indexOf(marker)
  if (markerIndex === -1) throw new Error(`S2d8[${caseId}]: downstream.md is missing the ${JSON.stringify(marker)} section`)
  const open = text.indexOf('```', markerIndex)
  if (open === -1) throw new Error(`S2d8[${caseId}]: downstream.md ${JSON.stringify(marker)} section has no opening fence`)
  const close = text.indexOf('\n```', open + 4)
  if (close === -1) throw new Error(`S2d8[${caseId}]: downstream.md ${JSON.stringify(marker)} section is never closed`)
  const content = text.slice(open + 4, close)
  if (!content.endsWith('\n')) {
    throw new Error(`S2d8[${caseId}]: downstream.md ${JSON.stringify(marker)} section does not end with the recorder newline`)
  }
  return content.slice(0, -1)
}

interface RecordedResponse {
  readonly status: number
  readonly headers: HeaderList
  readonly body: string
}

function parseDownstreamMarkdown(text: string, caseId: string): RecordedResponse {
  const head = fencedSection(text, '## Status + headers', caseId)
  const bodyMarker = text.includes('## full SSE byte stream') ? '## full SSE byte stream' : '## body'
  const body = fencedSection(text, bodyMarker, caseId)
  const headLines = head.split('\n')
  const statusLine = headLines[0] ?? ''
  if (!statusLine.startsWith('HTTP/1.1 ')) throw new Error(`S2d8[${caseId}]: downstream.md has no status line`)
  const status = Number(statusLine.split(' ')[1])
  const headers: Array<[string, string]> = []
  for (const line of headLines.slice(1)) {
    if (line.trim() === '') continue
    const separator = line.indexOf(': ')
    if (separator <= 0) continue
    headers.push([line.slice(0, separator), line.slice(separator + 2)])
  }
  return { status, headers, body }
}

// ─── Masking (meta.yaml dynamic_fields → normalization) ──────────────────────────────

interface MaskProfile {
  readonly port: boolean
  readonly toolIdDigits: boolean
}

const PORT_SUFFIX_RE = /:\d+$/
/** Anchored on the stream `content_block` wrapper so non-stream ids stay byte-pinned. */
const STREAM_TOOL_ID_RE = /("content_block":\{"type":"tool_use","id":"[^"]+?)-\d+"/g

function maskProfile(caseId: string, dynamicFields: readonly string[]): MaskProfile {
  let port = false
  let toolIdDigits = false
  for (const field of dynamicFields) {
    if (field === 'Date, X-Cpa-Trace-Id, Content-Length headers') {
      continue // response-head values owned by S1/the runtime; never asserted
    }
    if (
      field === 'reference/mock port numbers in upstream.jsonl Host fields' ||
      field === 'ports (worker-local): reference 18317, mock 19001'
    ) {
      port = true
      continue
    }
    if (
      field ===
      'content_block.id digits in stream tool_use events (process counter; orchestrator ruling S2d8-2 accepts masking)'
    ) {
      toolIdDigits = true
      continue
    }
    if (field === "terminal transport-error text if it differs from 'unexpected EOF' (record what the reference emits)") {
      continue // recorded text IS the golden ("unexpected EOF"); byte-pinned, not masked
    }
    throw new Error(
      `S2d8[${caseId}]: unrecognized meta.yaml dynamic_fields entry ${JSON.stringify(field)} — ` +
        'extend the mask table in tests/contract/s2d8-cla2gem.test.ts consciously',
    )
  }
  return { port, toolIdDigits }
}

function normalizeHeaderValue(name: string, value: string, mask: MaskProfile): string {
  if (name.toLowerCase() === 'host' && mask.port) return value.replace(PORT_SUFFIX_RE, ':<PORT>')
  return value
}

function maskSseFrameData(data: string, mask: MaskProfile): string {
  return mask.toolIdDigits ? data.replace(STREAM_TOOL_ID_RE, '$1-<N>"') : data
}

// ─── Mock upstream transport (played from each case's meta.yaml mock_control) ─────────

interface MockControl {
  readonly mode?: string
  readonly status?: number
  readonly error_body?: unknown
  readonly delay_ms?: number
  readonly after?: number
  readonly canned_nonstream?: unknown
  readonly canned_stream?: readonly unknown[]
  readonly canned_count?: unknown
}

interface CaseMeta {
  readonly id: string
  readonly http_status: string | number
  readonly upstream_hits: number
  readonly dynamic_fields: readonly string[]
  readonly mock_control: MockControl
  readonly request_model_substituted?: string
  readonly gate_round1_correction_B1?: string
}

/** Serializes like Python's json.dumps defaults — the mock fleet's recorded byte style. */
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Demand-driven byte stream: every pull hands out one chunk; the read after the last chunk errors (disconnect) or closes. */
function scriptedByteStream(
  chunks: readonly Uint8Array[],
  options: { readonly abortAfter?: number; readonly delayMs?: number } = {},
): ReadableStream<Uint8Array> {
  let served = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const index = served
      served += 1
      if (options.delayMs !== undefined && index > 0) await sleep(options.delayMs)
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

/**
 * Replays the recorded mock behavior. The gemini mock serves canned JSON with Python
 * spacing and canned stream chunks as bare `data:` frames (no event names on this wire);
 * a disconnect surfaces as a rejected read whose text differs from the pinned terminal
 * message on purpose (§4.2).
 */
function buildMockResponse(control: MockControl, caseId: string): MockResponseSpec {
  const mode = control.mode ?? 'happy'
  if (mode === 'error') {
    if (control.status === undefined || control.error_body === undefined) {
      throw new Error(`S2d8[${caseId}]: error-mode mock control must carry status + error_body`)
    }
    return {
      status: control.status,
      headers: [['Content-Type', 'application/json']],
      body: scriptedByteStream([encoder.encode(pythonJson(control.error_body))]),
    }
  }
  if (control.canned_count !== undefined) {
    return {
      status: 200,
      headers: [['Content-Type', 'application/json']],
      body: scriptedByteStream([encoder.encode(pythonJson(control.canned_count))]),
    }
  }
  if (control.canned_nonstream !== undefined) {
    return {
      status: 200,
      headers: [['Content-Type', 'application/json']],
      body: scriptedByteStream([encoder.encode(pythonJson(control.canned_nonstream))]),
    }
  }
  if (control.canned_stream !== undefined) {
    const chunks = control.canned_stream.map((chunk) => {
      if (chunk === undefined || chunk === null) {
        throw new Error(`S2d8[${caseId}]: canned_stream entries must be JSON values`)
      }
      return encoder.encode(`data: ${pythonJson(chunk)}\n\n`)
    })
    const abortAfter = mode === 'disconnect' ? control.after : undefined
    const delayMs = mode === 'slow' ? control.delay_ms : undefined
    return {
      status: 200,
      headers: [['Content-Type', 'text/event-stream']],
      body: scriptedByteStream(chunks, { abortAfter, delayMs }),
    }
  }
  throw new Error(`S2d8[${caseId}]: mock control has neither an error reply nor a canned body`)
}

// ─── Comparison helpers ──────────────────────────────────────────────────────────────

function headerValue(headers: HeaderList, name: string): string | undefined {
  const key = name.toLowerCase()
  for (const [headerName, value] of headers) {
    if (headerName.toLowerCase() === key) return value
  }
  return undefined
}

async function readResponseBody(body: MessagesResponse['body']): Promise<string> {
  if (typeof body === 'string') return body
  if (body !== null && typeof body === 'object' && typeof body.getReader === 'function') {
    const reader = body.getReader()
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
  readonly event: string
  readonly data: string
  readonly tail: 2 | 3
}

/**
 * R-SSE decoder for the Claude-client framing: the ordered frame list with the terminator
 * pinned per §3.5/§4.2 — three newlines after every ordinary data line, two after the
 * single terminal error event. Anything else (event-less frames, [DONE], heartbeats,
 * 2-newline frames before the end) fails with an explicit framing error.
 */
function decodeSseFrames(body: string, context: string): SseFrame[] {
  const frames: SseFrame[] = []
  let cursor = 0
  while (cursor < body.length) {
    if (!body.startsWith('event: ', cursor)) {
      throw new Error(`${context}: byte offset ${cursor}: every downstream SSE frame must open with an "event: " line`)
    }
    const nameEnd = body.indexOf('\n', cursor + 7)
    if (nameEnd === -1) throw new Error(`${context}: unterminated event-name line`)
    const event = body.slice(cursor + 7, nameEnd)
    if (!body.startsWith('data: ', nameEnd + 1)) {
      throw new Error(`${context}: event ${JSON.stringify(event)} must carry exactly one "data: " line`)
    }
    const dataEnd = body.indexOf('\n', nameEnd + 7)
    if (dataEnd === -1) throw new Error(`${context}: event ${JSON.stringify(event)} has an unterminated data line`)
    const data = body.slice(nameEnd + 7, dataEnd)
    if (body.startsWith('\n\n\n', dataEnd)) {
      frames.push({ event, data, tail: 3 })
      cursor = dataEnd + 3
      continue
    }
    if (body.startsWith('\n\n', dataEnd) && dataEnd + 2 === body.length) {
      frames.push({ event, data, tail: 2 })
      cursor = body.length
      continue
    }
    throw new Error(
      `${context}: event ${JSON.stringify(event)} must end with the 3-newline terminator ` +
        '(2 newlines are legal only for the single terminal error event, §4.2)',
    )
  }
  return frames
}

interface RecordedUpstreamLine {
  readonly method: string
  readonly path: string
  readonly headers: Record<string, string>
  readonly body: string
  readonly response_status?: number
}

function assertUpstreamWire(
  recorded: RecordedUpstreamLine,
  captured: UpstreamRequest,
  mask: MaskProfile,
  baseUrl: string,
  caseId: string,
): void {
  const context = `S2d8[${caseId}] upstream wire`
  expect(captured.method, `${context}: method`).toBe(recorded.method)
  expect(captured.url, `${context}: url (baseUrl + recorded path; ?alt=sse constant on streams)`).toBe(
    `${baseUrl.replace(/\/$/, '')}${recorded.path}`,
  )

  const expectedPairs: Array<[string, string]> = []
  for (const [name, value] of Object.entries(recorded.headers)) {
    if (name.toLowerCase() === 'content-length') continue // transport-derived; checked below
    expectedPairs.push([name, normalizeHeaderValue(name, value, mask)])
  }
  const actualPairs: Array<[string, string]> = []
  let actualContentLength: string | undefined
  for (const [name, value] of captured.headers) {
    const key = name.toLowerCase()
    if (key === 'content-length') {
      actualContentLength = value
      continue
    }
    if (key === 'authorization' || key === 'accept') {
      throw new Error(`${context}: header ${JSON.stringify(name)} must never be sent upstream (§2.2)`)
    }
    if (key === 'x-goog-api-key') {
      expect(value, `${context}: X-Goog-Api-Key must carry the credential key`).toBe(DEFAULT_CREDENTIALS[0]?.apiKey)
      actualPairs.push([name, '<redacted>'])
      continue
    }
    actualPairs.push([name, normalizeHeaderValue(name, value, mask)])
  }
  expect(actualPairs, `${context}: header list (order + names + values)`).toEqual(expectedPairs)
  if (actualContentLength !== undefined) {
    expect(actualContentLength, `${context}: Content-Length must match the body byte length`).toBe(
      String(encoder.encode(captured.body).length),
    )
  }
  expect(captured.body, `${context}: translated body bytes`).toBe(recorded.body)
}

async function assertDownstream(
  response: MessagesResponse,
  expected: RecordedResponse,
  mask: MaskProfile,
  caseId: string,
): Promise<void> {
  const context = `S2d8[${caseId}] downstream`
  const body = await readResponseBody(response.body)
  expect(response.status, `${context}: status`).toBe(expected.status)

  const expectedContentType = headerValue(expected.headers, 'content-type')
  expect(expectedContentType, `${context}: fixture must record Content-Type`).toBeDefined()
  expect(headerValue(response.headers, 'content-type'), `${context}: Content-Type`).toBe(expectedContentType)

  // Cache-Control: `no-cache` exactly on SSE commits (§2.1), absent otherwise — pins
  // "no SSE headers before the first translated chunk" for the pre-commit 500 of S2d8-18.
  const expectedCacheControl = headerValue(expected.headers, 'cache-control')
  const actualCacheControl = headerValue(response.headers, 'cache-control')
  if (expectedCacheControl === undefined) {
    expect(actualCacheControl, `${context}: Cache-Control must be absent outside SSE commits`).toBeUndefined()
  } else {
    expect(actualCacheControl, `${context}: Cache-Control`).toBe(expectedCacheControl)
  }

  // The gemini executor attaches no Retry-After on any error path (§4.1).
  expect(headerValue(response.headers, 'retry-after'), `${context}: Retry-After must be absent`).toBeUndefined()

  if (expectedContentType === 'text/event-stream') {
    const expectedFrames = decodeSseFrames(expected.body, `${context}: recorded body`).map((frame) => ({
      event: frame.event,
      data: maskSseFrameData(frame.data, mask),
      tail: frame.tail,
    }))
    const actualFrames = decodeSseFrames(body, `${context}: produced body`).map((frame) => ({
      event: frame.event,
      data: maskSseFrameData(frame.data, mask),
      tail: frame.tail,
    }))
    expect(actualFrames, `${context}: decoded SSE event sequence (R-SSE; names + data bytes + framing, in order)`).toEqual(
      expectedFrames,
    )
  } else {
    expect(body, `${context}: body bytes`).toBe(expected.body)
  }
}

// ─── Case runner ─────────────────────────────────────────────────────────────────────

function parseRecordedUpstream(text: string, caseId: string): readonly RecordedUpstreamLine[] {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as RecordedUpstreamLine)
}

async function replayCase(caseId: CaseId): Promise<void> {
  if (adapterFactory === undefined) throw new Error('adapter factory missing')
  const meta = await readFixtureJson<CaseMeta>(caseId, 'meta.yaml')
  const request = parseRequestHttp(await readFixtureText(caseId, 'request.http'))
  const expected = parseDownstreamMarkdown(await readFixtureText(caseId, 'downstream.md'), caseId)
  const recordedUpstream = parseRecordedUpstream(await readFixtureText(caseId, 'upstream.jsonl'), caseId)
  const mask = maskProfile(caseId, meta.dynamic_fields)

  const service = adapterFactory({
    credentials: DEFAULT_CREDENTIALS,
    store: new MemoryStore({ now: () => FROZEN_NOW_MS }),
    now: () => FROZEN_NOW_MS,
    requestRetry: 0,
    transientErrorCooldownSeconds: -1,
  })
  if (typeof service.handleMessages !== 'function') {
    throw new Error(`${ADAPTER_EXPORT}() must return an object with a handleMessages(request, send) method`)
  }

  const captured: UpstreamRequest[] = []
  const send: UpstreamSender = async (call) => {
    captured.push(call)
    return buildMockResponse(meta.mock_control, caseId)
  }

  const response = await service.handleMessages(request, send)
  await assertDownstream(response, expected, mask, caseId)

  expect(captured.length, `S2d8[${caseId}]: upstream call count`).toBe(recordedUpstream.length)
  for (let index = 0; index < recordedUpstream.length; index += 1) {
    const recorded = recordedUpstream[index]
    const capturedCall = captured[index]
    expect(capturedCall, `S2d8[${caseId}]: missing upstream call ${index + 1}`).toBeDefined()
    if (recorded !== undefined && capturedCall !== undefined) {
      assertUpstreamWire(recorded, capturedCall, mask, DEFAULT_CREDENTIALS[0]?.baseUrl ?? '', caseId)
    }
  }
}

// ─── Suites ──────────────────────────────────────────────────────────────────────────

describe('S2d8 fixture inventory (harness self-check, adapter-independent)', () => {
  it('exposes exactly the 18 admitted golden cases, each internally consistent', async () => {
    expect([...fixtureCaseDirs]).toEqual([...EXPECTED_CASES].sort())
    for (const caseId of EXPECTED_CASES) {
      const meta = await readFixtureJson<CaseMeta>(caseId, 'meta.yaml')
      const request = parseRequestHttp(await readFixtureText(caseId, 'request.http'))
      const downstream = parseDownstreamMarkdown(await readFixtureText(caseId, 'downstream.md'), caseId)
      const upstream = parseRecordedUpstream(await readFixtureText(caseId, 'upstream.jsonl'), caseId)

      expect(meta.id, `${caseId}: meta.id echoes the directory name`).toBe(caseId)
      expect(meta.mock_control, `${caseId}: meta must embed the mock control`).toBeDefined()
      maskProfile(caseId, meta.dynamic_fields) // fails loudly on unknown dynamic fields

      // Recorded request: POST on one of the two S2d8 routes, exact Content-Length,
      // well-formed JSON per NE-LENIENT, and the alias-only client model (recorded
      // routing fact — every golden requests `gm`, never the upstream name).
      expect(request.method, `${caseId}: route method`).toBe('POST')
      expect(
        [CLIENT_ROUTE, COUNT_ROUTE].includes(request.path),
        `${caseId}: route path must be one of the two S2d8 routes`,
      ).toBe(true)
      const contentLength = Number(headerValue(request.headers, 'content-length'))
      expect(contentLength, `${caseId}: parsed body length matches the recorded Content-Length`).toBe(
        new TextEncoder().encode(request.body).length,
      )
      let requestBody: Record<string, unknown>
      try {
        requestBody = JSON.parse(request.body) as Record<string, unknown>
      } catch {
        throw new Error(`${caseId}: request body is not well-formed JSON (NE-LENIENT replay boundary)`)
      }
      expect(requestBody.model, `${caseId}: client model is the alias gm`).toBe('gm')
      const streamRequest = requestBody.stream === true
      const countRoute = request.path === COUNT_ROUTE

      // Recorded upstream wire: one hit per golden, gemini paths, redacted key,
      // pinned header order, §2.3 body key order, mock status agreement.
      expect(upstream.length, `${caseId}: upstream.jsonl line count matches meta.upstream_hits`).toBe(
        meta.upstream_hits,
      )
      for (const [index, recorded] of upstream.entries()) {
        expect(recorded.method, `${caseId}: recorded upstream method`).toBe('POST')
        expect(recorded.path, `${caseId}: recorded upstream path`).toMatch(UPSTREAM_PATH_RE)
        if (countRoute) {
          expect(recorded.path, `${caseId}: count_tokens takes the :countTokens upstream action`).toBe(
            `/v1beta/models/${RECORDED_UPSTREAM_MODEL}:countTokens`,
          )
        } else {
          const expectedPath = streamRequest
            ? `/v1beta/models/${RECORDED_UPSTREAM_MODEL}:streamGenerateContent?alt=sse`
            : `/v1beta/models/${RECORDED_UPSTREAM_MODEL}:generateContent`
          expect(recorded.path, `${caseId}: stream flag ↔ upstream action (§2.2)`).toBe(expectedPath)
        }
        expect(Object.keys(recorded.headers), `${caseId}: recorded upstream header order`).toEqual([
          ...RECORDED_HEADER_ORDER,
        ])
        expect(recorded.headers['X-Goog-Api-Key'], `${caseId}: recorded key is redacted in the wire log`).toBe(
          '<redacted>',
        )
        expect(recorded.headers['User-Agent'], `${caseId}: recorded User-Agent literal`).toBe('Go-http-client/1.1')
        expect(recorded.headers.Authorization, `${caseId}: recorded wire carries no Authorization`).toBeUndefined()
        const bodyKeys = Object.keys(JSON.parse(recorded.body) as Record<string, unknown>)
        let orderCursor = 0
        for (const key of bodyKeys) {
          while (orderCursor < BODY_KEY_ORDER.length && BODY_KEY_ORDER[orderCursor] !== key) orderCursor += 1
          expect(
            orderCursor < BODY_KEY_ORDER.length,
            `${caseId}: upstream body key ${JSON.stringify(key)} breaks the §2.3 top-level order`,
          ).toBe(true)
          orderCursor += 1
        }
        const expectedMockStatus = meta.mock_control.mode === 'error' ? meta.mock_control.status : 200
        expect(
          recorded.response_status,
          `${caseId}: recorded mock reply status agrees with the mock control`,
        ).toBe(expectedMockStatus)
        expect(index, `${caseId}: one upstream line per case`).toBeLessThan(1)
      }

      // Mock control shape vs the request: streams need a canned chunk script (slow and
      // disconnect wrap it), non-streams need a canned JSON body, errors need a reply.
      const control = meta.mock_control
      const mode = control.mode ?? 'happy'
      expect(['happy', 'error', 'slow', 'disconnect'].includes(mode), `${caseId}: known mock mode`).toBe(true)
      const cannedFields = [control.canned_nonstream, control.canned_stream, control.canned_count].filter(
        (field) => field !== undefined,
      )
      if (mode === 'error') {
        expect(cannedFields.length, `${caseId}: error mode carries no canned body`).toBe(0)
        expect(control.status, `${caseId}: error mode carries the reply status`).toBeDefined()
        expect(control.error_body, `${caseId}: error mode carries the reply body`).toBeDefined()
      } else {
        expect(cannedFields.length, `${caseId}: exactly one canned body per non-error control`).toBe(1)
        expect(
          control.canned_stream !== undefined,
          `${caseId}: canned_stream is used exactly for streamed requests`,
        ).toBe(streamRequest)
        expect(control.canned_count !== undefined, `${caseId}: canned_count is used exactly on the count route`).toBe(
          countRoute,
        )
        if (mode === 'slow') expect(control.delay_ms, `${caseId}: slow mode carries an inter-chunk delay`).toBeDefined()
        if (mode === 'disconnect') {
          expect(control.after, `${caseId}: disconnect mode carries the abort chunk count`).toBeDefined()
          expect(
            (control.after ?? 0) < (control.canned_stream?.length ?? 0),
            `${caseId}: disconnect aborts before the canned script ends`,
          ).toBe(true)
        }
      }

      // Recorded downstream: meta status agreement, Content-Type, and the parse
      // convention pinned by Content-Length on every non-stream body.
      expect(downstream.status, `${caseId}: meta http_status agrees with the recorded status line`).toBe(
        Number(meta.http_status),
      )
      expect(headerValue(downstream.headers, 'content-type'), `${caseId}: fixture must record Content-Type`).toBeDefined()
      if (headerValue(downstream.headers, 'content-type') === 'text/event-stream') {
        expect(
          headerValue(downstream.headers, 'content-length'),
          `${caseId}: SSE responses are chunked, never Content-Length`,
        ).toBeUndefined()
        expect(
          () => decodeSseFrames(downstream.body, `S2d8[${caseId}]: recorded body`),
          `${caseId}: recorded SSE body decodes under the pinned framing`,
        ).not.toThrow()
        expect(
          headerValue(downstream.headers, 'cache-control'),
          `${caseId}: SSE commits record Cache-Control no-cache`,
        ).toBe('no-cache')
      } else {
        const recordedLength = Number(headerValue(downstream.headers, 'content-length'))
        expect(recordedLength, `${caseId}: recorded Content-Length matches the parsed body bytes`).toBe(
          new TextEncoder().encode(downstream.body).length,
        )
      }
    }
  })
})

suite(suiteTitle, () => {
  for (const caseId of EXPECTED_CASES) {
    it(`${caseId} — replays the recorded exchange: upstream wire byte-exact, downstream surface byte-exact`, async () => {
      await replayCase(caseId)
    })
  }
})
