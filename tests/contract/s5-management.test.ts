/**
 * S5 golden contract — the full `/v0/management` surface.
 *
 * Spec source of truth: spec/sections/S5-management-api.md (admitted). Goldens: the 22
 * recorded fixture cases under tests/fixtures/S5/ (oracle recordings of CLIProxyAPI
 * v7.3.4, docker digest sha256:97825da...; 168 steps = 167 case steps + 1 AUX helper
 * step). Rulings applied: R-404 (404 = empty body, wrong method = 404), R-BCRYPT (the
 * seed config carries the bcrypt-hashed secret-key while the plaintext stays the
 * accepted key), R-FIXTURE (all S5 behaviors are RECORDABLE-LOCALLY — no LLM upstream
 * involved). R-SSE does not apply: no management endpoint streams (spec §4).
 *
 * Byte-exactness targets this suite pins (mission-critical list):
 *   - gin.H (Go map) bodies marshal keys ALPHABETICALLY: every error body
 *     `{"error":...,"message"?}`, `{"changed":["config"],"ok":true}`,
 *     `{"cancelled":false,"status":"ok"}`, `{"disabled":<bool>,"status":"ok"}`,
 *     auth-file entries, the `/auth-files` envelope, vertex-import 200 bodies,
 *     `/auth-files/models` 4-key entries, the api-call inner header map.
 *   - struct-ordered bodies: provider list entries (api-key, base-url, models,
 *     auth-index), GET /config, api-key-usage entries (success, failed,
 *     recent_requests), the api-call envelope (status_code, header, body).
 *   - 400/401/403/404/422 bodies incl. "missing management key" / "invalid management
 *     key" and the weight ladder ("weight must be an integer",
 *     "<path>[i].weight: weight must not exceed 1000000", bare PATCH reason).
 *   - safe canonicalization bytes for auth-file download (alphabetical keys +
 *     persisted `disabled` flag + patched fields) and the auth-file entry `size`.
 *   - vertex-import STEP 9 fake-PEM 400 `{"error":"invalid service account","message":
 *     "private_key is not valid pem: missing pem markers"}`.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * ADAPTER INTERFACE — what the future `@cpa-edge/management` MUST export for these
 * tests to run. The suite dynamically imports the package and skips with the reason
 * below while `createManagementApi` is absent; it turns red as soon as the export
 * ships. This file holds its own structural mirror of the types; the package should
 * export the real ones.
 *
 *   export function createManagementApi(deps: ManagementApiDeps): ManagementApi
 *
 *   type HeaderList = ReadonlyArray<readonly [string, string]>  // ordered, set casing
 *
 *   interface ManagementApiDeps {
 *     // STATE INJECTION POINT. Baseline `config.yaml` bytes exactly as the
 *     // oracle container mounted them (comments included, bcrypt-hashed
 *     // `secret-key` inside; see "Harness seeding" below for where the bytes
 *     // come from). The adapter parses this file the same way the reference
 *     // does at startup and materializes every server-side state the fixtures
 *     // need: the scalar config keys, the eight provider lists, `api-keys`,
 *     // `routing`, and the management authorization material. No other
 *     // seeding exists: the auth dir starts EMPTY (fresh container per case)
 *     // and every uploaded / vertex-imported credential is created by the
 *     // replayed steps themselves.
 *     readonly configYaml: string
 *     // Plaintext management key that must be accepted ("oracle-mgmt-key-1").
 *     readonly managementKey: string
 *     // All persistent state flows through the @cpa-edge/core Store (Iron Rule 4).
 *     readonly store: Store
 *     // Build identity surfaced through the X-Cpa-* response headers.
 *     readonly buildInfo: {
 *       readonly version: string        // "v7.3.4"
 *       readonly commit: string         // "8335eac"
 *       readonly buildDate: string      // "2026-09-15T14:07:06Z"
 *       readonly supportPlugin: boolean // true -> "X-Cpa-Support-Plugin: 1"
 *     }
 *     // Outbound transport for POST /api-call (see "api-call mock upstream").
 *     readonly sendUpstream?: ApiCallSender
 *     // Client address for the remote-management local/remote decision.
 *     readonly clientIp?: string        // "127.0.0.1"
 *   }
 *
 *   interface ManagementApi {
 *     handle(request: Request): Promise<WireResponse>
 *   }
 *
 *   type WireResponse = Response & { readonly rawHeaders: HeaderList }
 *
 * `handle` is the injectable handler surface: plain WHATWG `Request` in, plain
 * `Response` out (the runtime-agnostic core never touches node:* APIs). The
 * `rawHeaders` attachment is REQUIRED by this suite and is the canonical-casing
 * carrier: fetch `Headers` normalize names to lowercase on iteration, but the
 * recorded wire uses Go-canonical casing (`X-Cpa-Version`, `X-Cpa-Commit`, ...),
 * and spec §2.2 says the contract must compare exactly that casing. Attach it with
 *   Object.assign(new Response(bytes, init), { rawHeaders })
 * where `rawHeaders` lists every response header the handler set — names in the
 * casing it chose, in its emission order, without the runtime-framed `Date` /
 * `Content-Length` / `Transfer-Encoding` (see "Comparison rules").
 *
 *   interface ApiCallRequest {          // what the impl wants ON THE WIRE upstream
 *     readonly method: string
 *     readonly url: string              // verbatim `url` field of the request body
 *     readonly headers: HeaderList      // ordered, canonical casing — byte-pinned
 *     readonly body: string
 *   }
 *   interface ApiCallReply {
 *     readonly status: number
 *     readonly headers: HeaderList      // upstream reply headers, received order
 *     readonly body: string             // verbatim upstream body bytes
 *   }
 *   type ApiCallSender = (request: ApiCallRequest) => Promise<ApiCallReply>
 *
 * The `POST /api-call` handler must build `ApiCallRequest` itself — including the
 * recorded `User-Agent: Go-http-client/1.1` and `Accept-Encoding: gzip` headers —
 * and hand it to the injected sender. The node runtime binds the sender to
 * node:http; because the impl fully controls the header list there, the suite pins
 * the upstream wire byte-exactly (a fetch-based transport cannot: undici injects
 * `sec-fetch-mode`, `accept-language`, ... — that deviation would have to be
 * registered in SPEC §5, not silently accepted here).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * HARNESS SEMANTICS
 *
 * • Per case the harness builds a FRESH adapter instance (fresh container per
 *   recording), seeded with the S5 baseline fleet config. The seed bytes are the
 *   recorded `GET /v0/management/config.yaml` golden (S5-config-yaml STEP 1): the
 *   full worker-4 fleet YAML — eight mock-provider entries, `api-keys:
 *   ["oracle-local-key-1"]`, `request-retry: 0`, `transient-error-cooldown-seconds:
 *   -1`, `usage-statistics-enabled: false`, `logging-to-file` absent, bcrypt-hashed
 *   `secret-key`, `auth-dir: /root/.cli-proxy-api`, `port: 8407` — and no auth files.
 * • Steps replay in the fixture's section order (meta.yaml `seq`); config mutations
 *   persist WITHIN a case (one adapter instance per case, one Store per case) and
 *   never leak across cases.
 * • AUX steps (S5-quota-endpoints AUX-1) are state capture: the harness runs them,
 *   asserts their recorded status, extracts the live `auth-index` from the
 *   `GET /gemini-api-key` list and substitutes it into the following step's request
 *   body (the fixture records the oracle's own value `3cf396155c88e26a` there).
 *   Their bodies are structurally checked, not byte-compared (meta.yaml marks them
 *   `expect_status: null`; the auth-index value is runtime state).
 * • Fixture files render CRLF as LF. The harness reconstructs the exact wire bytes
 *   before sending: multipart bodies re-expand LF -> CRLF (curl emits CRLF framing,
 *   so `:8407`-style Content-Length counts agree only in the CRLF form) and
 *   non-multipart bodies recover a single trailing LF when the recorded
 *   Content-Length demands it (YAML PUT bodies end with a newline). Every one of
 *   the 168 request bodies and every Content-Length-carrying response body is
 *   validated against its recorded length — the parser throws otherwise.
 * • `Host` and `Content-Length` request headers are not passed to the Request
 *   constructor: fetch derives Host from the URL (the suite keeps the recorded
 *   `http://127.0.0.1:8407` origin, so the derived Host is byte-identical) and
 *   computes Content-Length from the body bytes (which are byte-identical).
 *
 * api-call mock upstream: no socket is needed. The injected sender dispatches on
 * (method, path, X-Mock-* control headers) exactly like the recording mock and
 * returns the canned replies transcribed in the case's own downstream goldens
 * (steps 1/3/4 embed the mock's reply bytes verbatim in the `body` field). Reply
 * headers are emitted with deliberately non-canonical casing (`server`,
 * `content-type`) plus hop-by-hop `connection`/`keep-alive`, which pins two real
 * behaviors: the impl must canonicalize header names when it serializes the
 * api-call `header` map and must strip hop-by-hop headers the way Go's client
 * does (the recorded map carries only Content-Length, Content-Type, Date, Server).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * COMPARISON RULES
 *
 * Status: exact. Body: byte-exact after masking (below). Headers: the recorded
 * header list minus the runtime-framed trio `Date` / `Content-Length` /
 * `Transfer-Encoding` is compared EXACTLY — names (case-insensitively via fetch
 * Headers; canonically via `rawHeaders`), values, order, and absence. That pins:
 * the CORS block, `Content-Type` (and its absence on empty 404s — build those
 * Responses with a null body, or undici injects a text/plain Content-Type),
 * `Cache-Control: no-store` + `X-Content-Type-Options: nosniff` on config.yaml,
 * `Content-Disposition` on downloads, the X-Cpa-* block on every management
 * response INCLUDING auth failures, and its ABSENCE on /oauth-callback (the only
 * route outside the auth middleware). If the impl sets Content-Length itself it
 * must equal the body byte length.
 *
 * MASKS — derived from each case's meta.yaml `dynamic_fields` (unknown entries fail
 * loudly, so new volatility must be added consciously) and applied identically to
 * recorded and produced bytes:
 *   - Date: runtime-framed response header; never compared (excluded above).
 *   - ports (8407, 21999, 22001-22007): masked wherever they appear after ':' or
 *     a port key (`host.docker.internal:22001`, `port: 8407`).
 *   - auth-index / auth_index: 16-hex runtime credential indices.
 *   - observed_at: envelope UTC timestamp (shape-guarded to RFC3339 with `Z`).
 *   - created_at / modtime / updated_at / last_refresh: entry timestamps; masked
 *     per the declaration, and shape-guarded to carry a ±HH:MM local offset
 *     (spec §3.4 / §8.11). `last_refresh` is masked with them although S5-auth-
 *     files-roundtrip omits it from its dynamic_fields list — spec §3.4 documents
 *     the field as "<LOCAL RFC3339>", so the omission is a fixture-list gap, not a
 *     byte-exact requirement.
 *   - recent_requests bucket timestamps: the 20-bucket array structure, count and
 *     success/failed counters stay byte-pinned; only the "HH:MM-HH:MM" labels mask.
 *   - cooldowns: whole array value (recorded as []).
 *   - path / auth-file / id / plugins_dir: container-absolute paths, the auth-file
 *     entry id, and the resolved plugins dir. `id` masks ONLY inside `{"files":[...`
 *     envelopes — the model-catalog `id`s in /auth-files/models are static and stay
 *     byte-pinned. `size` is NOT masked: the recorded entry sizes (57 for the
 *     canonical kimi file, 2087 for the re-encoded vertex key) pin the persisted
 *     canonical bytes.
 *   - bcrypt secret-key hash in YAML bytes: `$2a$10$...` -> "<BCRYPT-HASH>".
 *   - api-call inner header map: the mock's Date/Server VALUES mask (recorded
 *     dynamic), key presence and every other value stay pinned.
 *   - upstream.jsonl: recording-only `ts`/`type` fields and the URL-derived `Host`
 *     are excluded; mock-control headers (`X-Mock-*`) are consumed by the mock and
 *     absent from the recording, so they are excluded from the wire compare too.
 *     Everything else — method, path, body bytes, and the ordered canonical header
 *     list (User-Agent, Content-Type, X-S5-Token, Accept-Encoding) — is byte-pinned,
 *     including `Accept-Encoding: gzip` and `User-Agent: Go-http-client/1.1`.
 *     `Content-Length` is transport-derived: it is excluded from the ordered compare
 *     but its presence and value are still pinned — present exactly when the
 *     recording has it (the POST calls), equal to the recorded value, and always
 *     equal to the body byte length.
 */

import { readdir, readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { MemoryStore } from '@cpa-edge/core'
import type { Store } from '@cpa-edge/core'

// ─── Adapter load (skip-with-explanation until the real export ships) ────────────────

const ADAPTER_MODULE = '@cpa-edge/management'
const ADAPTER_EXPORT = 'createManagementApi'

/** Structural mirror of the adapter interface documented in the header. */
type HeaderList = ReadonlyArray<readonly [string, string]>

interface BuildInfo {
  readonly version: string
  readonly commit: string
  readonly buildDate: string
  readonly supportPlugin: boolean
}

interface ApiCallRequest {
  readonly method: string
  readonly url: string
  readonly headers: HeaderList
  readonly body: string
}

interface ApiCallReply {
  readonly status: number
  readonly headers: HeaderList
  readonly body: string
}

type ApiCallSender = (request: ApiCallRequest) => Promise<ApiCallReply>

interface ManagementApiDeps {
  readonly configYaml: string
  readonly managementKey: string
  readonly store: Store
  readonly buildInfo: BuildInfo
  readonly sendUpstream?: ApiCallSender
  readonly clientIp?: string
}

/** Response plus the required canonical-casing carrier (see header comment). */
type WireResponse = Response & { readonly rawHeaders: HeaderList }

interface ManagementApi {
  handle(request: Request): Promise<WireResponse>
}

type AdapterFactory = (deps: ManagementApiDeps) => ManagementApi

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
      skipReason: `\`${ADAPTER_MODULE}\` does not export \`${ADAPTER_EXPORT}(deps)\` yet. ` +
        'All 22 S5 golden cases SKIP until the management adapter ships; the required interface is documented in the header of this file.',
    }
  } catch (error) {
    return { skipReason: `import of \`${ADAPTER_MODULE}\` failed: ${String(error)}` }
  }
}

const adapterLoad = await loadAdapter()
const adapterFactory = adapterLoad.factory
const suite = adapterFactory ? describe : describe.skip
const suiteTitle = adapterFactory
  ? 'S5 — management API golden contract (recorded fixtures)'
  : `S5 — management API golden contract (SKIPPED: ${adapterLoad.skipReason ?? 'adapter unavailable'})`

// ─── Fixture access ───────────────────────────────────────────────────────────────────

const FIXTURE_ROOT = new URL('../fixtures/S5/', import.meta.url)
const MANAGEMENT_KEY = 'oracle-mgmt-key-1'
const CLIENT_IP = '127.0.0.1'
const REQUEST_ORIGIN = 'http://127.0.0.1:8407'
const BUILD_INFO: BuildInfo = {
  version: 'v7.3.4',
  commit: '8335eac',
  buildDate: '2026-09-15T14:07:06Z',
  supportPlugin: true,
}
const encoder = new TextEncoder()

const EXPECTED_CASES = [
  'S5-api-call-mock',
  'S5-api-keys-crud',
  'S5-auth-files-errors',
  'S5-auth-files-roundtrip',
  'S5-auth-header-styles',
  'S5-auth-invalid-key',
  'S5-auth-missing-key',
  'S5-config-get',
  'S5-config-yaml',
  'S5-gemini-key-crud',
  'S5-logs-disabled',
  'S5-model-definitions',
  'S5-oauth-session',
  'S5-openai-compat-crud',
  'S5-plugins-list',
  'S5-quota-endpoints',
  'S5-routing-strategy',
  'S5-scalar-toggle',
  'S5-unknown-route',
  'S5-usage-telemetry',
  'S5-vertex-import',
  'S5-vertex-key-validation',
] as const

type CaseId = (typeof EXPECTED_CASES)[number]

function caseFile(caseId: string, name: string): URL {
  return new URL(`${caseId}/${name}`, FIXTURE_ROOT)
}

async function readFixtureText(caseId: string, name: string): Promise<string> {
  return readFile(caseFile(caseId, name), 'utf8')
}

async function readFixtureJson<T>(caseId: string, name: string): Promise<T> {
  return JSON.parse(await readFixtureText(caseId, name)) as T
}

// ─── Fixture file parsers (request.http / downstream.md / upstream.jsonl) ─────────────

interface CaseMetaStep {
  readonly seq: number | string
  readonly label: string
  readonly method: string
  readonly path: string
  readonly note: string | null
  readonly aux: boolean
  readonly http_status: number
}

interface CaseMeta {
  readonly id: string
  readonly steps: readonly CaseMetaStep[]
  readonly dynamic_fields: readonly string[]
  readonly upstream_file: string | null
}

interface RequestSection {
  readonly caseId: string
  readonly stepId: string
  readonly method: string
  readonly path: string
  readonly headers: HeaderList
  readonly body: string
  readonly declaredBodyLength: number | undefined
}

interface DownstreamSection {
  readonly stepId: string
  readonly method: string
  readonly path: string
  readonly status: number
  readonly headers: HeaderList
  readonly body: string
  readonly declaredBodyLength: number | undefined
}

const SECTION_HEAD_RE = /^(\S+) ((?:STEP \d+)|(?:AUX-\d+)) — (\S+) (\S+)(.*)$/
const DOWNSTREAM_HEAD_RE = /^((?:STEP \d+)|(?:AUX-\d+)) — (\S+) (\S+)$/
const STATUS_BLOCK_RE = /### Status \+ response headers \(received order\)\n```\n([\s\S]*?)\n```\n/
const BODY_BLOCK_RE = /### Body\n```\n([\s\S]*?)\n?```\n/
const HTTP_STATUS_RE = /HTTP status: (\d+)/

function byteLength(text: string): number {
  return encoder.encode(text).length
}

/**
 * The fixtures render the sent wire bytes with CRLF collapsed to LF. This
 * reconstructs the exact original bytes: multipart bodies re-expand every LF to
 * CRLF (curl multipart framing) and optionally regain a trailing CRLF; other
 * bodies optionally regain a single trailing LF. The recorded Content-Length
 * decides — no candidate matches is a harness defect.
 */
function reconstructWireBytes(rendered: string, contentLength: number, multipart: boolean): string {
  const candidates = [rendered, `${rendered}\n`]
  if (multipart) {
    const crlf = rendered.replaceAll('\n', '\r\n')
    candidates.push(crlf, `${crlf}\r\n`)
  }
  for (const candidate of candidates) {
    if (byteLength(candidate) === contentLength) return candidate
  }
  throw new Error(
    `cannot reconstruct wire bytes: recorded Content-Length ${contentLength} matches none of the LF-rendered candidates ` +
      `(rendered length ${byteLength(rendered)}, multipart=${String(multipart)})`,
  )
}

/**
 * Destructures a regex match under `noUncheckedIndexedAccess`. Every pattern used
 * here has non-optional capture groups, so a match always carries them; the width
 * check still guards against pattern drift.
 */
function requiredGroups(match: RegExpExecArray, context: string, width: 3): readonly [string, string, string]
function requiredGroups(match: RegExpExecArray, context: string, width: 4): readonly [string, string, string, string]
function requiredGroups(match: RegExpExecArray, context: string, width: number): readonly string[] {
  const groups = match.slice(1).map((group) => group ?? '')
  if (groups.length < width) {
    throw new Error(`${context}: expected ${width} capture groups, got ${groups.length}`)
  }
  return groups
}

function declaredContentLength(headers: HeaderList): number | undefined {
  for (const [name, value] of headers) {
    if (name.toLowerCase() === 'content-length') return Number(value)
  }
  return undefined
}

function isMultipartRequest(headers: HeaderList): boolean {
  for (const [name, value] of headers) {
    if (name.toLowerCase() === 'content-type' && value.toLowerCase().startsWith('multipart/form-data')) {
      return true
    }
  }
  return false
}

function parseRequestHttp(caseId: string, text: string): readonly RequestSection[] {
  const sections: RequestSection[] = []
  for (const part of text.split(/^### /m)) {
    if (part.trim() === '') continue
    const lines = part.split('\n')
    const head = SECTION_HEAD_RE.exec(lines[0] ?? '')
    if (head === null) throw new Error(`request.http section head unparsable: ${JSON.stringify(lines[0])}`)
    const [caseName, stepId, method, path] = requiredGroups(head, `request.http ${caseId} section head`, 4)
    if (caseName !== caseId) throw new Error(`request.http section belongs to ${caseName}, expected ${caseId}`)
    const requestLine = lines[1] ?? ''
    if (!requestLine.startsWith(`${method} ${path} HTTP/1.1`)) {
      throw new Error(`request.http ${stepId}: request line ${JSON.stringify(requestLine)} disagrees with the section head`)
    }
    const headers: Array<[string, string]> = []
    let index = 2
    while (index < lines.length && (lines[index] ?? '') !== '') {
      const line = lines[index] ?? ''
      const separator = line.indexOf(': ')
      if (separator <= 0) throw new Error(`request.http ${stepId}: unparsable header line ${JSON.stringify(line)}`)
      headers.push([line.slice(0, separator), line.slice(separator + 2)])
      index += 1
    }
    index += 1
    const bodyLines = lines.slice(index)
    while (bodyLines.length > 0 && (bodyLines[bodyLines.length - 1] ?? '') === '') bodyLines.pop()
    const rendered = bodyLines.join('\n')
    const contentLength = declaredContentLength(headers)
    const body =
      contentLength === undefined
        ? rendered === ''
          ? ''
          : throwImpossible(`request.http ${caseId} ${stepId}: body present without Content-Length`)
        : reconstructWireBytes(rendered, contentLength, isMultipartRequest(headers))
    sections.push({ caseId, stepId, method, path, headers, body, declaredBodyLength: contentLength })
  }
  return sections
}

function parseDownstreamFile(caseId: string, text: string): readonly DownstreamSection[] {
  const sections: DownstreamSection[] = []
  for (const part of text.split(/^## /m)) {
    if (part.trim() === '') continue
    const endOfHead = part.indexOf('\n')
    const head = DOWNSTREAM_HEAD_RE.exec((endOfHead === -1 ? part : part.slice(0, endOfHead)).trim())
    if (head === null) continue // the "# <case> downstream" title line
    const [stepId, method, path] = requiredGroups(head, `downstream.md ${caseId} section head`, 3)
    const statusMatch = STATUS_BLOCK_RE.exec(part)
    if (statusMatch === null) throw new Error(`${caseId} ${stepId}: downstream.md has no status block`)
    const statusBlock = statusMatch[1]
    if (statusBlock === undefined) throw new Error(`${caseId} ${stepId}: downstream.md status block is empty`)
    const statusLines = statusBlock.split('\n')
    const statusLine = statusLines[0] ?? ''
    const statusFromLine = Number(statusLine.split(' ')[1])
    const headers: Array<[string, string]> = []
    for (const line of statusLines.slice(1)) {
      const separator = line.indexOf(': ')
      if (separator <= 0) throw new Error(`${caseId} ${stepId}: unparsable recorded header ${JSON.stringify(line)}`)
      headers.push([line.slice(0, separator), line.slice(separator + 2)])
    }
    const bodyMatch = BODY_BLOCK_RE.exec(part)
    if (bodyMatch === null) throw new Error(`${caseId} ${stepId}: downstream.md has no body block`)
    const renderedBody = bodyMatch[1]
    if (renderedBody === undefined) throw new Error(`${caseId} ${stepId}: downstream.md body block is empty`)
    const statusCodeMatch = HTTP_STATUS_RE.exec(part)
    if (statusCodeMatch === null) throw new Error(`${caseId} ${stepId}: downstream.md has no HTTP status footer`)
    const status = Number(statusCodeMatch[1])
    if (status !== statusFromLine) {
      throw new Error(`${caseId} ${stepId}: status line ${statusLine} disagrees with the footer ${String(status)}`)
    }
    const contentLength = declaredContentLength(headers)
    const body =
      contentLength === undefined
        ? renderedBody // chunked body: the fence separator is never part of the entity
        : reconstructWireBytes(renderedBody, contentLength, false)
    sections.push({ stepId, method, path, status, headers, body, declaredBodyLength: contentLength })
  }
  return sections
}

interface RecordedUpstreamLine {
  readonly method: string
  readonly path: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}

function parseUpstreamLog(text: string): readonly RecordedUpstreamLine[] {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as RecordedUpstreamLine)
}

function throwImpossible(message: string): never {
  throw new Error(message)
}

// ─── Masking (meta.yaml dynamic_fields -> normalization) ─────────────────────────────

interface MaskProfile {
  readonly ports: boolean
  readonly authIndex: boolean
  readonly observedAt: boolean
  readonly entryId: boolean
  readonly entryTimestamps: boolean
  readonly bucketTimes: boolean
  readonly cooldowns: boolean
  readonly entryPath: boolean
  readonly authFilePath: boolean
  readonly bcrypt: boolean
  readonly mockHeaderMap: boolean
  readonly pluginsDir: boolean
}

const EMPTY_MASK: MaskProfile = {
  ports: false,
  authIndex: false,
  observedAt: false,
  entryId: false,
  entryTimestamps: false,
  bucketTimes: false,
  cooldowns: false,
  entryPath: false,
  authFilePath: false,
  bcrypt: false,
  mockHeaderMap: false,
  pluginsDir: false,
}

/** Exact dynamic_fields strings recorded by the oracle (per-case, deduplicated). */
const DYN_DATE = 'Date response header'
const DYN_PORTS = 'port numbers anywhere (8407 / 21999 / 22001-22007; masked for contract replay)'
const DYN_AUTH_INDEX = 'auth-index values in list responses'
const DYN_OBSERVED_AT = 'observed_at'
const DYN_AUTH_INDEX_2 = 'auth_index'
const DYN_ID = 'id'
const DYN_CREATED = 'created_at'
const DYN_MODTIME = 'modtime'
const DYN_UPDATED = 'updated_at'
const DYN_BUCKETS = 'recent_requests bucket timestamps'
const DYN_QUOTA_OBSERVED = 'quota.observed_at'
const DYN_COOLDOWNS = 'cooldowns'
const DYN_PATH = 'path (container paths)'
const DYN_AUTH_FILE_PATH = 'auth-file path'
const DYN_VERTEX_LIST_BODY =
  'observed_at/auth_index/created_at/modtime/updated_at/recent_requests/quota/cooldowns/path in step 2 list body'
const DYN_BCRYPT = 'bcrypt secret-key hash string in YAML bytes (step 1; steps 4/6 bodies are the request bytes as sent)'
const DYN_MOCK_HEADERS = 'header map values inside api-call response (mock Server/Date)'
const DYN_MOCK_TS = 'ts field in upstream.jsonl'
const DYN_PLUGINS_DIR = 'plugins_dir resolved absolute path if the binary returns one'
const DYN_OBSERVED_LIKE = 'observed_at-like fields'

function maskProfile(caseId: string, dynamicFields: readonly string[]): MaskProfile {
  const mask = { ...EMPTY_MASK }
  for (const field of dynamicFields) {
    if (field === DYN_DATE || field === DYN_MOCK_TS) continue // response-header / recording-only artifacts
    if (field === DYN_PORTS) { mask.ports = true; continue }
    if (field === DYN_AUTH_INDEX || field === DYN_AUTH_INDEX_2) { mask.authIndex = true; continue }
    if (field === DYN_OBSERVED_AT || field === DYN_QUOTA_OBSERVED || field === DYN_OBSERVED_LIKE) {
      mask.observedAt = true
      continue
    }
    if (field === DYN_ID) { mask.entryId = true; continue }
    if (field === DYN_CREATED || field === DYN_MODTIME || field === DYN_UPDATED) { mask.entryTimestamps = true; continue }
    if (field === DYN_BUCKETS) { mask.bucketTimes = true; continue }
    if (field === DYN_COOLDOWNS) { mask.cooldowns = true; continue }
    if (field === DYN_PATH) { mask.entryPath = true; continue }
    if (field === DYN_AUTH_FILE_PATH) { mask.authFilePath = true; continue }
    if (field === DYN_BCRYPT) { mask.bcrypt = true; continue }
    if (field === DYN_MOCK_HEADERS) { mask.mockHeaderMap = true; continue }
    if (field === DYN_PLUGINS_DIR) { mask.pluginsDir = true; continue }
    if (field === DYN_VERTEX_LIST_BODY) {
      mask.observedAt = true
      mask.authIndex = true
      mask.entryTimestamps = true
      mask.bucketTimes = true
      mask.cooldowns = true
      mask.entryPath = true
      continue
    }
    throw new Error(
      `S5[${caseId}]: unrecognized meta.yaml dynamic_fields entry ${JSON.stringify(field)} — ` +
        'extend the mask table in tests/contract/s5-management.test.ts consciously',
    )
  }
  return mask
}

const PORT_IN_URL_RE = /:(8407|21999|2200[1-7])(?![0-9])/g
const PORT_IN_YAML_RE = /(port:\s*)(8407|21999|2200[1-7])(?![0-9])/g
const PORT_IN_JSON_RE = /("port":\s*)(8407|21999|2200[1-7])(?![0-9])/g
const AUTH_INDEX_RE = /"(auth-index|auth_index)":"[0-9a-f]{16}"/g
const OBSERVED_AT_RE = /"observed_at":"[^"]*"/g
const ENTRY_TIMESTAMP_RE = /"(created_at|modtime|updated_at|last_refresh)":"[^"]*"/g
const ENTRY_TIMESTAMP_SCAN_RE = /"(created_at|modtime|updated_at|last_refresh)":"([^"]*)"/g
const OBSERVED_AT_SCAN_RE = /"observed_at":"([^"]*)"/g
const BUCKET_TIME_RE = /"time":"\d{2}:\d{2}-\d{2}:\d{2}"/g
const COOLDOWNS_RE = /"cooldowns":\[[^\]]*\]/g
const ENTRY_PATH_RE = /"path":"[^"]*"/g
const ENTRY_ID_RE = /"id":"[^"]*"/g
const AUTH_FILE_PATH_RE = /"auth-file":"[^"]*"/g
const SECRET_KEY_BCRYPT_RE = /secret-key: "\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}"/g
const PLUGINS_DIR_RE = /"plugins_dir":"[^"]*"/g
const MOCK_DATE_MAP_RE = /"Date":\["[^\]]*"\]/g
const MOCK_SERVER_MAP_RE = /"Server":\["[^\]]*"\]/g

function normalizeBody(body: string, mask: MaskProfile, isFilesEnvelope: boolean): string {
  let out = body
  if (mask.ports) {
    out = out
      .replace(PORT_IN_URL_RE, ':<PORT>')
      .replace(PORT_IN_YAML_RE, (_match, prefix: string) => `${prefix}<PORT>`)
      .replace(PORT_IN_JSON_RE, (_match, prefix: string) => `${prefix}<PORT>`)
  }
  if (mask.bcrypt) out = out.replace(SECRET_KEY_BCRYPT_RE, 'secret-key: "<BCRYPT-HASH>"')
  if (mask.authIndex) out = out.replace(AUTH_INDEX_RE, (match, key: string) => `"${key}":"<AUTH-INDEX>"`)
  if (mask.observedAt) out = out.replace(OBSERVED_AT_RE, '"observed_at":"<TIMESTAMP>"')
  if (mask.entryTimestamps) {
    out = out.replace(ENTRY_TIMESTAMP_RE, (match, key: string) => `"${key}":"<TIMESTAMP>"`)
  }
  if (mask.bucketTimes) out = out.replace(BUCKET_TIME_RE, '"time":"<BUCKET>"')
  if (mask.cooldowns) out = out.replace(COOLDOWNS_RE, '"cooldowns":<MASKED>')
  if (mask.entryPath) out = out.replace(ENTRY_PATH_RE, '"path":"<PATH>"')
  if (mask.entryId && isFilesEnvelope) out = out.replace(ENTRY_ID_RE, '"id":"<ID>"')
  if (mask.authFilePath) out = out.replace(AUTH_FILE_PATH_RE, '"auth-file":"<PATH>"')
  if (mask.pluginsDir) out = out.replace(PLUGINS_DIR_RE, '"plugins_dir":"<DIR>"')
  if (mask.mockHeaderMap) {
    out = out.replace(MOCK_DATE_MAP_RE, '"Date":["<MOCK-VALUE>"]').replace(MOCK_SERVER_MAP_RE, '"Server":["<MOCK-VALUE>"]')
  }
  return out
}

const LOCAL_OFFSET_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?[+-]\d{2}:\d{2}$/
const UTC_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/

/**
 * Shape guards applied to the PRODUCED body before masking. Masking hides timestamp
 * values (they are wall-clock), but spec §3.4 and §8.11 still require their formats:
 * entry timestamps serialize the server's local ±HH:MM offset, the envelope
 * observed_at is UTC. Fields that are absent fail the byte compare anyway.
 */
function assertTimestampShapes(body: string, mask: MaskProfile, context: string): void {
  if (mask.entryTimestamps) {
    for (const match of body.matchAll(ENTRY_TIMESTAMP_SCAN_RE)) {
      const value = match[2] ?? ''
      expect(
        LOCAL_OFFSET_TS_RE.test(value),
        `${context}: entry timestamp ${JSON.stringify(match[1])} must carry a local ±HH:MM offset, got ${JSON.stringify(value)}`,
      ).toBe(true)
    }
  }
  if (mask.observedAt) {
    for (const match of body.matchAll(OBSERVED_AT_SCAN_RE)) {
      const value = match[1] ?? ''
      expect(
        UTC_TS_RE.test(value),
        `${context}: observed_at must be an RFC3339 UTC timestamp, got ${JSON.stringify(value)}`,
      ).toBe(true)
    }
  }
}

// ─── api-call mock upstream (injected sender; no socket) ─────────────────────────────

interface CapturedUpstreamCall {
  readonly request: ApiCallRequest
}

interface ApiCallMock {
  readonly send: ApiCallSender
  readonly captured: readonly CapturedUpstreamCall[]
}

const API_CALL_CASE = 'S5-api-call-mock' as const

/** Reply headers as the recording mock's socket sent them, plus hop-by-hop extras. */
function mockReplyHeaders(body: string): HeaderList {
  return [
    ['server', 'BaseHTTP/0.6 Python/3.14.6'],
    ['content-type', 'application/json'],
    ['content-length', String(byteLength(body))],
    ['date', 'Tue, 15 Sep 2026 17:08:54 GMT'],
    ['connection', 'keep-alive'],
    ['keep-alive', 'timeout=5'],
  ]
}

function headerValueIgnoreCase(headers: HeaderList, name: string): string | undefined {
  for (const [headerName, value] of headers) {
    if (headerName.toLowerCase() === name.toLowerCase()) return value
  }
  return undefined
}

/**
 * The canned replies are the mock bytes embedded verbatim in the case's own
 * downstream goldens (the api-call envelope carries them in its `body` field), so
 * no upstream script is duplicated here. The X-Mock-Mode/X-Mock-Status control
 * headers select the scripted error exactly like the recording mock.
 */
function makeApiCallMock(downstreams: readonly DownstreamSection[]): ApiCallMock {
  // Parsed lazily: only POST /api-call steps reach the sender, and every other
  // case's STEP 1/3/4 goldens are unrelated bodies.
  const cannedCache = new Map<string, { readonly status: number; readonly body: string }>()
  const canned = (stepId: string): { readonly status: number; readonly body: string } => {
    const cached = cannedCache.get(stepId)
    if (cached !== undefined) return cached
    const section = downstreams.find((entry) => entry.stepId === stepId)
    if (section === undefined) throw new Error(`api-call mock: ${stepId} golden missing`)
    const parsed = JSON.parse(section.body) as { readonly status_code?: unknown; readonly body?: unknown }
    if (typeof parsed.status_code !== 'number' || typeof parsed.body !== 'string') {
      throw new Error(`api-call mock: ${stepId} golden has no canned status_code/body pair`)
    }
    const reply = { status: parsed.status_code, body: parsed.body }
    cannedCache.set(stepId, reply)
    return reply
  }
  const captured: CapturedUpstreamCall[] = []
  const send: ApiCallSender = async (request) => {
    captured.push({ request })
    const url = new URL(request.url)
    if (request.method === 'GET' && url.pathname === '/v1/models') {
      const reply = canned('STEP 1')
      return { status: reply.status, headers: mockReplyHeaders(reply.body), body: reply.body }
    }
    if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
      const errorMode =
        headerValueIgnoreCase(request.headers, 'X-Mock-Mode') === 'error' &&
        headerValueIgnoreCase(request.headers, 'X-Mock-Status') === '500'
      const reply = canned(errorMode ? 'STEP 4' : 'STEP 3')
      return { status: reply.status, headers: mockReplyHeaders(reply.body), body: reply.body }
    }
    throw new Error(`api-call mock: no scripted reply for ${request.method} ${url.pathname}`)
  }
  return { send, captured }
}

const UPSTREAM_EXCLUDED_HEADERS = new Set(['host']) // derived from the request url
const UPSTREAM_CONTROL_PREFIX = 'x-mock-' // mock control headers: consumed, never logged

function assertUpstreamLog(
  caseId: string,
  recorded: readonly RecordedUpstreamLine[],
  mock: ApiCallMock,
  requestSections: readonly RequestSection[],
): void {
  expect(mock.captured.length, `${caseId}: upstream call count`).toBe(recorded.length)
  for (let index = 0; index < recorded.length; index += 1) {
    const line = recorded[index]
    const call = mock.captured[index]
    if (line === undefined || call === undefined) throw new Error(`${caseId}: upstream call ${index} missing`)
    const context = `S5[${caseId}] upstream wire call ${index + 1}`
    expect(call.request.method, `${context}: method`).toBe(line.method)
    const url = new URL(call.request.url)
    expect(url.pathname, `${context}: path`).toBe(line.path)
    expect(call.request.body, `${context}: body bytes`).toBe(line.body)
    // The url must be the request body's url field, passed through byte-exactly.
    const stepId = `STEP ${index + 1}`
    const stepSection = requestSections.find((section) => section.stepId === stepId)
    const requestedUrl = stepSection === undefined ? undefined : (JSON.parse(stepSection.body) as { readonly url?: unknown }).url
    if (typeof requestedUrl === 'string') {
      expect(call.request.url, `${context}: url passthrough`).toBe(requestedUrl)
    }
    // Content-Length is transport-derived, so it never enters the ordered pair
    // compare — but the recording still pins its PRESENCE and VALUE: the adapter
    // must emit it exactly when the reference did (POST calls only), and it must
    // always equal the body byte length.
    const expectedPairs: Array<[string, string]> = []
    let recordedContentLength: string | undefined
    for (const [name, value] of Object.entries(line.headers)) {
      const lower = name.toLowerCase()
      if (UPSTREAM_EXCLUDED_HEADERS.has(lower)) continue
      if (lower.startsWith(UPSTREAM_CONTROL_PREFIX)) continue
      if (lower === 'content-length') {
        recordedContentLength = value
        continue
      }
      expectedPairs.push([name, value])
    }
    const actualPairs: Array<[string, string]> = []
    let adapterContentLength: string | undefined
    for (const [name, value] of call.request.headers) {
      const lower = name.toLowerCase()
      if (UPSTREAM_EXCLUDED_HEADERS.has(lower)) continue
      if (lower.startsWith(UPSTREAM_CONTROL_PREFIX)) continue
      if (lower === 'content-length') {
        adapterContentLength = value
        continue
      }
      actualPairs.push([name, value])
    }
    expect(actualPairs, `${context}: header list (order + canonical casing + values)`).toEqual(expectedPairs)
    if (recordedContentLength === undefined) {
      expect(
        adapterContentLength,
        `${context}: Content-Length must be absent when the recording has none`,
      ).toBeUndefined()
    } else {
      expect(adapterContentLength, `${context}: Content-Length must be present as recorded`).toBeDefined()
      expect(adapterContentLength, `${context}: Content-Length must match the recorded value`).toBe(recordedContentLength)
      expect(
        adapterContentLength,
        `${context}: Content-Length must match the body byte length`,
      ).toBe(String(byteLength(call.request.body)))
    }
  }
}

// ─── Request construction and response assertions ────────────────────────────────────

/** Headers the fetch runtime owns; the golden records them but they are not handler-set. */
const RUNTIME_FRAMED_HEADERS = new Set(['date', 'content-length', 'transfer-encoding'])

function buildRequest(section: RequestSection, capturedAuthIndex: string | undefined): Request {
  const headers: Array<[string, string]> = []
  for (const [name, value] of section.headers) {
    const lower = name.toLowerCase()
    // Host derives from the URL (identical origin recorded); Content-Length derives
    // from the body bytes (byte-identical after reconstruction).
    if (lower === 'host' || lower === 'content-length') continue
    headers.push([name, value])
  }
  let body = section.body
  if (capturedAuthIndex !== undefined) {
    body = body.replace(
      /("auth_index"\s*:\s*")[0-9a-f]{16}(")/,
      (_match, prefix: string, suffix: string) => `${prefix}${capturedAuthIndex}${suffix}`,
    )
  }
  return new Request(`${REQUEST_ORIGIN}${section.path}`, {
    method: section.method,
    headers,
    body: body === '' ? undefined : body,
  })
}

async function assertResponseStep(
  caseId: string,
  stepId: string,
  response: Response,
  expected: DownstreamSection,
  mask: MaskProfile,
): Promise<void> {
  const context = `S5[${caseId}] ${stepId}`
  expect(response.status, `${context}: status`).toBe(expected.status)

  const expectedPairs: Array<[string, string]> = []
  for (const [name, value] of expected.headers) {
    if (RUNTIME_FRAMED_HEADERS.has(name.toLowerCase())) continue
    expectedPairs.push([name.toLowerCase(), value])
  }
  const actualPairs: Array<[string, string]> = []
  let actualContentLength: string | undefined
  for (const [name, value] of response.headers) {
    const lower = name.toLowerCase()
    if (lower === 'content-length') {
      actualContentLength = value
      continue
    }
    if (RUNTIME_FRAMED_HEADERS.has(lower)) continue
    actualPairs.push([lower, value])
  }
  expect(actualPairs, `${context}: response headers (order + names + values)`).toEqual(expectedPairs)

  const rawHeaders = (response as { readonly rawHeaders?: unknown }).rawHeaders
  if (rawHeaders === undefined) {
    throw new Error(
      `${context}: the adapter must attach \`rawHeaders\` to every Response ` +
        '(Object.assign(new Response(...), { rawHeaders: [...] })) — fetch Headers lowercase names, ' +
        'and §2.2 pins the Go-canonical casing (X-Cpa-Version, ...); see the header of this file',
    )
  }
  if (!Array.isArray(rawHeaders)) throw new Error(`${context}: rawHeaders must be an array of [name, value] pairs`)
  const expectedRaw: Array<[string, string]> = []
  for (const [name, value] of expected.headers) {
    if (RUNTIME_FRAMED_HEADERS.has(name.toLowerCase())) continue
    expectedRaw.push([name, value])
  }
  expect(rawHeaders as unknown as HeaderList, `${context}: raw headers (canonical casing + order)`).toEqual(expectedRaw)

  const body = await response.text()
  if (actualContentLength !== undefined) {
    expect(actualContentLength, `${context}: Content-Length must match the body byte length`).toBe(String(byteLength(body)))
  }
  assertTimestampShapes(body, mask, context)
  const envelope = body.startsWith('{"files":[')
  expect(normalizeBody(body, mask, envelope), `${context}: body bytes`).toBe(
    normalizeBody(expected.body, mask, expected.body.startsWith('{"files":[')),
  )
}

const AUX_AUTH_INDEX_RE = /"auth-index":"([^"]*)"/

/** AUX steps are state capture: recorded status + structure, live value extracted. */
async function assertAuxStep(
  caseId: string,
  stepId: string,
  response: Response,
  expected: DownstreamSection,
): Promise<string> {
  const context = `S5[${caseId}] ${stepId} (aux)`
  expect(response.status, `${context}: status`).toBe(expected.status)
  const body = await response.text()
  const parsed = JSON.parse(body) as { readonly 'gemini-api-key'?: ReadonlyArray<{ readonly 'auth-index'?: unknown }> }
  const entry = parsed['gemini-api-key']?.[0]
  expect(entry, `${context}: gemini-api-key list carries one entry`).toBeDefined()
  const authIndex = entry?.['auth-index']
  expect(typeof authIndex, `${context}: entry carries a live auth-index`).toBe('string')
  const captured = AUX_AUTH_INDEX_RE.exec(body)?.[1]
  expect(captured, `${context}: auth-index is extractable and non-empty`).toBeTruthy()
  return typeof authIndex === 'string' ? authIndex : ''
}

// ─── Case runner ─────────────────────────────────────────────────────────────────────

/** Seed bytes = the recorded GET /config.yaml golden of the fleet template. */
async function loadSeedConfigYaml(): Promise<string> {
  const sections = parseDownstreamFile('S5-config-yaml', await readFixtureText('S5-config-yaml', 'downstream.md'))
  const seed = sections.find((section) => section.stepId === 'STEP 1')
  if (seed === undefined) throw new Error('S5-config-yaml STEP 1 golden (the seed config.yaml) is missing')
  return seed.body
}

async function replayCase(caseId: CaseId): Promise<void> {
  if (adapterFactory === undefined) throw new Error('adapter factory missing')
  const meta = await readFixtureJson<CaseMeta>(caseId, 'meta.yaml')
  const requestSections = parseRequestHttp(caseId, await readFixtureText(caseId, 'request.http'))
  const downstreams = parseDownstreamFile(caseId, await readFixtureText(caseId, 'downstream.md'))
  const mask = maskProfile(caseId, meta.dynamic_fields)
  const upstreamLog =
    meta.upstream_file === null ? [] : parseUpstreamLog(await readFixtureText(caseId, meta.upstream_file))
  const mock = makeApiCallMock(downstreams) // exercised only by POST /api-call

  const api = adapterFactory({
    configYaml: await loadSeedConfigYaml(),
    managementKey: MANAGEMENT_KEY,
    store: new MemoryStore(),
    buildInfo: BUILD_INFO,
    sendUpstream: mock.send,
    clientIp: CLIENT_IP,
  })
  if (typeof api.handle !== 'function') {
    throw new Error(`${ADAPTER_EXPORT}() must return an object with a handle(request) method`)
  }

  expect(requestSections.length, `S5[${caseId}]: request steps`).toBe(downstreams.length)
  let capturedAuthIndex: string | undefined
  for (let index = 0; index < requestSections.length; index += 1) {
    const section = requestSections[index]
    if (section === undefined) throw new Error(`S5[${caseId}]: request section ${index} missing`)
    const expected = downstreams[index]
    if (expected === undefined) throw new Error(`S5[${caseId}]: downstream section ${index} missing`)
    if (expected.stepId !== section.stepId) {
      throw new Error(`S5[${caseId}]: section ${index} ids disagree (${section.stepId} vs ${expected.stepId})`)
    }
    const metaStep = meta.steps.find((step) => step.label.startsWith(`${section.stepId} —`))
    if (metaStep === undefined) throw new Error(`S5[${caseId}]: meta.yaml has no entry for ${section.stepId}`)
    expect(expected.status, `S5[${caseId}] ${section.stepId}: recorded status agrees with meta.yaml`).toBe(metaStep.http_status)

    const response = await api.handle(buildRequest(section, capturedAuthIndex))
    if (metaStep.aux) {
      capturedAuthIndex = await assertAuxStep(caseId, section.stepId, response, expected)
      continue
    }
    await assertResponseStep(caseId, section.stepId, response, expected, mask)
  }
  if (upstreamLog.length > 0 || caseId === API_CALL_CASE) {
    assertUpstreamLog(caseId, upstreamLog, mock, requestSections)
  }
}

// ─── Fixture inventory (harness self-check, adapter-independent) ─────────────────────

const fixtureCaseDirs = (await readdir(FIXTURE_ROOT, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()

describe('S5 fixture inventory (harness self-check, adapter-independent)', () => {
  it('exposes exactly the 22 recorded golden cases', () => {
    expect([...fixtureCaseDirs]).toEqual([...EXPECTED_CASES].sort())
  })

  it('parses all 168 steps byte-exactly and recognizes every declared dynamic field', async () => {
    let totalSteps = 0
    for (const caseId of EXPECTED_CASES) {
      const meta = await readFixtureJson<CaseMeta>(caseId, 'meta.yaml')
      expect(meta.id, `${caseId}: meta.id echoes the directory name`).toBe(caseId)
      const requestSections = parseRequestHttp(caseId, await readFixtureText(caseId, 'request.http'))
      const downstreams = parseDownstreamFile(caseId, await readFixtureText(caseId, 'downstream.md'))
      expect(meta.steps.length, `${caseId}: meta steps count`).toBe(requestSections.length)
      expect(downstreams.length, `${caseId}: downstream sections count`).toBe(requestSections.length)
      maskProfile(caseId, meta.dynamic_fields) // fails loudly on unknown dynamic fields
      for (let index = 0; index < requestSections.length; index += 1) {
        const section = requestSections[index]
        const downstream = downstreams[index]
        if (section === undefined || downstream === undefined) throw new Error(`${caseId}: section ${index} missing`)
        totalSteps += 1
        expect(section.stepId, `${caseId} ${section.stepId}: request/downstream ids align`).toBe(downstream.stepId)
        expect(section.method, `${caseId} ${section.stepId}: methods align`).toBe(downstream.method)
        expect(section.path, `${caseId} ${section.stepId}: paths align`).toBe(downstream.path)
        expect(section.path.startsWith('/v0/management'), `${caseId} ${section.stepId}: management path`).toBe(true)
        const metaStep = meta.steps.find((step) => step.label.startsWith(`${section.stepId} —`))
        expect(metaStep, `${caseId} ${section.stepId}: meta entry exists`).toBeDefined()
        expect(downstream.status, `${caseId} ${section.stepId}: meta status agrees with the recording`).toBe(
          metaStep?.http_status,
        )
        // Wire-byte reconstruction already validated against the recorded Content-Length
        // inside the parser; re-assert the byte count here as a visible contract.
        if (section.declaredBodyLength !== undefined) {
          expect(byteLength(section.body), `${caseId} ${section.stepId}: request body bytes match Content-Length`).toBe(
            section.declaredBodyLength,
          )
        } else {
          expect(section.body, `${caseId} ${section.stepId}: bodyless request has no body`).toBe('')
        }
        if (downstream.declaredBodyLength !== undefined) {
          expect(byteLength(downstream.body), `${caseId} ${section.stepId}: response body bytes match Content-Length`).toBe(
            downstream.declaredBodyLength,
          )
        }
      }
      if (meta.upstream_file !== null) {
        expect(caseId, 'only the api-call case records upstream traffic').toBe(API_CALL_CASE)
        const lines = parseUpstreamLog(await readFixtureText(caseId, meta.upstream_file))
        expect(lines.length, `${caseId}: upstream.jsonl line count`).toBeGreaterThan(0)
      }
    }
    expect(totalSteps, 'S5 fixture corpus: 168 steps (167 case steps + 1 AUX)').toBe(168)
  })
})

// ─── Suites ──────────────────────────────────────────────────────────────────────────

suite(suiteTitle, () => {
  for (const caseId of EXPECTED_CASES) {
    it(`${caseId} — replays recorded steps byte-exactly (status + headers + bodies)`, async () => {
      await replayCase(caseId)
    })
  }
})
