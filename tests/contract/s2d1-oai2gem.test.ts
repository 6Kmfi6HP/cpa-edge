/**
 * S2d1 golden contract — OpenAI Chat Completions client → Gemini (GenerateContent) upstream.
 *
 * Spec source of truth: spec/sections/S2d1-oai2gem.md (admitted). Goldens: the 23 recorded
 * fixture cases under tests/fixtures/S2d1/ — oracle wire transcripts of CLIProxyAPI v7.3.4
 * against the deterministic gemini mock (RECORDABLE-LOCALLY per R-FIXTURE; transcripts only,
 * no upstream source text). Rulings applied: R-SSE (downstream stream bodies compare as
 * DECODED `data:` frame sequences plus the terminal `data: [DONE]`, never transport chunk
 * boundaries), the trace-family ruling (`X-Cpa-Trace-Id`/`X-Cpa-*` values are recognized and
 * never compared; presence is pinned against the recorded head), NE-LENIENT (every replayed
 * request body is well-formed JSON; the strict 400-on-garbage boundary is a registered
 * non-equivalence outside these goldens and the inventory self-check rejects a non-JSON
 * request body). R-ORDER is recorded here as NOT APPLICABLE: no golden carries a frame with
 * two or more tool calls or any other run of interchangeably-ordered adjacent parts — every
 * frame is order-pinned. R-TOK has no surface here (countTokens is out of scope for this
 * direction, spec §1); R-404 and R-BCRYPT touch S1/S3-S6 behavior no fixture exercises.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * ADAPTER INTERFACE — what the `@cpa-edge/translators/oai2gem` direction module MUST
 * export. The suite dynamically imports the package and turns green-to-red once the
 * export ships; while the package is still a skeleton every case test SKIPS with the
 * reason below. The harness holds its own structural mirror of these types; the package
 * should export the real ones. All shapes are runtime-checked by the suite.
 *
 *   export function createOai2GemService(options: Oai2GemServiceOptions): Oai2GemChatService
 *
 *   type HeaderList = ReadonlyArray<readonly [string, string]>   // ordered, original casing
 *
 *   interface Oai2GemModelEntry {         // one gemini-api-key model of a credential
 *     name: string                        // upstream model name; the wire URL and the
 *                                          // translated body carry this name (alias target)
 *     alias?: string                      // client-facing alias; defaults to `name`. A
 *                                          // thinking suffix `alias(<suffix>)` is parsed:
 *                                          // the suffix is stripped for alias lookup AND
 *                                          // from the upstream URL/body model (C08)
 *     forceMapping?: boolean              // rewrite the response/chunk `model` field to the
 *                                          // client alias on EVERY downstream frame (C20/C21)
 *     thinking?: { levels?: readonly string[] }
 *                                          // capability override. ABSENT on every S2d1
 *                                          // fixture model: the capability pass then strips
 *                                          // a translated thinkingConfig (C07 leaves
 *                                          // `generationConfig:{}`) and silently drops a
 *                                          // model-name thinking suffix (C08). The levels
 *                                          // path is config-dependent, not golden-covered.
 *   }
 *
 *   interface Oai2GemCredential {         // one gemini-api-key provider entry
 *     apiKey: string                      // sent as `x-goog-api-key: <apiKey>` — the ONLY
 *                                          // auth header upstream (no Authorization)
 *     baseUrl: string                     // e.g. "http://host.docker.internal:20001";
 *                                          // trailing "/" trimmed; upstream URL =
 *                                          // `<baseUrl>/v1beta/models/{model}:generateContent`
 *                                          // (non-stream) or
 *                                          // `<baseUrl>/v1beta/models/{model}:streamGenerateContent?alt=sse`
 *     headers?: Readonly<Record<string, string>>
 *                                          // per-credential custom headers (spec §2.3;
 *                                          // OPTIONAL — no golden exercises it)
 *     models: readonly Oai2GemModelEntry[]
 *   }
 *
 *   interface Oai2GemServiceOptions {
 *     apiKeys: readonly string[]          // gateway api-keys; the client gate is
 *                                          // `Authorization: Bearer <api-key>`. The 401
 *                                          // shapes are S1-owned and pinned by no S2d1
 *                                          // fixture; every recorded request carries the
 *                                          // valid key and the service must accept it.
 *     credentials: readonly Oai2GemCredential[]  // gemini-api-key entries, config order
 *     store: Store                        // from @cpa-edge/core; ALL persistent state (the
 *                                          // 429 model cooldown) flows through it
 *     now?: () => number                   // epoch-ms clock; MUST drive every timing
 *                                          // decision (cooldown window open/close,
 *                                          // reset_seconds)
 *     requestRetry?: number                // 0 in every S2d1 fixture (single attempt)
 *     transientErrorCooldownSeconds?: number
 *                                          // -1 in every S2d1 fixture. NOTE (spec §5): -1
 *                                          // disables only transient-error cooldowns; the
 *                                          // ~1s rate-limit cooldown stays ACTIVE.
 *   }
 *
 *   interface Oai2GemChatRequest {
 *     method: string                      // 'POST'
 *     path: string                        // '/v1/chat/completions'
 *     headers: HeaderList                  // client headers, recorded order + casing; they
 *                                          // are NEVER forwarded upstream (spec §2.3)
 *     body: string                        // exact request-body bytes (well-formed JSON)
 *   }
 *
 *   interface Oai2GemUpstreamRequest {
 *     method: string                       // 'POST'
 *     url: string                         // absolute `<trimmed baseUrl><recorded path>`
 *     headers: HeaderList                  // emission ORDER is pinned (see below)
 *     body: string
 *   }
 *
 *   interface Oai2GemUpstreamResponse {
 *     status: number
 *     headers: HeaderList
 *     body: ReadableStream<Uint8Array>     // 2xx stream: SSE bytes; 2xx non-stream: JSON
 *                                           // bytes; non-2xx: raw error bytes. A rejected
 *                                           // read mid-body models an upstream disconnect.
 *   }
 *
 *   type Oai2GemUpstreamSender =
 *     (request: Oai2GemUpstreamRequest) => Promise<Oai2GemUpstreamResponse>
 *
 *   interface Oai2GemChatResponse {
 *     status: number
 *     headers: HeaderList                  // must carry the direction-owned subset (below)
 *     body: string | ReadableStream<Uint8Array>
 *   }
 *
 *   interface Oai2GemChatService {
 *     handleChatCompletions(
 *       request: Oai2GemChatRequest,
 *       send: Oai2GemUpstreamSender,
 *     ): Promise<Oai2GemChatResponse>
 *   }
 *
 * The facade covers the whole pinned direction pipeline for the /v1/chat/completions
 * surface: the Bearer api-key gate (401 shapes S1-owned), client-alias model resolution
 * incl. the thinking-suffix parse/strip (spec §2.2), request translation (spec §3.1:
 * systemInstruction extraction, contents roles, the synthetic functionResponse user turn,
 * tools → functionDeclarations with the raw parametersJsonSchema passthrough, sampling →
 * generationConfig), executor post-processing (spec §3.2: the thinking capability
 * strip/drop for config-declared thinking-less models, the always-injected 5-category
 * safetySettings block), the gemini upstream wire (spec §2.3: URL templates, the
 * x-goog-api-key-only auth, the Go-http-client/1.1 transport default), non-stream response
 * mapping (spec §3.3), stream chunk mapping + the usage filter and finish_reason timing
 * rules (spec §4), downstream SSE framing incl. the terminal [DONE] and the mid-stream
 * terminal error frame, and error semantics (spec §5: verbatim non-2xx pass-through, the
 * 429 → model cooldown envelope with Retry-After, the pre-commit JSON error response).
 * Internals may compose the gemini executor and core scheduling primitives; only this
 * facade is contract.
 *
 * OUT of scope here (owned by S1/the runtime, asserted by no fixture in this suite): the
 * CORS block, Date emission, Connection/Transfer-Encoding/Content-Length exactness
 * (transport-owned; `Connection` is volatile per spec §2.1), OPTIONS/404 routing semantics,
 * keep-alive watchdogs (disabled in the golden configuration).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * HARNESS SEMANTICS
 *
 * • Fixture layout per case (RECIPES, reports/oracle/BOOTSTRAP.md §7): meta.yaml (JSON),
 *   request.http (exactly ONE recorded request), downstream.md (status + raw response
 *   headers + the decoded body fence with a byte claim — stream cases additionally carry a
 *   raw-chunked section that this harness NEVER reads, per R-SSE), upstream.jsonl (one JSON
 *   line per upstream request; `ts`/`type` are recording-only metadata), mock-response.json
 *   (the scripted upstream behavior). request.http/downstream.md are CRLF-normalized on
 *   read; every compared surface is CR-free (verified across all 23 cases).
 *
 * • SESSIONS. Every case replays through a FRESH service + FRESH MemoryStore (per-case
 *   isolation; C03/C04/C12 share an alias but not state). The exception is the cooldown
 *   pair: the oracle recorded C15 (21:16:55.630, the verbatim 429 that opens the ~1s
 *   rate-limit window) back-to-back with C16 (21:16:55.651, <25ms later, inside the
 *   window) on ONE reference instance. C16's replay is therefore COMPOSED: its test replays
 *   C15 first (step 1) and then C16's own request (step 2) through one shared service +
 *   Store, in recording order. C15 ALSO has its own standalone test (a fresh session
 *   reproduces its recorded bytes with no history).
 *
 * • CLOCK. Real wall-clock time is never consulted. Every session runs a frozen clock
 *   (`now()` returns a constant epoch), so C16's request always lands INSIDE the 1s window
 *   and the pinned literals `Retry-After: 1` / `"reset_seconds":1` / `"reset_time":"1s"`
 *   compare byte-exact with NO masking (the same decision the S2d3 suite made for its
 *   scripted-429 cooldown case). No other golden depends on time: every recorded `created`
 *   is 0 (the mock sends no createTime) and no compared surface embeds a date.
 *
 * • MOCK UPSTREAM. Each case's mock-response.json drives every upstream call the case
 *   makes. `control_file.mode === 'error'` → non-2xx with the recorded status (default 429)
 *   and the verbatim error bytes: `error_body` embedded in the control (C17) serialized
 *   with Python json.dumps spacing, or the mock's default gemini error body (C15/C18 —
 *   byte-identical to the recorded verbatim pass-through). `mode === 'disconnect'` (C19)
 *   serves the first `after` stream events, then rejects the read with `new Error('unexpected
 *   EOF')` — the transport error text the reference surfaced for a chunked body that ends
 *   without its terminator; the adapter must propagate that text into the terminal frame.
 *   `mode === 'happy'`: a structured `stream_events` array replays one SSE data frame per
 *   event (C12/C13/C14/C19/C22/C23); a structured object is the non-stream reply
 *   (C04/C05/C06/C09); a STRING `scripted_mock_response` denotes the mock's DEFAULT reply
 *   (C01/C02/C03/C07/C08/C10/C11/C20/C21), which the harness reconstructs from the recorded
 *   evidence: the fixed default text/usage with `modelVersion` echoing the translated
 *   upstream body's `model` — so a mistranslated model also corrupts the downstream echo.
 *
 * • Upstream calls are captured per case; at the end the captured sequence must equal the
 *   recorded upstream.jsonl lines (count + bytes). The C16 cooldown step therefore also
 *   pins "no upstream call while cooling".
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * COMPARISON RULES
 *
 * Upstream wire (primary gold):
 *   - method, url (trimmed baseUrl + recorded path), body: byte-exact. Translated bodies
 *     are compact JSON with a pinned top-level key order — contents, model,
 *     [generationConfig], [systemInstruction], [tools], safetySettings — ending with the
 *     injected 5-category safetySettings block; `parametersJsonSchema` preserves the
 *     client's raw schema bytes including its original spacing (C03/C04/C12), and the
 *     literal thoughtSignature sentinel `skip_thought_signature_validator` appears on
 *     tool-call parts (C03) and user image parts (C10). No dynamic field appears inside
 *     any upstream body in this batch.
 *   - headers: the full ordered list, names case-preserved, in the recorded order
 *     `Host, User-Agent, [Content-Length], Content-Type, X-Goog-Api-Key, Accept-Encoding`.
 *     `Content-Length` is excluded from the ordered compare (transport-derived) and
 *     instead consistency-checked. `X-Goog-Api-Key` is redacted in the recordings; the
 *     adapter's value must EQUAL the configured credential apiKey (the whole header value
 *     is the key) and is then normalized to "<redacted>". The `Host` port is masked per
 *     meta.yaml (`:<PORT>`). The list compare pins the absence of `Authorization` and of
 *     any forwarded client header.
 *
 * Downstream (per step):
 *   - status: exact.
 *   - headers: only the direction-owned subset is asserted (presence AND value, absence
 *     included): `Content-Type` (exact — `text/event-stream` on SSE commits,
 *     `application/json` otherwise), `Cache-Control` (`no-cache` exactly on SSE commits,
 *     absent otherwise — this pins "no SSE headers before commit" for C15/C16/C17/C18),
 *     `Retry-After` (exact when recorded — C16 pins `1`; absent otherwise), and
 *     `X-Cpa-Trace-Id` PRESENCE matching the recorded head (present on every
 *     executor-routed response; ABSENT on the gateway-local C16 cooldown envelope — trace
 *     family ruling: the value is dynamic and never compared). Downstream header ORDER,
 *     `Date`, `Connection`, `Transfer-Encoding`, `Content-Length` and the CORS block are
 *     transport/S1-owned and not asserted.
 *   - body:
 *       · SSE mode (recorded Content-Type `text/event-stream`): the DECODED frame sequence
 *         per R-SSE — the ordered `data:` payload strings, compared exactly, INCLUDING the
 *         terminal `data: [DONE]` frame on clean EOF and the terminal `{"error":…}` frame
 *         (NO [DONE] after it) on a mid-stream transport failure (C19). SSE comment lines
 *         and `event:` names are contract violations on this surface and fail loudly.
 *       · everything else (JSON envelopes): body bytes compared byte-exact after masking.
 *
 * MASKS — derived from each case's meta.yaml `dynamic_fields` (unknown entries fail the
 * suite loudly so new volatility must be added consciously). All 23 cases declare the
 * shared six; three families add case-specific entries, handled as follows:
 *   - `Date response header` — never compared: outside the asserted subset; no compared
 *     body embeds a date.
 *   - `X-Cpa-Trace-Id / X-Cpa-* response headers` — presence-only assertion (see above);
 *     value never compared.
 *   - `Content-Length where body content is stable but framing varies` — never compared;
 *     the fixture's own body byte-claim is verified in the inventory self-check instead.
 *   - `upstream.jsonl 'ts' field and mock log timestamps` — recording-only jsonl metadata,
 *     excluded from the wire compare.
 *   - `curl User-Agent in request.http (record verbatim; contract layer masks)` — the
 *     client's request headers are replayed verbatim, never forwarded (pinned by the
 *     upstream header compare) and never compared; a recognized no-op.
 *   - `ports (8387/20001)` — the trailing `:port` of the upstream Host header is masked to
 *     `:<PORT>` on both sides; the gateway port appears only in the recorded request
 *     Host, which no assertion reads.
 *   - `choices[0].message.tool_calls[*].id` (C03/C04) / `choices[0].delta.tool_calls[*].id
 *     (frames)` (C12) — the volatile id tail `-<unix-nano>-<counter>` is masked to
 *     `-<ID>`; the sanitized-name prefix stays pinned, and a foreign id shape fails
 *     loudly instead of being masked.
 *   - `error.reset_time` + `error.reset_seconds` (C16) — recognized; deliberately NOT
 *     masked: the frozen clock pins the recorded literals `Retry-After: 1` /
 *     `"reset_seconds":1` / `"reset_time":"1s"` byte-exactly, and a consistency check ties
 *     the three together (see HARNESS SEMANTICS).
 *   - `terminal error message text if it embeds transport-specific info (expected stable
 *     'unexpected EOF'; verify)` (C19) — verified stable by the recording: the terminal
 *     frame carries exactly "unexpected EOF", so it byte-compares UNMASKED; the harness
 *     scripts the abort error with that same text.
 * Deliberately NOT masked (each is deterministic; masking would weaken a recorded pin):
 *   - the 5-category safetySettings bytes, the thoughtSignature sentinel and the raw
 *     parametersJsonSchema bytes (byte-pinned inside upstream bodies);
 *   - cooldown `Retry-After` / `reset_seconds` / `reset_time` (see above);
 *   - `created` (recorded 0 everywhere — the mock emits no createTime);
 *   - the C16 envelope's `last_upstream_error` (the verbatim C15 upstream body, whose bytes
 *     the harness reproduces exactly).
 *
 * COVERAGE (fixture -> what the replay pins; spec §6 for the full case index):
 *   C01-nostream-basic        leading system -> systemInstruction {role:"user",parts};
 *                            temperature/top_p/max_tokens -> generationConfig; the
 *                            5-category safetySettings injection; :generateContent URL +
 *                            pinned header set/order; envelope id:"" created:0 model=
 *                            <upstream modelVersion>; usage mapping
 *   C02-nostream-multiturn    contents role mapping user/model; trailing system message
 *                            -> user content; no generationConfig key when nothing maps
 *   C03-nostream-tools-history  tools -> functionDeclarations w/ parameters renamed to
 *                            parametersJsonSchema RAW (client spacing preserved); assistant
 *                            tool_calls -> functionCall part + literal thoughtSignature;
 *                            synthetic functionResponse user turn (matched tool message,
 *                            string content embedded as a JSON string)
 *   C04-nostream-tool-call    upstream functionCall -> message.tool_calls (NO index
 *                            field); finish_reason AND native_finish_reason both
 *                            "tool_calls" (non-stream override); sanitized name echo;
 *                            raw arguments
 *   C05-nostream-max-tokens   max_tokens -> generationConfig.maxOutputTokens; MAX_TOKENS ->
 *                            finish_reason "max_tokens"
 *   C06-nostream-usage-details  thought:true parts -> reasoning_content;
 *                            thoughtsTokenCount -> reasoning_tokens (and added into
 *                            completion_tokens); cachedContentTokenCount -> cached_tokens
 *   C07-nostream-reasoning-effort  reasoning_effort "low" -> translated thinkingConfig
 *                            STRIPPED by the capability pass; generationConfig survives
 *                            as {}
 *   C08-nostream-model-suffix  alias suffix "(high)": suffix stripped from the upstream
 *                            URL AND the body model; thinking intent dropped (no
 *                            generationConfig at all)
 *   C09-nostream-n2-candidates  n=2 -> generationConfig.candidateCount 2; two candidates
 *                            -> two ordered choices w/ index echo
 *   C10-nostream-image-data-url  image_url data: URL -> inlineData{mime_type,data} + the
 *                            thoughtSignature sentinel on the user image part; text part
 *                            kept in the same content
 *   C11-stream-basic          :streamGenerateContent?alt=sse URL; 3-frame sequence (role
 *                            + content frames with the "model" default mid-stream,
 *                            terminal frame merging finish_reason + usage + modelVersion);
 *                            data: [DONE]; SSE commit headers
 *   C12-stream-tool-call      stream functionCall -> buffered tool_calls delta (index,
 *                            dynamic id); finish_reason "tool_calls" + native_finish_reason
 *                            "stop" ASYMMETRY (vs C04's non-stream override); usage on
 *                            the terminal frame only
 *   C13-stream-max-tokens     stream MAX_TOKENS -> finish_reason "max_tokens"
 *   C14-stream-no-terminal-merge  split finish/usage upstream chunks -> the finish frame
 *                            carries NO finish_reason (null) and the usage-only chunk
 *                            yields NO frame; [DONE] still appended
 *   C15-error-429-nostream    upstream 429 JSON -> status + body VERBATIM downstream
 *                            (application/json, no SSE headers); opens the rate-limit
 *                            cooldown
 *   C16-error-429-cooldown    request INSIDE the ~1s window -> 429 model_cooldown envelope
 *                            (Retry-After 1, reset_seconds 1, reset_time "1s", provider
 *                            "gemini", verbatim last_upstream_error, model = client
 *                            alias); ZERO upstream calls; NO trace header; composed after
 *                            C15 on one shared session
 *   C17-error-400-nostream    upstream 400 INVALID_ARGUMENT JSON -> verbatim pass-through
 *   C18-stream-error-before-first-byte  stream request, upstream 429 before the first
 *                            chunk -> plain JSON 429 (NOT SSE; no Cache-Control)
 *   C19-stream-disconnect-mid-stream  200 SSE kept after 2 frames; transport failure ->
 *                            terminal data:{"error":{"message":"unexpected EOF",…}} frame;
 *                            NO [DONE] after it
 *   C20-nostream-force-mapping  force-mapping rewrites the response model to the client
 *                            alias
 *   C21-stream-force-mapping  force-mapping rewrites EVERY chunk's model to the client
 *                            alias (incl. the mid-stream default frames)
 *   C22-stream-n2-candidates  n=2 stream -> candidateCount 2; per-candidate frame fan-out
 *                            in candidate order; terminal chunk -> BOTH candidate final
 *                            frames carry finish_reason "stop" + the SAME duplicated usage
 *   C23-stream-c1-only-finish  terminal chunk where ONLY candidate 1 finished: the
 *                            candidates.0-keyed usage filter hides the usage -> NO frame
 *                            ever carries finish_reason or usage (delta-null frames for
 *                            both candidates); modelVersion still echoed
 *
 * Spec behavior with NO golden in this batch (documented, not asserted): the empty-JSON-
 * object default of the synthetic functionResponse turn when no tool message matches
 * (spec §3.1.1; C03 only exercises the matched branch), the OPTIONAL empty-stream edge
 * (headers + [DONE] only, spec §4.1), the `"stream":"true"`-as-string non-streaming rule
 * (spec §2.1), non-JSON upstream error bodies (spec §5 envelope fallback), and the
 * thinking `levels` path (spec §7.3, config-dependent).
 */

import { readdir, readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { MemoryStore } from '@cpa-edge/core'
import type { Store } from '@cpa-edge/core'

// ─── Adapter load (skip-with-explanation until the real export ships) ────────────────

const ADAPTER_MODULE = '@cpa-edge/translators/oai2gem'
const ADAPTER_EXPORT = 'createOai2GemService'

/** Structural mirror of the adapter interface documented in the header. */
type HeaderList = ReadonlyArray<readonly [string, string]>

interface ModelEntry {
  readonly name: string
  readonly alias?: string
  readonly forceMapping?: boolean
  readonly thinking?: { readonly levels?: readonly string[] }
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
        'All 23 S2d1 golden cases SKIP until the oai2gem adapter ships; the required interface is documented in the header of this file.',
    }
  } catch (error) {
    return { skipReason: `import of \`${ADAPTER_MODULE}\` failed: ${String(error)}` }
  }
}

const adapterLoad = await loadAdapter()
const adapterFactory = adapterLoad.factory
const suite = adapterFactory ? describe : describe.skip
const suiteTitle = adapterFactory
  ? 'S2d1 — oai2gem golden contract (recorded fixtures)'
  : `S2d1 — oai2gem golden contract (SKIPPED: ${adapterLoad.skipReason ?? 'adapter unavailable'})`

// ─── Fixture access ───────────────────────────────────────────────────────────────────

const FIXTURE_ROOT = new URL('../fixtures/S2d1/', import.meta.url)
const FROZEN_NOW_MS = 1_789_507_015_000

/** Gateway api-keys of the recording config (meta.yaml `config_fragment`). */
const GATEWAY_API_KEYS: readonly string[] = ['oracle-local-key-1']

/**
 * Recording-instance credential, transcribed from the fixture config fragments (spec §6):
 * one `gemini-api-key` provider pointing at the worker-2 gemini mock, fourteen model
 * entries. `mock-gemini-force` is the only `force-mapping: true` entry (C20/C21).
 */
const CREDENTIALS: readonly CredentialConfig[] = [
  {
    apiKey: 'mock-gemini-upstream-key',
    baseUrl: 'http://host.docker.internal:20001',
    models: [
      { name: 'gemini-mock-model', alias: 'mock-gemini-flash' },
      { name: 'gemini-mock-model-tools', alias: 'mock-gemini-tools' },
      { name: 'gemini-mock-model-maxtok', alias: 'mock-gemini-maxtok' },
      { name: 'gemini-mock-model-usage', alias: 'mock-gemini-usage' },
      { name: 'gemini-mock-model-think', alias: 'mock-gemini-think' },
      { name: 'gemini-mock-model-n2', alias: 'mock-gemini-n2' },
      { name: 'gemini-mock-model-img', alias: 'mock-gemini-img' },
      { name: 'gemini-mock-model-split', alias: 'mock-gemini-split' },
      { name: 'gemini-mock-model-err429', alias: 'mock-gemini-err429' },
      { name: 'gemini-mock-model-err400', alias: 'mock-gemini-err400' },
      { name: 'gemini-mock-model-streamerr', alias: 'mock-gemini-streamerr' },
      { name: 'gemini-mock-model-disc', alias: 'mock-gemini-disc' },
      { name: 'gemini-mock-model-force', alias: 'mock-gemini-force', forceMapping: true },
      { name: 'gemini-mock-model-n2stream', alias: 'mock-gemini-n2stream' },
    ],
  },
]

const EXPECTED_CASES = [
  'C01-nostream-basic',
  'C02-nostream-multiturn',
  'C03-nostream-tools-history',
  'C04-nostream-tool-call',
  'C05-nostream-max-tokens',
  'C06-nostream-usage-details',
  'C07-nostream-reasoning-effort',
  'C08-nostream-model-suffix',
  'C09-nostream-n2-candidates',
  'C10-nostream-image-data-url',
  'C11-stream-basic',
  'C12-stream-tool-call',
  'C13-stream-max-tokens',
  'C14-stream-no-terminal-merge',
  'C15-error-429-nostream',
  'C16-error-429-cooldown',
  'C17-error-400-nostream',
  'C18-stream-error-before-first-byte',
  'C19-stream-disconnect-mid-stream',
  'C20-nostream-force-mapping',
  'C21-stream-force-mapping',
  'C22-stream-n2-candidates',
  'C23-stream-c1-only-finish',
] as const

type CaseId = (typeof EXPECTED_CASES)[number]

/**
 * C16 recorded only the in-window delta (<25ms after C15 on one reference instance), so
 * its replay is composed: the recorded C15 429 opens the cooldown window (step 1), then
 * C16's own request lands inside it (step 2, same service + Store).
 */
const COMPOSED_STEPS: Readonly<Record<string, readonly string[]>> = {
  'C16-error-429-cooldown': ['C15-error-429-nostream', 'C16-error-429-cooldown'],
}

/** The recorded action suffix of the upstream URL for each stream mode (spec §2.3). */
const STREAM_PATH_SUFFIX = ':streamGenerateContent?alt=sse'
const NON_STREAM_PATH_SUFFIX = ':generateContent'

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
  // CR-free after this normalization — verified across all 23 recorded cases — so
  // terminators are normalized on read and never enter a byte comparison.
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
 * Parses the single recorded request of a case: request head up to the first blank line,
 * then the exact body bytes (edge newlines trimmed on both ends; the recorder separates
 * head and body with one extra blank line, and bodies are exact JSON bytes).
 */
function parseRequestHttp(text: string): RecordedRequest {
  const boundary = text.indexOf('\n\n')
  const head = boundary === -1 ? text : text.slice(0, boundary)
  let rest = boundary === -1 ? '' : text.slice(boundary + 2)
  while (rest.startsWith('\n')) rest = rest.slice(1)
  const body = rest.endsWith('\n') ? rest.slice(0, -1) : rest
  const lines = head.split('\n')
  const requestLine = (lines[0] ?? '').split(' ')
  const headers: Array<[string, string]> = []
  for (const line of lines.slice(1)) {
    const separator = line.indexOf(': ')
    if (separator <= 0) continue
    headers.push([line.slice(0, separator), line.slice(separator + 2)])
  }
  return { method: requestLine[0] ?? '', path: requestLine[1] ?? '', headers, body }
}

interface RecordedResponse {
  readonly status: number
  readonly headers: HeaderList
  readonly body: string
  readonly claimedBodyBytes: number
}

/**
 * Parses a case's downstream.md: the `## Status line` text, the raw `## Response headers`
 * block (read until the section's blank line), and the decoded body fence under
 * `## Body / SSE byte stream … (exact bytes received, N bytes)` (lines joined with '\n',
 * which reproduces the recorded bytes including the trailing blank lines of SSE bodies).
 * The `## Body (raw chunked stream as received)` section of stream cases is NEVER read —
 * R-SSE binds the decoded frames, not the transport framing.
 */
function parseDownstreamMarkdown(text: string, caseId: string): RecordedResponse {
  const lines = text.split('\n')
  const sectionStart = (marker: string): number => {
    const index = lines.findIndex((line) => line.startsWith(marker))
    if (index === -1) throw new Error(`downstream.md ${caseId}: missing the ${marker} section`)
    return index
  }

  const statusIndex = sectionStart('## Status line')
  const statusLine = lines[statusIndex + 1] ?? ''
  if (!statusLine.startsWith('HTTP/1.1 ')) {
    throw new Error(`downstream.md ${caseId}: status line missing the HTTP/1.1 prefix: ${statusLine}`)
  }
  const status = Number(statusLine.split(' ')[1])
  if (!Number.isInteger(status) || status <= 0) {
    throw new Error(`downstream.md ${caseId}: status line carries no numeric status: ${statusLine}`)
  }

  const headersIndex = sectionStart('## Response headers')
  const headers: Array<[string, string]> = []
  for (const line of lines.slice(headersIndex + 1)) {
    if (line === '') break
    const separator = line.indexOf(': ')
    if (separator <= 0) continue
    headers.push([line.slice(0, separator), line.slice(separator + 2)])
  }

  const bodyHeadingIndex = sectionStart('## Body / SSE byte stream')
  const bodyHeading = lines[bodyHeadingIndex] ?? ''
  const claimMatch = bodyHeading.match(/\(exact bytes received, (\d+) bytes\)/)
  if (claimMatch === null) {
    throw new Error(`downstream.md ${caseId}: body heading carries no byte claim: ${bodyHeading}`)
  }
  let cursor = bodyHeadingIndex + 1
  while (cursor < lines.length && !(lines[cursor] ?? '').startsWith('```')) cursor += 1
  if (cursor >= lines.length) throw new Error(`downstream.md ${caseId}: body fence never opens`)
  cursor += 1
  const content: string[] = []
  while (cursor < lines.length && !(lines[cursor] ?? '').startsWith('```')) {
    content.push(lines[cursor] ?? '')
    cursor += 1
  }
  if (cursor >= lines.length) throw new Error(`downstream.md ${caseId}: body fence never closes`)
  return { status, headers, body: content.join('\n'), claimedBodyBytes: Number(claimMatch[1]) }
}

// ─── Masking (meta.yaml dynamic_fields → recognition) ───────────────────────────────

interface MaskProfile {
  /** Mask the trailing `:port` of the upstream Host header on both sides of the wire compare. */
  readonly upstreamHostPort: boolean
  /** Mask the volatile `-<unix-nano>-<counter>` tail of generated tool_call ids in bodies. */
  readonly toolCallIds: boolean
}

function maskProfile(caseId: string, dynamicFields: readonly string[]): MaskProfile {
  const profile = { upstreamHostPort: false, toolCallIds: false }
  for (const field of dynamicFields) {
    if (
      field === 'Date response header' || // never compared: outside the asserted subset
      field === 'X-Cpa-Trace-Id / X-Cpa-* response headers' || // presence-only; value never compared
      field === 'Content-Length where body content is stable but framing varies' || // never compared; claim verified in the inventory
      field === "upstream.jsonl 'ts' field and mock log timestamps" || // recording-only jsonl metadata
      field === 'curl User-Agent in request.http (record verbatim; contract layer masks)' || // client headers: replayed, never forwarded, never compared
      field === 'ports (8387/20001)' // upstream Host port masked below; gateway port unread
    ) {
      if (field === 'ports (8387/20001)') profile.upstreamHostPort = true
      continue
    }
    if (field === 'choices[0].message.tool_calls[*].id' || field === 'choices[0].delta.tool_calls[*].id (frames)') {
      profile.toolCallIds = true
      continue
    }
    if (field === 'error.reset_time' || field === 'error.reset_seconds') {
      // Recognized and deliberately NOT masked: the frozen clock reproduces the recorded
      // literals (Retry-After 1 / reset_seconds 1 / reset_time "1s") byte-exactly.
      continue
    }
    if (field === "terminal error message text if it embeds transport-specific info (expected stable 'unexpected EOF'; verify)") {
      // Verified stable by the recording: the terminal frame carries exactly "unexpected
      // EOF", which byte-compares unmasked.
      continue
    }
    throw new Error(
      `S2d1[${caseId}]: unrecognized meta.yaml dynamic_fields entry ${JSON.stringify(field)} — ` +
        'extend the mask table in tests/contract/s2d1-oai2gem.test.ts consciously',
    )
  }
  return profile
}

const PORT_SUFFIX_RE = /:\d+$/
const TOOL_CALL_ID_TAIL_RE = /("id":")([A-Za-z0-9_.:-]+)-\d+-\d+(")/g

function normalizeHeaderValue(name: string, value: string, mask: MaskProfile): string {
  if (name.toLowerCase() === 'host' && mask.upstreamHostPort) return value.replace(PORT_SUFFIX_RE, ':<PORT>')
  return value
}

/** Masks the volatile id tail while keeping the sanitized-name prefix pinned. */
function normalizeBodyText(text: string, mask: MaskProfile): string {
  return mask.toolCallIds ? text.replace(TOOL_CALL_ID_TAIL_RE, '$1$2-<ID>$3') : text
}

// ─── Mock upstream (mock-response.json shapes) ───────────────────────────────────────

interface MockControl {
  readonly mode?: string
  readonly status?: number
  readonly after?: number
  readonly error_body?: unknown
}

interface MockResponseFile {
  readonly control_file?: MockControl
  readonly scripted_mock_response?: unknown
}

interface CaseMeta {
  readonly case: string
  readonly dynamic_fields: readonly string[]
  readonly stream: boolean
  readonly alias: string
  readonly upstream_model: string
  readonly observed_upstream_lines: number
  readonly observed_http_status: number
  readonly expected_upstream_calls?: number
}

interface RecordedUpstreamLine {
  readonly method: string
  readonly path: string
  readonly headers: Record<string, string>
  readonly body: string
}

const encoder = new TextEncoder()

/**
 * The mock's built-in gemini error body, transcribed from the recorded verbatim 429
 * pass-through (C15/C18 downstream bodies are these exact bytes; the reference trims
 * nothing because the mock emits no surrounding whitespace). Serialized with Python
 * json.dumps spacing — the byte style the recordings pin.
 */
const DEFAULT_GEMINI_ERROR_BODY = '{"error": {"code": 429, "message": "mock rate limit", "status": "RESOURCE_EXHAUSTED"}}'

/** Serializes like Python's json.dumps defaults — the mock's recorded byte style. */
function pythonJson(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value === null ? 'null' : String(value)
  }
  if (value === null) return 'null'
  if (Array.isArray(value)) return `[${value.map(pythonJson).join(', ')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}: ${pythonJson(entry)}`).join(', ')}}`
  }
  throw new Error(`mock upstream cannot serialize value of type ${typeof value}`)
}

/** The mock's default non-stream reply (mock-response.json string descriptions + C01). */
function defaultNonStreamReply(modelVersion: string): unknown {
  return {
    candidates: [
      {
        content: { parts: [{ text: 'Hello from mock gemini upstream more' }], role: 'model' },
        finishReason: 'STOP',
        index: 0,
      },
    ],
    usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 6, totalTokenCount: 15 },
    modelVersion,
  }
}

/** The mock's default 3-event stream (C11 recorded downstream + the C11/C21 descriptions). */
function defaultStreamEvents(modelVersion: string): readonly unknown[] {
  return [
    { candidates: [{ content: { parts: [{ text: 'Hello from mock gemini upstream' }], role: 'model' }, index: 0 }] },
    { candidates: [{ content: { parts: [{ text: ' more' }], role: 'model' }, index: 0 }] },
    {
      candidates: [{ content: { parts: [], role: 'model' }, finishReason: 'STOP', index: 0 }],
      usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 6, totalTokenCount: 15 },
      modelVersion,
    },
  ]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Lenient model read for the DEFAULT-reply echo: a non-JSON translated body must fail in
 * the wire compare, not here — the fallback is the case's recorded upstream model.
 */
function translatedModel(body: string, fallbackModel: string): string {
  try {
    const parsed = JSON.parse(body) as { model?: unknown }
    if (typeof parsed.model === 'string' && parsed.model !== '') return parsed.model
  } catch {
    // fall through to the recorded fallback
  }
  return fallbackModel
}

/**
 * Demand-driven byte stream: every pull hands out one chunk; the read after the last
 * chunk either closes (clean EOF) or errors (disconnect). `abortError` carries the
 * transport error text the adapter must surface in the terminal error frame (C19).
 */
function scriptedByteStream(
  chunks: readonly Uint8Array[],
  options: { readonly abortAfter?: number; readonly abortError?: string } = {},
): ReadableStream<Uint8Array> {
  let served = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const index = served
      served += 1
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

interface MockResponseSpec {
  readonly status: number
  readonly headers: HeaderList
  readonly body: ReadableStream<Uint8Array>
}

/**
 * Builds the upstream response for one captured call from the case's scripted control.
 * Error mode replies with the recorded status + verbatim error bytes; happy/disconnect
 * modes reply from the fixture's scripted payload — a structured `stream_events` array
 * (one SSE data frame per event), a structured non-stream object, or the reconstructed
 * DEFAULT reply when the fixture records the mock's stock behavior as a string.
 */
function buildMockResponse(
  control: MockControl | undefined,
  scripted: unknown,
  meta: CaseMeta,
  upstreamRequest: UpstreamRequest,
  caseId: string,
): MockResponseSpec {
  if (control === undefined) {
    throw new Error(`S2d1[${caseId}]: mock-response.json is missing its control_file`)
  }
  const mode = control.mode ?? 'happy'
  if (mode === 'error') {
    const status = control.status ?? 429
    const bodyText = control.error_body !== undefined ? pythonJson(control.error_body) : DEFAULT_GEMINI_ERROR_BODY
    return {
      status,
      headers: [['Content-Type', 'application/json']],
      body: scriptedByteStream([encoder.encode(bodyText)]),
    }
  }
  if (mode !== 'happy' && mode !== 'disconnect') {
    throw new Error(`S2d1[${caseId}]: unrecognized mock control mode ${JSON.stringify(mode)}`)
  }

  const modelVersion = translatedModel(upstreamRequest.body, meta.upstream_model)
  let events: readonly unknown[]
  if (typeof scripted === 'string') {
    // The fixture records the mock's stock behavior as prose; the harness reconstructs it
    // from the recorded evidence with modelVersion echoing the translated body's model.
    events = meta.stream ? defaultStreamEvents(modelVersion) : [defaultNonStreamReply(modelVersion)]
  } else if (isRecord(scripted) && Array.isArray(scripted['stream_events'])) {
    events = scripted['stream_events']
  } else if (isRecord(scripted)) {
    events = [scripted]
  } else {
    throw new Error(`S2d1[${caseId}]: scripted_mock_response shape not recognized by the harness`)
  }

  if (meta.stream) {
    const frames = events.map((event) => encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
    return {
      status: 200,
      headers: [['Content-Type', 'text/event-stream']],
      body: scriptedByteStream(frames, {
        abortAfter: mode === 'disconnect' ? control.after : undefined,
        // The transport error text the reference surfaced for a truncated chunked body;
        // the terminal frame byte-compares against it unmasked (C19).
        abortError: 'unexpected EOF',
      }),
    }
  }
  const bodyText = events.map((event) => JSON.stringify(event)).join('\n')
  return {
    status: 200,
    headers: [['Content-Type', 'application/json']],
    body: scriptedByteStream([encoder.encode(bodyText)]),
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

function truncate(text: string): string {
  return text.length > 200 ? `${text.slice(0, 200)}…` : text
}

/**
 * R-SSE decoder: the ordered `data:` payload strings of a downstream body. The terminal
 * `data: [DONE]` frame on clean EOF and the terminal `{"error":…}` frame on mid-stream
 * failure are frames like any other. Comment lines (keep-alives are disabled in the
 * golden configuration) and `event:` names (the openai chat surface never emits them)
 * are contract violations and fail loudly.
 */
function decodeSseFrames(body: string, context: string): readonly string[] {
  const frames: string[] = []
  for (const block of body.split('\n\n')) {
    if (block === '') continue
    const dataLines: string[] = []
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) {
        throw new Error(`${context}: SSE comment line violates the golden configuration: ${truncate(line)}`)
      }
      if (line.startsWith('event: ')) {
        throw new Error(`${context}: the openai chat surface never emits SSE event names: ${truncate(line)}`)
      }
      if (line.startsWith('data: ')) {
        dataLines.push(line.slice('data: '.length))
        continue
      }
      if (line === '') continue
      throw new Error(`${context}: unrecognized SSE line: ${truncate(line)}`)
    }
    if (dataLines.length > 0) frames.push(dataLines.join('\n'))
  }
  return frames
}

function assertUpstreamWire(
  recorded: RecordedUpstreamLine,
  call: UpstreamRequest,
  mask: MaskProfile,
  baseUrl: string,
  caseId: string,
): void {
  const context = `S2d1[${caseId}] upstream wire`
  expect(call.method, `${context}: method`).toBe(recorded.method)
  expect(call.url, `${context}: url (trimmed baseUrl + recorded path)`).toBe(`${baseUrl.replace(/\/$/, '')}${recorded.path}`)

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
    if (name.toLowerCase() === 'x-goog-api-key') {
      // The whole header value is the configured api-key (spec §2.3 pins it verbatim).
      expect(value, `${context}: x-goog-api-key must carry the configured credential api-key`).toBe(
        CREDENTIALS[0]?.apiKey ?? '',
      )
      actualPairs.push([name, '<redacted>'])
      continue
    }
    actualPairs.push([name, normalizeHeaderValue(name, value, mask)])
  }
  expect(actualPairs, `${context}: header list (order + names + values; pins NO Authorization and no forwarded client headers)`).toEqual(expectedPairs)
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
  response: ChatResponse,
  expected: RecordedResponse,
  mask: MaskProfile,
  caseId: string,
  step: number,
): Promise<void> {
  const context = `S2d1[${caseId}] step ${step} downstream`
  const body = await readResponseBody(response.body)
  expect(response.status, `${context}: status`).toBe(expected.status)

  const expectedContentType = headerValue(expected.headers, 'content-type')
  expect(expectedContentType, `${context}: fixture must record Content-Type`).toBeDefined()
  expect(headerValue(response.headers, 'content-type'), `${context}: Content-Type`).toBe(expectedContentType)

  // Cache-Control: `no-cache` exactly on SSE commits, absent otherwise — this pins "no SSE
  // headers before commit" for the 429/400 responses (C15/C16/C17/C18).
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

  // Trace family ruling: the VALUE is dynamic and never compared; PRESENCE must match the
  // recorded head (executor-routed responses carry it, the gateway-local cooldown does not).
  const expectedTrace = headerValue(expected.headers, 'x-cpa-trace-id') !== undefined
  expect(
    headerValue(response.headers, 'x-cpa-trace-id') !== undefined,
    `${context}: X-Cpa-Trace-Id presence must match the recorded head`,
  ).toBe(expectedTrace)

  if (expectedContentType === 'text/event-stream') {
    const expectedFrames = decodeSseFrames(expected.body, `${context}: recorded`)
    const actualFrames = decodeSseFrames(body, `${context}: produced`)
    expect(actualFrames.length, `${context}: decoded SSE frame count (incl. the terminal [DONE]/error frame)`).toBe(
      expectedFrames.length,
    )
    for (let index = 0; index < expectedFrames.length; index += 1) {
      const expectedFrame = expectedFrames[index]
      const actualFrame = actualFrames[index]
      if (expectedFrame === undefined || actualFrame === undefined) continue
      expect(
        normalizeBodyText(actualFrame, mask),
        `${context}: SSE frame ${index} payload (R-SSE: decoded data bytes, in order)`,
      ).toBe(normalizeBodyText(expectedFrame, mask))
    }
  } else {
    expect(normalizeBodyText(body, mask), `${context}: body bytes`).toBe(normalizeBodyText(expected.body, mask))
  }

  if (body.includes('"code":"model_cooldown"')) {
    assertCooldownEnvelope(actualRetryAfter, body, context)
  }
}

// ─── Case runner ─────────────────────────────────────────────────────────────────────

interface StepPlan {
  readonly caseId: string
  readonly request: RecordedRequest
  readonly expected: RecordedResponse
  readonly meta: CaseMeta
  readonly mockFile: MockResponseFile
  readonly recordedUpstream: readonly RecordedUpstreamLine[]
  readonly mask: MaskProfile
}

/** Loads one fixture case as a single replay step (every S2d1 fixture records ONE request). */
async function loadCaseSteps(caseId: string): Promise<readonly StepPlan[]> {
  const meta = await readFixtureJson<CaseMeta>(caseId, 'meta.yaml')
  const mockFile = await readFixtureJson<MockResponseFile>(caseId, 'mock-response.json')
  const request = parseRequestHttp(await readFixtureText(caseId, 'request.http'))
  const expected = parseDownstreamMarkdown(await readFixtureText(caseId, 'downstream.md'), caseId)
  const recordedUpstream = (await readFixtureText(caseId, 'upstream.jsonl'))
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as RecordedUpstreamLine)
  return [
    {
      caseId,
      request,
      expected,
      meta,
      mockFile,
      recordedUpstream,
      mask: maskProfile(caseId, meta.dynamic_fields),
    },
  ]
}

interface CapturedUpstreamCall {
  readonly step: number
  readonly call: UpstreamRequest
}

async function replayCase(caseId: CaseId): Promise<void> {
  if (adapterFactory === undefined) throw new Error('adapter factory missing')
  const stepCaseIds = COMPOSED_STEPS[caseId] ?? [caseId]
  const steps: StepPlan[] = []
  for (const stepCaseId of stepCaseIds) steps.push(...(await loadCaseSteps(stepCaseId)))

  const now = (): number => FROZEN_NOW_MS
  const service = adapterFactory({
    apiKeys: GATEWAY_API_KEYS,
    credentials: CREDENTIALS,
    store: new MemoryStore({ now }),
    now,
    requestRetry: 0,
    transientErrorCooldownSeconds: -1, // recording config; the 429 cooldown stays active (§5)
  })
  if (typeof service.handleChatCompletions !== 'function') {
    throw new Error(`${ADAPTER_EXPORT}() must return an object with a handleChatCompletions(request, send) method`)
  }

  const captured: CapturedUpstreamCall[] = []
  let currentStep = 0
  const send: UpstreamSender = async (call) => {
    const step = steps[currentStep]
    if (step === undefined) throw new Error('harness bug: no step plan for the current upstream call')
    captured.push({ step: currentStep, call })
    return buildMockResponse(step.mockFile.control_file, step.mockFile.scripted_mock_response, step.meta, call, step.caseId)
  }

  for (let index = 0; index < steps.length; index += 1) {
    currentStep = index
    const step = steps[index]
    if (step === undefined) throw new Error('unreachable: step index out of range')
    const response = await service.handleChatCompletions(
      {
        method: step.request.method,
        path: step.request.path,
        headers: step.request.headers,
        body: step.request.body,
      },
      send,
    )
    await assertDownstreamStep(response, step.expected, step.mask, step.caseId, index + 1)
  }

  const expectedTotal = steps.reduce((sum, step) => sum + step.recordedUpstream.length, 0)
  expect(
    captured.length,
    `S2d1[${caseId}]: upstream call count (the cooldown step must not call upstream)`,
  ).toBe(expectedTotal)
  let cursor = 0
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]
    if (step === undefined) throw new Error('unreachable: step index out of range')
    for (const recorded of step.recordedUpstream) {
      const capturedCall = captured[cursor]
      expect(capturedCall, `S2d1[${caseId}]: missing upstream call ${cursor + 1}`).toBeDefined()
      if (capturedCall !== undefined) {
        expect(capturedCall.step, `S2d1[${caseId}]: upstream call ${cursor + 1} must belong to step ${index + 1}`).toBe(index)
        assertUpstreamWire(recorded, capturedCall.call, step.mask, CREDENTIALS[0]?.baseUrl ?? '', step.caseId)
      }
      cursor += 1
    }
  }
}

// ─── Suites ──────────────────────────────────────────────────────────────────────────

const COOLDOWN_COMPOSED_CASE = 'C16-error-429-cooldown'

describe('S2d1 fixture inventory (harness self-check, adapter-independent)', () => {
  it('exposes exactly the 23 admitted golden cases, each internally consistent', async () => {
    expect([...fixtureCaseDirs]).toEqual([...EXPECTED_CASES].sort())
    let totalRequests = 0

    for (const caseId of EXPECTED_CASES) {
      const meta = await readFixtureJson<CaseMeta>(caseId, 'meta.yaml')
      const mockFile = await readFixtureJson<MockResponseFile>(caseId, 'mock-response.json')
      const request = parseRequestHttp(await readFixtureText(caseId, 'request.http'))
      const recorded = parseDownstreamMarkdown(await readFixtureText(caseId, 'downstream.md'), caseId)
      const upstreamLines = (await readFixtureText(caseId, 'upstream.jsonl'))
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as RecordedUpstreamLine)

      // C21/C23 kept their gate-era OPTIONAL marker inside meta.case while the directory
      // names dropped it; both spellings are accepted for exactly those two.
      const expectedMetaCaseNames = [`S2d1-${caseId}`, `S2d1-${caseId.replace(/^(C\d+)-/, '$1-OPTIONAL-')}`]
      expect(expectedMetaCaseNames, `${caseId}: meta.case echoes the directory name under the S2d1- prefix`).toContain(meta.case)
      maskProfile(caseId, meta.dynamic_fields) // fails loudly on unknown dynamic fields
      expect(mockFile.control_file, `${caseId}: mock control present`).toBeDefined()
      totalRequests += 1

      // Downstream request: the pinned /v1/chat/completions surface.
      expect(request.method, `${caseId}: route method`).toBe('POST')
      expect(request.path, `${caseId}: route path`).toBe('/v1/chat/completions')
      expect(
        headerValue(request.headers, 'authorization'),
        `${caseId}: recorded client auth is the Bearer transport`,
      ).toBe('Bearer oracle-local-key-1')
      const contentLength = headerValue(request.headers, 'content-length')
      if (contentLength !== undefined) {
        expect(Number(contentLength), `${caseId}: body bytes match the recorded Content-Length`).toBe(
          encoder.encode(request.body).length,
        )
      }
      let requestBody: Record<string, unknown>
      try {
        requestBody = JSON.parse(request.body) as Record<string, unknown>
      } catch {
        throw new Error(`${caseId}: request body must be well-formed JSON (NE-LENIENT replays well-formed bodies only)`)
      }
      expect(requestBody['model'], `${caseId}: request model echoes meta.alias`).toBe(meta.alias)
      expect(requestBody['stream'], `${caseId}: stream flag is the JSON literal matching meta.stream`).toBe(meta.stream)

      // Downstream response: the recorded bytes match the fixture's own claim.
      expect(recorded.status, `${caseId}: recorded status echoes meta.observed_http_status`).toBe(meta.observed_http_status)
      expect(encoder.encode(recorded.body).length, `${caseId}: body bytes match the recorded claim`).toBe(
        recorded.claimedBodyBytes,
      )
      expect(
        headerValue(recorded.headers, 'content-type'),
        `${caseId}: fixture must record Content-Type`,
      ).toBeDefined()
      if (headerValue(recorded.headers, 'content-type') === 'text/event-stream') {
        expect(
          () => decodeSseFrames(recorded.body, `inventory ${caseId}`),
          `${caseId}: recorded SSE body decodes`,
        ).not.toThrow()
      } else {
        expect(() => JSON.parse(recorded.body), `${caseId}: non-SSE recorded body is valid JSON`).not.toThrow()
      }

      // Trace family ruling: every executor-routed recording carries the trace header; the
      // gateway-local cooldown envelope (C16) does not.
      const expectedTrace = caseId !== COOLDOWN_COMPOSED_CASE
      expect(
        headerValue(recorded.headers, 'x-cpa-trace-id') !== undefined,
        `${caseId}: recorded trace-header presence must match the S2d1 policy`,
      ).toBe(expectedTrace)

      // Upstream wire: one line per expected call, gemini URL template, pinned header policy.
      expect(upstreamLines.length, `${caseId}: upstream.jsonl line count matches meta.observed_upstream_lines`).toBe(
        meta.observed_upstream_lines,
      )
      if (meta.expected_upstream_calls !== undefined) {
        expect(meta.expected_upstream_calls, `${caseId}: meta expected_upstream_calls matches the log`).toBe(
          upstreamLines.length,
        )
      }
      const actionSuffix = meta.stream ? STREAM_PATH_SUFFIX : NON_STREAM_PATH_SUFFIX
      for (const [index, line] of upstreamLines.entries()) {
        expect(line.method, `${caseId} upstream ${index + 1}: method`).toBe('POST')
        expect(
          line.path,
          `${caseId} upstream ${index + 1}: gemini URL template w/ the upstream base model`,
        ).toBe(`/v1beta/models/${meta.upstream_model}${actionSuffix}`)
        expect(line.headers['Authorization'], `${caseId} upstream ${index + 1}: no Authorization header (x-goog-api-key only)`).toBeUndefined()
        expect(line.headers['X-Goog-Api-Key'], `${caseId} upstream ${index + 1}: api key is redacted in the wire log`).toBe('<redacted>')
        expect(line.headers['User-Agent'], `${caseId} upstream ${index + 1}: Go transport default UA`).toBe('Go-http-client/1.1')

        const upstreamBody = JSON.parse(line.body) as Record<string, unknown>
        expect(upstreamBody['model'], `${caseId} upstream ${index + 1}: body model is the upstream base model`).toBe(meta.upstream_model)
        const keys = Object.keys(upstreamBody)
        expect(keys[0], `${caseId} upstream ${index + 1}: first body key`).toBe('contents')
        expect(keys[1], `${caseId} upstream ${index + 1}: second body key`).toBe('model')
        expect(keys[keys.length - 1], `${caseId} upstream ${index + 1}: body ends with the injected safetySettings`).toBe('safetySettings')
        const safetySettings = upstreamBody['safetySettings']
        if (!Array.isArray(safetySettings) || safetySettings.length !== 5) {
          throw new Error(`${caseId} upstream ${index + 1}: safetySettings must be the 5-category injection`)
        }
        expect(safetySettings, `${caseId} upstream ${index + 1}: pinned 5-category block`).toEqual([
          { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' },
          { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'OFF' },
          { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'OFF' },
          { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'OFF' },
          { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'BLOCK_NONE' },
        ])
      }

      // The cooldown pair: C16 records zero upstream calls and composes after C15.
      if (caseId === COOLDOWN_COMPOSED_CASE) {
        expect(upstreamLines.length, `${caseId}: the cooldown step records no upstream call`).toBe(0)
        expect(COMPOSED_STEPS[caseId]?.[0], `${caseId}: composed replay starts from the recorded 429 case`).toBe(
          'C15-error-429-nostream',
        )
        expect(headerValue(recorded.headers, 'retry-after'), `${caseId}: recorded Retry-After literal`).toBe('1')
        const errorBody = JSON.parse(recorded.body) as { error?: Record<string, unknown> }
        expect(errorBody['error']?.['reset_seconds'], `${caseId}: recorded reset_seconds literal`).toBe(1)
        expect(errorBody['error']?.['reset_time'], `${caseId}: recorded reset_time literal`).toBe('1s')
        assertCooldownEnvelope(headerValue(recorded.headers, 'retry-after'), recorded.body, `fixture ${caseId}`)
      }
    }

    // The mid-stream disconnect fixture: terminal error frame, stable message, NO [DONE].
    const disconnect = parseDownstreamMarkdown(
      await readFixtureText('C19-stream-disconnect-mid-stream', 'downstream.md'),
      'C19-stream-disconnect-mid-stream',
    )
    const disconnectFrames = decodeSseFrames(disconnect.body, 'inventory C19')
    const terminal = disconnectFrames[disconnectFrames.length - 1]
    expect(terminal, 'C19: terminal frame is the error envelope').toBe(
      '{"error":{"message":"unexpected EOF","type":"server_error","code":"internal_server_error"}}',
    )
    expect(disconnectFrames.includes('[DONE]'), 'C19: no [DONE] after a mid-stream terminal error').toBe(false)

    // Clean-EOF stream fixtures end with the gateway-appended [DONE] marker.
    for (const caseId of [
      'C11-stream-basic',
      'C12-stream-tool-call',
      'C13-stream-max-tokens',
      'C14-stream-no-terminal-merge',
      'C21-stream-force-mapping',
      'C22-stream-n2-candidates',
      'C23-stream-c1-only-finish',
    ] as const) {
      const recorded = parseDownstreamMarkdown(await readFixtureText(caseId, 'downstream.md'), caseId)
      const frames = decodeSseFrames(recorded.body, `inventory ${caseId}`)
      expect(frames[frames.length - 1], `${caseId}: clean-EOF stream ends with [DONE]`).toBe('[DONE]')
    }

    expect(totalRequests, '23 cases replay 23 recorded requests in total').toBe(23)
  })
})

suite(suiteTitle, () => {
  for (const caseId of EXPECTED_CASES) {
    if (caseId === COOLDOWN_COMPOSED_CASE) continue
    it(`${caseId} — replays the recorded exchange: upstream wire byte-exact, downstream surface byte-exact`, async () => {
      await replayCase(caseId)
    })
  }

  it(
    'C15-error-429-nostream → C16-error-429-cooldown — cooldown pair on one shared session, recording order ' +
      '(C15 passes the 429 verbatim and opens the ~1s window; C16 pins the model_cooldown envelope byte-exactly, ' +
      'incl. Retry-After 1 / reset_seconds 1 / reset_time "1s", with zero upstream calls)',
    async () => {
      await replayCase(COOLDOWN_COMPOSED_CASE)
    },
  )
})
