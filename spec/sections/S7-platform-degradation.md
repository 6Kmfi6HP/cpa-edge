# S7 — Platform degradation matrix (Vercel & no-DO runtimes)

Anchor: CLIProxyAPI v7.3.4, commit `8335eac731946bd4eff18f500653f93736df53d6`, image `eceasy/cli-proxy-api:v7.3.4`.
Owner: @spec-writer (S7). Feeds SPEC §5 non-equivalence registry; every degradation below is INTENTIONAL-NON-EQUIVALENCE.

## 1. Scope and boundaries

**In scope**
- The six Node-bound upstream features and their classification per target runtime:
  F1 outbound proxy transport (`proxy-url`, incl. socks5), F2 C-ABI dynamic-library plugins,
  F3 file logging (rotating log files + logs API), F4 inbound WebSocket (`GET /v1/ws`),
  F5 local callback servers (OAuth localhost redirect forwarders + device user-code flow UX),
  F6 file watchers / hot-reload (config file + auth directory).
- The runtime capability contract that gates each feature, and the exact substitute behavior
  (status code + body bytes) observed by clients when a capability is missing.
- Upstream goldens proving each degraded feature is real, config-accepted, and client-visible.

**Out of scope**
- Route/shape details of management endpoints (S5) — S7 references them as observables only.
- OAuth flow semantics (S3) — S7 specifies only platform applicability of each flow kind.
- The WebSocket relay message protocol (`wsrelay` JSON protocol after the 101 upgrade) — executor
  territory; S7 pins the handshake-level surface and the degradation of the route.
- Config persistence schemas (S6).

**Target runtimes**
- `runtimes/node` — reference runtime; all contract tests run against it (T1).
- `runtimes/cloudflare` — Durable Objects store, alarms, WebSocket hibernation (T2).
- `runtimes/vercel` — serverless functions, degraded per this section (T3).

## 2. Behavior inventory

### 2.1 Upstream behavior, per feature (evidence)

**F1 — Outbound proxy transport.**
- Config keys: global `proxy-url` (string; `config.example.yaml`); per-credential `proxy-url` on
  `gemini-api-key`, `interactions-api-key`, `codex-api-key`, `xai-api-key`, `meta-api-key`,
  `claude-api-key`, `vertex-api-key`, and `openai-compatibility.api-key-entries[]`.
  Evidence: `config.example.yaml`; `internal/config/sdk_config.go` (`ProxyURL`, json tag `proxy-url` — echoed by `GET /v0/management/config`).
- Value semantics (`sdk/proxyutil/proxy.go` `Parse`): `""` → inherit (upstream then honors
  environment proxies through Go's default transport); `"direct"`/`"none"` (case-insensitive) →
  explicit direct dial; URL with scheme `socks5|socks5h|http|https` + host → proxy mode; anything
  else → parse error.
- Transport construction (`sdk/proxyutil/proxy.go` `BuildHTTPTransport`/`BuildDialer`): socks5/socks5h
  via a SOCKS5 dialer; http via `http.ProxyURL`; https via `http.ProxyURL` + TLS-to-proxy dialer;
  HTTP CONNECT tunneling for connection-layer dialers. Raw TCP sockets are required.
- On parse/build failure upstream does NOT fail the request: it logs and falls back to the context
  round-tripper / default transport (i.e., direct). Evidence: `internal/runtime/executor/helps/proxy_helpers.go`
  (`NewProxyAwareHTTPClient`: "If proxy setup failed, log and fall through").
- Client-visible surface:
  - `GET/PUT/PATCH/DELETE /v0/management/proxy-url` (`internal/api/handlers/management/config_basic.go`):
    GET → `200 {"proxy-url": "<string>"}`; PUT/PATCH body `{"value": "<string>"}` → `200 {"status":"ok"}`
    (or `400 {"error":"invalid body"}`); DELETE → clears, `200 {"status":"ok"}`. No scheme validation happens here.
  - `POST /v0/management/api-call` (`internal/api/handlers/management/api_tools.go`): request field
    `proxy_url` (highest priority over credential/global proxy); invalid value → `400 {"error":"invalid proxy_url"}`;
    transport failure during the call → `502 {"error":"request failed"}`; success →
    `200 {"status_code": <upstream status>, "header": {...}, "body": "<upstream body>"}`.

**F2 — C-ABI dynamic-library plugins.**
- Config block `plugins` (`enabled`, `dir` default `"plugins"`, `store-sources`, `store-auth`,
  `configs.<id>.*`). Evidence: `config.example.yaml`; `internal/config/config.go` (`Plugins PluginsConfig`).
- Loading is `dlopen` behind cgo: plugin must export `cliproxy_plugin_init`, negotiate an ABI version,
  and speak a JSON method protocol over a C function table. Platforms without cgo get a stub loader
  that always fails. Evidence: `internal/pluginhost/loader_unix.go`, `internal/pluginhost/loader_unsupported.go`.
- Client-visible surface (`internal/api/handlers/management/plugins.go`,
  routes in `internal/api/server_management.go`):
  - `GET /v0/management/plugins` → `200 {"plugins_enabled": <bool>, "plugins_dir": "<resolved>", "plugins": [...]}`;
    entries carry `id, path, configured, registered, enabled, effective_enabled, supports_oauth,
    oauth_provider, supports_quota, quota_provider, logo, config_fields, menus, metadata`.
    A config-only plugin (no binary on disk) shows `configured:true, registered:false, effective_enabled:false`.
  - `GET/PUT/PATCH /v0/management/plugins/:id/config`, `PATCH /plugins/:id/enabled` (`{"enabled": bool}`),
    `DELETE /plugins/:id` → `200 {"status":"deleted","id":...,"path":...,"file_deleted":bool,"configured_removed":bool,"restart_required":false}`,
    `GET /plugins/:id/config` for unknown id → `404 {"error":"plugin_not_found","message":"plugin not found"}`.
  - `GET /v0/management/plugin-store`, `POST /plugin-store/:id/install` — live registry fetch + binary download.
- Plugin-provided executors, auth providers, management routes, and command-line flags exist only when a binary loads.

**F3 — File logging.**
- Config keys: `logging-to-file` (default false), `logs-max-total-size-mb` (default 0), `error-logs-max-files`
  (default 10). Evidence: `config.example.yaml`; `internal/config/config.go`.
- Toggles: `GET/PUT/PATCH /v0/management/logging-to-file` → `200 {"logging-to-file": <bool>}` /
  `{"status":"ok"}`; same pattern for the two size keys (`{"value": <int>}`, negatives clamped per handler).
  Evidence: `internal/api/handlers/management/config_basic.go`.
- Log files live under `<auth-dir>/logs/` (NOT next to `config.yaml`): recorded in S7-10
  (`/root/.cli-proxy-api/logs/main.log` in the container, i.e. the mounted auth dir); empty until
  `logging-to-file` is enabled. Independently of `logging-to-file`, per-request error dumps
  (`error-*.log`, containing request+response bytes) are written to the same directory whenever an
  error response is produced, subject to `error-logs-max-files` retention (recorded in S7-10: dumps
  exist while `logging-to-file: false`). Evidence: `internal/api/handlers/management/logs.go`,
  `internal/logging/` (rotation), S7-10 transcript + aux-logs.
- File content API (`internal/api/handlers/management/logs.go`):
  - `GET /v0/management/logs` → if `logging-to-file` is false: `400 {"error":"logging to file disabled"}`.
    If true: `200 {"lines":[...],"line-count":N,"latest-timestamp":<epoch>,"next-cursor":"<string>"}`
    (+ `"cursor-reset":true` after a cursor reset); supports `limit`, `after`, `cursor` query params.
  - `DELETE /v0/management/logs` → `400 {"error":"logging to file disabled"}` when off; when on
    truncates `main.log` and removes rotated files → `200 {"success":true,"message":"Logs cleared successfully","removed":N}`.

**F4 — Inbound WebSocket (`GET /v1/ws`).**
- The route is always registered on the main engine (GET only), wrapped in a conditional API-key
  middleware that is active whenever `ws-auth` is not explicitly `false` — the config loader presets
  `WebsocketAuth = true` before unmarshal, so an ABSENT key means AUTH REQUIRED.
  Evidence: `internal/config/config_load.go` + `internal/config/parse.go` (both: `cfg.WebsocketAuth = true`
  default), `sdk/cliproxy/service_lifecycle.go` (`ensureWebsocketGateway`, `AttachWebsocketRoute`),
  `internal/api/server_routes.go` (`AttachWebsocketRoute`), `internal/config/config.go` (`WebsocketAuth`),
  `internal/wsrelay/manager.go` (`path "/v1/ws"`, `CheckOrigin` allows all origins);
  recorded: S7-01 (unset → 401), S7-02 steps 2-6.
- Upgrade is gorilla/websocket v1.5.3 (`go.mod`): a GET that passes the auth gate but lacks
  `Connection: upgrade` → `400`, body `Bad Request\n` (`http.Error` writes `http.StatusText(400)`), header
  `Sec-Websocket-Version: 13`, `Content-Type: text/plain; charset=utf-8`, `X-Content-Type-Options: nosniff`
  (S7-02 recorded headers). A complete handshake →
  `101 Switching Protocols` with `Sec-WebSocket-Accept: base64(SHA1(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))`
  (verified live in S7-04; server sends nothing before the client's close frame and echoes it).
  Evidence: module cache `gorilla/websocket@v1.5.3/server.go` (`Upgrade`, `returnError`).
- Auth gate (active unless `ws-auth: false`): missing key → `401 {"error":"Missing API key"}`,
  invalid key → `401 {"error":"Invalid API key"}` (same middleware as all client routes; bootstrap probes
  05/06; recorded in S7-01/S7-02).
- `POST /v1/ws` → gin `404` empty body (wrong method on a registered route, R-404); `OPTIONS /v1/ws` →
  auto-answered `204` + CORS, no auth (bootstrap probe 03).
- On successful upgrade the session registers a synthetic runtime-only credential
  (`provider: aistudio`, id `aistudio-<16 lowercase alnum>`); enabling `ws-auth` while sessions are live
  terminates them. Evidence: `sdk/cliproxy/service_auth.go`, `internal/api/server_reload.go` / `service_lifecycle.go`
  (`SetWebsocketAuthChangeHandler`).
- `GET/PUT/PATCH /v0/management/ws-auth` → `200 {"ws-auth": <bool>}` / `{"status":"ok"}`.

**F5 — Local callback servers (OAuth redirect + device flows).**
- Provider-redirect callback routes served on the MAIN port, no auth
  (`internal/api/server_routes.go`): `GET /anthropic/callback`, `/codex/callback`, `/antigravity/callback`
  always → `200`, `Content-Type: text/html; charset=utf-8`, fixed body
  `<html><head><meta charset="utf-8"><title>Authentication successful</title><script>setTimeout(function(){window.close();},5000);</script></head><body><h1>Authentication successful!</h1><p>You can close this window.</p><p>This window will close automatically in 5 seconds.</p></body></html>`
  (they persist `code`/`state`/`error` only when `state` matches a pending session).
  `GET /callback` and `/devin/callback` validate: missing `code`+`error` → `400 {"error":"code or error is required"}`;
  no pending session → `400 {"error":"invalid or expired OAuth callback"}`; success → the same fixed HTML
  (`Cache-Control: no-store` set by the devin handler).
- OAuth start endpoints (management-authenticated): `GET /v0/management/{anthropic,codex,antigravity,devin,kimi,xai,meta}-auth-url`.
  - Redirect flows (anthropic/codex/antigravity/devin) return `200 {"status":"ok","url":"<provider URL>","state":"<state>"}`
    and spawn a background wait (5 min) for a callback file. Evidence:
    `internal/api/handlers/management/auth_files_provider_oauth.go`.
  - With `?is_webui=1` (values `1|true|yes|on`, case-insensitive) they ALSO bind a localhost forwarder:
    anthropic `0.0.0.0:54545`, codex `0.0.0.0:1455`, antigravity `0.0.0.0:51121`
    (`internal/api/handlers/management/auth_files_oauth_callback.go` + `internal/auth/antigravity/constants.go`).
    The forwarder answers any path with `302 Found` → `http(s)://127.0.0.1:<server-config-port>/<provider>/callback?<same query>`
    and `Cache-Control: no-store`; body is Go's default redirect HTML (`<a href="...">Found</a>.`), and it carries NO CORS
    headers (raw Go http server, not the gin stack — recorded in S7-13). It stops when the session ends.
    Bind failure → `500 {"error":"failed to start callback server"}`.
  - Device flows (kimi/xai/meta) call the vendor device-authorization endpoint and return
    `200 {"status":"ok","url":...,"state":"<vendor-prefixed UnixNano>","flow":"device","user_code":...,"expires_in":N}` —
    no inbound socket is involved. Evidence: `auth_files_provider_oauth.go` (`RequestXAIToken` etc.), `sdk/auth/{kimi,xai,meta}.go`.
- OAuth session registry (all runtimes, pure HTTP):
  - `GET/POST /v0/management/oauth-callback` — registered OUTSIDE the management auth group (availability
    middleware only). Error ladder (`internal/api/handlers/management/oauth_callback.go`):
    bad JSON → `400 {"status":"error","error":"invalid body"}`; missing state → `400 ... "state is required"`;
    malformed state → `400 ... "invalid state"` (state charset: `[A-Za-z0-9._-]`, no `/`, `\`, `..`, max 128 —
    `oauth_sessions.go` `ValidateOAuthState`); no code+error → `400 ... "code or error is required"`;
    unknown state → `404 ... "unknown or expired state"`.
  - `GET /v0/management/get-auth-status` (management-authenticated; recorded 401
    `{"error":"missing management key"}` without the key, S7-12 step 8) — no state → `200 {"status":"ok"}`;
    unknown valid-format state → `200 {"status":"error","error":"unknown or expired state"}`;
    pending session → `200 {"status":"wait"}`.
  - `DELETE /v0/management/oauth-session?state=` → `200 {"status":"ok","cancelled":<bool>}`; missing state →
    `400 {"status":"error","error":"missing state"}`; malformed → `400 ... "invalid state"`.
- CLI `--login` UX (same binary): binds the same fixed ports locally (claude 54545, codex 1455 —
  `sdk/auth/claude.go`, `sdk/auth/codex.go`), prints the verification URL, the device user code, and SSH
  tunnel hints for remote machines (`internal/util/ssh_helper.go` `PrintSSHTunnelInstructions`).

**F6 — File watchers / hot-reload.**
- fsnotify watchers on `config.yaml` and the auth directory; config reloads are debounced 150 ms and
  hash-compared (identical content is skipped). Evidence: `internal/watcher/watcher.go` (`configReloadDebounce`),
  `internal/watcher/config_reload.go` (`reloadConfigIfChanged`).
- On config change: log `config file changed, reloading: <path>` → `config successfully reloaded, triggering client reload`,
  plus per-field diff lines (e.g. `ws-auth: %t -> %t`, `internal/watcher/diff/config_diff.go`). Changes apply without restart:
  API keys, providers, `ws-auth` (terminates live WS sessions), retry knobs, etc.
- Auth directory: `*.json` files are synthesized into credentials and registered live
  (`internal/watcher/synthesizer/file.go`); deletion removes the credential.
- The watcher is started only in non-Home mode (`sdk/cliproxy/service_lifecycle.go` `Run`).

### 2.2 Classification matrix (normative)

| # | Feature | `runtimes/node` | `runtimes/cloudflare` | `runtimes/vercel` |
|---|---|---|---|---|
| F1 | Outbound proxy transport | **EQUIVALENT** | **DEGRADED** → 501 | **DEGRADED** → 501 |
| F2 | C-ABI plugin loading | **ABSENT** (config surface EQUIVALENT) | **ABSENT** (same) | **ABSENT** (same) |
| F3 | File logging | **EQUIVALENT** | **EQUIVALENT** (DO-storage-backed, §2.3-F3) | **DEGRADED** → 501 when enabled |
| F4 | Inbound WebSocket `/v1/ws` | **EQUIVALENT** | **EQUIVALENT** (DO hibernation) | **DEGRADED** → 501 after auth |
| F5a | Redirect-flow auth-URLs + localhost forwarders | **EQUIVALENT** | **DEGRADED** → 501 | **DEGRADED** → 501 |
| F5b | Device-flow auth-URLs (xai/meta/kimi) | **EQUIVALENT** | **EQUIVALENT** | **EQUIVALENT** |
| F5c | Main-port OAuth callback routes + session registry | **EQUIVALENT** | **EQUIVALENT** | **EQUIVALENT** |
| F5d | CLI `--login` UX (browser open, user-code print, SSH hints) | out of HTTP contract (OPTIONAL) | **ABSENT** | **ABSENT** |
| F6 | External file watching / hot-reload | **EQUIVALENT** | **DEGRADED** (management-writes-only) | **DEGRADED** (management-writes-only) |

Adjacent Node-bound surfaces, classified once here for completeness (no goldens beyond what S1/S5 record):
`pprof` debug server — ABSENT on every runtime (config key accepted, ignored); mDNS/DNS-SD `discovery`
— ABSENT on every runtime (config key accepted, ignored); TUI mode — ABSENT; local Redis RESP usage
output — ABSENT; keep-alive watchdog route `/keep-alive` — ABSENT (upstream itself only registers it in
TUI mode; probe 16 recorded 404). Each of these is an INTENTIONAL-NON-EQUIVALENCE listed in §7.

### 2.3 Substitute behavior (exact observables)

**F1 — proxy transport missing (cloudflare, vercel).**
1. Config acceptance is unchanged: `proxy-url` parses, persists, and echoes exactly as upstream
   (S7-05 golden). Per-credential `proxy-url` fields are likewise accepted.
2. Effective proxy mode per credential is resolved as upstream: own value → else global value → else inherit;
   `direct|none` → direct; `socks5|socks5h|http|https` URL → proxy; malformed value → invalid.
3. Runtimes with `proxyTransport: false` MUST exclude credentials whose effective mode is `proxy` from
   scheduling. A request whose model resolves only to excluded credentials MUST get HTTP 501 with the
   F1-501 client body (§5). Excluded credentials MUST NOT enter cooldown and MUST NOT generate retry rounds.
   While at least one eligible non-proxied credential exists, the request MUST succeed through it (no 501).
4. Model resolution precedes the 501: an unknown model still returns the upstream-compatible
   `400 model_not_found` even if proxied credentials exist for other models.
5. Invalid proxy values (parse errors) behave as upstream on ALL runtimes: the request proceeds direct
   (log + fall-through); no 501. (Fail-closed only for explicit proxy URLs the runtime cannot honor.)
6. `POST /v0/management/api-call`: request `proxy_url` invalid → `400 {"error":"invalid proxy_url"}` (upstream);
   request/credential/global resolved mode `proxy` on a runtime without `proxyTransport` → 501 with the
   F1-501 management body (§5). On `proxyTransport: true` runtimes the upstream behavior applies
   (through-proxy attempt; transport failure → `502 {"error":"request failed"}`, S7-06 golden).
7. `direct` and `inherit` modes are trivially equivalent on every runtime (Web `fetch` is direct by
   default). Registered difference: upstream `inherit` honors `HTTP(S)_PROXY`-style environment proxies
   (Go default transport); CPA-Edge ignores environment proxies on every runtime (§7, NE-S7-04).

**F2 — C-ABI plugins (all runtimes).**
1. The `plugins` config block is parsed, persisted, and echoed exactly as upstream. `pluginLoading`
   is `false` in every CPA-Edge runtime; no dynamic library is ever loaded.
2. `GET /v0/management/plugins` MUST return the upstream shape with `plugins_enabled`, `plugins_dir`,
   and configured entries. `registered` MUST be `false` and `effective_enabled` MUST be `false` for every
   entry in every runtime (no loading exists). A config-only entry shows `configured:true, enabled:<as
   configured>` (S7-07/S7-08 goldens).
3. Plugin config mutations (`PATCH /plugins/:id/enabled`, `GET/PUT/PATCH /plugins/:id/config`) remain
   upstream-shaped and operate on the config store only. `DELETE /plugins/:id` for a configured id
   returns the upstream 200 body with `file_deleted:false`, `path:""` (no artifacts exist on any runtime).
4. `POST /v0/management/plugin-store/:id/install` MUST return HTTP 501 with the F2-501 management body
   on every runtime. `GET /v0/management/plugin-store` (registry passthrough) is shape-owned by S5; S7
   adds no goldens (live-registry content is not deterministic).
5. Plugin-owned provider routing, auth providers, management routes, and CLI flags are ABSENT: plugin
   auth-URL paths (e.g. `/v0/management/<plugin>-auth-url`) return 404 per R-404, matching upstream with
   no plugin installed.

**F3 — file logging.**
1. `logging-to-file` / `logs-max-total-size-mb` / `error-logs-max-files` config + toggle endpoints are
   EQUIVALENT on every runtime (S7-09 golden), including the `400 {"error":"logging to file disabled"}`
   gating when the config value is false.
2. `runtimes/node`: EQUIVALENT — rotating files under `<auth-dir>/logs/` (recorded location, S7-10),
   byte-compatible API (S7-09/S7-10 goldens).
3. `runtimes/cloudflare`: EQUIVALENT observable — the log ring is persisted through the DO-backed Store
   instead of a filesystem; `GET /v0/management/logs` (lines/line-count/latest-timestamp/next-cursor,
   `limit`/`after`/`cursor` params) and `DELETE /v0/management/logs` keep upstream shapes. Retention is
   bounded by the same size keys interpreted as approximate byte budgets. This is a substrate change, not
   a client-visible contract change.
4. `runtimes/vercel` (`fileLogging: false`): when `logging-to-file` is false, behavior is identical to
   upstream (400 gating). When `logging-to-file` is true, `GET /v0/management/logs` and
   `DELETE /v0/management/logs` MUST return 501 with the F3-501 management body (§5). The toggle itself
   still accepts and echoes `true` (config compatibility).
5. `GET /request-error-logs*` / `/request-log-by-id/:id`: shape-owned by S5/S6; their persistence substrate
   follows `fileLogging` the same way (see open question OQ-S7-02).

**F4 — inbound WebSocket `/v1/ws`.**
1. `runtimes/node` + `runtimes/cloudflare`: EQUIVALENT. Handshake outcomes are upstream-exact:
   default config (`ws-auth` unset) → plain GET `401 {"error":"Missing API key"}` (S7-01 golden);
   explicit `ws-auth: true` → 401 `{"error":"Missing API key"}` / `{"error":"Invalid API key"}` for
   missing/invalid keys, and valid-key non-upgrade → 400 `Bad Request\n` + `Sec-Websocket-Version: 13`
   (S7-02 golden); explicit `ws-auth: false` → plain GET without auth → the same 400 gorilla body
   (S7-02 golden, step 6); full handshake → 101 + `Sec-WebSocket-Accept` (S7-04 golden);
   `POST /v1/ws` → 404 empty (R-404, S7-03 golden); `OPTIONS` → 204 + CORS. Cloudflare uses DO
   hibernation internally; observable outcomes are unchanged.
2. `runtimes/vercel` (`inboundWebSocket: false`): the route still exists and its auth contract is
   preserved — whenever `ws-auth` is not explicitly `false` (default/unset = required, S7-01 golden),
   missing/invalid API keys still return the upstream 401 bodies; after auth passes, and in the
   explicit `ws-auth: false` mode, a request to `/v1/ws` that would require an upgrade
   MUST return 501 with the F4-501 client body (§5). `POST /v1/ws` remains 404 empty; `OPTIONS` remains
   204 + CORS. `PUT/PATCH /v0/management/ws-auth` still accepts and echoes the flag (it just has no
   sessions to terminate).
3. The 101 path (and the relay protocol behind it) MUST NOT occur on a runtime with
   `inboundWebSocket: false`.

**F5a — redirect-flow auth-URLs (cloudflare, vercel).**
1. `GET /v0/management/{anthropic,codex,antigravity,devin}-auth-url` on a runtime with
   `localCallbackServer: false` MUST return 501 with the F5-501 management body (§5), whether or not
   `is_webui` is present. Management-key auth runs first (401 shapes unchanged).
2. On `localCallbackServer: true` runtimes (node), behavior is upstream: 200 envelope with `url` + `state`,
   and with `?is_webui=1` a forwarder binds 54545/1455/51121 and answers 302 →
   `http(s)://127.0.0.1:<port>/<provider>/callback?...` with `Cache-Control: no-store` (S7-13 golden).
3. F5b (device flows) and F5c (callback routes + session registry) are EQUIVALENT on every runtime;
   their error ladders are the S7-11/S7-12 goldens. On serverless the device flows are the documented
   substitute for redirect flows (§7, NE-S7-05).

**F6 — file watching.**
1. Management-driven updates are EQUIVALENT on every runtime: a config write through
   `/v0/management/*` applies immediately to subsequent requests (no restart), and the S7-02/S7-09/S7-10
   toggle goldens prove the pattern.
2. External-edit watching is EQUIVALENT only on `runtimes/node` (S7-14/S7-15 goldens: api-key addition,
   auth-file registration — both without restart, including the removal direction).
3. On `runtimes/cloudflare` / `runtimes/vercel` (`fileWatching: false`) there is no filesystem to watch:
   external edits do not exist as a concept; the config store is the Store backend and the only mutation
   paths are the management API and Store writes. Both apply immediately (same observable class as 1).
   No 501 exists for this feature; the absence is only observable as "nothing outside the API can mutate
   runtime state" (documented, not probed).

### 2.4 Rulings on cross-section inputs (S3 recorded findings)

- **Ruling R-S7-A (S3 O-2: api-keys unconfigured ⇒ upstream proxies OPENLY, no auth).**
  CPA-Edge MIRRORS upstream on every runtime: with `api-keys` absent, client routes accept
  unauthenticated requests exactly as upstream does; with ≥1 key configured, the upstream 401 shapes
  apply. This is a config-state behavior, not a platform degradation, so it stays uniform across
  node/cloudflare/vercel — same config, same behavior. The fail-open default is a documented
  inherited hazard: the deployment guide (D1) MUST warn that serverless deployments are public by
  default and that omitting `api-keys` (and `remote-management.secret-key`) exposes an open proxy.
  No golden is added here (S1/S3 own the auth fixtures); S7 records the ruling only.
- **Ruling R-S7-B (S3 O-4: OAuth login flows bind loopback callback servers).**
  Confirms §2.2 rows F5a/F5d. Redirect-based login (anthropic 54545, codex 1455, antigravity 51121,
  devin `127.0.0.1:<port>/callback`) is viable only where the process can bind those loopback ports:
  `runtimes/node` EQUIVALENT; cloudflare/vercel DEGRADED — the four redirect-flow auth-URL endpoints
  return the F5-501 body (§3.2), and the CLI login UX is ABSENT. Device flows (xai/meta/kimi) remain
  the supported serverless path (NE-S7-05).
- **Ruling R-S7-C (S3 O-3: anthropic/codex callback routes 200-HTML-always; devin strict 400s).**
  MIRRORED on every runtime. These are ordinary HTTP routes on the main port; no runtime lacks the
  capability to serve them. Recorded in S7-11 (fixed 200 HTML body byte-for-byte; devin 400 ladder
  `code or error is required` / `invalid or expired OAuth callback`); no runtime deviation exists to
  declare.

## 3. Schemas

### 3.1 Runtime capability descriptor (exported by `@cpa-edge/core`)

```ts
export interface RuntimeCapabilities {
  /** GET /v1/ws upgrade + relay sessions. */
  readonly inboundWebSocket: boolean;
  /** Outbound proxy-url dialing (socks5/socks5h/http/https). */
  readonly proxyTransport: boolean;
  /** C-ABI dynamic library loading. MUST be false in every CPA-Edge runtime. */
  readonly pluginLoading: boolean;
  /** Persistent rotating logs behind /v0/management/logs. */
  readonly fileLogging: boolean;
  /** External config/auth file watching (hot reload of outside edits). */
  readonly fileWatching: boolean;
  /** Binding extra localhost ports for OAuth redirect forwarders. */
  readonly localCallbackServer: boolean;
}
```

Declared values (each runtime exports a constant):

| capability | node | cloudflare | vercel |
|---|---|---|---|
| `inboundWebSocket` | `true` | `true` | `false` |
| `proxyTransport` | `true` | `false` | `false` |
| `pluginLoading` | `false` | `false` | `false` |
| `fileLogging` | `true` | `true` | `false` |
| `fileWatching` | `true` | `false` | `false` |
| `localCallbackServer` | `true` | `false` | `false` |

Rules:
- The router consumes the descriptor at construction; it is immutable for the process lifetime.
- Contract tests MUST exercise degraded paths by constructing the `runtimes/node` server with a
  modified descriptor (e.g. the vercel values) — this is how T1 tests T3 behavior.
- No global mutable state: the descriptor is passed in, never read from a module-level singleton.

### 3.2 Degraded response bodies (exact bytes)

Client-API routes (OpenAI-style error object, same shape family as the upstream 500 `server_error`):

```json
{"error":{"message":"inbound WebSocket is not available on this runtime","type":"not_implemented","code":"websocket_unavailable"}}
```
```json
{"error":{"message":"outbound proxy transport (proxy-url) is not available on this runtime","type":"not_implemented","code":"proxy_unavailable"}}
```

Management routes (`{"error": "<string>"}` management style):

```json
{"error":"local callback server is not available on this runtime"}
```
```json
{"error":"proxy transport is not available on this runtime"}
```
```json
{"error":"file logging is not available on this runtime"}
```
```json
{"error":"plugin installation is not available on this runtime"}
```

All 501 responses: `Content-Type: application/json; charset=utf-8`, the standard CORS header block
present (added by the response middleware, same as all middleware-handled responses — the S1-recorded
exception is redirects, which are a different mechanism and do not apply here), no extra headers, body
is a single compact JSON line + `\n`.

### 3.3 Error body → trigger mapping

| Body (code / message fragment) | Route class | Trigger |
|---|---|---|
| `websocket_unavailable` (client body) | `GET /v1/ws` | `!inboundWebSocket`, after the auth gate (i.e. after auth passes, or when `ws-auth: false`) |
| `proxy_unavailable` (client body) | any client completion route | `!proxyTransport` and every eligible credential for the model is proxy-credentialed |
| `local callback server is not available on this runtime` | `{anthropic,codex,antigravity,devin}-auth-url` | `!localCallbackServer` |
| `proxy transport is not available on this runtime` | `POST /v0/management/api-call` | `!proxyTransport` and resolved proxy mode is `proxy` |
| `file logging is not available on this runtime` | `GET/DELETE /v0/management/logs` | `logging-to-file: true` and `!fileLogging` |
| `plugin installation is not available on this runtime` | `POST /v0/management/plugin-store/:id/install` | always (project-wide absence) |

## 4. Streaming rules

1. Degraded 501 responses are never streamed. For a request with `stream: true` that triggers a
   degradation, the response is the complete JSON 501 body with `Content-Type: application/json;
   charset=utf-8`; no SSE headers, no `data:` frames, and no `[DONE]` are ever emitted.
2. The 501 decision for F1 (proxy) is made during credential candidacy, which happens before any
   upstream connection and before the first downstream byte; for F4 it is made at the route handler,
   before any upgrade attempt. In both cases the client observes a plain non-200 status, never a
   mid-stream abort. (Contrast: the upstream mid-stream transport failure path — disconnect-mid-stream
   in S2 sections — is unchanged by S7.)
3. `nonstream-keepalive-interval` blank-line keep-alives do not apply to 501 responses.

## 5. Error semantics

Precedence (normative, deterministic; each level fully resolves before the next):
1. Route/method resolution — R-404 (wrong method → 404 empty body) precedes everything.
2. Authentication — client API key middleware (401 `{"error":"Missing API key"}` /
   `{"error":"Invalid API key"}`) or management key middleware (401 management bodies), byte-identical
   to upstream. The vercel `/v1/ws` 501 therefore only appears after auth passes (or when `ws-auth:false`).
3. Config-state checks that upstream performs first — e.g. `/v0/management/logs` returns
   `400 {"error":"logging to file disabled"}` when the config value is false, on every runtime, before
   any capability check.
4. Capability check — the §3.2 501 bodies.
5. Feature handler — upstream-compatible behavior (§2.3).

Additional rules:
- F1's 501 is decided inside the handler (step 5) at credential-candidacy time, after model resolution:
  unknown model → upstream `400 model_not_found` regardless of proxies; known model, all candidates
  proxied → 501; known model, ≥1 eligible non-proxied candidate → normal request (no 501, no cooldown
  side effects from excluded credentials).
- No degraded 501 response ever triggers cooldowns, retry rounds, or usage queue entries.
- All upstream error bodies referenced above (401s, 400 gating, 502 api-call) are normative via the
  S7 goldens; this section does not re-specify S1/S5-owned shapes beyond their role as degradation triggers.

## 6. Golden samples index

Recorded by @oracle-runner (worker-3 stack: reference container `cpa-oracle-3` on 127.0.0.1:8397,
openai mock on 20999, forwarder host publish 24545→54545) against CLIProxyAPI v7.3.4
(`eceasy/cli-proxy-api:v7.3.4`, digest `sha256:97825da3009f98acf78b5c172fde650a5fbe7a690950a69ce6d7b535d77d4266`).
Per-case layout per RECIPES: `meta.yaml` (dynamic fields incl. port adaptations), `request.http`
(all steps in order, `### step N` dividers), `downstream-<step>.md` (or `downstream.md`),
`upstream.jsonl` (empty for mock-free cases), `mock-response.json`, `logs.md` (docker-log delta).
Case definitions: `spec/recordings/S7.cases.json`. Raw `-v` transcripts: `_cpa_edge_ref/run3/probes/S7/`.

**STATUS: 15/15 recordable cases RECORDED — 146 fixture files.** Fixture count per case = files listed.

| case-id | feature | recorded behavior (one line) | fixture path | files |
|---|---|---|---|---|
| S7-01 | F4 | default config (`ws-auth` unset) plain GET → `401 {"error":"Missing API key"}` + CORS block | tests/fixtures/S7/S7-01/ | 6 |
| S7-02 | F4+F6 | ws-auth toggle: PUT true → 401 Missing / 401 Invalid / valid-key 400 gorilla; PUT false → no-auth 400 gorilla; `{"status":"ok"}` echoes | tests/fixtures/S7/S7-02/ | 11 |
| S7-03 | F4 | POST → 404 empty (R-404); OPTIONS → 204 + CORS no auth | tests/fixtures/S7/S7-03/ | 7 |
| S7-04 | F4 | full 101 handshake; `Sec-WebSocket-Accept` == base64(SHA1(key+GUID)); server silent pre-close, echoes close frame; log `websocket provider connected: aistudio-<id>` | tests/fixtures/S7/S7-04/ | 6 |
| S7-05 | F1 | proxy-url PUT/GET echo (incl. config echo with `proxy-url` field), `direct`, DELETE, empty | tests/fixtures/S7/S7-05/ | 11 |
| S7-06 | F1 | api-call: direct control 200 + explicit `direct` 200 (2 mock hits in upstream.jsonl); dead socks5 → `502 {"error":"request failed"}`; `ftp://` → `400 {"error":"invalid proxy_url"}` | tests/fixtures/S7/S7-06/ | 9 |
| S7-07 | F2+F6 | external config edit: plugins block live-reloads; list shows `configured:true, registered:false, effective_enabled:false` | tests/fixtures/S7/S7-07/ | 6 |
| S7-08 | F2 | plugin ops: PATCH enabled, GET/PUT config echo, list, DELETE `{status:deleted, file_deleted:false, path:"", configured_removed:true}`, unknown id → 404 `plugin_not_found`; final config snapshot kept | tests/fixtures/S7/S7-08/ | 14 |
| S7-09 | F3 | logs GET/DELETE → `400 {"error":"logging to file disabled"}`; size-key PUT/GET echo | tests/fixtures/S7/S7-09/ | 11 |
| S7-10 | F3 | enabled: `{"lines":[...],"line-count":N,"latest-timestamp":N,"next-cursor":...}`; DELETE `{"success":true,"message":"Logs cleared successfully","removed":0}`; restore → 400 again; log files under `<auth-dir>/logs/`, error dumps present while disabled | tests/fixtures/S7/S7-10/ | 11 |
| S7-11 | F5c | callback routes: anthropic/codex/antigravity 200 fixed HTML (byte-exact), devin 400 ladder, POST → 404 empty | tests/fixtures/S7/S7-11/ | 12 |
| S7-12 | F5c | oauth-callback GET/POST error ladder (no mgmt auth on that route), get-auth-status: without key → 401 `missing management key`, with key → ok/error-ladder, oauth-session DELETE ladder | tests/fixtures/S7/S7-12/ | 16 |
| S7-13 | F5a | anthropic-auth-url?is_webui=1 → 200 `{status,url,state}`; forwarder 54545 → `302` + `Cache-Control: no-store` + `Location: http://127.0.0.1:<server-port>/anthropic/callback?...` (no CORS — raw Go server); get-auth-status `wait`; DELETE session `cancelled:true` | tests/fixtures/S7/S7-13/ | 9 |
| S7-14 | F6 | external api-keys edit: hot-added key serves GET /v1/models 200 (wired-template model list), removed key → 401 Invalid; live both directions; watcher log lines captured | tests/fixtures/S7/S7-14/ | 9 |
| S7-15 | F6 | fake kimi JSON hot-registered (auth-files entry, oauth account type) and hot-removed on delete; `auth file changed (CREATE/REMOVE)` log lines | tests/fixtures/S7/S7-15/ | 8 |
| S7-16 | F5b | device-flow auth-url envelopes (xai/meta/kimi) — NOT recorded | — | 0 |

Recording-session notes (for the contract layer):
- Port adaptations on the recording stack (8397/20999/24545 vs the bootstrap's 18317/18999) are listed
  in each `meta.yaml` dynamic_fields; the forwarder 302 `Location` embeds the server's CONFIG port.
- S7-01..06 and S7-09..12 shared one container (id order); S7-05's config echo carries the
  `"ws-auth":false` value persisted by S7-02's restore step; S7-07+08 shared a container (external
  plugins edit); S7-13 ran solo; S7-14 and S7-15 each used a fresh container.
- S7-14's `/v1/models` body content is environment-specific (the recording template wires 8 providers);
  the S7 claim is only "the hot-added key authenticates" — model-list content belongs to S1/S2 sections.
- S7-15's fixture retains the fake auth file (`fake-auth-file.json`) as the input artifact.

## 7. Intentional non-equivalences & open questions

Intentional non-equivalences (to be appended to SPEC §5 registry by the orchestrator):

- **NE-S7-01 (F1, cloudflare+vercel).** `proxy-url` (global or per-credential) with schemes
  `socks5|socks5h|http|https` cannot be honored on runtimes without raw-socket egress. Substitute: config
  accepted + echoed; proxy-credentialed candidates are excluded from scheduling; requests with no
  eligible direct credential return 501 `proxy_unavailable` (§3.2). Rationale: fail closed — sending
  traffic direct when a proxy was explicitly configured would be a silent privacy break.
- **NE-S7-02 (F2, all runtimes).** C-ABI plugin loading is ABSENT project-wide (no FFI in a
  Web-standards core; no cgo-equivalent on serverless; the upstream plugin ecosystem is Go-binary
  specific). Substitute: full config/management surface compatibility with `registered:false`,
  `effective_enabled:false`; plugin install returns 501 (§3.2).
- **NE-S7-03 (F3, vercel).** Rotating log files are impossible; `logging-to-file: true` + logs reads
  return 501 (§3.2). Toggle/config remain accepted. Cloudflare keeps the API contract via DO-backed
  storage (declared EQUIVALENT at the API level; substrate difference documented).
- **NE-S7-04 (F1, all runtimes).** Upstream `inherit` proxy mode honors environment proxy variables
  (Go default transport `ProxyFromEnvironment`); CPA-Edge's fetch-based core ignores environment proxies
  on every runtime. `direct`/`none` and explicit URLs behave identically to upstream.
- **NE-S7-05 (F5a, cloudflare+vercel).** Redirect-based OAuth flows fundamentally require the browser
  to reach `localhost:<54545|1455|51121>` on the CPA host; serverless hosts cannot bind those ports and
  the fixed redirect URIs cannot point at them. Substitute: 501 on the four redirect-flow auth-URL
  endpoints (§3.2); device flows (xai/meta/kimi) remain the supported path on serverless.
  Confirmed by S3's recorded O-4 finding; see Ruling R-S7-B.
- **NE-S7-06 (F6, cloudflare+vercel).** External-file watching does not exist (no filesystem); the
  management API and Store writes are the only mutation paths and apply immediately. On node, external
  watching is EQUIVALENT (S7-14/S7-15).
- **NE-S7-07 (F4, vercel).** `/v1/ws` cannot accept upgrades; 501 `websocket_unavailable` after the
  upstream-identical auth gate (§3.2).
- **NE-S7-08 (adjacent, all runtimes).** pprof server, mDNS/DNS-SD discovery, TUI, local Redis RESP
  usage output, and the `/keep-alive` watchdog route are ABSENT; their config keys are accepted and
  ignored (no route, no listener). `/keep-alive` returns 404 identical to upstream's non-TUI mode.

Open questions:
- **OQ-S7-01.** Vercel "Fluid compute" WebSocket support, if it becomes generally available and
  stable, would flip `inboundWebSocket` for vercel; the 501 body is the compatibility seam. Decision
  deferred to a future SPEC revision; T3 ships with `false`.
- **OQ-S7-02.** Per-request error dumps (`error-*.log` under `<auth-dir>/logs/`) are a SEPARATE
  upstream feature from `logging-to-file`: they are written even while `logging-to-file: false`
  (recorded in S7-10 aux artifacts; retention by `error-logs-max-files`). On `fileLogging: false`
  runtimes (vercel) these files cannot exist, so `GET /v0/management/request-error-logs*` /
  `/request-log-by-id/:id` need an explicit degraded stance: proposal — 501 with the F3 body for
  symmetry; on cloudflare the dumps can persist through the DO-backed Store with upstream-shaped
  responses. S5/S6 own the final route shapes; implementers should not add a third variant.
- **OQ-S7-03.** Cloudflare outbound `connect()`-based proxying (TCP sockets API) could make a subset of
  F1 (http CONNECT, socks5) possible on Workers; out of scope for T2 v1 — revisit if a real deployment
  needs it. The 501 contract is designed so flipping the capability later is non-breaking.
- **OQ-S7-04.** Device flows from serverless egress IPs may be rate-limited or blocked by vendors
  (operational, not behavioral); the contract stays EQUIVALENT regardless.
- **OQ-S7-05.** Upstream's `ws-auth` reload terminates live sessions mid-flight (S7-02 logs). For the
  cloudflare DO hibernation implementation, session termination on `ws-auth` enable must be observable
  as an abnormal-close of the client socket; T2 owns the close-code choice.
