/**
 * S6 golden contract — state & storage: config document + config.yaml persistence,
 * usage queue + RESP usage wire, error events, auth-file store, log window, model-list
 * synthesis, cooldown sidecars.
 *
 * Spec source of truth: spec/sections/S6-state-storage.md (admitted). Goldens: the 17
 * recorded fixture cases under tests/fixtures/S6/ (oracle recordings of CLIProxyAPI
 * v7.3.4, docker digest sha256:97825da...; 16 recordable case dirs S6-01..S6-16 +
 * S6-18; S6-17 is FIXTURE-DEFERRED per R-FIXTURE — CREDENTIALED-ONLY, no recording).
 * Rulings applied: R-BCRYPT (plaintext secret-key is bcrypt-hashed INTO config.yaml at
 * load, surgical write-back, already-hashed values preserved verbatim, the plaintext
 * stays the accepted key), R-FIXTURE, R-404 (not exercised: every S6 fixture path is a
 * registered route), NE-LENIENT (not exercised: management bodies are recorded
 * well-formed). R-SSE does not apply (no SSE endpoint in S6); its principle is applied
 * to the RESP wire instead: comparisons run over DECODED frame sequences, never over
 * transport chunk boundaries (see "Comparison rules"). S7 binding (SPEC §5, matrix
 * row F8): the RESP usage protocol is the NODE-RUNTIME contract — this suite drives it
 * against the socket-like `openUsageWire()` adapter (byte-identical frames, no TCP);
 * the node runtime binds that adapter to its multiplexed listener, Cloudflare/Vercel
 * are DEGRADED and expose no substitute.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * ADAPTER INTERFACE — the S6 state layer. The suite reuses the SAME factory the S5
 * suite pinned (`@cpa-edge/management` → `createManagementApi`), EXTENDED with the
 * S6 state surfaces: the returned object must additionally expose the operations
 * below (all Store-backed; Iron Rules 2/3/4 apply — Web Standard APIs only inside the
 * package, cross-package access through exports only, no shared mutable globals).
 * If the orchestrator homes the state layer under a different module path, only
 * ADAPTER_MODULE/ADAPTER_EXPORT at the top of this file change; the interface below
 * is the contract. While the factory is absent the whole replay suite SKIPs; when the
 * factory exists but the S6 operations are missing, each case SKIPs dynamically with
 * the list of missing operations (S5-only adapters stay green).
 *
 *   export function createManagementApi(deps: StateApiDeps): StateApi
 *
 *   type HeaderList = ReadonlyArray<readonly [string, string]>   // ordered, set casing
 *
 *   interface StateApiDeps {                    // S5 ManagementApiDeps + S6 additions
 *     readonly configYaml: string               // raw config.yaml bytes as mounted;
 *                                               // materialization runs the S6 §3.1
 *                                               // load pipeline (defaults -> unmarshal ->
 *                                               // sanitize -> validate -> R-BCRYPT
 *                                               // write-back) synchronously enough that
 *                                               // the first await readConfigFile()
 *                                               // observes the rewritten bytes.
 *     readonly managementKey: string            // "oracle-mgmt-key-1": the plaintext
 *                                               // that must authenticate (hashed seed
 *                                               // configs verify it; the S6-02 plaintext
 *                                               // seed stays accepted after the
 *                                               // write-back).
 *     readonly store: Store                     // @cpa-edge/core; ALL persistent state
 *     readonly buildInfo: { version, commit, buildDate, supportPlugin }  // X-Cpa-* values
 *     readonly clientIp?: string                // "127.0.0.1" (loopback; allow-remote gate)
 *     readonly now?: () => number               // epoch-ms clock. REQUIRED by this
 *                                               // suite (frozen) for §3.6.4 buckets,
 *                                               // observed_at/created_at stamps, .cds
 *                                               // updated_at, `created` epochs, cursor
 *                                               // modTime. Every timing decision must
 *                                               // flow through it.
 *     readonly initialLogLines?: readonly LogLineEntry[]  // boot content of the log
 *                                               // window (§3.6; the node runtime reads
 *                                               // its file, other runtimes replay the
 *                                               // ring). S6-13 seeds the 14 recorded
 *                                               // startup lines.
 *     readonly deriveAuthIndex?: (input: {
 *       readonly fileName: string               // auth-file name, e.g. "s6-test-claude.json"
 *       readonly document: JsonValue           // the parsed auth-file document
 *     }) => string                              // 16-hex credential index. The
 *                                               // DERIVATION is credential-manager
 *                                               // territory (I-auth/I-core), NOT S6
 *                                               // contract; the hook injects the
 *                                               // recorded fixture values.
 *   }
 *
 *   interface StateApi {
 *     // /v0/management request surface — identical semantics to the S5 contract
 *     // (§3.3.3 auth gate, R-404, gin.H alphabetical bodies). S6 routes exercised
 *     // here: GET /config (B1), GET/PUT /config.yaml (B2/B3), the B4 scalar fields,
 *     // GET /usage-queue (B5), GET/DELETE /logs (B7/B8), GET /request-error-logs
 *     // (B9), /auth-files list/download/upload/delete (B12-B15), PATCH
 *     // /auth-files/fields (B17), GET /api-keys (the S6-02 plaintext-auth probe).
 *     // Returns a WHATWG Response with the required `rawHeaders` attachment (see
 *     // the S5 header for the canonical-casing rationale).
 *     handle(request: Request): Promise<Response & { rawHeaders: HeaderList }>
 *
 *     // usage accounting (§3.5.1): normalize the completion (empty model/provider/
 *     // executor_type/auth_type -> "unknown", alias -> model, failed derived from
 *     // downstreamStatus >= 400, fail = {status, trimmed body} / {200, ""}, session
 *     // UUID canonicalization, service_tier -> "default" fallback), serialize in the
 *     // recorded field order, then enqueue (§3.5.3: no live subscriber) or deliver
 *     // live (§3.5.3: subscriber attached — record NOT queued). Resolves only after
 *     // the queue write / live delivery is complete.
 *     recordUsage(completion: UsageCompletion): Promise<void>
 *
 *     // error events (§3.5.2): serialize (omitempty: code, retryable,
 *     // next_retry_after, quota, auth_status.model absent values dropped) and
 *     // publish to live `errors` subscribers only (no replay, no queueing).
 *     publishError(event: ErrorEvent): Promise<void>
 *
 *     // RESP usage wire (§4). One call = one fresh connection (unauthenticated
 *     // state machine). `send` resolves when every reply attributable to that input
 *     // has been emitted to the output buffer; `takeOutput` drains the buffer
 *     // synchronously; `serverClosed` reports server-side close (QUIT on a
 *     // subscribed connection, UNSUBSCRIBE). The node runtime binds this to its
 *     // first-byte-multiplexed TCP listener; the protocol code itself stays
 *     // runtime-agnostic.
 *     openUsageWire(): UsageWireConnection
 *
 *     // cooldown sidecar persistence (§3.4.4, written only when
 *     // save-cooldown-status: true): merge the record into the sidecar document
 *     // (records keyed by model, sorted), stamp updated_at from now(), persist via
 *     // Store namespace `cooldown`. Absent `quota` renders the zero-valued block
 *     // (exceeded:false, next_recover_at/observed_at "0001-01-01T00:00:00Z").
 *     recordCooldown(record: CooldownRecord): Promise<void>
 *     listCooldownSidecars(): Promise<ReadonlyArray<{
 *       readonly name: string      // "<auth-id with : -> _>.cds" form
 *       readonly authId: string
 *       readonly content: string   // the serialized sidecar bytes (2-space indent,
 *                                  // trailing newline, §3.4.4 field order)
 *     }>>
 *     isCooling(authId: string, model?: string): Promise<boolean>  // restored state
 *                                  // feeds the request layer's 503 auth_unavailable
 *                                  // decision (§3.4.4); S4 owns the policy.
 *
 *     // log window (§3.6.3): one entry per emitted line; GET /logs reads the
 *     // window (§3.6.2 semantics: tail reads, limit validation, cursor mechanics,
 *     // alphabetical response keys); DELETE /logs clears it and reports removed:0
 *     // for the active window (rotated-file counting is node-runtime detail).
 *     appendLogLine(entry: LogLineEntry): Promise<void>
 *     readLogRing(): Promise<readonly LogRingEntry[]>   // ring `logs`, capacity 1000
 *
 *     // config-defined model synthesis (§3.7.3/B26): the exact /v1/models response
 *     // body for the OpenAI protocol — {"data":[…],"object":"list"}, entries exactly
 *     // {id, object, created, owned_by}, `created` = floor(now()/1000) at synthesis
 *     // (re-stamped on every hot reload), owned_by from the provider-type mapping.
 *     buildModelList(): Promise<string>
 *
 *     // config file lifecycle (§3.3.1/3.3.2/3.3.4): current raw config.yaml bytes
 *     // (after any R-BCRYPT write-back or management persistence), and the watcher's
 *     // reload entry point — the runtime owns the file watch/debounce/sha-gate and
 *     // calls this only for real content changes; the state layer re-loads, swaps
 *     // the effective config, re-synthesizes credentials/models, re-stamps `created`,
 *     // and emits the §3.3.4 reload log lines (incl. "config successfully reloaded,
 *     // triggering client reload").
 *     readConfigFile(): Promise<string>
 *     replaceConfigFile(yaml: string): Promise<void>
 *   }
 *
 *   interface UsageCompletion {           // camelCase mirror of §3.5.1; the state layer
 *     readonly source: string             // owns normalization + serialization only —
 *     readonly authIndex: string          // token counts/accounting arrive computed.
 *     readonly clientIp: string
 *     readonly xForwardedFor: string
 *     readonly userAgent: string
 *     readonly requestId: string
 *     readonly sessionId: string          // canonicalized to a canonical UUID
 *     readonly parentSessionId?: string   // empty -> omitted (omitempty)
 *     readonly accessTokenSha256?: string // empty -> omitted (omitempty)
 *     readonly latencyMs: number
 *     readonly ttftMs: number
 *     readonly tokens: { inputTokens, outputTokens, reasoningTokens, cachedTokens,
 *       cacheReadTokens, cacheReadTokensPresent, cacheCreationTokens, totalTokens }
 *     readonly accounting: { quality, totalTokens, inputTokens: { totalTokens,
 *       uncachedTokens, cacheReadTokens, cacheWriteTokens }, outputTokens: {
 *       totalTokens, nonReasoningTokens, reasoningTokens }, unclassifiedTokens }
 *     readonly generate: boolean
 *     readonly stream: boolean
 *     readonly downstreamStatus: number   // fail.status_code; failed = status >= 400
 *     readonly failBody?: string          // verbatim upstream error body, trimmed
 *     readonly responseHeaders: HeaderList  // serialized as map<Canonical-Case, [values]>
 *                                           // with alphabetically sorted keys
 *     readonly provider: string
 *     readonly executorType: string
 *     readonly model: string
 *     readonly alias?: string             // empty -> model
 *     readonly endpoint: string           // "<METHOD> <path>" of the client call
 *     readonly authType: string
 *     readonly apiKey: string             // the CLIENT api key used on the proxy
 *     readonly reasoningEffort: string
 *     readonly serviceTier?: string       // empty -> "default"
 *   }
 *
 *   interface ErrorEvent {                // §3.5.2 payload minus the timestamp (now())
 *     readonly provider: string; readonly model: string
 *     readonly authId: string; readonly authIndex: string
 *     readonly statusCode: number; readonly body: string
 *     readonly code?: string; readonly retryable?: boolean
 *     readonly authStatus?: { status, statusMessage, disabled, unavailable,
 *       nextRetryAfter?, quota?, model?: { name, status, statusMessage, unavailable,
 *       nextRetryAfter?, quota? } }
 *   }
 *
 *   interface CooldownRecord {            // §3.4.4 record minus updated_at (now())
 *     readonly authId: string; readonly provider: string; readonly model?: string
 *     readonly status: string; readonly nextRetryAfter: string  // scheduler-computed
 *     readonly reason: string             // verbatim upstream error body
 *     readonly lastError: { message: string; retryable: boolean; httpStatus: number }
 *     readonly quota?: { exceeded: boolean; nextRecoverAt: string; observedAt: string }
 *   }
 *
 *   interface LogLineEntry { line: string; level: string; timestamp: string; requestId: string }
 *   type LogRingEntry = LogLineEntry     // §3.6.3 stored shape
 *
 *   interface UsageWireConnection {
 *     send(bytes: Uint8Array): Promise<void>
 *     takeOutput(): Uint8Array            // drains output produced so far
 *     serverClosed(): boolean
 *     close(): void
 *   }
 *
 * STATE INJECTION POINTS (S6 §0 Store mapping) that the adapter must route through
 * the injected Store — documents: config (key `effective`) + auth + cooldown +
 * requests + mgmt + models + oauth-sessions namespaces; queue `usage`; rings
 * `logs` (capacity 1000) and `errors`. The raw config.yaml bytes are NOT Store state
 * (the runtime file adapter owns them; readConfigFile is the seam).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * HARNESS SEMANTICS
 *
 * • Fresh adapter + fresh MemoryStore per case (fresh container per recording), so
 *   recording-order constraints between cases do not apply. S6-16 "docker restart"
 *   = a SECOND adapter instance over the SAME Store + same clock.
 * • The clock is FROZEN (CLOCK_BASE_MS; S6-15 advances it 1 s to pin the hot-reload
 *   `created` re-stamp). The Store gets the same clock (lease arithmetic).
 * • Seed config.yaml = the case's meta.yaml `config_fragment` — the bytes the oracle
 *   mounted. S6-02 instead seeds the `config.yaml.before-boot` disk capture (the
 *   PLAINTEXT secret-key) and asserts the after-boot capture.
 * • FIXTURE STEP → ADAPTER OPERATION mapping (client-protocol steps are NOT HTTP
 *   replays; their translation layer is S2d*/I-exec territory and out of scope):
 *     - POST /v1/chat/completions (S6-05/07/08/18 steps, S6-07 seeds): the harness
 *       calls recordUsage(...) with the completion facts transcribed from the case's
 *       OWN golden record (the recorded bytes are the source; latency/ttft/request
 *       id/session id/client ip/user agent are inputs, so their echo is pinned).
 *       The chat HTTP responses those steps recorded are not asserted here.
 *     - S6-09 step 4 (failing chat completion): publishError(...) with the event
 *       facts from the golden RESP message frame.
 *     - S6-16 steps 2/4/8 (chat 500 → cooldown → 503 after restart): recordCooldown
 *       (×2, injected in REVERSE golden order to pin the by-model sort), sidecar
 *       byte-compare, isCooling checks; the 500/503 chat bodies are S2d/S4 scope.
 *     - S6-15 step 2 (config file edit): replaceConfigFile(after-edit disk capture).
 *     - S6-13: the log window is SEEDED with the 14 recorded startup lines; the
 *       step-1 access-log line (recorded inside the step-2 golden) is appended via
 *       appendLogLine after step 1, modeling the transport's gin-logger emission.
 *     - everything else replays through handle() as literal HTTP requests.
 * • RESP driving: per connection the recorded client byte stream is split into its
 *   RESP commands (tolerant framing — conn 2 of S6-07 deliberately declares $12
 *   for a 13-byte payload); each command's raw span is sent, then takeOutput drains
 *   the replies. The CONCATENATED output is compared as a decoded frame sequence
 *   against the golden server stream.
 * • S6-18's instance (`S6-follow-up`) has usage-statistics-enabled: true — recordUsage
 *   must produce a record for a FAILED completion too (§3.5.1).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * COMPARISON RULES
 *
 * Status: exact. Body: byte-exact after masking (below). Headers: the recorded list
 * minus the runtime-framed set {Date, Content-Length, Transfer-Encoding, Connection}
 * compared EXACTLY — order, values, absence — twice: through fetch `Headers`
 * (lowercased names) and through the required `rawHeaders` attachment (the recorded
 * canonical casing: Access-Control-*, Content-Type, X-Cpa-* …). Connection is
 * excluded as hop-by-hop framing (the S5 recorder already omitted it from its
 * goldens; the S6 recorder captured raw sockets — one adapter serves both suites).
 * If the adapter sets Content-Length it must equal the body byte length.
 *
 * RESP frames: type + content compared exactly; bulk strings additionally must be
 * SELF-CONSISTENT (declared length == payload byte length — the $12-vs-$13 contract
 * on the output side; the input side is pinned by S6-07 conn 2's `-ERR protocol
 * error` reply). Masked bulk payloads (usage records / error events) compare with
 * the mask applied; their declared lengths are only self-checked.
 *
 * MASKS — derived strictly from each case's meta.yaml `dynamic_fields` (unknown
 * entries fail loudly so new volatility must be added consciously). POLICY: only
 * values the ADAPTER GENERATES from the clock or randomness are masked; values the
 * harness supplies as fixed inputs (latency_ms, ttft_ms, request_id, client_ip,
 * user_agent, session_id, upstream response headers, verbatim error bodies, seeded
 * log lines, entry size/path/id) are NOT masked — their byte-exact echo IS the
 * contract. Every mask below therefore stays within the meta's declared volatility:
 *   - ports (8387/19999/2000[1-7]): masked in URLs, YAML `port:` and JSON "port"
 *     values (S5-consistent policy).
 *   - bcrypt hash value: `$2a$10$…53` -> "<BCRYPT-HASH>" (S6-02; structure asserted).
 *   - record/event "timestamp" (adapter-stamped RFC3339Nano): masked, shape-guarded.
 *   - invalid_yaml/invalid_config "message" (foreign parser text): masked; the
 *     "error" code field stays byte-pinned.
 *   - listing "created_at"/"modtime"/"updated_at" (±HH:MM local, shape-guarded) and
 *     "observed_at" (UTC Z, shape-guarded), "auth_index" (hook-supplied), bucket
 *     labels "HH:MM-HH:MM" (structure stays pinned: 20 zeroed buckets).
 *   - /logs "next-cursor": masked; the decoded cursor is structure-checked
 *     (v==1, file=="main.log", offset==size==window byte length, latestTimestamp,
 *     16-char base64url fingerprint). S6-16's meta omits observed_at for its one
 *     listing step — masked anyway (wall-clock envelope stamp, S6-10/S5 precedent;
 *     treated as a fixture-list gap).
 *   - .cds "updated_at" + "next_retry_after": masked; next_retry_after must equal
 *     the injected scheduler value verbatim; the rest of the sidecar (field order,
 *     zero-quota block, last_error, record sort) is byte-pinned.
 *   - model-list "created": masked; additionally asserted === floor(now()/1000)
 *     (B26) — all entries share the synthesis instant, re-stamped on hot reload.
 *   - S6-13 step 5 (post-clear read): lines/line-count/latest-timestamp are file
 *     artifacts of the reference's truncate behavior — masked per meta; the
 *     response key order/set stays pinned via the raw body regex.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * NOT COVERED HERE (registered, with owners): queue retention drops (§3.5.3 — the
 * consumer loop is timed substrate work, S7 F5b/F5c; no fixture), B19 management-off
 * 404s (no fixture: every instance has a secret), normalization fallbacks with no
 * recorded instance (service_tier "" -> "default", empty alias -> model, empty
 * provider -> "unknown"), multipart upload + multi-file 207 (no fixture), the
 * xai/kimi/vertex 2-space-indented typed-token save paths (S6-10/11 only exercise
 * the single-line metadata path; §3.4.2), log rotation/cleaner (§3.6.1, node
 * runtime), the 1024..1000 ring capacity boundary, mgmt ban counters (§3.3.3),
 * oauth-sessions/mgmt/models Store documents (no direct fixtures; S3/S5 own the
 * flows), S6-17 OAuth token-file bytes (FIXTURE-DEFERRED, §3.4.2/3.4.3 specify).
 * The mission brief's "46-key pin" is 47 keys in the recorded golden — the fixture
 * is authoritative (S6 inventory pins the exact sorted list).
 */


import { readdir, readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { MemoryStore } from '@cpa-edge/core'
import type { JsonValue, Store } from '@cpa-edge/core'

// ─── Adapter load (skip-with-explanation until the export ships) ────────────────────

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

interface LogLineEntry {
  readonly line: string
  readonly level: string
  readonly timestamp: string
  readonly requestId: string
}

type LogRingEntry = LogLineEntry

interface UsageTokens {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly reasoningTokens: number
  readonly cachedTokens: number
  readonly cacheReadTokens: number
  readonly cacheReadTokensPresent: boolean
  readonly cacheCreationTokens: number
  readonly totalTokens: number
}

interface UsageAccounting {
  readonly quality: string
  readonly totalTokens: number
  readonly inputTokens: { readonly totalTokens: number; readonly uncachedTokens: number; readonly cacheReadTokens: number; readonly cacheWriteTokens: number }
  readonly outputTokens: { readonly totalTokens: number; readonly nonReasoningTokens: number; readonly reasoningTokens: number }
  readonly unclassifiedTokens: number
}

interface UsageCompletion {
  readonly source: string
  readonly authIndex: string
  readonly clientIp: string
  readonly xForwardedFor: string
  readonly userAgent: string
  readonly requestId: string
  readonly sessionId: string
  readonly parentSessionId?: string
  readonly accessTokenSha256?: string
  readonly latencyMs: number
  readonly ttftMs: number
  readonly tokens: UsageTokens
  readonly accounting: UsageAccounting
  readonly generate: boolean
  readonly stream: boolean
  readonly downstreamStatus: number
  readonly failBody?: string
  readonly responseHeaders: HeaderList
  readonly provider: string
  readonly executorType: string
  readonly model: string
  readonly alias?: string
  readonly endpoint: string
  readonly authType: string
  readonly apiKey: string
  readonly reasoningEffort: string
  readonly serviceTier?: string
}

interface ErrorEventAuthStatusModel {
  readonly name: string
  readonly status: string
  readonly statusMessage: string
  readonly unavailable: boolean
}

interface ErrorEvent {
  readonly provider: string
  readonly model: string
  readonly authId: string
  readonly authIndex: string
  readonly statusCode: number
  readonly body: string
  readonly code?: string
  readonly retryable?: boolean
  readonly authStatus?: {
    readonly status: string
    readonly statusMessage: string
    readonly disabled: boolean
    readonly unavailable: boolean
    readonly model?: ErrorEventAuthStatusModel
  }
}

interface CooldownRecord {
  readonly authId: string
  readonly provider: string
  readonly model?: string
  readonly status: string
  readonly nextRetryAfter: string
  readonly reason: string
  readonly lastError: { readonly message: string; readonly retryable: boolean; readonly httpStatus: number }
  readonly quota?: { readonly exceeded: boolean; readonly nextRecoverAt: string; readonly observedAt: string }
}

interface CooldownSidecar {
  readonly name: string
  readonly authId: string
  readonly content: string
}

interface UsageWireConnection {
  send(bytes: Uint8Array): Promise<void>
  takeOutput(): Uint8Array
  serverClosed(): boolean
  close(): void
}

interface StateApi {
  handle(request: Request): Promise<Response & { rawHeaders: HeaderList }>
  recordUsage(completion: UsageCompletion): Promise<void>
  publishError(event: ErrorEvent): Promise<void>
  openUsageWire(): UsageWireConnection
  recordCooldown(record: CooldownRecord): Promise<void>
  listCooldownSidecars(): Promise<ReadonlyArray<CooldownSidecar>>
  isCooling(authId: string, model?: string): Promise<boolean>
  appendLogLine(entry: LogLineEntry): Promise<void>
  readLogRing(): Promise<ReadonlyArray<LogRingEntry>>
  buildModelList(): Promise<string>
  readConfigFile(): Promise<string>
  replaceConfigFile(yaml: string): Promise<void>
}

interface StateApiDeps {
  readonly configYaml: string
  readonly managementKey: string
  readonly store: Store
  readonly buildInfo: BuildInfo
  readonly clientIp?: string
  readonly now?: () => number
  readonly initialLogLines?: ReadonlyArray<LogLineEntry>
  readonly deriveAuthIndex?: (input: { readonly fileName: string; readonly document: JsonValue }) => string
}

type AdapterFactory = (deps: StateApiDeps) => StateApi

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
        'All 17 S6 golden cases SKIP until the state-layer adapter ships; the required interface is documented in the header of this file.',
    }
  } catch (error) {
    return { skipReason: `import of \`${ADAPTER_MODULE}\` failed: ${String(error)}` }
  }
}

const adapterLoad = await loadAdapter()
const adapterFactory = adapterLoad.factory
const baseSuite = adapterFactory ? describe : describe.skip
const suiteTitle = adapterFactory
  ? 'S6 — state & storage golden contract (recorded fixtures)'
  : `S6 — state & storage golden contract (SKIPPED: ${adapterLoad.skipReason ?? 'adapter unavailable'})`

/** Operations this suite needs beyond the S5 `handle` contract, in check order. */
const STATE_OPS: ReadonlyArray<keyof StateApi> = [
  'recordUsage',
  'publishError',
  'openUsageWire',
  'recordCooldown',
  'listCooldownSidecars',
  'isCooling',
  'appendLogLine',
  'readLogRing',
  'buildModelList',
  'readConfigFile',
  'replaceConfigFile',
]

function missingStateOps(api: StateApi): readonly string[] {
  const missing: string[] = []
  for (const op of STATE_OPS) {
    if (typeof api[op] !== 'function') missing.push(op)
  }
  return missing
}


// ─── Fixture access ─────────────────────────────────────────────────────────────────

const FIXTURE_ROOT = new URL('../fixtures/S6/', import.meta.url)
const MANAGEMENT_KEY = 'oracle-mgmt-key-1'
const CLIENT_IP = '127.0.0.1'
const REQUEST_ORIGIN = 'http://127.0.0.1:8387'
const BUILD_INFO: BuildInfo = {
  version: 'v7.3.4',
  commit: '8335eac',
  buildDate: '2026-09-15T14:07:06Z',
  supportPlugin: true,
}
const CLOCK_BASE_MS = 1_789_495_200_000
const encoder = new TextEncoder()
const decoder = new TextDecoder()

const EXPECTED_CASES = [
  'S6-01-config-get',
  'S6-02-secret-bcrypt-mutation',
  'S6-03-config-yaml-roundtrip',
  'S6-04-field-toggle-persist',
  'S6-05-usage-queue-record',
  'S6-06-usage-queue-errors',
  'S6-07-usage-resp-protocol',
  'S6-08-usage-subscribe-stream',
  'S6-09-errors-subscribe-stream',
  'S6-10-authfile-upload-list-delete',
  'S6-11-authfile-patch-fields',
  'S6-12-logs-disabled',
  'S6-13-logs-enabled',
  'S6-14-models-created-epoch',
  'S6-15-hot-reload-provider',
  'S6-16-cds-cooldown',
  'S6-18-failed-usage-record',
] as const

type CaseId = (typeof EXPECTED_CASES)[number]

const RESP_CASES: ReadonlySet<string> = new Set([
  'S6-07-usage-resp-protocol',
  'S6-08-usage-subscribe-stream',
  'S6-09-errors-subscribe-stream',
])

/** The S6-01 effective-view golden: 47 top-level keys (fixture is authoritative). */
const EXPECTED_CONFIG_VIEW_KEYS: readonly string[] = [
  'antigravity', 'api-keys', 'auth-auto-refresh-workers', 'claude-api-key', 'claude-code',
  'claude-header-defaults', 'codex', 'codex-api-key', 'codex-header-defaults', 'commercial-mode',
  'credential-concurrency', 'credential-in-flight', 'debug', 'devin', 'disable-claude-cloak-mode',
  'disable-cooling', 'disable-image-generation', 'discovery', 'error-logs-max-files',
  'force-model-prefix', 'gemini-api-key', 'interactions-api-key', 'logging-to-file',
  'logs-max-total-size-mb', 'max-retry-credentials', 'max-retry-interval', 'meta-api-key',
  'openai-compatibility', 'passthrough-headers', 'payload', 'plugins', 'pprof', 'proxy-url',
  'quota-exceeded', 'redis-usage-queue-retention-seconds', 'request-log', 'request-retry',
  'routing', 'save-cooldown-status', 'streaming', 'tls', 'transient-error-cooldown-seconds',
  'usage-statistics-enabled', 'vertex-api-key', 'ws-auth', 'xai', 'xai-api-key',
]

/** §3.5.1 record field order as recorded (access_token_sha256 / parent_session_id omitempty). */
const EXPECTED_USAGE_RECORD_KEYS: readonly string[] = [
  'timestamp', 'latency_ms', 'ttft_ms', 'source', 'auth_index', 'client_ip', 'x_forwarded_for',
  'user_agent', 'tokens', 'failed', 'generate', 'stream', 'fail', 'response_headers',
  'accounting_version', 'token_breakdown', 'provider', 'executor_type', 'model', 'alias',
  'endpoint', 'auth_type', 'api_key', 'request_id', 'session_id', 'reasoning_effort', 'service_tier',
]

/** §3.5.2 error-event field order as recorded (code/retryable/next_retry_after/quota omitted). */
const EXPECTED_ERROR_EVENT_KEYS: readonly string[] = [
  'timestamp', 'provider', 'model', 'auth_id', 'auth_index', 'status_code', 'body', 'auth_status',
]

/** §3.4.5 listing entry field order as recorded (S6-10 step 3). */
const EXPECTED_AUTH_ENTRY_KEYS: readonly string[] = [
  'account', 'account_type', 'auth_index', 'cooldowns', 'created_at', 'disabled', 'email',
  'failed', 'id', 'label', 'last_refresh', 'modtime', 'name', 'path', 'provider', 'quota',
  'recent_requests', 'runtime_only', 'size', 'source', 'status', 'status_message', 'success',
  'type', 'unavailable', 'updated_at',
]

/** §3.4.4 sidecar envelope + record field order as recorded. */
const EXPECTED_CDS_ENVELOPE_KEYS: readonly string[] = ['version', 'auth_id', 'provider', 'updated_at', 'records']
const EXPECTED_CDS_RECORD_KEYS: readonly string[] = [
  'provider', 'auth_id', 'status', 'next_retry_after', 'reason', 'quota', 'last_error', 'updated_at',
]
const EXPECTED_CDS_MODEL_RECORD_KEYS: readonly string[] = [
  'provider', 'auth_id', 'model', 'status', 'next_retry_after', 'reason', 'quota', 'last_error', 'updated_at',
]

function caseFile(caseId: string, name: string): URL {
  return new URL(`${caseId}/${name}`, FIXTURE_ROOT)
}

async function readFixtureText(caseId: string, name: string): Promise<string> {
  return readFile(caseFile(caseId, name), 'utf8')
}

async function readFixtureJson<T>(caseId: string, name: string): Promise<T> {
  return JSON.parse(await readFixtureText(caseId, name)) as T
}

interface CaseMeta {
  readonly case: string
  readonly instance: string
  readonly config_fragment: string
  readonly requests?: ReadonlyArray<{ readonly file: string; readonly step?: number; readonly what?: string }>
  readonly responses?: ReadonlyArray<{
    readonly file: string
    readonly step?: number
    readonly status?: number
    readonly what?: string
  }>
  readonly dynamic_fields: readonly string[]
  readonly disk_captures?: ReadonlyArray<{ readonly file: string; readonly what: string }>
}

function byteLength(text: string): number {
  return encoder.encode(text).length
}

// ─── Fixture file parsers ───────────────────────────────────────────────────────────

interface RequestSection {
  readonly method: string
  readonly path: string
  readonly headers: HeaderList
  readonly body: string
}

/**
 * S6 request files carry the raw wire: CRLF-framed request head, then the exact body
 * bytes (LF-only bodies in these fixtures). The body is everything after the first
 * blank line and must match the recorded Content-Length when one is present.
 */
function parseRequestFile(text: string, context: string): RequestSection {
  const crlfSplit = text.split('\r\n\r\n')
  const head = crlfSplit.length > 1 ? (crlfSplit[0] ?? '') : (text.split('\n\n')[0] ?? '')
  const body =
    crlfSplit.length > 1
      ? text.slice(head.length + 4)
      : text.slice(head.length + 2)
  const lines = head.split(/\r?\n/)
  const requestLine = lines[0] ?? ''
  const parts = requestLine.split(' ')
  const headers: Array<[string, string]> = []
  let declaredLength: number | undefined
  for (const line of lines.slice(1)) {
    const separator = line.indexOf(': ')
    if (separator <= 0) throw new Error(`${context}: unparsable header line ${JSON.stringify(line)}`)
    const name = line.slice(0, separator)
    const value = line.slice(separator + 2)
    if (name.toLowerCase() === 'content-length') declaredLength = Number(value)
    headers.push([name, value])
  }
  if (declaredLength !== undefined && declaredLength !== byteLength(body)) {
    throw new Error(
      `${context}: recorded Content-Length ${declaredLength} != body bytes ${byteLength(body)}`,
    )
  }
  return { method: parts[0] ?? '', path: parts[1] ?? '', headers, body }
}

interface DownstreamSection {
  readonly status: number
  readonly headers: HeaderList
  readonly body: string
}

/**
 * S6 downstream files hold ONE response each: `## Status line`, `## Response headers
 * (raw, received order)`, `## Body … (exact bytes received, N bytes)` (a second raw
 * chunked-stream block repeats the same bytes — ignored). The body is reconstructed
 * against the recorded byte count (the markdown fence eats one trailing newline).
 */
function parseDownstreamFile(text: string, context: string): DownstreamSection {
  const statusMatch = /HTTP\/1\.1 (\d+) /.exec(text)
  if (statusMatch === null) throw new Error(`${context}: no status line`)
  const headers: Array<[string, string]> = []
  const headerMatch = /## Response headers \(raw, received order\)\n(.*?)\n\n/.exec(text)
  if (headerMatch === null || headerMatch[1] === undefined) {
    throw new Error(`${context}: no response-header block`)
  }
  for (const line of headerMatch[1].split('\n')) {
    const separator = line.indexOf(': ')
    if (separator <= 0) throw new Error(`${context}: unparsable recorded header ${JSON.stringify(line)}`)
    headers.push([line.slice(0, separator), line.slice(separator + 2)])
  }
  const bodyMatch =
    /## Body (?:\([^)]*\) )?\(exact bytes received, (\d+) bytes\)\n```\n([\s\S]*?)\n```\n/.exec(text)
  if (bodyMatch === null || bodyMatch[1] === undefined || bodyMatch[2] === undefined) {
    throw new Error(`${context}: no exact-bytes body block`)
  }
  const stated = Number(bodyMatch[1])
  const rendered = bodyMatch[2]
  let body: string | undefined
  for (const candidate of [rendered, `${rendered}\n`]) {
    if (byteLength(candidate) === stated) {
      body = candidate
      break
    }
  }
  if (body === undefined) {
    throw new Error(`${context}: body does not reconstruct to the recorded ${stated} bytes`)
  }
  return { status: Number(statusMatch[1]), headers, body }
}

// ─── RESP transcript parsing ────────────────────────────────────────────────────────

interface RespConnTranscript {
  readonly index: number
  readonly description: string
  readonly statedBytes: number
  readonly direction: 'sent' | 'received'
  readonly literal: string
}

function parseRespTranscript(text: string, context: string): readonly RespConnTranscript[] {
  const sectionRe = /^## conn (\d+) — (.*?) — (\d+) bytes (sent|received)\s*$/gm
  const matches = [...text.matchAll(sectionRe)]
  const conns: RespConnTranscript[] = []
  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i]
    if (match === undefined) throw new Error(`${context}: conn match missing`)
    const index = Number(match[1])
    const description = match[2] ?? ''
    const statedBytes = Number(match[3])
    const direction = match[4] === 'received' ? 'received' : 'sent'
    const start = (match.index ?? 0) + match[0].length
    const end = i + 1 < matches.length ? matches[i + 1]?.index ?? text.length : text.length
    const section = text.slice(start, end)
    const literalMatch = /literal \(escaped\):\n```\n([\s\S]*?)\n```/.exec(section)
    if (literalMatch === null || literalMatch[1] === undefined) {
      throw new Error(`${context} conn ${index}: no escaped literal block`)
    }
    // Only \r\n sequences are recorder escapes; embedded \" / \u… are payload bytes.
    const literal = literalMatch[1].replaceAll('\\r\\n', '\r
')
    if (byteLength(literal) !== statedBytes) {
      throw new Error(`${context} conn ${index}: decoded ${byteLength(literal)} bytes, stated ${statedBytes}`)
    }
    conns.push({ index, description, statedBytes, direction, literal })
  }
  return conns
}

type RespFrame =
  | { readonly kind: 'simple'; readonly value: string }
  | { readonly kind: 'error'; readonly value: string }
  | { readonly kind: 'integer'; readonly value: number }
  | { readonly kind: 'bulk'; readonly declared: number; readonly value: string | null }
  | { readonly kind: 'array'; readonly count: number; readonly items: readonly RespFrame[] }

/** Strict RESP parser (declared lengths must match payload bytes). */
function parseRespFrames(data: Uint8Array, context: string): readonly RespFrame[] {
  let pos = 0
  const readLine = (): string => {
    const eol = data.indexOf(13, pos) // CR
    if (eol === -1 || data[eol + 1] !== 10) throw new Error(`${context}: unterminated RESP line at ${pos}`)
    const line = decoder.decode(data.subarray(pos, eol))
    pos = eol + 2
    return line
  }
  const parseOne = (): RespFrame => {
    if (pos >= data.length) throw new Error(`${context}: truncated RESP stream`)
    const type = decoder.decode(data.subarray(pos, pos + 1))
    pos += 1
    const line = readLine()
    if (type === '+') return { kind: 'simple', value: line }
    if (type === '-') return { kind: 'error', value: line }
    if (type === ':') return { kind: 'integer', value: Number(line) }
    if (type === '$') {
      const declared = Number(line)
      if (declared === -1) return { kind: 'bulk', declared, value: null }
      const payload = data.subarray(pos, pos + declared)
      if (payload.length !== declared || data[pos + declared] !== 13 || data[pos + declared + 1] !== 10) {
        throw new Error(`${context}: bulk declares ${declared} bytes but the stream disagrees`)
      }
      pos += declared + 2
      return { kind: 'bulk', declared, value: decoder.decode(payload) }
    }
    if (type === '*') {
      const count = Number(line)
      const items: RespFrame[] = []
      for (let i = 0; i < count; i += 1) items.push(parseOne())
      return { kind: 'array', count, items }
    }
    throw new Error(`${context}: unknown RESP type ${JSON.stringify(type)} at ${pos - 1}`)
  }
  const frames: RespFrame[] = []
  while (pos < data.length) frames.push(parseOne())
  return frames
}

/**
 * Splits a client byte stream into its top-level commands, returning the RAW byte
 * spans. Tolerant bulk framing (payload read until CRLF): S6-07 conn 2 deliberately
 * declares $12 for a 13-byte payload and the bytes must reach the adapter verbatim.
 */
function splitRespCommands(data: Uint8Array, context: string): readonly Uint8Array[] {
  let pos = 0
  const readLineEnd = (): number => {
    for (let i = pos; i + 1 < data.length; i += 1) {
      if (data[i] === 13 && data[i + 1] === 10) return i
    }
    throw new Error(`${context}: unterminated client line at ${pos}`)
  }
  const parseSpan = (): [number, number] => {
    const start = pos
    if (pos >= data.length) throw new Error(`${context}: truncated client stream`)
    const type = decoder.decode(data.subarray(pos, pos + 1))
    pos += 1
    const eol = readLineEnd()
    const line = decoder.decode(data.subarray(pos, eol))
    pos = eol + 2
    if (type === '+' || type === '-' || type === ':') return [start, pos]
    if (type === '$') {
      const declared = Number(line)
      if (declared === -1) return [start, pos]
      // tolerant: read until CRLF regardless of the declared length
      const payloadEnd = readLineEnd()
      pos = payloadEnd + 2
      return [start, pos]
    }
    if (type === '*') {
      const count = Number(line)
      for (let i = 0; i < count; i += 1) parseSpan()
      return [start, pos]
    }
    throw new Error(`${context}: unknown client RESP type ${JSON.stringify(type)}`)
  }
  const spans: Uint8Array[] = []
  while (pos < data.length) {
    const [start, end] = parseSpan()
    spans.push(data.subarray(start, end))
  }
  return spans
}


// ─── Masking (meta.yaml dynamic_fields -> normalization) ─────────────────────────────

interface MaskProfile {
  readonly ports: boolean
  readonly bcrypt: boolean
  readonly recordTimestamp: boolean
  readonly errorMessage: boolean
  readonly listingStamps: boolean
  readonly observedAt: boolean
  readonly authIndex: boolean
  readonly bucketLabels: boolean
  readonly nextRetryAfter: boolean
  readonly updatedStamps: boolean
  readonly cursor: boolean
  readonly created: boolean
}

const EMPTY_MASK: MaskProfile = {
  ports: false,
  bcrypt: false,
  recordTimestamp: false,
  errorMessage: false,
  listingStamps: false,
  observedAt: false,
  authIndex: false,
  bucketLabels: false,
  nextRetryAfter: false,
  updatedStamps: false,
  cursor: false,
  created: false,
}

/** Exact dynamic_fields strings recorded by the oracle (see each case meta.yaml). */
const DYN = {
  date: 'Date',
  dateHeader: 'Date header',
  buildHeaders:
    'X-CPA-VERSION/X-CPA-COMMIT/X-CPA-BUILD-DATE (build-stable; record actual values, mask in diff if image rebuilt)',
  ports: 'ports (8387/19999/200xx)',
  bcrypt: 'bcrypt hash value (random salt; keep the $2a$10$ + 53-char tail structure in the fixture, mask the tail)',
  invalidMessage: 'message text of invalid_yaml/invalid_config (upstream error strings; treat as masked-dynamic, assert error code only)',
  secretLine: 'secret-key hash line',
  recordTimestamp: 'record.timestamp',
  recordLatency: 'record.latency_ms',
  recordTtft: 'record.ttft_ms',
  recordRequestId: 'record.request_id',
  recordClientIp: 'record.client_ip',
  recordXff: 'record.x_forwarded_for',
  recordUserAgent: 'record.user_agent',
  recordUserAgentCurl: 'record.user_agent (curl version)',
  recordSha: 'record.access_token_sha256 (if populated)',
  recordSession: 'record.session_id',
  step4Records: 'step 4 record fields if a record is present (mask as in S6-05)',
  respBulkRecords: 'usage record fields inside step-4 bulk strings (mask as in S6-05)',
  messageFrameRecords: 'usage record fields inside step-4 message frame',
  eventTimestamp: 'error event timestamp',
  eventNextRetry: 'auth_status.next_retry_after / quota timestamps if present',
  eventBodyText: 'record body/message text fragments that embed upstream error strings (record actuals; mask only timestamps)',
  observedAt: 'observed_at',
  entryStamps: 'entry created_at/modtime/updated_at/last_refresh if populated',
  entrySize: 'entry size (record actual)',
  entryAuthIndex: 'entry auth_index (record actual; deterministic for identical config but mask in diff)',
  entryBuckets: 'entry recent_requests bucket labels (HH:MM local time)',
  logsLines: 'lines contents (timestamps, ports, config echoes)',
  logsLineCount: 'line-count',
  logsLatest: 'latest-timestamp',
  logsCursor: 'next-cursor',
  createdEpoch: 'data[].created (server epoch; mask value, assert within [start-60s, now])',
  createdFields: 'created fields',
  dockerLogTs: 'docker log timestamps',
  reloadTiming: 'reload timing',
  cdsStamps: '.cds updated_at / next_retry_at timestamps',
  cdsCooldowns: 'cooldowns block timestamps',
  cdsLastError: 'last_upstream_error body string (embeds mock error text — record actual, mask in diff)',
} as const

function maskProfile(caseId: string, dynamicFields: readonly string[]): MaskProfile {
  const mask = { ...EMPTY_MASK }
  const recordFields = () => {
    mask.recordTimestamp = true
  }
  for (const field of dynamicFields) {
    if (
      field === DYN.date ||
      field === DYN.dateHeader ||
      field === DYN.buildHeaders ||
      field === DYN.secretLine ||
      field === DYN.dockerLogTs ||
      field === DYN.reloadTiming ||
      field === DYN.cdsCooldowns ||
      field === DYN.cdsLastError ||
      field === DYN.entrySize
    ) {
      // Response-header / recording-time notes, or harness-supplied values whose
      // byte-exact echo IS the pin (already-hashed secret-key, verbatim error bodies,
      // the re-serialized entry size). No body mask.
      continue
    }
    if (field === DYN.ports) {
      mask.ports = true
      continue
    }
    if (field === DYN.bcrypt) {
      mask.bcrypt = true
      continue
    }
    if (field === DYN.invalidMessage) {
      mask.errorMessage = true
      continue
    }
    if (
      field === DYN.recordTimestamp ||
      field === DYN.eventTimestamp
    ) {
      recordFields()
      continue
    }
    if (
      field === DYN.recordLatency ||
      field === DYN.recordTtft ||
      field === DYN.recordRequestId ||
      field === DYN.recordClientIp ||
      field === DYN.recordXff ||
      field === DYN.recordUserAgent ||
      field === DYN.recordUserAgentCurl ||
      field === DYN.recordSha ||
      field === DYN.recordSession
    ) {
      // Harness-supplied completion facts: not masked, echo pinned (header policy).
      continue
    }
    if (field === DYN.step4Records || field === DYN.respBulkRecords || field === DYN.messageFrameRecords) {
      recordFields()
      continue
    }
    if (field === DYN.eventNextRetry) {
      mask.nextRetryAfter = true
      continue
    }
    if (field === DYN.eventBodyText) {
      continue // verbatim error bodies are pinned; only timestamps mask (handled above)
    }
    if (field === DYN.observedAt) {
      mask.observedAt = true
      continue
    }
    if (field === DYN.entryStamps) {
      mask.listingStamps = true
      continue
    }
    if (field === DYN.entryAuthIndex) {
      mask.authIndex = true
      continue
    }
    if (field === DYN.entryBuckets) {
      mask.bucketLabels = true
      continue
    }
    if (field === DYN.logsLines || field === DYN.logsLineCount || field === DYN.logsLatest) {
      continue // steps with fixture-seeded lines stay byte-pinned; step-5 artifact handling is bespoke
    }
    if (field === DYN.logsCursor) {
      mask.cursor = true
      continue
    }
    if (field === DYN.createdEpoch || field === DYN.createdFields) {
      mask.created = true
      continue
    }
    if (field === DYN.cdsStamps) {
      mask.nextRetryAfter = true
      mask.updatedStamps = true
      continue
    }
    throw new Error(
      `S6[${caseId}]: unrecognized meta.yaml dynamic_fields entry ${JSON.stringify(field)} — ` +
        'extend the mask table in tests/contract/s6-state.test.ts consciously',
    )
  }
  return mask
}

const PORT_IN_URL_RE = /:(8387|19999|2000[1-7])(?![0-9])/g
const PORT_IN_YAML_RE = /(port:[ "]*)(8387|19999|2000[1-7])(?![0-9])/g
const PORT_IN_JSON_RE = /("port":\s*)(8387|19999|2000[1-7])(?![0-9])/g
const SECRET_KEY_BCRYPT_RE = /secret-key: "\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}"/g
const RECORD_TIMESTAMP_RE = /"timestamp":\s*"([^"]*)"/g
const ERROR_MESSAGE_RE = /"message":\s*"[^"]*"/g
const ENTRY_STAMP_RE = /"(created_at|modtime|updated_at)":\s*"([^"]*)"/g
const OBSERVED_AT_RE = /"observed_at":\s*"([^"]*)"/g
const AUTH_INDEX_RE = /"auth_index":"[0-9a-f]{16}"/g
const BUCKET_LABEL_RE = /"time":"\d{2}:\d{2}-\d{2}:\d{2}"/g
const NEXT_RETRY_AFTER_RE = /"next_retry_after":\s*"[^"]*"/g
const UPDATED_STAMP_RE = /"updated_at":\s*"[^"]*"/g
const CURSOR_RE = /"next-cursor":"[^"]*"/g
const CREATED_RE = /"created":\d+/g

function normalizeBody(body: string, mask: MaskProfile): string {
  let out = body
  if (mask.ports) {
    out = out
      .replace(PORT_IN_URL_RE, ':<PORT>')
      .replace(PORT_IN_YAML_RE, (_match, prefix: string) => `${prefix}<PORT>`)
      .replace(PORT_IN_JSON_RE, (_match, prefix: string) => `${prefix}<PORT>`)
  }
  if (mask.bcrypt) out = out.replace(SECRET_KEY_BCRYPT_RE, 'secret-key: "<BCRYPT-HASH>"')
  if (mask.recordTimestamp) out = out.replace(RECORD_TIMESTAMP_RE, '"timestamp":"<TS>"')
  if (mask.errorMessage) out = out.replace(ERROR_MESSAGE_RE, '"message":"<MSG>"')
  if (mask.listingStamps) out = out.replace(ENTRY_STAMP_RE, (_match, key: string) => `"${key}":"<TS>"`)
  if (mask.observedAt) out = out.replace(OBSERVED_AT_RE, '"observed_at":"<TS>"')
  if (mask.authIndex) out = out.replace(AUTH_INDEX_RE, '"auth_index":"<AUTH-INDEX>"')
  if (mask.bucketLabels) out = out.replace(BUCKET_LABEL_RE, '"time":"<BUCKET>"')
  if (mask.nextRetryAfter) out = out.replace(NEXT_RETRY_AFTER_RE, '"next_retry_after":"<TS>"')
  if (mask.updatedStamps) out = out.replace(UPDATED_STAMP_RE, '"updated_at":"<TS>"')
  if (mask.cursor) out = out.replace(CURSOR_RE, '"next-cursor":"<CURSOR>"')
  if (mask.created) out = out.replace(CREATED_RE, '"created":<EPOCH>')
  return out
}

const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/
const LOCAL_OFFSET_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?[+-]\d{2}:\d{2}$/
const UTC_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/

/** Shape guards on the PRODUCED bytes (masking hides values, not formats). */
function assertTimestampShapes(body: string, mask: MaskProfile, context: string): void {
  if (mask.recordTimestamp) {
    for (const match of body.matchAll(RECORD_TIMESTAMP_RE)) {
      const value = match[1] ?? ''
      expect(
        RFC3339_RE.test(value),
        `${context}: record timestamp must be RFC3339(Nano), got ${JSON.stringify(value)}`,
      ).toBe(true)
    }
  }
  if (mask.listingStamps) {
    for (const match of body.matchAll(ENTRY_STAMP_RE)) {
      const value = match[2] ?? ''
      expect(
        LOCAL_OFFSET_TS_RE.test(value),
        `${context}: entry timestamp ${JSON.stringify(match[1])} must carry a local ±HH:MM offset`,
      ).toBe(true)
    }
  }
  if (mask.observedAt) {
    for (const match of body.matchAll(OBSERVED_AT_RE)) {
      const value = match[1] ?? ''
      expect(
        UTC_TS_RE.test(value),
        `${context}: observed_at must be an RFC3339 UTC timestamp, got ${JSON.stringify(value)}`,
      ).toBe(true)
    }
  }
}


// ─── Clock, harness construction, golden-fact inverters ─────────────────────────────

class FrozenClock {
  private current: number
  constructor(readonly base: number) {
    this.current = base
  }
  now(): number {
    return this.current
  }
  advance(ms: number): void {
    this.current += ms
  }
}

async function loadSeedConfig(caseId: string): Promise<string> {
  if (caseId === 'S6-02-secret-bcrypt-mutation') {
    // The plaintext secret-key file the oracle mounted BEFORE the container started.
    return readFixtureText(caseId, 'disk/CLIProxyAPI/config.yaml.before-boot')
  }
  const meta = await readFixtureJson<CaseMeta>(caseId, 'meta.yaml')
  return meta.config_fragment
}

interface HarnessOptions {
  readonly clock: FrozenClock
  readonly store?: Store
  readonly initialLogLines?: ReadonlyArray<LogLineEntry>
  readonly deriveAuthIndex?: (input: { readonly fileName: string; readonly document: JsonValue }) => string
}

interface CaseHarness {
  readonly api: StateApi
  readonly store: Store
  readonly clock: FrozenClock
  readonly missing: readonly string[]
}

async function createCaseHarness(caseId: CaseId, options: HarnessOptions): Promise<CaseHarness> {
  if (adapterFactory === undefined) throw new Error('adapter factory missing')
  const store = options.store ?? new MemoryStore({ now: () => options.clock.now() })
  const deps: StateApiDeps = {
    configYaml: await loadSeedConfig(caseId),
    managementKey: MANAGEMENT_KEY,
    store,
    buildInfo: BUILD_INFO,
    clientIp: CLIENT_IP,
    now: () => options.clock.now(),
  }
  if (options.initialLogLines !== undefined) deps.initialLogLines = options.initialLogLines
  if (options.deriveAuthIndex !== undefined) deps.deriveAuthIndex = options.deriveAuthIndex
  const api = adapterFactory(deps)
  if (typeof api.handle !== 'function') {
    throw new Error(`${ADAPTER_EXPORT}() must return an object with a handle(request) method`)
  }
  return { api, store, clock: options.clock, missing: missingStateOps(api) }
}

function requireOps(harness: CaseHarness, context: { skip: () => void }): StateApi {
  if (harness.missing.length > 0) {
    context.skip()
    throw new Error(`the adapter lacks the S6 state operations: ${harness.missing.join(', ')}`)
  }
  return harness.api
}

function readRecordField<T>(record: Record<string, unknown>, key: string, context: string): T {
  const value = record[key]
  if (value === undefined) throw new Error(`${context}: golden record lacks ${JSON.stringify(key)}`)
  return value as T
}

function readNumber(record: Record<string, unknown>, key: string, context: string): number {
  const value = readRecordField<unknown>(record, key, context)
  if (typeof value !== 'number') throw new Error(`${context}: ${JSON.stringify(key)} is not a number`)
  return value
}

function readString(record: Record<string, unknown>, key: string, context: string): string {
  const value = readRecordField<unknown>(record, key, context)
  if (typeof value !== 'string') throw new Error(`${context}: ${JSON.stringify(key)} is not a string`)
  return value
}

function readObject(record: Record<string, unknown>, key: string, context: string): Record<string, unknown> {
  const value = readRecordField<unknown>(record, key, context)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${context}: ${JSON.stringify(key)} is not an object`)
  }
  return value as Record<string, unknown>
}

/** Inverts a recorded usage record (§3.5.1 wire form) into the adapter input. */
function usageCompletionFromRecord(record: Record<string, unknown>, context: string): UsageCompletion {
  const tokens = readObject(record, 'tokens', context)
  const breakdown = readObject(record, 'token_breakdown', context)
  const inputBreakdown = readObject(breakdown, 'input', context)
  const outputBreakdown = readObject(breakdown, 'output', context)
  const fail = readObject(record, 'fail', context)
  const headers = readObject(record, 'response_headers', context)
  const headerPairs: Array<[string, string]> = []
  for (const [name, values] of Object.entries(headers)) {
    if (!Array.isArray(values)) throw new Error(`${context}: response header ${name} is not an array`)
    for (const value of values) {
      if (typeof value !== 'string') throw new Error(`${context}: response header ${name} value is not a string`)
      headerPairs.push([name, value])
    }
  }
  // Deliberately reversed: the adapter must emit the map with sorted keys (§3.5.1).
  headerPairs.reverse()
  const alias = record['alias']
  const failBody = fail['body']
  const completion: UsageCompletion = {
    source: readString(record, 'source', context),
    authIndex: readString(record, 'auth_index', context),
    clientIp: readString(record, 'client_ip', context),
    xForwardedFor: readString(record, 'x_forwarded_for', context),
    userAgent: readString(record, 'user_agent', context),
    requestId: readString(record, 'request_id', context),
    sessionId: readString(record, 'session_id', context),
    latencyMs: readNumber(record, 'latency_ms', context),
    ttftMs: readNumber(record, 'ttft_ms', context),
    tokens: {
      inputTokens: readNumber(tokens, 'input_tokens', context),
      outputTokens: readNumber(tokens, 'output_tokens', context),
      reasoningTokens: readNumber(tokens, 'reasoning_tokens', context),
      cachedTokens: readNumber(tokens, 'cached_tokens', context),
      cacheReadTokens: readNumber(tokens, 'cache_read_tokens', context),
      cacheReadTokensPresent: tokens['cache_read_tokens_present'] === true,
      cacheCreationTokens: readNumber(tokens, 'cache_creation_tokens', context),
      totalTokens: readNumber(tokens, 'total_tokens', context),
    },
    accounting: {
      quality: readString(breakdown, 'quality', context),
      totalTokens: readNumber(breakdown, 'total_tokens', context),
      inputTokens: {
        totalTokens: readNumber(inputBreakdown, 'total_tokens', context),
        uncachedTokens: readNumber(inputBreakdown, 'uncached_tokens', context),
        cacheReadTokens: readNumber(inputBreakdown, 'cache_read_tokens', context),
        cacheWriteTokens: readNumber(inputBreakdown, 'cache_write_tokens', context),
      },
      outputTokens: {
        totalTokens: readNumber(outputBreakdown, 'total_tokens', context),
        nonReasoningTokens: readNumber(outputBreakdown, 'non_reasoning_tokens', context),
        reasoningTokens: readNumber(outputBreakdown, 'reasoning_tokens', context),
      },
      unclassifiedTokens: readNumber(breakdown, 'unclassified_tokens', context),
    },
    generate: record['generate'] === true,
    stream: record['stream'] === true,
    downstreamStatus: readNumber(fail, 'status_code', context),
    responseHeaders: headerPairs,
    provider: readString(record, 'provider', context),
    executorType: readString(record, 'executor_type', context),
    model: readString(record, 'model', context),
    endpoint: readString(record, 'endpoint', context),
    authType: readString(record, 'auth_type', context),
    apiKey: readString(record, 'api_key', context),
    reasoningEffort: readString(record, 'reasoning_effort', context),
  }
  if (typeof alias === 'string') completion.alias = alias
  if (typeof failBody === 'string' && failBody !== '') completion.failBody = failBody
  const parent = record['parent_session_id']
  if (typeof parent === 'string' && parent !== '') completion.parentSessionId = parent
  const sha = record['access_token_sha256']
  if (typeof sha === 'string' && sha !== '') completion.accessTokenSha256 = sha
  const tier = record['service_tier']
  if (typeof tier === 'string') completion.serviceTier = tier
  return completion
}

/** Inverts a recorded error event (§3.5.2) into the adapter input. */
function errorEventFromGolden(event: Record<string, unknown>, context: string): ErrorEvent {
  const authStatus = readObject(event, 'auth_status', context)
  const result: ErrorEvent = {
    provider: readString(event, 'provider', context),
    model: readString(event, 'model', context),
    authId: readString(event, 'auth_id', context),
    authIndex: readString(event, 'auth_index', context),
    statusCode: readNumber(event, 'status_code', context),
    body: readString(event, 'body', context),
  }
  const code = event['code']
  if (typeof code === 'string' && code !== '') result.code = code
  const retryable = event['retryable']
  if (typeof retryable === 'boolean') result.retryable = retryable
  const modelRecord = readObject(authStatus, 'model', context)
  const modelStatus: ErrorEventAuthStatusModel = {
    name: readString(modelRecord, 'name', context),
    status: readString(modelRecord, 'status', context),
    statusMessage: readString(modelRecord, 'status_message', context),
    unavailable: modelRecord['unavailable'] === true,
  }
  result.authStatus = {
    status: readString(authStatus, 'status', context),
    statusMessage: readString(authStatus, 'status_message', context),
    disabled: authStatus['disabled'] === true,
    unavailable: authStatus['unavailable'] === true,
    model: modelStatus,
  }
  return result
}

/** Inverts the recorded .cds sidecar into cooldown-record inputs (§3.4.4). */
function cooldownInputsFromSidecar(
  sidecar: Record<string, unknown>,
  clock: FrozenClock,
  context: string,
): readonly CooldownRecord[] {
  const records = sidecar['records']
  if (!Array.isArray(records)) throw new Error(`${context}: sidecar records missing`)
  const inputs = records.map((entry) => {
    const record = entry as Record<string, unknown>
    const lastError = readObject(record, 'last_error', context)
    const model = record['model']
    const input: CooldownRecord = {
      authId: readString(record, 'auth_id', context),
      provider: readString(record, 'provider', context),
      status: readString(record, 'status', context),
      // Scheduler-computed cooldown end (S4 owns the policy; §3.4.4 stores it
      // verbatim). Frozen-clock derived so the delta to the stamped updated_at
      // is a pure adapter artifact.
      nextRetryAfter: new Date(clock.now() + 30_000).toISOString(),
      reason: readString(record, 'reason', context),
      lastError: {
        message: readString(lastError, 'message', context),
        retryable: lastError['retryable'] === true,
        httpStatus: readNumber(lastError, 'http_status', context),
      },
    }
    if (typeof model === 'string') input.model = model
    return input
  })
  // Reverse golden order: the sidecar must come back sorted by model (§3.4.4).
  inputs.reverse()
  return inputs
}

const LOG_LINE_RE = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\] \[([^\]]*)\] \[([a-z]+) *\] \[([^\]]*)\] (.*)$/

/** Parses a §3.6.3-formatted line into its ring entry fields. */
function logEntryFromLine(line: string, context: string): LogLineEntry {
  const match = LOG_LINE_RE.exec(line)
  if (match === null) throw new Error(`${context}: log line does not match the §3.6.3 format: ${line.slice(0, 80)}`)
  return {
    line,
    timestamp: match[1] ?? '',
    requestId: match[2] ?? '',
    level: match[3] ?? '',
  }
}


// ─── Request construction and response assertions ───────────────────────────────────

const RUNTIME_FRAMED_HEADERS = new Set(['date', 'content-length', 'transfer-encoding', 'connection'])

function buildRequest(section: RequestSection): Request {
  const headers: Array<[string, string]> = []
  for (const [name, value] of section.headers) {
    const lower = name.toLowerCase()
    // Host derives from the URL (identical origin recorded); Content-Length derives
    // from the body bytes (byte-identical after reconstruction).
    if (lower === 'host' || lower === 'content-length') continue
    headers.push([name, value])
  }
  return new Request(`${REQUEST_ORIGIN}${section.path}`, {
    method: section.method,
    headers,
    body: section.body === '' ? undefined : section.body,
  })
}

async function stepRequest(caseId: CaseId, file: string): Promise<RequestSection> {
  return parseRequestFile(await readFixtureText(caseId, file), `${caseId}/${file}`)
}

async function stepGolden(caseId: CaseId, file: string): Promise<DownstreamSection> {
  return parseDownstreamFile(await readFixtureText(caseId, file), `${caseId}/${file}`)
}

async function replayStep(
  caseId: CaseId,
  api: StateApi,
  requestFile: string,
  goldenFile: string,
  mask: MaskProfile,
): Promise<string> {
  const request = await stepRequest(caseId, requestFile)
  const expected = await stepGolden(caseId, goldenFile)
  const response = await api.handle(buildRequest(request))
  await assertResponseStep(caseId, requestFile, response, expected, mask)
  return response.status === 0 ? '' : await response.clone().text()
}

async function assertResponseStep(
  caseId: string,
  stepFile: string,
  response: Response,
  expected: DownstreamSection,
  mask: MaskProfile,
): Promise<void> {
  const context = `S6[${caseId}] ${stepFile}`
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
        'and the recorded wire uses Go-canonical casing; see the header of this file',
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
  expect(normalizeBody(body, mask), `${context}: body bytes`).toBe(normalizeBody(expected.body, mask))
}

/** Error-shape pin for the 400/422 config.yaml ladders: code byte-pinned, message masked. */
async function assertConfigErrorStep(
  caseId: string,
  stepFile: string,
  response: Response,
  expected: DownstreamSection,
  mask: MaskProfile,
  expectedCode: string,
): Promise<void> {
  await assertResponseStep(caseId, stepFile, response, expected, mask)
  const produced = JSON.parse(await response.clone().text()) as Record<string, unknown>
  expect(produced['error'], `S6[${caseId}] ${stepFile}: error code`).toBe(expectedCode)
}

// ─── /logs response assertions (S6-13) ─────────────────────────────────────────────

interface LogsCursor {
  readonly v: number
  readonly file: string
  readonly offset: number
  readonly size: number
  readonly modTime: number
  readonly modTimeUnixNano: number
  readonly latestTimestamp: number
  readonly fingerprint: string
}

function decodeCursor(value: string, context: string): LogsCursor {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/')
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
  const parsed = JSON.parse(atob(padded)) as Record<string, unknown>
  const cursor: LogsCursor = {
    v: parsed['v'] === 1 ? 1 : Number(parsed['v']),
    file: String(parsed['file'] ?? ''),
    offset: Number(parsed['offset']),
    size: Number(parsed['size']),
    modTime: Number(parsed['modTime']),
    modTimeUnixNano: Number(parsed['modTimeUnixNano']),
    latestTimestamp: Number(parsed['latestTimestamp']),
    fingerprint: String(parsed['fingerprint'] ?? ''),
  }
  if (cursor.v !== 1) throw new Error(`${context}: cursor v must be 1`)
  return cursor
}

interface LogsExpectation {
  readonly lines?: readonly string[]
  readonly lineCount?: number
  readonly latestTimestamp?: number
  readonly windowBytes?: number
  readonly artifact?: boolean
}

const LOGS_RESPONSE_SHAPE_RE =
  /^\{"latest-timestamp":\d+,"line-count":\d+,"lines":\[[\s\S]*\],"next-cursor":"[A-Za-z0-9_-]+"\}$/

async function assertLogsStep(
  caseId: string,
  stepFile: string,
  response: Response,
  expected: DownstreamSection,
  mask: MaskProfile,
  expectation: LogsExpectation,
): Promise<void> {
  const context = `S6[${caseId}] ${stepFile}`
  expect(response.status, `${context}: status`).toBe(expected.status)
  const body = await response.text()
  expect(LOGS_RESPONSE_SHAPE_RE.test(body), `${context}: alphabetical response keys {latest-timestamp, line-count, lines, next-cursor}`).toBe(true)
  const produced = JSON.parse(body) as { latest-timestamp: unknown; 'line-count': unknown; lines: unknown; 'next-cursor': unknown }
  const cursorValue = produced['next-cursor']
  expect(typeof cursorValue, `${context}: next-cursor is a string`).toBe('string')
  const cursor = decodeCursor(cursorValue as string, context)
  expect(cursor.file, `${context}: cursor names the active log file`).toBe('main.log')
  if (expectation.windowBytes !== undefined) {
    expect(cursor.offset, `${context}: cursor offset == window byte size`).toBe(expectation.windowBytes)
    expect(cursor.size, `${context}: cursor size == window byte size`).toBe(expectation.windowBytes)
  }
  expect(cursor.fingerprint, `${context}: cursor fingerprint is 16 base64url chars`).toMatch(/^[A-Za-z0-9_-]{16}$/)
  if (expectation.latestTimestamp !== undefined) {
    expect(cursor.latestTimestamp, `${context}: cursor latestTimestamp`).toBe(expectation.latestTimestamp)
  }
  if (expectation.artifact === true) {
    // Post-clear read: lines/line-count/latest-timestamp are reference file-truncate
    // artifacts (masked per meta) — key order, key set and cursor mechanics above stay
    // pinned; the produced values are type-checked only.
    expect(Array.isArray(produced.lines), `${context}: lines is an array`).toBe(true)
    expect(typeof produced['line-count'], `${context}: line-count is a number`).toBe('number')
    expect(typeof produced['latest-timestamp'], `${context}: latest-timestamp is a number`).toBe('number')
    return
  }
  expect(produced['line-count'], `${context}: line-count`).toBe(
    expectation.lineCount ?? (expected.body === '' ? 0 : undefined),
  )
  if (expectation.lines !== undefined) {
    expect(produced.lines, `${context}: lines (tail read of the seeded window)`).toEqual([...expectation.lines])
  }
  if (expectation.latestTimestamp !== undefined) {
    expect(produced['latest-timestamp'], `${context}: latest-timestamp (parsed from line prefixes)`).toBe(
      expectation.latestTimestamp,
    )
  }
}

// ─── Model-list assertions (S6-14/S6-15) ────────────────────────────────────────────

const MODEL_ENTRY_RE = /\{[^{}]*\}/g

async function assertModelList(
  caseId: string,
  stepLabel: string,
  producedBody: string,
  expectedBody: string,
  mask: MaskProfile,
  createdEpoch: number,
): Promise<void> {
  const context = `S6[${caseId}] ${stepLabel}`
  expect(producedBody.startsWith('{"data":['), `${context}: body opens with the data array`).toBe(true)
  expect(producedBody.endsWith(',"object":"list"}'), `${context}: body closes with object:"list"`).toBe(true)
  const produced = JSON.parse(producedBody) as { readonly object: unknown; readonly data: unknown }
  expect(produced.object, `${context}: object`).toBe('list')
  const expected = JSON.parse(expectedBody) as { readonly data: unknown }
  const producedEntries = [...producedBody.matchAll(MODEL_ENTRY_RE)].map((match) => normalizeBody(match[0] ?? '', mask))
  const expectedEntries = [...expectedBody.matchAll(MODEL_ENTRY_RE)].map((match) => normalizeBody(match[0] ?? '', mask))
  expect([...producedEntries].sort(), `${context}: model entries as a sorted multiset (map order is not pinned)`).toEqual(
    [...expectedEntries].sort(),
  )
  expect(produced.data, `${context}: data array length`).toEqual(expected.data)
  for (const entry of produced.data as unknown[]) {
    const record = entry as Record<string, unknown>
    expect(
      JSON.stringify(Object.keys(record)),
      `${context}: entry key order is exactly {created,id,object,owned_by}`,
    ).toBe(JSON.stringify(['created', 'id', 'object', 'owned_by']))
    expect(record['created'], `${context}: B26 created == floor(now()/1000) at synthesis`).toBe(createdEpoch)
    expect(record['object'], `${context}: entry object`).toBe('model')
  }
}

// ─── RESP stream assertions ─────────────────────────────────────────────────────────

function assertRespFrames(
  caseId: string,
  connLabel: string,
  produced: readonly Uint8Array[],
  golden: Uint8Array,
  mask: MaskProfile,
): void {
  const context = `S6[${caseId}] ${connLabel}`
  const combined = concatBytes(produced)
  const producedFrames = parseRespFrames(combined, `${context} produced stream`)
  const goldenFrames = parseRespFrames(golden, `${context} golden stream`)
  expect(producedFrames.length, `${context}: frame count`).toBe(goldenFrames.length)
  for (let index = 0; index < goldenFrames.length; index += 1) {
    const expectedFrame = goldenFrames[index]
    const producedFrame = producedFrames[index]
    if (expectedFrame === undefined || producedFrame === undefined) {
      throw new Error(`${context}: frame ${index} missing`)
    }
    expectRespFrame(producedFrame, expectedFrame, mask, `${context} frame ${index}`)
  }
}

function expectRespFrame(produced: RespFrame, expected: RespFrame, mask: MaskProfile, context: string): void {
  expect(produced.kind, `${context}: frame kind`).toBe(expected.kind)
  if (expected.kind === 'simple' || expected.kind === 'error') {
    expect(produced.value, `${context}: ${expected.kind} value`).toBe(expected.value)
    return
  }
  if (expected.kind === 'integer') {
    expect(produced.value, `${context}: integer value`).toBe(expected.value)
    return
  }
  if (expected.kind === 'bulk') {
    if (produced.kind !== 'bulk') throw new Error(`${context}: expected a bulk frame`)
    expect(produced.declared, `${context}: bulk declared length is self-consistent`).toBe(
      produced.value === null ? -1 : byteLength(produced.value),
    )
    if (expected.value === null) {
      expect(produced.value, `${context}: nil bulk`).toBeNull()
      return
    }
    expect(normalizeBody(produced.value ?? '', mask), `${context}: bulk payload (masked)`).toBe(
      normalizeBody(expected.value, mask),
    )
    return
  }
  if (expected.kind === 'array') {
    if (produced.kind !== 'array') throw new Error(`${context}: expected an array frame`)
    expect(produced.count, `${context}: array count`).toBe(expected.count)
    expect(produced.items.length, `${context}: array items`).toBe(expected.items.length)
    for (let i = 0; i < expected.items.length; i += 1) {
      const expectedItem = expected.items[i]
      const producedItem = produced.items[i]
      if (expectedItem === undefined || producedItem === undefined) throw new Error(`${context}: item ${i} missing`)
      expectRespFrame(producedItem, expectedItem, mask, `${context} item ${i}`)
    }
  }
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

/** Drives one recorded connection: sends each client command, drains after each. */
async function driveRespConnection(
  api: StateApi,
  clientBytes: Uint8Array,
  commands: number,
  context: string,
): Promise<{ readonly output: readonly Uint8Array[]; readonly conn: UsageWireConnection }> {
  const conn = api.openUsageWire()
  const spans = splitRespCommands(clientBytes, context)
  expect(spans.length, `${context}: client command count`).toBe(commands)
  const output: Uint8Array[] = []
  for (const span of spans) {
    await conn.send(span)
    output.push(conn.takeOutput())
  }
  return { output, conn }
}


// ─── Fixture inventory (harness self-check, adapter-independent) ─────────────────────

const fixtureCaseDirs = (await readdir(FIXTURE_ROOT, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()

describe('S6 fixture inventory (harness self-check, adapter-independent)', () => {
  it('exposes exactly the 17 recorded golden cases (S6-17 is FIXTURE-DEFERRED, unrecorded)', () => {
    expect([...fixtureCaseDirs]).toEqual([...EXPECTED_CASES].sort())
  })

  it('parses every fixture byte-exactly and recognizes every declared dynamic field', async () => {
    for (const caseId of EXPECTED_CASES) {
      const meta = await readFixtureJson<CaseMeta>(caseId, 'meta.yaml')
      expect(meta.case, `${caseId}: meta.case echoes the directory name`).toBe(caseId)
      expect(typeof meta.instance, `${caseId}: instance recorded`).toBe('string')
      expect(typeof meta.config_fragment, `${caseId}: config fragment recorded`).toBe('string')
      maskProfile(caseId, meta.dynamic_fields) // fails loudly on unknown dynamic fields
      for (const capture of meta.disk_captures ?? []) {
        await expect(readFixtureText(caseId, capture.file), `${caseId}: disk capture ${capture.file} exists`).resolves.toBeTypeOf('string')
      }
      if (RESP_CASES.has(caseId)) {
        const clientConns = parseRespTranscript(await readFixtureText(caseId, 'request.http'), `${caseId} request.http`)
        const serverConns = parseRespTranscript(await readFixtureText(caseId, 'downstream.md'), `${caseId} downstream.md`)
        for (const conn of clientConns) {
          splitRespCommands(encoder.encode(conn.literal), `${caseId} conn ${conn.index} client stream`)
        }
        for (const conn of serverConns) {
          parseRespFrames(encoder.encode(conn.literal), `${caseId} conn ${conn.index} server stream`)
        }
        expect(clientConns.length, `${caseId}: client connections`).toBe(serverConns.length)
        // The HTTP seed/trigger steps of RESP cases are plain recorded requests too.
        for (const entry of meta.requests ?? []) {
          if (!entry.file.endsWith('.http') || (!entry.file.startsWith('request-seed') && !entry.file.startsWith('request-h'))) continue
          parseRequestFile(await readFixtureText(caseId, entry.file), `${caseId}/${entry.file}`)
          const downFile = entry.file.replace('.http', '.down.md')
          parseDownstreamFile(await readFixtureText(caseId, downFile), `${caseId}/${downFile}`)
        }
        continue
      }
      for (const entry of meta.requests ?? []) {
        const section = parseRequestFile(await readFixtureText(caseId, entry.file), `${caseId}/${entry.file}`)
        void section
      }
      for (const entry of meta.responses ?? []) {
        const golden = parseDownstreamFile(await readFixtureText(caseId, entry.file), `${caseId}/${entry.file}`)
        expect(golden.status, `${caseId}/${entry.file}: recorded status agrees with meta.yaml`).toBe(entry.status)
      }
    }
  })

  it('pins the golden shapes the replay compares rely on', async () => {
    // B1: effective-config view — 47 top-level keys (mission brief said 46; the
    // recording is authoritative and the inventory pins its exact key set).
    const configView = JSON.parse(
      (await stepGolden('S6-01-config-get', 'downstream.md')).body,
    ) as Record<string, unknown>
    expect(Object.keys(configView).sort()).toEqual([...EXPECTED_CONFIG_VIEW_KEYS].sort())
    expect(Object.keys(configView).length).toBe(EXPECTED_CONFIG_VIEW_KEYS.length)

    // §3.5.1: usage-record field order (happy + failed), tokens + breakdown orders.
    for (const caseId of ['S6-05-usage-queue-record', 'S6-18-failed-usage-record'] as const) {
      const records = JSON.parse((await stepGolden(caseId, 'downstream-2.md')).body) as unknown[]
      const record = records[0] as Record<string, unknown> | undefined
      expect(record, `${caseId}: one usage record popped`).toBeDefined()
      if (record === undefined) throw new Error('unreachable')
      expect(Object.keys(record)).toEqual([...EXPECTED_USAGE_RECORD_KEYS])
      expect(record['failed'], `${caseId}: failed flag`).toBe(caseId === 'S6-18-failed-usage-record')
      expect(Object.keys(record['tokens'] as object)).toEqual([
        'input_tokens', 'output_tokens', 'reasoning_tokens', 'cached_tokens', 'cache_read_tokens',
        'cache_read_tokens_present', 'cache_creation_tokens', 'total_tokens',
      ])
      expect(Object.keys(record['token_breakdown'] as object)).toEqual([
        'schema_version', 'quality', 'total_tokens', 'input', 'output', 'unclassified_tokens',
      ])
      usageCompletionFromRecord(record, `${caseId} golden record`) // inverter must accept it
    }

    // §3.5.2: error-event field order + inverter acceptance (S6-09 message frame).
    {
      const server = parseRespTranscript(
        await readFixtureText('S6-09-errors-subscribe-stream', 'downstream.md'),
        'S6-09 downstream.md',
      )
      const frames = parseRespFrames(encoder.encode(server[0]?.literal ?? ''), 'S6-09 conn 1')
      const message = frames.find(
        (frame) => frame.kind === 'array' && frame.items[0]?.kind === 'bulk' && frame.items[0].value === 'message',
      )
      expect(message, 'S6-09: live error-event message frame recorded').toBeDefined()
      if (message !== undefined && message.kind === 'array') {
        const payload = message.items[2]
        if (payload === undefined || payload.kind !== 'bulk' || payload.value === null) {
          throw new Error('S6-09: message frame payload missing')
        }
        const event = JSON.parse(payload.value) as Record<string, unknown>
        expect(Object.keys(event)).toEqual([...EXPECTED_ERROR_EVENT_KEYS])
        errorEventFromGolden(event, 'S6-09 golden event')
      }
    }

    // §3.4.5: listing entry field order + 20 zeroed buckets + size == re-serialized bytes.
    {
      const listing = JSON.parse((await stepGolden('S6-10-authfile-upload-list-delete', 'downstream-3.md')).body) as {
        readonly files: ReadonlyArray<Record<string, unknown>>
      }
      const entry = listing.files[0]
      expect(entry, 'S6-10: one listed auth file').toBeDefined()
      if (entry === undefined) throw new Error('unreachable')
      expect(Object.keys(entry)).toEqual([...EXPECTED_AUTH_ENTRY_KEYS])
      const buckets = entry['recent_requests'] as ReadonlyArray<Record<string, unknown>>
      expect(buckets.length, 'S6-10: 20 recent-request buckets').toBe(20)
      for (const bucket of buckets) {
        expect(bucket['success']).toBe(0)
        expect(bucket['failed']).toBe(0)
      }
      const download = await stepGolden('S6-10-authfile-upload-list-delete', 'downstream-4.md')
      const diskBytes = await readFixtureText('S6-10-authfile-upload-list-delete', 'disk/root/.cli-proxy-api/s6-test-claude.json')
      expect(download.body, 'S6-10: download returns the re-serialized on-disk bytes').toBe(diskBytes)
      expect(entry['size'], 'S6-10: entry size == re-serialized byte count').toBe(byteLength(diskBytes))
    }

    // §3.4.4: sidecar envelope/record field orders, by-model sort, zero-quota block.
    {
      const sidecarText = await readFixtureText(
        'S6-16-cds-cooldown',
        'disk/root/.cli-proxy-api/openai-compatibility_mock-openai_484455246a84.cds',
      )
      const sidecar = JSON.parse(sidecarText) as Record<string, unknown>
      expect(Object.keys(sidecar)).toEqual([...EXPECTED_CDS_ENVELOPE_KEYS])
      expect(sidecar['version']).toBe(1)
      const records = sidecar['records'] as ReadonlyArray<Record<string, unknown>>
      expect(records.length, 'S6-16: global + per-model records').toBe(2)
      expect(Object.keys(records[0] as object)).toEqual([...EXPECTED_CDS_RECORD_KEYS])
      expect(Object.keys(records[1] as object)).toEqual([...EXPECTED_CDS_MODEL_RECORD_KEYS])
      for (const record of records) {
        const quota = record['quota'] as Record<string, unknown>
        expect(quota['exceeded']).toBe(false)
        expect(quota['next_recover_at']).toBe('0001-01-01T00:00:00Z')
        expect(quota['observed_at']).toBe('0001-01-01T00:00:00Z')
        expect(Object.keys(record['last_error'] as object)).toEqual(['message', 'retryable', 'http_status'])
      }
      cooldownInputsFromSidecar(sidecar, new FrozenClock(CLOCK_BASE_MS), 'S6-16 golden sidecar')
    }

    // §3.6.2: cursor mechanics decode against the recorded window sizes.
    {
      const first = JSON.parse((await stepGolden('S6-13-logs-enabled', 'downstream.md')).body) as Record<string, unknown>
      const lines = first['lines'] as string[]
      const windowBytes = lines.reduce((sum, line) => sum + byteLength(line) + 1, 0)
      const cursor = decodeCursor(String(first['next-cursor']), 'S6-13 step 1 cursor')
      expect(lines.length).toBe(14)
      expect(cursor.offset).toBe(windowBytes)
      expect(cursor.size).toBe(windowBytes)
      expect(cursor.latestTimestamp).toBe(1789493088)
      const second = JSON.parse((await stepGolden('S6-13-logs-enabled', 'downstream-2.md')).body) as Record<string, unknown>
      const secondCursor = decodeCursor(String(second['next-cursor']), 'S6-13 step 2 cursor')
      const ginLine = (second['lines'] as string[])[0] ?? ''
      expect(secondCursor.offset).toBe(windowBytes + byteLength(ginLine) + 1)
      expect(secondCursor.size).toBe(windowBytes + byteLength(ginLine) + 1)
      logEntryFromLine(ginLine, 'S6-13 step 2 access line')
      for (const line of lines) logEntryFromLine(line, 'S6-13 seeded startup line')
    }

    // §3.7.3: model-list goldens carry the alias -> owned_by mapping.
    {
      const expectedMapping: ReadonlyArray<readonly [string, string]> = [
        ['cm', 'anthropic'], ['cx', 'openai'], ['gm', 'google'], ['im', 'google'],
        ['mm', 'meta'], ['mock-model', 'mock-openai'], ['vm', 'google'], ['xg', 'xai'],
      ]
      const first = JSON.parse((await stepGolden('S6-14-models-created-epoch', 'downstream.md')).body) as {
        readonly data: ReadonlyArray<Record<string, unknown>>
      }
      expect([...first.data].map((entry) => [entry['id'], entry['owned_by']] as const).sort()).toEqual(
        [...expectedMapping].sort(),
      )
      const reloaded = JSON.parse((await stepGolden('S6-15-hot-reload-provider', 'downstream-3.md')).body) as {
        readonly data: ReadonlyArray<Record<string, unknown>>
      }
      expect(reloaded.data.length, 'S6-15: hot provider appears without restart').toBe(9)
      expect(reloaded.data.some((entry) => entry['id'] === 'hot-model' && entry['owned_by'] === 'mock-hot')).toBe(true)
    }

    // RESP golden frame shapes per connection.
    {
      const expectations: ReadonlyArray<readonly [CaseId, number]> = [
        ['S6-07-usage-resp-protocol', 4],
        ['S6-08-usage-subscribe-stream', 1],
        ['S6-09-errors-subscribe-stream', 1],
      ]
      for (const [caseId, conns] of expectations) {
        const server = parseRespTranscript(await readFixtureText(caseId, 'downstream.md'), `${caseId} downstream.md`)
        expect(server.length, `${caseId}: recorded connections`).toBe(conns)
      }
    }
  })
})


// ─── Replay suite (17 golden cases) ─────────────────────────────────────────────────

function requireOps(
  harness: CaseHarness,
  ctx: { skip: () => void },
  ops: ReadonlyArray<keyof StateApi>,
): StateApi {
  const missing = ops.filter((op) => typeof harness.api[op] !== 'function')
  if (missing.length > 0) {
    ctx.skip()
    throw new Error(`the adapter lacks the S6 state operations: ${missing.join(', ')}`)
  }
  return harness.api
}

/** Drives one recorded RESP connection command-by-command (live frames taken between sends). */
class RespDriver {
  private spans: readonly Uint8Array[]
  private cursor = 0
  readonly output: Uint8Array[] = []
  constructor(readonly conn: UsageWireConnection, clientBytes: Uint8Array, context: string) {
    this.spans = splitRespCommands(clientBytes, context)
  }
  get remaining(): number {
    return this.spans.length - this.cursor
  }
  async sendNext(): Promise<void> {
    const span = this.spans[this.cursor]
    if (span === undefined) throw new Error('no client command left to send')
    this.cursor += 1
    await this.conn.send(span)
    this.output.push(this.conn.takeOutput())
  }
  takeLive(): void {
    this.output.push(this.conn.takeOutput())
  }
}

async function respConn(
  caseId: CaseId,
  clientTranscript: readonly RespConnTranscript[],
  serverTranscript: readonly RespConnTranscript[],
  connIndex: number,
): Promise<{ readonly client: Uint8Array; readonly server: Uint8Array }> {
  const client = clientTranscript.find((conn) => conn.index === connIndex)
  const server = serverTranscript.find((conn) => conn.index === connIndex)
  if (client === undefined || server === undefined) {
    throw new Error(`S6[${caseId}]: conn ${connIndex} transcript missing`)
  }
  return { client: encoder.encode(client.literal), server: encoder.encode(server.literal) }
}

async function respTranscripts(caseId: CaseId): Promise<{
  readonly client: readonly RespConnTranscript[]
  readonly server: readonly RespConnTranscript[]
}> {
  const client = parseRespTranscript(await readFixtureText(caseId, 'request.http'), `${caseId} request.http`)
  const server = parseRespTranscript(await readFixtureText(caseId, 'downstream.md'), `${caseId} downstream.md`)
  return { client, server }
}

async function maskFor(caseId: CaseId): Promise<MaskProfile> {
  const meta = await readFixtureJson<CaseMeta>(caseId, 'meta.yaml')
  return maskProfile(caseId, meta.dynamic_fields)
}

/** The S6-10/11 hook: the credential-manager auth-index derivation is not S6 contract. */
async function deriveAuthIndexFromGolden(): Promise<
  (input: { readonly fileName: string; readonly document: JsonValue }) => string
> {
  const listing = JSON.parse(
    (await stepGolden('S6-10-authfile-upload-list-delete', 'downstream-3.md')).body,
  ) as { readonly files: ReadonlyArray<{ readonly auth_index?: unknown }> }
  const authIndex = listing.files[0]?.auth_index
  if (typeof authIndex !== 'string' || authIndex === '') {
    throw new Error('S6-10: golden listing lacks the uploaded credential auth_index')
  }
  return () => authIndex
}

baseSuite(suiteTitle, () => {
  // ── B1: effective-config JSON view ──────────────────────────────────────────────
  it('S6-01-config-get — effective-config view: 47-key set, sanitized values, json:"-" omissions', async (ctx) => {
    const mask = await maskFor('S6-01-config-get')
    const harness = await createCaseHarness('S6-01-config-get', { clock: new FrozenClock(CLOCK_BASE_MS) })
    requireOps(harness, ctx, ['handle'])
    await replayStep('S6-01-config-get', harness.api, 'request.http', 'downstream.md', mask)
  })

  // ── B21/R-BCRYPT: in-place secret-key mutation at load ─────────────────────────
  it('S6-02-secret-bcrypt-mutation — plaintext secret-key bcrypt-hashed into config.yaml in place; plaintext still accepted', async (ctx) => {
    const mask = await maskFor('S6-02-secret-bcrypt-mutation')
    const harness = await createCaseHarness('S6-02-secret-bcrypt-mutation', { clock: new FrozenClock(CLOCK_BASE_MS) })
    const api = requireOps(harness, ctx, ['handle', 'readConfigFile'])
    // Steps 1-3 of the recording are the disk before/after captures.
    const persisted = await api.readConfigFile()
    const goldenAfter = await readFixtureText('S6-02-secret-bcrypt-mutation', 'disk/CLIProxyAPI/config.yaml.after-boot')
    expect(persisted.match(SECRET_KEY_BCRYPT_RE), 'the write-back produces a $2a$10$ + 53-char bcrypt hash').not.toBeNull()
    expect(normalizeBody(persisted, mask), 'config.yaml after boot (surgical write-back: only the secret-key line and one blank line differ)').toBe(
      normalizeBody(goldenAfter, mask),
    )
    // Step 4: the plaintext remains the accepted management key.
    await replayStep('S6-02-secret-bcrypt-mutation', api, 'request-4.http', 'downstream.md', mask)
  })

  // ── B2/B3: config.yaml round-trip ladders ───────────────────────────────────────
  it('S6-03-config-yaml-roundtrip — GET/PUT config.yaml, 400 invalid_yaml, 422 invalid_config, changed-ok shape', async (ctx) => {
    const mask = await maskFor('S6-03-config-yaml-roundtrip')
    const harness = await createCaseHarness('S6-03-config-yaml-roundtrip', { clock: new FrozenClock(CLOCK_BASE_MS) })
    const api = requireOps(harness, ctx, ['handle', 'readConfigFile'])
    await replayStep('S6-03-config-yaml-roundtrip', api, 'request.http', 'downstream.md', mask)
    // Step 2: full-file PUT is accepted and persisted byte-identically.
    const put = await stepRequest('S6-03-config-yaml-roundtrip', 'request-2.http')
    const putResponse = await api.handle(buildRequest(put))
    await assertResponseStep('S6-03-config-yaml-roundtrip', 'request-2.http', putResponse, await stepGolden('S6-03-config-yaml-roundtrip', 'downstream-2.md'), mask)
    const persisted = await api.readConfigFile()
    const goldenAfter = await stepGolden('S6-03-config-yaml-roundtrip', 'downstream-5.md')
    expect(normalizeBody(persisted, mask), 'PUT persists the file byte-identically').toBe(normalizeBody(goldenAfter.body, mask))
    // Step 3: unparsable YAML -> 400 invalid_yaml (code pinned, message masked).
    const badYaml = await stepRequest('S6-03-config-yaml-roundtrip', 'request-3.http')
    await assertConfigErrorStep('S6-03-config-yaml-roundtrip', 'request-3.http', await api.handle(buildRequest(badYaml)), await stepGolden('S6-03-config-yaml-roundtrip', 'downstream-3.md'), mask, 'invalid_yaml')
    // Step 4: semantic validation -> 422 invalid_config.
    const badConfig = await stepRequest('S6-03-config-yaml-roundtrip', 'request-4.http')
    await assertConfigErrorStep('S6-03-config-yaml-roundtrip', 'request-4.http', await api.handle(buildRequest(badConfig)), await stepGolden('S6-03-config-yaml-roundtrip', 'downstream-4.md'), mask, 'invalid_config')
    // Step 5: failed PUTs left the file untouched.
    await replayStep('S6-03-config-yaml-roundtrip', api, 'request-5.http', 'downstream-5.md', mask)
  })

  // ── B4: scalar field toggles + persistence ─────────────────────────────────────
  it('S6-04-field-toggle-persist — scalar PUT persists to config.yaml (order preserved, new keys appended), invalid body 400', async (ctx) => {
    const mask = await maskFor('S6-04-field-toggle-persist')
    const harness = await createCaseHarness('S6-04-field-toggle-persist', { clock: new FrozenClock(CLOCK_BASE_MS) })
    const api = requireOps(harness, ctx, ['handle', 'readConfigFile'])
    await replayStep('S6-04-field-toggle-persist', api, 'request.http', 'downstream.md', mask)
    await replayStep('S6-04-field-toggle-persist', api, 'request-2.http', 'downstream-2.md', mask)
    await replayStep('S6-04-field-toggle-persist', api, 'request-3.http', 'downstream-3.md', mask)
    await replayStep('S6-04-field-toggle-persist', api, 'request-4.http', 'downstream-4.md', mask)
    await replayStep('S6-04-field-toggle-persist', api, 'request-5.http', 'downstream-5.md', mask)
    await replayStep('S6-04-field-toggle-persist', api, 'request-6.http', 'downstream-6.md', mask)
    await replayStep('S6-04-field-toggle-persist', api, 'request-7.http', 'downstream-7.md', mask)
    await replayStep('S6-04-field-toggle-persist', api, 'request-8.http', 'downstream-8.md', mask)
    const persisted = await api.readConfigFile()
    const afterCleanup = await readFixtureText('S6-04-field-toggle-persist', 'disk/CLIProxyAPI/config.yaml.after-cleanup')
    expect(
      normalizeBody(persisted, mask),
      'config.yaml after the toggle ladder (key order preserved; logs-max-total-size-mb: 0 appended)',
    ).toBe(normalizeBody(afterCleanup, mask))
  })

  // ── B5/§3.5.1: usage record production + destructive pop ──────────────────────
  it('S6-05-usage-queue-record — full record schema enqueue, destructive pop (second pop is empty)', async (ctx) => {
    const mask = await maskFor('S6-05-usage-queue-record')
    const harness = await createCaseHarness('S6-05-usage-queue-record', { clock: new FrozenClock(CLOCK_BASE_MS) })
    const api = requireOps(harness, ctx, ['handle', 'recordUsage'])
    const golden = JSON.parse((await stepGolden('S6-05-usage-queue-record', 'downstream-2.md')).body) as unknown[]
    const record = golden[0] as Record<string, unknown> | undefined
    if (record === undefined) throw new Error('S6-05: golden pop response must carry one record')
    await api.recordUsage(usageCompletionFromRecord(record, 'S6-05 golden record'))
    await replayStep('S6-05-usage-queue-record', api, 'request-2.http', 'downstream-2.md', mask)
    await replayStep('S6-05-usage-queue-record', api, 'request-3.http', 'downstream-3.md', mask)
  })

  // ── B5: count validation ───────────────────────────────────────────────────────
  it('S6-06-usage-queue-errors — count=0/-1/abc 400 "count must be a positive integer"; absent count pops 1 ([] when empty)', async (ctx) => {
    const mask = await maskFor('S6-06-usage-queue-errors')
    const harness = await createCaseHarness('S6-06-usage-queue-errors', { clock: new FrozenClock(CLOCK_BASE_MS) })
    const api = requireOps(harness, ctx, ['handle'])
    await replayStep('S6-06-usage-queue-errors', api, 'request.http', 'downstream.md', mask)
    await replayStep('S6-06-usage-queue-errors', api, 'request-2.http', 'downstream-2.md', mask)
    await replayStep('S6-06-usage-queue-errors', api, 'request-3.http', 'downstream-3.md', mask)
    await replayStep('S6-06-usage-queue-errors', api, 'request-4.http', 'downstream-4.md', mask)
  })

  // ── B18/§4: RESP command surface ───────────────────────────────────────────────
  it('S6-07-usage-resp-protocol — NOAUTH, $12 protocol error vs $13 invalid key, LPOP/RPOP frames, errors channel, QUIT state machine', async (ctx) => {
    const mask = await maskFor('S6-07-usage-resp-protocol')
    const harness = await createCaseHarness('S6-07-usage-resp-protocol', { clock: new FrozenClock(CLOCK_BASE_MS) })
    const api = requireOps(harness, ctx, ['recordUsage', 'openUsageWire'])
    const transcripts = await respTranscripts('S6-07-usage-resp-protocol')
    // Seeds: the two chat completions whose records conn 3 pops (oldest first).
    const conn3Golden = transcripts.server.find((conn) => conn.index === 3)
    if (conn3Golden === undefined) throw new Error('S6-07: conn 3 golden missing')
    const conn3Frames = parseRespFrames(encoder.encode(conn3Golden.literal), 'S6-07 conn 3 golden')
    const poppedArray = conn3Frames.find((frame) => frame.kind === 'array' && frame.count === 2)
    if (poppedArray === undefined || poppedArray.kind !== 'array') throw new Error('S6-07: counted LPOP reply missing')
    for (const item of poppedArray.items) {
      if (item.kind !== 'bulk' || item.value === null) throw new Error('S6-07: popped record missing')
      await api.recordUsage(usageCompletionFromRecord(JSON.parse(item.value) as Record<string, unknown>, 'S6-07 popped record'))
    }
    // conn 1: unauthenticated LPOP -> -NOAUTH (connection stays usable).
    {
      const { client, server } = await respConn('S6-07-usage-resp-protocol', transcripts.client, transcripts.server, 1)
      const driver = new RespDriver(api.openUsageWire(), client, 'S6-07 conn 1')
      await driver.sendNext()
      assertRespFrames('S6-07-usage-resp-protocol', 'conn 1', driver.output, server, mask)
      expect(driver.conn.serverClosed(), 'conn 1 stays open after NOAUTH').toBe(false)
      driver.conn.close()
    }
    // conn 2: AUTH declaring $12 for a 13-byte payload -> -ERR protocol error.
    {
      const { client, server } = await respConn('S6-07-usage-resp-protocol', transcripts.client, transcripts.server, 2)
      const driver = new RespDriver(api.openUsageWire(), client, 'S6-07 conn 2')
      await driver.sendNext()
      assertRespFrames('S6-07-usage-resp-protocol', 'conn 2', driver.output, server, mask)
      driver.conn.close()
    }
    // conn 3: AUTH ok; LPOP 10 -> 2 records; LPOP -> $-1; RPOP 1 -> *0;
    // errors channel unsupported; FOO unknown; QUIT unknown on a non-subscribed conn.
    {
      const { client, server } = await respConn('S6-07-usage-resp-protocol', transcripts.client, transcripts.server, 3)
      const driver = new RespDriver(api.openUsageWire(), client, 'S6-07 conn 3')
      expect(driver.remaining, 'S6-07 conn 3: seven recorded commands').toBe(7)
      while (driver.remaining > 0) await driver.sendNext()
      assertRespFrames('S6-07-usage-resp-protocol', 'conn 3', driver.output, server, mask)
      expect(driver.conn.serverClosed(), 'conn 3 stays open (QUIT is unknown on non-subscribed connections)').toBe(false)
      driver.conn.close()
    }
    // conn 4: corrected $13 frame, wrong key -> -ERR invalid management key.
    {
      const { client, server } = await respConn('S6-07-usage-resp-protocol', transcripts.client, transcripts.server, 4)
      const driver = new RespDriver(api.openUsageWire(), client, 'S6-07 conn 4')
      await driver.sendNext()
      assertRespFrames('S6-07-usage-resp-protocol', 'conn 4', driver.output, server, mask)
      driver.conn.close()
    }
  })

  // ── B18/§3.5.3: subscribe stream + live-subscriber precedence ──────────────────
  it('S6-08-usage-subscribe-stream — SUBSCRIBE ack + {"support_refresh":true}, live message, PING $-1/$5, UNSUBSCRIBE close, queue stays empty', async (ctx) => {
    const mask = await maskFor('S6-08-usage-subscribe-stream')
    const harness = await createCaseHarness('S6-08-usage-subscribe-stream', { clock: new FrozenClock(CLOCK_BASE_MS) })
    const api = requireOps(harness, ctx, ['handle', 'recordUsage', 'openUsageWire'])
    const transcripts = await respTranscripts('S6-08-usage-subscribe-stream')
    const { client, server } = await respConn('S6-08-usage-subscribe-stream', transcripts.client, transcripts.server, 1)
    const goldenFrames = parseRespFrames(server, 'S6-08 conn 1 golden')
    const liveRecordFrame = goldenFrames.find(
      (frame) => frame.kind === 'array' && frame.items[0]?.kind === 'bulk' && frame.items[0].value === 'message' && frame.items[2]?.kind === 'bulk' && (frame.items[2].value ?? '').startsWith('{"timestamp"'),
    )
    if (liveRecordFrame === undefined || liveRecordFrame.kind !== 'array') {
      throw new Error('S6-08: live usage message frame missing from the golden')
    }
    const liveRecordBulk = liveRecordFrame.items[2]
    if (liveRecordBulk === undefined || liveRecordBulk.kind !== 'bulk' || liveRecordBulk.value === null) {
      throw new Error('S6-08: live usage payload missing')
    }
    const driver = new RespDriver(api.openUsageWire(), client, 'S6-08 conn 1')
    await driver.sendNext() // AUTH -> +OK
    await driver.sendNext() // SUBSCRIBE usage -> ack + initial {"support_refresh":true}
    await api.recordUsage(usageCompletionFromRecord(JSON.parse(liveRecordBulk.value) as Record<string, unknown>, 'S6-08 live record'))
    driver.takeLive() // live message delivered to the attached subscriber
    await driver.sendNext() // PING -> *2 pong $-1
    await driver.sendNext() // PING hello -> *2 pong $5 hello
    // step h7: the record went to the subscriber, NOT the queue (§3.5.3).
    await replayStep('S6-08-usage-subscribe-stream', api, 'request-h7.http', 'request-h7.down.md', mask)
    await driver.sendNext() // UNSUBSCRIBE usage -> ack + close
    assertRespFrames('S6-08-usage-subscribe-stream', 'conn 1', driver.output, server, mask)
    expect(driver.conn.serverClosed(), 'UNSUBSCRIBE closes the connection after the ack').toBe(true)
  })

  // ── B18/§3.5.2: errors channel ─────────────────────────────────────────────────
  it('S6-09-errors-subscribe-stream — SUBSCRIBE errors acks with NO initial payload; live error event; QUIT closes', async (ctx) => {
    const mask = await maskFor('S6-09-errors-subscribe-stream')
    const harness = await createCaseHarness('S6-09-errors-subscribe-stream', { clock: new FrozenClock(CLOCK_BASE_MS) })
    const api = requireOps(harness, ctx, ['publishError', 'openUsageWire'])
    const transcripts = await respTranscripts('S6-09-errors-subscribe-stream')
    const { client, server } = await respConn('S6-09-errors-subscribe-stream', transcripts.client, transcripts.server, 1)
    const goldenFrames = parseRespFrames(server, 'S6-09 conn 1 golden')
    const eventFrame = goldenFrames.find(
      (frame) => frame.kind === 'array' && frame.items[0]?.kind === 'bulk' && frame.items[0].value === 'message',
    )
    if (eventFrame === undefined || eventFrame.kind !== 'array') throw new Error('S6-09: event frame missing')
    const eventBulk = eventFrame.items[2]
    if (eventBulk === undefined || eventBulk.kind !== 'bulk' || eventBulk.value === null) {
      throw new Error('S6-09: event payload missing')
    }
    const driver = new RespDriver(api.openUsageWire(), client, 'S6-09 conn 1')
    await driver.sendNext() // AUTH -> +OK
    await driver.sendNext() // SUBSCRIBE errors -> ack ONLY (no initial payload)
    await api.publishError(errorEventFromGolden(JSON.parse(eventBulk.value) as Record<string, unknown>, 'S6-09 golden event'))
    driver.takeLive() // live error event (verbatim upstream body, timestamp masked)
    await driver.sendNext() // QUIT on a subscribed connection -> +OK, close
    assertRespFrames('S6-09-errors-subscribe-stream', 'conn 1', driver.output, server, mask)
    expect(driver.conn.serverClosed(), 'QUIT closes a subscribed connection').toBe(true)
  })

  // ── B12-B15: auth-file CRUD + re-serialization ─────────────────────────────────
  it('S6-10-authfile-upload-list-delete — upload re-serialization (single-line, alphabetical, disabled:false), listing entry, download, 400s, delete', async (ctx) => {
    const mask = await maskFor('S6-10-authfile-upload-list-delete')
    const harness = await createCaseHarness('S6-10-authfile-upload-list-delete', {
      clock: new FrozenClock(CLOCK_BASE_MS),
      deriveAuthIndex: await deriveAuthIndexFromGolden(),
    })
    const api = requireOps(harness, ctx, ['handle'])
    await replayStep('S6-10-authfile-upload-list-delete', api, 'request.http', 'downstream.md', mask)
    await replayStep('S6-10-authfile-upload-list-delete', api, 'request-3.http', 'downstream-3.md', mask)
    await replayStep('S6-10-authfile-upload-list-delete', api, 'request-4.http', 'downstream-4.md', mask)
    await replayStep('S6-10-authfile-upload-list-delete', api, 'request-5.http', 'downstream-5.md', mask)
    await replayStep('S6-10-authfile-upload-list-delete', api, 'request-6.http', 'downstream-6.md', mask)
    await replayStep('S6-10-authfile-upload-list-delete', api, 'request-7.http', 'downstream-7.md', mask)
    await replayStep('S6-10-authfile-upload-list-delete', api, 'request-8.http', 'downstream-8.md', mask)
    await replayStep('S6-10-authfile-upload-list-delete', api, 'request-9.http', 'downstream-9.md', mask)
    // The re-serialized bytes on disk are the download bytes (upload_body_equals_disk: false).
    const download = await stepGolden('S6-10-authfile-upload-list-delete', 'downstream-4.md')
    const diskBytes = await readFixtureText('S6-10-authfile-upload-list-delete', 'disk/root/.cli-proxy-api/s6-test-claude.json')
    expect(download.body).toBe(diskBytes)
    const listing = await readFixtureText('S6-10-authfile-upload-list-delete', 'disk/root/.cli-proxy-api/.listing-after-delete.txt')
    expect(listing.trim(), 'the auth dir is empty after delete').toBe('(empty)')
  })

  // ── B17: PATCH fields ladder ───────────────────────────────────────────────────
  it('S6-11-authfile-patch-fields — typed merge (priority/note/weight/request_retry), validation 400s, persisted bytes', async (ctx) => {
    const mask = await maskFor('S6-11-authfile-patch-fields')
    const harness = await createCaseHarness('S6-11-authfile-patch-fields', {
      clock: new FrozenClock(CLOCK_BASE_MS),
      deriveAuthIndex: await deriveAuthIndexFromGolden(),
    })
    const api = requireOps(harness, ctx, ['handle'])
    const ladder: ReadonlyArray<readonly [string, string]> = [
      ['request.http', 'downstream.md'],
      ['request-2.http', 'downstream-2.md'],
      ['request-3.http', 'downstream-3.md'],
      ['request-4.http', 'downstream-4.md'],
      ['request-5.http', 'downstream-5.md'],
      ['request-6.http', 'downstream-6.md'],
      ['request-7.http', 'downstream-7.md'],
      ['request-8.http', 'downstream-8.md'],
      ['request-9.http', 'downstream-9.md'],
      ['request-10.http', 'downstream-10.md'],
      ['request-11.http', 'downstream-11.md'],
      ['request-12.http', 'downstream-12.md'],
    ]
    for (const [requestFile, goldenFile] of ladder) {
      await replayStep('S6-11-authfile-patch-fields', api, requestFile, goldenFile, mask)
    }
    const afterMerge = await stepGolden('S6-11-authfile-patch-fields', 'downstream-3.md')
    expect(afterMerge.body, 'merged file bytes on disk (step 3 download)').toBe(
      await readFixtureText('S6-11-authfile-patch-fields', 'disk/root/.cli-proxy-api/s6-test-claude.json.after-merge'),
    )
    const afterRetry = await stepGolden('S6-11-authfile-patch-fields', 'downstream-11.md')
    expect(afterRetry.body, 'request_retry-persisted bytes (step 11 download)').toBe(
      await readFixtureText('S6-11-authfile-patch-fields', 'disk/root/.cli-proxy-api/s6-test-claude.json.after-retry'),
    )
  })

  // ── B7/B8/B9: logs disabled ────────────────────────────────────────────────────
  it('S6-12-logs-disabled — logs endpoints 400 "logging to file disabled"; request-error-logs [] shape', async (ctx) => {
    const mask = await maskFor('S6-12-logs-disabled')
    const harness = await createCaseHarness('S6-12-logs-disabled', { clock: new FrozenClock(CLOCK_BASE_MS) })
    const api = requireOps(harness, ctx, ['handle'])
    await replayStep('S6-12-logs-disabled', api, 'request.http', 'downstream.md', mask)
    await replayStep('S6-12-logs-disabled', api, 'request-2.http', 'downstream-2.md', mask)
    await replayStep('S6-12-logs-disabled', api, 'request-3.http', 'downstream-3.md', mask)
    await replayStep('S6-12-logs-disabled', api, 'request-4.http', 'downstream-4.md', mask)
  })

  // ── B7/B8/§3.6.2: logs enabled ─────────────────────────────────────────────────
  it('S6-13-logs-enabled — tail reads, limit validation, alphabetical clear body, cursor mechanics on the seeded window', async (ctx) => {
    const mask = await maskFor('S6-13-logs-enabled')
    const firstGolden = await stepGolden('S6-13-logs-enabled', 'downstream.md')
    const firstParsed = JSON.parse(firstGolden.body) as { readonly lines: string[] }
    const seededLines = firstParsed.lines
    const windowBytes = seededLines.reduce((sum, line) => sum + byteLength(line) + 1, 0)
    const secondGolden = await stepGolden('S6-13-logs-enabled', 'downstream-2.md')
    const ginLine = (JSON.parse(secondGolden.body) as { readonly lines: string[] }).lines[0] ?? ''
    const harness = await createCaseHarness('S6-13-logs-enabled', {
      clock: new FrozenClock(CLOCK_BASE_MS),
      initialLogLines: seededLines.map((line) => logEntryFromLine(line, 'S6-13 seeded line')),
    })
    const api = requireOps(harness, ctx, ['handle', 'appendLogLine'])
    // Step 1: full tail read of the boot window.
    {
      const request = await stepRequest('S6-13-logs-enabled', 'request.http')
      const response = await api.handle(buildRequest(request))
      await assertLogsStep('S6-13-logs-enabled', 'request.http', response, firstGolden, mask, {
        lines: seededLines,
        lineCount: seededLines.length,
        latestTimestamp: 1789493088,
        windowBytes,
      })
    }
    // The step-1 management request itself is access-logged (transport gin logger).
    await api.appendLogLine(logEntryFromLine(ginLine, 'S6-13 access line'))
    // Step 2: limit=1 tails exactly the last line.
    {
      const request = await stepRequest('S6-13-logs-enabled', 'request-2.http')
      const response = await api.handle(buildRequest(request))
      await assertLogsStep('S6-13-logs-enabled', 'request-2.http', response, secondGolden, mask, {
        lines: [ginLine],
        lineCount: 1,
        latestTimestamp: 1789493088,
        windowBytes: windowBytes + byteLength(ginLine) + 1,
      })
    }
    // Step 3: unparsable limit -> 400 (exact error body).
    await replayStep('S6-13-logs-enabled', api, 'request-3.http', 'downstream-3.md', mask)
    // Step 4: DELETE -> alphabetical {"message","removed","success"} body, removed 0.
    await replayStep('S6-13-logs-enabled', api, 'request-4.http', 'downstream-4.md', mask)
    // Step 5: post-clear read: 200, shape pinned, content is a truncate artifact (masked).
    {
      const request = await stepRequest('S6-13-logs-enabled', 'request-5.http')
      const golden = await stepGolden('S6-13-logs-enabled', 'downstream-5.md')
      const response = await api.handle(buildRequest(request))
      await assertLogsStep('S6-13-logs-enabled', 'request-5.http', response, golden, mask, { artifact: true })
    }
  })

  // ── B26/§3.7.3: models created = server epoch ──────────────────────────────────
  it('S6-14-models-created-epoch — configured models as {id,object,created,owned_by} with created = floor(now()/1000)', async (ctx) => {
    const mask = await maskFor('S6-14-models-created-epoch')
    const harness = await createCaseHarness('S6-14-models-created-epoch', { clock: new FrozenClock(CLOCK_BASE_MS) })
    const api = requireOps(harness, ctx, ['buildModelList'])
    const golden = await stepGolden('S6-14-models-created-epoch', 'downstream.md')
    await assertModelList('S6-14-models-created-epoch', 'model list', await api.buildModelList(), golden.body, mask, Math.floor(CLOCK_BASE_MS / 1000))
  })

  // ── B22/§3.3.4/§3.7.3: hot reload model bump ─────────────────────────────────
  it('S6-15-hot-reload-provider — config edit live-applies: new provider appears, every created re-stamped, reload log line emitted', async (ctx) => {
    const mask = await maskFor('S6-15-hot-reload-provider')
    const clock = new FrozenClock(CLOCK_BASE_MS)
    const harness = await createCaseHarness('S6-15-hot-reload-provider', { clock })
    const api = requireOps(harness, ctx, ['buildModelList', 'replaceConfigFile', 'readLogRing'])
    const firstGolden = await stepGolden('S6-15-hot-reload-provider', 'downstream.md')
    await assertModelList('S6-15-hot-reload-provider', 'step 1 model list', await api.buildModelList(), firstGolden.body, mask, Math.floor(clock.now() / 1000))
    // Step 2: the operator's file edit (docker cp in the recording) = the watcher input.
    const afterEdit = await readFixtureText('S6-15-hot-reload-provider', 'disk/CLIProxyAPI/config.yaml.after-edit')
    await api.replaceConfigFile(afterEdit)
    // §3.3.4: the reload emits its log line (ring `logs`); format §3.6.3, message pinned.
    const ring = await api.readLogRing()
    const reloadedLine = ring.find((entry) => entry.line.includes('config successfully reloaded, triggering client reload'))
    expect(reloadedLine, 'the reload emits the §3.3.4 log line into ring `logs`').toBeDefined()
    if (reloadedLine !== undefined) {
      expect(reloadedLine.line, 'the reload line follows the §3.6.3 format (internal file:line masked)').toMatch(
        /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] \[[^\]]*\] \[\w+ ?\] \[[^\]]+\] /,
      )
    }
    // Step 3: one second later the whole list re-synthesized (all created re-stamped).
    clock.advance(1_000)
    const thirdGolden = await stepGolden('S6-15-hot-reload-provider', 'downstream-3.md')
    await assertModelList('S6-15-hot-reload-provider', 'step 3 model list', await api.buildModelList(), thirdGolden.body, mask, Math.floor(clock.now() / 1000))
  })

  // ── B24/§3.4.4: cooldown sidecar + restart persistence ────────────────────────
  it('S6-16-cds-cooldown — .cds sidecar bytes + name, restored cooldown survives restart, listing shows no auth files', async (ctx) => {
    const mask = await maskFor('S6-16-cds-cooldown')
    // The S6-16 listing golden carries observed_at although the meta list omits it
    // (fixture-list gap, S6-10/S5 precedent) — mask it for this case as well.
    const maskWithObservedAt: MaskProfile = { ...mask, observedAt: true }
    const clock = new FrozenClock(CLOCK_BASE_MS)
    const harness = await createCaseHarness('S6-16-cds-cooldown', { clock })
    const api = requireOps(harness, ctx, ['handle', 'recordCooldown', 'listCooldownSidecars', 'isCooling'])
    const sidecarName = 'openai-compatibility_mock-openai_484455246a84.cds'
    const goldenSidecarText = await readFixtureText(
      'S6-16-cds-cooldown',
      `disk/root/.cli-proxy-api/${sidecarName}`,
    )
    const goldenSidecar = JSON.parse(goldenSidecarText) as Record<string, unknown>
    const authId = readString(goldenSidecar, 'auth_id', 'S6-16 golden sidecar')
    // Recording steps 2/4 (the failing request + the during-cooldown 503): the
    // executor/scheduler surfaces are S2d/S4 scope; S6 pins the persisted state.
    const inputs = cooldownInputsFromSidecar(goldenSidecar, clock, 'S6-16 golden sidecar')
    for (const input of inputs) await api.recordCooldown(input)
    const sidecars = await api.listCooldownSidecars()
    expect(sidecars.length, 'one sidecar per auth, written into the auth dir').toBe(1)
    const sidecar = sidecars[0]
    if (sidecar === undefined) throw new Error('S6-16: sidecar missing')
    expect(sidecar.name, 'sidecar file name: auth id with : -> _ plus .cds').toBe(sidecarName)
    expect(sidecar.authId).toBe(authId)
    const producedSidecar = JSON.parse(sidecar.content) as Record<string, unknown>
    expect(normalizeBody(sidecar.content, maskWithObservedAt), 'sidecar bytes (2-space indent, §3.4.4 field order, zero-quota block)').toBe(
      normalizeBody(goldenSidecarText, maskWithObservedAt),
    )
    const producedRecords = producedSidecar['records'] as ReadonlyArray<Record<string, unknown>>
    expect(producedRecords.length).toBe(inputs.length)
    for (let index = 0; index < inputs.length; index += 1) {
      const input = inputs[index]
      const record = producedRecords[inputs.length - 1 - index]
      if (record === undefined) throw new Error('S6-16: sidecar record missing')
      expect(record['next_retry_after'], 'the scheduler value persists verbatim').toBe(input.nextRetryAfter)
      expect(record['model'] ?? undefined).toBe(input.model)
    }
    expect(await api.isCooling(authId), 'the credential-level cooldown is active (feeds the 503 decision)').toBe(true)
    expect(await api.isCooling(authId, 'mock-model'), 'the per-model cooldown is active').toBe(true)
    // Step 6: the listing shows no auth files (config credentials are not files; the
    // sidecar is not an auth file).
    await replayStep('S6-16-cds-cooldown', api, 'request-6.http', 'downstream-6.md', maskWithObservedAt)
    // Step 8: docker restart — a fresh adapter over the SAME Store restores the state.
    const restarted = await createCaseHarness('S6-16-cds-cooldown', { clock, store: harness.store })
    const restartedApi = requireOps(restarted, ctx, ['recordCooldown', 'listCooldownSidecars', 'isCooling'])
    const restored = await restartedApi.listCooldownSidecars()
    expect(restored.map((entry) => entry.name)).toEqual([sidecarName])
    expect(normalizeBody(restored[0]?.content ?? '', maskWithObservedAt), 'the sidecar survives the restart byte-identically').toBe(
      normalizeBody(goldenSidecarText, maskWithObservedAt),
    )
    expect(await restartedApi.isCooling(authId, 'mock-model'), 'the cooldown is restored after restart (recorded: still 503)').toBe(true)
    const listing = await readFixtureText('S6-16-cds-cooldown', 'disk/root/.cli-proxy-api/.listing-after-restart.txt')
    expect(listing.split('\n').map((line) => line.trim()).filter((line) => line !== '')).toContain(sidecarName)
  })

  // ── §3.5.1: failed-request usage record ───────────────────────────────────────
  it('S6-18-failed-usage-record — failed completion enqueues failed:true, zeroed tokens, fail{status_code:500, body:verbatim}', async (ctx) => {
    const mask = await maskFor('S6-18-failed-usage-record')
    const harness = await createCaseHarness('S6-18-failed-usage-record', { clock: new FrozenClock(CLOCK_BASE_MS) })
    const api = requireOps(harness, ctx, ['handle', 'recordUsage'])
    const golden = JSON.parse((await stepGolden('S6-18-failed-usage-record', 'downstream-2.md')).body) as unknown[]
    const record = golden[0] as Record<string, unknown> | undefined
    if (record === undefined) throw new Error('S6-18: golden pop response must carry one record')
    await api.recordUsage(usageCompletionFromRecord(record, 'S6-18 golden record'))
    await replayStep('S6-18-failed-usage-record', api, 'request-2.http', 'downstream-2.md', mask)
  })
})
