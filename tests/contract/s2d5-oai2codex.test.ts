/**
 * S2d5 golden contract — OpenAI Chat Completions client → Codex (Responses API) upstream.
 *
 * Spec source of truth: spec/sections/S2d5-oai2codex.md (admitted, gate round 2). Goldens:
 * the 26 oracle-recorded fixture cases under tests/fixtures/S2d5/ (CLIProxyAPI v7.3.4,
 * commit 8335eac731946bd4eff18f500653f93736df53d6, deterministic codex mock; recorded by
 * oracle-runner-3). Rulings applied: R-SSE (downstream SSE compares as the decoded `data:`
 * frame sequence, never raw chunk boundaries), R-FIXTURE (all 26 cases are
 * RECORDABLE-LOCALLY codex-api-key replays; the OAuth-only Codex behaviors are
 * FIXTURE-DEFERRED and pinned by no case here), NE-LENIENT (every replayed request body is
 * well-formed JSON — the strict 400 boundary is a registered non-equivalence that no
 * golden exercises).
 *
 * R-ORDER was reviewed and is INERT on this direction: the S2d5 reference emits frames in
 * a deterministic order, and the only adjacent tool_calls frames in the goldens (S2D5-07:
 * one announcement + two argument fragments) belong to ONE call whose fragments are
 * sequential JSON pieces — their order is part of the wire contract (swapping them
 * corrupts client-side argument assembly). Every downstream frame is therefore
 * order-pinned; no canonicalization is applied. R-TOK (no token estimation exists in this
 * direction), R-404 and R-BCRYPT (S1/S3-S6 territory) are exercised by no fixture here.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * ADAPTER INTERFACE — what the `@cpa-edge/translators/oai2codex` direction module MUST
 * export. The suite dynamically imports the package and turns green-to-red once the
 * export ships; until then every case test SKIPS with the reason below. The harness holds
 * its own structural mirror of these types; the package should export the real ones. All
 * shapes are runtime-checked by the suite.
 *
 *   export function createOai2CodexService(options: Oai2CodexServiceOptions): Oai2CodexChatService
 *
 *   type HeaderList = ReadonlyArray<readonly [string, string]>   // ordered, original casing
 *
 *   interface Oai2CodexModelEntry {        // one model of a codex-api-key credential
 *     name: string                         // upstream model name (alias-rewrite target)
 *     alias?: string                       // client-facing alias; defaults to `name`
 *     thinking?: boolean                   // capability flag (spec §2.3). DEFAULT for
 *                                          // configured models: ABSENT (no thinking
 *                                          // capability) → the whole `reasoning` object
 *                                          // is stripped from the upstream body, whatever
 *                                          // `reasoning_effort` the client sent. TRUE =
 *                                          // capability-ON variant (effort passthrough);
 *                                          // NO golden sets it.
 *   }
 *
 *   interface Oai2CodexCredential {        // one codex-api-key config entry
 *     apiKey: string                       // upstream key → `Authorization: Bearer <apiKey>`
 *     baseUrl: string                      // upstream root, trailing "/" trimmed; upstream
 *                                          // URL = `<baseUrl>/responses`
 *     headers?: Readonly<Record<string, string>>
 *                                          // per-credential fixed headers (OPTIONAL; no
 *                                          // golden exercises it)
 *     models: readonly Oai2CodexModelEntry[]
 *   }
 *
 *   interface Oai2CodexServiceOptions {
 *     credentials: readonly Oai2CodexCredential[]
 *                                          // codex-api-key entries, config order
 *     store: Store                         // from @cpa-edge/core; ALL persistent state
 *                                          // (the 429 rate-limit cooldown of S2D5-24)
 *                                          // flows through it — no in-facade globals
 *     now?: () => number                   // epoch-ms clock; MUST drive every timing
 *                                          // decision (cooldown window open/close,
 *                                          // reset_seconds, Retry-After)
 *     requestRetry?: number               // 0 in every S2d5 fixture (no retries)
 *     transientErrorCooldownSeconds?: number
 *                                          // -1 in every S2d5 fixture. NOTE (spec §5 E2):
 *                                          // -1 disables only transient-error cooldowns;
 *                                          // the 429 rate-limit cooldown stays ACTIVE.
 *     disableCodexCloaking?: boolean      // OPTIONAL config (spec §2.2); false in every
 *                                          // fixture — cloaking is ON, so User-Agent and
 *                                          // Originator are the fixed codex-tui values.
 *   }
 *
 *   interface Oai2CodexChatRequest {
 *     method: string                       // 'POST'
 *     path: string                         // '/v1/chat/completions'
 *     headers: HeaderList                  // client headers, recorded order + casing (the
 *                                          // Bearer key feeds session derivation; the
 *                                          // whitelist headers may ride along)
 *     body: string                         // exact request-body bytes (well-formed JSON)
 *   }
 *
 *   interface Oai2CodexUpstreamRequest {
 *     method: string                       // 'POST'
 *     url: string                          // absolute `<baseUrl-trimmed>/responses`
 *     headers: HeaderList                  // emission ORDER is pinned (see below)
 *     body: string
 *   }
 *
 *   interface Oai2CodexUpstreamResponse {
 *     status: number
 *     headers: HeaderList
 *     body: ReadableStream<Uint8Array>     // 2xx: SSE bytes (the upstream is ALWAYS
 *                                          // requested as SSE); non-2xx: raw error bytes.
 *                                          // A rejected read mid-body models an upstream
 *                                          // hard disconnect (S2D5-17).
 *   }
 *
 *   type Oai2CodexUpstreamSender =
 *     (request: Oai2CodexUpstreamRequest) => Promise<Oai2CodexUpstreamResponse>
 *
 *   interface Oai2CodexChatResponse {
 *     status: number
 *     headers: HeaderList                  // must carry the direction-owned subset (below)
 *     body: string | ReadableStream<Uint8Array>
 *   }
 *
 *   interface Oai2CodexChatService {
 *     handleChatCompletions(
 *       request: Oai2CodexChatRequest,
 *       send: Oai2CodexUpstreamSender,
 *     ): Promise<Oai2CodexChatResponse>
 *   }
 *
 * The facade covers the whole pinned direction pipeline: alias → resolved-model rewrite,
 * chat → Responses request translation with the canonical field order (spec §2.3/§3),
 * the always-SSE upstream wire (§2.2/§2.4: fixed + cloaked headers, Session-Id identity,
 * whitelist), tool-name shortening + restoration (§2.10), tool-schema union → enum
 * rewriting (§2.11), non-stream aggregation incl. the empty-output patch (§2.4/§2.5),
 * SSE chunk mapping incl. service_tier latch and usage duplication (§2.6/§2.7), and the
 * error semantics of §5 (verbatim non-2xx passthrough, pre-commit vs in-stream terminal
 * failures, disconnect, empty-incomplete E6, model-not-found E7, and the 429 →
 * model_cooldown slice of §5 E2 whose state lives in the Store). Internals may compose
 * the codex executor and core scheduling primitives; only this facade is contract.
 *
 * OUT of scope here (owned by S1, asserted by no fixture in this suite): client auth
 * enforcement, the CORS block, Date emission, Content-Length/Transfer-Encoding exactness,
 * R-404 routing, keep-alive heartbeats (off in the golden configuration).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * HARNESS SEMANTICS
 *
 * • FIXTURE LAYOUT (RECIPES, reports/oracle/BOOTSTRAP.md §7): per case meta.yaml (JSON),
 *   request.http (R1..Rn request blocks), downstream.md (R1..Rn response sections),
 *   upstream.jsonl (one JSON line per upstream request, request order),
 *   mock-response.json (the scripted upstream behavior: `control_file` + optional
 *   `script_events`/`reply`). request.http heads and downstream.md head fences were
 *   recorded with CRLF; files are CRLF-normalized on read and every compared surface is
 *   CR-free (verified across all 26 cases).
 *
 * • ISOLATION. Every case replays through a FRESH service + FRESH MemoryStore. The one
 *   exception is built into the fixtures, not the harness: S2D5-24 is a PAIR recording —
 *   its R1 (upstream 429) and R2 (cooldown short-circuit) run back-to-back through the
 *   SAME service + store, exactly as the oracle recorded them.
 *
 * • CLOCK. Real wall-clock time is never consulted: `now()` returns one frozen epoch-ms
 *   constant for every step of every case. This makes the S2D5-24 cooldown envelope
 *   deterministic WITHOUT masking: R2 observes the cooldown window at elapsed ≈ 0, so a
 *   spec-faithful implementation reports the full recorded window — `Retry-After: 4`,
 *   `"reset_seconds":4`, `"reset_time":"4s"` — matching the recorded R2 bytes (recorded
 *   elapsed was ~0.1s of a 4s window; the reference reports the ceiling, which is 4
 *   either way). The cooldown literals are therefore byte-pinned, per the spec §5 E2
 *   recorded shape.
 *
 * • MOCK UPSTREAM. Each case's mock-response.json drives every upstream call the case
 *   makes (a single `control_file`, re-read per request — exactly the recording setup).
 *   Modes: happy — serve the control's `script_events`, or the embedded DEFAULT_SCRIPT
 *   when the control names no script (the codex mock's built-in canned stream);
 *   error — `reply.status` + pythonJson(`reply.body`) as the raw error bytes (the
 *   recorded 429 bodies carry Python json.dumps spacing — pythonJson reproduces it);
 *   disconnect — serve the default canned stream and error the read after
 *   `control_file.after` frames ("hard TCP close, no chunked terminator"). The read
 *   error text is harness-owned and intentionally generic: the reference surfaces its OWN
 *   incomplete-stream error text (§5 E5), so the adapter must not echo transport text.
 *   `slow` mode is not used by any S2d5 fixture and fails loudly if a fixture ever needs
 *   it.
 *
 * • Upstream calls are captured per step; after each step the captured count must equal
 *   meta.yaml `upstream_wire_lines_per_request` for that step — this pins "no upstream
 *   call" for gateway-local steps (S2D5-20 whole case; S2D5-24 R2). At the end of the
 *   case the captured sequence must equal the recorded upstream.jsonl lines (count +
 *   bytes).
 *
 * • CLAUSE LAYER. On top of the byte-gold, each captured upstream call is also checked
 *   against the semantic MUSTs that masking would otherwise hide (always-SSE, canonical
 *   constants, the reasoning strip, session-identity equality, case-specific rewrites).
 *   These clauses restate spec §2 in readable failures; they never loosen the byte gold.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * COMPARISON RULES
 *
 * Upstream wire (primary gold):
 *   - method, url (`<baseUrl-trimmed>` + recorded path `/responses`), body: byte-exact
 *     after masking. The canonical field order, the raw-token passthrough of
 *     `parameters` (client JSON spacing preserved!), the union → enum splice of
 *     S2D5-25, tool shortening and `store:false` / `parallel_tool_calls:true` are all
 *     pinned by this single comparison.
 *   - headers: the full ordered list, names case-preserved, pinned to the recorded wire
 *     order (Host, User-Agent, Content-Length, Accept, Authorization, Connection,
 *     Content-Type, Originator, Session-Id, Accept-Encoding). Recording-only `ts`/`type`
 *     fields of upstream.jsonl are not part of the wire request. `Content-Length` is
 *     excluded from the ordered compare and instead consistency-checked (if the adapter
 *     emits it, it must equal the body byte length). `Authorization` is redacted in the
 *     recordings; the adapter's value must start with "Bearer " and is normalized to
 *     "<redacted>". The `Host` port is masked per meta.yaml (`:<PORT>`).
 *   - The header ORDER also pins the client-header whitelist: nothing the client sent
 *     beyond the fixed set reaches the mock (client User-Agent/Accept/Content-Type are
 *     absent — overridden or dropped; only the whitelisted names may ride along, and
 *     only S2D5-22's Session-Id does).
 *
 * Downstream (per step):
 *   - status: exact. Body: byte-exact after masking — SSE bodies compare as DECODED
 *     frame sequences per R-SSE (the ordered list of `data:` payloads, `data: [DONE]`
 *     included; chunk boundaries ignored). `event:`/`id:` lines must NOT appear
 *     downstream (spec §2.6 re-framing).
 *   - headers: only the direction-owned subset is asserted:
 *       · Content-Type (exact) — and it pins "no SSE headers before commit" together
 *         with Cache-Control absence on the pre-commit failures (S2D5-15/16/19/20/24-R2
 *         and S2D5-26);
 *       · Cache-Control (exact `no-cache` when the recorded response is SSE, absent
 *         otherwise);
 *       · Retry-After (exact when present — the ONLY recorded value is S2D5-24 R2's
 *         `4`, byte-pinned; absent when the recording has none);
 *       · X-Cpa-Trace-Id — PRESENCE ONLY, matching the recorded head (value never
 *         compared). The recorded trace-ABSENT surfaces are S2D5-20 (gateway-local 400)
 *         and S2D5-24 R2 (the cooldown envelope, spec §7 item 15); the suite pins that
 *         the adapter mirrors those absences instead of papering over them.
 *   - `Date`, `Connection`, `Content-Length`, `Transfer-Encoding` and the CORS block are
 *     S1/transport territory and are not compared.
 *
 * MASKS — applied identically to recorded and produced bytes, derived from each case's
 * meta.yaml `dynamic_fields` (unknown entries fail the suite loudly):
 *   - X-Cpa-Trace-Id / Date: declared volatile; Date is never compared, the trace id is
 *     compared for PRESENCE only.
 *   - Session-Id / prompt_cache_key: masked where DERIVED; kept byte-exact where the
 *     CLIENT fixed the value (meta: "mask per-case when derived, keep when fixed by the
 *     case"):
 *       · S2D5-21 — client body `prompt_cache_key` "fixed-cache-key-123": BOTH the
 *         upstream Session-Id header and the body field are pinned verbatim;
 *       · S2D5-22 — client `Session-Id` header: the upstream header is pinned verbatim;
 *         the derived body `prompt_cache_key` is masked;
 *       · every other case with an upstream call: both masked (`<SESSION>`). The §2.9
 *         equality MUST (header == body field when the client supplied no session
 *         signal) and the UUID shape are asserted unmasked by the clause layer.
 *   - Host / Content-Length / Accept-Encoding / wire-log ts: transport-level; Host's
 *     port is masked, Content-Length is consistency-checked, Accept-Encoding stays
 *     pinned (`gzip`), ts is dropped.
 *   - NOT masked anywhere (all fixed by the recordings): `created` (canned script
 *     values), `usage` (incl. the cache_write_tokens → cache_write_tokens +
 *     cached_creation_tokens duplication), `reset_seconds` / `reset_time` /
 *     `Retry-After` (frozen-clock argument above), `last_upstream_error` (the verbatim
 *     upstream 429 body, json.dumps spacing included).
 */
import { readdir, readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { MemoryStore } from '@cpa-edge/core'
import type { Store } from '@cpa-edge/core'

// ─── Adapter load (skip-with-explanation until the real export ships) ────────────────

const ADAPTER_MODULE = '@cpa-edge/translators/oai2codex'
const ADAPTER_EXPORT = 'createOai2CodexService'

/** Structural mirror of the adapter interface documented in the header. */
type HeaderList = ReadonlyArray<readonly [string, string]>

interface ModelEntry {
  readonly name: string
  readonly alias?: string
  readonly thinking?: boolean
}

interface CredentialConfig {
  readonly apiKey: string
  readonly baseUrl: string
  readonly headers?: Readonly<Record<string, string>>
  readonly models: readonly ModelEntry[]
}

interface ServiceOptions {
  readonly credentials: readonly CredentialConfig[]
  readonly store: Store
  readonly now: () => number
  readonly requestRetry: number
  readonly transientErrorCooldownSeconds: number
  readonly disableCodexCloaking?: boolean
}

interface ChatRequest {
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

interface ChatResponse {
  readonly status: number
  readonly headers: HeaderList
  readonly body: string | ReadableStream<Uint8Array>
}

interface ChatService {
  handleChatCompletions(request: ChatRequest, send: UpstreamSender): Promise<ChatResponse>
}

type AdapterFactory = (options: ServiceOptions) => ChatService

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
        'All 26 S2d5 golden cases SKIP until the oai2codex adapter ships; the required interface is documented in the header of this file.',
    }
  } catch (error) {
    return { skipReason: `import of \`${ADAPTER_MODULE}\` failed: ${String(error)}` }
  }
}

const adapterLoad = await loadAdapter()
const adapterFactory = adapterLoad.factory
const suite = adapterFactory ? describe : describe.skip
const suiteTitle = adapterFactory
  ? 'S2d5 — oai2codex golden contract (recorded fixtures)'
  : `S2d5 — oai2codex golden contract (SKIPPED: ${adapterLoad.skipReason ?? 'adapter unavailable'})`

// ─── Fixture access ───────────────────────────────────────────────────────────────────

const FIXTURE_ROOT = new URL('../fixtures/S2d5/', import.meta.url)

/** One frozen epoch-ms instant for every step of every case (see header: CLOCK). */
const FROZEN_NOW_MS = 1_789_493_254_000

/** Recording-instance values, transcribed from each meta.yaml / the recording config. */
const UPSTREAM_API_KEY = 'mock-codex-key' // redacted ("<redacted>") in every wire log
const UPSTREAM_BASE_URL = 'http://host.docker.internal:21003'
const UPSTREAM_MODEL = 'gpt-mock-codex'
const MODEL_ALIAS = 'cx'
const CLOAKED_USER_AGENT = 'codex-tui/0.154.0 (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; 0.154.0)'
const VERSION_IMAGE = 'eceasy/cli-proxy-api:v7.3.4'
const VERSION_COMMIT = '8335eac731946bd4eff18f500653f93736df53d6'
const ROUTE_PATH = '/v1/chat/completions'

const EXPECTED_CASES = [
  'S2D5-01-nonstream-basic-aggregation',
  'S2D5-02-stream-basic',
  'S2D5-03-system-developer-multimodal',
  'S2D5-04-reasoning-effort-high',
  'S2D5-05-reasoning-effort-none',
  'S2D5-06-tools-history',
  'S2D5-07-stream-toolcall',
  'S2D5-08-nonstream-toolcall',
  'S2D5-09-stream-reasoning-deltas',
  'S2D5-10-nonstream-reasoning-item',
  'S2D5-11-stream-incomplete-length',
  'S2D5-12-nonstream-empty-output-patch',
  'S2D5-13-usage-rich',
  'S2D5-14-service-tier',
  'S2D5-15-upstream-429-nonstream',
  'S2D5-16-upstream-429-stream-precommit',
  'S2D5-17-disconnect-midstream',
  'S2D5-18-terminal-failure-midstream',
  'S2D5-19-terminal-failure-first',
  'S2D5-20-model-not-found',
  'S2D5-21-prompt-cache-key-passthrough',
  'S2D5-22-client-session-id-header',
  'S2D5-23-response-format-json-schema',
  'S2D5-24-rate-limit-cooldown-pair',
  'S2D5-25-union-schema-enum-rewrite',
  'S2D5-26-empty-incomplete-zero-tokens',
] as const

type CaseId = (typeof EXPECTED_CASES)[number]

const FIXTURE_FILES = ['downstream.md', 'meta.yaml', 'mock-response.json', 'request.http', 'upstream.jsonl'] as const

const fixtureCaseDirs = (await readdir(FIXTURE_ROOT, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()

function caseFile(caseId: string, name: string): URL {
  return new URL(`${caseId}/${name}`, FIXTURE_ROOT)
}

async function readFixtureText(caseId: string, name: string): Promise<string> {
  // request.http heads and downstream.md head fences were recorded with CRLF; compared
  // surfaces are CR-free (verified across all 26 cases), so terminators normalize on read.
  const raw = await readFile(caseFile(caseId, name), 'utf8')
  return raw.replaceAll('\r\n', '\n')
}

async function readFixtureJson<T>(caseId: string, name: string): Promise<T> {
  return JSON.parse(await readFixtureText(caseId, name)) as T
}

// ─── Fixture file parsers (request.http / downstream.md) ─────────────────────────────

/**
 * request.http holds one block per recorded request:
 * `### R1: POST /v1/chat/completions` then the request line, head lines, a blank
 * separator, and the exact body bytes. Bodies are single-line JSON, so the head/body
 * split at the first blank line and a trim of the file's trailing newline recover the
 * exact sent bytes (verified: parsed length == the recorded Content-Length, all cases).
 */
function parseRequestBlocks(text: string): readonly ChatRequest[] {
  const blocks = text.split(/\n### R\d+[^\n]*\n/).slice(1)
  return blocks.map((block) => {
    const separator = block.indexOf('\n\n')
    if (separator < 0) throw new Error('request.http block has no head/body separator')
    const head = block.slice(0, separator)
    let body = block.slice(separator + 2)
    if (body.startsWith('\n')) body = body.slice(1)
    if (body.endsWith('\n')) body = body.slice(0, -1)
    const lines = head.split('\n')
    const requestLine = (lines[0] ?? '').split(' ')
    const headers: Array<[string, string]> = []
    for (const line of lines.slice(1)) {
      const colon = line.indexOf(': ')
      if (colon <= 0) continue
      headers.push([line.slice(0, colon), line.slice(colon + 2)])
    }
    return { method: requestLine[0] ?? '', path: requestLine[1] ?? '', headers, body }
  })
}

interface RecordedResponse {
  readonly status: number
  readonly headers: HeaderList
  readonly body: string
  /** Byte count stated in the `### Body (N bytes, exact)` heading — an integrity check. */
  readonly claimedBodyBytes: number
}

/**
 * downstream.md holds one `## Rn` section per recorded response: a fenced response head
 * (status line + headers, ending at the first blank line) and a fenced body under
 * `### Body (N bytes, exact)` (the exact body bytes; the fence's own trailing newline is
 * stripped by the pattern, which reproduces SSE bodies' trailing blank lines).
 */
function parseDownstreamSections(text: string): Readonly<Record<string, RecordedResponse>> {
  const sections: Record<string, RecordedResponse> = {}
  const padded = `\n${text}`
  const markers = [...padded.matchAll(/\n## (R\d+)\n/g)]
  for (let index = 0; index < markers.length; index += 1) {
    const marker = markers[index]
    if (marker === undefined) continue
    const sectionId = marker[1] ?? ''
    const start = (marker.index ?? 0) + marker[0].length
    const next = markers[index + 1]
    const end = next?.index ?? padded.length
    const section = padded.slice(start, end)

    const headMatch = section.match(/```\n(HTTP\/1\.1[^\n]*)\n([\s\S]*?)\n```/)
    if (headMatch === null) throw new Error(`downstream.md ${sectionId}: missing response-head fence`)
    const statusLine = headMatch[1] ?? ''
    const status = Number(statusLine.split(' ')[1])
    if (!Number.isInteger(status) || status <= 0) {
      throw new Error(`downstream.md ${sectionId}: unparsable status line ${statusLine}`)
    }
    const headers: Array<[string, string]> = []
    for (const line of (headMatch[2] ?? '').split('\n')) {
      if (line === '') break
      const colon = line.indexOf(': ')
      if (colon <= 0) continue
      headers.push([line.slice(0, colon), line.slice(colon + 2)])
    }

    const bodyMatch = section.match(/### Body \((\d+) bytes, exact\)\n```\n([\s\S]*?)\n```/)
    if (bodyMatch === null) throw new Error(`downstream.md ${sectionId}: missing body fence`)
    sections[sectionId] = {
      status,
      headers,
      body: bodyMatch[2] ?? '',
      claimedBodyBytes: Number(bodyMatch[1]),
    }
  }
  return sections
}

// ─── Masking (meta.yaml dynamic_fields → policy) ────────────────────────────────────

/** meta.yaml dynamic_fields entries this harness recognizes; anything else fails loudly. */
const RECOGNIZED_DYNAMIC_FIELDS: ReadonlySet<string> = new Set([
  'X-Cpa-Trace-Id (response header)',
  'Date (response header)',
  'Session-Id / prompt_cache_key derived session UUID (upstream header + body; mask per-case when derived, keep when fixed by the case)',
  'Host, Content-Length, Accept-Encoding (transport-level headers in the upstream wire log)',
  'upstream Host port (21003)',
  'mock wire log ts',
])

interface SessionPolicy {
  /** Mask the upstream `Session-Id` header value (`<SESSION>`)? */
  readonly header: boolean
  /** Mask the upstream body `prompt_cache_key` value (`<SESSION>`)? */
  readonly body: boolean
}

/**
 * Where the CLIENT fixed the session identity the recording keeps the value verbatim;
 * derived values are masked. Everything not listed derives (mask both surfaces).
 * See header MASKS for the meta.yaml wording this table implements.
 */
const SESSION_PINNED_BY_CLIENT: Readonly<Record<string, SessionPolicy>> = {
  'S2D5-21-prompt-cache-key-passthrough': { header: false, body: false },
  'S2D5-22-client-session-id-header': { header: false, body: true },
}

function sessionPolicyFor(caseId: CaseId): SessionPolicy {
  return SESSION_PINNED_BY_CLIENT[caseId] ?? { header: true, body: true }
}

function validateDynamicFields(caseId: string, dynamicFields: readonly string[]): void {
  for (const field of dynamicFields) {
    if (!RECOGNIZED_DYNAMIC_FIELDS.has(field)) {
      throw new Error(
        `S2d5[${caseId}]: unrecognized meta.yaml dynamic_fields entry ${JSON.stringify(field)} — ` +
          'extend the mask table in tests/contract/s2d5-oai2codex.test.ts consciously',
      )
    }
  }
}

const PROMPT_CACHE_KEY_RE = /"prompt_cache_key":"[^"]*"/g
const HOST_PORT_RE = /:\d+$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function normalizeUpstreamBody(text: string, policy: SessionPolicy): string {
  return policy.body ? text.replace(PROMPT_CACHE_KEY_RE, '"prompt_cache_key":"<SESSION>"') : text
}

function normalizeUpstreamHeaderValue(name: string, value: string, policy: SessionPolicy): string {
  const key = name.toLowerCase()
  if (key === 'session-id' && policy.header) return '<SESSION>'
  if (key === 'host') return value.replace(HOST_PORT_RE, ':<PORT>')
  return value
}

// ─── Canned mock scripts + mock upstream transport ───────────────────────────────────

interface MockScriptEvent {
  readonly event: string
  readonly data: unknown
}

/**
 * The codex mock's built-in default stream, transcribed byte-faithfully from
 * spec/recordings/S2d5.cases.json `scripts.default` (JSON syntax kept verbatim so the
 * transcription stays diffable against its source). Every fixture whose control names no
 * script — and the disconnect mode — replays against this stream; scripted cases carry
 * their own events in mock-response.json `script_events`.
 */
const DEFAULT_SCRIPT: readonly MockScriptEvent[] = [
    {
      "event": "response.created",
      "data": {
        "type": "response.created",
        "response": {
          "id": "resp_mock_01",
          "object": "response",
          "created_at": 1770000000,
          "status": "in_progress",
          "model": "gpt-mock-codex",
          "output": [],
          "usage": {
            "input_tokens": 9,
            "output_tokens": 6,
            "total_tokens": 15
          },
          "parallel": false,
          "tool_choice": "auto",
          "tools": []
        }
      }
    },
    {
      "event": "response.output_item.added",
      "data": {
        "type": "response.output_item.added",
        "output_index": 0,
        "item": {
          "type": "message",
          "id": "msg_mock_01",
          "role": "assistant",
          "status": "in_progress",
          "content": []
        }
      }
    },
    {
      "event": "response.content_part.added",
      "data": {
        "type": "response.content_part.added",
        "item_id": "msg_mock_01",
        "output_index": 0,
        "content_index": 0,
        "part": {
          "type": "output_text",
          "text": "",
          "annotations": []
        }
      }
    },
    {
      "event": "response.output_text.delta",
      "data": {
        "type": "response.output_text.delta",
        "item_id": "msg_mock_01",
        "output_index": 0,
        "content_index": 0,
        "delta": "Hello from mock codex upstream"
      }
    },
    {
      "event": "response.output_text.delta",
      "data": {
        "type": "response.output_text.delta",
        "item_id": "msg_mock_01",
        "output_index": 0,
        "content_index": 0,
        "delta": " more"
      }
    },
    {
      "event": "response.output_text.done",
      "data": {
        "type": "response.output_text.done",
        "item_id": "msg_mock_01",
        "output_index": 0,
        "content_index": 0,
        "text": "Hello from mock codex upstream more"
      }
    },
    {
      "event": "response.content_part.done",
      "data": {
        "type": "response.content_part.done",
        "item_id": "msg_mock_01",
        "output_index": 0,
        "content_index": 0,
        "part": {
          "type": "output_text",
          "text": "Hello from mock codex upstream more",
          "annotations": []
        }
      }
    },
    {
      "event": "response.output_item.done",
      "data": {
        "type": "response.output_item.done",
        "output_index": 0,
        "item": {
          "type": "message",
          "id": "msg_mock_01",
          "role": "assistant",
          "status": "completed",
          "content": [
            {
              "type": "output_text",
              "text": "Hello from mock codex upstream more",
              "annotations": []
            }
          ]
        }
      }
    },
    {
      "event": "response.completed",
      "data": {
        "type": "response.completed",
        "response": {
          "id": "resp_mock_01",
          "object": "response",
          "created_at": 1770000000,
          "status": "completed",
          "model": "gpt-mock-codex",
          "output": [
            {
              "type": "message",
              "id": "msg_mock_01",
              "role": "assistant",
              "status": "completed",
              "content": [
                {
                  "type": "output_text",
                  "text": "Hello from mock codex upstream more",
                  "annotations": []
                }
              ]
            }
          ],
          "usage": {
            "input_tokens": 9,
            "output_tokens": 6,
            "total_tokens": 15
          },
          "parallel": false,
          "tool_choice": "auto",
          "tools": []
        }
      }
    }
]

interface MockControl {
  readonly mode?: string
  readonly script?: string
  readonly status?: number
  readonly after?: number
}

interface MockFile {
  readonly control_file?: MockControl
  readonly script?: string
  readonly script_events?: readonly unknown[]
  readonly reply?: { readonly status?: number; readonly body?: unknown }
  readonly behavior?: string
}

function mockControl(mockFile: MockFile, caseId: string): MockControl {
  const control = mockFile.control_file
  if (control === undefined) {
    throw new Error(`S2d5[${caseId}]: mock-response.json must carry a control_file object`)
  }
  return control
}

/** Validates a mock-response.json `script_events` list into harness events. */
function scriptEventsOf(mockFile: MockFile, caseId: string): readonly MockScriptEvent[] {
  const raw = mockFile.script_events
  if (raw === undefined || raw.length === 0) {
    throw new Error(`S2d5[${caseId}]: script control without script_events in mock-response.json`)
  }
  return raw.map((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`S2d5[${caseId}]: script_events[${index}] is not an object`)
    }
    const record = entry as Record<string, unknown>
    if (typeof record.event !== 'string' || record.data === null || typeof record.data !== 'object') {
      throw new Error(`S2d5[${caseId}]: script_events[${index}] must carry { event: string, data: object }`)
    }
    return { event: record.event, data: record.data }
  })
}

const encoder = new TextEncoder()

/** Serializes like Python's json.dumps defaults — the recorded 429 and failure bodies depend on that spacing. */
function pythonJson(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new Error(`mock upstream cannot serialize non-integer number ${String(value)}`)
    return String(value)
  }
  if (typeof value === 'boolean' || value === null) return String(value)
  if (Array.isArray(value)) return `[${value.map(pythonJson).join(', ')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}: ${pythonJson(entry)}`).join(', ')}}`
  }
  throw new Error(`mock upstream cannot serialize value of type ${typeof value}`)
}

/**
 * Demand-driven byte stream: every pull hands out one chunk; the read after the last chunk
 * closes normally, or errors when `abortAfter` chunks were served (upstream disconnect —
 * the rejection models a hard TCP close without a chunked terminator).
 */
function scriptedByteStream(chunks: readonly Uint8Array[], abortAfter?: number): ReadableStream<Uint8Array> {
  let served = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const index = served
      served += 1
      if (abortAfter !== undefined && index >= abortAfter) {
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

function buildMockUpstreamResponse(control: MockControl, mockFile: MockFile, caseId: string): MockResponseSpec {
  const mode = control.mode ?? 'happy'
  if (mode === 'error') {
    const reply = mockFile.reply
    if (reply === undefined || reply.body === undefined || reply.status === undefined) {
      throw new Error(`S2d5[${caseId}]: error control must carry reply { status, body } in mock-response.json`)
    }
    return {
      status: reply.status,
      headers: [['Content-Type', 'application/json']],
      body: scriptedByteStream([encoder.encode(pythonJson(reply.body))]),
    }
  }
  if (mode !== 'happy' && mode !== 'disconnect') {
    throw new Error(`S2d5[${caseId}]: mock mode ${JSON.stringify(mode)} is not implemented by this harness`)
  }
  const events = control.script === undefined ? DEFAULT_SCRIPT : scriptEventsOf(mockFile, caseId)
  const chunks = events.map((event) => encoder.encode(`event: ${event.event}\ndata: ${pythonJson(event.data)}\n\n`))
  const abortAfter = mode === 'disconnect' ? control.after : undefined
  if (mode === 'disconnect' && (abortAfter === undefined || !Number.isInteger(abortAfter) || abortAfter < 0)) {
    throw new Error(`S2d5[${caseId}]: disconnect control must carry a non-negative integer "after"`)
  }
  return {
    status: 200,
    headers: [['Content-Type', 'text/event-stream']],
    body: scriptedByteStream(chunks, abortAfter),
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

async function readResponseBody(body: ChatResponse['body']): Promise<string> {
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

/** R-SSE: the contract surface is the ordered `data:` payload list; framing is transport. */
function decodeSseDataFrames(body: string): string[] {
  const frames: string[] = []
  for (const block of body.split('\n\n')) {
    for (const line of block.split('\n')) {
      if (line.startsWith('data: ')) frames.push(line.slice('data: '.length))
    }
  }
  return frames
}

function truncate(text: string): string {
  return text.length > 200 ? `${text.slice(0, 200)}…` : text
}

/** Order-pinned frame comparison (R-ORDER is inert on this direction — see header). */
function expectFrameSequence(actual: readonly string[], expected: readonly string[], context: string): void {
  if (actual.length !== expected.length) {
    let difference = 'one side is empty'
    const count = Math.min(actual.length, expected.length)
    for (let i = 0; i < count; i += 1) {
      if (actual[i] !== expected[i]) {
        difference = `frame ${i}: recorded ${truncate(expected[i] ?? '')} vs produced ${truncate(actual[i] ?? '')}`
        break
      }
    }
    if (difference === 'one side is empty' && count > 0) difference = `common prefix of ${count} frames matches`
    throw new Error(`${context}: decoded SSE frame count ${actual.length} != recorded ${expected.length}. ${difference}`)
  }
  for (let index = 0; index < expected.length; index += 1) {
    expect(actual[index], `${context}: SSE frame ${index}`).toBe(expected[index])
  }
}

interface RecordedUpstreamLine {
  readonly method: string
  readonly path: string
  readonly headers: Record<string, string>
  readonly body: string
}

interface CapturedUpstreamCall {
  readonly step: number
  readonly request: ChatRequest
  readonly call: UpstreamRequest
}

function assertUpstreamWire(
  recorded: RecordedUpstreamLine,
  captured: CapturedUpstreamCall,
  policy: SessionPolicy,
  caseId: string,
  baseUrl: string,
): void {
  const context = `S2d5[${caseId}] step ${captured.step} upstream wire`
  expect(captured.call.method, `${context}: method`).toBe(recorded.method)
  expect(captured.call.url, `${context}: url (baseUrl + recorded path)`).toBe(
    `${baseUrl.replace(/\/+$/, '')}${recorded.path}`,
  )

  const expectedPairs: Array<[string, string]> = []
  for (const [name, value] of Object.entries(recorded.headers)) {
    if (name.toLowerCase() === 'content-length') continue // transport-derived; consistency-checked below
    expectedPairs.push([name, normalizeUpstreamHeaderValue(name, value, policy)])
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
    actualPairs.push([name, normalizeUpstreamHeaderValue(name, value, policy)])
  }
  expect(actualPairs, `${context}: header list (order + names + values)`).toEqual(expectedPairs)
  if (actualContentLength !== undefined) {
    expect(actualContentLength, `${context}: Content-Length must match the body byte length`).toBe(
      String(encoder.encode(captured.call.body).length),
    )
  }
  expect(normalizeUpstreamBody(captured.call.body, policy), `${context}: translated body bytes`).toBe(
    normalizeUpstreamBody(recorded.body, policy),
  )
}

async function assertDownstreamStep(
  response: ChatResponse,
  expected: RecordedResponse,
  caseId: string,
  step: number,
): Promise<void> {
  const context = `S2d5[${caseId}] step ${step} downstream`
  const body = await readResponseBody(response.body)
  expect(response.status, `${context}: status`).toBe(expected.status)

  const expectedContentType = headerValue(expected.headers, 'content-type')
  expect(expectedContentType, `${context}: fixture must record Content-Type`).toBeDefined()
  const contentType = headerValue(response.headers, 'content-type')
  expect(contentType, `${context}: Content-Type`).toBe(expectedContentType)

  const expectedCacheControl = headerValue(expected.headers, 'cache-control')
  const cacheControl = headerValue(response.headers, 'cache-control')
  if (expectedCacheControl === undefined) {
    expect(cacheControl, `${context}: Cache-Control must be absent outside SSE commits`).toBeUndefined()
  } else {
    expect(cacheControl, `${context}: Cache-Control`).toBe(expectedCacheControl)
  }

  const expectedRetryAfter = headerValue(expected.headers, 'retry-after')
  const retryAfter = headerValue(response.headers, 'retry-after')
  if (expectedRetryAfter === undefined) {
    expect(retryAfter, `${context}: Retry-After must be absent when the recording has none`).toBeUndefined()
  } else {
    // Never masked: the only recorded value is the S2D5-24 R2 cooldown literal "4",
    // deterministic under the frozen clock (see header: CLOCK).
    expect(retryAfter, `${context}: Retry-After`).toBe(expectedRetryAfter)
  }

  // Presence-only: the trace id VALUE is dynamic; the recorded absences (S2D5-20 and
  // S2D5-24 R2) are part of the contract surface (spec §7 item 15).
  const expectedTrace = headerValue(expected.headers, 'x-cpa-trace-id') !== undefined
  expect(
    headerValue(response.headers, 'x-cpa-trace-id') !== undefined,
    `${context}: X-Cpa-Trace-Id presence must match the recorded head`,
  ).toBe(expectedTrace)

  if (expectedContentType === 'text/event-stream') {
    for (const line of body.split('\n')) {
      expect(
        line.startsWith('event:') || line.startsWith('id:'),
        `${context}: downstream SSE must carry only data: frames — found ${truncate(line)}`,
      ).toBe(false)
    }
    const expectedFrames = decodeSseDataFrames(expected.body)
    const actualFrames = decodeSseDataFrames(body)
    expectFrameSequence(actualFrames, expectedFrames, context)
  } else {
    expect(body, `${context}: body bytes`).toBe(expected.body)
  }
}

// ─── Clause layer (semantic MUSTs that masking would hide) ───────────────────────────

function parseJsonRecord(text: string, context: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${context}: expected a JSON object`)
  }
  return parsed as Record<string, unknown>
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function asArray(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) ? value : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * Spec §2/§3 invariants restated as readable assertions on the CAPTURED (unmasked) wire.
 * These clauses duplicate nothing the byte gold already pins loosely — they pin what
 * masking could hide and name the MUST each check enforces.
 */
function assertUpstreamClauses(caseId: CaseId, captured: CapturedUpstreamCall): void {
  const context = `S2d5[${caseId}] step ${captured.step} upstream clauses`
  const parsed = parseJsonRecord(captured.call.body, `${context}: translated body`)
  const sessionHeader = headerValue(captured.call.headers, 'session-id')
  const bodyCacheKey = asString(parsed.prompt_cache_key)

  // §2.4: the upstream is ALWAYS requested as SSE, stream and non-stream clients alike.
  expect(parsed.stream, `${context}: body stream flag (always-SSE)`).toBe(true)
  expect(headerValue(captured.call.headers, 'accept'), `${context}: Accept header (always-SSE)`).toBe('text/event-stream')

  // §2.3 canonical constants.
  expect(parsed.store, `${context}: store`).toBe(false)
  expect(parsed.parallel_tool_calls, `${context}: parallel_tool_calls`).toBe(true)
  expect(parsed.instructions, `${context}: instructions`).toBe('')
  expect(parsed.include, `${context}: include`).toEqual(['reasoning.encrypted_content'])

  // §2.3 capability-less model: the whole reasoning object is stripped, whatever
  // reasoning_effort the client sent (goldens S2D5-04/05/09 pin the client side).
  expect(Object.hasOwn(parsed, 'reasoning'), `${context}: reasoning key must be absent (capability strip)`).toBe(false)

  // §2.3: default config injects the image_generation tool as the LAST tools element.
  const tools = asArray(parsed.tools)
  expect(tools, `${context}: tools array`).toBeDefined()
  expect(tools?.[tools.length - 1], `${context}: injected image_generation tool appended LAST`).toEqual({
    type: 'image_generation',
    output_format: 'png',
  })

  // §2.2: cloaking runs LAST — the fixed codex-tui identity overwrites everything else.
  expect(headerValue(captured.call.headers, 'user-agent'), `${context}: cloaked User-Agent`).toBe(CLOAKED_USER_AGENT)
  expect(headerValue(captured.call.headers, 'originator'), `${context}: cloaked Originator`).toBe('codex-tui')

  // §2.9 session identity: client prompt_cache_key (1) → verbatim on BOTH surfaces;
  // client Session-Id header (2) → verbatim header, derived body key; otherwise (3) the
  // header and the body key are the SAME derived UUID.
  const clientBody = parseJsonRecord(captured.request.body, `${context}: client body`)
  const clientCacheKey = asString(clientBody.prompt_cache_key)
  const clientSessionHeader = headerValue(captured.request.headers, 'session-id')
  if (clientCacheKey !== undefined) {
    expect(sessionHeader, `${context}: Session-Id header == client prompt_cache_key (verbatim)`).toBe(clientCacheKey)
    expect(bodyCacheKey, `${context}: body prompt_cache_key == client prompt_cache_key (verbatim)`).toBe(clientCacheKey)
  } else if (clientSessionHeader !== undefined) {
    expect(sessionHeader, `${context}: Session-Id header == client Session-Id (verbatim)`).toBe(clientSessionHeader)
    expect(bodyCacheKey, `${context}: body prompt_cache_key is the derived UUID`).toMatch(UUID_RE)
  } else {
    expect(sessionHeader, `${context}: §2.9 identity equality (header == body prompt_cache_key)`).toBe(bodyCacheKey)
    expect(bodyCacheKey, `${context}: derived identity is a UUID`).toMatch(UUID_RE)
    expect(sessionHeader, `${context}: derived identity is a UUID`).toMatch(UUID_RE)
  }

  if (caseId === 'S2D5-07-stream-toolcall' || caseId === 'S2D5-08-nonstream-toolcall') {
    // §2.10: >64-char mcp__ name shortened upstream (restoration is pinned downstream by
    // the byte gold: the client's original long name reappears in tool_calls).
    const name = asString(asRecord(tools?.[0])?.name)
    expect(name, `${context}: shortened tool name`).toBe('mcp__jira_search_issues_with_advanced_filters_and_pagination_opt')
    expect((name ?? '').length <= 64, `${context}: shortened name within the 64-char limit`).toBe(true)
  }

  if (caseId === 'S2D5-25-union-schema-enum-rewrite') {
    // §2.11: 8-branch pure-const oneOf → enum rewrite (oneOf deleted, values in order).
    const pickMode = (asArray(parsed.tools) ?? [])
      .map((tool) => asRecord(tool))
      .find((tool) => asString(tool?.name) === 'pick_mode')
    const mode = asRecord(asRecord(asRecord(pickMode?.parameters)?.properties)?.mode)
    expect(mode, `${context}: pick_mode mode property`).toBeDefined()
    expect(mode !== undefined && Object.hasOwn(mode, 'oneOf'), `${context}: oneOf must be deleted`).toBe(false)
    expect(mode?.enum, `${context}: enum carries the branch const values in order`).toEqual([
      'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta',
    ])
    // §3.1 type selection: function-typed call named after a custom tool →
    // custom_tool_call; a name declared as BOTH function and custom stays function_call.
    const input = asArray(parsed.input) ?? []
    const items = input.map((item) => asRecord(item))
    const customCall = items.find((item) => asString(item?.type) === 'custom_tool_call' && asString(item?.call_id) === 'call_cst')
    expect(asString(customCall?.name), `${context}: custom_tool_call name`).toBe('cst_lookup')
    expect(asString(customCall?.input), `${context}: custom_tool_call input carries the arguments`).toBe('["x"]')
    const sharedCall = items.find((item) => asString(item?.type) === 'function_call' && asString(item?.call_id) === 'call_shared')
    expect(asString(sharedCall?.name), `${context}: shared name resolves to function_call (function wins)`).toBe('shared_name')
    expect(asString(sharedCall?.arguments), `${context}: function_call arguments`).toBe('{}')
  }
}

// ─── Case runner ─────────────────────────────────────────────────────────────────────

interface CaseMeta {
  readonly case: string
  readonly recorded_at: string
  readonly recorder: string
  readonly version: { readonly image: string; readonly digest: string; readonly commit: string }
  readonly dynamic_fields: readonly string[]
  readonly upstream_wire_lines_per_request: readonly number[]
  readonly files?: readonly string[]
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0)
}

async function replayCase(caseId: CaseId): Promise<void> {
  if (adapterFactory === undefined) throw new Error('adapter factory missing')
  const meta = await readFixtureJson<CaseMeta>(caseId, 'meta.yaml')
  validateDynamicFields(caseId, meta.dynamic_fields)
  const requests = parseRequestBlocks(await readFixtureText(caseId, 'request.http'))
  const responses = parseDownstreamSections(await readFixtureText(caseId, 'downstream.md'))
  const mockFile = await readFixtureJson<MockFile>(caseId, 'mock-response.json')
  const control = mockControl(mockFile, caseId)
  const policy = sessionPolicyFor(caseId)
  const recordedUpstream = (await readFixtureText(caseId, 'upstream.jsonl'))
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as RecordedUpstreamLine)

  expect(requests.length, `S2d5[${caseId}]: meta wire counts must cover every request`).toBe(
    meta.upstream_wire_lines_per_request.length,
  )
  expect(recordedUpstream.length, `S2d5[${caseId}]: recorded upstream lines == sum of per-request counts`).toBe(
    sum(meta.upstream_wire_lines_per_request),
  )

  // Fresh service + fresh store per case; multi-request cases (the S2D5-24 pair) share
  // them WITHIN the case, exactly as the oracle recorded them.
  const service = adapterFactory({
    credentials: [
      {
        apiKey: UPSTREAM_API_KEY,
        baseUrl: UPSTREAM_BASE_URL,
        models: [{ name: UPSTREAM_MODEL, alias: MODEL_ALIAS }],
      },
    ],
    store: new MemoryStore({ now: () => FROZEN_NOW_MS }),
    now: () => FROZEN_NOW_MS,
    requestRetry: 0,
    transientErrorCooldownSeconds: -1,
  })
  if (typeof service.handleChatCompletions !== 'function') {
    throw new Error(`${ADAPTER_EXPORT}() must return an object with a handleChatCompletions(request, send) method`)
  }

  const captured: CapturedUpstreamCall[] = []
  let currentStep = 0
  let currentRequest: ChatRequest | undefined
  const send: UpstreamSender = async (call) => {
    if (currentRequest === undefined) throw new Error(`S2d5[${caseId}]: harness bug — upstream call outside a step`)
    captured.push({ step: currentStep, request: currentRequest, call })
    return buildMockUpstreamResponse(control, mockFile, caseId)
  }

  let wireIndex = 0
  for (const [index, request] of requests.entries()) {
    currentStep = index + 1
    currentRequest = request
    const stepId = `R${currentStep}`
    const expected = responses[stepId]
    if (expected === undefined) throw new Error(`S2d5[${caseId}]: downstream.md is missing section ${stepId}`)
    const callsBefore = captured.length
    const response = await service.handleChatCompletions(request, send)
    await assertDownstreamStep(response, expected, caseId, currentStep)

    const callsThisStep = captured.slice(callsBefore)
    const expectedCalls = meta.upstream_wire_lines_per_request[index] ?? -1
    expect(callsThisStep.length, `S2d5[${caseId}] step ${currentStep}: upstream call count (gateway-local steps call nothing)`).toBe(expectedCalls)
    for (const capturedCall of callsThisStep) {
      const recorded = recordedUpstream[wireIndex]
      wireIndex += 1
      if (recorded === undefined) {
        throw new Error(`S2d5[${caseId}] step ${currentStep}: more upstream calls than recorded wire lines`)
      }
      assertUpstreamWire(recorded, capturedCall, policy, caseId, UPSTREAM_BASE_URL)
      assertUpstreamClauses(caseId, capturedCall)
    }
  }
  expect(captured.length, `S2d5[${caseId}]: total upstream call count`).toBe(recordedUpstream.length)
}

// ─── Suites ──────────────────────────────────────────────────────────────────────────

/** Guards pythonJson byte fidelity: Python json.dumps escapes everything above ASCII. */
function assertAsciiStrings(value: unknown, context: string): void {
  if (typeof value === 'string') {
    for (const character of value) {
      if (character.charCodeAt(0) > 0x7e) {
        throw new Error(`${context}: non-ASCII string breaks mock byte fidelity: ${JSON.stringify(value)}`)
      }
    }
  } else if (Array.isArray(value)) {
    value.forEach((entry, index) => assertAsciiStrings(entry, `${context}[${index}]`))
  } else if (value !== null && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      assertAsciiStrings(entry, `${context}.${key}`)
    }
  }
}

describe('S2d5 fixture inventory (harness self-check, adapter-independent)', () => {
  it('exposes exactly the 26 admitted golden cases, each internally consistent', async () => {
    expect([...fixtureCaseDirs]).toEqual([...EXPECTED_CASES].sort())
    for (const caseId of EXPECTED_CASES) {
      const context = `S2d5[${caseId}]`
      const meta = await readFixtureJson<CaseMeta>(caseId, 'meta.yaml')
      expect(meta.case, `${context}: meta.case echoes the directory name`).toBe(caseId)
      expect(meta.recorder, `${context}: recorder`).toBe('oracle-runner-3')
      expect(meta.version.image, `${context}: version anchor image`).toBe(VERSION_IMAGE)
      expect(meta.version.commit, `${context}: version anchor commit`).toBe(VERSION_COMMIT)
      expect([...(meta.files ?? [])].sort(), `${context}: meta.files matches the layout`).toEqual([...FIXTURE_FILES])
      const directoryEntries = (await readdir(new URL(`${caseId}/`, FIXTURE_ROOT), { withFileTypes: true }))
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .sort()
      expect(directoryEntries, `${context}: fixture directory holds exactly the RECIPES files`).toEqual([...FIXTURE_FILES])
      validateDynamicFields(caseId, meta.dynamic_fields)
      sessionPolicyFor(caseId) // fails loudly if the pin table ever loses a case

      const requests = parseRequestBlocks(await readFixtureText(caseId, 'request.http'))
      const responses = parseDownstreamSections(await readFixtureText(caseId, 'downstream.md'))
      const mockFile = await readFixtureJson<MockFile>(caseId, 'mock-response.json')
      const control = mockControl(mockFile, caseId)
      const mode = control.mode ?? 'happy'
      expect(['happy', 'error', 'disconnect'].includes(mode), `${context}: known mock mode`).toBe(true)
      if (mode === 'error') {
        expect(mockFile.reply?.status, `${context}: error reply status agrees with the control`).toBe(control.status)
        expect(mockFile.reply?.body, `${context}: error reply carries a body`).toBeDefined()
        assertAsciiStrings(mockFile.reply?.body, `${context}: mock reply body`)
      }
      if (control.script !== undefined) {
        expect(mockFile.script, `${context}: script echo agrees with the control`).toBe(control.script)
        const events = scriptEventsOf(mockFile, caseId) // validates the shape
        for (const [index, event] of events.entries()) {
          assertAsciiStrings(event.data, `${context}: script_events[${index}]`)
        }
      }
      if (mode === 'disconnect') {
        expect(Number.isInteger(control.after), `${context}: disconnect control carries an integer "after"`).toBe(true)
      }

      expect(meta.upstream_wire_lines_per_request.length, `${context}: one wire count per request`).toBe(requests.length)
      expect(Object.keys(responses).length, `${context}: one response section per request`).toBe(requests.length)
      for (const [index, request] of requests.entries()) {
        const stepId = `R${index + 1}`
        expect(request.method, `${context} ${stepId}: route method`).toBe('POST')
        expect(request.path, `${context} ${stepId}: route path`).toBe(ROUTE_PATH)
        expect(headerValue(request.headers, 'content-length'), `${context} ${stepId}: body bytes match Content-Length`).toBe(
          String(encoder.encode(request.body).length),
        )
        const clientBody = parseJsonRecord(request.body, `${context} ${stepId}: client body (NE-LENIENT replays are well-formed)`)
        expect(typeof clientBody.model, `${context} ${stepId}: client model is a string`).toBe('string')
        const recorded = responses[stepId]
        if (recorded === undefined) throw new Error(`${context}: downstream.md is missing section ${stepId}`)
        expect(recorded.claimedBodyBytes, `${context} ${stepId}: body bytes match the claimed count`).toBe(
          encoder.encode(recorded.body).length,
        )
        const contentType = headerValue(recorded.headers, 'content-type')
        expect(contentType, `${context} ${stepId}: response head records Content-Type`).toBeDefined()
        expect(
          headerValue(recorded.headers, 'cache-control') !== undefined,
          `${context} ${stepId}: Cache-Control present iff SSE commit`,
        ).toBe(contentType === 'text/event-stream')
      }

      const upstreamLines = (await readFixtureText(caseId, 'upstream.jsonl'))
        .split('\n')
        .filter((line) => line.trim() !== '')
      expect(upstreamLines.length, `${context}: wire line count`).toBe(sum(meta.upstream_wire_lines_per_request))
      for (const [index, line] of upstreamLines.entries()) {
        const recorded = JSON.parse(line) as RecordedUpstreamLine
        expect(
          recorded.headers['Content-Length'],
          `${context} upstream line ${index + 1}: recorded Content-Length matches the body bytes`,
        ).toBe(String(encoder.encode(recorded.body).length))
      }
    }

    for (const [index, event] of DEFAULT_SCRIPT.entries()) {
      expect(event.event.length > 0, `DEFAULT_SCRIPT event ${index}: non-empty event name`).toBe(true)
      assertAsciiStrings(event.data, `DEFAULT_SCRIPT event ${index}`)
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
