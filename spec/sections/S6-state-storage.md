# S6 — State & storage (config schema, auth-file schema, usage queue, log ring, model-list cache, hot reload)

Section id: S6 · Owner: @spec-writer (spec-s6-state) · Upstream anchor: CLIProxyAPI v7.3.4, commit `8335eac731946bd4eff18f500653f93736df53d6` (all evidence paths below are relative to `_cpa_edge_ref/CLIProxyAPI/`).

Every "MUST" below is contract-testable. Behaviors marked **OPTIONAL** may be omitted by an implementation without failing S6 gate. CREDENTIALED-ONLY behaviors (real OAuth token issuance) are marked **FIXTURE-DEFERRED** and specified from upstream source only.

---

## 0. Store mapping — every document onto the P0.2 `Store` abstraction

All persistent state crosses the `Store` interface from `@cpa-edge/core` (`packages/core/src/store.ts`). No shared mutable globals (Iron Rule 4). Stored shapes are **type aliases** (not interfaces) so they satisfy `isJsonValue`'s index-signature check.

| State | Store family | Name / key | Stored shape (type alias) | Update pattern |
|---|---|---|---|---|
| Effective config | document | namespace `config`, key `effective` | `ConfigDocument` (§3.1) | `update()` transaction callback — mgmt mutations read-modify-write atomically; reload replaces wholesale via `put()` |
| Raw config file bytes | NOT in Store | file `config.yaml` owned by the runtime adapter | — | runtimes/node keeps a file adapter; core only sees `ConfigDocument` |
| Auth file (one per credential) | document | namespace `auth`, key = auth-file name (e.g. `claude-test@example.com.json`) | `AuthFileDocument` (§3.4) | `update()` callback for PATCH-fields; `put()` for upload/replace; `delete()` for removal |
| Cooldown sidecar | document | namespace `cooldown`, key = `<authfile-base>.cds`-equivalent (auth file base name) | `CooldownStateDocument` (§3.4.4) | `update()` callback; written only when `save-cooldown-status: true` |
| Usage records | queue | queue name `usage` | `UsageRecord` (§3.5.1) as payload | `enqueue()` on request completion; consumer `claim(leaseMs)` + `ack()`; **retention is enforced by the consumer** (§3.5.3) |
| Error events | ring | ring name `errors` | `ErrorEventDocument` (§3.5.2) | `ringAppend(ring, entry, capacity)` — observability window only; the RESP channel still delivers live events only (no replay) |
| Application log window | ring | ring name `logs` | `LogRingEntry` (§3.6.3) | `ringAppend()` per emitted log line; `ringRead(ring, maxEntries)` serves GET /logs |
| Per-credential recent-request counters | document | namespace `requests`, key = `<auth_index>` | `RecentRequestBuckets` = 20 × `RecentRequestBucket` (§3.6.4) | `update()` callback — bucket counters are read-modify-write increments; concurrent completions must not lose counts (document, not ring: buckets are addressed by bucket id, not append-only) |
| Model catalog cache | document | namespace `models`, keys `catalog:<name>` (`<name>` = per-provider from models.json, plus `catalog:codex-client` and `catalog:devin` for the two auxiliary catalogs) | `ModelCatalogEntry[]` (§3.7 item 1) | `put()` on catalog refresh; availability registry is derived in-memory (rebuilt at startup, not persisted — upstream parity) |
| Mgmt auth-failure counters / bans | document | namespace `mgmt`, key `attempts` | `MgmtAttemptsDocument` | `update()` callback (5 failures → 30 min ban per client IP; §3.3.3) |
| OAuth session registry | document | namespace `oauth-sessions`, key = state token (≤128 chars) | `OAuthSessionDocument` (§3.3.6) | `update()` callback for state transitions (register → pending → completed/error); **Store-backed registry is the designed divergence from upstream in-memory map** — flow semantics are S3; substrate MUSTs (Cloudflare DO alarms for poll execution, Node in-process timers) are S7 §2.3-F5b/F5c |

Rules carried from P0.2 adversary review (`reports/adversary/P0.2.md`):
- **N8 portability**: `list()` orders by UTF-16 code units, not UTF-8 bytes. Keys with astral characters can sort differently on remote stores. S6 keys MUST stay ASCII (they are: file names, `catalog:*`, fixed strings). T2 must keep this note for the Cloudflare store.
- Detachment: every document read from Store is a detached copy; mutation after write never changes stored state.
- Queue payloads are delivered at-least-once under lease takeover; usage consumers MUST be idempotent (§3.5.3).

Stored shapes as TypeScript **type aliases** (interfaces would break `isJsonValue`'s implicit-index-signature narrowing; `JsonValue`-compatible by construction):

```ts
import type { JsonValue } from '@cpa-edge/core'

/** Sanitized effective config; key names = YAML keys of §3.1 (dashed). */
export type ConfigDocument = {
  readonly [key: string]: JsonValue
}

/** One auth file: §3.4.1 common keys + per-type token fields (§3.4.2). */
export type AuthFileDocument = {
  readonly [key: string]: JsonValue
}

/** .cds envelope (§3.4.4). */
export type CooldownStateDocument = {
  readonly version: 1
  readonly auth_id?: string
  readonly provider?: string
  readonly updated_at: string
  readonly records: readonly {
    readonly auth_id: string
    readonly provider?: string
    readonly model?: string
    readonly status?: string
    readonly next_retry_after: string
    readonly reason?: string
    readonly quota?: JsonValue
    readonly last_error?: JsonValue
    readonly updated_at: string
  }[]
}

/** Usage queue payload (§3.5.1); exact JSON field names are contract. */
export type UsageRecord = {
  readonly [key: string]: JsonValue
}

/** Errors-ring entry (§3.5.2). */
export type ErrorEventDocument = {
  readonly [key: string]: JsonValue
}

/** Log ring entry (§3.6.3). */
export type LogRingEntry = {
  readonly line: string
  readonly level: string
  readonly timestamp: string
  readonly request_id: string
}

/** 20-bucket recent-request window (§3.6.4). */
export type RecentRequestBuckets = readonly {
  readonly time: string
  readonly success: number
  readonly failed: number
}[]

/** Mgmt auth failures (§3.3.3): per-IP { failures: number, banned_until?: string }. */
export type MgmtAttemptsDocument = {
  readonly [ip: string]: { readonly failures: number; readonly banned_until?: string }
}

/** OAuth session registry entry (§3.3.6; S3 flow semantics). */
export type OAuthSessionDocument = {
  readonly provider: string
  readonly status: string
  readonly source: 'builtin' | 'plugin'
  readonly metadata?: JsonValue
  readonly completed: boolean
  readonly created_at: string
  readonly expires_at: string
}

/** Model catalog cache entry (§3.7.2). */
export type ModelCatalogEntry = {
  readonly id: string
  readonly object: 'model'
  readonly created: number
  readonly owned_by: string
  readonly [key: string]: JsonValue
}
```

Upstream evidence for the abstraction boundary: upstream itself swaps storage backends behind one token-store interface — file (`sdk/auth/filestore.go`), git (`internal/store/gitstore.go`), S3-compatible object store (`internal/store/objectstore.go`), Postgres (`internal/store/postgresstore.go`) + separate cooldown store (`internal/store/postgres_cooldown_store.go`). CPA-Edge's `Store` is the single such seam.

---

## 1. Scope and boundaries

**In scope**
1. Config document schema: every key, type, default, validation, sanitization (§3.1), the effective-config JSON view (§3.2), YAML persistence + in-place bcrypt mutation of `remote-management.secret-key` (§3.3), hot-reload watcher semantics (§3.8).
2. Auth-file on-disk schema per provider type + common metadata keys + file naming + cooldown sidecar `.cds` (§3.4).
3. Usage queue semantics: production, enqueue/ack/retention, record schema, error-event schema, HTTP + RESP wire exposure (§3.5, §4).
4. Log storage: file rotation facts, ring-buffer mapping, /v0/management/logs endpoints, per-credential recent-request ring, log line format (§3.6).
5. Model-list cache + `created` = server epoch (§3.7).
6. Recordable management endpoints that read/write the above state (inventory in §2).

**Out of scope**
- Full `/v0/management` surface (S5), scheduling/cooldown policy (S4), OAuth flows and refresh (S3), translation (S2d*), platform file-system degradation matrix (S7 — but §3.6 cross-references it).
- Plugin store, Home mode (`home` runtime-only config), TUI, pprof, discovery (mDNS) — carried as config keys only.

---

## 2. Behavior inventory (recordable surface)

All management endpoints require the management key: `Authorization: Bearer <key>` OR `X-Management-Key: <key>` (upstream `internal/api/handlers/management/handler.go`, `Middleware()`). Auth gate semantics: §3.3.3. All responses carry the global CORS block and `X-CPA-VERSION`, `X-CPA-COMMIT`, `X-CPA-BUILD-DATE`, `X-CPA-SUPPORT-PLUGIN` headers (mgmt middleware sets them; recorded in `reports/oracle/BOOTSTRAP.md` §4).

| # | Behavior | Method + path | Status codes | Evidence |
|---|---|---|---|---|
| B1 | Effective config view | GET `/v0/management/config` | 200 (JSON object; 200 `{}` if config unavailable) | `management/config_basic.go` `GetConfig` |
| B2 | Raw config file | GET `/v0/management/config.yaml` | 200 raw YAML bytes (`Content-Type: application/yaml; charset=utf-8`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`); 404 `{"error":"not_found","message":"config file not found"}` | `config_basic.go` `GetConfigYAML` |
| B3 | Replace config file | PUT `/v0/management/config.yaml` (body = full YAML) | 200 `{"ok":true,"changed":["config"]}`; 400 `{"error":"invalid_yaml","message":...}`; 422 `{"error":"invalid_config","message":...}`; 500 `{"error":"write_failed"/"reload_failed",...}` | `config_basic.go` `PutConfigYAML` |
| B4 | Scalar field get/put (storage-relevant subset) | GET/PUT/PATCH `/v0/management/{debug, usage-statistics-enabled, logging-to-file, logs-max-total-size-mb, error-logs-max-files, request-log, request-retry, max-retry-credentials, max-retry-interval, ws-auth, force-model-prefix, proxy-url (GET/PUT/PATCH/DELETE)}` | GET → 200 `{"<dashed-key>": <value>}`; PUT/PATCH body `{"value": <v>}` → 200 `{"status":"ok"}` (persisted to config.yaml + hot-reloaded); invalid body → 400 `{"error":"invalid body"}` | `config_basic.go`; `handler.go` `updateBoolField/updateIntField/updateStringField`, `persistLocked` |
| B5 | Usage queue pop (HTTP) | GET `/v0/management/usage-queue?count=N` | 200 JSON array of records (destructive pop); 400 `{"error":"count must be a positive integer"}` when count invalid or ≤ 0; absent count = 1 | `management/usage.go` `GetUsageQueue`, `parseUsageQueueCount` |
| B6 | Per-key usage snapshot | GET `/v0/management/api-key-usage` | 200 nested map (§3.5.4) | `management/api_key_usage.go` |
| B7 | App logs read | GET `/v0/management/logs?cursor=&after=&limit=` | 200 `{lines, line-count, latest-timestamp, next-cursor[, cursor-reset]}`; **400 `{"error":"logging to file disabled"}` when `logging-to-file: false`**; **400 `{"error":"invalid limit: must be a positive integer"}` for an unparsable `limit`, and `{"error":"invalid limit: must be greater than zero"}` for `limit <= 0`** (recorded, S6-13 step 3); 500 on IO errors | `management/logs.go` `GetLogs`, `parseLimit` |
| B8 | App logs clear | DELETE `/v0/management/logs` | 200 `{"success":true,"message":"Logs cleared successfully","removed":<n>}`; 400 as B7; 404 `{"error":"log directory not found"}` | `logs.go` `DeleteLogs` |
| B9 | Error request-log files | GET `/v0/management/request-error-logs` | 200 `{"files":[{name,size,modified}]}` (modified desc; `[]` when `request-log: true`); 200 `{"files":[]}` when dir missing | `logs.go` `GetRequestErrorLogs` |
| B10 | Request log download | GET `/v0/management/request-log-by-id/:id` | 200 file attachment; 400 `{"error":"missing request ID"}` / `{"error":"invalid request ID"}` (id containing `/` or `\`); 404 `{"error":"log file not found for the given request ID"}` | `logs.go` `GetRequestLogByID` |
| B11 | Error log download | GET `/v0/management/request-error-logs/:name` | 200 attachment (`error-*.log` names only); 400 `{"error":"invalid file name"}` (empty name, `/` or `\` in name, wrong prefix/suffix); 404 `{"error":"log file not found"}` | `logs.go` `DownloadRequestErrorLog` |
| B12 | Auth files list | GET `/v0/management/auth-files[?name=&auth_index=]` | 200 `{"observed_at":<RFC3339 UTC>, "files":[<entry>…]}` (§3.4.5); disk fallback variant §3.4.5 | `management/auth_files.go` `ListAuthFiles` |
| B13 | Auth file download | GET `/v0/management/auth-files/download?name=<n>.json` | 200 the CURRENT on-disk file bytes (i.e. the re-serialized form of B14, not the original upload), `Content-Disposition: attachment; filename="<n>.json"`, `Content-Type: application/json`; 400 `{"error":"invalid name"}` / `{"error":"name must end with .json"}`; 404 `{"error":"file not found"}` | `auth_files_crud.go` `DownloadAuthFile` |
| B14 | Auth file upload | POST `/v0/management/auth-files` (multipart file(s), or raw body + `?name=<n>.json`) | 200 `{"status":"ok"}` (single) / `{"status":"ok","uploaded":<n>,"files":[...]}` (multi) / 207 `{"status":"partial",...}` (multi w/ failures); 400 `{"error":"file must be .json"}`, `{"error":"no files uploaded"}`, `{"error":"invalid name"}`, `{"error":"name must end with .json"}`; 500 on write errors. **Recorded reality (S6-10)**: after upload the file on disk is RE-SERIALIZED by the token store — single-line JSON, keys in Go map-marshal (alphabetical) order, `disabled` injected (`false` when absent in the upload) | `auth_files_crud.go` `UploadAuthFile`, `sdk/auth/filestore.go` `Save` |
| B15 | Auth file delete | DELETE `/v0/management/auth-files?name=<n>` / `?all=true` / repeated `name` / JSON body `{name|names}` / `[names]` | 200 `{"status":"ok"}` / `{"status":"ok","deleted":<n>[,"files":[...]]}` / 207 partial; 404 `{"error":"auth file not found"}`; 400 `{"error":"invalid name"}`; 409 `{"error":"plugin virtual auth cannot be modified directly; edit or delete the source auth file"}` | `auth_files_crud.go` `DeleteAuthFile` |
| B16 | Auth file status patch | PATCH `/v0/management/auth-files/status` | 200 `{"status":"ok"}`; 400/404 per §3.4.6 | `auth_files_fields.go` `PatchAuthFileStatus` |
| B17 | Auth file field patch | PATCH `/v0/management/auth-files/fields` | 200 `{"status":"ok"}`; 400 `{"error":"name is required"}`, `{"error":"no fields to update"}`, `{"error":"weight must be an integer"}`, `{"error":"weight must not exceed 1000000"}`, `{"error":"weight does not support nested fields"}`, `{"error":"request_retry must be an integer or null"}`, `{"error":"request_retry does not support nested fields"}`, `{"error":"invalid request body"}`; 404 `{"error":"auth file not found"}`; 409 plugin-virtual | `auth_files_fields.go` `PatchAuthFileFields` |
| B18 | Usage wire (RESP on management TCP port) | RESP `AUTH`/`SUBSCRIBE usage|errors`/`LPOP|RPOP usage [count]`/`PING`/`UNSUBSCRIBE`/`QUIT` | exact frames §4 | `internal/api/redis_queue_protocol.go` |
| B19 | Management disabled without secret | any `/v0/management/*` when `remote-management.secret-key` empty AND no `MANAGEMENT_PASSWORD` env AND no local password | **404 empty body** (routes not registered; usage queue also disabled) | `internal/api/server.go` (`hasManagementSecret`, `redisqueue.SetEnabled`) |

**Non-endpoint behaviors** (contract via fixtures or unit-level goldens):

| # | Behavior | Evidence |
|---|---|---|
| B20 | Config load pipeline: defaults → YAML unmarshal → per-key sanitization → validation; fatal errors abort startup (non-optional mode) | `internal/config/config_load.go` |
| B21 | `secret-key` bcrypt mutation: plaintext detected (not `$2a$`/`$2b$`/`$2y$` prefixed) → bcrypt-hashed (cost = bcrypt default) **and written back into config.yaml in place** (comments/order preserved) | `config_load.go`, `config_validation.go` (`looksLikeBcrypt`, `hashSecret`), `config_yaml.go` `SaveConfigPreserveCommentsUpdateNestedScalar` |
| B22 | Config hot reload: file watcher, 150 ms debounce, sha256 content gate, reload-keep-old-on-error, client reload, async persist | `internal/watcher/config_reload.go`, `watcher.go` |
| B23 | Auth dir watcher: add/modify/delete with revisions; 1 s delete debounce; 50 ms replace settle | `watcher.go` |
| B24 | `.cds` cooldown sidecar write (atomic temp+rename) when `save-cooldown-status: true` | `sdk/cliproxy/auth/cooldown_state.go` |
| B25 | Model catalog: embedded fallback + remote refresh at startup, every 3 h, 30 s timeout, changed-provider callback | `internal/registry/model_updater.go` |
| B26 | `created` field of config-defined models = server epoch at synthesis | `sdk/cliproxy/service_models.go` (`now := time.Now().Unix()` → `buildConfiguredModelInfo`) |

---

## 3. Schemas

### 3.1 Config document schema (config.yaml)

Evidence: `internal/config/config.go` (Config), `sdk_config.go` (SDKConfig inline), `config_types.go` (nested types), `config_defaults.go`, `config_load.go` (defaults + normalization), `config_normalization.go` (sanitizers), `config.example.yaml`. YAML key names are public interface (compat) and MUST match exactly. `ConfigDocument` (Store alias) is the sanitized effective config as JSON.

Defaults marked "(zero-value)" are not set explicitly upstream; an absent key behaves as the zero value of the type.

#### 3.1.1 Server block

| Key | Type | Default | Validation / normalization |
|---|---|---|---|
| `host` | string | `""` (bind all interfaces) | none (runtime bind) |
| `port` | int | (zero-value; example 8317, oracle 18317) | none at config layer |
| `tls.enable` / `tls.cert` / `tls.key` | bool / string / string | false / "" / "" | none |
| `auth-dir` | string | `~/.cli-proxy-api` | `~` prefix expanded to user home at resolve time (`internal/util/util.go` `ResolveAuthDir`); missing dir is not an error |
| `debug` | bool | false | none |
| `pprof.enable` / `pprof.addr` | bool / string | false / `127.0.0.1:8316` | addr trimmed; empty → default |
| `commercial-mode` | bool | false | none |
| `proxy-url` | string | "" | none |
| `api-keys` | []string | (empty) | none (auth keys for client API) |
| `ws-auth` | bool | **true** | none |
| `remote-management.allow-remote` | bool | false | non-local mgmt callers get 403 `{"error":"remote management disabled"}` |
| `remote-management.secret-key` | string | "" | plaintext bcrypt-hashed at startup (B21); already-hashed values (`$2a$`/`$2b$`/`$2y$` prefix) kept; **empty ⇒ B19 (mgmt off)** |
| `remote-management.disable-control-panel` | bool | false | none |
| `remote-management.disable-auto-update-panel` | bool | false | none |
| `remote-management.panel-github-repository` | string | `https://github.com/router-for-me/Cli-Proxy-API-Management-Center` | trimmed; empty → default |
| `plugins.enabled` / `plugins.dir` | bool / string | false / `plugins` | dir trimmed; empty → `plugins` (`defaultPluginsDir`) |
| `plugins.store-sources` | []string | (empty) | trimmed, empties dropped |
| `plugins.configs.<id>.enabled` / `.priority` | bool / int | **false** / 0 | enabled normalized to pointer-false when absent; whole original YAML subtree preserved verbatim on save |
| `discovery.enabled` | bool | false | mDNS advertise |
| `discovery.service-name` | string | "" (→ `CPA-<ShortID>`) | — |
| `discovery.service-type` | string | `_ai-gateway._tcp` | empty → default |
| `discovery.subtypes` | []string | `["_chat-completions","_responses","_messages","_generate-content","_interactions"]` | empty → default list |
| `discovery.interfaces.include` / `.exclude` | []string | (empty) | — |
| `discovery.auth-required` | bool | true | — |
| `discovery.advertise-management` | bool | false | — |

#### 3.1.2 Logging & usage block

| Key | Type | Default | Validation / normalization |
|---|---|---|---|
| `logging-to-file` | bool | false | false ⇒ stdout; true ⇒ rotating files (§3.6.1) |
| `logs-max-total-size-mb` | int | 0 (off) | negative → 0 at load and via mgmt PUT; >0 ⇒ oldest rotated logs deleted until under limit |
| `error-logs-max-files` | int | 10 | negative → 10; 0 ⇒ cleanup disabled |
| `request-log` | bool | false | per-request log files (§3.6.1) |
| `usage-statistics-enabled` | bool | false | gates usage-record production only (§3.5.1); queue itself enabled by mgmt secret (§3.3.3) |
| `redis-usage-queue-retention-seconds` | int | 60 | `<= 0` → 60; `> 3600` → clamped to 3600 with a warn log |

#### 3.1.3 Retry, cooling, routing block

| Key | Type | Default | Validation / normalization |
|---|---|---|---|
| `request-retry` | int | (zero-value; example recommends 3) | additional credential retry rounds; per-credential override `request-retry` (nil/negative → inherit global; 0 → disable extra rounds) |
| `max-retry-credentials` | int | 0 (= all) | negative → 0 |
| `max-retry-interval` | int (seconds) | (zero-value) | non-positive ⇒ never wait for cooldown |
| `disable-cooling` | bool | false | per-credential `disable-cooling` overrides global |
| `save-cooldown-status` | bool | false | true ⇒ `.cds` sidecars (§3.4.4) |
| `transient-error-cooldown-seconds` | int | 0 | **0 = legacy 60 s** (not "off"); negative = off. Recorded upstream fact (BOOTSTRAP §8) |
| `auth-auto-refresh-workers` | int | (zero-value → internal default pool) | `<= 0` → default |
| `routing.strategy` | string | `round-robin` | canonical values `round-robin` \| `weighted-round-robin` \| `fill-first`; mgmt PUT also accepts aliases `rr`, `roundrobin`, `wrr`, `weightedroundrobin`, `ff`, `fillfirst` (normalized, case-insensitive; unknown → 400 `{"error":"invalid strategy"}`) |
| `routing.session-affinity` | bool | false | — |
| `routing.session-affinity-ttl` | duration string | `1h` | `30m`, `2h30m`, … |
| `routing.session-affinity-subagents` | bool | true | ignored when session-affinity false |
| `force-model-prefix` | bool | false | — |
| `quota-exceeded.switch-project` / `.switch-preview-model` / `.antigravity-credits` | bool | false / false / false | — |

#### 3.1.4 API-key provider blocks

Shared credential fields (all provider blocks unless noted; all strings trimmed):

| Field | Type | Default | Notes |
|---|---|---|---|
| `api-key` | string | — | required for meta (`dca:`-prefixed values rejected there) |
| `base-url` | string | — | **required for codex/xai/meta/openai-compatibility** (entry dropped otherwise); meta default `https://api.meta.ai/v1` |
| `priority` | int | 0 | higher preferred |
| `weight` | int (pointer) | 1 | `<= 0` excludes credential; `> 1_000_000` is a **fatal load error** (`ValidateCredentialWeights`); explicit 0 preserved on save |
| `prefix` | string | "" | trimmed of `/`; containing `/` ⇒ emptied |
| `proxy-url` | string | "" | per-entry override |
| `headers` | map<string,string> | (empty) | keys+values trimmed; empty pairs removed |
| `excluded-models` | []string | (empty) | trimmed, lowercased, deduped, order-preserving |
| `disable-cooling` | bool (pointer) | absent | absent = inherit global |
| `request-retry` | int (pointer) | absent | nil/negative inherit global; 0 disables |
| `request-scoped-errors` | [{status int>0, match []string, match-regexr []string, action string}] | (empty) | upstream error classification rules |
| `models` | [{name, alias, display-name, max-context-length, force-mapping, is-compat, thinking}] | (empty) | name = upstream id, alias = client-visible id; alias defaults to name |

Per-block specifics (evidence `config_normalization.go`):

| Block | Sanitization on load |
|---|---|
| `gemini-api-key` | entry dropped when `api-key` AND `base-url` both empty; **deduplicated** by (api-key, base-url, proxy-url, prefix, sorted headers) |
| `interactions-api-key` | same as gemini-api-key |
| `codex-api-key` | dropped without base-url; `websockets`, `alpha-search` bools |
| `xai-api-key` | same as codex; `alpha-search` forced false |
| `meta-api-key` | dropped when api-key empty or `dca:`-prefixed; base-url default `https://api.meta.ai/v1` |
| `claude-api-key` | NOT dropped for missing base-url (default Anthropic URL applies); extra: `rebuild-mid-system-message` bool; `cloak` {mode: `auto`\|`always`\|`never`, strict-mode bool, sensitive-words [], cache-user-id *bool}; `fingerprint-profile` (recognized value `claude-code-cli` rewritten canonical; unrecognized preserved); `experimental-cch-signing` bool |
| `openai-compatibility` | dropped without base-url; extra: `name` (provider id, becomes `owned_by`), `disabled` bool, `support-prompt-cache-key` bool, `api-key-entries` [{api-key, weight, proxy-url}], model extras `image` bool, `input-modalities`/`output-modalities` []string |
| `vertex-api-key` | vertex-compat keys; wire = Gemini/Vertex; `vertex_compat.go` |

#### 3.1.5 OAuth-channel blocks (apply to file-backed auths)

| Key | Type | Default | Sanitization |
|---|---|---|---|
| `oauth-excluded-models` | map<provider, []pattern> | (empty) | provider keys lowercased/trimmed; patterns trimmed/lowercased/deduped; empty maps removed |
| `oauth-model-alias` | map<channel, [{name, alias, fork, display-name, force-mapping}>] | (empty) | channel lowercased; drop empty name/alias; drop name==alias (case-insensitive); dedup aliases per channel |
| `oauth-request-scoped-errors` | map<channel, rule[]> | (empty) | drop rules with status ≤ 0, no matchers, or empty action; empty map → removed |

#### 3.1.6 Misc behavior keys

| Key | Type | Default | Notes |
|---|---|---|---|
| `request-log` | bool | false | §3.6.1 |
| `passthrough-headers` | bool | false | upstream response headers forwarded downstream |
| `disable-image-generation` | bool \| `"chat"` \| `"passthrough"` | false | tri-state string-or-bool |
| `gpt-image-2-base-model` | string | `gpt-5.4-mini` when empty/invalid | must start `gpt-` (case-insensitive) |
| `video-result-auth-cache-ttl` | duration string | `3h` | `30m`, `3h`, …; empty/invalid → default |
| `streaming.keepalive-seconds` | int | 0 (off) | `<= 0` disables SSE/WS heartbeats |
| `streaming.bootstrap-retries` | int | 0 (off) | pre-first-byte stream retries |
| `nonstream-keepalive-interval` | int (seconds) | 0 (off) | `<= 0` disables |
| `claude-code.disable-cloaking-model-list` | bool | false | — |
| `disable-claude-cloak-mode` | bool | false | globally disables Claude request cloaking; every Claude credential defaults to no cloaking (`"never"`), per-credential `cloak` blocks / `cloak_mode` auth-file values can still re-enable or override (evidence `internal/config/config.go`; pinned by golden S6-01) |
| `claude-header-defaults` | {user-agent, package-version, runtime-version, os, arch, timeout, timezone, stabilize-device-profile *bool} | all empty | values trimmed |
| `codex-header-defaults` | {user-agent, beta-features} | empty | values trimmed |
| `codex.*` | see `config_types.go` `CodexConfig` | — | identity-confuse, disable-codex-cloaking, stream-bootstrap-buffering (false), stream-bootstrap-timeout ("0"=unlimited; accepts `none/unlimited/disabled/off/never`), optimize-multi-agent-v2, orphan-delegation-compatibility, model-level-cooling, live-media-relay {enabled, max-sessions, disable-private-remote-ips, public-ip, udp-port-min/max, ice-servers[{urls, username, credential}]} |
| `xai.inject-x-search` | bool | false | — |
| `antigravity.sensitive-words` | []string | (empty) | zero-width obfuscation |
| `antigravity.connection-pool` | {enabled *bool=false, idle-conn-timeout "30s" (cap 210 s), max-idle-conns-per-host *int=2} | — | — |
| `devin.sensitive-words` | []string | (empty) | — |
| `antigravity-signature-cache-enabled` | bool | true | — |
| `antigravity-signature-bypass-strict` | bool | (absent) | — |
| `payload` | {default[], default-raw[], override[], override-raw[], filter[]} | (empty) | `*-raw` rules whose params are not valid JSON are **dropped with a warn log** (`SanitizePayloadRules`) |
| `credential-concurrency` | nested (Home-authoritative; local ignored in Home mode) | see `credential_concurrency.go` `WithDefaults` | **OPTIONAL** for CPA-Edge (Home mode out of scope) |
| `credential-in-flight` | {snapshot-interval "2s", stale-after "10s", max-part-bytes 262144, max-part-count 64, max-revision-bytes 16777216, max-aggregate-groups 100000, max-details 10000, max-string-bytes 256, staging-retention "1m"} | as listed | validation **fatal at load**: snapshot-interval > 0; stale-after ≥ 3× snapshot; part bounds; revision ≥ part bytes; group/detail/string caps (`credential_in_flight.go` `Validate`) |

**Load failure semantics** (B20): with `LoadConfig` (server startup) any YAML parse error, weight error, or `credential-in-flight` validation error aborts startup with an error. With `LoadConfigOptional` (cloud standby) a missing/empty/invalid file yields an empty config with only `credential-in-flight` defaults. Evidence: `config_load.go`.

### 3.2 Effective-config JSON view — GET /v0/management/config

Serialization = the effective `Config` with its JSON tags. MUST omit (`json:"-"`): `host`, `port`, `remote-management` (incl. secret-key), `auth-dir`, home config. MUST include: `api-keys` (plaintext), all provider blocks with their `api-key` values, sanitized/normalized values (post-§3.1 defaults). Byte-shape is fixture-recorded (golden S6-01). Evidence: `config.go` struct tags; `config_basic.go` GetConfig returns a copy of the in-memory config.

### 3.3 Config persistence, secret-key mutation, management auth gate

1. **Bcrypt-at-startup mutation (B21)** — MUST: on load, when `remote-management.secret-key` is non-empty and does not look like bcrypt (`$2a$`/`$2b$`/`$2y$` prefix), hash it (bcrypt default cost) and write the hash back into `config.yaml` via a comment/order-preserving scalar update (`remote-management.secret-key` path only). The plaintext remains the accepted key. Recorded reality (S6-02): the write-back is surgical — after-boot file == before-boot except the secret-key line and one cosmetic blank line; comments and all other bytes preserved. Evidence: `config_load.go` (hash + persist), `config_validation.go`.
2. **Mgmt mutation persistence (B4)** — every management write endpoint persists the full config through `SaveConfigPreserveComments`: comments and key order of existing keys are preserved; new keys are added only when non-zero and not a known default (`pprof.addr`, `remote-management.panel-github-repository`, `plugins.dir`, `routing.strategy`, `error-logs-max-files`=10 exceptions; `weight` explicit zero always kept); sequences merged element-wise keyed by identity fields (`id`, `name`, `alias`, `api-key`, …); legacy keys removed on save (`auth`, `openai-compatibility[].api-keys`, `amp*`, `generative-language-api-key`); `oauth-model-alias`/`oauth-request-scoped-errors`/`plugins.configs` pruned to generated keys (explicit empty map kept when user deleted the last channel); collection nodes rendered block-style; standalone comment lines de-indented. After persist, the change is hot-reloaded asynchronously. Evidence: `config_yaml.go`.
3. **Management auth gate (§3.3.3 → B19)** — management routes are registered iff `remote-management.secret-key != ""` OR env `MANAGEMENT_PASSWORD` set OR a local (TUI) password exists. Otherwise every `/v0/management/*` request returns **404 with empty body** and the usage queue is disabled. The accepted key: `Authorization: Bearer <key>` or `X-Management-Key: <key>`; `MANAGEMENT_PASSWORD` env compared constant-time; local password accepted for loopback only; config secret compared as bcrypt hash. Failure shaping: no key → 401 `{"error":"missing management key"}`; wrong key → 401 `{"error":"invalid management key"}`; non-local without allow-remote → 403 `{"error":"remote management disabled"}`; secret unset → 403 `{"error":"remote management key not set"}`; 5 consecutive failures per client IP → 403 `{"error":"IP banned due to too many failed attempts. Try again in <duration>"}` for 30 min. Evidence: `handler.go` `Middleware`, `AuthenticateManagementKey`; `server.go`.
4. **Hot reload (B22)** — MUST: watch `config.yaml`; debounce 150 ms; on the debounced event read the file; skip when empty or sha256 unchanged; on parse/validate error log (recorded: `failed to reload config: failed to parse config file: yaml: line 16: did not find expected key` — bonus probe `_cpa_edge_ref/run2/s6/probes/S6-15-reload-of-invalid-yaml/`) and keep the old config without crashing; otherwise swap effective config, log `"config successfully reloaded, triggering client reload"`, re-synthesize credentials (auth-dir change → full rescan; `force-model-prefix`/`oauth-model-alias`/retry config change → forced auth refresh), apply usage toggles (`usage-statistics-enabled`, retention seconds) live. Persistence side effects of the load itself (bcrypt rewrite) re-trigger the watcher harmlessly (hash gate). Evidence: `watcher/config_reload.go`, `internal/api/server_reload.go`.




#### 3.3.6 OAuth session registry (storage mapping only — flow semantics are S3)

Upstream keeps OAuth login sessions (state → session) in a process-local map with a TTL of 30 min for pending sessions (long enough to cover device-code flows: xAI ~30 m, Kimi ~15 m) and 1 min for completed ones, purging lazily on access; state strings are capped at 128 chars; a session carries `{provider, status, source: builtin|plugin, metadata?, completed, created_at, expires_at}` (evidence: `internal/api/handlers/management/oauth_sessions.go`). CPA-Edge MUST keep this registry in Store documents (`oauth-sessions` namespace, `update()` for state transitions) so multi-instance and serverless runtimes share login state — the designed divergence from the upstream in-memory map, registered here and in §7. Timed behavior (expiry purges, device-code poll execution) runs on the platform substrate that S7 §2.3-F5b/F5c mandates: Cloudflare Durable Object alarms; Node in-process timers.
### 3.4 Auth-file on-disk schema (recorded from container disk; auth dir default `/root/.cli-proxy-api` in the image)

Loading rules (evidence `sdk/auth/filestore.go` `readAuthFiles`, `internal/watcher/synthesizer/file.go`): only non-directory `*.json` files (case-insensitive suffix); empty files skipped; JSON-parse failures skipped (warn); `type` field (string) lowercased+trimmed selects the provider; `type: "gemini"` is remapped to `gemini-cli` and then **skipped by built-in synthesis** (v7.3.4 handles Gemini OAuth through plugin providers); missing/empty `type` skipped. Auth ID = relative path under auth dir (lowercased on Windows).

#### 3.4.1 Common metadata keys (honored for EVERY built-in type; flattened top-level)

| Key | Type | Semantics |
|---|---|---|
| `type` | string | provider selector (§3.4.2) |
| `disabled` | bool | `true` ⇒ credential disabled (status `disabled`); persisted back into the file on save |
| `priority` | number or numeric string | scheduling priority |
| `weight` | number or numeric string | 0..1_000_000; `<=0` excludes; invalid ⇒ whole file skipped |
| `note` | string | free-form label (trimmed; empty dropped) |
| `proxy_url` | string | per-credential proxy (trimmed) |
| `prefix` | string | model prefix (trimmed of `/`; inner `/` rejected) |
| `headers` | map<string,string> | extra upstream headers |
| `excluded_models` (legacy `excluded-models`) | []string | per-credential model exclusions |
| `model_aliases` (legacy `model-aliases`) | [{name, alias, fork, display-name, force-mapping}] | per-credential aliases (same sanitize as `oauth-model-alias`) |
| `request_retry` | int | nil/negative inherit; 0 disables extra rounds |
| `fingerprint_profile` | string | Claude fingerprint selection |
| dashed spellings (`api-key`, `base-url`, `disable-cooling`, …) | — | normalized to canonical underscore keys on read (`sdk/cliproxy/auth/metadata_keys.go`) |

#### 3.4.2 Per-type token schemas (JSON field names are public interface)

| `type` | Fields (beyond §3.4.1) | Evidence |
|---|---|---|
| `claude` | `id_token`, `access_token`, `refresh_token`, `last_refresh` (RFC3339-ish string), `email`, `account_uuid?`, `organization_uuid?`, `organization_name?`, `claude_device_ids?` ([]string), `expired` (note: JSON key `expired`, field semantic = access-token expiry) | `internal/auth/claude/token.go` `ClaudeTokenStorage` |
| `codex` | `id_token`, `access_token`, `refresh_token`, `account_id`, `last_refresh`, `email`, `expired`; `plan_type` extracted from metadata or JWT `id_token` claim into attribute `plan_type` | `internal/auth/codex/token.go` `CodexTokenStorage`, `synthesizer/file.go` |
| `xai` | `access_token`, `refresh_token`, `id_token?`, `token_type?`, `expires_in?` (int), `expired?`, `last_refresh?`, `email?`, `sub?`, `base_url?`, `redirect_uri?`, `token_endpoint?`, `auth_kind?` | `internal/auth/xai/token.go` `TokenStorage` |
| `kimi` | `access_token`, `refresh_token`, `token_type`, `scope?`, `device_id?`, `expired?` | `internal/auth/kimi/token.go` `KimiTokenStorage` |
| `meta` | `auth_kind`, `access_token`, `dca_token?`, `api_key?`, `token_type?`, `expires_in?`, `expired?`, `dca_expired?`, `dca_expires_at?` (int64), `last_refresh?`, `base_url?`, `email?`, `name?` | `internal/auth/meta/meta.go` `MetaTokenStorage` |
| `devin` | free-form metadata: `api_key` = session token, `session_token`, `user_name`, `user_id`, `org_id`, `auth_kind: "oauth"`, `email?`, `plan?` | `internal/auth/devin/record.go` |
| `antigravity` | `access_token`, `refresh_token`, `expires_in` (int), `timestamp` (unix ms), `expired` (RFC3339), `email?`, `project_id?` | `management/auth_files_provider_oauth.go` `RequestAntigravityToken` |
| `gemini` / `gemini-cli` | skipped by built-in synthesis (plugin territory) — MUST NOT register a credential | `synthesizer/file.go`, `filestore.go` |
| `vertex` | `service_account` (verbatim normalized service-account JSON object), `project_id`, `email` (client_email), `location?` (default `us-central1`), `type: "vertex"`, `prefix?`; written 2-space indented by the import path | `internal/auth/vertex/vertex_credentials.go`, `management/vertex_import.go` |

Writes: files created with mode 0600, parent dirs 0700 (`filestore.go` `Save`, token `SaveTokenToFile`); token-file write = JSON object with metadata flattened at top level (`internal/misc/credentials.go` `MergeMetadata`); a disabled credential whose source file was deleted is never recreated. **Re-serialization rule (recorded, S6-10/S6-11)**: whenever the credential manager persists (upload registration, PATCH-fields, refresh), the credential payload is re-marshaled before hitting the disk. The exact byte shape depends on the WRITE PATH: (a) metadata-map saves — the filestore metadata path used for upload registration, PATCH-fields and type-less metadata records — write **single-line JSON with keys in Go map-marshal (alphabetical) order, `disabled` always materialized**; (b) typed token saves for claude/codex/meta also write single-line JSON (`json.Encoder` default); (c) typed token saves for **xai, kimi and vertex write 2-space-INDENTED JSON** (`json.Encoder.SetIndent("", "  ")`; evidence `internal/auth/xai/token.go`, `internal/auth/kimi/token.go`, `internal/auth/vertex/vertex_credentials.go`). The upload endpoint first writes the raw body, then the store save immediately rewrites it; downloads read the current disk file.

#### 3.4.3 File naming conventions

| Provider | Pattern | Evidence |
|---|---|---|
| claude | `claude-<org-or-account-hash8>-<email>.json`; legacy `claude-<email>.json` | `internal/auth/claude/filename.go` |
| codex | `codex-<hash8>-<email>[-<plan>].json`; legacy `codex-<email>.json` | `internal/auth/codex/filename.go` |
| antigravity | `antigravity-<email>.json` (bare `antigravity.json` when no email) | `internal/auth/antigravity/filename.go` |
| devin | `devin-<sanitized-identifier>.json` (unsafe chars → `_`; fallback `user-<hash8>`) | `internal/auth/devin/record.go` |
| uploaded | exactly the operator-supplied `name` (must end `.json`) | `auth_files_crud.go` |
| vertex | `vertex-<sanitized-project_id>.json` (`/`,`\`,`:` → `_`, space → `-`); created by `POST /v0/management/vertex/import` (S5 surface — recorded there as `tests/fixtures/S5/S5-vertex-import/` STEP 9, fake-PEM → 400) | `management/vertex_import.go`, `internal/auth/vertex/vertex_credentials.go` |

#### 3.4.4 Cooldown sidecar (`.cds`) — B24

When `save-cooldown-status: true`, one `<authfile-base>.cds` JSON file per auth is written **into the auth dir** (atomic temp-file + rename), envelope:

```json
{
  "version": 1,
  "auth_id": "<auth id>",
  "provider": "<provider>",
  "updated_at": "<RFC3339 UTC>",
  "records": [
    { "auth_id": "...", "provider": "...?", "model": "...?", "status": "...?",
      "next_retry_after": "<RFC3339>", "reason": "...?", "quota": {...}?, "last_error": {...}?,
      "updated_at": "<RFC3339>" }
  ]
}
```

Records sorted by model; stale `.cds` files for vanished auths are removed on save; missing dir = empty state. Evidence: `sdk/cliproxy/auth/cooldown_state.go` (`cooldownStateFile`, `stateRelativePath`, `NewFileCooldownStateStoreWithAuthDir(authDir, authDir)` from `sdk/cliproxy/service_auth.go`). **Restored cooldowns survive restart** (persisted runtime state — PROVEN by S6-16 step 8: after `docker restart`, the during-cooldown request still returns 503 `auth_unavailable` and the auth-files listing is unchanged). Recorded field values (S6-16): envelope `auth_id` keeps the raw separator form (`openai-compatibility:<name>:<hash12>`) while the file name sanitizes separators to `_`; `status` is `"cooling"` during a transient cooldown; `reason` = verbatim upstream error body; `last_error` = `{message, retryable, http_status}`; per-model records add the `model` key; a quota block with zero `next_recover_at`/`observed_at` (`0001-01-01T00:00:00Z`) is present when the quota struct is zero-valued. Downstream effect of an exhausted credential pool (recorded): HTTP **503** `{"error":{"message":"auth_unavailable: no auth available (providers=<provider>, model=<model>; last upstream error: <verbatim>)","type":"server_error","code":"internal_server_error"}}` — the `model_cooldown` error shape belongs to rate-limit cooldowns (S4 scope). Scheduling effects are S4.

#### 3.4.5 Auth-file listing entry — GET /v0/management/auth-files (B12)

`{"observed_at": <RFC3339 UTC>, "files": [...]}`; files sorted case-insensitively by `name`. Entry fields: `id`, `auth_index`, `name`, `type` (= provider), `provider`, `label` (email when present, else provider), `status` (`active`|`disabled`|…), `status_message`, `disabled`, `unavailable`, `runtime_only`, `source` (`file` when on disk, `memory` when the file is gone), `size` (bytes), `success`, `failed`, `recent_requests` (§3.6.4), `quota`, `email?`, `project_id?`, `account_type?`/`account?`, `created_at?`, `modtime?`, `updated_at?`, `last_refresh?`, `next_retry_after?`, `path?`, `priority?`, `note?`, `weight?`, `websockets?`, `request_retry?`, `cooldowns` (`null` in Home mode), `model_quotas?`, `id_token` claims (codex)?, plugin quota fields? — full list in `auth_files.go` `buildAuthFileEntryLocked`. Disk-fallback variant (auth manager unavailable) reads files directly and emits `{name, size, modtime, cooldowns: null, type, email, project_id?, priority?, weight?, note?, websockets?, request_retry?}` (`listAuthFilesFromDisk`).

#### 3.4.6 Patch semantics (B16/B17)

- `PATCH /v0/management/auth-files/status` body `{"name"|"auth_index", "disabled": bool}` — flips the `disabled` flag in memory + persists it into the file (metadata key `disabled`).
- `PATCH /v0/management/auth-files/fields` body `{"name", "<dotted.field.path>": <json value>}` — generic dotted-path metadata merge into the auth file: `weight` special-cased (integer ≤ 1_000_000, null deletes; nested rejected), `headers` object merge, `request_retry` integer-or-null (nested rejected, negative = inherit); unknown fields merge as-is; canonicalizes dashed roots to underscore; conflicting same-field spellings → 400 `auth file fields "a" and "b" refer to the same field`; plugin-virtual auths → 409. Response `{"status":"ok"}`.

### 3.5 Usage queue

#### 3.5.1 Production + record schema

A usage record is produced once per provider request completion. Production is gated by `usage-statistics-enabled` (config or live management toggle). The queue itself is enabled iff the management secret is present (§3.3.3). Enqueue is skipped for empty payloads. Record JSON (field order fixed by the marshaler; `timestamp` = RFC3339Nano):

```json
{
  "timestamp": "<RFC3339Nano>",
  "latency_ms": 0, "ttft_ms": 0,
  "source": "<protocol source>", "auth_index": "<index>",
  "access_token_sha256": "<hash or empty>",
  "client_ip": "", "x_forwarded_for": "", "user_agent": "",
  "tokens": { "input_tokens": 0, "output_tokens": 0, "reasoning_tokens": 0,
              "cached_tokens": 0, "cache_read_tokens": 0, "cache_read_tokens_present": true,
              "cache_creation_tokens": 0, "total_tokens": 0 },
  "failed": false, "generate": true, "stream": false,
  "fail": { "status_code": 200, "body": "" },
  "response_headers": { "<Canonical-Mime-Case>": ["value"] },
  "accounting_version": 2,
  "token_breakdown": { "schema_version": 2, "quality": "<level>",
    "total_tokens": 0, "input": {"total_tokens":0,"uncached_tokens":0,"cache_read_tokens":0,"cache_write_tokens":0},
    "output": {"total_tokens":0,"non_reasoning_tokens":0,"reasoning_tokens":0},
    "unclassified_tokens": 0 },
  "provider": "", "executor_type": "", "model": "", "alias": "",
  "endpoint": "", "auth_type": "", "api_key": "", "request_id": "",
  "session_id": "", "parent_session_id": "", "reasoning_effort": "",
  "service_tier": "default", "response_service_tier": ""
}
```

Normalization rules (evidence `internal/redisqueue/plugin.go`): empty `model`/`provider`/`executor_type`/`auth_type` → `"unknown"`; empty `alias` → model; `failed` falls back to downstream status ≥ 400; `fail.status_code` = record status, else downstream status, else 500; non-failed ⇒ `fail = {200, ""}`; `fail.body` trimmed; `session_id`/`parent_session_id` normalized to canonical UUID (empty parent dropped); `service_tier` falls back `default`. `api_key` = the **client** API key used on the proxy. Evidence: `sdk/cliproxy/usage/manager.go` (`Record`), `usage/accounting.go` (`TokenBreakdown`, version 2).

Recorded value semantics (fixture S6-05, byte-exact): `source` = the **upstream credential's API key** (recorded `"mock-upstream-key"`); `response_headers` = the **upstream** response headers (Go-canonical-cased keys); `provider` for openai-compat credentials = `openai-compatible-<name>`; `executor_type` = the executor class (recorded `"OpenAICompatExecutor"`); `auth_type` = `"apikey"` for config keys; `endpoint` = `"<METHOD> <path>"` of the client call; `auth_index` = 16-hex-char credential index; `service_tier` = `"auto"` on OpenAI-protocol requests (recorded), `default` via direct SDK callers. **Failed requests also enqueue records** (fixture S6-18, byte-exact): `failed:true`, zeroed token counts, `fail` carrying the upstream status and verbatim error body. `parent_session_id` is omitted when empty (`omitempty`).

#### 3.5.2 Error events (ring `errors`)

Emitted on failed executions when the queue is enabled (NOT gated by `usage-statistics-enabled`). Wire parity: the RESP `errors` channel delivers events **only to subscribers attached at emission time**; with no subscriber attached the event is dropped on the floor (upstream `EnqueueError` publishes without buffering). CPA-Edge MAY retain the same events in Store ring `errors` for observability, but `SUBSCRIBE errors` MUST NOT replay ring history. Payload:

```json
{ "timestamp": "<RFC3339Nano>", "provider": "", "model": "", "auth_id": "", "auth_index": "",
  "status_code": 500, "body": "", "code": "", "retryable": false,
  "auth_status": { "status": "", "status_message": "", "disabled": false, "unavailable": false,
    "next_retry_after": null, "quota": null,
    "model": { "name": "", "status": "", "status_message": "", "unavailable": false,
               "next_retry_after": null, "quota": null } } }
```

`status_code` = upstream HTTP status when known else 500; `body` = trimmed error message ("request failed" fallback); `quota`/`model` objects omitted when empty. Evidence: `sdk/cliproxy/auth/error_events.go`.

#### 3.5.3 Queue semantics (Store queue mapping)

Upstream in-memory FIFO with subscriber fan-out (evidence `internal/redisqueue/queue.go`); CPA-Edge maps it to the Store queue `usage` with these MUSTs:
- enqueue at request completion (payload = §3.5.1 record); empty payloads skipped.
- **live-subscriber precedence**: when a RESP/SSE subscriber is attached, records are delivered to subscribers and NOT queued; pop endpoints only see records that arrived with no subscriber attached. (Upstream `publishToSubscribers` returns true and skips the buffer.)
- pop is oldest-first and destructive (HTTP B5; RESP LPOP/RPOP). Missing/empty → empty result.
- retention: records older than `redis-usage-queue-retention-seconds` (normalized §3.1.2) are dropped lazily at enqueue/pop. In the Store mapping the retention check runs in the consumer loop (claim → check `timestamp` → ack-drop or redeliver); at-least-once redelivery after lease takeover MUST be tolerated by sinks (idempotent inserts). The consumer loop is timed work: runtimes execute it on the substrate S7 §2.3-F5b/F5c mandates (Cloudflare Durable Object alarms; Node in-process timers).
- subscriber buffer = 256 records; a full (slow) subscriber is dropped and closed (records continue to the queue).
- `SubscribeUsage` immediately delivers `{"support_refresh":true}`; `NotifyUsageRefresh` publishes `{"refresh":true}`; `SubscribeErrors` has no initial payload. Not in Home mode (usage wire rejects with `-ERR redis usage output disabled in home mode`).

#### 3.5.4 API-key usage snapshot (B6)

`GET /v0/management/api-key-usage` → 200 `{ "<provider>": { "<base_url>|<api_key>": { "success": <int>, "failed": <int>, "recent_requests": [20 × {"time": "HH:MM-HH:MM", "success": 0, "failed": 0}] } } }` — only `api_key`-kind credentials; merged across duplicate keys; bucket list oldest→newest (§3.6.4). Evidence: `api_key_usage.go`.

### 3.6 Logs

#### 3.6.1 File storage facts (Node runtime; platform degradation in S7)

- `logging-to-file: true` ⇒ logs to `<logdir>/main.log`, rotated at **10 MB** per file, no backup/age cap, no compression (lumberjack). Log dir = `<writable-base>/logs`, else `./logs`, else `<auth-dir>/logs` when cwd not writable. Evidence: `internal/logging/global_logger.go` (`ResolveLogDirectory`, `ConfigureLogOutput`).
- `logs-max-total-size-mb > 0` ⇒ background cleaner deletes oldest log files until under the cap.
- `request-log: true` ⇒ per-request transcript files; when false, failed requests still write `error-*.log` files, capped by `error-logs-max-files` (default 10; 0 = off). Evidence: `internal/logging/request_logger*.go`, `log_dir_cleaner.go`.
- Rotation naming read by GET /logs: `main.log`, `main.log.<n>` (numeric order), `main-<YYYY-MM-DDTHH-MM-SS>.log[.gz]` (timestamp order). Evidence: `logs.go` `rotationOrder`.

#### 3.6.2 GET /v0/management/logs semantics (B7)

- Query: `cursor` (opaque), `after` (unix seconds cutoff), `limit` (positive int). Unparsable `limit` ⇒ 400 `{"error":"invalid limit: must be a positive integer"}`; `limit <= 0` ⇒ 400 `{"error":"invalid limit: must be greater than zero"}` (recorded, S6-13).
- `logging-to-file: false` ⇒ 400 `{"error":"logging to file disabled"}` (MUST).
- Cursor = base64url(RawURL, padded fallback) of `{"v":1,"file":"<name>","offset":<int>,"size":<int>,"modTime":<s>,"modTimeUnixNano":<int>?,"latestTimestamp":<unix s>,"fingerprint":"<base64url 12 bytes>"}`; fingerprint = base64url(sha256(`log-cursor-v1:<boundary>:` + first ≤4096 B + `:<tailStart>:` + last ≤4096 B)[0:12]); cursor validation: v==1, file allow-listed (main.log or rotated pattern, no path), non-negative offsets, non-empty fingerprint — invalid cursor ⇒ `cursor-reset: true` tail replay. Truncated/rotated-away files ⇒ cursor-reset. Response keys exactly: `lines` ([]string, empty array not null), `line-count` (int), `latest-timestamp` (unix s), `next-cursor` (string), plus `cursor-reset: true` only on reset paths. Serialization order is alphabetical (map marshal; recorded S6-13: `{"latest-timestamp":…,"line-count":…,"lines":[…],"next-cursor":"…"}`). Timestamps parsed from line prefix `[YYYY-MM-DD HH:MM:SS` (local time). Log line ≤ 8 MiB; larger ⇒ 500.
- Evidence: `management/logs.go` (cursor struct, `logFileFingerprint`, `parseTimestamp`, `writeLogsResponse`).

#### 3.6.3 Ring mapping (`logs` ring) — CPA-Edge storage contract

MUST: the runtime keeps the most recent application log entries in Store ring `logs`, capacity 1000 (`DEFAULT_RING_CAPACITY`), one `LogRingEntry` per emitted line:

```ts
type LogRingEntry = { line: string, level: 'debug'|'info'|'warn'|'error'|..., timestamp: string, request_id: string }
```

`GET /v0/management/logs` serves from the ring when files are unavailable (non-Node runtimes) — response shape MUST be byte-identical to §3.6.2 (cursor may be the empty string there; `cursor-reset` absent). Node runtime MUST keep file-backed reads for byte-parity with upstream (S7 decides per platform). Evidence for entry shape: upstream's own log-forward payload uses `{line, level, timestamp, request_id}` (`internal/logging/home_app_log_forwarder.go`, queue size 1024, drop-on-full).

Log line format (MUST for entries produced by CPA-Edge when file logs are on; recorded in fixtures):

```
[YYYY-MM-DD HH:MM:SS] [<request_id or -------->] [<level %-5s, warning→warn>] [<file>:<line>] <message>[ field=value …]
```

Recorded example (S6-13):

```
[2026-09-16 01:24:48] [--------] [info ] [gin_logger.go:103] 200 |          74ms |      172.17.0.1 | GET     "/v0/management/logs"
```

Evidence: `internal/logging/global_logger.go` `LogFormatter.Format`; quoted fields: credential/connection/proxy_scheme/remote_transport/media_session_id/call_id/peer/state/reason; field order: provider, model, plugin_id, plugin_name, source_id, version, … (logFieldOrder).

#### 3.6.4 Per-credential recent-request counters (S4-adjacent, storage here)

**20 buckets × 600 s**; bucket id = `floor(unix/600)`; slot = `bucket_id mod 20` (negative-safe); entry = `{time: "HH:MM-HH:MM" (local, start-end), success: int, failed: int}`; a new bucket id resets that slot's counters; snapshot lists exactly 20 buckets oldest→newest, zero-filled for untouched slots. Evidence: `sdk/cliproxy/auth/types.go` (`recentRequestRing`, `recordRecentRequest`, `RecentRequestsSnapshot`, `formatRecentRequestBucketLabel`). CPA-Edge mapping: Store document namespace `requests`, key `<auth_index>`, value = the 20-bucket array; every request completion increments via the `update()` transaction callback (slot addressed by current bucket id), so concurrent completions are lost-update-free. Exposed via auth-files listing `recent_requests` and via GET /v0/management/api-key-usage (§3.5.4).

#### 3.6.5 Management failure counters

Per-client-IP failure counts and ban deadlines (5 failures → 30-min ban) are in-memory upstream; CPA-Edge MUST persist them through Store document `mgmt/attempts` when a remote Store is configured (multi-instance parity is the point of the Store); single-instance behavior is unchanged. Evidence: `handler.go` `AuthenticateManagementKey`.

### 3.7 Model-list cache

1. **Catalog sources (B25) — three catalog files, same refresh scheme**:
   - `models.json` (per-provider model definitions): embedded fallback loaded at startup; remote refresh from `https://raw.githubusercontent.com/router-for-me/models/refs/heads/main/models.json` then `https://models.router-for.me/models.json` (30 s timeout each, first success wins), immediately at startup and every 3 h; parse/validation failures keep the previous catalog; provider-level change detection fires a refresh callback. Evidence: `internal/registry/model_updater.go`, embedded `internal/registry/models/models.json`.
   - `codex_client_models.json` (Codex client catalog): identical scheme on `…/codex_client_models.json` (same two hosts), `//go:embed` fallback, startup + 3 h refresh, 30 s timeout, **8 MiB size cap** (`maxCodexClientModelsSize`), JSON validation, keep-old on failure, and a monotonic **revision counter** bumped only when validated content changes (snapshot API returns bytes + revision). Evidence: `internal/registry/codex_client_models_updater.go`, `codex_client_models.go`, embedded `models/codex_client_models.json`.
   - `devin_models.json` (Devin catalog): same scheme on `…/devin_models.json`, embed fallback, startup + 3 h, 30 s timeout, 8 MiB cap, revision counter. Evidence: `internal/registry/devin_models_updater.go`, `devin_models.go`, embedded `models/devin_models.json`.
   OPTIONAL to mirror the remote URLs; MUST keep the embedded fallbacks, the refresh hooks, and revision semantics. Evidence: `internal/registry/model_definitions.go`.
2. **Availability cache**: `GetAvailableModels(<protocol>)` results cached per protocol and invalidated on any registration/unregistration/quota change (generation counter). Evidence: `internal/registry/model_registry.go` (`availableModelsCache`, `invalidateAvailableModelsCacheLocked`). CPA-Edge: derived in-memory; catalog documents cached in Store `models/catalog:<provider>`; nothing else persisted.
3. **`created` = server epoch (B26, oracle finding)**: for models defined in config blocks (`openai-compatibility`, `gemini-api-key`, `claude-api-key`, …), the `created` field equals `floor(now)` at credential synthesis time — NOT any upstream value — so it changes on every restart/hot reload. `/v1/models` filters entries to exactly `{id, object, created, owned_by}` under `{"object":"list","data":[…]}`. Evidence: `sdk/cliproxy/service_models.go` (`buildConfiguredModelInfo`, `now := time.Now().Unix()`), `sdk/api/handlers/openai/openai_handlers.go` `OpenAIModels`. Catalog-fetched OAuth models keep catalog `created` values.

---

## 4. Streaming rules (usage wire — byte-exact contract)

**Platform scope (S7 ruling, matrix row F8)**: the RESP usage protocol in this section is the **NODE-RUNTIME contract** — Node is EQUIVALENT (raw TCP listener + protocol multiplexing); Cloudflare and Vercel are DEGRADED: no raw TCP listener and NO substitute wire surface for the RESP channel. The HTTP usage endpoints (GET `/v0/management/usage-queue`, GET `/v0/management/api-key-usage`) remain cross-runtime with identical semantics per §3.5.

Transport: the management TCP port multiplexes HTTP and RESP (first-byte dispatch: `*`, `$`, `+`, `-`, `:` ⇒ RESP). Evidence: `internal/api/mux_listener.go`, `protocol_multiplexer.go`, `redis_queue_protocol.go` (`isRedisRESPPrefix`).

Command sequence (single connection, CRLF framing, RESP arrays of bulk strings):

1. No AUTH yet + any command ⇒ `-NOAUTH Authentication required.\r\n` (or `-ERR IP banned due to too many failed attempts. Try again in <duration>` when banned). Home mode ⇒ `-ERR redis usage output disabled in home mode` and connection closes.
2. `AUTH <password>` (or `AUTH <user> <password>`) ⇒ `+OK\r\n` on success; `-ERR invalid management key` / `-ERR missing management key` / `-ERR remote management disabled` / `-ERR remote management key not set` / `-ERR wrong number of arguments for 'auth' command` on failure. Bulk strings must declare the true byte length (e.g. `oracle-mgmt-key-1` is 17 bytes ⇒ `$17`); a frame whose declared length does not match the payload bytes answers `-ERR protocol error\r\n` (recorded in S6-07 conn 2).
3. `SUBSCRIBE usage` ⇒ `*3\r\n$9\r\nsubscribe\r\n$5\r\nusage\r\n:1\r\n` then immediately `*3\r\n$7\r\nmessage\r\n$5\r\nusage\r\n$21\r\n{"support_refresh":true}\r\n`. `SUBSCRIBE errors` ⇒ ack only (`…$6\r\nerrors\r\n:1\r\n`), no initial message. Unsupported channel ⇒ `-ERR unsupported channel '<name>'`.
4. While subscribed: each queued/published record ⇒ `*3\r\n$7\r\nmessage\r\n$<ch-len>\r\n<channel>\r\n$<len>\r\n<payload>\r\n`. `PING [payload]` ⇒ `*2\r\n$4\r\npong\r\n$<len>\r\n<payload>\r\n`; **PING without payload answers with a NIL bulk string `$-1\r\n`** (recorded, S6-08). `UNSUBSCRIBE` ⇒ `*3\r\n$11\r\nunsubscribe\r\n$<ch>\r\n:0\r\n` then close. `QUIT` ⇒ `+OK\r\n` then close. Unknown ⇒ `-ERR unknown command '<lowercased>'` and the stream continues.
5. `LPOP usage <n>` / `RPOP usage <n>` (counted form) ⇒ `*<k>\r\n` + k bulk strings (records oldest-first), and `*0\r\n` (empty array) when the queue is empty; `LPOP usage` (no count) ⇒ single bulk string or `$-1\r\n` when empty; count ≤ 0 or unparsable ⇒ `-ERR value is not an integer or out of range`; `errors` channel ⇒ `-ERR unsupported channel 'errors'`; wrong arity ⇒ `-ERR wrong number of arguments for 'lpop' command`.
6. Unknown top-level command ⇒ `-ERR unknown command '<lowercased>'`. **`QUIT` is state-dependent** (recorded, S6-07 + S6-09): on a SUBSCRIBED connection it answers `+OK\r\n` and closes; on a merely AUTHed (non-subscribed) connection it is NOT a command — `-ERR unknown command 'quit'\r\n` (the connection stays usable); unauthenticated ⇒ NOAUTH first.

Slow-subscriber rule: buffer 256; overflow ⇒ subscriber dropped/closed (§3.5.3). Errors channel receives only live-published events (§3.5.2).

**Volatile-field masking whitelist for S6 fixtures** (byte-exact comparisons MUST mask only these): port numbers (the oracle stack substitutes the reference port and mock ports; mask `:18317`→`:8387`, `:18999`→`:19999`, `:190xx`→`:200xx` in URLs, paths, and config base-urls); `Date` response header; bcrypt hash value in config.yaml (structure `$2a$10$…60 chars` stays); usage-record `timestamp`, `latency_ms`, `ttft_ms`, `request_id`, `client_ip`, `x_forwarded_for`, `user_agent` (when it encodes curl version), `session_id`/`parent_session_id`, `response_headers` keys casing/values that vary, `access_token_sha256`; error-event `timestamp`, `next_retry_after`, quota timestamps, `auth_index` when derived from random IDs; auth-file entry `observed_at`, `created_at`, `modtime`, `updated_at`, `last_refresh`, `next_retry_after`, `size` (only when re-serialized), `.cds` timestamps and `next_retry_after`; `/logs` `lines` content, `latest-timestamp`, `next-cursor`, `cursor-reset`, `line-count` when log content varies; `/v1/models` `created`. Everything else MUST be byte-identical.

---

## 5. Error semantics

- Management endpoints never use R-404-empty for JSON paths they own: unknown `/v0/management/*` sub-routes are 404 **empty body** (gin NoRoute, ruling R-404); known routes emit `{"error":"<string>"}` with the exact strings in §2.
- Auth failures on management: 401/403 shapes per §3.3.3; the RESP wire mirrors them as `-ERR <message>` (§4).
- `PATCH /auth-files/fields` validation errors are 400 with strings listed in B17; unknown auth name → 404 `{"error":"auth file not found"}`; plugin-virtual target → 409 (exact string in B15).
- Config PUT (`config.yaml`): parse error 400 `invalid_yaml`, semantic validation error 422 `invalid_config` (message = upstream error text; treat message text as masked-dynamic in fixtures, code field is stable).
- Logs endpoints: 400 `logging to file disabled` (B7/B8), 400 `invalid limit: …` per §3.6.2 (B7), 404 shapes (B8/B10/B11), 500 with `failed to …` messages on IO errors.
- Usage queue: 400 `count must be a positive integer` (B5).
- Store-level failures surface as `unavailable` (HTTP 503 `{"error":"handler unavailable"}` shape is upstream's analog for nil-handler cases, e.g. 503 `{"error":"core auth manager unavailable"}`).

---

## 6. Golden-sample index

Recorded by @oracle-runner-2 against `eceasy/cli-proxy-api:v7.3.4` (digest `sha256:97825da…`), per RECIPES in `reports/oracle/BOOTSTRAP.md` §7. Layout per case: `tests/fixtures/S6/<case>/` with `meta.yaml`, `request.http` (numbered request sequence), `downstream.md` (numbered responses), `upstream.jsonl` (mock wire), `mock-response.json`, plus `disk/` captures for on-disk schemas (config.yaml snapshots, auth files, `.cds`).

| Fixture | Case | Covers |
|---|---|---|
| `tests/fixtures/S6/S6-01-config-get/` | effective-config JSON view (B1, §3.2) |
| `tests/fixtures/S6/S6-02-secret-bcrypt-mutation/` | in-place bcrypt rewrite of secret-key (B21, §3.3.1) + disk capture |
| `tests/fixtures/S6/S6-03-config-yaml-roundtrip/` | GET/PUT config.yaml + invalid YAML 400 + invalid config 422 (B2/B3) |
| `tests/fixtures/S6/S6-04-field-toggle-persist/` | usage-statistics-enabled toggle, persistence to disk, hot reload (B4, §3.3.2/3.3.4) |
| `tests/fixtures/S6/S6-05-usage-queue-record/` | usage record pop, field schema, destructive pop (B5, §3.5.1/3.5.3) |
| `tests/fixtures/S6/S6-06-usage-queue-errors/` | count validation (B5) |
| `tests/fixtures/S6/S6-07-usage-resp-protocol/` | AUTH/LPOP/RPOP frames (B18, §4) |
| `tests/fixtures/S6/S6-08-usage-subscribe-stream/` | SUBSCRIBE usage + initial payload + live message + PING/UNSUBSCRIBE (B18, §4) |
| `tests/fixtures/S6/S6-09-errors-subscribe-stream/` | SUBSCRIBE errors + live error event (B18, §3.5.2) |
| `tests/fixtures/S6/S6-10-authfile-upload-list-delete/` | upload → list entry → download → delete + disk bytes (B12/B13/B14/B15, §3.4) |
| `tests/fixtures/S6/S6-11-authfile-patch-fields/` | PATCH fields + weight/validation errors (B17, §3.4.6) |
| `tests/fixtures/S6/S6-12-logs-disabled/` | 400 logging-to-file disabled (B7/B8) |
| `tests/fixtures/S6/S6-13-logs-enabled/` | GET/DELETE logs with file logging on (B7/B8, §3.6.2) |
| `tests/fixtures/S6/S6-14-models-created-epoch/` | /v1/models created=server epoch + alias mapping (B26, §3.7.3) |
| `tests/fixtures/S6/S6-15-hot-reload-provider/` | config file edit → live provider add (B22, §3.3.4) |
| `tests/fixtures/S6/S6-16-cds-cooldown/` | save-cooldown-status .cds sidecar, 503 `auth_unavailable` during cooldown, restart persistence re-check (B24, §3.4.4) |
| `tests/fixtures/S6/S6-18-failed-usage-record/` | failed-request usage record: `failed:true`, zeroed tokens, `fail{status_code:500, body:verbatim}` (§3.5.1) |
| — `S6-17-oauth-token-file-live-login` | **FIXTURE-DEFERRED** (CREDENTIALED-ONLY): real OAuth token-file bytes; schemas specified in §3.4.2/§3.4.3 |

Case definitions: `spec/recordings/S6.cases.json` — 18 cases: 17 RECORDABLE-LOCALLY recorded in full (S6-01…S6-16, S6-18) + 1 FIXTURE-DEFERRED (S6-17, CREDENTIALED-ONLY: live OAuth token files — on-disk shapes specified from source in §3.4.2/§3.4.3, not recorded). Status: **RECORDED 17/17 by @oracle-runner-2** (2026-09-16, isolated stack: reference on 127.0.0.1:8387, mocks on 19999/200xx; port substitution masked per §4); S6-07 also carries a follow-up conn 4 (wrong-key AUTH with correct `$13` frame → `-ERR invalid management key`) and a bonus conn-2 malformed-frame segment (`-ERR protocol error`). Fixture layout per case: `meta.yaml`, `request[N].http` + `downstream[N].md` (numbered multi-step; `### <n>` sections), RESP cases carry byte-exact hex+ascii socket transcripts (client→server in `request.http`, server→client in `downstream.md`, numbered connections; HTTP steps inside RESP cases as `request-hN.http`/`request-hN.down.md`, seed requests as `request-seedN.*`), `upstream.jsonl` + `mock-response.json` for mock-driven cases, `disk/` for verbatim on-disk captures (paths relative to `disk/`, listed in `meta.yaml`). Recorded-vs-predicted corrections are folded into §2/§3/§4 above (AUTH `$17`, counted-pop `*0`, state-dependent QUIT, upload re-serialization, 503 `auth_unavailable` cooldown shape, surgical bcrypt write-back). Bonus probes: failed-request usage record was promoted to fixture S6-18; the invalid-YAML hot-reload keep-old-config transcript remains a sandbox probe (`_cpa_edge_ref/run2/s6/probes/S6-15-reload-of-invalid-yaml/`, cited in §3.3(4)), available for promotion on request.

---

## 7. Open questions and intentional non-equivalences

1. **`gemini`/`gemini-cli` auth files skipped** (v7.3.4 delegates Gemini OAuth to plugin providers). CPA-Edge ships no plugin host initially ⇒ these files MUST be ignored exactly like upstream. Registered as intentional non-equivalence (no plugin runtime yet).
2. **Logs: ring vs files.** Upstream `/v0/management/logs` reads rotating files. CPA-Edge Node runtime MUST reproduce file behavior byte-for-byte; other runtimes serve from Store ring `logs` with identical response shape (cursor mechanics degrade to `next-cursor: ""`). S7 owns the final degradation matrix; flagged there.
3. **`redis-usage-queue-retention-seconds`** retains its Redis-era name for config compatibility although no Redis is involved; CPA-Edge keeps the key name (public interface) and maps it to Store queue retention.
4. **Object-store/git/Postgres token backends** are OPTIONAL for CPA-Edge; the Store interface is the seam. Postgres mirroring of cooldown state included in that optionality.
5. **Home mode** (`home` runtime-only config, credential-concurrency, usage-wire disable) is out of scope; config keys are accepted-and-ignored (documented in §3.1).
6. **Open question (upstream)**: `PATCH /auth-files/fields` accepts arbitrary dotted paths — we spec the typed subset (§3.4.6) as MUST and generic merge as MUST, but do not enumerate every downstream consumer. No fixture covers hostile paths beyond the listed 400s.
7. **Open question**: `x-goog-api-key` accepted on `/v1` (bootstrap §8) is S1 territory; noted here only because usage records key on client `api_key` regardless of header style.
8. **FIXTURE-DEFERRED (CREDENTIALED-ONLY)**: real OAuth token files written by live logins (claude/codex/xai/kimi/meta/devin/antigravity flows) — the on-disk shapes are specified from source (§3.4.2/§3.4.3); synthetic uploads cover the read/patch/list/delete surface locally.
9. **Bcrypt cost**: upstream uses bcrypt default cost (10 in the image build). CPA-Edge MUST accept `$2a$`/`$2b$`/`$2y$`; cost choice is implementation detail (hashes interop).
