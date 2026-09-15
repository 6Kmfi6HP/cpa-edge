/**
 * S2d2 golden contract — Gemini-protocol client → OpenAI Chat Completions upstream.
 *
 * Spec source of truth: spec/sections/S2d2-gem2oai.md (admitted). Goldens: the 26 recorded
 * fixture cases under tests/fixtures/S2d2/ (oracle recordings of CLIProxyAPI v7.3.4 against
 * the deterministic openai mock). Rulings applied: R-SSE (decoded event sequences, never
 * chunk boundaries), R-ORDER (multi-tool finish frames compare under a canonical part
 * ordering — §7 N5 volatility whitelist), R-TOK (countTokens integers are byte-pinned,
 * never masked), R-FIXTURE (all 26 cases RECORDABLE-LOCALLY), NE-LENIENT (every replayed
 * request body is well-formed JSON; strict 400-on-garbage is a registered non-equivalence
 * outside these goldens). R-404/R-BCRYPT are S1/S3-S6 territory and are not exercised by
 * any fixture here.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * ADAPTER INTERFACE — what the `@cpa-edge/translators/gem2oai` direction module MUST
 * export. The suite dynamically imports the package and turns green-to-red once the
 * export ships; while the package is still a skeleton every case test SKIPS with the
 * reason below. The harness holds its own structural mirror of these types; the package
 * should export the real ones. All shapes are runtime-checked by the suite.
 *
 *   export function createGem2OaiService(options: Gem2OaiServiceOptions): Gem2OaiService
 *
 *   type HeaderList = ReadonlyArray<readonly [string, string]>   // ordered, original casing
 *
 *   interface Gem2OaiModelEntry {          // one openai-compatibility model of a credential
 *     name: string                         // upstream model name (alias-rewrite target)
 *     alias?: string                       // client-facing alias; defaults to `name`
 *     thinking?: { levels?: readonly string[] }
 *                                          // capability override. DEFAULT for openai-compat
 *                                          // models without explicit config (spec §3.3):
 *                                          // levels ["low","medium","high"], dynamic
 *                                          // thinking not allowed, disable not allowed.
 *   }
 *
 *   interface Gem2OaiCredential {          // one openai-compatibility provider entry
 *     name: string                         // provider name; cooldown `provider` field is
 *                                          // `openai-compatible-<name>` (spec §5.3)
 *     apiKey: string                       // upstream key -> `Authorization: Bearer <apiKey>`
 *     baseUrl: string                      // configured base-url INCLUDING the /v1 suffix;
 *                                          // a trailing "/" is trimmed; upstream URL =
 *                                          // `<baseUrl>/chat/completions`
 *     headers?: Readonly<Record<string, string>>
 *                                          // provider-level custom headers (OPTIONAL; no
 *                                          // golden exercises it)
 *     models: readonly Gem2OaiModelEntry[]
 *   }
 *
 *   interface Gem2OaiRegistryEntry {       // global model registry entry (all providers)
 *     id: string                           // client-facing model id (registry key)
 *     displayName?: string                 // LIST + raw GET field; defaults to `id`
 *     description?: string                 // LIST-only field; defaults to `id`
 *     supportedGenerationMethods?: readonly string[]
 *                                          // LIST-only field; defaults to ["generateContent"]
 *   }
 *
 *   interface Gem2OaiServiceOptions {
 *     credentials: readonly Gem2OaiCredential[]  // openai-compat entries, config order
 *     registry: readonly Gem2OaiRegistryEntry[]  // every registered model, registration
 *                                                 // order = GET /v1beta/models list order
 *     apiKeys: readonly string[]           // gateway api-keys accepted on /v1beta (the
 *                                          // five client-auth transports of spec §2.2)
 *     store: Store                         // from @cpa-edge/core; ALL persistent state
 *                                          // (429 cooldown windows + escalation) flows
 *                                          // through it — no in-facade mutable state
 *     now?: () => number                   // epoch-ms clock; MUST drive every timing
 *                                          // decision (window open/close, reset_seconds)
 *     requestRetry?: number                // 0 in every S2d2 fixture (no retries)
 *     transientErrorCooldownSeconds?: number
 *                                          // -1 in every S2d2 fixture. NOTE (spec §5.3):
 *                                          // -1 disables only transient-error cooldowns;
 *                                          // the 429 model cooldown stays ACTIVE.
 *   }
 *
 *   interface Gem2OaiRequest {             // one downstream request on the /v1beta group
 *     method: string                        // 'GET' | 'POST'
 *     path: string                         // full path + query, e.g.
 *                                           // '/v1beta/models/mock-model:generateContent'
 *                                           // or '.../streamGenerateContent?alt=sse'
 *     headers: HeaderList                   // client headers, recorded order + casing
 *     body: string                          // exact request-body bytes ('' for GET)
 *   }
 *
 *   interface Gem2OaiUpstreamRequest {
 *     method: string                        // 'POST'
 *     url: string                           // absolute `<baseUrl-trimmed>/chat/completions`
 *     headers: HeaderList                   // emission ORDER is pinned (see below)
 *     body: string
 *   }
 *
 *   interface Gem2OaiUpstreamResponse {
 *     status: number
 *     headers: HeaderList
 *     body: ReadableStream<Uint8Array>      // 2xx stream: SSE bytes; 2xx non-stream: JSON
 *                                           // bytes; non-2xx: raw error bytes. A rejected
 *                                           // read mid-body models an upstream disconnect.
 *   }
 *
 *   type Gem2OaiUpstreamSender =
 *     (request: Gem2OaiUpstreamRequest) => Promise<Gem2OaiUpstreamResponse>
 *
 *   interface Gem2OaiResponse {
 *     status: number
 *     headers: HeaderList                   // must carry the direction-owned subset (below)
 *     body: string | ReadableStream<Uint8Array>
 *   }
 *
 *   interface Gem2OaiService {
 *     handleV1Beta(
 *       request: Gem2OaiRequest,
 *       send: Gem2OaiUpstreamSender,
 *     ): Promise<Gem2OaiResponse>
 *   }
 *
 * The facade covers the WHOLE pinned /v1beta client surface of this direction (spec §2):
 * the five-transport client auth (401 shapes), `GET /v1beta/models` + single-model GET
 * (list normalization vs raw GET map, 404s), `*action` path parsing (first-colon split,
 * 0-or-2+-colon JSON 404, `models/`-prefixed ids, unknown `:method` -> 200 empty body),
 * alias resolution (400 model_not_found), request translation + the two-stage thinking
 * pipeline with the recorded clamp table (§3.3), the openai-compat upstream wire (§2.3:
 * header set + order, alias rewrite, stream_options injection), non-stream response
 * mapping (§3.2), stream chunk mapping + both alt framing modes (§4.1/§4.2), local
 * countTokens synthesis over the translated body with the o200k tokenizer (§3.4, R-TOK),
 * error semantics (§5: verbatim non-2xx passthrough, in-stream `event: error` frames,
 * 429 cooldown + escalation through the Store), and the X-Cpa-Trace-Id presence policy
 * (§2.5: only executor-routed responses carry it). Internals may compose the openai-compat
 * executor and core scheduling primitives; only this facade is contract.
 *
 * OUT of scope here (owned by S1/S4, asserted by no fixture in this suite): the CORS
 * block, Date emission, Content-Length/Transfer-Encoding exactness, OPTIONS handling,
 * trailing-slash redirects, keep-alive watchdogs (disabled in the golden configuration).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * HARNESS SEMANTICS
 *
 * • Fixture layout per case (RECIPES, reports/oracle/BOOTSTRAP.md §7): meta.yaml (JSON),
 *   request.http (R1..Rn request blocks), downstream.md (R1..Rn response sections),
 *   upstream.jsonl (one JSON line per upstream request, request order), mock-response.json
 *   (the scripted upstream behavior). request.http/downstream.md are CRLF-normalized on
 *   read; every compared surface is CR-free.
 *
 * • SESSIONS. Most cases replay through a FRESH service + FRESH MemoryStore (per-case
 *   isolation). The exception is the cooldown escalation pair, which the oracle recorded
 *   back-to-back on ONE reference instance: `gem2oai-error-429` (17:18:09 / 17:18:11)
 *   then `gem2oai-cooldown-after-429` (17:18:13 / 17:18:13). The recorded `reset_seconds:4`
 *   on the cooldown response is the THIRD consecutive 429's window (spec §5.3 escalation);
 *   it is only reproducible with that shared failure history, so the harness replays BOTH
 *   cases through one shared service + store, in recording order, inside a single test.
 *   Everything else about the two cases is asserted exactly like the isolated ones.
 *
 * • CLOCK. Real wall-clock time is never consulted. Each session runs a stepwise clock:
 *   `now()` returns a constant per step (frozen within a step), advanced between steps per
 *   the table below (offsets in ms from the frozen epoch). The cooldown-pair schedule
 *   mirrors the recorded inter-request gaps so a spec-faithful backoff (first 429 ~1s
 *   window, doubling per post-window failure; reset_seconds = window seconds, recorded
 *   3.9s-remaining -> "4") reproduces the fixture bytes — including Retry-After: 4 and
 *   `"reset_seconds":4` — with NO masking:
 *
 *     gem2oai-error-429          step R1 @ +0,      R2 @ +2500   (R2 post-window -> the
 *                               second recorded upstream call happens, as recorded)
 *     gem2oai-cooldown-after-429 step R1 @ +5000,   R2 @ +5100   (R1 post-window -> third
 *                               upstream 429 escalates the window to 4s; R2 lands INSIDE
 *                               -> model_cooldown, reset_seconds 4)
 *     every other case           all steps @ +0 (frozen)
 *
 * • MOCK UPSTREAM. Each case's mock-response.json drives every upstream call the case
 *   makes (single scripted control per case, exactly like the recording). Shapes:
 *   { control_file: { mode: 'happy' }, reply: null } — gateway-local, the sender must
 *   NEVER be called (it throws if it is); happy non-stream — reply.status +
 *   reply.response_body (exact bytes, one chunk); happy/slow/disconnect stream —
 *   reply.sse_frames (exact upstream wire frame strings, one stream chunk each);
 *   error — control_file.status + reply.body_raw verbatim (both recorded 429 shapes).
 *   slow mode sleeps control_file.delay_ms between chunks; disconnect mode errors the
 *   read after control_file.after chunks with `new Error('unexpected EOF')` — the
 *   transport error text the reference surfaced for a chunked body that ends without
 *   its terminator (spec §5.4); the adapter propagates that text into the terminal
 *   `event: error` frame.
 *
 * • Upstream calls are captured per case; at the end the captured sequence must equal
 *   the recorded upstream.jsonl lines (count + bytes). Cooldown / countTokens /
 *   discovery / auth / model-resolution steps therefore also pin "no upstream call".
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * COMPARISON RULES
 *
 * Upstream wire (primary gold):
 *   - method, url (trimmed baseUrl + recorded path), body: byte-exact. Translated bodies
 *     are compact JSON with pinned key order (spec §3); no dynamic field appears inside
 *     any upstream body in this batch.
 *   - headers: the full ordered list, names case-preserved. Recording-only `ts`/`type`
 *     fields of upstream.jsonl are not part of the wire request. `Content-Length` is
 *     excluded from the ordered compare and instead consistency-checked (if the adapter
 *     emits it, it must equal the body byte length). `Authorization` is redacted in the
 *     recordings; the adapter's value must start with "Bearer " and is normalized to
 *     "<redacted>". The `Host` header port is masked per meta.yaml (`:<PORT>`).
 *
 * Downstream (per step):
 *   - status: exact.
 *   - body:
 *       · SSE mode (recorded Content-Type `text/event-stream`): the DECODED event
 *         sequence per R-SSE — the ordered list of (`event?`, `data`) pairs, event name
 *         and data payload bytes compared exactly; chunk boundaries and the blank-line
 *         framing are ignored. SSE comment lines (`:`) and a downstream `data: [DONE]`
 *         marker are contract violations and fail loudly (keep-alives are disabled in
 *         the golden configuration; §4.1 pins no [DONE] downstream).
 *       · raw-chunk mode (recorded Content-Type `text/plain; charset=utf-8`, the non-sse
 *         `alt` framing): byte-adjacent JSON objects compared as the full concatenated
 *         body byte-exactly (chunk-boundary agnostic by construction).
 *       · everything else: body bytes compared byte-exactly.
 *   - R-ORDER (spec §7 N5): a frame whose candidates[0].content.parts carries TWO OR MORE
 *     functionCall entries compares under a canonical part ordering (sort key:
 *     functionCall.name, then functionCall.id) — both sides pass through the identical
 *     canonicalization, so every other frame stays byte-pinned and only the part ORDER
 *     inside multi-tool frames is free (golden `gem2oai-stream-toolcall-multi`; single-
 *     tool frames stay byte-exact). Applied identically in SSE mode; no raw-mode golden
 *     carries a multi-tool frame today.
 *   - headers: only the direction-owned subset is asserted (presence AND value, absence
 *     included): `Content-Type` (exact, including the bare-vs-charset distinction and
 *     the missing header on the 200-empty unknown-method response), `Cache-Control`
 *     (`no-cache` exactly on SSE responses, absent otherwise — this pins "no SSE headers
 *     before commit" for pre-stream failures and the raw-mode header suppression),
 *     `Connection` (`keep-alive` exactly on SSE responses, absent otherwise), and
 *     `Retry-After` (exact when recorded — the cooldown step pins `4`; absent otherwise).
 *     `X-Cpa-Trace-Id` is asserted for PRESENCE ONLY, matching the recorded head per
 *     step: executor-routed responses carry it, gateway-local ones (401s, model-
 *     resolution 400/404, the 200-empty response, discovery responses, the cooldown
 *     error) must not. Its value is dynamic (meta.yaml) and never compared. Downstream
 *     header ORDER is not pinned (transport-owned). The cooldown envelope's timing
 *     fields are byte-pinned via the shared-session clock schedule above; a consistency
 *     check additionally ties Retry-After == reset_seconds == reset_time's integer.
 *
 * MASKS — derived from each case's meta.yaml `dynamic_fields` (unknown entries fail the
 * suite loudly so new volatility must be added consciously). All 26 cases declare the
 * same five entries, handled as follows:
 *   - `Date` — never compared: Date headers are outside the asserted subset and no
 *     compared body in this batch embeds a date.
 *   - `X-Cpa-Trace-Id` — presence-only assertion (see above); value never compared.
 *   - `upstream Host header port (20999)` — the trailing `:port` of the upstream Host
 *     header is masked to `:<PORT>` on both sides of the upstream wire compare.
 *   - `mock wire log ts field` — the upstream.jsonl `ts` (and `type`) are recording-only
 *     metadata, excluded from the wire request compare.
 *   - `createTime / responseId-like ids where present` — recognized no-op: no compared
 *     surface of this batch carries such a field (the S2d2 gemini envelopes have no
 *     responseId/createTime); kept in the table so a future fixture that adds one fails
 *     loudly instead of silently comparing a volatile value.
 *
 * COVERAGE (fixture -> what the replay pins; spec §6 for the full case index):
 *   auth-styles           401 Missing/Invalid shapes; x-goog-api-key + Bearer accepted;
 *                         countTokens 200 (totalTokens 3) — no upstream call
 *   auth-transports       X-Api-Key, ?key=, ?auth_token=, non-Bearer Authorization all
 *                         accepted; identical 401 shapes; query-in-path parsing
 *   basic-params          generationConfig table; systemInstruction -> system array;
 *                         text -> string content; alias rewrite; stream:false, no
 *                         stream_options; upstream header set/order; client headers not
 *                         forwarded; non-stream envelope + usageMetadata
 *   cooldown-after-429    R1 429 verbatim; R2 model_cooldown envelope byte-exact
 *                         (status 429, Retry-After 4, reset_seconds 4, provider key),
 *                         NO upstream call, no trace header; shared-session escalation
 *   count-tokens          local synthesis (totalTokens 4), empty upstream log (R-TOK)
 *   count-tokens-tools    tool-history + tools counting (totalTokens 79), empty log
 *   error-429             429 status+body passthrough VERBATIM for non-stream AND stream
 *                         (pre-commit: JSON content type, no SSE headers), 2 upstream
 *                         calls; also the escalation feeder for the cooldown pair
 *   error-in-stream-payload  mid-stream error payload -> terminal event:error frame with
 *                         the payload verbatim; earlier frames preserved; HTTP 200
 *   model-resolution-errors  unknown alias 400; models/-prefixed 400; unknown :method
 *                         200 EMPTY (no Content-Type, no trace); colon-less action 404
 *                         JSON with the request path in the message; zero upstream calls
 *   models-list           LIST: all-provider registry, models/ prefix, displayName/
 *                         description/supportedGenerationMethods defaults, charset
 *                         content type; GET: raw 2-key map for the bare id, 404 not_found
 *                         for prefixed + unknown ids
 *   resp-nonstream-reasoning  reasoning_content -> leading thought part; length ->
 *                         MAX_TOKENS; reasoning_tokens -> thoughtsTokenCount
 *   resp-nonstream-toolcall   tool_calls -> functionCall part (id kept); tool_calls ->
 *                         STOP finishReason; args parsed to a raw object
 *   role-mapping          model -> assistant; text concatenation; unknown roles verbatim
 *   stream-alt-json       alt=json: NO SSE headers (text/plain; charset=utf-8), byte-
 *                         adjacent JSON objects, no Cache-Control
 *   stream-disconnect     role chunk dropped, 1 frame flushed, hard close -> terminal
 *                         event:error `unexpected EOF` frame, HTTP stays 200
 *   stream-reasoning      reasoning deltas -> thought:true frames interleaved with text
 *                         frames in arrival order; finish frame; no usage frame upstream
 *   stream-slow           same frame sequence under inter-chunk delays (flush per frame)
 *   stream-text-full      role chunk dropped; per-delta frames; finish frame; usage-only
 *                         frame (candidates, usageMetadata, model order); [DONE]
 *                         swallowed upstream and NOT sent downstream; SSE headers
 *   stream-toolcall       tool_call deltas buffered (no frames), args reassembled,
 *                         single flush on the finish frame, id preserved
 *   stream-toolcall-multi 2 buffered calls -> ONE finish frame; parts compared under the
 *                         R-ORDER canonical ordering
 *   system-snake-multimodal  system_instruction snake key; system inline image ->
 *                         image_url data: URL; thought part dropped; inline audio ->
 *                         input_audio (wav); mixed turn -> content array
 *   thinking-clamps       none/minimal -> low, xhigh/max -> high, budgets 0/300 -> low,
 *                         30000 -> high (effective stage-2 mapping)
 *   thinking-config       level high passthrough; budget 2048 -> medium; level auto ->
 *                         medium (recorded clamp)
 *   thinking-invalid      level "ultra" -> 400 `level ... not supported`; budget -5 ->
 *                         400 `budget ... cannot be converted`; same 400 on countTokens;
 *                         zero upstream calls
 *   tool-roundtrip-request  functionCall -> tool_calls with sha256-derived ids;
 *                         functionResponse -> tool messages (FIFO pairing, JSON-stringified
 *                         content); trailing empty function-role message quirk
 *   tools-toolconfig       functionDeclarations (parameters + parametersJsonSchema,
 *                         description always present); tool_choice NONE/AUTO/ANY-single/
 *                         ANY-multi across four requests
 */

import { readdir, readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { MemoryStore } from '@cpa-edge/core'
import type { Store } from '@cpa-edge/core'

// ─── Adapter load (skip-with-explanation until the real export ships) ────────────────

const ADAPTER_MODULE = '@cpa-edge/translators/gem2oai'
const ADAPTER_EXPORT = 'createGem2OaiService'

/** Structural mirror of the adapter interface documented in the header. */
type HeaderList = ReadonlyArray<readonly [string, string]>

interface ModelEntry {
  readonly name: string
  readonly alias?: string
  readonly thinking?: { readonly levels?: readonly string[] }
}

interface CredentialConfig {
  readonly name: string
  readonly apiKey: string
  readonly baseUrl: string
  readonly headers?: Readonly<Record<string, string>>
  readonly models: readonly ModelEntry[]
}

interface RegistryEntry {
  readonly id: string
  readonly displayName?: string
  readonly description?: string
  readonly supportedGenerationMethods?: readonly string[]
}

interface ServiceOptions {
  readonly credentials: readonly CredentialConfig[]
  readonly registry: readonly RegistryEntry[]
  readonly apiKeys: readonly string[]
  readonly store: Store
  readonly now: () => number
  readonly requestRetry: number
  readonly transientErrorCooldownSeconds: number
}

interface V1BetaRequest {
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

interface V1BetaResponse {
  readonly status: number
  readonly headers: HeaderList
  readonly body: string | ReadableStream<Uint8Array>
}

interface V1BetaService {
  handleV1Beta(request: V1BetaRequest, send: UpstreamSender): Promise<V1BetaResponse>
}

type AdapterFactory = (options: ServiceOptions) => V1BetaService

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
        'All 26 S2d2 golden cases SKIP until the gem2oai adapter ships; the required interface is documented in the header of this file.',
    }
  } catch (error) {
    return { skipReason: `import of \`${ADAPTER_MODULE}\` failed: ${String(error)}` }
  }
}

const adapterLoad = await loadAdapter()
const adapterFactory = adapterLoad.factory
const suite = adapterFactory ? describe : describe.skip
const suiteTitle = adapterFactory
  ? 'S2d2 — gem2oai golden contract (recorded fixtures)'
  : `S2d2 — gem2oai golden contract (SKIPPED: ${adapterLoad.skipReason ?? 'adapter unavailable'})`

// ─── Fixture access ───────────────────────────────────────────────────────────────────

const FIXTURE_ROOT = new URL('../fixtures/S2d2/', import.meta.url)
const FROZEN_NOW_MS = 1_789_492_684_000

/**
 * Recording-instance configuration, transcribed from the fixture wiring (spec §6): one
 * openai-compatibility provider `mock-openai` pointing at the worker-3 mock, one model.
 */
const CREDENTIALS: readonly CredentialConfig[] = [
  {
    name: 'mock-openai',
    apiKey: 'mock-upstream-key',
    baseUrl: 'http://host.docker.internal:20999/v1',
    models: [{ name: 'mock-gpt-model', alias: 'mock-model' }],
  },
]

/**
 * Global model registry, transcribed from the `gem2oai-models-list` golden: eight models
 * across all configured providers, in the recorded LIST order. `displayName` is the raw
 * registry field (the LIST and the raw GET map show it verbatim); `description` and
 * `supportedGenerationMethods` default per spec §2.4.
 */
const REGISTRY: readonly RegistryEntry[] = [
  { id: 'mock-model', displayName: 'mock-model' },
  { id: 'cm', displayName: 'claude-mock-model' },
  { id: 'vm', displayName: 'vertex-mock-model' },
  { id: 'gm', displayName: 'gemini-mock-model' },
  { id: 'xg', displayName: 'grok-mock' },
  { id: 'im', displayName: 'gemini-mock-model' },
  { id: 'mm', displayName: 'muse-mock' },
  { id: 'cx', displayName: 'gpt-mock-codex' },
]

/** Gateway api-keys of the recording config (meta.yaml `gateway_key`). */
const API_KEYS: readonly string[] = ['oracle-local-key-1']

/**
 * Stepwise clock offsets per case, in ms added to FROZEN_NOW_MS (see HARNESS SEMANTICS).
 * Cases not listed run every step at +0. The two cooldown-pair cases share one session,
 * so their offsets form one continuous schedule across the pair.
 */
const STEP_CLOCK_OFFSETS_MS: Readonly<Record<string, readonly number[]>> = {
  'gem2oai-error-429': [0, 2_500],
  'gem2oai-cooldown-after-429': [5_000, 5_100],
}

/** The two cases the oracle recorded back-to-back on one reference instance (see header). */
const COOLDOWN_PAIR_ORDER: readonly string[] = ['gem2oai-error-429', 'gem2oai-cooldown-after-429']

const EXPECTED_CASES = [
  'gem2oai-auth-styles',
  'gem2oai-auth-transports',
  'gem2oai-basic-params',
  'gem2oai-cooldown-after-429',
  'gem2oai-count-tokens',
  'gem2oai-count-tokens-tools',
  'gem2oai-error-429',
  'gem2oai-error-in-stream-payload',
  'gem2oai-model-resolution-errors',
  'gem2oai-models-list',
  'gem2oai-resp-nonstream-reasoning',
  'gem2oai-resp-nonstream-toolcall',
  'gem2oai-role-mapping',
  'gem2oai-stream-alt-json',
  'gem2oai-stream-disconnect',
  'gem2oai-stream-reasoning',
  'gem2oai-stream-slow',
  'gem2oai-stream-text-full',
  'gem2oai-stream-toolcall',
  'gem2oai-stream-toolcall-multi',
  'gem2oai-system-snake-multimodal',
  'gem2oai-thinking-clamps',
  'gem2oai-thinking-config',
  'gem2oai-thinking-invalid',
  'gem2oai-tool-roundtrip-request',
  'gem2oai-tools-toolconfig',
] as const

type CaseId = (typeof EXPECTED_CASES)[number]

const fixtureCaseDirs = (await readdir(FIXTURE_ROOT, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()

function caseFile(caseId: string, name: string): URL {
  return new URL(`${caseId}/${name}`, FIXTURE_ROOT)
}

async function readFixtureText(caseId: string, name: string): Promise<string> {
  // request.http / downstream.md carry CRLF line terminators; every compared surface is
  // CR-free, so terminators are normalized on read and never enter a byte comparison.
  const raw = await readFile(caseFile(caseId, name), 'utf8')
  return raw.replaceAll('\r\n', '\n')
}

async function readFixtureJson<T>(caseId: string, name: string): Promise<T> {
  return JSON.parse(await readFixtureText(caseId, name)) as T
}

// ─── Fixture file parsers (request.http / downstream.md) ─────────────────────────────

interface RecordedRequest {
  readonly method: string
  readonly path: string
  readonly headers: HeaderList
  readonly body: string
}

/**
 * Splits request.http into its `### Rn: <summary>` blocks and parses each into a request.
 * The head/body separator is a blank-line run, and blocks are separated by a blank line,
 * so the body slice is trimmed of surrounding newlines on both ends (request bodies in
 * this format are exact JSON bytes with no meaningful edge newlines; GET bodies are '').
 */
function parseRequestHttp(text: string): readonly RecordedRequest[] {
  const blocks = text.split(/\n### R\d+[^\n]*\n/).slice(1)
  return blocks.map((block) => {
    const separator = block.indexOf('\n\n')
    if (separator < 0) throw new Error('request.http block is missing a head/body separator')
    const head = block.slice(0, separator)
    const body = block.slice(separator + 2).replace(/^\n+/, '').replace(/\n+$/, '')
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
  readonly claimedBodyBytes: number
}

function parseHeadBlock(lines: readonly string[]): { status: number; headers: Array<[string, string]> } {
  const statusLine = lines[0] ?? ''
  if (!statusLine.startsWith('HTTP/1.1 ')) {
    throw new Error(`downstream.md response head must start with an HTTP/1.1 status line, got: ${statusLine}`)
  }
  const status = Number(statusLine.split(' ')[1])
  if (!Number.isInteger(status) || status <= 0) {
    throw new Error(`downstream.md status line does not carry a numeric status: ${statusLine}`)
  }
  const headers: Array<[string, string]> = []
  for (const line of lines.slice(1)) {
    if (line === '') break
    const colon = line.indexOf(': ')
    if (colon <= 0) continue
    headers.push([line.slice(0, colon), line.slice(colon + 2)])
  }
  return { status, headers }
}

/**
 * Splits downstream.md into its `## Rn` sections. Per section the first fenced block is
 * the response head; the fenced block after `### Body (N bytes, exact)` is the body
 * (lines joined with '\n' — this reproduces the recorded bytes, including the trailing
 * blank lines of SSE bodies).
 */
function parseDownstreamMarkdown(text: string): Readonly<Record<string, RecordedResponse>> {
  const sections: Record<string, RecordedResponse> = {}
  // Prepend a newline so a section marker at position 0 matches the same \n-anchored
  // pattern as the later ones; every index below refers to this normalized string.
  const normalized = `\n${text}`
  const markers = [...normalized.matchAll(/\n## (R\d+)\n/g)]
  for (let index = 0; index < markers.length; index += 1) {
    const marker = markers[index]
    if (marker === undefined) continue
    const sectionId = marker[1] ?? ''
    const start = (marker.index ?? 0) + marker[0].length
    const next = markers[index + 1]
    const end = next?.index ?? normalized.length
    const section = normalized.slice(start, end)

    const headMatch = section.match(/```\n(HTTP\/1\.1[^\n]*)\n([\s\S]*?)\n```/)
    if (headMatch === null) throw new Error(`downstream.md ${sectionId}: missing response-head fence`)
    const head = parseHeadBlock([headMatch[1] ?? '', ...((headMatch[2] ?? '').split('\n'))])

    const bodyMatch = section.match(/### Body \((\d+) bytes, exact\)\n```\n([\s\S]*?)\n```/)
    if (bodyMatch === null) throw new Error(`downstream.md ${sectionId}: missing body fence`)
    sections[sectionId] = {
      status: head.status,
      headers: head.headers,
      body: bodyMatch[2] ?? '',
      claimedBodyBytes: Number(bodyMatch[1]),
    }
  }
  return sections
}

// ─── Masking (meta.yaml dynamic_fields → recognition) ───────────────────────────────

interface MaskProfile {
  /** Mask the trailing `:port` of the upstream Host header on both sides of the wire compare. */
  readonly upstreamHostPort: boolean
}

function maskProfile(caseId: string, dynamicFields: readonly string[]): MaskProfile {
  for (const field of dynamicFields) {
    if (
      field === 'Date' || // never compared: outside the asserted header subset, absent from bodies
      field === 'X-Cpa-Trace-Id' || // presence-only assertion; value never compared
      field === 'upstream Host header port (20999)' ||
      field === 'mock wire log ts field' || // recording-only jsonl metadata, excluded from compare
      field === 'createTime / responseId-like ids where present' // no compared surface carries one in this batch
    ) {
      continue
    }
    throw new Error(
      `S2d2[${caseId}]: unrecognized meta.yaml dynamic_fields entry ${JSON.stringify(field)} — ` +
        'extend the mask table in tests/contract/s2d2-gem2oai.test.ts consciously',
    )
  }
  return { upstreamHostPort: true }
}

const PORT_SUFFIX_RE = /:\d+$/

function normalizeHeaderValue(name: string, value: string, mask: MaskProfile): string {
  if (name.toLowerCase() === 'host' && mask.upstreamHostPort) return value.replace(PORT_SUFFIX_RE, ':<PORT>')
  return value
}

// ─── Canned mock upstream (mock-response.json control shapes) ───────────────────────

interface MockControlFile {
  readonly mode?: string
  readonly status?: number
  readonly scenario?: string
  readonly after?: number
  readonly delay_ms?: number
}

interface MockReply {
  readonly status?: number
  readonly response_body?: string
  readonly body_raw?: string
  readonly sse_frames?: readonly string[]
}

interface MockResponseFile {
  readonly control_file?: MockControlFile
  readonly reply?: MockReply | null
}

interface RecordedUpstreamLine {
  readonly method: string
  readonly path: string
  readonly headers: Record<string, string>
  readonly body: string
}

interface CaseMeta {
  readonly case: string
  readonly dynamic_fields: readonly string[]
  readonly upstream_wire_lines_per_request: readonly number[]
}

const encoder = new TextEncoder()

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Demand-driven byte stream: every pull hands out one chunk; the read after the last
 * chunk either closes (clean EOF) or errors (disconnect). `abortError` carries the
 * transport error text the adapter must surface in the terminal error frame.
 */
function scriptedByteStream(
  chunks: readonly Uint8Array[],
  options: { readonly abortAfter?: number; readonly delayMs?: number; readonly abortError?: string } = {},
): ReadableStream<Uint8Array> {
  let served = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const index = served
      served += 1
      if (options.delayMs !== undefined && index > 0) await sleep(options.delayMs)
      if (options.abortAfter !== undefined && index >= options.abortAfter) {
        controller.error(new Error(options.abortError ?? 'mock upstream: connection reset mid-stream'))
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

/** Builds the upstream response for one captured call from the case's scripted control. */
function buildMockResponse(mockFile: MockResponseFile, caseId: string): UpstreamResponse {
  const control = mockFile.control_file
  if (control === undefined) {
    throw new Error(`S2d2[${caseId}]: mock-response.json is missing its control_file`)
  }
  const reply = mockFile.reply
  if (reply === null || reply === undefined) {
    // Gateway-local fixture: every recorded upstream log for these cases is empty, so a
    // call here is an adapter defect — fail with the clearest possible message.
    throw new Error(`S2d2[${caseId}]: gateway-local fixture — the upstream must NOT be called`)
  }
  const mode = control.mode ?? 'happy'
  if (mode === 'error') {
    if (reply.body_raw === undefined) {
      throw new Error(`S2d2[${caseId}]: error control must carry reply.body_raw (the recorded verbatim bytes)`)
    }
    const status = reply.status ?? control.status
    if (status === undefined) throw new Error(`S2d2[${caseId}]: error control carries no status`)
    return {
      status,
      headers: [['Content-Type', 'application/json']],
      body: scriptedByteStream([encoder.encode(reply.body_raw)]),
    }
  }
  if (reply.sse_frames !== undefined) {
    const chunks = reply.sse_frames.map((frame) => encoder.encode(frame))
    return {
      status: 200,
      headers: [['Content-Type', 'text/event-stream']],
      body: scriptedByteStream(chunks, {
        delayMs: mode === 'slow' ? control.delay_ms : undefined,
        abortAfter: mode === 'disconnect' ? control.after : undefined,
        // Spec §5.4: the terminal frame carries the transport error text; the reference
        // surfaced "unexpected EOF" for a chunked body that ended without its terminator.
        abortError: 'unexpected EOF',
      }),
    }
  }
  if (reply.response_body !== undefined) {
    return {
      status: reply.status ?? 200,
      headers: [['Content-Type', 'application/json']],
      body: scriptedByteStream([encoder.encode(reply.response_body)]),
    }
  }
  throw new Error(`S2d2[${caseId}]: mock reply shape not recognized by the harness`)
}

// ─── Comparison helpers ──────────────────────────────────────────────────────────────

function headerValue(headers: HeaderList, name: string): string | undefined {
  const key = name.toLowerCase()
  for (const [headerName, value] of headers) {
    if (headerName.toLowerCase() === key) return value
  }
  return undefined
}

async function readResponseBody(body: V1BetaResponse['body']): Promise<string> {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// ─── SSE decoding + R-ORDER canonicalization ────────────────────────────────────────

interface SseFrame {
  readonly event: string | undefined
  readonly data: string
}

/**
 * Decodes an SSE body into its ordered (`event?`, `data`) frames per R-SSE. Framing bytes
 * and chunk boundaries never reach the comparison. Comment lines are a contract violation
 * (keep-alives are disabled in the golden configuration), so they fail loudly.
 */
function decodeSseEvents(body: string): readonly SseFrame[] {
  const frames: SseFrame[] = []
  for (const block of body.split('\n\n')) {
    if (block === '') continue
    let event: string | undefined
    const dataLines: string[] = []
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) {
        throw new Error(`SSE comment line violates the golden configuration: ${truncate(line)}`)
      }
      if (line === '') continue
      if (line.startsWith('event: ')) {
        event = line.slice('event: '.length)
        continue
      }
      if (line.startsWith('data: ')) {
        dataLines.push(line.slice('data: '.length))
        continue
      }
      throw new Error(`unrecognized SSE line: ${truncate(line)}`)
    }
    if (dataLines.length > 0) frames.push({ event, data: dataLines.join('\n') })
  }
  return frames
}

/** R-ORDER sort key for a gemini part: functionCall.name, then functionCall.id (§7 N5). */
function canonicalPartKey(part: unknown): string {
  if (isRecord(part) && isRecord(part['functionCall'])) {
    const call = part['functionCall']
    const name = typeof call['name'] === 'string' ? call['name'] : ''
    const id = typeof call['id'] === 'string' ? call['id'] : ''
    return `functionCall\u0000${name}\u0000${id}`
  }
  return `raw\u0000${JSON.stringify(part) ?? ''}`
}

/**
 * Canonicalizes a decoded frame for comparison. Frames whose candidates[0].content.parts
 * carries TWO OR MORE functionCall entries are re-serialized with the parts sorted by the
 * R-ORDER key (the reference emits them in nondeterministic map-iteration order); every
 * other frame is returned byte-untouched. Both sides pass through the identical
 * transformation, so all bytes except the part ORDER inside multi-tool frames stay pinned.
 */
function canonicalizeFrameData(data: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return data
  }
  if (!isRecord(parsed)) return data
  const candidates = parsed['candidates']
  if (!Array.isArray(candidates)) return data
  const first = candidates[0]
  if (!isRecord(first) || !isRecord(first['content'])) return data
  const parts = first['content']['parts']
  if (!Array.isArray(parts)) return data
  const functionCallCount = parts.filter((part) => isRecord(part) && 'functionCall' in part).length
  if (functionCallCount < 2) return data
  const sortedParts = [...parts].sort((left, right) => {
    const leftKey = canonicalPartKey(left)
    const rightKey = canonicalPartKey(right)
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
  })
  const rebuiltFirst: Record<string, unknown> = { ...first, content: { ...first['content'], parts: sortedParts } }
  const rebuiltCandidates = candidates.map((entry, index) => (index === 0 ? rebuiltFirst : entry))
  return JSON.stringify({ ...parsed, candidates: rebuiltCandidates })
}

function firstFrameDifference(actual: readonly SseFrame[], expected: readonly SseFrame[]): string {
  const count = Math.min(actual.length, expected.length)
  for (let index = 0; index < count; index += 1) {
    const expectedFrame = expected[index]
    const actualFrame = actual[index]
    if (expectedFrame === undefined || actualFrame === undefined) continue
    if (expectedFrame.event !== actualFrame.event || expectedFrame.data !== actualFrame.data) {
      return `frame ${index}: recorded ${truncate(expectedFrame.data)} vs produced ${truncate(actualFrame.data)}`
    }
  }
  return count === 0 ? 'one side is empty' : 'common prefix matches; one side has extra trailing frames'
}

function expectEventSequence(actual: readonly SseFrame[], expected: readonly SseFrame[], context: string): void {
  if (actual.length !== expected.length) {
    throw new Error(
      `${context}: decoded SSE frame count ${actual.length} != recorded ${expected.length}. ` +
        `First difference: ${firstFrameDifference(actual, expected)}`,
    )
  }
  for (let index = 0; index < expected.length; index += 1) {
    const expectedFrame = expected[index]
    const actualFrame = actual[index]
    if (expectedFrame === undefined || actualFrame === undefined) continue
    expect(actualFrame.event, `${context}: SSE frame ${index} event name`).toBe(expectedFrame.event)
    expect(
      canonicalizeFrameData(actualFrame.data),
      `${context}: SSE frame ${index} payload (multi-tool frames canonicalized per R-ORDER)`,
    ).toBe(canonicalizeFrameData(expectedFrame.data))
  }
}

// ─── Wire + downstream assertions ────────────────────────────────────────────────────

function assertUpstreamWire(
  recorded: RecordedUpstreamLine,
  call: UpstreamRequest,
  mask: MaskProfile,
  baseUrl: string,
  caseId: string,
): void {
  const context = `S2d2[${caseId}] upstream wire`
  expect(call.method, `${context}: method`).toBe(recorded.method)
  expect(call.url, `${context}: url (trimmed baseUrl + recorded path)`).toBe(
    `${baseUrl.replace(/\/$/, '')}${recorded.path}`,
  )

  const expectedPairs: Array<[string, string]> = []
  for (const [name, value] of Object.entries(recorded.headers)) {
    if (name.toLowerCase() === 'content-length') continue // transport-derived; consistency-checked below
    expectedPairs.push([name, normalizeHeaderValue(name, value, mask)])
  }
  const actualPairs: Array<[string, string]> = []
  let actualContentLength: string | undefined
  for (const [name, value] of call.headers) {
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
      String(encoder.encode(call.body).length),
    )
  }
  // No dynamic field of this batch appears inside an upstream body — byte-exact as recorded.
  expect(call.body, `${context}: translated body bytes`).toBe(recorded.body)
}

/** Cooldown envelope sanity: Retry-After == reset_seconds == the integer inside reset_time. */
function assertCooldownEnvelope(retryAfter: string | undefined, body: string, context: string): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new Error(`${context}: model_cooldown body must be valid JSON`)
  }
  if (!isRecord(parsed) || !isRecord(parsed['error'])) {
    throw new Error(`${context}: model_cooldown body must carry an error object`)
  }
  const error = parsed['error']
  const resetSeconds = error['reset_seconds']
  const resetTime = error['reset_time']
  if (typeof resetSeconds !== 'number' || !Number.isInteger(resetSeconds) || resetSeconds <= 0) {
    throw new Error(`${context}: reset_seconds must be a positive integer, got ${String(resetSeconds)}`)
  }
  expect(resetTime, `${context}: reset_time echoes reset_seconds`).toBe(`${resetSeconds}s`)
  if (retryAfter !== undefined) {
    expect(Number(retryAfter), `${context}: Retry-After echoes reset_seconds`).toBe(resetSeconds)
  }
}

async function assertDownstreamStep(
  response: V1BetaResponse,
  expected: RecordedResponse,
  caseId: string,
  step: number,
): Promise<void> {
  const context = `S2d2[${caseId}] step ${step} downstream`
  const body = await readResponseBody(response.body)
  expect(response.status, `${context}: status`).toBe(expected.status)

  const expectedContentType = headerValue(expected.headers, 'content-type')
  const actualContentType = headerValue(response.headers, 'content-type')
  if (expectedContentType === undefined) {
    expect(actualContentType, `${context}: Content-Type must be absent when the recording has none`).toBeUndefined()
  } else {
    expect(actualContentType, `${context}: Content-Type`).toBe(expectedContentType)
  }

  for (const name of ['cache-control', 'connection', 'retry-after']) {
    const expectedValue = headerValue(expected.headers, name)
    const actualValue = headerValue(response.headers, name)
    if (expectedValue === undefined) {
      expect(actualValue, `${context}: ${name} must be absent when the recording has none`).toBeUndefined()
    } else {
      expect(actualValue, `${context}: ${name}`).toBe(expectedValue)
    }
  }

  const expectedTrace = headerValue(expected.headers, 'x-cpa-trace-id') !== undefined
  expect(
    headerValue(response.headers, 'x-cpa-trace-id') !== undefined,
    `${context}: X-Cpa-Trace-Id presence must match the recorded head`,
  ).toBe(expectedTrace)

  if (expectedContentType === 'text/event-stream') {
    expect(body.includes('data: [DONE]'), `${context}: [DONE] must never reach a gemini client (§4.1)`).toBe(false)
    expectEventSequence(decodeSseEvents(body), decodeSseEvents(expected.body), context)
  } else {
    // Raw-chunk (alt=json) and non-stream bodies compare byte-exactly; reading the full
    // stream makes stream chunk boundaries irrelevant by construction.
    expect(body, `${context}: body bytes`).toBe(expected.body)
  }

  if (expected.body.includes('"code":"model_cooldown"')) {
    assertCooldownEnvelope(headerValue(response.headers, 'retry-after'), body, context)
  }
}

// ─── Sessions + case runner ──────────────────────────────────────────────────────────

interface HarnessSession {
  readonly service: V1BetaService
  /** Freezes `now()` at FROZEN_NOW_MS + offsetMs for the next handled request. */
  setClock(offsetMs: number): void
}

function createSession(): HarnessSession {
  const factory = adapterFactory
  if (factory === undefined) throw new Error('adapter factory missing')
  let clockMs = FROZEN_NOW_MS
  const now = (): number => clockMs
  const store = new MemoryStore({ now })
  const service = factory({
    credentials: CREDENTIALS,
    registry: REGISTRY,
    apiKeys: API_KEYS,
    store,
    now,
    requestRetry: 0,
    transientErrorCooldownSeconds: -1, // recording config; 429 cooldown stays active (§5.3)
  })
  if (typeof service.handleV1Beta !== 'function') {
    throw new Error(`${ADAPTER_EXPORT}() must return an object with a handleV1Beta(request, send) method`)
  }
  return {
    service,
    setClock: (offsetMs: number) => {
      clockMs = FROZEN_NOW_MS + offsetMs
    },
  }
}

async function replayCase(caseId: CaseId, session: HarnessSession): Promise<void> {
  const meta = await readFixtureJson<CaseMeta>(caseId, 'meta.yaml')
  const mockFile = await readFixtureJson<MockResponseFile>(caseId, 'mock-response.json')
  const mask = maskProfile(caseId, meta.dynamic_fields)
  const requests = parseRequestHttp(await readFixtureText(caseId, 'request.http'))
  const downstream = parseDownstreamMarkdown(await readFixtureText(caseId, 'downstream.md'))
  const recordedUpstream = (await readFixtureText(caseId, 'upstream.jsonl'))
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as RecordedUpstreamLine)
  const offsets = STEP_CLOCK_OFFSETS_MS[caseId]

  expect(
    requests.length,
    `S2d2[${caseId}]: request blocks must match meta.upstream_wire_lines_per_request`,
  ).toBe(meta.upstream_wire_lines_per_request.length)

  const captured: UpstreamRequest[] = []
  const send: UpstreamSender = async (call) => {
    captured.push(call)
    return buildMockResponse(mockFile, caseId)
  }

  for (let step = 1; step <= requests.length; step += 1) {
    const request = requests[step - 1]
    const expected = downstream[`R${step}`]
    expect(expected, `S2d2[${caseId}] step ${step}: fixture must record a downstream response`).toBeDefined()
    if (request === undefined || expected === undefined) continue
    session.setClock(offsets?.[step - 1] ?? 0)
    const response = await session.service.handleV1Beta(request, send)
    await assertDownstreamStep(response, expected, caseId, step)
  }

  expect(
    captured.length,
    `S2d2[${caseId}]: upstream call count (cooldown / countTokens / discovery / auth / resolution steps must not call upstream)`,
  ).toBe(recordedUpstream.length)
  for (let index = 0; index < recordedUpstream.length; index += 1) {
    const recorded = recordedUpstream[index]
    const call = captured[index]
    expect(call, `S2d2[${caseId}]: missing upstream call ${index + 1}`).toBeDefined()
    if (recorded === undefined || call === undefined) continue
    assertUpstreamWire(recorded, call, mask, CREDENTIALS[0]?.baseUrl ?? '', caseId)
  }
}

// ─── Suites ──────────────────────────────────────────────────────────────────────────

const ISOLATED_CASES = EXPECTED_CASES.filter((caseId) => !COOLDOWN_PAIR_ORDER.includes(caseId))

describe('S2d2 fixture inventory (harness self-check, adapter-independent)', () => {
  it('exposes exactly the 26 admitted golden cases, each internally consistent', async () => {
    expect([...fixtureCaseDirs]).toEqual([...EXPECTED_CASES].sort())
    for (const caseId of COOLDOWN_PAIR_ORDER) {
      expect(EXPECTED_CASES, 'the escalation pair must be part of the case list').toContain(caseId)
    }

    let totalRequests = 0
    for (const caseId of EXPECTED_CASES) {
      const meta = await readFixtureJson<CaseMeta>(caseId, 'meta.yaml')
      const mockFile = await readFixtureJson<MockResponseFile>(caseId, 'mock-response.json')
      const requests = parseRequestHttp(await readFixtureText(caseId, 'request.http'))
      const downstream = parseDownstreamMarkdown(await readFixtureText(caseId, 'downstream.md'))
      const upstreamLines = (await readFixtureText(caseId, 'upstream.jsonl'))
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as RecordedUpstreamLine)

      expect(meta.case, `${caseId}: meta.case echoes the directory name`).toBe(caseId)
      maskProfile(caseId, meta.dynamic_fields) // fails loudly on unknown dynamic fields
      expect(requests.length, `${caseId}: request block count`).toBe(meta.upstream_wire_lines_per_request.length)
      expect(upstreamLines.length, `${caseId}: upstream wire lines`).toBe(
        meta.upstream_wire_lines_per_request.reduce((sum, count) => sum + count, 0),
      )
      expect(mockFile.control_file, `${caseId}: mock control present`).toBeDefined()
      totalRequests += requests.length

      for (let step = 1; step <= requests.length; step += 1) {
        const request = requests[step - 1]
        const expected = downstream[`R${step}`]
        expect(expected, `${caseId} R${step}: downstream section present`).toBeDefined()
        if (request === undefined || expected === undefined) continue
        expect(['GET', 'POST'], `${caseId} R${step}: route method`).toContain(request.method)
        expect(request.path.startsWith('/v1beta'), `${caseId} R${step}: route path`).toBe(true)
        const contentLength = headerValue(request.headers, 'content-length')
        if (contentLength !== undefined) {
          expect(Number(contentLength), `${caseId} R${step}: body bytes match Content-Length`).toBe(
            encoder.encode(request.body).length,
          )
        }
        expect(encoder.encode(expected.body).length, `${caseId} R${step}: body bytes match the recorded claim`).toBe(
          expected.claimedBodyBytes,
        )
        if (headerValue(expected.headers, 'content-type') === 'text/event-stream') {
          expect(() => decodeSseEvents(expected.body), `${caseId} R${step}: recorded SSE body decodes`).not.toThrow()
        }
      }

      for (const [index, line] of upstreamLines.entries()) {
        expect(line.method, `${caseId} upstream ${index + 1}: method`).toBe('POST')
        expect(line.path, `${caseId} upstream ${index + 1}: path`).toBe('/v1/chat/completions')
      }

      if (mockFile.reply === null || mockFile.reply === undefined) {
        expect(upstreamLines.length, `${caseId}: gateway-local fixture records no upstream calls`).toBe(0)
      }

      const offsets = STEP_CLOCK_OFFSETS_MS[caseId]
      if (offsets !== undefined) {
        expect(offsets.length, `${caseId}: clock schedule covers every step`).toBe(requests.length)
      }
    }

    // Spec §5.3 directs contract tests to the fixture's recorded cooldown timing; the
    // replay byte-compares against it, so cross-check its internal consistency here.
    const cooldownSections = parseDownstreamMarkdown(
      await readFixtureText('gem2oai-cooldown-after-429', 'downstream.md'),
    )
    const cooldownR2 = cooldownSections['R2']
    expect(cooldownR2, 'cooldown fixture must record the R2 model_cooldown response').toBeDefined()
    if (cooldownR2 !== undefined) {
      assertCooldownEnvelope(
        headerValue(cooldownR2.headers, 'retry-after'),
        cooldownR2.body,
        'fixture gem2oai-cooldown-after-429 R2',
      )
    }

    expect(totalRequests, '26 cases replay 53 recorded requests in total').toBe(53)
  })
})

suite(suiteTitle, () => {
  for (const caseId of ISOLATED_CASES) {
    it(`${caseId} — replays recorded steps: upstream wire byte-exact, downstream surface byte-exact`, async () => {
      await replayCase(caseId, createSession())
    })
  }

  it(
    'gem2oai-error-429 → gem2oai-cooldown-after-429 — cooldown escalation pair on one shared session, recording order ' +
      '(pins the recorded model_cooldown envelope byte-exactly, incl. Retry-After 4 / reset_seconds 4)',
    async () => {
      const session = createSession()
      await replayCase('gem2oai-error-429', session)
      await replayCase('gem2oai-cooldown-after-429', session)
    },
  )
})
