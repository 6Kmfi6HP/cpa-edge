/**
 * S2d6 golden contract — Responses client → OpenAI chat (openai-compatibility) upstream.
 *
 * Spec source of truth: spec/sections/S2d6-responses2oai.md (admitted, gate round 3).
 * Goldens: the 27 oracle-recorded fixture cases under tests/fixtures/S2d6/ (CLIProxyAPI
 * v7.3.4, commit 8335eac731946bd4eff18f500653f93736df53d6, deterministic openai mock;
 * recorded by @oracle-runner). Rulings applied: R-SSE (downstream SSE compares as the
 * DECODED event sequence — event name plus data-payload bytes, in order — never raw
 * transport chunk boundaries), R-FIXTURE (all 27 cases are RECORDABLE-LOCALLY
 * Responses-over-openai-compatibility replays; no CREDENTIALED-ONLY behavior is pinned
 * here), NE-LENIENT (every byte-replayed request body is well-formed JSON; the one
 * non-JSON golden, S2d6-badbody-notfound, is a REFERENCE-behavior golden — its replay
 * asserts the strict-400 divergence, never the recorded lenient bytes).
 *
 * R-ORDER is INERT on this direction: the S2d6 reference translator is a deterministic
 * state machine with strict sequence numbers, and the only adjacent same-type frames in
 * the goldens (the reasoning_summary_text.delta pair of S2d6-stream-reasoning, the
 * function_call_arguments.delta fragments of S2d6-stream-toolcalls) are SEQUENTIAL text
 * and JSON fragments whose order is part of the wire contract — swapping them corrupts
 * client-side assembly. Every downstream frame is order-pinned; no canonicalization is
 * applied. R-TOK is not applicable (the Responses inbound surface has no count-tokens
 * route — spec §1 — and no fixture estimates tokens); R-404 and R-BCRYPT are S1/S3-S6
 * territory and are exercised by no fixture here.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * ADAPTER INTERFACE — what the `@cpa-edge/translators/res2oai` direction module MUST
 * export. The suite dynamically imports the package and turns green-to-red once the
 * export ships; until then every case test SKIPS with the reason below. The harness
 * holds its own structural mirror of these types; the package should export the real
 * ones. All shapes are runtime-checked by the suite.
 *
 *   export function createRes2OaiService(options: Res2OaiServiceOptions): Res2OaiService
 *
 *   type HeaderList = ReadonlyArray<readonly [string, string]>   // ordered, original casing
 *
 *   interface Res2OaiModelEntry {         // one model of an openai-compatibility credential
 *     name: string                        // upstream model name (alias-rewrite target)
 *     alias?: string                      // client-facing alias; defaults to `name`
 *   }
 *
 *   interface Res2OaiCredential {          // one openai-compatibility config entry
 *     apiKey: string                      // upstream key → `Authorization: Bearer <apiKey>`
 *     baseUrl: string                     // upstream root, trailing "/" trimmed; upstream
 *                                         // URL = `<baseUrl>/chat/completions`, compact
 *                                         // URL = `<baseUrl>/responses/compact` (spec §2.4/§3.2)
 *     headers?: Readonly<Record<string, string>>
 *                                         // per-credential fixed headers (OPTIONAL; no
 *                                         // golden exercises it)
 *     models: readonly Res2OaiModelEntry[]
 *   }
 *
 *   interface Res2OaiServiceOptions {
 *     apiKeys: readonly string[]           // gateway client keys ("oracle-local-key-1" in
 *                                         // every fixture). The facade owns the recorded
 *                                         // gate slice: no Authorization header → 401
 *                                         // {"error":"Missing API key"} (S2d6-auth-missing);
 *                                         // a present-but-unknown key → the S1
 *                                         // {"error":"Invalid API key"} shape (no golden
 *                                         // pins it here).
 *     credentials: readonly Res2OaiCredential[]
 *                                         // openai-compatibility entries, config order
 *     store: Store                        // from @cpa-edge/core; ALL persistent state (the
 *                                         // ~1s 429 rate-limit cooldown of spec §5.1, which
 *                                         // transientErrorCooldownSeconds: -1 does NOT
 *                                         // disable) flows through it — no facade globals
 *     now?: () => number                  // epoch-ms clock; MUST drive every timing decision
 *     requestRetry?: number               // 0 in every S2d6 fixture (single attempt)
 *     transientErrorCooldownSeconds?: number
 *                                         // -1 in every S2d6 fixture (disables transient
 *                                         // cooldowns only; the rate-limit slice stays ON)
 *   }
 *
 *   interface Res2OaiRequest {
 *     method: string                       // 'POST'
 *     path: string                         // '/v1/responses' | '/v1/responses/compact'
 *                                          // (the /backend-api/codex/responses aliases are
 *                                          // OPTIONAL, unpinned by any golden)
 *     headers: HeaderList                  // client headers, recorded order + casing:
 *                                          // Authorization feeds the 401 gate; User-Agent /
 *                                          // Originator feed the codex-client detection that
 *                                          // selects the `response.failed` failure event
 *                                          // (spec §5.2)
 *     body: string                         // exact request-body bytes
 *   }
 *
 *   interface Res2OaiUpstreamRequest {
 *     method: string                       // 'POST'
 *     url: string                          // absolute `<baseUrl-trimmed>/chat/completions`
 *                                          // or `<baseUrl-trimmed>/responses/compact`
 *     headers: HeaderList                  // emission ORDER is pinned (see below)
 *     body: string
 *   }
 *
 *   interface Res2OaiUpstreamResponse {
 *     status: number
 *     headers: HeaderList
 *     body: ReadableStream<Uint8Array>     // 2xx on streams: SSE bytes; non-2xx and
 *                                          // non-stream: raw reply bytes. A read that
 *                                          // rejects mid-body models an upstream hard
 *                                          // disconnect; the facade maps that failure to
 *                                          // the recorded canonical transport text
 *                                          // "unexpected EOF" (spec §5.2 — same family
 *                                          // ruling as S2d7 §4.4).
 *   }
 *
 *   type Res2OaiUpstreamSender =
 *     (request: Res2OaiUpstreamRequest) => Promise<Res2OaiUpstreamResponse>
 *
 *   interface Res2OaiResponse {
 *     status: number
 *     headers: HeaderList                  // must carry the direction-owned subset (below)
 *     body: string | ReadableStream<Uint8Array>
 *   }
 *
 *   interface Res2OaiService {
 *     handleResponses(
 *       request: Res2OaiRequest,
 *       send: Res2OaiUpstreamSender,
 *     ): Promise<Res2OaiResponse>
 *   }
 *
 * The facade covers the whole pinned direction pipeline: the gateway-key gate (401
 * family), model resolution (unroutable model → 400 model_not_found with the raw
 * body-model string JSON-escaped; empty model → same shape with the empty name — the
 * reference's lenient variant is documented by S2d6-badbody-notfound, which the rewrite
 * preempts with the NE-LENIENT strict 400), the compact stream:true rejection (400, no
 * upstream call), request translation (spec §3.1 whitelist semantics + sjson append
 * order), the upstream wire of §3.2 (URL suffix switch, fixed header set + order,
 * stream_options.include_usage append), non-stream response translation incl. the
 * EnsureResponsesUsageDetails append order (§3.3/§8-4), stream translation (§3.4/§4:
 * state machine, strict sequence numbers, byte-templates, terminal-event suppression,
 * the WriteDone lone \n), and the error semantics of §5 (verbatim non-stream status+body
 * passthrough, the stream pre-frame sanitizer with re-sorted keys, in-stream terminal
 * frames as `event: error` vs `event: response.failed` per client identity, the
 * [DONE]-strictness failure, the conductor `empty_stream` 500 of §5.3, and the 429 →
 * rate-limit-cooldown slice whose state lives in the Store). Internals may compose the
 * openai executor and core scheduling primitives; only this facade is contract.
 *
 * OUT of scope here (owned by S1, asserted by no fixture in this suite): the CORS block,
 * Date emission, Transfer-Encoding, R-404 routing, Content-Encoding zstd handling (spec
 * §2.2; no golden), keep-alive heartbeats (off in the golden configuration), the
 * WebSocket GET upgrade (spec §1), and thinking-suffix model(...) rewriting (spec §8-7).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * HARNESS SEMANTICS
 *
 * • FIXTURE LAYOUT (RECIPES, reports/oracle/BOOTSTRAP.md §7): per case meta.yaml (JSON:
 *   id/purpose/anchor/mock_control/expect_hints/dynamic_fields/http_status/upstream_hits),
 *   request.http (ONE recorded request: request line, head, blank line, body),
 *   downstream.md (`## Status + headers` fence + `## body` or `## full SSE byte stream
 *   (incl. trailing bytes)` fence + `HTTP status:` trailer), upstream.jsonl (ONE JSON line
 *   per upstream request: ts/type/method/path/headers/body/credential/response_status),
 *   mock-response.json (the scripted mock reply — a canned chat completion / compact
 *   reply object, or { events, terminator } for SSE scripts; ABSENT when the case rode
 *   the mock's built-in defaults or its error mode). All files are LF-only and ASCII
 *   (verified by the inventory test; no CRLF normalization happens on read).
 *   Fixture-file convention: the fenced body is the exact body bytes plus ONE trailing
 *   newline; the parser strips exactly that one byte (Content-Length cross-checks it).
 *
 * • ISOLATION + THE 429 PAIR SESSION. Every case replays through a FRESH service + FRESH
 *   MemoryStore, so recording-order constraints (the ~1s rate-limit cooldown) cannot
 *   leak between cases. The ONE deliberate exception is the verbatim-vs-sanitized 429
 *   pair: S2d6-error-nostream-429 then S2d6-error-stream-429 replay back-to-back through
 *   the SAME service + store — one shared session, exactly as the oracle recorded them
 *   (last, with a gap; see CLOCK). A replay that short-circuits the second request into
 *   the model_cooldown 500 fails loudly against the recorded 429 golden.
 *
 * • CLOCK. Real wall-clock time is never consulted. `now()` returns one frozen epoch-ms
 *   constant for every step of every case; the only state that could observe time (the
 *   429 rate-limit cooldown) is exercised exclusively by the pair session, where the
 *   harness advances the frozen clock by +2500 ms between the two steps — mirroring the
 *   recorded ~2.5s gap and staying ABOVE the recorded ~1s cooldown window. Determinism
 *   without masking: no cooldown literal is ever masked.
 *
 * • MOCK UPSTREAM. Each case's scripted behavior resolves from its own files: a
 *   mock-response.json with an `events` array is an SSE script (each event is served as
 *   `data: <python-json>\n\n`; `terminator: "data: [DONE]"` appends the DONE frame);
 *   any other mock-response.json is a canned non-stream reply (served as Python
 *   json.dumps bytes — the recorded verbatim 429 passthrough depends on that spacing).
 *   Cases without mock-response.json derive from meta.yaml mock_control: variant
 *   `default` → the DEFAULT non-stream reply; `default-stream-done` /
 *   `default-stream-nodone` → the DEFAULT SSE script (with / without the DONE frame);
 *   mode `error` → the recorded 429 (status + the five-key error body whose bytes the
 *   non-stream golden pins verbatim); mode `slow` replays the DEFAULT script with NO
 *   delays (inter-event timing is a recording-only dynamic field — meta declares it, the
 *   golden is byte-equality with S2d6-stream-basic). The DEFAULT scripts are READ from
 *   the sibling fixtures that pin them (S2d6-nostream-basic / S2d6-stream-basic
 *   mock-response.json) so the transcription cannot drift; the inventory asserts those
 *   anchors. mode `disconnect` serves the DEFAULT SSE script and hard-aborts the read
 *   after `after` served frames ("hard TCP close, no chunked terminator" — a rejected
 *   read). The read error text is harness-owned and intentionally generic: the facade
 *   must surface the canonical "unexpected EOF", never echo transport text.
 *
 * • Upstream calls are captured per case; after the case the captured count must equal
 *   meta.yaml `upstream_hits` — this pins "no upstream call" for the gateway-local
 *   cases (auth-missing, model-notfound, badbody-notfound, compact-stream-rejected) —
 *   and the captured sequence must equal the recorded upstream.jsonl lines (count +
 *   bytes). The scripted mock reply's status must also equal the recorded wire line's
 *   `response_status`.
 *
 * • CLAUSE LAYER. On top of the byte golds, the captured wire and the produced
 *   downstream surface are checked against the semantic MUSTs that masking or byte
 *   equality alone would hide as unreadable failures: the resolved-model rewrite (never
 *   the alias), the stream wire shape (stream_options appended LAST, include_usage,
 *   SSE Accept/Cache-Control), the non-stream shape (no stream_options, no SSE headers),
 *   the compact stream-key deletion, the §3.1 whitelist drops, the model-echo asymmetry
 *   on both paths, the usage key orders on both paths, and the failure-frame
 *   sequence-number == data-frame-count rule. These clauses restate spec §2-§5 in
 *   readable failures; they never loosen the byte gold.
 *
 * • DERIVED TESTS (clearly labeled — no golden exists): spec §3.5 pins, source-cited,
 *   that an upstream usage carrying reasoning tokens > 0 makes the stream terminal event
 *   write `output_tokens_details.reasoning_tokens` BEFORE `total_tokens`, with
 *   EnsureResponsesUsageDetails then finding both detail objects present and appending
 *   NOTHING; §3.3 pins the non-stream analogue (translator position before `total`,
 *   only `input_tokens_details` appended after). The two derived cases replay the
 *   S2d6-nostream-basic / S2d6-stream-usage-incomplete fixtures with the mock usage
 *   extended by `output_tokens_details.reasoning_tokens: 4` and compare the full
 *   downstream surface against the recorded body with exactly the usage object swapped
 *   (spec §6 records them as unit-test level for implementers; this suite pins them so
 *   the divergence cannot regress silently).
 *
 * • S2d6-badbody-notfound replay: NE-LENIENT divergence pin — status 400, JSON
 *   `invalid_request_error` body, zero upstream calls, and NOT the reference's lenient
 *   `model_not_found` bytes (which stay pinned in the fixture by the inventory test as
 *   reference documentation, including the trailing-space empty-model message).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * COMPARISON RULES
 *
 * Upstream wire (primary gold):
 *   - method, url (`http://host.docker.internal:18999` + the recorded wire path — the
 *     adapter's baseUrl is the recording config's `.../v1` root and the §2.4/§3.2
 *     suffix rules produce exactly that URL), body: byte-exact. The canonical field
 *     order of §3.1 (model, messages, stream, then the appended optional fields, then
 *     stream_options), the verbatim raw-JSON passthrough of `parameters`, the tool-name
 *     qualification, and the compact passthrough (client field order, model rewritten,
 *     stream key deleted) are all pinned by this single comparison.
 *   - headers: the full ordered list, names case-preserved, pinned to the recorded wire
 *     order, which differs by mode: non-stream [Host, User-Agent, Content-Length,
 *     Authorization, Content-Type, Accept-Encoding]; stream [Host, User-Agent,
 *     Content-Length, Accept, Authorization, Cache-Control, Content-Type,
 *     Accept-Encoding]. The header ORDER also pins the client-header whitelist — nothing
 *     the client sent beyond the fixed set reaches the upstream. `Content-Length` is
 *     excluded from the ordered compare and instead consistency-checked (if the adapter
 *     emits it, it must equal the body byte length). `Authorization` is redacted in the
 *     recordings; the adapter's value must start with "Bearer " and is normalized to
 *     "<redacted>". The `Host` port is masked per meta.yaml (`:<PORT>`). Recording-only
 *     `ts`/`type`/`credential`/`response_status` fields of upstream.jsonl are not wire
 *     (response_status is cross-checked against the scripted reply instead).
 *
 * Downstream (per case, one response):
 *   - status: exact. Body: byte-exact after masking — SSE bodies compare per R-SSE as
 *     DECODED (event name + data payload) sequences, PLUS the §4.1 framing layer: every
 *     event is exactly `event: <type>\ndata: <json>\n\n` (single space after each colon,
 *     LF endings), no `id:`/`retry:` lines, terminal failure frames carry ONE leading
 *     `\n`, a clean close appends the WriteDone lone `\n` (the body ends
 *     `data: {...}\n\n\n`), an error close does not, and there is NO `data: [DONE]`
 *     downstream. Events after the first terminal event must be dropped. JSON bodies
 *     compare byte-exact.
 *   - headers: only the direction-owned subset is asserted: Content-Type (exact,
 *     including the recorded `application/json; charset=utf-8` middleware variants);
 *     Cache-Control and Connection (exact recorded values on SSE-committed responses,
 *     ABSENT otherwise — pins "no SSE headers before commit" for the pre-frame
 *     failures: error-stream-429, stream-empty200, and the JSON 400/401 family);
 *     X-Cpa-Trace-Id — PRESENCE ONLY, matching the recorded head (the recorded
 *     absences are auth-missing, model-notfound, badbody-notfound and
 *     compact-stream-rejected — the gateway-local middleware surfaces; the suite pins
 *     that the adapter mirrors them instead of papering over them).
 *   - `Date`, `Content-Length`, `Transfer-Encoding` and the CORS block are S1/transport
 *     territory and are not compared (Content-Length is consistency-checked when the
 *     adapter emits it; the recorded Content-Length is verified against the recorded
 *     body bytes by the inventory).
 *
 * MASKS — applied identically to recorded and produced bytes, derived from each case's
 * meta.yaml `dynamic_fields` (unknown entries fail the suite loudly):
 *   - Date: response-header only; never compared (no mask needed on bodies — the only
 *     date-like value, `created_at`, is a canned mock constant, byte-pinned).
 *   - X-Cpa-Trace-Id: presence-only comparison (see above).
 *   - Host/port numbers: the upstream wire-log `Host` port suffix (`:18999`) → `:<PORT>`
 *     on both sides. The client-request Host and the base-url port are harness constants.
 *   - error.message if transport-prefixed (disconnect cases only): the recorded canonical
 *     transport-failure text is `unexpected EOF` (byte-pinned — it does NOT match the
 *     transport-prefix pattern). A surfaced message that carries a volatile transport
 *     prefix (socket-pair text like `read tcp ...`, `socket hang up`, `ECONNRESET`, ...)
 *     is masked to `<TRANSPORT-ERROR>` on both sides, exactly the allowance meta.yaml
 *     declares. Anything else fails.
 *   - inter-event timing (stream-slow): recorded in meta only; never compared — the
 *     slow golden is byte-equality with S2d6-stream-basic, asserted by the inventory.
 *   - NOT masked anywhere: sequence numbers (strict +1 per translated event; failure
 *     frames re-emit the data-frame count — deterministic from the canned scripts),
 *     `created_at` (canned), usage shapes and their key orders, model names, the
 *     cooldown-independent error messages, and every status code.
 */
import { readdir, readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { MemoryStore } from '@cpa-edge/core'
import type { Store } from '@cpa-edge/core'

// ─── Adapter load (skip-with-explanation until the real export ships) ────────────────

const ADAPTER_MODULE = '@cpa-edge/translators/res2oai'
const ADAPTER_EXPORT = 'createRes2OaiService'

/** Structural mirror of the adapter interface documented in the header. */
type HeaderList = ReadonlyArray<readonly [string, string]>

interface ModelEntry {
  readonly name: string
  readonly alias?: string
}

interface CredentialConfig {
  readonly apiKey: string
  readonly baseUrl: string
  readonly headers?: Readonly<Record<string, string>>
  readonly models: readonly ModelEntry[]
}

interface ServiceOptions {
  readonly apiKeys: readonly string[]
  readonly credentials: readonly CredentialConfig[]
  readonly store: Store
  readonly now: () => number
  readonly requestRetry: number
  readonly transientErrorCooldownSeconds: number
}

interface ResponsesRequest {
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

interface ResponsesServiceResponse {
  readonly status: number
  readonly headers: HeaderList
  readonly body: string | ReadableStream<Uint8Array>
}

interface ResponsesService {
  handleResponses(request: ResponsesRequest, send: UpstreamSender): Promise<ResponsesServiceResponse>
}

type AdapterFactory = (options: ServiceOptions) => ResponsesService

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
        'All 27 S2d6 golden cases SKIP until the res2oai adapter ships; the required interface is documented in the header of this file.',
    }
  } catch (error) {
    return { skipReason: `import of \`${ADAPTER_MODULE}\` failed: ${String(error)}` }
  }
}

const adapterLoad = await loadAdapter()
const adapterFactory = adapterLoad.factory
const suite = adapterFactory ? describe : describe.skip
const suiteTitle = adapterFactory
  ? 'S2d6 — res2oai golden contract (recorded fixtures)'
  : `S2d6 — res2oai golden contract (SKIPPED: ${adapterLoad.skipReason ?? 'adapter unavailable'})`

// ─── Fixture access ───────────────────────────────────────────────────────────────────

const FIXTURE_ROOT = new URL('../fixtures/S2d6/', import.meta.url)

/** One frozen epoch-ms instant (see header: CLOCK). */
const FROZEN_NOW_MS = 1_789_504_600_000
/** Clock advance between the two 429 pair steps (recorded gap ~2.5s > the ~1s window). */
const PAIR_GAP_MS = 2_500

/** Recording-instance values, transcribed from each meta.yaml / the recording config. */
const GATEWAY_API_KEY = 'oracle-local-key-1'
const UPSTREAM_API_KEY = 'mock-upstream-key' // recorded as `credential`, redacted on the wire
const UPSTREAM_ORIGIN = 'http://host.docker.internal:18999'
/** The openai-compatibility `base-url` of the recording config, trailing "/" trimmed. */
const UPSTREAM_BASE_URL = `${UPSTREAM_ORIGIN}/v1`
const UPSTREAM_MODEL = 'mock-gpt-model'
const MODEL_ALIAS = 'mock-model'
const UPSTREAM_USER_AGENT = 'cli-proxy-openai-compat'
const VERSION_IMAGE = 'eceasy/cli-proxy-api:v7.3.4'
const VERSION_COMMIT = '8335eac731946bd4eff18f500653f93736df53d6'
const RESPONSES_PATH = '/v1/responses'
const RESPONSES_COMPACT_PATH = '/v1/responses/compact'
const CHAT_WIRE_PATH = '/v1/chat/completions'

const EXPECTED_CASES = [
  'S2d6-auth-missing',
  'S2d6-badbody-notfound',
  'S2d6-compact-passthrough',
  'S2d6-compact-stream-rejected',
  'S2d6-compact-streamfalse',
  'S2d6-error-nostream-429',
  'S2d6-error-stream-429',
  'S2d6-model-notfound',
  'S2d6-nostream-basic',
  'S2d6-nostream-custom-tool',
  'S2d6-nostream-image',
  'S2d6-nostream-incomplete',
  'S2d6-nostream-namespace-tool',
  'S2d6-nostream-reasoning',
  'S2d6-nostream-roles',
  'S2d6-nostream-string-input',
  'S2d6-nostream-tool-roundtrip',
  'S2d6-stream-basic',
  'S2d6-stream-closeterminal',
  'S2d6-stream-disconnect',
  'S2d6-stream-disconnect-codex',
  'S2d6-stream-empty200',
  'S2d6-stream-nodone',
  'S2d6-stream-reasoning',
  'S2d6-stream-slow',
  'S2d6-stream-toolcalls',
  'S2d6-stream-usage-incomplete',
] as const

type CaseId = (typeof EXPECTED_CASES)[number]

/**
 * Cases that replay standalone against their recorded golden. The two 429 cases are
 * excluded (they replay together through ONE shared session — see header: ISOLATION) as
 * is S2d6-badbody-notfound (the NE-LENIENT divergence replay).
 */
const REPLAY_CASES: readonly CaseId[] = EXPECTED_CASES.filter(
  (caseId) =>
    caseId !== 'S2d6-badbody-notfound' &&
    caseId !== 'S2d6-error-nostream-429' &&
    caseId !== 'S2d6-error-stream-429',
)

const fixtureCaseDirs = (await readdir(FIXTURE_ROOT, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()

function caseFile(caseId: string, name: string): URL {
  return new URL(`${caseId}/${name}`, FIXTURE_ROOT)
}

async function readFixtureText(caseId: string, name: string): Promise<string> {
  const raw = await readFile(caseFile(caseId, name), 'utf8')
  if (raw.includes('\r')) {
    throw new Error(`S2d6[${caseId}]: fixture file ${name} carries CR bytes — expected LF-only recordings`)
  }
  return raw
}

async function readFixtureJson<T>(caseId: string, name: string): Promise<T> {
  return JSON.parse(await readFixtureText(caseId, name)) as T
}

async function fixtureFileExists(caseId: string, name: string): Promise<boolean> {
  const entries = await readdir(new URL(`${caseId}/`, FIXTURE_ROOT), { withFileTypes: true })
  return entries.some((entry) => entry.isFile() && entry.name === name)
}

// ─── Fixture file parsers (request.http / downstream.md / upstream.jsonl / meta.yaml) ─

interface RecordedRequest {
  readonly method: string
  readonly path: string
  readonly headers: HeaderList
  readonly body: string
}

/**
 * request.http holds ONE recorded request: request line, head lines, a blank separator,
 * then the exact body bytes. The file's body is preceded by one extra `\n` and followed
 * by the file's final newline; the parser strips exactly those (the recorded
 * Content-Length cross-check validates the result).
 */
function parseRequestFile(text: string): RecordedRequest {
  const separator = text.indexOf('\n\n')
  if (separator < 0) throw new Error('request.http has no head/body separator')
  const head = text.slice(0, separator)
  let body = text.slice(separator + 2)
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
}

interface RecordedResponse {
  readonly status: number
  readonly headers: HeaderList
  readonly body: string
  readonly bodySectionTitle: string
}

/**
 * downstream.md: a `## Status + headers` fence (status line + head, ending at its blank
 * line) and a body fence under `## body` or `## full SSE byte stream (incl. trailing
 * bytes)` — the title is recording prose, NOT a content-type signal (error-mode cases
 * reuse the SSE title for JSON bodies) — plus an `HTTP status:` trailer. The fenced
 * content is the exact body bytes plus ONE writer-added trailing newline; the parser
 * strips exactly that one byte (the recorded Content-Length cross-checks it).
 */
function parseDownstreamFile(text: string): RecordedResponse {
  const headMatch = /## Status \+ headers\n```\n(HTTP\/1\.1[^\n]*)\n([\s\S]*?)\n```/.exec(text)
  if (headMatch === null) throw new Error('downstream.md is missing the status + headers fence')
  const status = Number((headMatch[1] ?? '').split(' ')[1])
  if (!Number.isInteger(status) || status <= 0) {
    throw new Error(`downstream.md has an unparsable status line ${headMatch[1] ?? ''}`)
  }
  const headers: Array<[string, string]> = []
  for (const line of (headMatch[2] ?? '').split('\n')) {
    if (line === '') break
    const colon = line.indexOf(': ')
    if (colon <= 0) continue
    headers.push([line.slice(0, colon), line.slice(colon + 2)])
  }

  const bodyMatch =
    /## (body|full SSE byte stream \(incl\. trailing bytes\))\n```\n([\s\S]*?)\n```\n\nHTTP status: (\d+)/.exec(text)
  if (bodyMatch === null) throw new Error('downstream.md is missing the body fence + HTTP status trailer')
  let body = bodyMatch[2] ?? ''
  if (!body.endsWith('\n')) {
    throw new Error('downstream.md body fence must end with the writer-added trailing newline')
  }
  body = body.slice(0, -1)
  const trailerStatus = Number(bodyMatch[3])
  if (trailerStatus !== status) {
    throw new Error(`downstream.md status ${status} disagrees with the HTTP status trailer ${trailerStatus}`)
  }
  return { status, headers, body, bodySectionTitle: bodyMatch[1] ?? '' }
}

/** One upstream.jsonl wire line (RECIPES layout: one JSON object per upstream request). */
interface WireLine {
  readonly method: string
  readonly path: string
  readonly headers: Record<string, string>
  readonly body: string
  readonly credential: string
  readonly responseStatus: number
}

function parseWireLines(text: string): readonly WireLine[] {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const parsed: unknown = JSON.parse(line)
      const record = asRecordOrThrow(parsed, 'upstream.jsonl line')
      return {
        method: stringField(record, 'method', 'upstream.jsonl'),
        path: stringField(record, 'path', 'upstream.jsonl'),
        headers: recordOf(record.headers, 'upstream.jsonl headers'),
        body: stringField(record, 'body', 'upstream.jsonl'),
        credential: stringField(record, 'credential', 'upstream.jsonl'),
        responseStatus: numberField(record, 'response_status', 'upstream.jsonl'),
      }
    })
}

interface MockControl {
  readonly mode?: string
  readonly variant?: string
  readonly after?: number
  readonly status?: number
  readonly delayMs?: number
  readonly errorBody?: unknown
  readonly cannedNonstream?: unknown
  readonly cannedSse?: unknown
  readonly route?: string
}

interface CaseMeta {
  readonly id: string
  readonly purpose: string
  readonly anchor: string
  readonly recorded_at: string
  readonly record: string
  readonly mock_control: MockControl
  readonly expect_hints: Record<string, unknown>
  readonly dynamic_fields: readonly string[]
  readonly http_status: number | string
  readonly upstream_hits: number
}

async function readCaseMeta(caseId: string): Promise<CaseMeta> {
  const meta = await readFixtureJson<CaseMeta>(caseId, 'meta.yaml')
  const record = asRecordOrThrow(meta, 'meta.yaml')
  if (typeof record.mock_control !== 'object' || record.mock_control === null) {
    throw new Error(`S2d6[${caseId}]: meta.yaml mock_control must be an object`)
  }
  const control = record.mock_control as Record<string, unknown>
  const cannedSse = asRecord(control.canned_sse)
  const cannedNonstream = control.canned_nonstream
  return {
    ...meta,
    mock_control: {
      mode: asString(control.mode),
      variant: asString(control.variant),
      after: asOptionalNumber(control.after),
      status: asOptionalNumber(control.status),
      delayMs: asOptionalNumber(control.delay_ms),
      errorBody: control.error_body,
      cannedNonstream,
      cannedSse,
      route: asString(control.route),
    },
  }
}

// ─── JSON narrowing helpers (no `any`, strict-safe) ──────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function asRecordOrThrow(value: unknown, context: string): Record<string, unknown> {
  const record = asRecord(value)
  if (record === undefined) throw new Error(`${context}: expected a JSON object`)
  return record
}

function asArray(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) ? value : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function recordOf(value: unknown, context: string): Record<string, string> {
  const record = asRecordOrThrow(value, context)
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry !== 'string') throw new Error(`${context}: header ${key} must be a string`)
    out[key] = entry
  }
  return out
}

function stringField(record: Record<string, unknown>, key: string, context: string): string {
  const value = record[key]
  if (typeof value !== 'string') throw new Error(`${context}: field ${key} must be a string`)
  return value
}

function numberField(record: Record<string, unknown>, key: string, context: string): number {
  const value = record[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${context}: field ${key} must be a number`)
  }
  return value
}

function parseJsonRecord(text: string, context: string): Record<string, unknown> {
  return asRecordOrThrow(JSON.parse(text), `${context} (expected a JSON object)`)
}

// ─── Masking (meta.yaml dynamic_fields → policy) ─────────────────────────────────────

/** meta.yaml dynamic_fields entries this harness recognizes; anything else fails loudly. */
const RECOGNIZED_DYNAMIC_FIELDS: ReadonlySet<string> = new Set([
  'Date',
  'X-Cpa-Trace-Id',
  'Host/port numbers',
  "error.message if transport-prefixed (e.g. 'read tcp ...')",
  'error.message if transport-prefixed',
  'inter-event timing',
])

function validateDynamicFields(caseId: string, dynamicFields: readonly string[]): void {
  for (const field of dynamicFields) {
    if (!RECOGNIZED_DYNAMIC_FIELDS.has(field)) {
      throw new Error(
        `S2d6[${caseId}]: unrecognized meta.yaml dynamic_fields entry ${JSON.stringify(field)} — ` +
          'extend the mask table in tests/contract/s2d6-res2oai.test.ts consciously',
      )
    }
  }
}

const HOST_PORT_RE = /:\d+$/

/**
 * The volatile-transport-text allowance the disconnect metas declare: socket-pair /
 * errno-prefixed messages are masked on both sides. The recorded canonical text
 * "unexpected EOF" does NOT match and stays byte-pinned.
 */
const TRANSPORT_PREFIX_RE =
  /^((read|write|dial)\s+(tcp|udp)|socket\s|connection\s+(reset|closed|aborted|refused)|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|ENOTFOUND|fetch failed|network error)/

const MESSAGE_FIELD_RE = /"message":"((?:[^"\\]|\\.)*)"/

function maskFailureFrameData(data: string, context: string): string {
  const match = MESSAGE_FIELD_RE.exec(data)
  if (match === null) {
    throw new Error(`${context}: failure frame data carries no message field to mask-check`)
  }
  const message = match[1] ?? ''
  if (!TRANSPORT_PREFIX_RE.test(message)) return data
  return data.replace(MESSAGE_FIELD_RE, '"message":"<TRANSPORT-ERROR>"')
}

function normalizeUpstreamHeaderValue(name: string, value: string): string {
  if (name.toLowerCase() === 'host') return value.replace(HOST_PORT_RE, ':<PORT>')
  return value
}

// ─── Mock upstream: canned scripts, python-json bytes, scripted streams ──────────────

/** Serializes like Python's json.dumps defaults — the recorded verbatim 429 passthrough bytes depend on that spacing. */
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
 * Demand-driven byte stream: every pull hands out one chunk; the read after the last
 * chunk closes normally, or errors once `abortAfter` chunks were served (upstream
 * hard disconnect — the rejection models a TCP close without a chunked terminator).
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

/**
 * The mock's served 429 reply — the five-key error body whose Python-dumps bytes the
 * non-stream golden passes downstream VERBATIM (fixture-derived: S2d6-error-nostream-429
 * recorded body == pythonJson(this); the inventory test pins that equality).
 */
const RATE_LIMIT_429_BODY: Record<string, unknown> = {
  error: {
    message: 'mock rate limit',
    type: 'rate_limit_exceeded',
    code: 429,
    status: 'RESOURCE_EXHAUSTED',
  },
}

/** The mock's built-in default non-stream reply, anchored by S2d6-nostream-basic's mock-response.json. */
const DEFAULT_NONSTREAM_REPLY: unknown = await readFixtureJson<unknown>('S2d6-nostream-basic', 'mock-response.json')

interface StreamScript {
  readonly events: readonly unknown[]
  readonly terminator: string | null
}

/** The mock's built-in default SSE script, anchored by S2d6-stream-basic's mock-response.json. */
const DEFAULT_STREAM_SCRIPT: StreamScript = await readFixtureJson<StreamScript>('S2d6-stream-basic', 'mock-response.json')

/** The one scripted upstream behavior a case drives. */
type MockScript =
  | { readonly kind: 'nonstream'; readonly reply: unknown }
  | { readonly kind: 'stream'; readonly script: StreamScript; readonly abortAfter?: number }
  | { readonly kind: 'error'; readonly status: number; readonly body: unknown }

/**
 * Resolves the scripted upstream behavior per case: the case's own mock-response.json
 * when it has one (an `events` array = SSE script; anything else = canned non-stream
 * reply), else the meta.yaml mock_control derivation (default / default-stream-done /
 * default-stream-nodone variants ride the mock's built-in defaults; error mode serves
 * the recorded 429; disconnect mode rides the default SSE script and hard-aborts after
 * `after` frames). Unknown derivations fail loudly.
 */
async function resolveMockScript(
  caseId: CaseId,
): Promise<{ readonly script: MockScript; readonly control: MockControl; readonly scripted: boolean }> {
  const meta = await readCaseMeta(caseId)
  const control = meta.mock_control
  const mode = control.mode ?? 'happy'

  if (await fixtureFileExists(caseId, 'mock-response.json')) {
    const mockFile = asRecordOrThrow(
      await readFixtureJson<unknown>(caseId, 'mock-response.json'),
      `${caseId} mock-response.json`,
    )
    const events = asArray(mockFile.events)
    if (events !== undefined) {
      const terminator = asString(mockFile.terminator)
      const abortAfter = mode === 'disconnect' ? control.after : undefined
      if (abortAfter !== undefined && (!Number.isInteger(abortAfter) || abortAfter < 0)) {
        throw new Error(`S2d6[${caseId}]: disconnect control must carry a non-negative integer "after"`)
      }
      return { script: { kind: 'stream', script: { events, terminator }, abortAfter }, control, scripted: true }
    }
    return { script: { kind: 'nonstream', reply: mockFile }, control, scripted: true }
  }

  if (mode === 'error') {
    if (control.status !== 429) {
      throw new Error(`S2d6[${caseId}]: only the recorded 429 error mode exists (got status ${String(control.status)})`)
    }
    return { script: { kind: 'error', status: 429, body: RATE_LIMIT_429_BODY }, control, scripted: false }
  }

  const variant = control.variant
  if (variant === 'default') {
    return { script: { kind: 'nonstream', reply: DEFAULT_NONSTREAM_REPLY }, control, scripted: false }
  }
  if (variant === 'default-stream-done') {
    return { script: { kind: 'stream', script: DEFAULT_STREAM_SCRIPT }, control, scripted: false }
  }
  if (variant === 'default-stream-nodone') {
    return { script: { kind: 'stream', script: { events: DEFAULT_STREAM_SCRIPT.events, terminator: null } }, control, scripted: false }
  }
  if (mode === 'disconnect' || mode === 'slow') {
    throw new Error(`S2d6[${caseId}]: mode ${mode} must name a default stream variant`)
  }
  throw new Error(
    `S2d6[${caseId}]: no mock-response.json and no derivable control (mode ${JSON.stringify(mode)}, variant ${JSON.stringify(variant)})`,
  )
}

interface MockUpstreamResponse {
  readonly response: UpstreamResponse
  readonly status: number
}

function buildMockUpstreamResponse(script: MockScript, caseId: string): MockUpstreamResponse {
  const encoder = new TextEncoder()
  if (script.kind === 'error') {
    return {
      status: script.status,
      response: {
        status: script.status,
        headers: [['Content-Type', 'application/json']],
        body: scriptedByteStream([encoder.encode(pythonJson(script.body))]),
      },
    }
  }
  if (script.kind === 'nonstream') {
    return {
      status: 200,
      response: {
        status: 200,
        headers: [['Content-Type', 'application/json']],
        body: scriptedByteStream([encoder.encode(pythonJson(script.reply))]),
      },
    }
  }
  const chunks: Uint8Array[] = []
  for (const event of script.script.events) {
    chunks.push(encoder.encode(`data: ${pythonJson(event)}\n\n`))
  }
  if (script.script.terminator !== null && script.script.terminator !== undefined && script.script.terminator !== '') {
    chunks.push(encoder.encode(`${script.script.terminator}\n\n`))
  }
  return {
    status: 200,
    response: {
      status: 200,
      headers: [['Content-Type', 'text/event-stream']],
      body: scriptedByteStream(chunks, script.abortAfter),
    },
  }
}
