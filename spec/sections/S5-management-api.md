# S5 — Management API (`/v0/management` full surface)

Section id: S5. Module: `packages/management` (+ routing mounted by `runtimes/*`).
Upstream anchor: CLIProxyAPI v7.3.4, commit `8335eac731946bd4eff18f500653f93736df53d6` (see SPEC.md §0).
Upstream evidence paths in this section are relative to the upstream repo root.

---

## 1. Scope and boundaries

IN scope:
- The entire `/v0/management` surface: route inventory, methods, payloads, status codes, JSON field names.
- Management authentication/authorization middleware (cross-referenced with S3): key styles, remote/local rules, failure banning.
- Management availability semantics (routes present only when a management secret exists).
- The control-panel route `/management.html`.
- Per-management-response header contract (`X-CPA-*`, CORS block).

OUT of scope (owned elsewhere):
- Client API routes (`/v1/**`, `/v1beta/**`, `/backend-api/codex/**`, `/openai/v1/**`, OAuth callback routes on the main port `/anthropic/callback`, `/codex/callback`, `/antigravity/callback`, `/devin/callback`, `/callback`) — S1.
- OAuth flow internals (PKCE generation, token exchange, refresh semantics) — S3. S5 covers only the management HTTP envelopes of the auth-URL/status/cancel/callback endpoints.
- Credential scheduling/cooldown algorithms — S4.
- Persisted config/auth-file/usage schemas (Store documents) — S6. S5 defines the HTTP wire shapes only.
- Plugin runtime semantics — the plugin host itself is out of scope; only the management HTTP envelopes of the plugin endpoints are specified here.

Intentional non-equivalences are listed in §8.

---

## 2. Behavior inventory

### 2.1 Route registration and availability

Routes are registered lazily, only when a management secret is configured
(evidence: `internal/api/server.go` — `hasManagementSecret := cfg.RemoteManagement.SecretKey != "" || envManagementSecret || s.localPassword != ""`; `internal/api/server_management.go` — `registerManagementRoutes`).

MUST:
- If no management secret is configured (no `remote-management.secret-key`, no `MANAGEMENT_PASSWORD` env, no runtime-local password), EVERY `/v0/management` request — regardless of method or path — returns **404 with an empty body** (R-404 in SPEC.md §5; evidence: `internal/api/server_management.go` `managementAvailable` → `c.AbortWithStatus(http.StatusNotFound)`).
- If `home.enabled` is true (Home control-center mode), every `/v0/management` request returns **404 empty** (evidence: `managementAvailable`).
- A wrong HTTP method on a registered management route returns **404 empty**, not 405 (R-404; gin semantics).
- `OPTIONS` on any path is auto-answered **204 No Content** with the CORS block, without any auth (evidence: recorded probe `04-options-request`).
- `GET /management.html` serves the control-panel asset; MUST return 404 when `remote-management.disable-control-panel: true`, when `home.enabled` is true, or when the asset cannot be materialized (evidence: `internal/api/server_management.go` `serveManagementControlPanel`). CPA-Edge MUST implement the 404 semantics; serving a panel asset is OPTIONAL.

### 2.2 Management authentication (see S3 for full rules)

Evidence: `internal/api/handlers/management/handler.go` (`Middleware`, `AuthenticateManagementKey`).

MUST:
- Accept the management key in EITHER header: `Authorization: Bearer <key>` (scheme case-insensitive, split on first space) or `X-Management-Key: <key>`. If both styles are evaluated, `Authorization` wins when present (an `Authorization` header that is not `Bearer ...` is used verbatim as the key).
- On every `/v0/management` response — including auth failures — set the headers:
  `X-CPA-VERSION` (e.g. `v7.3.4`), `X-CPA-COMMIT` (e.g. `8335eac`), `X-CPA-BUILD-DATE` (e.g. `2026-09-15T14:07:06Z`), `X-CPA-SUPPORT-PLUGIN` (`1` when plugin support is compiled in). On the wire these appear with Go-canonical casing — recorded fixtures show `X-Cpa-Version`, `X-Cpa-Commit`, `X-Cpa-Build-Date`, `X-Cpa-Support-Plugin` (and `X-Cpa-Trace-Id` in the expose list); contract tests must compare with this canonical casing.
- Every response (including 404/401) carries the CORS block:
  `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Headers: *`,
  `Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS`,
  `Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id`.

Auth failure statuses (body always `{"error":"<message>"}`):

| Condition | Status | Body |
|---|---|---|
| No key provided, one is configured | 401 | `{"error":"missing management key"}` |
| Key does not match (bcrypt hash, env secret, or local password) | 401 | `{"error":"invalid management key"}` |
| Non-localhost client and `allow-remote: false` | 403 | `{"error":"remote management disabled"}` |
| No secret configured at all (but routes somehow reachable) | 403 | `{"error":"remote management key not set"}` |
| Client IP banned (≥5 counted failures within the ban window) | 403 | `{"error":"IP banned due to too many failed attempts. Try again in <duration>"}` — duration is a wall-clock remainder, dynamic |

Counted failures: missing and invalid keys each count; a remote-disabled rejection does NOT count. Ban duration 30 minutes; counter resets on success. (All evidence: `AuthenticateManagementKey`.) The ban message MUST be byte-equal modulo the duration expression; CPA-Edge MAY choose the same `m`s/`s` formatting as Go's `time.Duration.Round(time.Second)`.
- An unknown `/v0/management` sub-route — for ANY method (the fallback dispatch `pluginManagementNoRoute` is method-agnostic) — with a valid key → **404 empty**; with a missing/invalid key → **401** (the management middleware runs before the fallback 404; evidence: `internal/api/server_management.go` `pluginManagementNoRoute`).

### 2.3 Route inventory

All paths are prefixed `/v0/management`. Unless noted, the two `oauth-callback` routes are the ONLY routes outside the auth middleware (they still require management availability). PATCH on scalar endpoints is an alias of PUT (same handler, same body contract). Every mutating handler that persists config responds `200 {"status":"ok"}` on success unless a richer shape is given.

**Core config**

| Method | Path | Success | Notes / error codes |
|---|---|---|---|
| GET | `/config` | 200 | Full effective config JSON (see §3.1) |
| GET | `/config.yaml` | 200 | Raw config.yaml bytes, `Content-Type: application/yaml; charset=utf-8`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`; 404 `{"error":"not_found","message":"config file not found"}` |
| PUT | `/config.yaml` | 200 `{"changed":["config"],"ok":true}` (recorded; gin.H → keys alphabetical) | Body = raw YAML; 400 `invalid_yaml` (+`message`) on YAML parse failure; 422 `invalid_config` (+`message`) when parsed config fails validation; writes body verbatim and hot-reloads |
| GET | `/latest-version` | 200 `{"latest-version":"<tag>"}` | Queries GitHub releases API; 500/502 shapes in §5. EXTERNAL — see §8 |

**Scalar toggles/fields** (each: GET returns `{"<key>":<value>}`; PUT/PATCH body `{"value":<value>}`; invalid/non-JSON body or missing `value` → 400 `{"error":"invalid body"}`)

| Config key | GET/PUT/PATCH path | Type | Notes |
|---|---|---|---|
| `debug` | `/debug` | bool | |
| `logging-to-file` | `/logging-to-file` | bool | |
| `logs-max-total-size-mb` | `/logs-max-total-size-mb` | int | negative values clamped to 0 |
| `error-logs-max-files` | `/error-logs-max-files` | int | negative values reset to 10 |
| `usage-statistics-enabled` | `/usage-statistics-enabled` | bool | |
| `request-log` | `/request-log` | bool | |
| `ws-auth` | `/ws-auth` | bool | |
| `request-retry` | `/request-retry` | int | |
| `max-retry-credentials` | `/max-retry-credentials` | int | |
| `max-retry-interval` | `/max-retry-interval` | int | |
| `force-model-prefix` | `/force-model-prefix` | bool | |
| `proxy-url` | `/proxy-url` | string | DELETE `/proxy-url` clears it (200 `{"status":"ok"}`) |
| `quota-exceeded.switch-project` | `/quota-exceeded/switch-project` | bool | GET key: `switch-project` |
| `quota-exceeded.switch-preview-model` | `/quota-exceeded/switch-preview-model` | bool | GET key: `switch-preview-model` |
| `routing.strategy` | `/routing/strategy` | string | GET `{"strategy":"<normalized>"}`; accepted PUT values (case-insensitive, trimmed): `round-robin`/`roundrobin`/`rr`, `weighted-round-robin`/`weightedroundrobin`/`wrr`, `fill-first`/`fillfirst`/`ff`; anything else → 400 `{"error":"invalid strategy"}`; stored value is the normalized name |

**api-keys (list[string])**

| Method | Path | Body / query | Success | Errors |
|---|---|---|---|---|
| GET | `/api-keys` | — | 200 `{"api-keys":[...]}` | |
| PUT | `/api-keys` | JSON array of strings, or `{"items":[...]}` (items must be non-empty) | 200 `{"status":"ok"}` (replaces list) | 400 `{"error":"failed to read body"}` / `{"error":"invalid body"}` |
| PATCH | `/api-keys` | `{"index":i,"value":v}` or `{"old":a,"new":b}` | 200 `{"status":"ok"}` | 400 `{"error":"invalid body"}` / `{"error":"missing fields"}` (index+value replaces at index; old+new replaces first match else appends) |
| DELETE | `/api-keys` | `?index=i` or `?value=v` | 200 `{"status":"ok"}` | 400 `{"error":"missing index or value"}` |

**Provider api-key lists** — identical envelope per provider: GET returns `{"<path>":[...]}` where each entry carries `auth-index` (runtime credential index, possibly empty). All accept PUT with a bare JSON array or `{"items":[...]}`. PATCH body `{"index":i,"value":{...}}` (or `{"match":"<api-key>"}` / `{"name":"<provider name>"}` for openai-compatibility); 404 `{"error":"item not found"}` when no match; 400 for ambiguous matches (see §3.3). DELETE via `?api-key=` (+`&base-url=` to disambiguate), `?index=`, or `?name=` (openai-compatibility); missing selector → 400 `{"error":"missing api-key or index"}` (or `missing name or index`).

| Path | Entry type | PUT quirks |
|---|---|---|
| `/gemini-api-key` | `GeminiKey` | `SanitizeGeminiKeys` after write; PATCH that empties BOTH `api-key` and `base-url` removes the entry |
| `/interactions-api-key` | `GeminiKey` shape | same removal quirk |
| `/claude-api-key` | `ClaudeKey` | normalizes fingerprint-profile; validates weight + fingerprint-profile on PUT (400 `claude-api-key[i].<field>: <reason>`) |
| `/codex-api-key` | `CodexKey` | entries with empty `base-url` after normalization are DROPPED on PUT; PATCH with `base-url:""` removes the entry |
| `/xai-api-key` | `XAIKey` (CodexKey shape + `websockets`) | same base-url drop/removal quirk |
| `/meta-api-key` | `MetaKey` (CodexKey shape) | empty `base-url` defaults to `https://api.meta.ai/v1` on PUT and PATCH |
| `/vertex-api-key` | `VertexCompatKey` | empty `api-key` → 400 `{"error":"vertex-api-key[i].api-key is required"}`; PATCH with `api-key:""` removes the entry |
| `/openai-compatibility` | `OpenAICompatibility` | entries with empty `base-url` are DROPPED on PUT; PATCH with `base-url:""` removes; DELETE selector is `?name=` |

Weight validation (all provider lists): `weight` is optional; `null`/absent = default 1; integers > 1 000 000 → 400 `{"error":"<field>: weight must not exceed 1000000"}` (PUT: `<path>[i].weight`; PATCH: bare reason). Non-integer weight in PATCH → 400 `{"error":"weight must be an integer"}`. Non-positive weights are valid (they exclude the credential from weighted routing) — evidence: `internal/credentialweight/weight.go`, `internal/api/handlers/management/config_lists.go`.

**OAuth provider-wide maps**

| Method | Path | Shape |
|---|---|---|
| GET/PUT/PATCH/DELETE | `/oauth-excluded-models` | GET `{"oauth-excluded-models":{"<provider>":["model",...]}}`; PUT bare map or `{"items":{...}}`; PATCH `{"provider":"p","models":[...]}` (empty normalized list deletes the provider key; 404 `{"error":"provider not found"}` if absent; 400 `{"error":"invalid provider"}` when blank); DELETE `?provider=p` (400 `{"error":"missing provider"}`, 404 `provider not found`); provider keys lowercased+trimmed |
| GET/PUT/PATCH/DELETE | `/oauth-model-alias` | GET `{"oauth-model-alias":{"<channel>":[{"name","alias","fork"?,"display-name"?,"force-mapping"?}]}}`; PATCH `{"channel":"c","aliases":[...]}` or legacy `{"provider":"p",...}` (400 `{"error":"invalid channel"}` when blank; empty alias list deletes channel key, 404 `{"error":"channel not found"}`); DELETE `?channel=` or `?provider=` (400 `{"error":"missing channel"}`) |
| GET/PUT/PATCH/DELETE | `/oauth-request-scoped-errors` | Same pattern; rules are `[{"status"?:int,"match"?:[string],"match-regexr"?:[string],"action"?:"stop"|"stop-and-cooldown"|"continue"|"continue-and-cooldown"}]`; the per-channel error key is `channel` (legacy `provider` accepted in PATCH) |

**Auth files (credentials)**

| Method | Path | Contract |
|---|---|---|
| GET | `/auth-files` | 200 `{"observed_at":<RFC3339>,"files":[...]}` (§3.4); optional filters `?name=`, `?auth_index=` |
| GET | `/auth-files/models` | `?name=` required → 400 `{"error":"name is required"}` (recorded); 200 `{"models":[...]}` — for a provider with a static catalog this returns the FULL catalog (recorded for a `kimi` file: `{"display_name":"Kimi K2","id":"kimi-k2","owned_by":"moonshot","type":"kimi"}` and every other static kimi model, alphabetical key order) |
| GET | `/auth-files/download` | `?name=<file.json>`; 400 `{"error":"invalid name"}` (empty or path separators), 400 `{"error":"name must end with .json"}`; 404 `{"error":"file not found"}`; success: 200, `Content-Type: application/json`, `Content-Disposition: attachment; filename="<name>"`, raw bytes of the PERSISTED file — which the reference CANONICALIZES: keys alphabetical, `disabled` flag persisted, fields written by `PATCH /auth-files/fields` included (recorded download bytes: `{"disabled":false,"email":"s5@example.com","note":"s5-note-value","priority":7,"type":"kimi"}`) |
| POST | `/auth-files` | Either raw JSON body + `?name=<file.json>` (same 400s as download; 500 on write errors), or `multipart/form-data` (any field names, sorted; single file → 200 `{"status":"ok"}`; multiple → 200 `{"status":"ok","uploaded":N,"files":[...]}` or 207 `{"status":"partial","uploaded":N,"files":[...],"failed":[{"name","error"}]}`); non-`.json` filenames → 400 `{"error":"file must be .json"}` (multipart) / `{"error":"name must end with .json"}` (query); empty multipart → 400 `{"error":"no files uploaded"}` |
| DELETE | `/auth-files` | `?name=` (repeatable), JSON body `{"name":..}`/`{"names":[..]}`/`["a","b"]`, or `?all=true|1|*`; single → 200 `{"status":"ok"}`; multi → 200 `{"status":"ok","deleted":N,"files":[...]}` or 207 partial; all → 200 `{"status":"ok","deleted":N}`; unknown name → 404 `{"error":"auth file not found"}`; unsafe name → 400 `{"error":"invalid name"}`; plugin virtual auth → 409 `{"error":"plugin virtual auth cannot be modified directly; edit or delete the source auth file"}` |
| PATCH | `/auth-files/status` | Body `{"name","auth_index"?,"disabled":bool}`; 400 `{"error":"name is required"}` / `{"error":"disabled is required"}` / `{"error":"invalid request body"}`; 404 `{"error":"auth file not found"}`; success 200 `{"disabled":<bool>,"status":"ok"}` (alphabetical; recorded); config-derived api-key auths are disabled via the config instead → 200 adds `"via":"config:excluded-models","excluded_pattern":"*"`; plugin virtual auth → 409 (same message as DELETE) |
| PATCH | `/auth-files/fields` | Body: `{"name":.., "<field>":<value>, ...}` plus optional `request_retry`; updates metadata fields on the auth file; 400 `{"error":"invalid request body"}`, `{"error":"name is required"}`, `{"error":"no fields to update"}`, `{"error":"field name is required"}`, `{"error":"invalid field <field>"}`, `{"error":"weight must be an integer"}`, `{"error":"weight does not support nested fields"}`, `{"error":"request_retry must be an integer or null"}`, `{"error":"request_retry does not support nested fields"}`, `{"error":"auth file fields \"a\" and \"b\" refer to the same field"}`; 404 `{"error":"auth file not found"}`; 409 plugin virtual; success 200 `{"status":"ok"}` |
| POST | `/auth-files/refresh` | Query or JSON `{"name","auth_index","all"}`; 400 `{"error":"name or all=true is required"}`, `{"error":"invalid request body: ..."}`; 404 `{"error":"auth file not found"}`; `all=true` → 200 `{"ok":true,"results":[...]}`; single → 200 `{"ok":true,"auth":{...}}` (success path EXTERNAL — see §8) |
| POST | `/vertex/import` | multipart field `file` = service-account JSON, optional `location` (form/query; default `us-central1`). Validation order: missing file → 400 `{"error":"file required"}` (recorded); non-JSON → 400 `{"error":"invalid json","message":...}` (recorded: `invalid character 'o' in literal null (expecting 'u')`); `private_key` is normalized as a REAL RSA key BEFORE the project_id check (SOURCE-verified: `NormalizeServiceAccountMap` runs before the project_id lookup, `internal/auth/vertex/keyutil.go` + `vertex_import.go`; the recorded STEP 9 carries a valid project_id, so it proves the PEM check fires but does NOT discriminate the order — the discriminating request would be invalid-PEM + missing-project_id → `invalid service account`); the full 400 `{"error":"invalid service account","message":"<reason>"}` family: `service account payload is empty` (fires on a JSON `null` body, which unmarshals to a nil map — `{}` is NOT empty and proceeds to the private_key check; evidence: `vertex_import.go` unmarshal + `keyutil.go` nil-map check), `service account missing private_key`, `private_key is not valid pem: <detail>` (recorded detail: `missing pem markers`; other details: `private_key base64 payload empty`, base64 decode failures), `private_key pem decode failed`, `private_key invalid rsa: <err>`, `private_key invalid pkcs8: <err>`, `private_key is not an RSA key`, `private_key uses unsupported format` — the fake-PEM rejection (`private_key is not valid pem: missing pem markers`) is the recorded golden step appended per gate round 1 (B2; raw probe preserved at `_cpa_edge_ref/run4/probes/S5/S5-vertex-import-drafted-content/`); valid key but no `project_id` → 400 `{"error":"project_id missing"}` (recorded); persistence failure → 500 `{"error":"save_failed","message":...}`. On import the key is RE-ENCODED to PKCS#1 (`-----BEGIN RSA PRIVATE KEY-----`) in the persisted auth file — wire-visible via `GET /auth-files/download` (persisted-file schema detail owned by S6). Success 200, keys alphabetical: `{"auth-file":"<path>","email":...,"location":...,"project_id":...,"status":"ok"}` (recorded); persisted file name `vertex-<sanitized project_id>.json` (the fixture embeds a synthetic RSA-2048 PKCS#8 PEM) |

**Usage / telemetry**

| Method | Path | Contract |
|---|---|---|
| GET | `/api-key-usage` | 200: object keyed by provider → `"base_url\|api_key"` → `{"success":n,"failed":n,"recent_requests":[...]}`; `{}` when no api-key credentials exist; 503 `{"error":"core auth manager unavailable"}` when the auth manager is missing |
| GET | `/usage-queue` | `?count=N` (default 1; non-positive/non-integer → 400 `{"error":"count must be a positive integer"}`); 200: JSON array of popped usage records (each a raw JSON object, or a string when the record is not valid JSON) |
| POST | `/reset-quota` | Body `{"auth_index":"..."}`; 400 `{"error":"invalid request body"}` / `{"error":"auth_index is required"}`; 404 `{"error":"auth not found"}`; 200 `{"status":"ok","auth_index":"<idx>","models":[...]}` |
| GET | `/quota/providers` | 200 `{"providers":[...]}` (empty when no plugin quota providers) |
| POST | `/quota/fetch` | Body `{"auth_index":..,"provider"?,"plugin_id"?}`; 400 `{"error":"invalid request body"}` / `{"error":"auth_index is required"}`; 404 `{"error":"auth not found"}`; 501 `{"error":"no quota provider available for credential"}`; 502 `{"error":"failed to fetch quota: ..."}` |
| POST | `/quota/reset` | Same selectors; auth resolution PRECEDES the provider check: unknown `auth_index` → 404 `{"error":"auth not found"}` (recorded); with the plugin host absent and a real auth → 501 `{"error":"plugin host unavailable"}`; with a plugin host but no provider → 501 `{"error":"no quota provider available for credential to reset"}` / 404 `{"error":"quota provider not found for plugin"}`; success 200 `{"auth_index":...,"message"?,"status":"ok"}` |

**Logs**

| Method | Path | Contract |
|---|---|---|
| GET | `/logs` | 400 `{"error":"logging to file disabled"}` when `logging-to-file:false`; else 200 `{"lines":[..],"line-count":n,"latest-timestamp":<epoch>,"next-cursor":""}` (`"cursor-reset":true` only after a cursor reset); `?limit=` invalid → 400 `{"error":"invalid limit: ..."}`; `?cursor=` resumes; `?after=<epoch>` legacy cutoff |
| DELETE | `/logs` | Same 400; 404 `{"error":"log directory not found"}`; 200 `{"success":true,"message":"Logs cleared successfully","removed":<n>}` (rotated files removed, `main.log` truncated) |
| GET | `/request-error-logs` | 200 `{"files":[{"name","size","modified"}...]}` sorted by `modified` desc; `{"files":[]}` when `request-log` is enabled or the dir is missing |
| GET | `/request-error-logs/:name` | Only `error-*.log` names; otherwise 404 `{"error":"log file not found"}`; `/` or `\` in name → 400 `{"error":"invalid log file name"}`; success streams the file as attachment |
| GET | `/request-log-by-id/:id` | Suffix match `*-<requestID>.log`; missing id → 400 `{"error":"missing request ID"}`; `/`/`\` in id → 400 `{"error":"invalid request ID"}`; with `logging-to-file:false` and no log directory present → 404 `{"error":"log directory not found"}` (RECORDED); with a log directory present but no matching file → 404 `{"error":"log file not found for the given request ID"}`; success streams the file as attachment |

**Plugins** (HTTP envelopes only; plugin runtime out of scope)

`/v0/resource/plugins/**` is also registered through the no-route fallback: NO management auth applies, and with the plugin host off every request is an unconditional **404 with an empty body** (evidence: `internal/api/server_management.go` `pluginResourceNoRoute`).

| Method | Path | Contract |
|---|---|---|
| GET | `/plugins` | 200 `{"plugins_enabled":bool,"plugins_dir":"<dir>","plugins":[{"id","path","configured","registered","enabled","effective_enabled","supports_oauth","oauth_provider","supports_quota","quota_provider"?,"logo","config_fields":[..],"menus":[..],"metadata"?}]}` |
| GET | `/plugins/:id/config` | 200 with the stored config object (or `{}` when registered/discovered but unconfigured); 404 `{"error":"plugin_not_found","message":"plugin not found"}` |
| PUT/PATCH | `/plugins/:id/config` | Body = JSON object merge (PUT replaces, PATCH merges); 400 `{"error":"invalid_body","message":...}`; 200 `{"status":"ok"}` |
| PATCH | `/plugins/:id/enabled` | Body `{"enabled":bool}`; 400 `{"error":"invalid_body","message":"enabled is required"}`; 200 `{"status":"ok"}` |
| DELETE | `/plugins/:id` | 404 `plugin_not_found`; 409 `{"error":"plugin_delete_requires_restart","message":"loaded plugin cannot be deleted while the server is running","restart_required":true}`; 200 `{"status":"ok","deleted":<bool>}` |
| GET/POST/DELETE | `/plugins/:id/quota` (+ POST `/plugins/:id/quota/reset`) | `?auth_index=` (or JSON body for POST); missing → 400 `{"error":"auth_index is required"}`; unknown auth_index → 404 `{"error":"auth not found"}` (checked before the plugin); unknown plugin → 404 `{"error":"quota provider not found for plugin"}` |
| GET | `/plugin-store` | External registry listing — see §8 |
| POST | `/plugin-store/:id/install` | External — see §8 |
| Invalid `:id` (fails plugin-id validation) | any `/plugins/:id/**` | 400 `{"error":"invalid_plugin_id","message":"invalid plugin id"}` |

**OAuth session management**

| Method | Path | Contract |
|---|---|---|
| GET | `/anthropic-auth-url`, `/codex-auth-url`, `/antigravity-auth-url`, `/kimi-auth-url`, `/xai-auth-url`, `/devin-auth-url`, `/meta-auth-url` | 200 `{"status":"ok","url":"<vendor authorize URL>","state":"<random>"}`; spawns a background wait (success path CREDENTIALED-ONLY — see §8); 500 `{"error":"failed to generate PKCE codes"}` etc. on internal failures |
| GET | `/get-auth-status` | `?state=`; empty/missing state → 200 `{"status":"ok"}` (recorded, STEP 1); invalid state (path separator, >128 chars, bad charset) → 400 `{"error":"invalid state","status":"error"}` (recorded, STEPS 3-4); unknown/expired → **HTTP 200** `{"error":"unknown or expired state","status":"error"}` (recorded, STEP 2); pending → 200 `{"status":"wait"}`; completed → 200 `{"status":"ok"}`; errored session → 200 `{"error":"<session message>","status":"error"}` |
| DELETE | `/oauth-session` | `?state=` required; missing → 400 `{"error":"missing state","status":"error"}` (recorded, STEP 5); invalid → 400 `{"error":"invalid state","status":"error"}`; success 200 `{"cancelled":<bool>,"status":"ok"}` (recorded, STEP 6: `{"cancelled":false,"status":"ok"}` for an unknown state) |
| GET/POST | `/oauth-callback` | **No management key required** (availability middleware only). POST body `{"provider"?,"redirect_url"?,"code"?,"state"?,"error"?}`; GET equivalent query params (`error` falls back to `error_description`; `redirect_url` is parsed for `state`/`code`/`error` when direct fields are empty). NON-JSON body → 400 `{"error":"invalid body","status":"error"}` (recorded, STEP 12); a valid-JSON but state-less body (e.g. `{}` or `{"code":"x"}`) → 400 `{"error":"state is required","status":"error"}` (recorded, STEPS 8-9); state present but no code/error → 400 `{"error":"code or error is required","status":"error"}` (recorded, STEP 11). Other 400s: `"invalid state"`, `"unsupported provider"`, `"provider does not match state"`. 404 `{"error":"unknown or expired state","status":"error"}` (recorded, STEP 7); 409 `"oauth flow is already completed"` / `"<session error message>"` / `"oauth flow is not pending"`; success 200 `{"status":"ok"}`. All envelope bodies marshal gin.H keys ALPHABETICALLY (`error` before `status`). |

**Misc**

| Method | Path | Contract |
|---|---|---|
| GET | `/model-definitions/:channel` | ONLY this path form is registered. `GET /model-definitions` — with or without `?channel=` — matches NO route and returns **404 with an empty body** (R-404; recorded, STEPS 1-2). An unknown `:channel` in the path → 400 `{"channel":"<channel>","error":"unknown channel"}` (recorded, STEP 5). A known channel → 200 `{"channel":"<lowercased channel>","models":[<static catalog>]}` — each model entry is a STRUCT-ordered, full-field object: `id`, `object` (`"model"`), `created` (epoch, static), `owned_by`, `type`, `display_name`, `description`, `context_length`, `max_completion_tokens`, `supportedInputModalities` (camelCase), `supportedOutputModalities` (camelCase), and `thinking` only for thinking-capable models (recorded for `kimi`: `{"id":"kimi-k2","object":"model","created":1752192000,"owned_by":"moonshot","type":"kimi","display_name":"Kimi K2","description":"...","context_length":131072,"max_completion_tokens":32768,"supportedInputModalities":["text"],"supportedOutputModalities":["text"]}`). DO NOT confuse this with `GET /auth-files/models`, whose entries are the 4-key alphabetical form `{"display_name","id","owned_by","type"}` (§2.3 auth-files table). Supported channels (source: `internal/registry/model_definitions.go` `GetStaticModelDefinitionsByChannel`): `claude`, `gemini`, `gemini-interactions`, `vertex`, `aistudio`, `codex`, `kimi`, `antigravity`, `xai`/`x-ai`/`grok`, `devin`, `meta`/`muse`. The handler's query-param fallback and its `{"error":"channel is required"}` branch are unreachable on the anchored binary (the route requires `:channel`). |
| POST | `/api-call` | Body `{"auth_index"? ("authIndex"/"AuthIndex" aliases),"method","url","proxy_url"?,"header"?,"data"?}`; 400 `{"error":"invalid body"}`, `{"error":"missing method"}`, `{"error":"missing url"}`, `{"error":"invalid url"}`, `{"error":"invalid proxy_url"}`, `{"error":"auth token not found"}`, `{"error":"auth token refresh failed"}`; 502 `{"error":"request failed"}`, `{"error":"failed to read response"}`; success 200 `{"status_code":<int>,"header":{<name>:["<value>",...]},"body":"<string>"}` — `header` is a Go multi-map: every value is an ARRAY of strings (recorded: `{"Content-Length":["100"],"Content-Type":["application/json"],"Date":[...],"Server":[...]}`); `body` preserves the upstream bytes verbatim as a string. `$TOKEN$` in header values / body is substituted from the selected credential (access_token → api_key → token/id_token/cookie); with NO `auth_index` selected, `$TOKEN$` passes through VERBATIM (recorded on the wire: `X-S5-Token: Bearer $TOKEN$`). Upstream requests are sent with `User-Agent: Go-http-client/1.1`. Default timeout 60 s. Proxy precedence: request `proxy_url` > credential proxy > global `proxy-url` > direct. Header key `host` (any case) sets the request Host instead of a header. |

There is NO restart endpoint. Config mutations hot-reload in place (save + async reload; evidence: `internal/api/handlers/management/handler.go` `persistLocked`/`reloadConfigAfterManagementSaveAsync`). `POST /api-call` is the only outbound-proxy helper.

---

## 3. Schemas

**JSON marshaling regimes (byte-exact contract material; confirmed by recordings):**
- Bodies built as Go maps (`gin.H`) marshal keys **ALPHABETICALLY** — e.g. `{"cancelled":false,"status":"ok"}`, `{"changed":["config"],"ok":true}`, `{"disabled":true,"status":"ok"}`, every error body `{"error":"...","message"?}`.
- Bodies built from structs marshal in **struct field-declaration order** — e.g. provider list entries (`{"api-key":...,"base-url":...,"models":[...],"auth-index":...}`), the `GET /config` object, and api-key-usage entries (`success`,`failed`,`recent_requests`).
- Contract tests must compare the recorded byte order for each body.

### 3.1 `GET /config` — effective config object

The response is the full runtime `Config` marshaled to JSON (Go pointer-to-copy marshals the struct; evidence: `internal/api/handlers/management/config_basic.go` `GetConfig`). Fields whose JSON tag is `-` are hidden: `host`, `port`, `auth-dir`, `remote-management`, `home`. The recorded reference body (probe `13-mgmt-valid-bearer`, oracle-local-key-1 config) is normative for field names; key excerpt (values are from the recorded bootstrap oracle config — one api key, no providers):

```json
{"proxy-url":"","disable-image-generation":false,"force-model-prefix":false,
"request-log":false,"claude-code":{"disable-cloaking-model-list":false},
"api-keys":["oracle-local-key-1"],"passthrough-headers":false,"streaming":{},
"tls":{"enable":false,"cert":"","key":""},
"credential-concurrency":{...},"credential-in-flight":{...},
"plugins":{"enabled":false,"dir":"plugins","configs":{}},
"debug":false,"pprof":{"enable":false,"addr":"127.0.0.1:8316"},
"discovery":{...},"commercial-mode":false,"logging-to-file":false,
"logs-max-total-size-mb":0,"error-logs-max-files":10,
"usage-statistics-enabled":false,"redis-usage-queue-retention-seconds":60,
"disable-cooling":false,"save-cooldown-status":false,
"transient-error-cooldown-seconds":-1,"auth-auto-refresh-workers":0,
"request-retry":0,"max-retry-credentials":0,"max-retry-interval":0,
"quota-exceeded":{"switch-project":false,"switch-preview-model":false,"antigravity-credits":false},
"routing":{},"ws-auth":true,"antigravity":{"connection-pool":{}},"devin":{},
"gemini-api-key":null,"interactions-api-key":null,"codex-api-key":null,
"xai-api-key":null,"meta-api-key":null,
"xai":{"inject-x-search":false},
"codex":{...},"codex-header-defaults":{"user-agent":"","beta-features":""},
"claude-api-key":null,
"claude-header-defaults":{"user-agent":"","package-version":"","runtime-version":"","os":"","arch":"","timeout":"","timezone":""},
"disable-claude-cloak-mode":false,"openai-compatibility":null,"vertex-api-key":null,
"payload":{"default":null,"default-raw":null,"override":null,"override-raw":null,"filter":null}}
```

With the current oracle fleet template (all 8 mock providers wired) the same response contains all eight provider lists populated under these exact field names; the S5-config-get golden records that variant.

MUST: the response contains `api-keys`, `claude-api-key`, `codex-api-key`, `xai-api-key`, `meta-api-key`, `gemini-api-key`, `interactions-api-key`, `vertex-api-key`, `openai-compatibility` with the config-list shapes of §3.3, and MUST NOT contain `remote-management`, `host`, `port`, `auth-dir`. Absent provider lists marshal as `null`.

### 3.2 Scalar/toggle bodies

PUT/PATCH body: `{"value": <value>}`. `value` MUST be present and of the right JSON type (bool/string/int); anything else (including `{}` or `{"value":null}`) → 400 `{"error":"invalid body"}`. GET responses use exactly one key named after the config key (`{"debug":false}`, `{"proxy-url":""}`, `{"request-retry":0}`, `{"strategy":"round-robin"}`, `{"switch-project":false}`, ...).

### 3.3 Provider list entries

Common fields (JSON names; evidence: `internal/config/config_types.go`):
- `GeminiKey` (gemini/interactions): `api-key`, `priority`?, `weight`?, `prefix`?, `base-url`?, `proxy-url`?, `models`? `[{name,alias,display-name?,max-context-length?,force-mapping?,is-compat?,thinking?}]`, `headers`?, `excluded-models`?, `disable-cooling`?, `request-retry`?, `request-scoped-errors`?.
- `ClaudeKey`: adds `rebuild-mid-system-message`?, `cloak`?, `fingerprint-profile`?, `experimental-cch-signing`?; models add nothing else.
- `CodexKey` (codex/xai/meta): adds `websockets`? (xai only in patch), `alpha-search`? (codex).
- `VertexCompatKey`: `api-key`, `priority`?, `weight`?, `prefix`?, `base-url`?, `proxy-url`?, `headers`?, `models`?, `excluded-models`?, `disable-cooling`?, `request-retry`?.
- `OpenAICompatibility`: `name`, `priority`?, `disabled`, `prefix`?, `base-url`, `api-key-entries`? `[{api-key,weight?,proxy-url?}]`, `models` `[{name,alias,display-name?,max-context-length?,force-mapping?,image?,input-modalities?,output-modalities?,is-compat?,thinking?}]`, `headers`?, `support-prompt-cache-key`?, `disable-cooling`?, `request-retry`?, `request-scoped-errors`?.

GET responses wrap each entry with an additional `"auth-index"` field (runtime credential index). Recorded facts: single-key providers (gemini/claude/codex/xai/meta/vertex/interactions) carry a real entry-level `auth-index` when the credential is live; for `openai-compatibility` entries that define `api-key-entries`, the ENTRY-level `auth-index` is empty (omitted from JSON) and EACH api-key entry carries its own real `auth-index` (recorded: `{"api-key":"s5-mock-key","auth-index":"1152a183f8c6a0c6"}`). Provider entries marshal in STRUCT order (name, disabled, base-url, api-key-entries, models — not alphabetical). PATCH partial bodies touch only supplied fields (`weight` accepts integer or `null` to clear; `disable-cooling` accepts boolean or `null` — other types → 400 `{"error":"disable-cooling must be a boolean or null"}`).

PATCH selector rules (evidence: `config_lists.go`):
- `index` used when in range; else `match` (api-key string; gemini/interactions additionally narrow with `?base-url=`; more than one match → 400 `{"error":"multiple items match; index is required"}`); openai-compatibility uses `name` instead of `match`.
- No match → 404 `{"error":"item not found"}`.
- DELETE `?api-key=` with >1 match → 400 `{"error":"multiple items match api-key; base-url is required"}`; `?index=` out of range falls through to 400 `missing api-key or index` (or `missing name or index`).

### 3.4 `GET /auth-files` entry

The entry object is a `gin.H` map → all keys marshal ALPHABETICALLY. Recorded entry for an uploaded `{"type":"kimi","email":"s5@example.com"}` file (dynamic values masked):

```json
{"account":"s5@example.com","account_type":"oauth","auth_index":"<16-hex>",
"cooldowns":[],"created_at":"<LOCAL RFC3339>","disabled":false,"email":"s5@example.com",
"failed":0,"id":"s5-kimi.json","label":"s5@example.com","last_refresh":"<LOCAL RFC3339>",
"modtime":"<LOCAL RFC3339>","name":"s5-kimi.json","note":"s5-note-value",
"path":"/root/.cli-proxy-api/s5-kimi.json","priority":7,"provider":"kimi",
"quota":{"signals":{}},"recent_requests":[{"time":"HH:MM-HH:MM","success":0,"failed":0}, ...20 buckets...],
"runtime_only":false,"size":<bytes>,"source":"file","status":"active","status_message":"",
"success":0,"type":"kimi","unavailable":false,"updated_at":"<LOCAL RFC3339>"}
```

Recorded field semantics:
- `cooldowns` is an EMPTY ARRAY `[]` when no cooldowns are active (Home mode disabled) — not null.
- `quota` is `{"signals":{}}` when nothing has been observed; `observed_at` appears inside `quota` only after an observation.
- `recent_requests` is a fixed array of 20 ten-minute WALL-CLOCK buckets `{"time":"HH:MM-HH:MM","success":n,"failed":n}` (bucket labels are recording-time dynamic fields).
- `created_at`/`modtime`/`updated_at`/`last_refresh` serialize the server's LOCAL time zone offset (recorded: `+08:00`), while the envelope `observed_at` is UTC (`Z`). Contract tests mask timestamps but MAY assert the presence of an offset in entry fields.
- `note` and `priority` appear after `PATCH /auth-files/fields`; `account`/`account_type`/`project_id` appear per provider (vertex entries carry `project_id`; email-based providers carry `account`/`account_type:"oauth"`).
- `size` is the byte size of the persisted file on disk.
- `id` equals the file name for file-backed credentials (`s5-kimi.json`); `path` is the absolute in-container path (masked).
- Other optional keys appear only when applicable: `model_quotas`, `supports_quota`, `quota_provider`, `quota_probe`, `next_retry_after`, `id_token` (codex claims: `chatgpt_account_id`, `plan_type`, ...), `weight`, `websockets`, `request_retry`.

List-level envelope (gin.H, alphabetical): `{"files":[...],"observed_at":"<UTC RFC3339>"}`; `files` is sorted case-insensitively by `name`.

The persisted auth FILE itself is canonicalized by the reference (recorded download bytes): `{"disabled":false,"email":"s5@example.com","note":"s5-note-value","priority":7,"type":"kimi"}` — alphabetical keys, `disabled` flag always persisted, patched fields included.


### 3.5 `GET /api-key-usage` / `GET /usage-queue`

- `api-key-usage`: object; first level keyed by provider, second level keyed by the composite string `"<base_url>|<api_key>"`; entries (struct order): `{"success":int,"failed":int,"recent_requests":[...]}`. Recorded facts on the fleet config with zero traffic: provider keys are `claude`, `codex`, `gemini`, `gemini-interactions`, `meta`, `mock-openai`, `vertex`, `xai` — openai-compatibility entries key under the provider NAME (`compat_name`), and the interactions provider keys as `gemini-interactions`; the composite key keeps the FULL configured base-url including any path suffix (recorded: `http://host.docker.internal:21999/v1|mock-upstream-key`); `recent_requests` is the same fixed 20-bucket wall-clock array as the auth-files entry.
- `usage-queue`: JSON array; each element is the raw queued usage record object (verbatim JSON), or a JSON string when the record bytes are not valid JSON. Records are POPPED (destructive read), oldest first. Recorded empty state: `[]` (any `count`).

### 3.6 OAuth session payloads

- auth-url endpoints: `{"status":"ok","url":"<authorize URL with PKCE/state>","state":"<state>"}`.
- `get-auth-status` / `oauth-session` / `oauth-callback`: envelope `{"status":"ok"|"wait"|"error","error"?:string,"cancelled"?:bool}` with gin.H keys marshaled ALPHABETICALLY on the wire (recorded: `{"cancelled":false,"status":"ok"}`, `{"error":"state is required","status":"error"}`). `status:"error"` responses still use HTTP 200 on `get-auth-status`, but 400/404/409 on `oauth-callback` and 400 on `oauth-session`.
- State validation: trimmed, non-empty, ≤128 chars, no `/`, no `\`, no `..`, printable ASCII letters/digits only (evidence: `internal/api/handlers/management/oauth_sessions.go` `ValidateOAuthState`).

---

## 4. Streaming rules

- No management endpoint streams. All bodies are single JSON documents (or raw YAML/file bytes for `config.yaml`, `auth-files/download`, log downloads).
- Management responses never emit SSE; there are no `event:` frames, no `[DONE]` markers.
- The only indirectly streaming-adjacent endpoint is `POST /api-call`, which buffers the whole upstream response and returns it as a single JSON object (upstream status in `status_code`, upstream headers in `header`, upstream body as a string in `body`).
- Contract tests compare management responses byte-exactly after masking only the dynamic fields whitelisted per case (§6).

---

## 5. Error semantics

Common shape: `{"error":"<message>"}` — a single string field. Some endpoints add a sibling `"message"` string (`config.yaml` PUT, `latest-version`, plugin endpoints, `vertex/import` JSON errors, plugin store). Status code summary:

| Status | Producers |
|---|---|
| 400 | Malformed JSON bodies (`invalid body` family), missing selectors (note: the model-definitions `channel is required` branch is DEAD CODE on the anchored binary — see §8.9) (`missing index or value`, `missing api-key or index`, `missing name or index`, `missing provider`, `missing channel`, `name is required`, `auth_index is required`, `count must be a positive integer`, `invalid strategy`, `invalid name`, `name must end with .json`, `file must be .json`, `no files uploaded`, `invalid body`, `invalid_yaml`, `invalid url`, `missing method`, `missing url`, `missing state`, `invalid state`, `invalid plugin_id`, `weight must not exceed 1000000`, ...) |
| 401 | Missing/invalid management key (§2.2) |
| 403 | Remote management disabled; no secret; IP ban (§2.2) |
| 404 | Unknown route or wrong method (EMPTY body, R-404); `item not found` (provider list PATCH/DELETE); `provider not found` / `channel not found` (oauth maps); `auth file not found`; `auth not found` (quota/reset-quota); `file not found` (download); `not_found` (config.yaml GET); `plugin_not_found`; `log file not found`; `unknown or expired state` (oauth-callback) |
| 405 | NEVER used (wrong method → 404, R-404) |
| 409 | `oauth flow is already completed` / session error replay (oauth-callback); plugin virtual auth conflict |
| 422 | `invalid_config` (+`message`) on PUT `/config.yaml` |
| 500 | Save/persist failures (`failed to save config: ...`), internal generation errors, `handler unavailable`/`handler not initialized` |
| 501 | `no quota provider available for credential` (POST `/quota/fetch` with a resolved auth — recorded); `/quota/reset` variants `plugin host unavailable` / `no quota provider available for credential to reset` (only after auth resolution) |
| 502 | `request failed` / `failed to read response` (api-call transport errors); `latest-version` upstream failures; `failed to fetch quota: ...` |
| 503 | `core auth manager unavailable` (auth-file POST/DELETE/refresh/status/fields, api-key-usage, reset-quota); `configuration unavailable`; `Codex auth manager unavailable` style errors |

MUST: management error bodies never use the OpenAI error object shape (`{"error":{"message","type","code"}}`) — that shape is reserved for client-facing request errors (S1). The only field is `error` (string), plus optional `message`.

Config persist failures: every mutating handler that calls `persist` responds 500 `{"error":"failed to save config: <reason>"}` when the config file write fails; the in-memory value is NOT rolled back (best-effort semantics).

---

## 6. Golden samples index

Recordings: CLIProxyAPI v7.3.4 (docker image digest `sha256:97825da3009f98acf78b5c172fde650a5fbe7a690950a69ce6d7b535d77d4266`), oracle env per `reports/oracle/BOOTSTRAP.md` §3 (config: port 18317, `api-keys:["oracle-local-key-1"]`, `remote-management:{allow-remote:true, secret-key:"oracle-mgmt-key-1", disable-control-panel:true}`, `request-retry:0`, `transient-error-cooldown-seconds:-1`, `usage-statistics-enabled:false`; no real credentials). Management key value `oracle-mgmt-key-1` in fixtures is not a secret.

Fixtures live in `tests/fixtures/S5/<case-id>/` per the RECIPES layout (`meta.yaml`, `request.http`, `downstream.md`, `upstream.jsonl`, `mock-response.json` — `upstream.jsonl` is only used for `api-call` cases). All S5 goldens are RECORDABLE-LOCALLY: the management API is exercised against the reference binary directly; no upstream LLM is involved (the mission classification).

Recording environment (@oracle-runner-4 stack): reference on `127.0.0.1:8407`, mock upstreams on ports `21999` (openai), `22001` (gemini), `22002` (claude), `22003` (codex), `22004` (xai), `22005` (meta), `22006` (interactions), `22007` (vertex); management key `oracle-mgmt-key-1`; client api key `oracle-local-key-1`. PORT NUMBERS anywhere in a transcript (8407, 21999-22007, and URLs embedding them) are masked dynamic fields for contract replay; all other bytes are compared exactly. (The cases file `spec/recordings/S5.cases.json` was drafted against the oracle-runner-2 stack — 8387/19999-20007 — and oracle-runner-4 applies the mechanical port map 8387→8407, 19999→21999, 2000N→2200N when executing; the recorded fixtures carry the runner-4 ports.)

| case-id | purpose | fixture dir | dynamic fields (mask these) |
|---|---|---|---|
| S5-auth-missing-key | 401 missing management key + X-CPA-* header contract | `tests/fixtures/S5/S5-auth-missing-key/` | Date |
| S5-auth-invalid-key | 401 invalid management key | `tests/fixtures/S5/S5-auth-invalid-key/` | Date |
| S5-auth-header-styles | X-Management-Key style accepted (200) | `tests/fixtures/S5/S5-auth-header-styles/` | Date |
| S5-unknown-route | 404 empty body for unknown management sub-route (R-404) | `tests/fixtures/S5/S5-unknown-route/` | Date |
| S5-config-get | GET /config full effective-config JSON | `tests/fixtures/S5/S5-config-get/` | Date |
| S5-scalar-toggle | debug GET/PUT round trip + invalid body | `tests/fixtures/S5/S5-scalar-toggle/` | Date |
| S5-api-keys-crud | api-keys PUT/GET/PATCH/DELETE round trip + errors | `tests/fixtures/S5/S5-api-keys-crud/` | Date |
| S5-routing-strategy | routing strategy get/put/validation | `tests/fixtures/S5/S5-routing-strategy/` | Date |
| S5-openai-compat-crud | openai-compatibility full CRUD + list shape | `tests/fixtures/S5/S5-openai-compat-crud/` | Date, auth-index values |
| S5-gemini-key-crud | gemini-api-key CRUD + weight validation + delete selectors | `tests/fixtures/S5/S5-gemini-key-crud/` | Date, auth-index values |
| S5-vertex-key-validation | vertex-api-key required api-key + round trip | `tests/fixtures/S5/S5-vertex-key-validation/` | Date, auth-index values |
| S5-auth-files-roundtrip | auth-files list/upload/status/fields/download/delete | `tests/fixtures/S5/S5-auth-files-roundtrip/` | Date, observed_at, auth_index, created_at/modtime/updated_at, recent_requests, quota, cooldowns, path |
| S5-auth-files-errors | auth-files validation and 404 error family | `tests/fixtures/S5/S5-auth-files-errors/` | Date, observed_at, auth_index, timestamps |
| S5-usage-telemetry | api-key-usage {}, usage-queue [], count validation | `tests/fixtures/S5/S5-usage-telemetry/` | Date |
| S5-quota-endpoints | quota providers/fetch/reset on empty quota-provider state (incl. 501 with a real auth_index via AUX GET /gemini-api-key) | `tests/fixtures/S5/S5-quota-endpoints/` | Date, auth_index values |
| S5-logs-disabled | logs endpoints in logging-disabled state + request-log toggle (recorded request-log-by-id variant: `log directory not found`) | `tests/fixtures/S5/S5-logs-disabled/` | Date |
| S5-model-definitions | :channel catalog (kimi full static list), unknown-channel 400, and the 404-empty query-form route gap | `tests/fixtures/S5/S5-model-definitions/` | Date |
| S5-oauth-session | get-auth-status / oauth-session cancel / oauth-callback error family incl. non-JSON body `invalid body` (no key needed for oauth-callback) | `tests/fixtures/S5/S5-oauth-session/` | Date |
| S5-api-call-mock | api-call against local mock + url/method validation | `tests/fixtures/S5/S5-api-call-mock/` | Date, upstream header map (Date/Content-Length of mock reply) |
| S5-vertex-import | vertex service-account import (synthetic RSA-2048 PKCS#8 PEM embedded) + cleanup + error paths incl. the recorded fake-PEM 400 (STEP 9, gate-round-1 B2) — 9 steps | `tests/fixtures/S5/S5-vertex-import/` | Date, auth-file path, auth dir paths, observed_at/auth_index/timestamps/size in list |
| S5-config-yaml | config.yaml GET raw bytes + PUT validation/round trip | `tests/fixtures/S5/S5-config-yaml/` | Date, bcrypt secret-key hash in YAML bytes |
| S5-plugins-list | plugins list empty state + invalid id + enabled validation | `tests/fixtures/S5/S5-plugins-list/` | Date |

Case definitions with exact requests: `spec/recordings/S5.cases.json`.

**Recording status (2026-09-16, @oracle-runner-4; amended after gate round 1):** all 22 cases RECORDED — 22 fixture directories, **168 request/response steps = 167 case steps + 1 AUX helper step** (disk-verified). The case-step total includes one optional step that was executed, the 2-step round-1 addendum (S5-model-definitions, S5-oauth-session), and the gate-round-1 B2 fix step — the fake-PEM rejection, appended to S5-vertex-import (STEP 9, re-run live; sent bytes byte-identical to the preserved side probe at `_cpa_edge_ref/run4/probes/S5/S5-vertex-import-drafted-content/`). All per-case `meta.yaml` dynamic_fields lists were deduped (globals: Date + port masking; case lists hold case-specific fields only) per review item N8. Zero cases skipped; the 6 `fixture_deferred` behaviors remain unrecorded by design. 17/22 cases matched the source-derived predictions byte-exactly; 5 deviations (model-definitions query-form 404-empty, quota/reset auth-first ordering, oauth-callback `{}` semantics, request-log-by-id variant, gin.H alphabetical key order) are folded into §2.3/§3 above and carried as recorded bytes in the fixtures. Raw evidence: `_cpa_edge_ref/run4/probes/S5/` (boot logs, exact request bytes, structured responses, and the `S5-vertex-import-drafted-content` side recording). Each fixture `meta.yaml` lists per-step `http_status`, `expect_status`, mismatch verdicts, and the masked dynamic fields.

---

## 7. Classification (RECORDABLE-LOCALLY vs CREDENTIALED-ONLY) for S5

RECORDABLE-LOCALLY (goldens recorded): all of §6 — management CRUD against the reference binary, `api-call` through the local mock upstream, `vertex/import` with a synthetic service account, error families, auth failures.

FIXTURE-DEFERRED (specified, not recorded; reasons):
- OAuth provider flows success path (`*-auth-url` → vendor login → credential saved): needs real vendor accounts; response `url`/`state` are per-request random. Error envelopes of the sibling endpoints ARE recorded (S5-oauth-session).
- `POST /auth-files/refresh` success (`{"ok":true,"auth":...}` / `results`): performs real vendor token refresh over the network; the validation errors (400 `name or all=true is required`, 404 `auth file not found`) are recorded in S5-auth-files-errors.
- `GET /latest-version`: response is the live GitHub release tag — version-dependent, non-deterministic; specified shape only.
- Plugin store endpoints (`GET /plugin-store`, `POST /plugin-store/:id/install`, plugin release/quota success paths): depend on the external plugin registry network and content; only the local no-plugin envelopes are recorded (S5-plugins-list).
- Log endpoints with `logging-to-file:true`: enabled-state goldens EXIST in `tests/fixtures/S7/S7-10` (`logs-enabled-lines-and-clear`, recorded by oracle-runner-3) — S5 defers to those for the enabled-state bodies (`/logs` lines/cursor, `DELETE /logs` success, error-log listing); S5-logs-disabled pins the disabled-state envelopes on the management surface. No S5 follow-up recording needed.
- `auth-files` list with live OAuth credentials (quota/usage fields populated): CREDENTIALED-ONLY; the synthetic-file entry shape is recorded instead.

---

## 8. Open questions and intentional non-equivalences

1. `get-auth-status` returns HTTP 200 with `{"error":...,"status":"error"}` for failed flows (quirk); upstream clients poll this endpoint. CPA-Edge MUST mirror the 200-with-error-body behavior — recorded in S5-oauth-session STEP 2 (unknown state → 200 `{"error":"unknown or expired state","status":"error"}`).
2. The upstream server HASHES the plaintext `secret-key` in the mounted config file on startup (bcrypt) and hot-reloads `config.yaml` on change. Whether CPA-Edge persists the same bcrypt normalization is a runtime/store concern (S6); S5 requires only that the PLAINTEXT value remains the accepted key after any in-place mutation, and that `GET /config` never exposes `remote-management`.
3. RESOLVED (gate round 1 ruling, `reports/adversary/S5.md` N2): CPA-Edge MIRRORS upstream — `GET /config` exposes the full effective config including all provider API keys (management key required). The resolution (MIRROR) is recorded in S7's round-2 amendment.
4. RESOLVED by recording: an empty provider list returns `{"<path>":[]}` from the list endpoints (S5-gemini-key-crud STEP 14: `{"gemini-api-key":[]}`) while `GET /config` shows the same lists as `null` when unset (bootstrap probe 13). Both forms are contract-testable against their respective goldens.
5. `PATCH /auth-files/fields` accepts arbitrary metadata keys; the full normalization/canonicalization matrix (e.g. `model_aliases` vs `model-aliases`) is only partly covered here; S6 owns the auth-file schema.
6. The IP-ban window (5 failures / 30 min) is part of the auth contract (S3); S5 records only the 401 paths to avoid leaving the oracle banned. The ban message format is specified but the golden is not recorded (non-deterministic duration).
7. `usage-queue` pops records destructively; repeated GETs return different arrays. Golden recorded only for the empty/validated state. A seeded-queue golden would need a deterministic producer; deferred as a S6 concern.
8. `PUT /config.yaml` accepts any YAML that parses and validates; the recorded golden uses the exact oracle fleet config with a changed `request-retry` (success body `{"changed":["config"],"ok":true}`). Whether CPA-Edge accepts byte-identical YAML (comment preservation) is a store concern (S6).
9. `/model-definitions/:channel` exists ONLY in path form; the query-param fallback and its `channel is required` 400 are dead code on the anchored binary (query-form requests 404 empty). CPA-Edge registers the route the same way; the dead branches are OPTIONAL to implement but, if present, must not be reachable.
10. `PATCH /auth-files/fields` persists a canonicalized JSON file (alphabetical keys, `disabled` flag, patched fields) — recorded via the download golden. Whether CPA-Edge persists the caller's exact uploaded bytes instead is an intentional non-equivalence candidate; the wire-visible list/download contract is what the goldens pin.
11. Entry timestamps in `GET /auth-files` serialize the server's LOCAL UTC offset while the envelope `observed_at` is UTC. CPA-Edge may emit a fixed-offset form; contract tests mask timestamps, but the offset format (`±HH:MM`) must be present if the field is emitted at all.
