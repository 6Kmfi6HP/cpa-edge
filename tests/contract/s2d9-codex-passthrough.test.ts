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
 * event-stop + the response.done -> response.completed frame rename (event line AND
 * payload type), the WriteDone trailing `\n`, §4.3 model injection into created/in_progress and force-mapping rewrites
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
 *   per-frame usage-detail presence (BOTH detail objects on every usage; values
 *   forwarded VERBATIM when the upstream sent them — S2d9-02's 3/5 — and 0 injected
 *   only where the upstream omitted them), and the output repair. These clauses restate
 *   §3-§5 in readable failures; they never loosen the byte gold.
 *
 * • DERIVED TEST (clearly labeled — no golden exists): the §4.2 response.done ->
 *   response.completed rename. The S2d9-02 script is patched so the terminal frame
 *   arrives as `event: response.done` + data `{"type":"response.done",...}`; per the
 *   orchestrator ruling (2026-09-16) the reference renames the frame BEFORE forwarding
 *   (the same completion-normalization path the S2d5 family documented): BOTH the
 *   event line and the payload type come back as response.completed, so the expected
 *   downstream surface is the recorded S2d9-02 golden BYTE-IDENTICAL — the rename must
 *   fully normalize the frame, the stream still terminates on it, and the WriteDone
 *   `\n` still lands. The inventory asserts the surgery anchors.
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
 *   - `Date`, `X-Cpa-Trace-Id` and the other X-Cpa-* and X-Server-* headers, the CORS block,
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


// ─── Upstream wire comparison (primary gold) ──────────────────────────────────────────

interface CapturedUpstreamCall {
  readonly step: number
  readonly request: RecordedRequest
  readonly call: UpstreamRequest
}

function assertUpstreamWire(
  recorded: WireLine,
  captured: CapturedUpstreamCall,
  policy: SessionPolicy,
  caseId: string,
): void {
  const context = `S2d9[${caseId}] step ${captured.step} upstream wire`
  expect(captured.call.method, `${context}: method`).toBe(recorded.method)
  expect(captured.call.url, `${context}: url (recording origin + recorded wire path; §3.2/§6 suffix rules)`).toBe(
    `${UPSTREAM_ORIGIN}${recorded.path}`,
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
  expect(
    normalizeUpstreamBody(captured.call.body, policy),
    `${context}: translated body bytes (session-masked; raw-JSON edit discipline pinned byte-exact)`,
  ).toBe(normalizeUpstreamBody(recorded.body, policy))
}

// ─── Downstream comparison (per step) ────────────────────────────────────────────────

interface DownstreamAssertionResult {
  readonly body: string
  readonly decoded: DecodedSse | undefined
}

async function assertDownstreamStep(
  produced: PassthroughResponse,
  expected: RecordedResponse,
  caseId: string,
  step: number,
): Promise<DownstreamAssertionResult> {
  const context = `S2d9[${caseId}] step ${step} downstream`
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

  const expectedRetryAfter = headerValue(expected.headers, 'retry-after')
  const retryAfter = headerValue(produced.headers, 'retry-after')
  if (expectedRetryAfter === undefined) {
    expect(retryAfter, `${context}: Retry-After must be absent when the recording has none`).toBeUndefined()
  } else {
    // Never masked: the only recorded value is the S2d9-12 cooldown literal "3600",
    // deterministic under the frozen clock (see header: CLOCK).
    expect(retryAfter, `${context}: Retry-After`).toBe(expectedRetryAfter)
  }

  const producedContentLength = headerValue(produced.headers, 'content-length')
  if (producedContentLength !== undefined) {
    expect(producedContentLength, `${context}: Content-Length must match the body byte length when emitted`).toBe(
      String(encoder.encode(body).length),
    )
  }

  if (expectedContentType === 'text/event-stream') {
    // R-SSE: the DECODED byte stream is the comparison surface (the adapter's own
    // transport chunking is irrelevant — the harness reads the stream to completion).
    // S2d9-17 goldens the framing layer, so the decoded stream itself is byte-pinned.
    expect(body, `${context}: decoded SSE byte stream (framing + payloads)`).toBe(expected.body)
    const recordedDecoded = decodeDownstreamSse(expected.body, `${context}: recorded`)
    const producedDecoded = decodeDownstreamSse(body, `${context}: produced`)
    expect(producedDecoded.trailingWriteDone, `${context}: the WriteDone trailing \\n must land exactly where recorded`).toBe(
      recordedDecoded.trailingWriteDone,
    )
    expect(producedDecoded.failureLead, `${context}: failure frames must carry the §5.2 leading \\n exactly where recorded`).toEqual(
      recordedDecoded.failureLead,
    )
    return { body, decoded: producedDecoded }
  }
  expect(body, `${context}: body bytes`).toBe(expected.body)
  return { body, decoded: undefined }
}

// ─── Clause layer (semantic MUSTs that byte equality hides as unreadable failures) ─────

/** Every frame payload that carries a usage object (response.usage or usage). */
function usageObjectsOf(payload: Record<string, unknown>): readonly Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  const responseUsage = asRecord(asRecord(payload.response)?.usage)
  if (responseUsage !== undefined) out.push(responseUsage)
  const topLevelUsage = asRecord(payload.usage)
  if (topLevelUsage !== undefined) out.push(topLevelUsage)
  return out
}

/**
 * The upstream's own usage-detail values for one case, extracted from its mock script:
 * §4.2/§4.7 INJECTS `reasoning_tokens: 0` / `cached_tokens: 0` only where the upstream
 * omitted them — upstream-provided values (S2d9-02 sends 3 / 5) are forwarded VERBATIM.
 * An absent member means "the mock omitted it -> the gateway injects 0".
 */
interface UsageExpectation {
  readonly reasoningTokens?: unknown
  readonly cachedTokens?: unknown
}

/** Reads the LAST usage-carrying frame of the case's mock script (the terminal in every golden). */
function mockUsageExpectation(script: MockScript, caseId: string): UsageExpectation {
  if (script.kind !== 'stream' && script.kind !== 'stream-chunks') return {}
  const scriptBytes = script.kind === 'stream' ? script.bytes : script.chunks.join('')
  let expectation: UsageExpectation = {}
  for (const frame of scriptFramesOf(scriptBytes, `S2d9[${caseId}] mock usage expectation`)) {
    const payload = parseJsonRecord(frame.data, `S2d9[${caseId}] mock usage expectation frame`)
    const usage = asRecord(asRecord(payload.response)?.usage) ?? asRecord(payload.usage)
    if (usage !== undefined) {
      expectation = {
        reasoningTokens: asRecord(usage.output_tokens_details)?.reasoning_tokens,
        cachedTokens: asRecord(usage.input_tokens_details)?.cached_tokens,
      }
    }
  }
  return expectation
}

/** §4.2/§4.7: BOTH detail objects exist on every usage; values pass through verbatim, 0 only when the upstream omitted them. */
function assertUsageDetailsPresent(
  usage: Record<string, unknown>,
  context: string,
  expected: UsageExpectation,
): void {
  const outputDetails = asRecord(usage.output_tokens_details)
  const inputDetails = asRecord(usage.input_tokens_details)
  expect(outputDetails, `${context}: output_tokens_details object present (injected when the upstream omitted it)`).toBeDefined()
  expect(inputDetails, `${context}: input_tokens_details object present (injected when the upstream omitted it)`).toBeDefined()
  expect(
    outputDetails?.reasoning_tokens,
    `${context}: reasoning_tokens (upstream value forwarded verbatim; 0 only when the mock omitted it)`,
  ).toBe(expected.reasoningTokens ?? 0)
  expect(
    inputDetails?.cached_tokens,
    `${context}: cached_tokens (upstream value forwarded verbatim; 0 only when the mock omitted it)`,
  ).toBe(expected.cachedTokens ?? 0)
}

/** The §5.1 re-serialization family: gateway-generated layout, alphabetical + compact. */
function canonicalCompact(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value)
  if (Array.isArray(value)) return `[${value.map(canonicalCompact).join(',')}]`
  const record = asRecordOrThrow(value, 'canonicalCompact')
  const entries = Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalCompact(entry)}`).join(',')}}`
}

function assertUpstreamClauses(
  caseId: CaseId,
  captured: CapturedUpstreamCall,
  policy: SessionPolicy,
): void {
  const context = `S2d9[${caseId}] step ${captured.step} upstream clauses`
  const body = parseJsonRecord(captured.call.body, `${context}: translated body`)
  const client = parseJsonRecord(captured.request.body, `${context}: client body`)
  const isLite =
    headerValue(captured.request.headers, 'x-openai-internal-codex-responses-lite')?.trim().toLowerCase() === 'true'

  // §3.2: the upstream model field is the RESOLVED name, never the client alias —
  // force-mapping rewrites only the DOWNSTREAM echo, not the upstream request.
  expect(body.model, `${context}: model is the resolved upstream name`).toBe(UPSTREAM_MODEL)

  const sessionHeader = headerValue(captured.call.headers, 'session-id')
  const bodyCacheKey = asString(body.prompt_cache_key)
  const clientCacheKey = asString(client.prompt_cache_key)
  if (clientCacheKey !== undefined) {
    // §3.2 (S2d9-06): a client-fixed prompt_cache_key passes verbatim on BOTH surfaces
    // and becomes the Session-Id header.
    expect(sessionHeader, `${context}: Session-Id header == client prompt_cache_key (verbatim)`).toBe(clientCacheKey)
    expect(bodyCacheKey, `${context}: body prompt_cache_key == client prompt_cache_key (verbatim)`).toBe(clientCacheKey)
  } else {
    // §3.2: the derived session UUID is mirrored: header == body field, UUID shape.
    expect(sessionHeader, `${context}: derived §3.2 identity equality (header == body prompt_cache_key)`).toBe(bodyCacheKey)
    expect(bodyCacheKey, `${context}: derived identity is a UUID`).toMatch(UUID_RE)
    expect(sessionHeader, `${context}: derived identity is a UUID`).toMatch(UUID_RE)
  }
  if (policy.header) {
    // belt-and-braces: the masked surfaces really carried distinct per-request values
    expect(sessionHeader, `${context}: masked header still holds the unmasked derived value`).toBeDefined()
  }

  // §3.2: cloaking runs LAST — the fixed codex-tui identity overwrites everything.
  expect(headerValue(captured.call.headers, 'user-agent'), `${context}: cloaked User-Agent`).toBe(CLOAKED_USER_AGENT)
  expect(headerValue(captured.call.headers, 'originator'), `${context}: cloaked Originator`).toBe(CLOAKED_ORIGINATOR)
  expect(headerValue(captured.call.headers, 'accept-encoding'), `${context}: Accept-Encoding`).toBe('gzip')
  expect(headerValue(captured.call.headers, 'connection'), `${context}: Connection`).toBe('Keep-Alive')
  expect(headerValue(captured.call.headers, 'content-type'), `${context}: Content-Type`).toBe('application/json')

  if (COMPACT_PATHS.has(captured.request.path)) {
    // §6 compact passthrough: stream DELETED, no store/include forcing, no tool
    // injection, near-verbatim input; upstream is a plain JSON call.
    expect(Object.hasOwn(body, 'stream'), `${context}: compact bodies delete the stream key`).toBe(false)
    expect(Object.hasOwn(body, 'store'), `${context}: compact bodies never gain a forced store`).toBe(false)
    expect(Object.hasOwn(body, 'include'), `${context}: compact bodies never gain a forced include`).toBe(false)
    expect(Object.hasOwn(body, 'tools'), `${context}: compact bodies never gain injected tools`).toBe(false)
    if (isLite && typeof client.instructions !== 'string') {
      // §6 + §3.3: a native-Lite compact request with no instructions gains no default.
      expect(Object.hasOwn(body, 'instructions'), `${context}: Lite compact bodies gain no defaulted instructions`).toBe(false)
    } else {
      expect(body.instructions, `${context}: compact instructions (client value or the §3.2 default)`).toBe(
        typeof client.instructions === 'string' ? client.instructions : '',
      )
    }
    expect(body.input, `${context}: compact input passes verbatim`).toEqual(client.input)
    expect(headerValue(captured.call.headers, 'accept'), `${context}: compact upstream Accept`).toBe('application/json')
    expect(asString(body.prompt_cache_key), `${context}: compact attaches the same derived cache key`).toBeDefined()
    return
  }

  // §3.2/§4.1: the upstream is ALWAYS SSE on /responses, stream and non-stream clients.
  expect(body.stream, `${context}: stream flag (always-SSE)`).toBe(true)
  expect(headerValue(captured.call.headers, 'accept'), `${context}: SSE Accept header`).toBe('text/event-stream')

  // §3.2 canonical constants.
  expect(body.store, `${context}: store forced false`).toBe(false)
  expect(body.include, `${context}: include forced`).toEqual(['reasoning.encrypted_content'])
  expect(body.parallel_tool_calls, `${context}: parallel_tool_calls (Lite forces false, §3.3)`).toBe(!isLite)
  if (isLite && typeof client.instructions !== 'string') {
    // §3.3: native Lite leaves absent instructions ABSENT (no "" default).
    expect(Object.hasOwn(body, 'instructions'), `${context}: Lite requests gain no defaulted instructions`).toBe(false)
  } else {
    expect(body.instructions, `${context}: instructions (client value preserved, else defaulted "")`).toBe(
      typeof client.instructions === 'string' ? client.instructions : '',
    )
  }

  if (isLite) {
    // §3.3 native Lite: NO image_generation injection, Lite header forwarded upstream
    // (recorded with canonical MIME casing — the wire gold pins the exact name).
    expect(Object.hasOwn(body, 'tools'), `${context}: Lite requests gain no injected tools`).toBe(false)
    expect(headerValue(captured.call.headers, 'x-openai-internal-codex-responses-lite'), `${context}: Lite header forwarded`).toBe(
      'true',
    )
  } else {
    // §3.2 tools row (disable-image-generation: off — the recorded default): the
    // image_generation tool is INJECTED as the LAST tools element.
    const tools = asArray(body.tools)
    expect(tools, `${context}: tools array`).toBeDefined()
    expect(tools?.[tools.length - 1], `${context}: injected image_generation tool appended LAST`).toEqual({
      type: 'image_generation',
      output_format: 'png',
    })
  }

  if (caseId === 'S2d9-04') {
    // §3.2 input rewrites: system -> developer; builtin alias web_search_preview ->
    // web_search (byte gold pins the layout — untouched client elements keep their
    // original spacing, rewritten elements re-serialize compactly).
    const input = asArray(body.input) ?? []
    expect(asRecord(input[0])?.role, `${context}: system role rewritten to developer`).toBe('developer')
    expect(asRecord(input[1])?.role, `${context}: user role untouched`).toBe('user')
    const tools = (asArray(body.tools) ?? []).map((tool) => asRecord(tool))
    expect(asRecord(tools[0])?.name, `${context}: client function tool preserved`).toBe('get_weather')
    expect(tools[1], `${context}: web_search_preview normalized to web_search`).toEqual({ type: 'web_search' })
    expect(tools[2], `${context}: image_generation appended after the normalized builtin`).toEqual({
      type: 'image_generation',
      output_format: 'png',
    })
  }

  if (caseId === 'S2d9-05') {
    // §3.2 reasoning-row divergence, RECORDED: the capability-less model strips the
    // whole top-level reasoning object (the fixture outranks §3.2's PRESERVED prose —
    // see header). The reasoning-ITEM sanitization rules are pinned next.
    expect(Object.hasOwn(body, 'reasoning'), `${context}: reasoning object stripped (recorded capability default)`).toBe(false)
    const input = (asArray(body.input) ?? []).map((item) => asRecord(item))
    expect(input.length, `${context}: four input items survive`).toBe(4)
    const valid = input[0]
    const orphan = input[1]
    const invalid = input[2]
    const message = input[3]
    expect(valid?.id, `${context}: valid encrypted_content keeps the item id`).toBe('rs_valid_1')
    expect(asString(valid?.encrypted_content)?.startsWith('gAAAA'), `${context}: valid encrypted_content preserved`).toBe(true)
    expect(Object.hasOwn(orphan ?? {}, 'id'), `${context}: orphan reasoning item loses its id (store=false rule)`).toBe(false)
    expect(Object.hasOwn(invalid ?? {}, 'id'), `${context}: invalid-encrypted reasoning item loses its id`).toBe(false)
    expect(Object.hasOwn(invalid ?? {}, 'encrypted_content'), `${context}: invalid encrypted_content dropped`).toBe(false)
    expect(asRecord(message)?.role, `${context}: the trailing message item is untouched`).toBe('user')
  }

  if (caseId === 'S2d9-06') {
    // §3.2 deletion list + the stream_options carve-out + preserved passthroughs.
    for (const dropped of [
      'previous_response_id',
      'truncation',
      'user',
      'temperature',
      'top_p',
      'max_output_tokens',
      'service_tier',
      'prompt_cache_retention',
      'safety_identifier',
      'generate',
    ]) {
      expect(Object.hasOwn(body, dropped), `${context}: whitelist drop — ${dropped} must not reach the upstream`).toBe(false)
    }
    expect(body.stream_options, `${context}: stream_options reduced to reasoning_summary_delivery`).toEqual({
      reasoning_summary_delivery: 'consequential',
    })
    expect(body.metadata, `${context}: metadata preserved verbatim`).toEqual({ trace: 't1' })
  }
}

function assertDownstreamClauses(
  caseId: CaseId,
  result: DownstreamAssertionResult,
  clientBody: Record<string, unknown>,
  usageExpectation: UsageExpectation,
): void {
  const context = `S2d9[${caseId}] downstream clauses`
  const clientModel = asString(clientBody.model)

  if (result.decoded === undefined) {
    const body = parseJsonRecord(result.body, context)
    const error = asRecord(body.error)
    switch (caseId) {
      case 'S2d9-01':
      case 'S2d9-04': {
        // §4.7 aggregation: the terminal response object, model NOT injected (§4.3:
        // the non-stream path never injects), output repaired from output_item.done,
        // usage details defaulted in the recorded append order.
        expect(body.model, `${context}: aggregated model is the upstream name (never injected)`).toBe(UPSTREAM_MODEL)
        const output = asArray(body.output)
        expect(output?.length, `${context}: output rebuilt from output_item.done items`).toBeGreaterThan(0)
        const usage = asRecordOrThrow(body.usage, `${context}: aggregated usage`)
        assertUsageDetailsPresent(usage, context, usageExpectation)
        expect(Object.keys(usage), `${context}: usage key order (details appended after total_tokens)`).toEqual([
          'input_tokens',
          'output_tokens',
          'total_tokens',
          'output_tokens_details',
          'input_tokens_details',
        ])
        return
      }
      case 'S2d9-09': {
        // §5.1: the 401 rewrite — classified auth_unavailable body, alphabetical layout.
        expect(error?.code, `${context}: 401 rewritten to auth_unavailable`).toBe('auth_unavailable')
        expect(error?.message, `${context}: upstream message preserved`).toBe('Invalid token')
        expect(error?.type, `${context}: upstream type preserved`).toBe('authentication_error')
        expect(result.body, `${context}: body is the canonical alphabetical-compact re-serialization`).toBe(
          canonicalCompact(parseJsonRecord(result.body, context)),
        )
        return
      }
      case 'S2d9-10':
      case 'S2d9-11': {
        // §5.1: everything-else passthrough, re-serialized with observed fields intact.
        expect(result.body, `${context}: body is the canonical alphabetical-compact re-serialization`).toBe(
          canonicalCompact(parseJsonRecord(result.body, context)),
        )
        return
      }
      case 'S2d9-12': {
        // §5.1/§9.3: the rate-limit cooldown selection error — Retry-After comes from
        // the 429 body's resets_in_seconds; the window literals are byte-pinned.
        expect(error?.code, `${context}: model_cooldown family`).toBe('model_cooldown')
        expect(error?.provider, `${context}: provider`).toBe('codex')
        expect(error?.model, `${context}: model is the client-facing alias`).toBe(clientModel)
        expect(error?.reset_seconds, `${context}: reset_seconds == the 429 body's resets_in_seconds`).toBe(3600)
        expect(error?.reset_time, `${context}: reset_time is the Go duration string`).toBe('1h0m0s')
        expect(error?.last_upstream_error, `${context}: last_upstream_error == "<error.code>: <error.message>"`).toBe(
          'usage_limit_reached: You have exceeded your usage limit',
        )
        expect(result.body, `${context}: body is the canonical alphabetical-compact re-serialization`).toBe(
          canonicalCompact(parseJsonRecord(result.body, context)),
        )
        return
      }
      case 'S2d9-16': {
        // §5.4: the compact stream:true rejection — gateway-synthesized, zero upstream.
        expect(body, `${context}: exact gateway-synthesized 400 body`).toEqual({
          error: { message: 'Streaming not supported for compact responses', type: 'invalid_request_error' },
        })
        return
      }
      case 'S2d9-18': {
        // §5.1/§9.3: the 404-cooldown selection error — the 503 auth_unavailable
        // family carries the gateway struct layout (message, type, code — NOT
        // alphabetical; the byte gold pins the layout) and embeds the last upstream
        // error as "<error.code>: <error.message>".
        expect(error?.type, `${context}: server_error type`).toBe('server_error')
        expect(error?.code, `${context}: internal_server_error code`).toBe('internal_server_error')
        const message = asString(error?.message)
        expect(message?.startsWith('auth_unavailable: no auth available (providers=codex, model='), `${context}: auth_unavailable message head`).toBe(true)
        expect(message?.includes('last upstream error: model_not_found: model not found: mock-codex-upstream'), `${context}: embedded last upstream error`).toBe(true)
        return
      }
      case 'S2d9-15': {
        // §6: compact passthrough — upstream body VERBATIM, no usage defaulting for
        // object == response.compaction.
        expect(body.object, `${context}: compaction object marker`).toBe('response.compaction')
        expect(Object.hasOwn(body, 'usage'), `${context}: no usage defaulting on compaction bodies`).toBe(false)
        return
      }
      default:
        return
    }
  }

  // SSE clause layer.
  const frames = result.decoded.frames
  assertSequenceNumbers(result.decoded, context)
  const lastFrame = frames[frames.length - 1]
  const lastEvent = lastFrame?.event ?? ''
  const isFailureLast = FAILURE_EVENT_NAMES.has(lastEvent)

  for (const frame of frames) {
    const payload = parseJsonRecord(frame.data, `${context}: ${frame.event ?? 'data'} payload`)
    // §4.2: per-frame usage-detail defaulting on every forwarded chunk with a usage —
    // detail objects always present; values verbatim from the upstream, 0 injected
    // only where the mock omitted them (S2d9-02 sends 3 / 5).
    for (const usage of usageObjectsOf(payload)) {
      assertUsageDetailsPresent(usage, `${context}: ${frame.event ?? 'data'} usage`, usageExpectation)
    }
    if (frame.event === 'response.created' || frame.event === 'response.in_progress') {
      // §4.3: created/in_progress always carry a model — injected when the upstream
      // omitted it, preserved when present, force-mapped when configured.
      const response = asRecordOrThrow(payload.response, `${context}: ${frame.event} response object`)
      expect(response.model, `${context}: ${frame.event} carries response.model (§4.3)`).toBeDefined()
    }
  }

  if (caseId === 'S2d9-02') {
    // §4.3 model injection: the mock's response.created carries NO model; the gateway
    // injects the client-requested alias (byte position pinned by the gold).
    const created = parseJsonRecord(frames[0]?.data ?? '{}', `${context}: response.created payload`)
    expect(asRecord(created.response)?.model, `${context}: injected model is the client-requested alias`).toBe(clientModel)
  }
  if (caseId === 'S2d9-03') {
    // §4.3 force-mapping: EVERY model field in EVERY payload is the alias, overriding
    // the upstream-provided values.
    for (const frame of frames) {
      const payload = parseJsonRecord(frame.data, `${context}: ${frame.event ?? 'data'} payload`)
      const response = asRecord(payload.response)
      if (response !== undefined) {
        expect(response.model, `${context}: force-mapped response.model`).toBe(FORCED_MODEL_ALIAS)
      }
    }
  }
  if (caseId === 'S2d9-02' || caseId === 'S2d9-03' || caseId === 'S2d9-05' || caseId === 'S2d9-06' || caseId === 'S2d9-07' || caseId === 'S2d9-17') {
    // §4.6 output repair: the mock's terminal frame ships an EMPTY output; the gateway
    // rebuilds it from the recorded output_item.done items. (The derived replay of
    // S2d9-02 terminates with response.completed — the §4.2 rename normalizes the
    // response.done frame before forwarding.)
    const terminal = frames.find(
      (frame) => frame.event === 'response.completed' || frame.event === 'response.done',
    )
    const payload = parseJsonRecord(terminal?.data ?? '{}', `${context}: terminal payload`)
    const output = asArray(asRecordOrThrow(payload.response, `${context}: terminal response`).output)
    expect(output?.length, `${context}: terminal output rebuilt from output_item.done items`).toBeGreaterThan(0)
  }
  if (isFailureLast && lastFrame !== undefined) {
    const payload = parseJsonRecord(lastFrame.data, `${context}: failure frame payload`)
    if (caseId === 'S2d9-08') {
      // §5.3 disconnect: request_timeout detail, message = the canonical
      // incomplete-stream text; the adapter must surface THIS, never transport text.
      expect(lastFrame.event, `${context}: plain client gets event: error`).toBe('error')
      const detail = asRecordOrThrow(payload.error, `${context}: error detail`)
      expect(detail.code, `${context}: request_timeout code`).toBe('request_timeout')
      expect(detail.type, `${context}: invalid_request_error type`).toBe('invalid_request_error')
      expect(detail.message, `${context}: canonical incomplete-stream message`).toBe(
        'stream error: stream disconnected before completion: stream closed before response.completed',
      )
      expect(detail.param, `${context}: param null slot in the alphabetical detail`).toBeNull()
    }
    if (caseId === 'S2d9-13') {
      // §5.2: plain client + the upstream error frame's code/message used verbatim as
      // the detail; the upstream error frame itself is NOT forwarded.
      expect(lastFrame.event, `${context}: plain client gets event: error`).toBe('error')
      const detail = asRecordOrThrow(payload.error, `${context}: error detail`)
      expect(detail.code, `${context}: upstream error code preserved`).toBe('server_error')
      expect(detail.message, `${context}: upstream error message preserved`).toBe('upstream exploded')
      expect(frames.some((frame) => frame.data.includes('"upstream exploded"') && frame.event === undefined), `${context}: the upstream error frame must not be forwarded`).toBe(false)
    }
    if (caseId === 'S2d9-14') {
      // §5.2: codex-flavored client (Originator: codex_cli_rs) gets the
      // response.failed envelope with the same detail object.
      expect(lastFrame.event, `${context}: codex-flavored client gets event: response.failed`).toBe('response.failed')
      const response = asRecordOrThrow(payload.response, `${context}: response.failed envelope`)
      expect(response.status, `${context}: failed status`).toBe('failed')
      const detail = asRecordOrThrow(response.error, `${context}: response.failed detail`)
      expect(detail.code, `${context}: upstream error code preserved`).toBe('server_error')
      expect(detail.message, `${context}: upstream error message preserved`).toBe('upstream exploded')
    }
  }
}


// ─── Case runner ──────────────────────────────────────────────────────────────────────

interface ReplaySession {
  readonly service: PassthroughService
  readonly captured: CapturedUpstreamCall[]
  readonly advanceClock: (deltaMs: number) => void
  stepCounter: number
}

/** Fresh service + fresh MemoryStore per session; the clock never touches wall time. */
function makeSession(): ReplaySession {
  if (adapterFactory === undefined) throw new Error('adapter factory missing')
  let nowMs = FROZEN_NOW_MS
  const now = (): number => nowMs
  const service = adapterFactory({
    credentials: [
      {
        apiKey: UPSTREAM_API_KEY,
        baseUrl: UPSTREAM_ORIGIN,
        models: [
          { name: UPSTREAM_MODEL, alias: MODEL_ALIAS },
          { name: UPSTREAM_MODEL, alias: FORCED_MODEL_ALIAS, forceMapping: true },
        ],
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
    stepCounter: 0,
  }
}

interface CaseFiles {
  readonly caseId: CaseId
  readonly meta: CaseMeta
  readonly request: RecordedRequest
  readonly recorded: RecordedResponse
  readonly wire: readonly WireLine[]
  /** The recorded upstream-call count this case must produce (0 for gateway-local + window steps). */
  readonly upstreamHits: number
  /** The client body, parsed once (well-formed JSON per NE-LENIENT). */
  readonly clientBody: Record<string, unknown>
  readonly sessionPolicy: SessionPolicy
}

async function loadCaseFiles(caseId: CaseId): Promise<CaseFiles> {
  const meta = await readFixtureJson<CaseMeta>(caseId, 'meta.yaml')
  validateDynamicFields(caseId, meta.dynamic_fields_to_mask)
  const request = parseRequestFile(await readFixtureText(caseId, 'request.http'))
  const recorded = parseDownstreamFile(await readFixtureText(caseId, 'downstream.md'))
  const wire = parseWireLines(await readFixtureText(caseId, 'upstream.jsonl'))
  const clientBody = parseJsonRecord(request.body, `S2d9[${caseId}]: client body (NE-LENIENT replays are well-formed)`)

  const hits =
    asNumber(meta.observed_upstream_lines) ??
    asNumber(asRecord(meta.observed_second_call)?.upstream_calls) ??
    0
  const metaStatus = asNumber(meta.observed_http_status) ?? asNumber(asRecord(meta.observed_second_call)?.status)
  if (metaStatus !== undefined) {
    expect(recorded.status, `S2d9[${caseId}]: recorded status must match the meta observation`).toBe(metaStatus)
  }
  expect(wire.length, `S2d9[${caseId}]: recorded wire lines must match the meta upstream-call count`).toBe(hits)
  const expectedCount = asString(meta.expected_upstream_call_count)
  if (expectedCount !== undefined) {
    const expectedHits = expectedCount === 'one' ? 1 : expectedCount === 'zero' ? 0 : -1
    if (expectedHits >= 0) {
      expect(hits, `S2d9[${caseId}]: meta expected_upstream_call_count agrees with the wire lines`).toBe(expectedHits)
    }
  }
  return {
    caseId,
    meta,
    request,
    recorded,
    wire,
    upstreamHits: hits,
    clientBody,
    sessionPolicy: sessionPolicyFor(clientBody),
  }
}

interface ReplayOptions {
  /** Override the scripted mock behavior (the derived test patches the canned script). */
  readonly script?: MockScript
}

/** One recorded request, replayed against the session's service; asserts both golds. */
async function replayStep(session: ReplaySession, caseId: CaseId, options: ReplayOptions = {}): Promise<void> {
  const files = await loadCaseFiles(caseId)
  const script = options.script ?? (await resolveMockScript(caseId))
  const mock = buildMockUpstreamResponse(script)
  session.stepCounter += 1
  const step = session.stepCounter

  const send: UpstreamSender = async (call) => {
    session.captured.push({ step, request: files.request, call })
    if (mock === undefined) {
      throw new Error(
        `S2d9[${caseId}] step ${step}: this recorded step made an upstream call but its wire count is 0 ` +
          '(a gateway-local or cooldown-window step — the adapter must short-circuit before the sender)',
      )
    }
    return mock
  }

  const callsBefore = session.captured.length
  const produced = await session.service.handleResponses(files.request, send)
  const callsThisStep = session.captured.slice(callsBefore)
  expect(
    callsThisStep.length,
    `S2d9[${caseId}] step ${step}: upstream call count (gateway-local and window steps call nothing)`,
  ).toBe(files.upstreamHits)
  for (const [index, captured] of callsThisStep.entries()) {
    const recordedWire = files.wire[index]
    if (recordedWire === undefined) {
      throw new Error(`S2d9[${caseId}] step ${step}: more upstream calls than recorded wire lines`)
    }
    assertUpstreamWire(recordedWire, captured, files.sessionPolicy, caseId)
    assertUpstreamClauses(caseId, captured, files.sessionPolicy)
  }

  const result = await assertDownstreamStep(produced, files.recorded, caseId, step)
  assertDownstreamClauses(caseId, result, files.clientBody, mockUsageExpectation(script, caseId))
}

// ─── Derived surgery helpers (no golden; spec §4.2 — see header: DERIVED TEST) ────────

/** Occurrence count of `needle` in `haystack` — the surgery targets must be unique. */
function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

function replaceUnique(haystack: string, from: string, to: string, context: string): string {
  if (countOccurrences(haystack, from) !== 1) {
    throw new Error(`${context}: expected exactly one occurrence of ${JSON.stringify(from)}`)
  }
  return haystack.replace(from, to)
}

/** Parses the recorded mock SSE script into (event, data) frames, order preserved. */
function scriptFramesOf(scriptBytes: string, context: string): readonly { event: string | undefined; data: string }[] {
  const frames: { event: string | undefined; data: string }[] = []
  let pendingEvent: string | undefined
  for (const line of scriptBytes.split('\n')) {
    if (line.startsWith('event: ')) {
      pendingEvent = line.slice('event: '.length)
    } else if (line.startsWith('data: ')) {
      frames.push({ event: pendingEvent, data: line.slice('data: '.length) })
      pendingEvent = undefined
    }
  }
  if (frames.length === 0) throw new Error(`${context}: the script carries no data frames`)
  return frames
}


// ─── Inventory helpers ───────────────────────────────────────────────────────────────

/**
 * De-chunks the recorded `## Body (raw chunked stream as received)` fence: LF-normalized
 * chunked framing (`<hex-size>\n<data>\n` per chunk, `0` terminator). Byte counts are
 * cross-checked both as UTF-16 code units and as encoded bytes (every recorded chunk is
 * ASCII), so the reconstruction is exact.
 */
function dechunkRawStream(raw: string, context: string): string {
  const out: string[] = []
  let pos = 0
  for (;;) {
    const newline = raw.indexOf('\n', pos)
    if (newline < 0) throw new Error(`${context}: truncated raw chunked stream (missing size line at ${pos})`)
    const size = Number.parseInt(raw.slice(pos, newline).trim(), 16)
    if (!Number.isInteger(size) || size < 0) {
      throw new Error(`${context}: unparsable chunk size ${JSON.stringify(raw.slice(pos, newline))}`)
    }
    pos = newline + 1
    if (size === 0) break
    const data = raw.slice(pos, pos + size)
    if (data.length !== size || encoder.encode(data).length !== size) {
      throw new Error(`${context}: chunk of size ${size} is truncated or non-ASCII at ${pos}`)
    }
    pos += size
    if (raw[pos] !== '\n') {
      throw new Error(`${context}: missing chunk terminator at ${pos}`)
    }
    pos += 1
    out.push(data)
  }
  return out.join('')
}

/** Compact serialization in INSERTION order (no key sorting) — mirrors the mock payloads. */
function insertionOrderCompact(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value)
  if (Array.isArray(value)) return `[${value.map(insertionOrderCompact).join(',')}]`
  const record = asRecordOrThrow(value, 'insertionOrderCompact')
  return `{${Object.entries(record)
    .map(([key, entry]) => `${JSON.stringify(key)}:${insertionOrderCompact(entry)}`)
    .join(',')}}`
}

/** §4.6/§4.7 reconstruction: terminal response + rebuilt output + ensured usage details. */
function rebuildAggregatedBody(scriptBytes: string, context: string): string {
  const items: Array<{ outputIndex: number; item: unknown }> = []
  let terminal: Record<string, unknown> | undefined
  for (const frame of scriptFramesOf(scriptBytes, context)) {
    const payload = parseJsonRecord(frame.data, `${context}: script frame`)
    const type = asString(payload.type)
    if (type === 'response.output_item.done') {
      items.push({ outputIndex: asNumber(payload.output_index) ?? 0, item: payload.item })
    }
    if (type === 'response.completed' || type === 'response.incomplete') {
      terminal = asRecordOrThrow(payload.response, `${context}: terminal response object`)
    }
  }
  if (terminal === undefined) throw new Error(`${context}: the script carries no terminal frame`)
  const rebuilt: Record<string, unknown> = { ...terminal }
  const output = asArray(rebuilt.output)
  if (output === undefined || output.length === 0) {
    rebuilt.output = items
      .slice()
      .sort((a, b) => a.outputIndex - b.outputIndex)
      .map((entry) => entry.item)
  }
  const usage = asRecord(rebuilt.usage)
  if (usage !== undefined) {
    const ensured: Record<string, unknown> = { ...usage }
    const outputDetails = asRecord(ensured.output_tokens_details)
    ensured.output_tokens_details = {
      ...outputDetails,
      ...(outputDetails?.reasoning_tokens === undefined ? { reasoning_tokens: 0 } : {}),
    }
    const inputDetails = asRecord(ensured.input_tokens_details)
    ensured.input_tokens_details = {
      ...inputDetails,
      ...(inputDetails?.cached_tokens === undefined ? { cached_tokens: 0 } : {}),
    }
    rebuilt.usage = ensured
  }
  return insertionOrderCompact(rebuilt)
}

/** Reads a case's mock SSE script bytes (exact-bytes recordings only). */
async function mockScriptBytes(caseId: CaseId): Promise<string> {
  const script = await resolveMockScript(caseId)
  if (script.kind !== 'stream') throw new Error(`S2d9[${caseId}]: expected an exact-bytes SSE script`)
  return script.bytes
}

// ─── Fixture inventory (harness self-check, adapter-independent) ──────────────────────

describe('S2d9 fixture inventory (harness self-check, adapter-independent)', () => {
  it('exposes exactly the 18 recorded cases (17 contract + the S2d9-18 observation), each internally consistent', async () => {
    expect([...fixtureCaseDirs]).toEqual([...EXPECTED_CASES])

    for (const caseId of EXPECTED_CASES) {
      const context = `S2d9[${caseId}]`
      const meta = await readFixtureJson<CaseMeta>(caseId, 'meta.yaml')
      expect(meta.case, `${context}: meta.case echoes the directory name`).toBe(caseId)
      expect(meta.anchor.includes(VERSION_TAG), `${context}: version anchor tag`).toBe(true)
      expect(meta.anchor.includes(VERSION_IMAGE_DIGEST), `${context}: version anchor image digest`).toBe(true)
      expect(meta.anchor.includes(VERSION_COMMIT), `${context}: version anchor commit`).toBe(true)
      expect(typeof meta.recorded_at === 'string' && Date.parse(meta.recorded_at) > 0, `${context}: recorded_at`).toBe(true)
      validateDynamicFields(caseId, meta.dynamic_fields_to_mask)
      expect(meta.config_fragment.includes('codex-api-key'), `${context}: config names the codex-api-key provider`).toBe(true)
      expect(meta.config_fragment.includes('codex-mock-forced'), `${context}: config declares the force-mapping alias`).toBe(true)
      expect(meta.config_fragment.includes('force-mapping: true'), `${context}: config enables force-mapping`).toBe(true)
      expect(meta.config_fragment.includes('transient-error-cooldown-seconds: -1'), `${context}: recording disables transient cooldowns only`).toBe(true)

      const request = parseRequestFile(await readFixtureText(caseId, 'request.http'))
      expect(request.method, `${context}: route method`).toBe('POST')
      expect(
        RESPONSES_PATHS.has(request.path) || COMPACT_PATHS.has(request.path),
        `${context}: route path is one of the four recorded surfaces`,
      ).toBe(true)
      expect(headerValue(request.headers, 'content-length'), `${context}: request body bytes match Content-Length`).toBe(
        String(encoder.encode(request.body).length),
      )
      expect(headerValue(request.headers, 'authorization'), `${context}: recorded gateway key`).toBe(
        `Bearer ${GATEWAY_API_KEY}`,
      )
      const clientBody = parseJsonRecord(request.body, `${context}: client body (NE-LENIENT replays are well-formed)`)
      expect(typeof clientBody.model, `${context}: client model is a string`).toBe('string')
      if (meta.request?.path !== undefined) {
        expect(String(meta.request.path), `${context}: meta request echo agrees with request.http`).toBe(request.path)
      }

      const recorded = parseDownstreamFile(await readFixtureText(caseId, 'downstream.md'))
      const metaStatus = asNumber(meta.observed_http_status) ?? asNumber(asRecord(meta.observed_second_call)?.status)
      if (metaStatus !== undefined) {
        expect(metaStatus, `${context}: meta status observation agrees with the recording`).toBe(recorded.status)
      }
      expect(recorded.claimedBodyBytes, `${context}: body bytes match the claimed count`).toBe(
        encoder.encode(recorded.body).length,
      )
      const contentType = headerValue(recorded.headers, 'content-type')
      expect(contentType, `${context}: response head records Content-Type`).toBeDefined()
      expect(
        headerValue(recorded.headers, 'cache-control') !== undefined,
        `${context}: Cache-Control present iff SSE commit`,
      ).toBe(contentType === 'text/event-stream')
      const expectedRetryAfter = headerValue(recorded.headers, 'retry-after')
      expect(expectedRetryAfter === undefined || expectedRetryAfter === '3600', `${context}: only the recorded 3600 Retry-After exists`).toBe(true)

      if (contentType === 'text/event-stream') {
        expect(headerValue(recorded.headers, 'transfer-encoding'), `${context}: SSE recording is chunked`).toBe('chunked')
        expect(headerValue(recorded.headers, 'content-length'), `${context}: chunked recordings carry no Content-Length`).toBeUndefined()
        const decoded = decodeDownstreamSse(recorded.body, `${context}: golden SSE`)
        assertSequenceNumbers(decoded, `${context}: golden SSE`)
        const failureFrames = decoded.frames.filter((frame) => frame.event !== undefined && FAILURE_EVENT_NAMES.has(frame.event))
        expect(
          decoded.trailingWriteDone,
          `${context}: the WriteDone \\n lands exactly on the terminal-success closes`,
        ).toBe(failureFrames.length === 0)
        if (recorded.rawChunked !== undefined) {
          expect(dechunkRawStream(recorded.rawChunked, `${context}: raw chunked stream`), `${context}: de-chunked raw stream == decoded body`).toBe(recorded.body)
        }
      } else {
        expect(headerValue(recorded.headers, 'content-length'), `${context}: JSON recording records Content-Length`).toBe(
          String(encoder.encode(recorded.body).length),
        )
      }

      const wire = parseWireLines(await readFixtureText(caseId, 'upstream.jsonl'))
      const hits =
        asNumber(meta.observed_upstream_lines) ?? asNumber(asRecord(meta.observed_second_call)?.upstream_calls) ?? 0
      expect(wire.length, `${context}: wire line count == the recorded upstream-call count`).toBe(hits)
      for (const [index, line] of wire.entries()) {
        const wireContext = `${context} wire ${index}`
        expect(line.method, `${wireContext}: method`).toBe('POST')
        expect(
          line.path === UPSTREAM_RESPONSES_PATH || line.path === UPSTREAM_COMPACT_PATH,
          `${wireContext}: known upstream path`,
        ).toBe(true)
        expect(line.headers.Authorization, `${wireContext}: Authorization is redacted in the log`).toBe('<redacted>')
        expect(line.headers['User-Agent'], `${wireContext}: cloaked User-Agent`).toBe(CLOAKED_USER_AGENT)
        expect(line.headers.Originator, `${wireContext}: cloaked Originator`).toBe(CLOAKED_ORIGINATOR)
        expect(line.headers.Connection, `${wireContext}: fixed Connection`).toBe('Keep-Alive')
        expect(line.headers['Accept-Encoding'], `${wireContext}: fixed Accept-Encoding`).toBe('gzip')
        expect(line.headers['Content-Type'], `${wireContext}: fixed Content-Type`).toBe('application/json')
        expect(
          line.headers.Accept,
          `${wireContext}: Accept switches with the route (§3.2 always-SSE / §6 compact JSON)`,
        ).toBe(line.path === UPSTREAM_COMPACT_PATH ? 'application/json' : 'text/event-stream')
        expect(
          line.headers['Content-Length'],
          `${wireContext}: logged Content-Length matches the body`,
        ).toBe(String(encoder.encode(line.body).length))
        const wireBody = parseJsonRecord(line.body, `${wireContext}: body`)
        expect(line.headers['Session-Id'], `${wireContext}: Session-Id == body prompt_cache_key (§3.2)`).toBe(
          asString(wireBody.prompt_cache_key),
        )
        const expectedOrder: string[] = [...WIRE_HEADER_ORDER]
        if (line.headers[LITE_HEADER_WIRE_NAME] !== undefined) {
          expectedOrder.splice(expectedOrder.indexOf('Accept-Encoding'), 0, LITE_HEADER_WIRE_NAME)
        }
        expect(Object.keys(line.headers), `${wireContext}: stable recorded header order (+ Lite slot)`).toEqual(expectedOrder)
      }

      const mockFile = asRecordOrThrow(
        (await readFixtureJsonIfExists<unknown>(caseId, 'mock-response.json')) ?? {},
        `${context} mock-response.json`,
      )
      if (asRecord(mockFile.http_error) !== undefined) {
        const httpError = asRecordOrThrow(mockFile.http_error, `${context} http_error`)
        expect(Number.isInteger(asNumber(httpError.status)), `${context}: http_error status is an integer`).toBe(true)
        expect(asString(httpError.body), `${context}: http_error body is exact recorded text`).toBeDefined()
        parseJsonRecord(asString(httpError.body) ?? '', `${context}: http_error body is JSON`)
      }
      if (asString(mockFile.sse_script_exact_bytes) !== undefined) {
        const scriptBytes = asString(mockFile.sse_script_exact_bytes) ?? ''
        for (const character of scriptBytes) {
          if (character.charCodeAt(0) > 0x7e) {
            throw new Error(`${context}: mock script carries a non-ASCII byte: ${JSON.stringify(character)}`)
          }
        }
        if (caseId === 'S2d9-08') {
          expect(scriptBytes.includes('\nMOCK:'), `${context}: the disconnect script ends with its MOCK instruction line`).toBe(true)
        }
        scriptFramesOf(caseId === 'S2d9-08' ? scriptBytes.slice(0, scriptBytes.indexOf('\nMOCK:')) : scriptBytes, `${context} script`)
      }
      if (asRecord(mockFile.writes) !== undefined) {
        const writes = asArray(asRecordOrThrow(mockFile.writes, `${context} writes`).writes) ?? []
        expect(writes.length > 0, `${context}: the slow-chunks control carries write entries`).toBe(true)
        for (const [index, entry] of writes.entries()) {
          const write = asRecordOrThrow(entry, `${context} writes[${index}]`)
          expect(asString(write.bytes), `${context} writes[${index}].bytes is exact recorded text`).toBeDefined()
        }
      }
      if (caseId === 'S2d9-18') {
        expect(asString(mockFile.control_file), `${context}: the observation references the S2d9-10 control`).toBe('S2d9-10')
        expect(wire.length, `${context}: the window step records ZERO upstream lines by design`).toBe(0)
      }
    }

    // ── cross-case pins ──────────────────────────────────────────────────────────────

    // S2d9-02: the mock's response.created carries NO model; the golden injects the alias.
    const script02 = await mockScriptBytes('S2d9-02')
    const created02 = scriptFramesOf(script02, 'S2d9-02 script')[0]
    expect(created02?.event, 'S2d9-02: script opens with response.created').toBe('response.created')
    expect(
      asRecord(parseJsonRecord(created02?.data ?? '{}', 'S2d9-02 created').response)?.model,
      'S2d9-02: the mock omits response.model on response.created',
    ).toBeUndefined()
    const recorded02 = parseDownstreamFile(await readFixtureText('S2d9-02', 'downstream.md'))
    const decoded02 = decodeDownstreamSse(recorded02.body, 'S2d9-02 golden')
    const downstreamCreated02 = parseJsonRecord(decoded02.frames[0]?.data ?? '{}', 'S2d9-02 downstream created')
    expect(asRecord(downstreamCreated02.response)?.model, 'S2d9-02: the gateway injects the alias (§4.3)').toBe(MODEL_ALIAS)

    // S2d9-03: force-mapping rewrites EVERY model field back to the alias.
    const script03 = await mockScriptBytes('S2d9-03')
    for (const frame of scriptFramesOf(script03, 'S2d9-03 script')) {
      const response = asRecord(parseJsonRecord(frame.data, 'S2d9-03 script frame').response)
      if (response !== undefined) {
        expect(response.model, 'S2d9-03: the mock speaks the upstream model name').toBe(UPSTREAM_MODEL)
      }
    }
    const recorded03 = parseDownstreamFile(await readFixtureText('S2d9-03', 'downstream.md'))
    for (const frame of decodeDownstreamSse(recorded03.body, 'S2d9-03 golden').frames) {
      const response = asRecord(parseJsonRecord(frame.data, 'S2d9-03 golden frame').response)
      if (response !== undefined) {
        expect(response.model, 'S2d9-03: downstream model fields are force-mapped to the alias (§4.3)').toBe(FORCED_MODEL_ALIAS)
      }
    }

    // S2d9-01/04: the aggregated JSON body == the terminal response object with the
    // output rebuilt from output_item.done and the usage details defaulted.
    for (const caseId of ['S2d9-01', 'S2d9-04'] as const) {
      const recordedBody = parseDownstreamFile(await readFixtureText(caseId, 'downstream.md')).body
      expect(recordedBody, `${caseId}: aggregation reconstruction matches the recorded body`).toBe(
        rebuildAggregatedBody(await mockScriptBytes(caseId), `${caseId} aggregation`),
      )
    }

    // S2d9-09/10/11: the §5.1 re-serialization family — observed error fields preserved,
    // alphabetical keys, compact separators (09 rewrites code to auth_unavailable).
    for (const caseId of ['S2d9-09', 'S2d9-10', 'S2d9-11'] as const) {
      const mockFile = asRecordOrThrow(
        await readFixtureJson<unknown>(caseId, 'mock-response.json'),
        `${caseId} mock-response.json`,
      )
      const httpError = asRecordOrThrow(mockFile.http_error, `${caseId} http_error`)
      const upstreamError = asRecordOrThrow(
        parseJsonRecord(asString(httpError.body) ?? '', `${caseId} upstream error body`).error,
        `${caseId} upstream error object`,
      )
      const expectedError = caseId === 'S2d9-09' ? { ...upstreamError, code: 'auth_unavailable' } : upstreamError
      const recordedBody = parseDownstreamFile(await readFixtureText(caseId, 'downstream.md')).body
      expect(recordedBody, `${caseId}: downstream body == canonical alphabetical-compact re-serialization (§5.1)`).toBe(
        canonicalCompact({ error: expectedError }),
      )
    }

    // The 429 pair (S2d9-11 -> S2d9-12): recorded back-to-back; the cooldown window and
    // its Retry-After come from the 429 body's resets_in_seconds.
    const meta11 = await readFixtureJson<CaseMeta>('S2d9-11', 'meta.yaml')
    const meta12 = await readFixtureJson<CaseMeta>('S2d9-12', 'meta.yaml')
    expect(
      Math.abs(Date.parse(meta11.recorded_at) - Date.parse(meta12.recorded_at)) < 1_000,
      'S2d9-12 recorded < 1s after S2d9-11 (inside the rate-limit window)',
    ).toBe(true)
    const mock11 = asRecordOrThrow(await readFixtureJson<unknown>('S2d9-11', 'mock-response.json'), 'S2d9-11 mock')
    const error11 = asRecordOrThrow(
      parseJsonRecord(
        asString(asRecordOrThrow(mock11.http_error, 'S2d9-11 http_error').body) ?? '',
        'S2d9-11 mock error body',
      ).error,
      'S2d9-11 mock error object',
    )
    const recorded12 = parseDownstreamFile(await readFixtureText('S2d9-12', 'downstream.md'))
    const error12 = asRecordOrThrow(parseJsonRecord(recorded12.body, 'S2d9-12 body').error, 'S2d9-12 error object')
    expect(error12.last_upstream_error, 'S2d9-12: last_upstream_error == "<error.code>: <error.message>" of the 429').toBe(
      `${asString(error11.code)}: ${asString(error11.message)}`,
    )
    expect(error12.reset_seconds, 'S2d9-12: reset_seconds mirrors the 429 body resets_in_seconds').toBe(error11.resets_in_seconds)
    expect(error12.reset_time, 'S2d9-12: reset_time is the Go duration string').toBe('1h0m0s')
    expect(headerValue(recorded12.headers, 'retry-after'), 'S2d9-12: Retry-After mirrors reset_seconds (§5.1)').toBe(
      String(error11.resets_in_seconds),
    )

    // The 404 pair (S2d9-10 -> S2d9-18): the observation's 503 body embeds the trigger's
    // "<error.code>: <error.message>" and records ZERO upstream lines.
    const mock10 = asRecordOrThrow(await readFixtureJson<unknown>('S2d9-10', 'mock-response.json'), 'S2d9-10 mock')
    const error10 = asRecordOrThrow(
      parseJsonRecord(
        asString(asRecordOrThrow(mock10.http_error, 'S2d9-10 http_error').body) ?? '',
        'S2d9-10 mock error body',
      ).error,
      'S2d9-10 mock error object',
    )
    const recorded18 = parseDownstreamFile(await readFixtureText('S2d9-18', 'downstream.md'))
    expect(recorded18.body, 'S2d9-18: the 503 body embeds the trigger error summary').toContain(
      `last upstream error: ${asString(error10.code)}: ${asString(error10.message)}`,
    )
    expect(recorded18.body, 'S2d9-18: the 503 body names the client-facing model').toContain('model=codex-mock')

    // S2d9-16: the compact stream:true rejection is gateway-local; S2d9-15's compact
    // passthrough deletes the stream key upstream.
    const recorded16 = parseDownstreamFile(await readFixtureText('S2d9-16', 'downstream.md'))
    expect(recorded16.status, 'S2d9-16: 400 before any upstream call').toBe(400)
    expect(headerValue(recorded16.headers, 'content-type'), 'S2d9-16: the gateway-local 400 carries the charset variant').toBe(
      'application/json; charset=utf-8',
    )
    expect(recorded16.body, 'S2d9-16: exact gateway-synthesized rejection body').toBe(
      '{"error":{"message":"Streaming not supported for compact responses","type":"invalid_request_error"}}',
    )
    const wire15 = parseWireLines(await readFixtureText('S2d9-15', 'upstream.jsonl'))
    expect(
      Object.hasOwn(parseJsonRecord(wire15[0]?.body ?? '{}', 'S2d9-15 wire body'), 'stream'),
      'S2d9-15: the compact passthrough deletes the stream key',
    ).toBe(false)

    // S2d9-05: the recorded capability strip — the upstream body carries NO reasoning
    // object although the client sent one (fixture outranks §3.2's PRESERVED prose).
    const wire05 = parseWireLines(await readFixtureText('S2d9-05', 'upstream.jsonl'))
    expect(
      Object.hasOwn(parseJsonRecord(wire05[0]?.body ?? '{}', 'S2d9-05 wire body'), 'reasoning'),
      'S2d9-05: the recorded upstream body strips the reasoning object (capability default)',
    ).toBe(false)
    expect(
      Object.hasOwn(parseJsonRecord(parseRequestFile(await readFixtureText('S2d9-05', 'request.http')).body, 'S2d9-05 client body'), 'reasoning'),
      'S2d9-05: the client really sent a reasoning object',
    ).toBe(true)

    // S2d9-08: the disconnect golden — three forwarded frames, then the request_timeout
    // failure frame with seq == data-frame count, and NO WriteDone byte after it.
    const recorded08 = parseDownstreamFile(await readFixtureText('S2d9-08', 'downstream.md'))
    const decoded08 = decodeDownstreamSse(recorded08.body, 'S2d9-08 golden')
    expect(decoded08.frames.length, 'S2d9-08: three forwarded frames + one synthesized failure').toBe(4)
    expect(decoded08.failureLead.at(-1), 'S2d9-08: the failure frame carries the §5.2 lead \\n').toBe(true)
    expect(decoded08.trailingWriteDone, 'S2d9-08: a failure close appends NO WriteDone byte').toBe(false)

    // S2d9-17: the slow-chunks investigation table — all three variants returned 200
    // (no reference stall policy); the recorded sleeps stay meta-only.
    const meta17 = await readFixtureJson<CaseMeta>('S2d9-17', 'meta.yaml')
    const results17 = meta17.investigation?.results
    const variants17 = Object.keys(results17 ?? {})
    for (const variant of ['a-as-specified', 'b-halved-sleeps', 'c-single-pause-clean-frames']) {
      expect(variants17, `S2d9-17: the investigation table carries the ${variant} variant`).toContain(variant)
    }
    for (const [variant, result] of Object.entries(results17 ?? {})) {
      expect(result?.http_status, `S2d9-17: variant ${variant} recorded HTTP 200 (no stall policy)`).toBe(200)
    }

    // Derived-test surgery anchors: the S2d9-02 script carries exactly one occurrence
    // of each rename target, and the golden's terminal event line is unique — after the
    // §4.2 rename (event line + payload) the derived replay must reproduce this golden
    // byte-identically, so both surfaces are pinned.
    expect(countOccurrences(script02, 'event: response.completed'), 'S2d9-02 script: one terminal event line').toBe(1)
    expect(countOccurrences(script02, '"type":"response.completed"'), 'S2d9-02 script: one terminal payload type').toBe(1)
    expect(countOccurrences(recorded02.body, 'event: response.completed'), 'S2d9-02 golden: one terminal event line').toBe(1)

    // Session-policy reality: only S2d9-06 fixed the cache key client-side; every other
    // recorded Session-Id is a derived UUID.
    for (const caseId of EXPECTED_CASES) {
      const request = parseRequestFile(await readFixtureText(caseId, 'request.http'))
      const clientBody = parseJsonRecord(request.body, `S2d9[${caseId}] client body`)
      const wire = parseWireLines(await readFixtureText(caseId, 'upstream.jsonl'))
      if (wire.length === 0) continue
      const sessionValue = wire[0]?.headers['Session-Id']
      if (typeof clientBody.prompt_cache_key === 'string') {
        expect(sessionValue, `S2d9[${caseId}]: the client-fixed cache key is pinned verbatim`).toBe(clientBody.prompt_cache_key)
      } else {
        expect(sessionValue, `S2d9[${caseId}]: the derived session is a UUID`).toMatch(UUID_RE)
      }
    }
  })
})


// ─── Golden replays (adapter suite) ────────────────────────────────────────────────────

suite(suiteTitle, () => {
  for (const caseId of STANDALONE_CASES) {
    it(`${caseId} — replays the recorded golden: upstream wire byte-exact, downstream surface byte-exact`, async () => {
      const session = makeSession()
      await replayStep(session, caseId)
    })
  }

  it('S2d9-11 + S2d9-12 — the 429 and its immediate repeat on ONE shared session (rate-limit cooldown family)', async () => {
    // Recorded 5ms apart on one container (meta cross-check in the inventory). The
    // harness clock does NOT advance between the steps: the second request observes the
    // window at elapsed ≈ 0 and must short-circuit BEFORE the sender — 429 + Retry-After
    // 3600 + the model_cooldown body with reset_time "1h0m0s", byte-pinned, zero upstream
    // calls. A replay that reaches the upstream fails the zero-call pin loudly.
    const session = makeSession()
    await replayStep(session, 'S2d9-11')
    await replayStep(session, 'S2d9-12')
  })

  it('S2d9-10 + S2d9-18 — the 404 and the twice-fired observation on ONE shared session (model-not-found cooldown family)', async () => {
    // Recorded as the S2d9-10 request fired TWICE back-to-back with no restart; this
    // fixture pair pins the observable 404 -> 503 window: the trigger replays its verbatim
    // 404 golden, then the immediate repeat returns the 503 auth_unavailable selection
    // error (gateway struct layout, last upstream error embedded) with ZERO upstream calls.
    const session = makeSession()
    await replayStep(session, 'S2d9-10')
    await replayStep(session, 'S2d9-18')
  })

  it('derived (no golden): an upstream response.done frame is renamed to response.completed on the event line AND the payload (§4.2)', async () => {
    // The S2d9-02 script is patched so the terminal frame arrives as
    // `event: response.done` + data `{"type":"response.done",...}`. Per the orchestrator
    // ruling (2026-09-16) the reference renames the frame BEFORE forwarding: BOTH the
    // event line and the payload type come back as response.completed. Expected surface:
    // the recorded S2d9-02 golden BYTE-IDENTICAL — a rename that misses either half, a
    // missed terminal close, or a lost WriteDone `\n` fails the byte gold loudly. The
    // inventory asserts the script surgery anchors.
    const caseId = 'S2d9-02' as CaseId
    const scriptBytes = await mockScriptBytes(caseId)
    const patchedScript: MockScript = {
      kind: 'stream',
      bytes: replaceUnique(
        replaceUnique(scriptBytes, 'event: response.completed', 'event: response.done', 'derived response.done script (event line)'),
        '"type":"response.completed"',
        '"type":"response.done"',
        'derived response.done script (payload type)',
      ),
    }
    const session = makeSession()
    await replayStep(session, caseId, { script: patchedScript })
  })
})

