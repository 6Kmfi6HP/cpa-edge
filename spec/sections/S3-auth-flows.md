# S3 — Auth flows (OAuth code, Device RFC 8628, refresh, API keys, mgmt authz)

Section status: DRAFT by @spec-writer (mission S3). Anchor: CLIProxyAPI v7.3.4, commit `8335eac731946bd4eff18f500653f93736df53d6`.
All upstream citations are paths in the reference repo at that tag. Wire-level constants (URLs, client IDs, scopes, header names, JSON keys) are public-interface facts cited for compatibility, per clean-room rule 1.

## 1. Scope and boundaries

IN scope:
- Inbound client API-key authentication for all proxied routes (`/v1/*`, `/v1beta/*`, `/openai/v1/*`, `/backend-api/codex/*`, `/v1/realtime*`): key sources, comparison semantics, 401 shapes, example-key safe mode, open-when-unconfigured mode.
- Management-plane authorization for `/v0/management/*`: key sources, bcrypt secret handling, remote gating, per-IP failure ban, response headers, route availability gating.
- OAuth authorization-code flow structure per provider (Claude, Codex, Antigravity, Devin): authorization URL construction (exact query parameters and order), PKCE, state, loopback callback server semantics, main-port callback routes, token exchange request/response wire formats, login-URL management endpoints, in-memory OAuth session store, cancel/status endpoints.
- Device-code flows (Kimi, xAI, Meta, Codex-device): endpoint discovery, device/user codes, poll interval, `authorization_pending` / `slow_down` / `expired_token` / `access_denied` handling, post-token enrichment (Meta key minting, Codex device → code exchange), login-URL management endpoints.
- Token refresh semantics: per-provider refresh lead (expiry thresholds), refresh request wire formats, retry/backoff rules, auto-refresh loop parameters, refresh-on-401 during request execution.
- Auth-file on-disk schemas per provider and the file-store loading/saving rules (pointer level; file mutation details live in S6).

OUT of scope (owned elsewhere):
- Full `/v0/management` CRUD surface beyond auth-related routes (S5).
- Config file parsing/defaults/cooldowns (S6), scheduling/selection order (S4).
- Provider executors' request paths and how tokens are attached to upstream calls (S2*, per-provider sections) except the 401-refresh trigger.
- Realtime client-secret issuance (`/v1/realtime/client_secrets`) beyond its auth error shape (S1/S2d9).
- Home (cluster) auth dispatch (not part of the single-node baseline).
- Plugin-provided OAuth providers (interface exists; no built-in golden behavior).

Classification (R-FIXTURE): api-key matrix, management auth, OAuth error/callback paths, and the local-URL-building login endpoints are RECORDABLE-LOCALLY. Provider happy-path token exchanges and device flows against live vendor endpoints are CREDENTIALED-ONLY → FIXTURE-DEFERRED.

## 2. Behavior inventory

### 2.1 Inbound API-key auth middleware

Applied to groups `/v1`, `/v1beta`, `/openai/v1`, `/backend-api/codex` and the standalone realtime routes (evidence: `internal/api/server_routes.go` `setupRoutes`; middleware `internal/api/server_middleware.go` `AuthMiddleware` → `accessAuthMiddleware`).

`accessAuthMiddleware(manager, realtimeError=false)`:
1. Manager with zero providers → request allowed, no principal set (legacy open mode) (evidence: `sdk/access/manager.go` `Authenticate` returns `nil, nil` when no providers; middleware calls `c.Next()`).
2. Otherwise the single registered provider `config-api-key` (default instance name `config-inline`) evaluates the request (evidence: `internal/access/config_access/provider.go`).
3. Success → context keys `userApiKey` = matched key, `accessProvider` = `config-inline`, `accessMetadata.source` = winning source name.
4. Failure → abort with status 401 and body `{"error": "<message>"}` (non-realtime) — exact messages below.

Key normalization (config load / hot reload): trim whitespace, drop empty strings, deduplicate (evidence: `internal/access/config_access/provider.go` `normalizeKeys`). Empty `api-keys` list → provider unregistered → open mode (must be mirrored; see golden `s3-apikey-open-when-unconfigured`).

Credential extraction order (first configured-key match wins; per-source precedence for *presence* is as listed):
| # | Source | Extraction rule |
|---|---|---|
| 1 | `Authorization` header | If value has form `Bearer <token>` (prefix case-insensitive, single space split) → token = trimmed remainder; otherwise the entire header value is the candidate (evidence: `extractBearerToken`). |
| 2 | `X-Goog-Api-Key` header | entire value |
| 3 | `X-Api-Key` header | entire value |
| 4 | query parameter `key` | entire value |
| 5 | query parameter `auth_token` | entire value |

- No credential present in any source → `401` `{"error":"Missing API key"}` (evidence: `sdk/access/errors.go` `NewNoCredentialsError`).
- At least one credential present but none matches → `401` `{"error":"Invalid API key"}` (evidence: `NewInvalidCredentialError`).
- Comparison semantics: exact string equality against an in-memory set (Go map lookup). Not constant-time; no hashing; case-sensitive. OPTIONAL hardening (constant-time compare) may be registered as a non-equivalence, otherwise mirror as-is.

Realtime routes (`/v1/realtime`, `/v1/realtime/calls`, `.../client_secrets`, `.../sessions`, `.../transcription_sessions`, `.../translations*`, `.../hangup|accept|reject|refer`) use `realtimeStandardAuthMiddleware` (same evaluation) but a different failure body (evidence: `internal/api/server_middleware.go`):
```json
{"error":{"message":"<Missing API key|Invalid API key>","type":"authentication_error","param":null,"code":"invalid_api_key"}}
```
HTTP 5xx from the auth layer instead yields `"type":"server_error","code":"authentication_service_error"`.

Example-API-key safe mode (evidence: `internal/safemode/example_api_keys.go`, `internal/api/server_middleware.go`):
- If any configured top-level key equals `your-api-key-1`, `your-api-key-2`, or `your-api-key-3`, the server starts in safe mode.
- Proxy paths (`/v1`, `/v1beta`, `/openai/v1`, `/backend-api/codex` prefixes) → `403` with header `X-CPA-SAFE-MODE: example-api-key` and body:
```json
{"error":"unsafe_example_api_key","message":"Proxy API endpoints are disabled because api-keys contains template values. Open /management.html?safe-mode=configure, update api-keys in Management, then retry."}
```
- `GET /` and `GET /management.html` serve an HTML warning page (lists the offending keys, links to `/management.html?safe-mode=configure`) instead of the normal root payload; `GET /management.html?safe-mode=configure` is exempt and serves the panel path.
- Safe mode is re-evaluated when `api-keys` changes through management (clearing template values lifts the block).

### 2.2 Management-plane authorization

Route gating: `/v0/management/*` handlers are registered iff at least one of {config `remote-management.secret-key`, env `MANAGEMENT_PASSWORD`, local management password} is non-empty at startup or via hot reload; otherwise every `/v0/management` request falls through to NoRoute → `404` empty body (R-404). Evidence: `internal/api/server.go` (`hasManagementSecret`), `internal/api/server_reload.go`, `internal/api/server_management.go` (`managementAvailable`). `POST|GET /v0/management/oauth-callback` is registered in the same group but WITHOUT the key middleware (see 2.4).

Per-request pipeline (evidence: `internal/api/handlers/management/handler.go` `Middleware` → `AuthenticateManagementKey`):
1. Response headers set on every management response (before any check, including 401/403/404 bodies): `X-CPA-VERSION`, `X-CPA-COMMIT`, `X-CPA-BUILD-DATE`, `X-CPA-SUPPORT-PLUGIN` — emitted with Go-canonical capitalization `X-Cpa-Version: v7.3.4`, `X-Cpa-Commit: 8335eac`, `X-Cpa-Build-Date: 2026-09-15T14:07:06Z`, `X-Cpa-Support-Plugin: 1` (recorded). These headers do NOT appear on `/v1`/`/v1beta` auth rejections (those carry only the global CORS block from S1). `X-Cpa-Trace-Id` is never emitted on auth or management surfaces (it is only listed in `Access-Control-Expose-Headers`). Values are build-info constants; masked as dynamic in goldens.
2. `clientIP = c.ClientIP()` (gin default proxy rules); `localClient` iff IP is `127.0.0.1` or `::1`.
3. Key extraction: `Authorization: Bearer <key>` (non-bearer → whole header value), else `X-Management-Key`.
4. Ban check first: if this IP is currently banned → `403` `{"error":"IP banned due to too many failed attempts. Try again in <remaining>"}` where `<remaining>` is a Go duration string at seconds precision (recorded observation: `30m0s` on the first banned request, which lands <1s after the ban is set). The failure that triggers the ban is itself answered `401` — only SUBSEQUENT requests get the 403. No failure is counted while banned; ban expiry resets the counter.
5. Remote gate: `!localClient && !allowRemote` → `403` `{"error":"remote management disabled"}` (no failure counted). `allowRemote` = config `remote-management.allow-remote`; forced true when env `MANAGEMENT_PASSWORD` is set.
6. If neither a config secret hash nor env secret exists → `403` `{"error":"remote management key not set"}` (reachable only in narrow hot-reload/env edge cases; normally routes are unregistered → 404, see above).
7. Missing key → count one failure for the IP, `401` `{"error":"missing management key"}`.
8. Local clients only: a local management password (TUI mode), if set, is compared in constant time; match → success + reset.
9. Env secret (`MANAGEMENT_PASSWORD`), if set, compared in constant time; match → success + reset.
10. Config secret: bcrypt compare of the presented key against `remote-management.secret-key`. Mismatch → count one failure, `401` `{"error":"invalid management key"}`. Match → success + reset.

Failure counter / sliding ban (all constants are code constants; there is no config knob). The counter is process-lifetime state keyed by client IP and accumulates across ALL requests for the lifetime of the server instance (golden replay of the ban pair must preserve the recorded request order — see §6):
| Knob | Value | Evidence |
|---|---|---|
| Ban threshold | 5 consecutive counted failures (per IP) | `AuthenticateManagementKey` `maxFailures = 5` |
| Ban duration | 30 minutes | `banDuration = 30 * time.Minute` |
| On ban | `blockedUntil = now+30m`, counter reset to 0 | `fail()` |
| Success | counter reset to 0, `blockedUntil` cleared | `reset()` |
| Cleanup | hourly sweep; entries idle > 2h purged unless still banned | `attemptCleanupInterval = 1h`, `attemptMaxIdleTime = 2h` |
Counted failures: missing key, invalid key. NOT counted: banned responses, remote-disabled responses.

Secret at rest — bcrypt-on-startup mutation (oracle finding, mirrored): at config load, a non-empty `remote-management.secret-key` that is not already a bcrypt hash (prefix `$2a$`/`$2b$`/`$2y$`) is hashed with bcrypt at default cost, set in memory, and written back into `config.yaml` in place, preserving comments, updating only the nested `remote-management.secret-key` scalar (evidence: `internal/config/config_load.go` + `internal/config/config_validation.go` `looksLikeBcrypt`/`hashSecret`, `internal/config/parse.go` same logic for the parse path). The plaintext remains the accepted key. Config mutation mechanics (file watcher, save path) are S6; the auth-relevant contract is: after first startup the stored value is a bcrypt hash and plaintext compares keep working.

Management login responses also flow through the global CORS middleware; OPTIONS on management paths auto-answers 204 without auth (S1).

### 2.3 OAuth authorization-code flows

Common structure (all providers):
- `state`: 16 random bytes, hex-encoded (32 lowercase hex chars) (evidence: `internal/misc/oauth.go` `GenerateRandomState`).
- PKCE: S256 code challenge; verifier random (evidence: `internal/auth/{claude,codex,devin}/pkce.go`).
- Login waits at most 5 minutes for a callback (CLI loopback servers and management flows).
- CLI loopback callback server: bound to the provider's fixed port; 405-equivalent behavior does NOT apply here (plain `net/http`): non-GET → `405` plain-text `Method not allowed`; `error` query param → `400` `OAuth error: <error>`; missing `code` → `400` `No authorization code received`; missing `state` → `400` `No state parameter received`; success → `302` redirect to `/success` HTML page (evidence: `internal/auth/claude/oauth_server.go` (path `/callback`), `internal/auth/codex/oauth_server.go` (path `/auth/callback`)). These loopback servers are CLI-process behavior; the serverless rewrite ships them as a runtime adapter (see §7 open question O-4).
- Manual-paste fallback: after 15s (5s for Devin) an optional prompt accepts a pasted callback URL; parsed with the same rules as `misc.ParseOAuthCallback` (accepts bare `code`, `?code=...`, full URL, fragment `#state`, `code#state`).

#### 2.3.1 Claude (provider id `claude`)
| Item | Value | Evidence |
|---|---|---|
| Authorize endpoint | `https://claude.ai/oauth/authorize` | `internal/auth/claude/anthropic_auth.go` |
| Token endpoint (exchange AND refresh) | `https://platform.claude.com/v1/oauth/token` | same |
| Client ID | `9d1c250a-e61b-44d9-88ed-5944d1962f5e` | same |
| Redirect URI | `http://localhost:54545/callback` | same |
| Scope | `user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload` | `ClaudeOAuthScope` |
| Loopback port | 54545 (configurable via login options) | `sdk/auth/claude.go` |
| Refresh lead | 4 hours before expiry | `ClaudeAuthenticator.RefreshLead` |
Authorize URL query parameters (exact set; serialized by Go `url.Values.Encode`, i.e. alphabetical keys, `+` for spaces): `code=true`, `client_id`, `code_challenge`, `code_challenge_method=S256`, `redirect_uri`, `response_type=code`, `scope`, `state`.

Code exchange: `POST https://platform.claude.com/v1/oauth/token`, body JSON with **fixed field order** `grant_type`=`authorization_code`, `code`, `redirect_uri`, `client_id`, `code_verifier`, `state`; headers `Accept: application/json, text/plain, */*`, `Content-Type: application/json`, `User-Agent: axios/1.15.2`, `Accept-Encoding: gzip, compress, deflate, br`, `Connection: close`. A `#state` suffix on the code overrides the state field (native client quirk). Success response JSON: `access_token`, `refresh_token`, `token_type`, `expires_in` (seconds), `organization{uuid,name}`, `account{uuid,email_address}`. `expired` := now + `expires_in` (RFC3339). Companion advisory calls (failures logged, never fatal): `GET https://api.anthropic.com/api/oauth/profile` and `GET https://api.anthropic.com/api/oauth/claude_cli/roles` with `Authorization: Bearer <access_token>`, `Cache-Control: no-cache`; profile values override token-response identity fields when non-empty. Credential file name: `claude-<8-hex>-<email>.json` where the 8-hex is the first 8 chars of sha256(organization UUID) — account UUID if no org — else legacy `claude-<email>.json` (evidence: `internal/auth/claude/filename.go`).

Refresh: same endpoint, JSON body (map → alphabetically ordered keys): `client_id`, `grant_type=refresh_token`, `refresh_token`, `scope`. Empty `refresh_token` in response → previous refresh token retained. On HTTP 429: parse `Retry-After` (seconds or HTTP-date) or `Retry-After-Ms`, clamp to [5s, 5m], and block that refresh token until then (subsequent refreshes fail fast, non-retryable). 5xx → retryable; other 4xx → non-retryable. `RefreshTokensWithRetry(maxRetries)`: attempt 1 immediately, then sleep `attempt` seconds between attempts, stop early on non-retryable. Single-flight per refresh token; 30s per-attempt timeout (evidence: `internal/auth/claude/anthropic_auth.go`).

#### 2.3.2 Codex (provider id `codex`)
| Item | Value | Evidence |
|---|---|---|
| Authorize endpoint | `https://auth.openai.com/oauth/authorize` | `internal/auth/codex/openai_auth.go` |
| Token endpoint | `https://auth.openai.com/oauth/token` | same |
| Client ID | `app_EMoamEEZ73f0CkXaXp7hrann` | same |
| Redirect URI | `http://localhost:1455/auth/callback` | same |
| Scope | `openid email profile offline_access` | same |
| Extra authorize params | `prompt=login`, `id_token_add_organizations=true`, `codex_cli_simplified_flow=true` | same |
| Loopback port / path | 1455, `/auth/callback` | `sdk/auth/codex.go`, `internal/auth/codex/oauth_server.go` |
| Refresh lead | 24 hours | `CodexAuthenticator.RefreshLead` |
Code exchange: `POST` token endpoint, `application/x-www-form-urlencoded` with keys `grant_type=authorization_code`, `client_id`, `code`, `redirect_uri`, `code_verifier`; header `Accept: application/json`. Success JSON: `access_token`, `refresh_token`, `id_token`, `token_type`, `expires_in`. The `id_token` JWT is base64URL-decoded (no signature check) and claims read: `email`, `https://api.openai.com/auth.chatgpt_account_id`, `...chatgpt_plan_type` (evidence: `internal/auth/codex/jwt_parser.go`). Credential file name: `codex-<8-hex-of-sha256(account_id)>-<email>[-<plan>].json` (plan lowercased, non-alphanumerics → `-`), legacy `codex-<email>[-<plan>].json`.
Refresh: form POST `client_id`, `grant_type=refresh_token`, `refresh_token`, `scope=openid profile email`. Non-retryable when the error body contains `refresh_token_reused`. Single-flight per refresh token; 30s timeout.

#### 2.3.3 Antigravity (provider id `antigravity`)
| Item | Value | Evidence |
|---|---|---|
| Authorize endpoint | `https://accounts.google.com/o/oauth2/v2/auth` | `internal/auth/antigravity/constants.go`, `auth.go` |
| Token endpoint | `https://oauth2.googleapis.com/token` | same |
| Client ID | `1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com` | same |
| Client secret | public installed-app constant in upstream `constants.go` (needed for the form exchange; treat as a public value, not a secret) | same |
| Redirect URI | `http://localhost:51121/oauth-callback` | same |
| Scopes | `cloud-platform`, `userinfo.email`, `userinfo.profile`, `cclog`, `experimentsandconfigs` (full googleapis URLs in source) | same |
| Loopback port / path | 51121, `/oauth-callback` (plain HTML response, no redirect) | `sdk/auth/antigravity.go` |
| Refresh lead | 30 minutes | same |
Authorize URL query parameters (alphabetical via `url.Values.Encode`): `access_type=offline`, `client_id`, `prompt=consent`, `redirect_uri`, `response_type=code`, `scope`, `state`.
Code exchange: form POST `code`, `client_id`, `client_secret`, `redirect_uri`, `grant_type=authorization_code`. Success JSON: `access_token`, `refresh_token`, `expires_in`, `token_type`. Post-exchange enrichment (mandatory, failures fatal): `GET https://www.googleapis.com/oauth2/v2/userinfo?alt=json` → `email`; `loadCodeAssist` on `https://cloudcode-pa.googleapis.com` (metadata `ideType=ANTIGRAVITY`) → project id. Auth-file schema: `{type:"antigravity", access_token, refresh_token, expires_in, timestamp:<unix ms>, expired:<RFC3339>, email, project_id}`; file name `antigravity[-<email>].json` (evidence: `sdk/auth/antigravity.go` `BuildAntigravityAuth`, `internal/auth/antigravity/filename.go`).

#### 2.3.4 Devin (provider id `devin`)
| Item | Value | Evidence |
|---|---|---|
| Authorize endpoint | `https://app.devin.ai/auth/cli/continue` | `internal/auth/devin/devin_auth.go` |
| Token exchange | `POST https://api.devin.ai/auth/cli/token` JSON `{code, code_verifier}` → `{"token": <session token>}` | same |
| Redirect URI (management flow) | `http://127.0.0.1:<server-port>/callback` (strict: 127.0.0.1 + `/callback`) | `internal/api/handlers/management/auth_files_devin_oauth.go` |
| Redirect URI (CLI flow) | `http://127.0.0.1:<ephemeral port>/callback` (port 0 → ephemeral) | `sdk/auth/devin.go` |
| Loopback path | `/callback` (ephemeral 127.0.0.1 port; 400 HTML on missing params, 200 HTML success) | `internal/auth/devin/devin_auth.go` |
| Refresh lead | none (permanent session tokens) | `DevinAuthenticator.RefreshLead` = nil |
Authorize URL query order (hand-built, NOT alphabetical): `redirect_uri`?, `state`?, `prompt=select_account`, `code_challenge`, `code_challenge_method=S256`, and `cli_pkce_marker=1` appended when `redirect_uri` is empty (headless manual-code mode).
Session token format: raw token is wrapped as `devin-session-token$<token>` when it starts with `eyJ` and lacks the prefix. Profile enrichment: `GET https://api.devin.ai/v3/self` (`user_name`, `user_id`, `org_id`), user status/quota endpoint (`email`, `plan`, quota percents) — best effort. Auth-file schema: `{type:"devin", api_key:<session token>, session_token, user_name, user_id, org_id, auth_kind:"oauth", email?, plan?}` + attributes `base_url=https://server.codeium.com`; file name `devin-<sanitized identifier>.json` (identifier = user_name | user_id | `user-<8-hex-of-sha256(token)>`; sanitize non-`[A-Za-z0-9-_.@]` → `_`, hash fallback when the sanitized form changes the string or exceeds 160 chars) (evidence: `internal/auth/devin/record.go`).

### 2.4 OAuth callback routes on the main server port (recordable)

Plain callback routes (evidence: `internal/api/server_routes.go`):
- `GET /anthropic/callback`, `GET /codex/callback`, `GET /antigravity/callback`: read query `code`, `state`, `error` (fallback `error_description`). If `state` is non-empty, attempt to persist a callback file for a matching pending session (see 2.5); write failures are ignored. Always respond `200`, `Content-Type: text/html; charset=utf-8`, body = fixed success HTML (auto-close script, 5s window). No auth required.
- `GET /callback` and `GET /devin/callback` (Devin; stricter): `Cache-Control: no-store` always; missing both `code` and `error` → `400` `{"error":"code or error is required"}`; no matching pending session → `400` `{"error":"invalid or expired OAuth callback"}`; else write callback file and respond `200` success HTML.

Management-plane callback route (NO management key; availability middleware applies): `POST /v0/management/oauth-callback` and `GET /v0/management/oauth-callback` (evidence: `internal/api/server_management.go`, `internal/api/handlers/management/oauth_callback.go`):
- POST body JSON: `provider`, `redirect_url` (optional; parsed, its query used as fallback source for state/code/error), `code`, `state`, `error`.
- GET query: `provider`, `code`, `state`, `error` (fallback `error_description`).
- Validation order and responses (all JSON `{"status":...,"error":...}`):
  1. Unparseable POST body → `400` `{"status":"error","error":"invalid body"}`.
  2. Missing `state` → `400` `... "state is required"`.
  3. `state` fails validation (regex `[A-Za-z0-9._-]{1..128}`, no path separators, no `..`) → `400` `"invalid state"`.
  4. Missing both `code` and `error` → `400` `"code or error is required"`.
  5. Unknown/expired session state → `404` `"unknown or expired state"`.
  6. Completed session → `409` `"oauth flow is already completed"`.
  7. Provider normalization fails (`anthropic|claude`, `codex|openai`, `antigravity|anti-gravity`, `xai|x-ai|x.ai|grok`, `devin|cognition`, `meta|muse`; plugins: `[a-z0-9-]+`) → `400` `"unsupported provider"`.
  8. Session already carries an error status → `409` with that status message.
  9. Provider ≠ session provider → `400` `"provider does not match state"`.
  10. Success → `200` `{"status":"ok"}` and the callback file is published (atomic temp-file rename) for the pending login goroutine.

### 2.5 In-memory OAuth session store & login endpoints

Session store (evidence: `internal/api/handlers/management/oauth_sessions.go`): keyed by state; TTL 30 min pending (covers xAI 30m / Kimi 15m device flows), 1 min after completion; purge on access; state validation as above; provider normalized lowercase. `Cancel` only removes still-pending sessions. Callback-file handshake: login goroutines poll every 500 ms for file `.oauth-<provider>-<state>.oauth` in the auth dir; the file is JSON `{code, state, error}` written atomically; waiters treat "session no longer pending" as a silent abort (no credential save). Before saving credentials, waiters re-check the session is still pending (cancel race guard).

Login-URL endpoints (all `GET`, management key required, listed in 2.2's pipeline; evidence: `internal/api/handlers/management/auth_files_provider_oauth.go`):
| Endpoint | Effect | 200 body (map-serialized; key set as shown, order alphabetical per Go JSON map marshaling — recorded fixture is authoritative) |
|---|---|---|
| `/v0/management/anthropic-auth-url` | Builds Claude authorize URL (PKCE + state); registers session `anthropic`; background waiter (5 min) | `{"state":<32-hex>,"status":"ok","url":<authorize URL>}` — key order alphabetical (recorded) |
| `/v0/management/codex-auth-url` | Same for Codex (`codex` session) | same shape, Codex URL |
| `/v0/management/antigravity-auth-url` | Same for Antigravity (fixed redirect 51121) | same shape, Google URL |
| `/v0/management/devin-auth-url` | Builds Devin URL with `redirect_uri=http://127.0.0.1:<port>/callback`; session `devin` | same shape, Devin URL |
| `/v0/management/kimi-auth-url` | Starts LIVE Kimi device flow (network to auth.kimi.com) | `{"expires_in":<s>,"flow":"device","state":"kmi-<unixns>","status":"ok","url":<verification uri>,"user_code":<code>}` |
| `/v0/management/xai-auth-url` | LIVE xAI OIDC discovery + device flow | same shape, `state":"xai-<unixns>"` |
| `/v0/management/meta-auth-url` | LIVE Meta device flow | same shape, `state":"meta-<unixns>"` |
Notes (recorded): ALL these JSON bodies serialize keys alphabetically, including nested objects (Go map marshaling), e.g. `{"error":"...","status":"error"}`, `{"cancelled":true,"status":"ok"}` — the recorded fixtures are byte-authoritative. `&` characters inside JSON string values (the `url` query separator) are emitted as `\u0026` (Go `encoding/json` HTML escaping) — byte-relevant for the rewrite's JSON encoder. State values for device flows embed the current Unix nanoseconds (`kmi-` for Kimi — not `kimi-`). `expires_in` falls back to the provider's max poll duration (xAI 1800, Kimi 900, Meta 900) when the device response omits it. `is_webui` query (`1|true|yes|on`) additionally starts a loopback forwarder binding the provider's fixed port (54545/1455/51121) which forwards browser callbacks to the main-port route — OPTIONAL in the serverless rewrite (runtime adapter concern).
Failure mode: any local URL-building error → `500` `{"error":"failed to generate PKCE codes"|"failed to generate state parameter"|"failed to generate authorization url"|"callback server unavailable"|"failed to start callback server"}`.

Status & cancel:
- `GET /v0/management/get-auth-status?state=<state>`: no `state` param → `200` `{"status":"ok"}`; invalid state → `400` `{"status":"error","error":"invalid state"}`; unknown/expired → `200` `{"status":"error","error":"unknown or expired state"}`; completed → `200` `{"status":"ok"}`; failed → `200` `{"status":"error","error":"<session error message>"}` (e.g. `Timeout waiting for OAuth callback`, `Bad request`, `State code error`, `Failed to exchange authorization code for tokens`, `Failed to save authentication tokens`, provider-specific messages); otherwise pending → `200` `{"status":"wait"}`.
- `DELETE /v0/management/oauth-session?state=<state>`: missing → `400` `{"status":"error","error":"missing state"}`; invalid → `400` `{"status":"error","error":"invalid state"}`; else `200` `{"status":"ok","cancelled":<bool>}` (`false` when the session was already gone/completed/errored).

### 2.6 Device-code flows (RFC 8628)

General contract per RFC 8628: device authorization request → `{device_code, user_code, verification_uri, verification_uri_complete, expires_in, interval}` → poll token endpoint with the device grant until success or terminal error; honor `authorization_pending` (keep interval), `slow_down` (increase interval), `expired_token`, `access_denied`.

| | Kimi | xAI | Meta | Codex (device) |
|---|---|---|---|---|
| Discovery | fixed endpoints | `GET https://auth.x.ai/.well-known/openid-configuration` → `device_authorization_endpoint`, `token_endpoint`; both must be `https` on `x.ai`/`*.x.ai` else error | fixed endpoints | fixed endpoints |
| Device auth request | POST `https://auth.kimi.com/api/oauth/device_authorization`, form `client_id=17e5f671-d194-4dfb-9706-5516cb48c098` + `X-Msh-*` headers | POST discovery endpoint, form `client_id=b1a00492-073a-47ea-816f-4c329264a828`, `scope=openid profile email offline_access grok-cli:access api:access` | POST `https://auth.meta.com/oidc/device/authorization/`, form `client_id=1031625952748946`, `User-Agent: muse-code/1.0.2` | POST `https://auth.openai.com/api/accounts/deviceauth/usercode`, JSON `{"client_id":"app_EMoamEEZ73f0CkXaXp7hrann"}` |
| Response | `{device_code, user_code, verification_uri?, verification_uri_complete, expires_in, interval}` | same + endpoints recorded | same | `{device_auth_id, user_code|usercode, interval (string or number, default 5)}` |
| Poll request | POST `https://auth.kimi.com/api/oauth/token` form `client_id`, `device_code`, `grant_type=urn:ietf:params:oauth:grant-type:device_code` (+ X-Msh headers) | POST token endpoint form `grant_type`, `device_code`, `client_id` | POST `https://auth.meta.com/oidc/device/token/` form `grant_type`, `device_code`, `client_id`, `User-Agent: muse-code/1.0.2` | POST `https://auth.openai.com/api/accounts/deviceauth/token` JSON `{device_auth_id, user_code}` |
| Pending/slow_down | HTTP 200 with `error` JSON body: `authorization_pending` → continue; `slow_down` → continue at the SAME interval (v7.3.4 does not increase); `expired_token` → fail `kimi: device code expired`; `access_denied` → fail `kimi: access denied by user` | error JSON regardless of status: `authorization_pending` → same interval; `slow_down` → interval += 5s; `expired_token`/`access_denied` → fail | non-200 error JSON: `authorization_pending` → continue; `slow_down` → interval += 5s (ticker reset); `access_denied`/`expired_token` → fail; unknown error string → fail; unexpected non-200 without error → warn + continue | 403/404 → keep polling at interval; other non-2xx → fail; 2xx → `{authorization_code, code_verifier, code_challenge}` |
| First poll | after one interval (ticker) | immediate, then interval | after one interval | immediate loop, then interval |
| Interval floor | 5s | 5s | 5s | 5s default |
| Deadline | min(15 min, expires_in) | min(30 min, expires_in) | min(15 min, expires_in) | 15 min |
| Success payload | `{access_token, refresh_token, token_type, expires_in, scope}` | `{access_token, refresh_token, id_token, token_type, expires_in}` (email/sub from ID-token JWT) | `{access_token, token_type, expires_in}` → then key minting below | code+PKCE → standard Codex code exchange with `redirect_uri=https://auth.openai.com/deviceauth/callback` |
| Post-token | — | — | `POST https://api.meta.ai/muse-code/key` JSON `{"dca_token":<access_token>}`, `Authorization: Bearer <dca_token>`, `User-Agent: muse-code/1.0.2` → `{api_key, base_url, user_email, user_full_name, subs_tier_*, ...}`. If minted: stored `access_token` := `api_key` and `expired` left EMPTY (API key has no DCA deadline); else `expired` := DCA expiry. Mint failure is non-fatal for login. | — |
| Verification URL | `verification_uri_complete` | `verification_uri_complete` | `verification_uri_complete` | `https://auth.openai.com/codex/device` |
| Refresh lead | 5 min | 5 min | none (on-demand re-mint on 401) | n/a (24h via code-flow auth) |
| Refresh request | form `client_id`, `grant_type=refresh_token`, `refresh_token` (+X-Msh headers) | form `grant_type=refresh_token`, `client_id`, `refresh_token` (endpoint from discovery, no scope) | no refresh-token grant; 401 → re-`POST /muse-code/key` with stored `dca_token` | code-flow refresh (2.3.2) |
Evidence: `internal/auth/kimi/kimi.go`, `internal/auth/xai/{xai.go,types.go}`, `internal/auth/meta/meta.go`, `sdk/auth/codex_device.go`.

### 2.7 Token refresh lifecycle (manager-level)

Constants (evidence: `sdk/cliproxy/auth/conductor_refresh.go`, `auto_refresh_loop.go`, `refresh_registry.go` + per-provider `RefreshLead`):
| Parameter | Value |
|---|---|
| Refresh-check loop interval | 5 s (timer wake capped at 30 s for suspend-resume) |
| Max concurrent refreshes | 16 |
| Pending backoff (refresh in flight) | 1 min (`NextRefreshAfter`) |
| Failure backoff | 5 min |
| Ineffective backoff (refresh "succeeded" but expiry unchanged) | 30 s |
| Refresh leads | claude 4h, codex 24h, antigravity 30m, kimi 5m, xai 5m, meta none, devin none; API-key credentials never scheduled |
| Optional per-credential override | metadata/attribute `refresh_interval_seconds` (or `refreshIntervalSeconds`/`refresh_interval`/`refreshInterval`, number or Go duration string): refresh when `now - last_refresh >= interval` or within `interval` of expiry |

Scheduling rule (`shouldRefresh`): never for API-key credentials; skip if a per-auth `NextRefreshAfter` is in the future; with a lead: refresh when `time-to-expiry <= lead` (or `now - last_refresh >= lead` when no expiry is known); with a preferred interval: same modulo the interval. Expiry is parsed from the auth file's `expired` (RFC3339) field.

Refresh-on-401 (evidence: `conductor_refresh.go` `tryRefreshAfterUnauthorized`): during request execution, an upstream error is unauthorized if its status code is 401 or its text contains `status 401`/`401 unauthorized`. If unauthorized and the credential has a `refresh_token` (or, for Meta only, a `dca_token`):
1. Request-scoped errors do NOT trigger refresh (a direct upstream 401 body mapped as request-scoped is surfaced, not retried).
2. At most one synchronous refresh per request (`alreadyTried`).
3. Per-credential mutex; concurrent requests reuse a newer token when the failed access token already differs from the current one.
4. Refresh failure with 401 → credential marked `unavailable`, status `error`, status message `unauthorized`, `NextRefreshAfter` zeroed — excluded from scheduling and selection until a successful login/refresh; other failures → backoff 5 min while retaining the credential if its access token is still valid.
5. Success → `LastRefreshedAt = now`, backoff cleared, previous error cleared, `status = active`, unauthorized model states cleared, and the updated auth persisted through the Store.

Successful refresh persists the new token set through the file store (S6 pointer: `sdk/auth/filestore.go`), merging metadata and preserving login-time fields (e.g. disabled state, proxy_url, prefix).

## 3. Schemas

### 3.1 Error bodies (auth plane)
- Client 401 (non-realtime): `{"error":"<string>"}` — `Missing API key` / `Invalid API key`.
- Client 401 (realtime): OpenAI-shaped object (§2.1); recorded nested key order is alphabetical: `{"error":{"code":"invalid_api_key","message":"...","param":null,"type":"authentication_error"}}`.
- Safe mode 403: `{"error":"unsafe_example_api_key","message":"..."}`.
- Management 401/403: `{"error":"<message>"}` (§2.2).
- Management OAuth session endpoints: `{"status":"ok"|"wait"|"error","error"?:string,...}` (§2.5).
- Plain callback routes: fixed HTML (success page) or `{"error":"..."}` for Devin validation.

### 3.2 Auth-file on-disk schemas (per provider; files under the auth dir, default `~/.cli-proxy-api`)
Store rules (evidence: `sdk/auth/filestore.go`): recursive walk; loads `*.json` (case-insensitive) only; a file whose `type` is `gemini` is silently SKIPPED (Gemini CLI OAuth is not a supported credential type in v7.3.4); provider = `type` (trimmed; missing → `unknown`); shared keys: `disabled` (bool), `proxy_url` (string), `prefix` (string, `/`-trimmed, no inner slashes), `label` (fallback `email`, then `project_id`); invalid credential-weight values drop the file silently; saves create dirs 0700 / files 0600 and inject `disabled` into the persisted JSON.

| type | Fields (JSON keys as persisted) | File name |
|---|---|---|
| `claude` | `id_token`, `access_token`, `refresh_token`, `last_refresh`, `email`, `account_uuid?`, `organization_uuid?`, `organization_name?`, `claude_device_ids?` (array, one 64-hex-char device id), `type`, `expired` (RFC3339; note the key is `expired`, though the in-memory field is "Expire") | `claude-<8-hex>-<email>.json` (legacy `claude-<email>.json`) |
| `codex` | `id_token`, `access_token`, `refresh_token`, `account_id`, `last_refresh`, `email`, `type`, `expired` | `codex-<8-hex>-<email>[-<plan>].json` (legacy `codex-<email>[-<plan>].json`) |
| `kimi` | `access_token`, `refresh_token`, `token_type`, `scope?`, `device_id?`, `expired?`, `type` (+ login metadata: `timestamp` unix ms) | `kimi-<unix-ms>.json` |
| `xai` | `access_token`, `refresh_token`, `id_token`, `token_type`, `expires_in`, `expired`, `last_refresh`, `base_url`, `token_endpoint`, `auth_kind:"oauth"`, `email?`, `sub?` (+ `timestamp`) | `xai-<sanitized email|sub|-<unixms>>.json` |
| `meta` | `auth_kind:"oauth"`, `access_token`, `dca_token?`, `api_key?`, `token_type?`, `expires_in?`, `expired?`, `dca_expired?`, `dca_expires_at?`, `last_refresh?`, `base_url?`, `email?`, `name?` — persisted 2-space-indented with trailing newline via atomic temp-file rename; credential fields are never restored from stale metadata | `meta-<sanitized email>-<8-hex>.json` (see upstream `CredentialFileName`) |
| `antigravity` | `type`, `access_token`, `refresh_token`, `expires_in`, `timestamp` (unix ms), `expired` (RFC3339), `email?`, `project_id?` | `antigravity[-<email>].json` |
| `devin` | `type`, `api_key` (= session token), `session_token`, `user_name?`, `user_id?`, `org_id?`, `auth_kind:"oauth"`, `email?`, `plan?` | `devin-<sanitized id>.json` |
OAuth callback handshake files: `.oauth-<provider>-<state>.oauth`, JSON `{code, state, error}`, atomic publish, removed after consumption; `.oauth-*` naming keeps them out of the `*.json` walk.

### 3.3 Login-URL response schema
`{"status":"ok","url":string,"state":string}` (+`"flow":"device"`, `"user_code":string`, `"expires_in":number` for device flows). `state` is the session key used by `get-auth-status` / `oauth-session` / `oauth-callback`.

## 4. Streaming rules
None of the S3 surfaces produce SSE. Auth-related HTTP responses are single-shot JSON/HTML. The only sequencing contract is the OAuth/login request flow itself (authorize URL → callback → status polling), specified in §2.3–2.5 and encoded in the multi-request golden cases. Byte-exact comparisons for S3 goldens mask only the whitelisted dynamic fields (`Date`, `X-CPA-*` build headers where recorded, trace ids, random `state`/PKCE values, ban countdown, ports).

## 5. Error semantics (summary matrix)
| Surface | Condition | Status | Body |
|---|---|---|---|
| `/v1*`,`/v1beta*`,`/openai/v1*`,`/backend-api/codex*` | no credential anywhere | 401 | `{"error":"Missing API key"}` |
| same | credential present, no match | 401 | `{"error":"Invalid API key"}` |
| same | template api-key safe mode | 403 | `{"error":"unsafe_example_api_key","message":...}` + `X-CPA-SAFE-MODE: example-api-key` |
| realtime group | auth failure | 401 | OpenAI-shaped `authentication_error`/`invalid_api_key` (§2.1) |
| `/v0/management/*` | routes not enabled (no secret) | 404 | empty (R-404) |
| same | banned IP | 403 | `IP banned due to too many failed attempts. Try again in <duration>` |
| same | remote client, allow-remote false | 403 | `remote management disabled` |
| same | no key presented | 401 | `missing management key` |
| same | wrong key | 401 | `invalid management key` |
| `/anthropic|codex|antigravity/callback` | any query | 200 | success HTML (write failures ignored) |
| `/callback`,`/devin/callback` | no code+error | 400 | `{"error":"code or error is required"}` |
| same | no pending session | 400 | `{"error":"invalid or expired OAuth callback"}` |
| `/v0/management/oauth-callback` | see §2.4 ladder | 400/404/409/200 | `{"status":"error","error":...}` / `{"status":"ok"}` |
| `get-auth-status` | per §2.5 | 200/400 | `{"status":...}` |
| `oauth-session` DELETE | per §2.5 | 200/400 | `{"status":...,"cancelled":...}` |
| login-URL endpoints | local build failure | 500 | `{"error":"failed to ..."}` |

## 6. Golden samples index
Recording request: `spec/recordings/S3.cases.json` (48 cases: 38 RECORDABLE-LOCALLY + 10 FIXTURE-DEFERRED). Fixtures land under `tests/fixtures/S3/<case-id>/` per the RECIPES layout (meta.yaml, request.http, downstream.md; `upstream.jsonl`/`mock-response.json` not applicable — S3 exercises the reference binary itself on `127.0.0.1:18317`, no provider mock). Config instances beyond the default oracle template: `open` (api-keys removed), `safemode` (`your-api-key-1`), `no-mgmt-secret`, `mgmt-local-only` (allow-remote false), `fresh-ban` (fresh container for the IP-ban pair; ordering constraints in the cases file).

Case groups:
- Inbound api-key matrix (10): missing / invalid / valid Bearer, raw Authorization (no Bearer prefix), x-goog-api-key, x-api-key, query `key`, query `auth_token`, open-when-unconfigured, safemode 403.
- Realtime auth shapes (2): missing key, invalid key — OpenAI-shaped 401.
- Management authz (8): missing key, invalid key, valid X-Management-Key, valid Bearer, remote-disabled 403, unconfigured-404, ban-reset-on-success, ban-after-5-invalid.
- Plain OAuth callback routes (4): anthropic/codex unknown-state 200-HTML, devin missing 400, devin unknown 400.
- `/v0/management/oauth-callback` ladder (5): invalid body, missing state, invalid state, missing code, unknown state 404.
- Login-URL endpoints (4): anthropic, codex, antigravity, devin (URL structure byte-asserted with masked random values).
- Session lifecycle (2 multi-request): full pending→wait→cancel→expired→404 lifecycle; provider-mismatch 400.
- Status/cancel edges (3): empty status, invalid state, missing state.
FIXTURE-DEFERRED (10): claude/codex/antigravity/devin live exchanges, claude/codex refresh flows, kimi/xai/meta live device flows, device-auth-url endpoints (live vendor call), refresh-on-401 — all CREDENTIALED-ONLY per R-FIXTURE; documented in S3 §2.3/§2.6/§2.7 and the cases file.

**Delivered (oracle-runner-2, recorded 2026-09-15 against the anchored image on an isolated stack; instance port and `Host`/`redirect_uri` port occurrences are masked dynamic fields):** all 38 recordable cases exist under `tests/fixtures/S3/<case-id>/` — 38 case directories, 57 recorded response transcripts (47 request files). Layout per RECIPES with the multi-step extension: single-request cases = `meta.yaml` + `request.http` + `downstream.md`; multi-request cases = `request.http`/`request-N.http` and `downstream.md`/`downstream-<step>.md`; repeated steps = `downstream-<step>r<i>.md`. `meta.yaml` carries the full request/response file map with `(step, repeat, status)` per response, `$S` substitution values, the instance config fragment, and `dynamic_fields`.

Per-group fixture counts:
- api-key matrix (10): `s3-apikey-{missing,invalid-bearer,valid-bearer,raw-authorization,x-goog,x-api-key,query-key,query-auth-token}` + `s3-apikey-open-when-unconfigured` + `s3-safemode-example-key` (2 responses incl. the `GET /` warning HTML, served `200`, not 403).
- realtime shapes (2): `s3-realtime-{unauth,invalid-key}`.
- management authz (8): `s3-mgmt-{missing-key,invalid-key,valid-x-management-key,valid-bearer,remote-disabled,unconfigured-404,ban-reset-on-success,ban-after-5-invalid}`.
- plain callback routes (4): `s3-oauth-callback-{anthropic,codex}-unknown-state`, `s3-oauth-callback-devin-{missing,unknown}`.
- management oauth-callback ladder (5): `s3-mgmt-oauth-callback-{invalid-body,missing-state,invalid-state,missing-code,unknown-state}`.
- login-URL endpoints (4): `s3-auth-url-{anthropic,codex,antigravity,devin}`.
- session lifecycle (2): `s3-oauth-session-lifecycle` (5 steps), `s3-mgmt-oauth-callback-provider-mismatch` (2 steps).
- status/cancel edges (3): `s3-get-auth-status-{empty,invalid-state}`, `s3-cancel-session-missing-state`.

Recorded confirmations folded into §2: alphabetical JSON key order everywhere (incl. nested realtime object), `\u0026` escaping inside URL values, `X-Cpa-*` build headers on every management response (incl. 401/403) and their absence on `/v1` auth rejections, no `X-Cpa-Trace-Id` on auth/management surfaces, ban countdown format `30m0s` on the first banned request, safemode root page `200`, and the `config_fragment` in lifecycle fixtures showing the already-bcrypted `secret-key` (startup mutation evidence).

**Replay caveat (ban pair):** the per-IP failure counter is cumulative for the server instance lifetime. The goldens were recorded with the reset case immediately followed by the ban case in ONE fresh instance, so the 4 counted failures of the reset case's step 3 carry over: `s3-mgmt-ban-after-5-invalid` records `[401, 403, 403, 403, 403, 403]` — its first request is cumulative failure #5 (that request is still answered 401; the ban applies to subsequent requests). Replay both fixtures in this order and this instance discipline, or a standalone replay of the ban case on a fresh counter would yield `[401×5, 403]`. `s3-mgmt-ban-reset-on-success` records `[401×4, 200, 401×4]` (9 responses) and never bans in-case.

FIXTURE-DEFERRED (10, see `spec/recordings/S3.cases.json` for reasons): `s3-def-{claude-token-exchange, claude-refresh, codex-token-exchange, antigravity-exchange, kimi-device-flow, xai-device-flow, meta-device-flow, devin-exchange, device-auth-url-endpoints, refresh-on-401}`.

## 7. Open questions and intentional non-equivalences
- O-1: Inbound API-key comparison is a plain map lookup (not constant-time). Mirror for behavioral equality, or register a security non-equivalence? Default: mirror; timing is not observable in wire goldens.
- O-2: "Open proxy when `api-keys` is empty" is dangerous but recorded reality. S7 may register a degradation (default-deny) — decision needed at gate.
- O-3: `/anthropic/callback` etc. answer `200` success HTML even when the state matches no pending session (write failure swallowed). Recorded reality; flagged for the gate.
- O-4: Loopback OAuth callback servers (ports 54545/1455/51121/ephemeral, plain net/http 405/400/302 semantics) are process-level behavior. In the serverless baseline they become a runtime adapter (runtimes/node) or are satisfied by the `is_webui` main-port forwarding path only. Proposed: main-port callback routes are the contract; loopback servers are OPTIONAL (runtimes/node only).
- O-5: Kimi `slow_down` does not increase the poll interval in v7.3.4 (comment claims caller handling; none exists). Mirror the no-op, or fix and register non-equivalence? Default: mirror.
- O-6: The Codex "device flow" is OpenAI's proprietary deviceauth API, not RFC 8628 wire format. Specified as-is.
- O-7: `remote management key not set` (403) is effectively unreachable in normal startup (routes stay unregistered → 404). Kept in the matrix for hot-reload parity; no golden.
- O-8: Gemini CLI/AIStudio OAuth is NOT supported in v7.3.4 (no login flow; `type:"gemini"` auth files are skipped on load). Any Gemini support is API-key only (`gemini-api-key`), per R-FIXTURE.
- N-1 (non-equivalence, registered): CPA-Edge implements auth logic in runtime-agnostic TypeScript (Web Crypto for PKCE/random state, bcrypt via a vetted Web-compatible lib in runtimes if needed); no behavioral divergence is intended; algorithm outputs (state length, S256 challenge, RFC3339 formats) are byte-identical.
