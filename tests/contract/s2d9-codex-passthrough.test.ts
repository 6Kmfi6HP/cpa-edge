/**
 * S2d9 golden contract — Codex/Responses passthrough (Responses client -> codex-api-key
 * upstream).
 *
 * Spec source of truth: spec/sections/S2d9-codex-passthrough.md (admitted). Goldens: the
 * 17 oracle-recorded contract cases plus the S2d9-18 supplementary observation under
 * tests/fixtures/S2d9/ (CLIProxyAPI v7.3.4, commit 8335eac731946bd4eff18f500653f93736df53d6,
 * image digest sha256:97825da3..., deterministic codex-responses mock; recorded by
 * @oracle-runner worker-2, reference port 8387, mock port 20003). Rulings applied:
 * R-SSE (the downstream SSE surface compares as the DECODED byte stream — transport chunk
 * boundaries are ignored; here the decoded stream itself is byte-pinned because S2d9-17
 * goldens the §4.2 framing normalization: comment glue, `data:` re-prefixing, `\n\n`
 * frame completion, the §5.2 failure-frame lead `\n`, and the §4.2 WriteDone trailing
 * `\n`), R-FIXTURE (all 18 recordings are RECORDABLE-LOCALLY codex-api-key replays; the
 * OAuth-only Codex behaviors are FIXTURE-DEFERRED and pinned by no case here),
 * NE-LENIENT (every replayed request body is well-formed JSON; the strict-400 boundary
 * is exercised by no S2d9 golden). R-ORDER is INERT on this direction: the passthrough
 * forwards upstream frames in arrival order and the goldens contain no adjacent
 * same-type frames whose order is not part of the wire contract (the two
 * output_text.delta frames of S2d9-02 are sequential text fragments). R-TOK (no token
 * estimation exists in this direction), R-404 and R-BCRYPT (S1/S3-S6 territory) are
 * exercised by no fixture here. Per the trace-family ruling, X-Cpa-Trace-Id is
 * RECOGNIZED as a declared dynamic field but NEVER compared (S1 middleware territory;
 * the recorded trace-ABSENT surfaces — S2d9-12, S2d9-16, S2d9-18 — stay documented by the
 * inventory, unasserted on the adapter).
 *
 * RECORDED DIVERGENCE the implementer must know (fixture wins over prose, SPEC §0):
 * S2d9-05's client sends a top-level `reasoning` object and the recorded upstream body
 * DELETES it — the configured codex-api-key models carry no thinking capability, and the
 * capability-less strip recorded for the S2d5 chat direction applies here too. Spec
 * §3.2's "reasoning PRESERVED verbatim" row describes the capability-ON variant, which
 * no golden exercises. The adapter interface below therefore carries the same
 * `thinking` model flag as the S2d5 contract; ABSENT (the recorded default) strips the
 * reasoning object upstream.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * ADAPTER INTERFACE — what the `@cpa-edge/translators/codex-passthrough` direction
 * module MUST export. The suite dynamically imports the package and turns green-to-red
 * once the export ships; until then every adapter case test SKIPS with the reason below.
 * The harness holds its own structural mirror of these types; the package should export
 * the real ones. All shapes are runtime-checked by the suite.
 *
 *   export function createCodexPassthroughService(
 *     options: CodexPassthroughServiceOptions,
 *   ): CodexPassthroughService
 *
 *   type HeaderList = ReadonlyArray<readonly [string, string]>   // ordered, original casing
 *
 *   interface CodexPassthroughModelEntry {  // one model of a codex-api-key credential
 *     name: string                          // upstream model name (alias-rewrite target)
 *     alias?: string                        // client-facing alias; defaults to `name`
 *     forceMapping?: boolean                // §4.3: rewrite model fields in every
 *                                           // forwarded payload back to the alias
 *     thinking?: boolean                    // capability flag. ABSENT (recorded default)
 *                                           // = no thinking capability -> the top-level
 *                                           // `reasoning` object is DELETED from the
 *                                           // upstream body (S2d9-05 golden). TRUE =
 *                                           // capability-ON passthrough; NO golden sets it.
 *   }
 *
 *   interface CodexPassthroughCredential { // one codex-api-key config entry
 *     apiKey: string                        // upstream key -> `Authorization: Bearer <apiKey>`
 *     baseUrl: string                       // upstream ROOT, trailing "/" trimmed; the
 *                                           // executor appends `/responses` (B1/B2) or
 *                                           // `/responses/compact` (B3/B4) — operators do
 *                                           // NOT point this at a `/v1` prefix (§3.2)
 *     headers?: Readonly<Record<string, string>>
 *                                           // per-credential fixed headers (OPTIONAL; no
 *                                           // golden exercises it)
 *     models: readonly CodexPassthroughModelEntry[]
 *   }
 *
 *   interface CodexPassthroughServiceOptions {
 *     credentials: readonly CodexPassthroughCredential[]
 *                                           // codex-api-key entries, config order; the
 *                                           // recording config declares the SAME upstream
 *                                           // name under two aliases, the second with
 *                                           // forceMapping: true
 *     store: Store                          // from @cpa-edge/core; ALL persistent state —
 *                                           // both recorded cooldown families (§5.1: the
 *                                           // 429 rate-limit window driven by
 *                                           // resets_in_seconds/resets_at, and the 404
 *                                           // model_not_found window of S2d9-18) — flows
 *                                           // through it; no in-facade globals
 *     now?: () => number                    // epoch-ms clock; MUST drive every timing
 *                                           // decision (cooldown window open/close,
 *                                           // reset_seconds, Retry-After, reset_time)
 *     requestRetry?: number                 // 0 in every fixture (single attempt)
 *     transientErrorCooldownSeconds?: number
 *                                           // -1 in every fixture. -1 disables only
 *                                           // transient-error cooldowns; BOTH recorded
 *                                           // cooldown families stay ACTIVE (§5.1).
 *     disableCodexCloaking?: boolean        // OPTIONAL (spec §3.2); false in every
 *                                           // fixture — cloaking is ON, so User-Agent and
 *                                           // Originator are the fixed codex-tui values.
 *     disableImageGeneration?: 'off' | 'true' | 'all' | 'chat' | 'passthrough'
 *                                           // OPTIONAL (spec §3.2 tools row); 'off' in
 *                                           // every fixture -> the image_generation tool
 *                                           // is INJECTED (appended last) unless the
 *                                           // request is native Lite. No golden exercises
 *                                           // another value.
 *   }
 *
 *   interface CodexPassthroughRequest {
 *     method: string                        // 'POST'
 *     path: string                         // '/v1/responses' | '/backend-api/codex/responses'
 *                                          // | '/v1/responses/compact'
 *                                          // | '/backend-api/codex/responses/compact'
 *     headers: HeaderList                  // client headers, recorded order + casing:
 *                                          // User-Agent / Originator feed the codex-client
 *                                          // detection that selects the §5.2 failure
 *                                          // event; X-OpenAI-Internal-Codex-Responses-Lite
 *                                          // feeds the §3.3 Lite dialect
 *     body: string                         // exact request-body bytes (well-formed JSON)
 *   }
 *
 *   interface CodexPassthroughUpstreamRequest {
 *     method: string                       // 'POST'
 *     url: string                          // absolute `<baseUrl-trimmed>/responses` or
 *                                          // `<baseUrl-trimmed>/responses/compact`
 *     headers: HeaderList                  // emission ORDER is pinned (see below)
 *     body: string
 *   }
 *
 *   interface CodexPassthroughUpstreamResponse {
 *     status: number
 *     headers: HeaderList
 *     body: ReadableStream<Uint8Array>     // 2xx: raw SSE bytes (the upstream is ALWAYS
 *                                          // requested as SSE on /responses, stream and
 *                                          // non-stream clients alike; compact replies are
 *                                          // plain JSON). Non-2xx: raw error bytes. A
 *                                          // clean close before a terminal event (S2d9-08)
 *                                          // and a rejected read must both surface the same
 *                                          // §5.3 incomplete-stream failure.
 *   }
 *
 *   type CodexPassthroughUpstreamSender =
 *     (request: CodexPassthroughUpstreamRequest) => Promise<CodexPassthroughUpstreamResponse>
 *
 *   interface CodexPassthroughResponse {
 *     status: number
 *     headers: HeaderList                  // must carry the direction-owned subset (below)
 *     body: string | ReadableStream<Uint8Array>
 *   }
 *
 *   interface CodexPassthroughService {
 *     handleResponses(
 *       request: CodexPassthroughRequest,
 *       send: CodexPassthroughUpstreamSender,
 *     ): Promise<CodexPassthroughResponse>
 *   }
 *
 * The facade covers the whole pinned passthrough pipeline: route dispatch on the four
 * recorded surfaces, the `stream == true` JSON-boolean gate (string "true" is NOT
 * accepted), the compact stream:true rejection (400, zero upstream calls, body
 * `{"error":{"message":"Streaming not supported for compact responses","type":"invalid_request_error"}}`,
 * Content-Type `application/json; charset=utf-8`), the §3.2 upstream construction (alias
 * -> resolved-model rewrite; `stream` forced true on /responses and DELETED on compact;
 * `store` forced false on /responses and untouched on compact; `include` forced to the
 * one-element array; `parallel_tool_calls` forced true, false for Lite, deleted when the
 * tools array ends up empty; `instructions` defaulted "" for non-Lite; input rewrites —
 * string -> one user message item, system -> developer, reasoning-item sanitization incl.
 * the store=false orphan-id drops; the §3.2 deletion list; stream_options reduced to
 * reasoning_summary_delivery; the derived prompt_cache_key mirrored into the Session-Id
 * header), the fixed cloaked header set + order + the client-header whitelist (forwarded
 * names are re-emitted with canonical MIME casing — the Lite header is recorded as
 * `X-Openai-Internal-Codex-Responses-Lite`), the §4 SSE passthrough (line-level
 * forwarding, `data: ` re-prefixing, comment glue, `\n\n` frame completion, terminal
 * event-stop + the response.done -> response.completed payload rename, the WriteDone
 * trailing `\n`, §4.3 model injection into created/in_progress and force-mapping rewrites
 * of every model field, §4.6 output repair + id hydration, per-frame usage-detail
 * defaulting), §4.7 non-stream aggregation, §6 compact passthrough (verbatim body, no
 * usage defaulting for object == response.compaction), §5.1 upstream error mapping incl.
 * the 401 -> auth_unavailable rewrite and the alphabetical-compact re-serialization of
 * JSON error bodies, §5.2 in-stream terminal failure synthesis (event: error for plain
 * clients, event: response.failed for codex-flavored clients, detail object from the
 * upstream error frame, sequence_number rules, the lead `\n`), §5.3 the
 * stream-disconnected request_timeout frame, and the two cooldown families whose state
 * lives in the Store (§5.1: the 429 -> 429 model_cooldown + Retry-After:
 * <reset_seconds> selection error with the Go duration reset_time; S2d9-18: the 404 ->
 * 503 auth_unavailable selection error embedding `<error.code>: <error.message>`).
 *
 * OUT of scope here (owned by S1/S4/S6, asserted by no fixture in this suite): client
 * authn enforcement and the 401 family, the CORS block, Date emission, R-404 routing,
 * Transfer-Encoding/Content-Encoding transport handling, keep-alive heartbeats (off in
 * the golden configuration), the WebSocket GET upgrade, /v1/alpha/search, usage queue
 * persistence, and the cooldown WINDOW DURATION policies (S4) — the suite pins only the
 * observable pairs (trigger response + window response at elapsed 0 under the frozen
 * clock).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * HARNESS SEMANTICS
 *
 * • FIXTURE LAYOUT (RECIPES, reports/oracle/BOOTSTRAP.md §7): per case meta.yaml (JSON),
 *   request.http (ONE recorded request: request line, head, blank line, exact body bytes),
 *   downstream.md (`## Status line` + `## Response headers (raw, received order)` + a
 *   `## Body ... (exact bytes received, N bytes)` fence whose content IS the exact body
 *   bytes — no writer newline to strip; the byte count in the heading is an integrity
 *   check — plus, for SSE cases, a `## Body (raw chunked stream as received)` fence that
 *   the inventory de-chunks and cross-checks against the decoded body), upstream.jsonl
 *   (ONE JSON line per emitted upstream request: ts/type/method/path/headers/body), and
 *   mock-response.json (the scripted mock behavior — exact-bytes scripts, no
 *   re-serialization). request.http heads and the raw-chunked fences were recorded with
 *   CRLF; files are CRLF-normalized on read and every compared surface is CR-free
 *   (verified across all 18 cases; a lone CR fails the suite).
 *
 * • ISOLATION + THE TWO PAIR SESSIONS. Every standalone case replays through a FRESH
 *   service + FRESH MemoryStore. The recording topology had to restart the reference
 *   between the error cases (each puts the credential into a cooldown that
 *   transient-error-cooldown-seconds: -1 does NOT disable), so the suite mirrors exactly
 *   the recorded back-to-back pairs and nothing else: (a) S2d9-11 then S2d9-12 — the 429
 *   and its immediate repeat recorded 5ms apart on one container — replay on ONE shared
 *   session with NO clock advance; (b) S2d9-10 then S2d9-18 — the 404 and the
 *   twice-fired observation — replay on ONE shared session, NO clock advance. A replay
 *   that short-circuits the first step fails loudly against its own golden; a replay that
 *   lets the second step reach the upstream fails the zero-call pin.
 *
 * • CLOCK. Real wall-clock time is never consulted: `now()` returns one frozen epoch-ms
 *   constant for every step. Both pair sessions replay at elapsed ≈ 0 inside windows of
 *   3600s (recorded) and "outlasts multi-second waits" (S2d9-18), so a spec-faithful
 *   implementation reports the FULL recorded window — Retry-After: 3600,
 *   reset_seconds: 3600, reset_time: "1h0m0s" — all byte-pinned, never masked.
 *
 * • MOCK UPSTREAM. Each case's scripted behavior comes verbatim from its own
 *   mock-response.json — no harness re-serialization anywhere: `sse_script_exact_bytes`
 *   is served as the exact upstream SSE bytes (single `\n`-separated frames are the
 *   RECORDED wire: the framer completes frames at their data line); S2d9-08's script
 *   ends with a `MOCK:` instruction line — the harness serves the SSE part, then closes
 *   the read (clean upstream close, no terminal event, §5.3); `writes.writes[]` is
 *   served one chunk per write (S2d9-17's split-payload / comment / no-space tricks;
 *   the recorded `sleep_after_ms` pacing is a dynamic field — never compared, never
 *   reproduced); `http_error` is served as the exact status + body bytes; the compact
 *   reply is served as exact bytes. Cases whose mock-response.json carries no script
 *   (S2d9-12, S2d9-16, S2d9-18) expect ZERO upstream calls; the harness sender throws
 *   if the adapter calls it.
 *
 * • Upstream calls are captured per step; after each step the captured count must equal
 *   the case's recorded wire-line count — this pins "no upstream call" for the
 *   gateway-local (S2d9-16) and window (S2d9-12, S2d9-18) steps — and the captured
 *   sequence must equal the recorded upstream.jsonl lines (count + bytes).
 *
 * • CLAUSE LAYER. On top of the byte golds, the captured wire and the produced
 *   downstream surface are checked against the semantic MUSTs that masking or byte
 *   equality alone would hide as unreadable failures: the resolved-model rewrite (never
 *   the alias), the forced/derived field rules, the §3.2 deletion list, the
 *   Session-Id == prompt_cache_key equality + UUID shape, the Lite dialect rules, the
 *   reasoning capability strip, the error-body layout family (alphabetical-compact
 *   re-serialization), the seq rules (data frames strictly +1 from 0; failure frame seq
 *   == data-frame count), the model echo asymmetry (stream created/in_progress get the
 *   alias when the upstream omitted model; the non-stream aggregate never injects), the
 *   per-frame usage-detail presence, and the output repair. These clauses restate
 *   §3-§5 in readable failures; they never loosen the byte gold.
 *
 * • DERIVED TEST (clearly labeled — no golden exists): the §4.2 response.done ->
 *   response.completed payload rename. The S2d9-02 script is patched so the terminal
 *   frame arrives as `event: response.done` + data `{"type":"response.done",...}`; the
 *   suite expects the recorded golden with exactly the terminal event line changed to
 *   `event: response.done` (event names are preserved — recorded wire note — while the
 *   data payload type is renamed to response.completed, the stream still terminates,
 *   and the WriteDone `\n` still lands). The event-line half of this expectation is
 *   interpretation (the spec pins only the payload rename); see OPEN QUESTIONS.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * COMPARISON RULES
 *
 * Upstream wire (primary gold):
 *   - method, url (recording origin + the recorded wire path — the adapter's baseUrl is
 *     the recording config's mock root and the §3.2/§6 suffix rules produce exactly that
 *     URL), body: byte-exact after the session mask. The raw-JSON edit discipline is
 *     pinned by this single comparison: untouched client keys keep their ORIGINAL byte
 *     spacing (e.g. `"stream": true`), rewritten values are re-serialized compactly in
 *     place (e.g. `"store": false`, the re-serialized input items of S2d9-04/05, the
 *     rebuilt `{"type":"web_search"}` tool), appended fields land in the recorded order
 *     (which differs per code path — S2d9-01 vs S2d9-04 vs S2d9-06 all append
 *     differently), and compact deletes the `stream` key mid-body. No clause restates
 *     byte layout; the wire gold is the layout contract.
 *   - headers: the full ordered list, names case-pinned to the recorded wire (Host,
 *     User-Agent, Content-Length, Accept, Authorization, Connection, Content-Type,
 *     Originator, Session-Id, [X-Openai-Internal-Codex-Responses-Lite], Accept-Encoding),
 *     which also pins the client-header whitelist: nothing the client sent beyond the
 *     forwarded names reaches the upstream, the cloaked User-Agent/Originator overwrite
 *     anything the client sent, and the Lite header is re-emitted with canonical MIME
 *     casing. `Content-Length` is excluded from the ordered compare and instead
 *     consistency-checked (if the adapter emits it, it must equal the body byte length).
 *     `Authorization` is redacted in the recordings; the adapter's value must start
 *     with "Bearer " and is normalized to "<redacted>". The `Host` port is masked per
 *     meta.yaml (`:<PORT>`). Recording-only `ts`/`type` fields of upstream.jsonl are not
 *     wire.
 *
 * Downstream (per step):
 *   - status: exact. Body: byte-exact — JSON bodies directly; SSE bodies compare as the
 *     DECODED byte stream per R-SSE (transport chunking of the adapter's own output is
 *     irrelevant; the harness reads the stream to completion), which here also pins the
 *     §4.2 framing layer because S2d9-17 goldens comment glue + `data: ` normalization
 *     + reassembly: every frame is `event: <type>\ndata: <json>` with a single space
 *     after each colon, LF endings, `\n\n` completion, terminal failure frames carry
 *     exactly ONE leading `\n`, a clean close appends the WriteDone lone `\n` (body ends
 *     `...\n\n\n`), a failure close does not, `data: [DONE]` never appears, nothing
 *     follows the first terminal event, and an upstream comment line is forwarded glued
 *     with `\n` onto the following frame. The decoder validates all of this while
 *     extracting frames for the clause layer.
 *   - headers: only the direction-owned subset is asserted: Content-Type (exact,
 *     including the recorded `application/json; charset=utf-8` variant on the
 *     gateway-local 400 of S2d9-16); Cache-Control (exact `no-cache` on SSE commits,
 *     ABSENT otherwise — pins "no SSE headers before commit" for every pre-frame JSON
 *     surface: the §5.1 error passthroughs, the §5.3 pre-frame variants, and the 400);
 *     Retry-After (exact when present — the only recorded value is S2d9-12's `3600`,
 *     byte-pinned under the frozen clock; absent when the recording has none).
 *   - `Date`, `X-Cpa-Trace-Id` and the other X-Cpa-*/X-Server-* headers, the CORS block,
 *     `Connection`, `Content-Length`, `Transfer-Encoding` are S1/transport/middleware
 *     territory and are not compared (trace: per the family ruling). Content-Length is
 *     consistency-checked when the adapter emits it.
 *
 * MASKS — applied identically to recorded and produced bytes, derived from each case's
 * meta.yaml `dynamic_fields_to_mask` (unknown entries fail the suite loudly):
 *   - Date / X-Cpa-* response headers: declared volatile; never compared (the header
 *     subset above already excludes them).
 *   - Session-Id / prompt_cache_key: masked where DERIVED (`<SESSION>` on the upstream
 *     header AND the upstream body field — the §3.2 equality is asserted UNMASKED by the
 *     clause layer, as is the UUID shape); kept byte-exact where the CLIENT fixed the
 *     value (S2d9-06's `sess-fix-123` is pinned verbatim on both surfaces).
 *   - ports: the upstream wire-log `Host` port suffix -> `:<PORT>` on both sides; the
 *     base-url port is a harness constant.
 *   - inter-write timing (S2d9-17 `sleep_after_ms`): recorded in meta only; never
 *     compared, never reproduced — the §4.2 chunk-boundary independence stands as
 *     recorded (the slow golden is byte-equality with the reassembled stream).
 *   - reset_time / reset_seconds (declared by S2d9-18's meta): S2d9-18's recorded body
 *     carries none; S2d9-12's literals are deterministic under the frozen clock and are
 *     byte-pinned, per its own meta (which does NOT declare them dynamic).
 *   - NOT masked anywhere: sequence numbers, `created_at` (canned mock constant), mock
 *     ids, usage shapes and key orders, model names, `last_upstream_error`, error
 *     messages, and every status code.
 */

import { readdir, readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { MemoryStore } from '@cpa-edge/core'
import type { Store } from '@cpa-edge/core'

// ─── Adapter load (skip-with-explanation until the real export ships) ────────────────

const ADAPTER_MODULE = '@cpa-edge/translators/codex-passthrough'
const ADAPTER_EXPORT = 'createCodexPassthroughService'

/** Structural mirror of the adapter interface documented in the header. */
type HeaderList = ReadonlyArray<readonly [string, string]>

interface ModelEntry {
  readonly name: string
  readonly alias?: string
  readonly forceMapping?: boolean
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
  readonly disableImageGeneration?: 'off' | 'true' | 'all' | 'chat' | 'passthrough'
}

interface PassthroughRequest {
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

interface PassthroughResponse {
  readonly status: number
  readonly headers: HeaderList
  readonly body: string | ReadableStream<Uint8Array>
}

interface PassthroughService {
  handleResponses(request: PassthroughRequest, send: UpstreamSender): Promise<PassthroughResponse>
}

type AdapterFactory = (options: ServiceOptions) => PassthroughService

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
        'All S2d9 golden cases SKIP until the codex-passthrough adapter ships; the required interface is documented in the header of this file.',
    }
  } catch (error) {
    return { skipReason: `import of \`${ADAPTER_MODULE}\` failed: ${String(error)}` }
  }
}

const adapterLoad = await loadAdapter()
const adapterFactory = adapterLoad.factory
const suite = adapterFactory ? describe : describe.skip
const suiteTitle = adapterFactory
  ? 'S2d9 — codex-passthrough golden contract (recorded fixtures)'
  : `S2d9 — codex-passthrough golden contract (SKIPPED: ${adapterLoad.skipReason ?? 'adapter unavailable'})`

// ─── Fixture access ───────────────────────────────────────────────────────────────────

const FIXTURE_ROOT = new URL('../fixtures/S2d9/', import.meta.url)

/** One frozen epoch-ms instant for every step of every case (see header: CLOCK). */
const FROZEN_NOW_MS = 1_789_506_658_000

/** Recording-instance values, transcribed from each meta.yaml / the recording config. */
const GATEWAY_API_KEY = 'oracle-local-key-1'
const UPSTREAM_API_KEY = 'mock-codex-key-1' // redacted ("<redacted>") in every wire log
const UPSTREAM_ORIGIN = 'http://host.docker.internal:20003'
const UPSTREAM_MODEL = 'mock-codex-upstream'
const MODEL_ALIAS = 'codex-mock'
const FORCED_MODEL_ALIAS = 'codex-mock-forced'
const CLOAKED_USER_AGENT = 'codex-tui/0.154.0 (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; 0.154.0)'
const CLOAKED_ORIGINATOR = 'codex-tui'
const LITE_HEADER_WIRE_NAME = 'X-Openai-Internal-Codex-Responses-Lite'
const VERSION_TAG = 'CLIProxyAPI v7.3.4'
const VERSION_COMMIT = '8335eac731946bd4eff18f500653f93736df53d6'
const VERSION_IMAGE_DIGEST = 'sha256:97825da3009f98acf78b5c172fde650a5fbe7a690950a69ce6d7b535d77d4266'
const RESPONSES_PATHS: ReadonlySet<string> = new Set(['/v1/responses', '/backend-api/codex/responses'])
const COMPACT_PATHS: ReadonlySet<string> = new Set(['/v1/responses/compact', '/backend-api/codex/responses/compact'])
const UPSTREAM_RESPONSES_PATH = '/responses'
const UPSTREAM_COMPACT_PATH = '/responses/compact'
/** The recorded wire header order; the Lite header (S2d9-07) slots before Accept-Encoding. */
const WIRE_HEADER_ORDER = [
  'Host',
  'User-Agent',
  'Content-Length',
  'Accept',
  'Authorization',
  'Connection',
  'Content-Type',
  'Originator',
  'Session-Id',
  'Accept-Encoding',
] as const

const EXPECTED_CASES = [
  'S2d9-01',
  'S2d9-02',
  'S2d9-03',
  'S2d9-04',
  'S2d9-05',
  'S2d9-06',
  'S2d9-07',
  'S2d9-08',
  'S2d9-09',
  'S2d9-10',
  'S2d9-11',
  'S2d9-12',
  'S2d9-13',
  'S2d9-14',
  'S2d9-15',
  'S2d9-16',
  'S2d9-17',
  'S2d9-18',
] as const

type CaseId = (typeof EXPECTED_CASES)[number]

/**
 * Cases that replay standalone against their recorded golden on a FRESH session. The
 * pair members are excluded — S2d9-11 + S2d9-12 and S2d9-10 + S2d9-18 replay together
 * through ONE shared session each, exactly as the oracle recorded them (see header:
 * ISOLATION + THE TWO PAIR SESSIONS).
 */
const STANDALONE_CASES: readonly CaseId[] = EXPECTED_CASES.filter(
  (caseId) => caseId !== 'S2d9-10' && caseId !== 'S2d9-11' && caseId !== 'S2d9-12' && caseId !== 'S2d9-18',
)

const fixtureCaseDirs = (await readdir(FIXTURE_ROOT, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()

function caseFile(caseId: string, name: string): URL {
  return new URL(`${caseId}/${name}`, FIXTURE_ROOT)
}

/**
 * request.http heads and the downstream.md raw-chunked fences were recorded with CRLF;
 * every compared surface is CR-free (verified across all 18 cases), so terminators
 * normalize on read and a surviving lone CR fails loudly.
 */
async function readFixtureText(caseId: string, name: string): Promise<string> {
  const raw = await readFile(caseFile(caseId, name), 'utf8')
  const normalized = raw.replaceAll('\r\n', '\n')
  if (normalized.includes('\r')) {
    throw new Error(`S2d9[${caseId}]: fixture file ${name} carries a lone CR byte after CRLF normalization`)
  }
  return normalized
}

async function readFixtureJson<T>(caseId: string, name: string): Promise<T> {
  return JSON.parse(await readFixtureText(caseId, name)) as T
}

async function readFixtureJsonIfExists<T>(caseId: string, name: string): Promise<T | undefined> {
  const entries = await readdir(new URL(`${caseId}/`, FIXTURE_ROOT), { withFileTypes: true })
  if (!entries.some((entry) => entry.isFile() && entry.name === name)) return undefined
  return readFixtureJson<T>(caseId, name)
}


// ─── Fixture file parsers (request.http / downstream.md / upstream.jsonl) ────────────

interface RecordedRequest {
  readonly method: string
  readonly path: string
  readonly headers: HeaderList
  readonly body: string
}

/**
 * request.http holds ONE recorded request: request line, head lines, a blank separator,
 * then the exact body bytes. The file's body is single-line JSON; the head/body split at
 * the first blank line and a trim of the file's final newline recover the exact sent
 * bytes (verified: parsed length == the recorded Content-Length, all cases).
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
  /** Byte count stated in the body heading — an integrity check the inventory asserts. */
  readonly claimedBodyBytes: number
  /** The `## Body (raw chunked stream as received)` fence, when the case recorded one. */
  readonly rawChunked: string | undefined
}

/**
 * downstream.md: a `## Status line` section, a `## Response headers (raw, received
 * order)` section, and a body fence under `## Body / byte stream (...)
 * (exact bytes received, N bytes)` — S2d9-18 uses the shorter `## Body (exact bytes
 * received, N bytes)` heading — plus, for SSE cases, the raw chunked-stream fence. The
 * fenced content IS the exact body bytes (the closing fence's newline belongs to the
 * fence, not the body — the claimed byte count cross-checks it), so nothing is stripped.
 */
function parseDownstreamFile(text: string): RecordedResponse {
  const statusMatch = /## Status line\n(HTTP\/1\.1[^\n]*)\n/.exec(text)
  if (statusMatch === null) throw new Error('downstream.md is missing the status line section')
  const status = Number((statusMatch[1] ?? '').split(' ')[1])
  if (!Number.isInteger(status) || status <= 0) {
    throw new Error(`downstream.md has an unparsable status line ${statusMatch[1] ?? ''}`)
  }

  const headersMatch = /## Response headers \(raw, received order\)\n([\s\S]*?)\n\n## /.exec(text)
  if (headersMatch === null) throw new Error('downstream.md is missing the response headers section')
  const headers: Array<[string, string]> = []
  for (const line of (headersMatch[1] ?? '').split('\n')) {
    const colon = line.indexOf(': ')
    if (colon <= 0) continue
    headers.push([line.slice(0, colon), line.slice(colon + 2)])
  }

  const bodyMatch = /## Body[^\n]*\(exact bytes received, (\d+) bytes\)\n```\n([\s\S]*?)\n```\n/.exec(text)
  if (bodyMatch === null) throw new Error('downstream.md is missing the body fence + byte count heading')
  const rawChunkedMatch = /## Body \(raw chunked stream as received\)\n```\n([\s\S]*?)\n```\n/.exec(text)
  return {
    status,
    headers,
    body: bodyMatch[2] ?? '',
    claimedBodyBytes: Number(bodyMatch[1]),
    rawChunked: rawChunkedMatch?.[1],
  }
}

/** One upstream.jsonl wire line (RECIPES layout: one JSON object per upstream request). */
interface WireLine {
  readonly method: string
  readonly path: string
  readonly headers: Record<string, string>
  readonly body: string
}

function parseWireLines(text: string): readonly WireLine[] {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const record = asRecordOrThrow(JSON.parse(line), 'upstream.jsonl line')
      return {
        method: stringField(record, 'method', 'upstream.jsonl'),
        path: stringField(record, 'path', 'upstream.jsonl'),
        headers: recordOf(record.headers, 'upstream.jsonl headers'),
        body: stringField(record, 'body', 'upstream.jsonl'),
      }
    })
}

interface MockWrite {
  readonly bytes?: string
  readonly sleep_after_ms?: number
}

interface MockFile {
  readonly mode?: string
  readonly upstream_call_count?: string
  readonly case_file?: string
  readonly note?: string
  readonly sse_script_exact_bytes?: string
  readonly http_error?: { readonly status?: unknown; readonly content_type?: unknown; readonly body?: unknown }
  readonly writes?: { readonly writes?: readonly unknown[] }
  readonly compact_reply_exact_bytes?: string
  readonly control_file?: string
  readonly mock_script?: string
}

interface CaseMeta {
  readonly case: string
  readonly purpose: string
  readonly anchor: string
  readonly recorded_at: string
  readonly dynamic_fields_to_mask: readonly string[]
  readonly config_fragment: string
  readonly expected_upstream_call_count?: string
  readonly observed_upstream_lines?: number
  readonly observed_http_status?: number
  readonly request?: { readonly method?: unknown; readonly path?: unknown }
  readonly notes?: readonly string[]
  readonly investigation?: {
    readonly results?: Readonly<Record<string, { readonly http_status?: unknown }>>
  }
  readonly observed_second_call?: { readonly status?: unknown; readonly body?: unknown; readonly upstream_calls?: unknown }
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

function asNumber(value: unknown): number | undefined {
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

function parseJsonRecord(text: string, context: string): Record<string, unknown> {
  return asRecordOrThrow(JSON.parse(text), `${context} (expected a JSON object)`)
}

// ─── Masking (meta.yaml dynamic_fields_to_mask → policy) ─────────────────────────────

/**
 * meta.yaml `dynamic_fields_to_mask` entries this harness recognizes; anything else
 * fails loudly. The two S2d9-18-only variants ("Date", "X-Cpa-* response headers",
 * "reset_time / reset_seconds in any cooldown envelope") are recognized alongside the
 * shared list every other case declares.
 */
const RECOGNIZED_DYNAMIC_FIELDS: ReadonlySet<string> = new Set([
  'Date response header',
  'Date',
  'X-Cpa-Trace-Id and other X-Cpa-*/X-Server-* response headers',
  'X-Cpa-* response headers',
  'upstream body prompt_cache_key (uuid) and header Session-Id when the client sent no prompt_cache_key',
  'nothing else is dynamic: mock ids (resp_mock_*), created_at 1742812800, ports, and key strings are fixed',
  'ports (8387/20003)',
  'reset_time / reset_seconds in any cooldown envelope',
])

function validateDynamicFields(caseId: string, dynamicFields: readonly string[]): void {
  for (const field of dynamicFields) {
    if (!RECOGNIZED_DYNAMIC_FIELDS.has(field)) {
      throw new Error(
        `S2d9[${caseId}]: unrecognized meta.yaml dynamic_fields_to_mask entry ${JSON.stringify(field)} — ` +
          'extend the mask table in tests/contract/s2d9-codex-passthrough.test.ts consciously',
      )
    }
  }
}

interface SessionPolicy {
  /** Mask the upstream `Session-Id` header value (`<SESSION>`)? */
  readonly header: boolean
  /** Mask the upstream body `prompt_cache_key` value (`<SESSION>`)? */
  readonly body: boolean
}

/**
 * Where the CLIENT fixed the session identity (a body prompt_cache_key — only S2d9-06
 * does) the recording keeps the value verbatim; derived values are masked on BOTH the
 * upstream header and the upstream body field. The §3.2 equality (header == body field)
 * and the UUID shape are asserted UNMASKED by the clause layer.
 */
function sessionPolicyFor(clientBody: Record<string, unknown>): SessionPolicy {
  return typeof clientBody.prompt_cache_key === 'string' ? { header: false, body: false } : { header: true, body: true }
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


// ─── Mock upstream: exact recorded bytes, scripted streams ─────────────────────────────

const encoder = new TextEncoder()

/** The one scripted upstream behavior a case drives. `none` = zero upstream calls. */
type MockScript =
  | { readonly kind: 'stream'; readonly bytes: string }
  | { readonly kind: 'stream-chunks'; readonly chunks: readonly string[] }
  | { readonly kind: 'error'; readonly status: number; readonly contentType: string; readonly body: string }
  | { readonly kind: 'json'; readonly status: number; readonly body: string }
  | { readonly kind: 'none' }

/**
 * Resolves the scripted upstream behavior per case from its mock-response.json — every
 * reply is served as EXACT recorded bytes (the harness never re-serializes):
 *   - `sse_script_exact_bytes`: the recorded upstream SSE wire. S2d9-08's script ends
 *     with a `MOCK:` instruction line ("wait 300ms ... then close the socket without any
 *     terminal event"): the SSE part is served, then the read closes cleanly (§5.3; the
 *     pacing is a dynamic field, never reproduced). The scripts separate frames with a
 *     single `\n` — the recorded mock wire the framer must handle.
 *   - `writes.writes[]`: one chunk per recorded write (S2d9-17's split payload, comment,
 *     and `data:`-without-space tricks; `sleep_after_ms` pacing is never reproduced).
 *   - `http_error`: the exact upstream error status + body bytes.
 *   - `compact_reply_exact_bytes`: the exact 200 compact reply.
 *   - no script (S2d9-12, S2d9-16, S2d9-18): the step expects ZERO upstream calls.
 */
async function resolveMockScript(caseId: CaseId): Promise<MockScript> {
  const mockFile = asRecordOrThrow(
    (await readFixtureJsonIfExists<unknown>(caseId, 'mock-response.json')) ?? {},
    `${caseId} mock-response.json`,
  )
  const httpError = asRecord(mockFile.http_error)
  if (httpError !== undefined) {
    const status = asNumber(httpError.status)
    const contentType = asString(httpError.content_type)
    const body = asString(httpError.body)
    if (status === undefined || contentType === undefined || body === undefined) {
      throw new Error(`S2d9[${caseId}]: http_error must carry { status, content_type, body }`)
    }
    return { kind: 'error', status, contentType, body }
  }
  const scriptBytes = asString(mockFile.sse_script_exact_bytes)
  if (scriptBytes !== undefined) {
    const mockNoteIndex = scriptBytes.indexOf('\nMOCK:')
    if (mockNoteIndex >= 0) {
      return { kind: 'stream', bytes: scriptBytes.slice(0, mockNoteIndex) }
    }
    return { kind: 'stream', bytes: scriptBytes }
  }
  const writesWrapper = asRecord(mockFile.writes)
  const rawWrites = writesWrapper === undefined ? undefined : asArray(writesWrapper.writes)
  if (rawWrites !== undefined) {
    const chunks: string[] = []
    for (const [index, entry] of rawWrites.entries()) {
      const write = asRecordOrThrow(entry, `S2d9[${caseId}] writes[${index}]`)
      chunks.push(stringField(write, 'bytes', `S2d9[${caseId}] writes[${index}]`))
    }
    if (chunks.length === 0) throw new Error(`S2d9[${caseId}]: writes control carries no write entries`)
    return { kind: 'stream-chunks', chunks }
  }
  const compactReply = asString(mockFile.compact_reply_exact_bytes)
  if (compactReply !== undefined) {
    return { kind: 'json', status: 200, body: compactReply }
  }
  return { kind: 'none' }
}

/**
 * Demand-driven byte stream: every pull hands out one chunk; the read after the last
 * chunk closes normally (a clean upstream close — S2d9-08's no-terminal disconnect and
 * the post-terminal EOF of every happy script are the same transport event).
 */
function scriptedByteStream(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
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

function buildMockUpstreamResponse(script: MockScript): UpstreamResponse | undefined {
  if (script.kind === 'none') return undefined
  if (script.kind === 'error') {
    return {
      status: script.status,
      headers: [['Content-Type', script.contentType]],
      body: scriptedByteStream([encoder.encode(script.body)]),
    }
  }
  if (script.kind === 'json') {
    return {
      status: script.status,
      headers: [['Content-Type', 'application/json']],
      body: scriptedByteStream([encoder.encode(script.body)]),
    }
  }
  if (script.kind === 'stream') {
    return {
      status: 200,
      headers: [['Content-Type', 'text/event-stream']],
      body: scriptedByteStream([encoder.encode(script.bytes)]),
    }
  }
  return {
    status: 200,
    headers: [['Content-Type', 'text/event-stream']],
    body: scriptedByteStream(script.chunks.map((chunk) => encoder.encode(chunk))),
  }
}

// ─── Downstream SSE: framing decoder + R-SSE comparison ──────────────────────────────

/** Terminal event names of the downstream Responses stream (spec §4.2/§5.2). */
const TERMINAL_EVENT_NAMES: ReadonlySet<string> = new Set([
  'response.completed',
  'response.incomplete',
  'response.failed',
  'response.done',
  'error',
])

/** In-stream failure events (spec §5.2): the only frames allowed a leading `\n`. */
const FAILURE_EVENT_NAMES: ReadonlySet<string> = new Set(['response.failed', 'error'])

interface SseFrame {
  readonly event: string | undefined
  readonly data: string
  readonly comments: readonly string[]
}

interface DecodedSse {
  readonly frames: readonly SseFrame[]
  /** Per frame: was it preceded by the §5.2 leading `\n` (failure frames only). */
  readonly failureLead: readonly boolean[]
  /** The §4.2 WriteDone lone `\n` after the last frame (clean closes only). */
  readonly trailingWriteDone: boolean
}

/**
 * Decodes a downstream SSE body under the §4.1/§4.2 byte rules and enforces the framing
 * contract while decoding: the body splits into `\n\n`-terminated frame blocks whose
 * tail is either empty or the WriteDone `\n`; every data line is prefixed `data: `
 * (single space — a `data:`-without-space normalization failure is a contract breach);
 * comment lines (the S2d9-17 `: keepalive` glue) ride inside the block they were glued
 * to; terminal failure frames carry exactly one leading `\n` and no other frame does;
 * nothing follows the first terminal event; and `data: [DONE]` never appears
 * downstream. Used on the recorded goldens (inventory + replay validation) and on the
 * produced surface (clause extraction) — the byte comparison itself is whole-body.
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
    let event: string | undefined
    let data: string | undefined
    const comments: string[] = []
    for (const line of text.split('\n')) {
      if (line.startsWith('event: ')) {
        if (event !== undefined) throw new Error(`${context}: a frame block carries two event lines — ${JSON.stringify(text.slice(0, 80))}`)
        event = line.slice('event: '.length)
      } else if (line.startsWith('data: ')) {
        if (data !== undefined) throw new Error(`${context}: a frame block carries two data lines — ${JSON.stringify(text.slice(0, 80))}`)
        data = line.slice('data: '.length)
      } else if (line.startsWith('data:')) {
        throw new Error(`${context}: data lines must be re-prefixed \`data: \` (single space) — found ${JSON.stringify(line)}`)
      } else if (line.startsWith(':')) {
        comments.push(line)
      } else {
        throw new Error(`${context}: unrecognized SSE line ${JSON.stringify(line)}`)
      }
    }
    if (data === undefined) {
      throw new Error(`${context}: a frame block carries no data line — ${JSON.stringify(text.slice(0, 80))}`)
    }
    if (data === '[DONE]') {
      throw new Error(`${context}: a data: [DONE] frame must never appear downstream (§4.2 — terminal markers are the completed/incomplete/failed/error events)`)
    }
    if (terminalSeen) {
      throw new Error(`${context}: events after the terminal event must be dropped (§4.2) — found ${JSON.stringify(event ?? data.slice(0, 40))}`)
    }
    const isFailure = event !== undefined && FAILURE_EVENT_NAMES.has(event)
    if (isFailure && !lead) {
      throw new Error(`${context}: the terminal failure frame must be written after one leading \\n (§5.2)`)
    }
    if (lead && !isFailure) {
      throw new Error(`${context}: only terminal failure frames may carry the leading \\n — found on ${JSON.stringify(event)}`)
    }
    terminalSeen = event !== undefined && TERMINAL_EVENT_NAMES.has(event)
    frames.push({ event, data, comments })
    failureLead.push(lead)
  }
  return { frames, failureLead, trailingWriteDone: tail === '\n' }
}

/**
 * Sequence-number rules (§4.2 recorded mock scripts, §5.2/§5.3 synthesized frames):
 * data frames number strictly +1 from 0; a terminal failure frame carries the count of
 * data frames already forwarded.
 */
function assertSequenceNumbers(decoded: DecodedSse, context: string): void {
  let dataFrameCount = 0
  for (const [index, frame] of decoded.frames.entries()) {
    const payload = parseJsonRecord(frame.data, `${context}: frame ${index} payload`)
    const sequenceNumber = payload.sequence_number
    const isFailure = frame.event !== undefined && FAILURE_EVENT_NAMES.has(frame.event)
    expect(
      typeof sequenceNumber === 'number' && Number.isInteger(sequenceNumber),
      `${context}: frame ${index} carries an integer sequence_number`,
    ).toBe(true)
    expect(sequenceNumber, `${context}: frame ${index} sequence_number (${isFailure ? 'failure frame == data-frame count' : 'data frame == strict +1'})`).toBe(
      dataFrameCount,
    )
    if (!isFailure) dataFrameCount += 1
  }
}

// ─── Comparison helpers ───────────────────────────────────────────────────────────────

function headerValue(headers: HeaderList, name: string): string | undefined {
  const key = name.toLowerCase()
  for (const [headerName, value] of headers) {
    if (headerName.toLowerCase() === key) return value
  }
  return undefined
}

async function readResponseBody(body: PassthroughResponse['body']): Promise<string> {
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

function truncate(text: string): string {
  return text.length > 200 ? `${text.slice(0, 200)}…` : text
}
