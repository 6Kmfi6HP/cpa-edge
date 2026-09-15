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
const VERSION_TAG = 'CLIProxyAPI v7.3.4'
const VERSION_COMMIT = '8335eac731946bd4eff18f500653f93736df53d6'
const VERSION_IMAGE_DIGEST = 'sha256:97825da3009f98acf78b5c172fde650a5fbe7a690950a69ce6d7b535d77d4266'
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
      const terminator = asString(mockFile.terminator) ?? null
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

// ─── Comparison helpers ──────────────────────────────────────────────────────────────

function headerValue(headers: HeaderList, name: string): string | undefined {
  const key = name.toLowerCase()
  for (const [headerName, value] of headers) {
    if (headerName.toLowerCase() === key) return value
  }
  return undefined
}

async function readResponseBody(body: ResponsesServiceResponse['body']): Promise<string> {
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

const encoder = new TextEncoder()

function truncate(text: string): string {
  return text.length > 200 ? `${text.slice(0, 200)}…` : text
}

// ─── Downstream SSE: framing decoder + R-SSE frame comparison ───────────────────────

/** Terminal event names of the downstream Responses stream (spec §4.1/§4.3/§5.2). */
const TERMINAL_EVENT_NAMES: ReadonlySet<string> = new Set([
  'response.completed',
  'response.incomplete',
  'response.failed',
  'error',
])

/** In-stream failure events (spec §5.2): the only frames allowed a leading `\n`. */
const FAILURE_EVENT_NAMES: ReadonlySet<string> = new Set(['response.failed', 'error'])

interface SseFrame {
  readonly event: string
  readonly data: string
}

interface DecodedSse {
  readonly frames: readonly SseFrame[]
  /** Per frame: was it preceded by the §5.2 leading `\n` (failure frames only). */
  readonly failureLead: readonly boolean[]
  /** The §4.1 WriteDone lone `\n` after the last frame (clean closes only). */
  readonly trailingWriteDone: boolean
}

/**
 * Decodes a downstream SSE body under the §4.1 byte rules and enforces the framing
 * template while decoding: every event is exactly `event: <type>\ndata: <json>\n\n`
 * (single space after each colon, LF endings, no id:/retry: lines, no multi-line
 * blocks), `data: [DONE]` never appears, terminal failure frames carry exactly one
 * leading `\n`, no other frame does, nothing follows the first terminal event, and
 * the only allowed trailing byte is the clean-close WriteDone `\n`.
 */
function decodeDownstreamSse(body: string, context: string): DecodedSse {
  const blocks = body.split('\n\n')
  const tail = blocks.pop()
  if (tail !== undefined && tail !== '' && tail !== '\n') {
    throw new Error(
      `${context}: the body must end with a frame terminator (+ the WriteDone \\n on a clean close); found trailing ${JSON.stringify(tail)}`,
    )
  }
  const frames: SseFrame[] = []
  const failureLead: boolean[] = []
  let terminalSeen = false
  for (const block of blocks) {
    let text = block
    const lead = text.startsWith('\n')
    if (lead) text = text.slice(1)
    const lines = text.split('\n')
    const eventLine = lines[0] ?? ''
    const dataLine = lines[1] ?? ''
    if (lines.length !== 2 || !eventLine.startsWith('event: ') || !dataLine.startsWith('data: ')) {
      throw new Error(
        `${context}: every downstream event must be exactly \`event: <type>\\ndata: <json>\` ` +
          `(single space after each colon, no id:/retry: lines) — found ${JSON.stringify(text.slice(0, 80))}`,
      )
    }
    const event = eventLine.slice('event: '.length)
    const data = dataLine.slice('data: '.length)
    if (data === '[DONE]') {
      throw new Error(`${context}: a data: [DONE] frame must never appear downstream (§4.1 — the terminal marker is the completed/incomplete event)`)
    }
    if (terminalSeen) {
      throw new Error(`${context}: events after the terminal event must be dropped (§4.1) — found ${event}`)
    }
    if (FAILURE_EVENT_NAMES.has(event) && !lead) {
      throw new Error(`${context}: the terminal failure frame must be written after one leading \\n (§5.2)`)
    }
    if (lead && !FAILURE_EVENT_NAMES.has(event)) {
      throw new Error(`${context}: only terminal failure frames may carry the leading \\n — found on ${event}`)
    }
    terminalSeen = TERMINAL_EVENT_NAMES.has(event)
    frames.push({ event, data })
    failureLead.push(lead)
  }
  return { frames, failureLead, trailingWriteDone: tail === '\n' }
}

/** Order-pinned (event name + data bytes) comparison (R-ORDER is inert — see header). */
function expectDecodedSse(actual: DecodedSse, expected: DecodedSse, context: string): void {
  if (actual.frames.length !== expected.frames.length) {
    let difference = 'one side is empty'
    const count = Math.min(actual.frames.length, expected.frames.length)
    for (let index = 0; index < count; index += 1) {
      if (actual.frames[index]?.event !== expected.frames[index]?.event || actual.frames[index]?.data !== expected.frames[index]?.data) {
        difference =
          `frame ${index}: recorded ${truncate(`${expected.frames[index]?.event ?? ''} | ${expected.frames[index]?.data ?? ''}`)} ` +
          `vs produced ${truncate(`${actual.frames[index]?.event ?? ''} | ${actual.frames[index]?.data ?? ''}`)}`
        break
      }
    }
    if (difference === 'one side is empty' && count > 0) difference = `common prefix of ${count} frames matches`
    throw new Error(`${context}: decoded SSE frame count ${actual.frames.length} != recorded ${expected.frames.length}. ${difference}`)
  }
  for (let index = 0; index < expected.frames.length; index += 1) {
    const expectedFrame = expected.frames[index]
    const actualFrame = actual.frames[index]
    if (expectedFrame === undefined || actualFrame === undefined) continue
    let expectedData = expectedFrame.data
    let actualData = actualFrame.data
    if (FAILURE_EVENT_NAMES.has(expectedFrame.event)) {
      expectedData = maskFailureFrameData(expectedData, context)
      actualData = maskFailureFrameData(actualData, context)
    }
    expect(actualFrame.event, `${context}: SSE frame ${index} event name`).toBe(expectedFrame.event)
    expect(actualData, `${context}: SSE frame ${index} data bytes`).toBe(expectedData)
  }
  expect(actual.failureLead, `${context}: failure frames must carry the §5.2 leading \\n exactly where recorded`).toEqual(
    expected.failureLead,
  )
  expect(
    actual.trailingWriteDone,
    `${context}: the clean-close WriteDone trailing \\n (§4.1) must appear exactly where recorded`,
  ).toBe(expected.trailingWriteDone)
}

// ─── Upstream wire comparison (primary gold) ─────────────────────────────────────────

interface CapturedUpstreamCall {
  readonly request: ResponsesRequest
  readonly call: UpstreamRequest
}

function assertUpstreamWire(recorded: WireLine, captured: CapturedUpstreamCall, caseId: string): void {
  const context = `S2d6[${caseId}] upstream wire`
  expect(captured.call.method, `${context}: method`).toBe(recorded.method)
  expect(captured.call.url, `${context}: url (origin + recorded wire path; §2.4/§3.2 suffix rules)`).toBe(
    `${UPSTREAM_ORIGIN}${recorded.path}`,
  )

  const expectedPairs: Array<[string, string]> = []
  for (const [name, value] of Object.entries(recorded.headers)) {
    if (name.toLowerCase() === 'content-length') continue // transport-derived; consistency-checked below
    expectedPairs.push([name, normalizeUpstreamHeaderValue(name, value)])
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
    actualPairs.push([name, normalizeUpstreamHeaderValue(name, value)])
  }
  expect(actualPairs, `${context}: header list (order + names + values)`).toEqual(expectedPairs)
  if (actualContentLength !== undefined) {
    expect(actualContentLength, `${context}: Content-Length must match the body byte length`).toBe(
      String(encoder.encode(captured.call.body).length),
    )
  }
  expect(captured.call.body, `${context}: translated body bytes`).toBe(recorded.body)
}

// ─── Downstream comparison (per case) ────────────────────────────────────────────────

interface DownstreamAssertionResult {
  readonly body: string
  readonly decoded: DecodedSse | undefined
}

async function assertDownstreamStep(
  produced: ResponsesServiceResponse,
  expected: RecordedResponse,
  caseId: string,
): Promise<DownstreamAssertionResult> {
  const context = `S2d6[${caseId}] downstream`
  const body = await readResponseBody(produced.body)
  expect(produced.status, `${context}: status`).toBe(expected.status)

  const expectedContentType = headerValue(expected.headers, 'content-type')
  if (expectedContentType === undefined) throw new Error(`${context}: fixture must record Content-Type`)
  expect(headerValue(produced.headers, 'content-type'), `${context}: Content-Type`).toBe(expectedContentType)

  const expectedCacheControl = headerValue(expected.headers, 'cache-control')
  const cacheControl = headerValue(produced.headers, 'cache-control')
  if (expectedCacheControl === undefined) {
    expect(cacheControl, `${context}: Cache-Control must be absent outside SSE commits`).toBeUndefined()
  } else {
    expect(cacheControl, `${context}: Cache-Control`).toBe(expectedCacheControl)
  }

  const expectedConnection = headerValue(expected.headers, 'connection')
  const connection = headerValue(produced.headers, 'connection')
  if (expectedConnection === undefined) {
    expect(connection, `${context}: Connection must be absent outside SSE commits (§4.1 header set)`).toBeUndefined()
  } else {
    expect(connection, `${context}: Connection`).toBe(expectedConnection)
  }

  // Presence-only: the trace id VALUE is dynamic; the recorded absences (the
  // gateway-local middleware surfaces) are part of the contract surface.
  const expectedTrace = headerValue(expected.headers, 'x-cpa-trace-id') !== undefined
  expect(
    headerValue(produced.headers, 'x-cpa-trace-id') !== undefined,
    `${context}: X-Cpa-Trace-Id presence must match the recorded head`,
  ).toBe(expectedTrace)

  const producedContentLength = headerValue(produced.headers, 'content-length')
  if (producedContentLength !== undefined) {
    expect(producedContentLength, `${context}: Content-Length must match the body byte length when emitted`).toBe(
      String(encoder.encode(body).length),
    )
  }

  if (expectedContentType === 'text/event-stream') {
    const expectedDecoded = decodeDownstreamSse(expected.body, `${context}: recorded`)
    const actualDecoded = decodeDownstreamSse(body, `${context}: produced`)
    expectDecodedSse(actualDecoded, expectedDecoded, context)
    return { body, decoded: actualDecoded }
  }
  expect(body, `${context}: body bytes`).toBe(expected.body)
  return { body, decoded: undefined }
}

// ─── Clause layer (semantic MUSTs that byte equality hides as unreadable failures) ────

function usageKeyOrder(usage: Record<string, unknown>): readonly string[] {
  return Object.keys(usage)
}

function assertUpstreamClauses(caseId: CaseId, captured: CapturedUpstreamCall): void {
  const context = `S2d6[${caseId}] upstream clauses`
  const body = parseJsonRecord(captured.call.body, `${context}: translated body`)
  const client = parseJsonRecord(captured.request.body, `${context}: client body`)

  // §3.1: the upstream model field is the RESOLVED name, never the client alias.
  expect(body.model, `${context}: model is the resolved upstream name`).toBe(UPSTREAM_MODEL)

  const clientStream = client.stream === true
  const acceptHeader = headerValue(captured.call.headers, 'accept')
  const cacheControlHeader = headerValue(captured.call.headers, 'cache-control')
  if (clientStream) {
    // §2.3/§3.2: streaming is upstream-SSE with the forced usage option appended last.
    expect(body.stream, `${context}: stream flag`).toBe(true)
    expect(body.stream_options, `${context}: stream_options.include_usage forced true (§2.3)`).toEqual({
      include_usage: true,
    })
    const keys = Object.keys(body)
    expect(keys[keys.length - 1], `${context}: stream_options appended LAST by the executor`).toBe('stream_options')
    expect(acceptHeader, `${context}: SSE Accept header`).toBe('text/event-stream')
    expect(cacheControlHeader, `${context}: SSE Cache-Control header`).toBe('no-cache')
  } else {
    expect(body.stream, `${context}: stream flag`).toBe(false)
    expect(
      Object.hasOwn(body, 'stream_options'),
      `${context}: non-stream requests never gain stream_options`,
    ).toBe(false)
    expect(acceptHeader, `${context}: no SSE Accept on non-stream upstream calls`).toBeUndefined()
    expect(cacheControlHeader, `${context}: no SSE Cache-Control on non-stream upstream calls`).toBeUndefined()
  }

  if (captured.request.path === RESPONSES_COMPACT_PATH) {
    // §2.4: the client stream field is deleted from the compact passthrough body.
    expect(Object.hasOwn(body, 'stream'), `${context}: compact bodies delete the stream key`).toBe(false)
  }

  if (caseId === 'S2d6-nostream-basic') {
    // §3.1 whitelist: these Responses fields are DROPPED, never translated.
    for (const dropped of ['temperature', 'top_p', 'user', 'store', 'metadata', 'previous_response_id', 'truncation']) {
      expect(Object.hasOwn(body, dropped), `${context}: whitelist drop — ${dropped} must not reach the upstream`).toBe(false)
    }
  }

  if (caseId === 'S2d6-nostream-reasoning' || caseId === 'S2d6-stream-reasoning') {
    // §3.1: reasoning.effort → reasoning_effort (lowercased, trimmed).
    expect(body.reasoning_effort, `${context}: reasoning_effort`).toBe('high')
  }
}

function assertDownstreamClauses(
  caseId: CaseId,
  result: DownstreamAssertionResult,
  usageOrderOverride?: readonly string[],
): void {
  const context = `S2d6[${caseId}] downstream clauses`
  if (result.decoded === undefined) {
    const body = parseJsonRecord(result.body, context)
    const isCompact = caseId.startsWith('S2d6-compact-')
    if (!isCompact) {
      // §3.3 echo quirk: the non-stream response model echoes the RESOLVED upstream name.
      expect(body.model, `${context}: non-stream echo quirk — model is the resolved upstream name (§3.3)`).toBe(
        UPSTREAM_MODEL,
      )
    }
    const usage = asRecord(body.usage)
    if (usage !== undefined) {
      // §3.3/§8-4: Ensure appends BOTH detail objects after total_tokens (this order).
      expect(usageKeyOrder(usage), `${context}: non-stream usage key order (details appended after total)`).toEqual(
        usageOrderOverride ?? [
          'input_tokens',
          'output_tokens',
          'total_tokens',
          'output_tokens_details',
          'input_tokens_details',
        ],
      )
    }
    return
  }

  const frames = result.decoded.frames
  const lastFrame = frames[frames.length - 1]
  const lastEvent = lastFrame?.event ?? ''
  const isFailureLast = FAILURE_EVENT_NAMES.has(lastEvent)
  const dataFrameCount = frames.length - (isFailureLast ? 1 : 0)

  // §4.3 echo asymmetry: stream-side events echo the CLIENT-REQUESTED model (alias).
  for (const frame of frames) {
    if (frame.event === 'response.created' || frame.event === 'response.in_progress' || frame.event === 'response.completed' || frame.event === 'response.incomplete') {
      const payload = parseJsonRecord(frame.data, `${context}: ${frame.event} payload`)
      const response = asRecord(payload.response)
      expect(response?.model, `${context}: ${frame.event} echoes the client-requested model (§3.4/§4.3)`).toBe(
        MODEL_ALIAS,
      )
    }
  }

  if (isFailureLast && lastFrame !== undefined) {
    // §5.2: the failure frame's sequence_number equals the data-frame count at close.
    const payload = parseJsonRecord(lastFrame.data, `${context}: failure frame payload`)
    expect(payload.sequence_number, `${context}: failure frame sequence_number == data-frame count (§5.2)`).toBe(
      dataFrameCount,
    )
  }

  if (caseId === 'S2d6-stream-usage-incomplete') {
    const terminal = frames.find((frame) => frame.event === 'response.incomplete')
    if (terminal === undefined) throw new Error(`${context}: expected a response.incomplete terminal frame`)
    const terminalPayload = parseJsonRecord(terminal.data, `${context}: terminal payload`)
    const usage = asRecordOrThrow(
      asRecordOrThrow(terminalPayload.response, `${context}: terminal response object`).usage,
      `${context}: terminal usage`,
    )
    // §3.5 stream shape: cached_tokens inline (2nd key), reasoning_tokens appended after total.
    expect(usageKeyOrder(usage), `${context}: stream usage key order (§3.5)`).toEqual(
      usageOrderOverride ?? [
        'input_tokens',
        'input_tokens_details',
        'output_tokens',
        'total_tokens',
        'output_tokens_details',
      ],
    )
  }
}

// ─── Case runner ─────────────────────────────────────────────────────────────────────

interface ReplaySession {
  readonly service: ResponsesService
  readonly captured: CapturedUpstreamCall[]
  readonly advanceClock: (deltaMs: number) => void
}

/** Fresh service + fresh MemoryStore per case; the clock never touches wall time. */
function makeSession(): ReplaySession {
  if (adapterFactory === undefined) throw new Error('adapter factory missing')
  let nowMs = FROZEN_NOW_MS
  const now = (): number => nowMs
  const service = adapterFactory({
    apiKeys: [GATEWAY_API_KEY],
    credentials: [
      {
        apiKey: UPSTREAM_API_KEY,
        baseUrl: UPSTREAM_BASE_URL,
        models: [{ name: UPSTREAM_MODEL, alias: MODEL_ALIAS }],
      },
    ],
    store: new MemoryStore({ now }),
    now,
    requestRetry: 0,
    transientErrorCooldownSeconds: -1,
  })
  if (typeof service.handleResponses !== 'function') {
    throw new Error(`${ADAPTER_EXPORT}() must return an object with a handleResponses(request, send) method`)
  }
  return {
    service,
    captured: [],
    advanceClock: (deltaMs: number) => {
      nowMs += deltaMs
    },
  }
}

interface CaseFiles {
  readonly caseId: CaseId
  readonly meta: CaseMeta
  readonly request: ResponsesRequest
  readonly recorded: RecordedResponse
  readonly wire: readonly WireLine[]
}

async function loadCaseFiles(caseId: CaseId): Promise<CaseFiles> {
  const meta = await readCaseMeta(caseId)
  validateDynamicFields(caseId, meta.dynamic_fields)
  const request = parseRequestFile(await readFixtureText(caseId, 'request.http'))
  const recorded = parseDownstreamFile(await readFixtureText(caseId, 'downstream.md'))
  const wire = parseWireLines(await readFixtureText(caseId, 'upstream.jsonl'))
  expect(recorded.status, `S2d6[${caseId}]: recorded status must match meta http_status`).toBe(Number(meta.http_status))
  expect(wire.length, `S2d6[${caseId}]: recorded wire lines must match meta upstream_hits`).toBe(meta.upstream_hits)
  return { caseId, meta, request, recorded, wire }
}

/** NE-LENIENT divergence replay for S2d6-badbody-notfound (see header: HARNESS SEMANTICS). */
async function assertBadRequestDivergence(
  produced: ResponsesServiceResponse,
  recorded: RecordedResponse,
  caseId: CaseId,
): Promise<void> {
  const context = `S2d6[${caseId}] NE-LENIENT divergence`
  const body = await readResponseBody(produced.body)
  expect(produced.status, `${context}: strict boundary must reject with 400`).toBe(400)
  const contentType = headerValue(produced.headers, 'content-type')
  expect(
    contentType !== undefined && contentType.startsWith('application/json'),
    `${context}: strict 400 carries a JSON content type (the exact variant is rewrite-owned)`,
  ).toBe(true)
  const parsed = parseJsonRecord(body, `${context}: strict 400 body`)
  const error = asRecord(parsed.error)
  expect(error, `${context}: strict 400 body carries an error object`).toBeDefined()
  expect(error?.type, `${context}: strict 400 error type (this surface's error shape)`).toBe('invalid_request_error')
  const message = asString(error?.message)
  expect(typeof message === 'string' && message.length > 0, `${context}: strict 400 message is non-empty`).toBe(true)
  expect(
    body === recorded.body,
    `${context}: the strict 400 must NOT reproduce the reference's lenient model_not_found bytes (SPEC.md NE-LENIENT)`,
  ).toBe(false)
}

interface ReplayOptions {
  /** Override the scripted mock behavior (derived tests patch the canned usage). */
  readonly script?: MockScript
  /** Override the expected downstream body (derived tests swap the usage object). */
  readonly expectedBody?: string
  /** Override the usage key-order clause (derived tests expect the reasoning>0 orders). */
  readonly expectedUsageOrder?: readonly string[]
}

async function replayCase(session: ReplaySession, caseId: CaseId, options: ReplayOptions = {}): Promise<void> {
  const files = await loadCaseFiles(caseId)
  const script: MockScript | undefined = options.script ?? (files.meta.upstream_hits > 0 ? (await resolveMockScript(caseId)).script : undefined)
  const mock = script === undefined ? undefined : buildMockUpstreamResponse(script, caseId)

  let currentRequest: ResponsesRequest | undefined
  const send: UpstreamSender = async (call) => {
    if (currentRequest === undefined) {
      throw new Error(`S2d6[${caseId}]: harness bug — upstream call outside the request step`)
    }
    session.captured.push({ request: currentRequest, call })
    if (mock === undefined) {
      throw new Error(`S2d6[${caseId}]: gateway-local case made an upstream call (meta upstream_hits is 0)`)
    }
    return mock.response
  }

  const callsBefore = session.captured.length
  currentRequest = files.request
  const produced = await session.service.handleResponses(files.request, send)
  const callsThisCase = session.captured.slice(callsBefore)
  expect(callsThisCase.length, `S2d6[${caseId}]: upstream call count (gateway-local cases call nothing)`).toBe(
    files.meta.upstream_hits,
  )
  for (const [index, captured] of callsThisCase.entries()) {
    const recorded = files.wire[index]
    if (recorded === undefined) {
      throw new Error(`S2d6[${caseId}]: more upstream calls than recorded wire lines`)
    }
    expect(
      mock.status,
      `S2d6[${caseId}] upstream call ${index + 1}: scripted mock reply status matches the recorded response_status`,
    ).toBe(recorded.responseStatus)
    assertUpstreamWire(recorded, captured, caseId)
    assertUpstreamClauses(caseId, captured)
  }

  if (caseId === 'S2d6-badbody-notfound') {
    await assertBadRequestDivergence(produced, files.recorded, caseId)
    return
  }

  const expected =
    options.expectedBody === undefined
      ? files.recorded
      : { ...files.recorded, body: options.expectedBody }
  const result = await assertDownstreamStep(produced, expected, caseId)
  assertDownstreamClauses(caseId, result, options.expectedUsageOrder)
}

// ─── Derived expectations (no golden; spec §3.3/§3.5 source-cited) ────────────────────

/** Swaps the usage object of a recorded body, asserting the target substring is unique. */
function withSwappedUsage(body: string, from: string, to: string, context: string): string {
  const occurrences = body.split(from).length - 1
  if (occurrences !== 1) {
    throw new Error(`${context}: expected exactly one occurrence of the recorded usage object, found ${occurrences}`)
  }
  return body.replace(from, to)
}

/** §3.3 derived: translator writes reasoning before total; Ensure appends ONLY cached_tokens. */
const DERIVED_NONSTREAM_USAGE =
  '{"input_tokens":9,"output_tokens":6,"output_tokens_details":{"reasoning_tokens":4},"total_tokens":15,"input_tokens_details":{"cached_tokens":0}}'
/** §3.5 derived: terminal builder writes both details inline; Ensure appends NOTHING. */
const DERIVED_STREAM_USAGE =
  '{"input_tokens":9,"input_tokens_details":{"cached_tokens":0},"output_tokens":6,"output_tokens_details":{"reasoning_tokens":4},"total_tokens":15}'

const RECORDED_NONSTREAM_USAGE =
  '{"input_tokens":9,"output_tokens":6,"total_tokens":15,"output_tokens_details":{"reasoning_tokens":0},"input_tokens_details":{"cached_tokens":0}}'
const RECORDED_STREAM_USAGE =
  '{"input_tokens":9,"input_tokens_details":{"cached_tokens":0},"output_tokens":6,"total_tokens":15,"output_tokens_details":{"reasoning_tokens":0}}'

/** Patches a canned chat reply / SSE chunk list with reasoning_tokens > 0 upstream usage. */
function patchUsageWithReasoning(script: MockScript, caseId: string): MockScript {
  const patchUsage = (usage: Record<string, unknown>): Record<string, unknown> => ({
    ...usage,
    output_tokens_details: { reasoning_tokens: 4 },
  })
  if (script.kind === 'nonstream') {
    const reply = asRecordOrThrow(script.reply, `S2d6[${caseId}] derived nonstream reply`)
    return { kind: 'nonstream', reply: { ...reply, usage: patchUsage(asRecordOrThrow(reply.usage, 'canned usage')) } }
  }
  if (script.kind === 'stream') {
    const events: unknown[] = []
    for (const event of script.script.events) {
      const chunk = asRecord(event)
      if (chunk !== undefined && asRecord(chunk.usage) !== undefined) {
        events.push({ ...chunk, usage: patchUsage(asRecordOrThrow(chunk.usage, 'chunk usage')) })
      } else {
        events.push(event)
      }
    }
    return { kind: 'stream', script: { events, terminator: script.script.terminator }, abortAfter: script.abortAfter }
  }
  throw new Error(`S2d6[${caseId}] derived: cannot patch an error script`)
}

// ─── ASCII guard (pythonJson byte fidelity) ──────────────────────────────────────────

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

// ─── Suites ──────────────────────────────────────────────────────────────────────────

/** Recorded wire header orders (stable across all 27 fixtures; differs by upstream mode). */
const NONSTREAM_WIRE_HEADER_ORDER = [
  'Host',
  'User-Agent',
  'Content-Length',
  'Authorization',
  'Content-Type',
  'Accept-Encoding',
] as const
const STREAM_WIRE_HEADER_ORDER = [
  'Host',
  'User-Agent',
  'Content-Length',
  'Accept',
  'Authorization',
  'Cache-Control',
  'Content-Type',
  'Accept-Encoding',
] as const

/** SSE goldens that end with the clean-close WriteDone `\n` vs the failure-frame close. */
const CLEAN_CLOSE_CASES: ReadonlySet<string> = new Set([
  'S2d6-stream-basic',
  'S2d6-stream-reasoning',
  'S2d6-stream-slow',
  'S2d6-stream-toolcalls',
  'S2d6-stream-usage-incomplete',
])
/** Recorded middleware-abort surfaces: the trace header is absent exactly here. */
const TRACE_ABSENT_CASES: ReadonlySet<string> = new Set([
  'S2d6-auth-missing',
  'S2d6-badbody-notfound',
  'S2d6-compact-stream-rejected',
  'S2d6-model-notfound',
])

describe('S2d6 fixture inventory (harness self-check, adapter-independent)', () => {
  it('exposes exactly the 27 admitted golden cases, each internally consistent', async () => {
    expect([...fixtureCaseDirs]).toEqual([...EXPECTED_CASES])

    for (const caseId of EXPECTED_CASES) {
      const context = `S2d6[${caseId}]`
      const meta = await readCaseMeta(caseId)
      expect(meta.id, `${context}: meta.id echoes the directory name`).toBe(caseId)
      expect(meta.anchor.includes(VERSION_TAG), `${context}: version anchor tag`).toBe(true)
      expect(meta.anchor.includes(VERSION_IMAGE_DIGEST), `${context}: version anchor image digest`).toBe(true)
      expect(meta.anchor.includes(VERSION_COMMIT), `${context}: version anchor commit`).toBe(true)
      expect(typeof meta.recorded_at === 'string' && meta.recorded_at.length > 0, `${context}: recorded_at`).toBe(true)
      validateDynamicFields(caseId, meta.dynamic_fields)

      const request = parseRequestFile(await readFixtureText(caseId, 'request.http'))
      expect(request.method, `${context}: route method`).toBe('POST')
      expect(
        request.path === RESPONSES_PATH || request.path === RESPONSES_COMPACT_PATH,
        `${context}: route path is the recorded Responses surface`,
      ).toBe(true)
      expect(headerValue(request.headers, 'content-length'), `${context}: request body bytes match Content-Length`).toBe(
        String(encoder.encode(request.body).length),
      )
      if (caseId === 'S2d6-auth-missing') {
        expect(headerValue(request.headers, 'authorization'), `${context}: the auth-missing request carries no key`).toBeUndefined()
      } else {
        expect(headerValue(request.headers, 'authorization'), `${context}: recorded gateway key`).toBe(
          `Bearer ${GATEWAY_API_KEY}`,
        )
      }
      if (caseId !== 'S2d6-badbody-notfound') {
        parseJsonRecord(request.body, `${context}: client body (NE-LENIENT replays are well-formed)`)
      }

      const recorded = parseDownstreamFile(await readFixtureText(caseId, 'downstream.md'))
      expect(Number(meta.http_status), `${context}: meta http_status agrees with the recording`).toBe(recorded.status)
      const contentType = headerValue(recorded.headers, 'content-type')
      expect(contentType, `${context}: response head records Content-Type`).toBeDefined()
      if (contentType === 'text/event-stream') {
        expect(headerValue(recorded.headers, 'cache-control'), `${context}: SSE commit records Cache-Control`).toBe('no-cache')
        expect(headerValue(recorded.headers, 'connection'), `${context}: SSE commit records Connection`).toBe('keep-alive')
        expect(headerValue(recorded.headers, 'transfer-encoding'), `${context}: SSE recording is chunked`).toBe('chunked')
        expect(headerValue(recorded.headers, 'content-length'), `${context}: chunked recordings carry no Content-Length`).toBeUndefined()
        // Structural decode of the golden bytes under the §4.1 framing rules.
        const decoded = decodeDownstreamSse(recorded.body, `${context}: golden SSE`)
        const dataFrameCount = decoded.frames.length - (decoded.failureLead.at(-1) === true ? 1 : 0)
        for (let index = 0; index < dataFrameCount; index += 1) {
          expect(
            asRecordOrThrow(JSON.parse(decoded.frames[index]?.data ?? 'null'), `${context} frame ${index}`).sequence_number,
            `${context}: golden data frames number strictly +1 from 1`,
          ).toBe(index + 1)
        }
        if (decoded.failureLead.at(-1) === true) {
          const payload = asRecordOrThrow(JSON.parse(decoded.frames.at(-1)?.data ?? 'null'), `${context} failure frame`)
          expect(payload.sequence_number, `${context}: golden failure frame seq == data-frame count (§5.2)`).toBe(
            dataFrameCount,
          )
        }
        expect(decoded.trailingWriteDone, `${context}: golden clean-close WriteDone rule`).toBe(CLEAN_CLOSE_CASES.has(caseId))
      } else {
        expect(headerValue(recorded.headers, 'content-length'), `${context}: JSON recording records Content-Length`).toBe(
          String(encoder.encode(recorded.body).length),
        )
      }
      expect(
        (headerValue(recorded.headers, 'x-cpa-trace-id') !== undefined) === !TRACE_ABSENT_CASES.has(caseId),
        `${context}: recorded trace-header presence matches the middleware-vs-handler split`,
      ).toBe(true)

      const wire = parseWireLines(await readFixtureText(caseId, 'upstream.jsonl'))
      expect(wire.length, `${context}: wire line count == meta upstream_hits`).toBe(meta.upstream_hits)
      for (const [index, line] of wire.entries()) {
        expect(line.method, `${context} wire ${index}: method`).toBe('POST')
        expect(
          line.path === CHAT_WIRE_PATH || line.path === RESPONSES_COMPACT_PATH,
          `${context} wire ${index}: known upstream path`,
        ).toBe(true)
        expect(line.headers.Authorization, `${context} wire ${index}: Authorization is redacted in the log`).toBe('<redacted>')
        expect(line.headers['User-Agent'], `${context} wire ${index}: fixed compat User-Agent`).toBe(UPSTREAM_USER_AGENT)
        expect(line.credential, `${context} wire ${index}: recorded credential name`).toBe(UPSTREAM_API_KEY)
        expect(line.headers['Content-Length'], `${context} wire ${index}: logged Content-Length matches the body`).toBe(
          String(encoder.encode(line.body).length),
        )
        const headerOrder = Object.keys(line.headers)
        const expectedOrder = line.headers.Accept === undefined ? NONSTREAM_WIRE_HEADER_ORDER : STREAM_WIRE_HEADER_ORDER
        expect(headerOrder, `${context} wire ${index}: stable recorded header order (stream vs non-stream)`).toEqual([
          ...expectedOrder,
        ])
      }

      if (meta.upstream_hits > 0) {
        const resolved = await resolveMockScript(caseId)
        if (resolved.script.kind === 'nonstream') assertAsciiStrings(resolved.script.reply, `${context}: canned reply`)
        if (resolved.script.kind === 'stream') {
          assertAsciiStrings(resolved.script.script.events, `${context}: SSE script events`)
          expect(
            resolved.script.script.terminator === null ||
              resolved.script.script.terminator === undefined ||
              resolved.script.script.terminator === 'data: [DONE]',
            `${context}: only the data: [DONE] terminator is recorded`,
          ).toBe(true)
        }
        if (resolved.script.kind === 'error') {
          expect(resolved.script.status, `${context}: recorded error mode is the 429`).toBe(429)
          assertAsciiStrings(resolved.script.body, `${context}: error reply body`)
        }
      } else {
        expect(wire.length, `${context}: zero-hit cases record no wire lines`).toBe(0)
      }

      // meta.yaml canned_* duplicates must agree with the scripted mock file when both exist.
      if (await fixtureFileExists(caseId, 'mock-response.json')) {
        const mockFile = await readFixtureJson<unknown>(caseId, 'mock-response.json')
        if (meta.mock_control.cannedNonstream !== undefined) {
          expect(meta.mock_control.cannedNonstream, `${context}: meta canned_nonstream echoes mock-response.json`).toEqual(
            mockFile,
          )
        }
        if (meta.mock_control.cannedSse !== undefined) {
          expect(meta.mock_control.cannedSse, `${context}: meta canned_sse echoes mock-response.json`).toEqual(mockFile)
        }
      }
    }

    // ── cross-case pins ──────────────────────────────────────────────────────────────
    const bodyOf = async (caseId: CaseId): Promise<string> =>
      parseDownstreamFile(await readFixtureText(caseId, 'downstream.md')).body
    const wireOf = async (caseId: CaseId): Promise<readonly WireLine[]> =>
      parseWireLines(await readFixtureText(caseId, 'upstream.jsonl'))

    // stream-slow is byte-equal to stream-basic (timing is meta-only).
    expect(await bodyOf('S2d6-stream-slow'), 'stream-slow golden bytes == stream-basic').toBe(await bodyOf('S2d6-stream-basic'))

    // compact-streamfalse pins the stream-key DELETION: its upstream body equals the
    // passthrough case's although the client sent "stream":false.
    const compactPassthroughWire = await wireOf('S2d6-compact-passthrough')
    const compactStreamfalseWire = await wireOf('S2d6-compact-streamfalse')
    expect(compactStreamfalseWire[0]?.body, 'compact-streamfalse upstream body == passthrough (stream deleted)').toBe(
      compactPassthroughWire[0]?.body,
    )
    expect(compactPassthroughWire[0]?.path, 'compact upstream path').toBe(RESPONSES_COMPACT_PATH)

    // The 429 pair: one shared recording session, gap above the ~1s rate-limit window.
    const metaA = await readCaseMeta('S2d6-error-nostream-429')
    const metaB = await readCaseMeta('S2d6-error-stream-429')
    expect(metaA.mock_control.mode, 'pair case A error mode').toBe('error')
    expect(metaB.mock_control.mode, 'pair case B error mode').toBe('error')
    expect(
      Math.abs(Date.parse(metaA.recorded_at) - Date.parse(metaB.recorded_at)) >= 2_000,
      'the two 429 goldens recorded >= 2s apart (cooldown expired for the second)',
    ).toBe(true)
    // The mock's served 429 bytes: the non-stream golden passed them through VERBATIM.
    expect(await bodyOf('S2d6-error-nostream-429'), 'nostream-429 golden == pythonJson(mock 429 body), verbatim').toBe(
      pythonJson(RATE_LIMIT_429_BODY),
    )
    const stream429Body = await bodyOf('S2d6-error-stream-429')
    expect(stream429Body, 'stream-429 golden is the sanitized re-marshal with SORTED keys (§5.1)').toBe(
      '{"error":{"code":429,"message":"mock rate limit","status":"RESOURCE_EXHAUSTED","type":"rate_limit_exceeded"}}',
    )

    // Fixture-authoritative divergence (spec §6): empty200 is the conductor empty_stream
    // 500 with the message prefix — not the source-derived 502 hint in meta.expect_hints.
    const emptyMeta = await readCaseMeta('S2d6-stream-empty200')
    expect(Number(emptyMeta.http_status), 'empty200 recorded status is 500 (conductor classification)').toBe(500)
    expect(await bodyOf('S2d6-stream-empty200'), 'empty200 recorded body').toBe(
      '{"error":{"message":"empty_stream: upstream stream closed before first payload","type":"server_error","code":"internal_server_error"}}',
    )

    // badbody reference-behavior pin (NE-LENIENT documentation, not a rewrite target).
    const badbody = await bodyOf('S2d6-badbody-notfound')
    expect(badbody, 'badbody golden keeps the reference lenient model_not_found bytes').toBe(
      '{"error":{"message":"unknown provider for model ","type":"invalid_request_error","code":"model_not_found","param":"model"}}',
    )

    // Default-script anchors: the derived variants ride these two fixture files.
    const basicMeta = await readCaseMeta('S2d6-nostream-basic')
    const streamBasicMeta = await readCaseMeta('S2d6-stream-basic')
    expect(basicMeta.mock_control.variant, 'nostream-basic anchors the default non-stream reply').toBe('default')
    expect(streamBasicMeta.mock_control.variant, 'stream-basic anchors the default SSE script').toBe('default-stream-done')
    expect(DEFAULT_NONSTREAM_REPLY, 'DEFAULT_NONSTREAM_REPLY is the anchored fixture file').toEqual(
      await readFixtureJson<unknown>('S2d6-nostream-basic', 'mock-response.json'),
    )
    expect(DEFAULT_STREAM_SCRIPT, 'DEFAULT_STREAM_SCRIPT is the anchored fixture file').toEqual(
      await readFixtureJson<unknown>('S2d6-stream-basic', 'mock-response.json'),
    )

    // Derived-case surgery targets: each recorded usage object must occur exactly once.
    for (const [caseId, needle] of [
      ['S2d6-nostream-basic', RECORDED_NONSTREAM_USAGE],
      ['S2d6-stream-usage-incomplete', RECORDED_STREAM_USAGE],
    ] as const) {
      const body = await bodyOf(caseId)
      expect(body.split(needle).length - 1, `${caseId}: derived usage surgery target occurs exactly once`).toBe(1)
    }

    assertAsciiStrings(RATE_LIMIT_429_BODY, 'RATE_LIMIT_429_BODY')
  })
})

suite(suiteTitle, () => {
  for (const caseId of REPLAY_CASES) {
    it(`${caseId} — replays the recorded golden: upstream wire byte-exact, downstream surface byte-exact`, async () => {
      const session = makeSession()
      await replayCase(session, caseId)
    })
  }

  it('S2d6-badbody-notfound — NE-LENIENT divergence replay: strict 400, JSON error shape, zero upstream calls', async () => {
    const session = makeSession()
    await replayCase(session, 'S2d6-badbody-notfound')
  })

  it('S2d6-error-nostream-429 + S2d6-error-stream-429 — verbatim vs sanitized 429 pair on ONE shared session', async () => {
    // One service + one store for both cases, replayed in recording order; the harness
    // clock advances +2500ms between the steps (recorded gap ~2.5-3.5s > the ~1s
    // rate-limit window), so the second request must still reach the upstream and
    // observe its own 429 — a cooldown short-circuit fails against the recorded golden.
    const session = makeSession()
    await replayCase(session, 'S2d6-error-nostream-429')
    session.advanceClock(PAIR_GAP_MS)
    await replayCase(session, 'S2d6-error-stream-429')
  })

  it('derived (no golden): upstream reasoning_tokens>0 — non-stream usage order (spec §3.3)', async () => {
    const caseId = 'S2d6-nostream-basic' as CaseId
    const session = makeSession()
    const resolved = await resolveMockScript(caseId)
    const script = patchUsageWithReasoning(resolved.script, caseId)
    const files = await loadCaseFiles(caseId)
    const expectedBody = withSwappedUsage(files.recorded.body, RECORDED_NONSTREAM_USAGE, DERIVED_NONSTREAM_USAGE, 'derived nonstream')
    await replayCase(session, caseId, {
      script,
      expectedBody,
      expectedUsageOrder: ['input_tokens', 'output_tokens', 'output_tokens_details', 'total_tokens', 'input_tokens_details'],
    })
  })

  it('derived (no golden): upstream reasoning_tokens>0 — stream usage order (spec §3.5)', async () => {
    const caseId = 'S2d6-stream-usage-incomplete' as CaseId
    const session = makeSession()
    const resolved = await resolveMockScript(caseId)
    const script = patchUsageWithReasoning(resolved.script, caseId)
    const files = await loadCaseFiles(caseId)
    const expectedBody = withSwappedUsage(files.recorded.body, RECORDED_STREAM_USAGE, DERIVED_STREAM_USAGE, 'derived stream')
    await replayCase(session, caseId, {
      script,
      expectedBody,
      expectedUsageOrder: ['input_tokens', 'input_tokens_details', 'output_tokens', 'output_tokens_details', 'total_tokens'],
    })
  })
})
