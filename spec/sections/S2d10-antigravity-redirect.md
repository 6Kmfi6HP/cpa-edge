# S2d10 — Antigravity provider: OAuth redirect rules, loopback callback, and `v1internal` wire

Section id: S2d10. Module: `packages/executors` (antigravity executor) + `packages/auth` (antigravity OAuth) + `packages/management` (login endpoints) + routing mounted by `runtimes/*`.
Upstream anchor: CLIProxyAPI v7.3.4, commit `8335eac731946bd4eff18f500653f93736df53d6` (see SPEC.md §0).
Upstream evidence paths in this section are relative to the upstream repo root.

Classification (R-FIXTURE, SPEC.md §5): Antigravity is a CREDENTIALED-ONLY provider (Google OAuth, fixed vendor endpoints). Everything in §2 (login/redirect/session surface) is RECORDABLE-LOCALLY and has goldens; everything in §3–§4 (live upstream traffic with real Google tokens) is specified from upstream source and marked FIXTURE-DEFERRED, except the error paths that a synthetic credential can still drive locally (see §6 and `spec/recordings/S2d10.cases.json`).

---

## 1. Scope and boundaries

IN scope:
- The Antigravity login surface: `GET /v0/management/antigravity-auth-url`, the temporary loopback callback forwarder on port 51121, `GET /antigravity/callback` on the main port, `GET|POST /v0/management/oauth-callback`, `GET /v0/management/get-auth-status`, `DELETE /v0/management/oauth-session`.
- The **redirect rule set**: exactly which interactions answer with an HTTP redirect (3xx + `Location`), which answer 200 with a body, and which are proxied through to the upstream with no redirect at all.
- The Antigravity upstream wire: fixed endpoints under `cloudcode-pa.googleapis.com` / `daily-cloudcode-pa.googleapis.com` with API version `v1internal`, request envelope, response envelope, SSE rules, count-tokens shape, model-list probe, and the auth-time control-plane calls (`loadCodeAssist`, `onboardUser`, token exchange/refresh).
- Model mapping: how a client-visible model id becomes the upstream `model` field, thinking-suffix parsing, image-model rules, Claude-on-Antigravity rules, catalog sources.

OUT of scope (owned elsewhere):
- Client-protocol translation matrices (OpenAI chat / Gemini / Claude / Responses / Interactions → Antigravity) — the pairwise translators are referenced in §3.1 but field-by-field mapping tables belong to the S2d1–S2d9 family; see §8 open question 1.
- Credential scheduling, rotation, alias resolution, `force-mapping` response rewriting, cooldown persistence — S4.
- Generic management middleware (auth styles, ban, CORS block), `get-auth-status`/`oauth-session` generic envelopes — S5 (this section pins only the Antigravity-specific values).
- OAuth flow internals shared across providers (state validation rules, callback-file protocol, session store TTLs) — S3; S2d10 cites the exact Antigravity-specific strings and behaviors.
- Usage-record shape, request/response logging — S6.
- The `/v0/management/model-definitions/antigravity` catalog endpoint — S5 (S5-model-definitions golden).

Intentional non-equivalences are listed in §8.

---

## 2. Behavior inventory — login, redirect, and callback surface

### 2.1 Provider constants (public interface values; MUST match for compatibility)

| Constant | Value | Evidence |
|---|---|---|
| OAuth client id | `1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com` | `internal/auth/antigravity/constants.go` (`ClientID`), duplicated in `internal/api/handlers/management/api_tools.go` |
| OAuth client secret | `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` | `internal/auth/antigravity/constants.go` (`ClientSecret`) |
| Loopback callback port | `51121` | `internal/auth/antigravity/constants.go` (`CallbackPort`) |
| Loopback callback path | `/oauth-callback` (loopback server) / `/antigravity/callback` (main port) | `sdk/auth/antigravity.go`, `internal/api/server_routes.go` |
| Authorization endpoint | `https://accounts.google.com/o/oauth2/v2/auth` | `internal/auth/antigravity/constants.go` (`AuthEndpoint`) |
| Token endpoint | `https://oauth2.googleapis.com/token` | `constants.go` (`TokenEndpoint`); refresh also hardcodes it in `internal/runtime/executor/antigravity_executor_auth.go` |
| Userinfo endpoint | `https://www.googleapis.com/oauth2/v2/userinfo?alt=json` | `constants.go` (`UserInfoEndpoint`) |
| Scopes (space-joined, order fixed) | `https://www.googleapis.com/auth/cloud-platform`, `https://www.googleapis.com/auth/userinfo.email`, `https://www.googleapis.com/auth/userinfo.profile`, `https://www.googleapis.com/auth/cclog`, `https://www.googleapis.com/auth/experimentsandconfigs` | `constants.go` (`Scopes`) |
| Request API base (default) | `https://daily-cloudcode-pa.googleapis.com` | `internal/runtime/executor/antigravity_executor.go` (`antigravityBaseURLDaily`) |
| Auth-time control plane | `https://cloudcode-pa.googleapis.com` (loadCodeAssist), `https://daily-cloudcode-pa.googleapis.com` (onboardUser) | `constants.go` (`APIEndpoint`, `DailyAPIEndpoint`) |
| API version path segment | `v1internal` | `constants.go` (`APIVersion`) |
| Sandbox base (probe fallback only) | `https://daily-cloudcode-pa.sandbox.googleapis.com` | `internal/runtime/executor/antigravity_executor.go`, `cmd/fetch_antigravity_models/main.go` |
| Hub updater manifest | `https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/manifest/latest-arm64-mac.yml` | `internal/misc/antigravity_version.go` |
| Hub platform string | `darwin/arm64` | same |
| Fallback client version | `2.9.1` | same (`antigravityFallbackVersion`; Cloud Code rejects models for clients < 2.9.0, so the floor must stay ≥ 2.9.0) |

MUST: the redirect URI in the authorization URL is always `http://localhost:51121/oauth-callback` (management flow builds it with the fixed `CallbackPort`; the CLI flow uses the actually bound port, normally 51121). The management flow does NOT redirect `redirect_uri` to the main port — the main-port hop happens via the 302 forwarder below.

### 2.2 `GET /v0/management/antigravity-auth-url` — start login session

Evidence: `internal/api/server_management.go` (route in auth group), `internal/api/handlers/management/auth_files_provider_oauth.go` (`RequestAntigravityToken`).

MUST:
- Method GET only; wrong method → 404 empty body (R-404).
- Management key required (S5 §2.2 auth rules).
- On success: HTTP **200** with JSON body `{"status":"ok","url":"<authorization URL>","state":"<state>"}`. Go marshals `gin.H` maps with alphabetical keys, so the exact byte order is `{"state":"...","status":"ok","url":"..."}`. The endpoint NEVER issues a 3xx (the WebUI opens `url` itself).
- `state` is 32 lowercase hex chars (`crypto/rand` 16 bytes hex; `internal/misc/oauth.go` `GenerateRandomState`). `state` is dynamic per request.
- The authorization URL is `AuthEndpoint` + `?` + form-encoded params **in alphabetical key order** (Go `url.Values.Encode`): `access_type=offline`, `client_id=<ClientID>`, `prompt=consent`, `redirect_uri=http%3A%2F%2Flocalhost%3A51121%2Foauth-callback`, `response_type=code`, `scope=<five scopes, space-separated, spaces encoded as %20>`, `state=<state>`.
- The session is registered as provider `antigravity` (pending, TTL 30 minutes; completed sessions live 1 minute; `internal/api/handlers/management/oauth_sessions.go`).
- A background waiter goroutine starts immediately: it polls the auth dir every 500 ms for `.oauth-antigravity-<state>.oauth`, up to 5 minutes, and exits silently if the session stops being pending (cancelled/completed/errored/expired).
- Error paths: state generation failure → 500 `{"error":"failed to generate state parameter"}` (not locally reproducible, specified only).

### 2.3 The loopback forwarder (webui mode) — the ONLY 302 in the Antigravity flow

Evidence: `internal/api/handlers/management/auth_files_provider_oauth.go` + `auth_files_oauth_callback.go` (`isWebUIRequest`, `startCallbackForwarder`, `managementCallbackURL`).

MUST:
- The forwarder is started ONLY when the auth-url request carries query param `is_webui` with value (case-insensitive) `1`, `true`, `yes`, or `on`. Without the flag, NO listener on 51121 is opened by the server at all.
- It binds `0.0.0.0:51121`. If the bind fails → the auth-url request returns **500 `{"error":"failed to start callback server"}`** (the session stays registered; the waiter still runs).
- It serves ANY method and ANY path (the handler is the server root handler, not a path mux).
- For every request it responds **302 Found** with:
  - `Cache-Control: no-store`
  - `Location: <scheme>://127.0.0.1:<main-server-port>/antigravity/callback` + (if the incoming request had a query string) `?` + the incoming **raw query unchanged** (or `&` if the target already had a query — it never does for this provider).
  - The incoming request **path is discarded**; the Location path is always exactly `/antigravity/callback`.
  - Scheme is `https` when `tls.enable` is true, else `http`. Host is always literal `127.0.0.1` (not the external host/port the client used).
  - Go's `http.Redirect` also writes a small HTML body for GET/HEAD requests (`<a href="...">Found</a>.`).
- Lifecycle: an existing forwarder on the same port is stopped first (a second `is_webui` flow replaces it); the forwarder is stopped when the background waiter exits (completion, cancel, error, or the 5-minute timeout). It is NOT stopped between the 302 hop and session completion.

Rule (redirect vs proxy-through): the forwarder REDIRECTS the browser; it never terminates the OAuth flow itself. The redirect target (main port `/antigravity/callback`) is the component that persists `code`/`state`.

### 2.4 `GET /antigravity/callback` — main-port OAuth callback

Evidence: `internal/api/server_routes.go`.

MUST:
- Registered unconditionally on the main engine; NO API-key auth, NO management availability requirement. `OPTIONS` is auto-answered 204 + CORS (S1); wrong methods → 404 empty body (R-404).
- Query params read: `code`, `state`, `error` (fallback `error_description` when `error` is empty). All other params ignored.
- Behavior: if `state` is non-empty, attempt to persist a callback file via the pending-session protocol (§2.6); the write is best-effort — a non-pending or unknown `state` silently does nothing. The response is then ALWAYS:
  - Status **200**; header `Content-Type: text/html; charset=utf-8`; body is the exact one-line HTML constant `oauthCallbackSuccessHTML`:
    `<html><head><meta charset="utf-8"><title>Authentication successful</title><script>setTimeout(function(){window.close();},5000);</script></head><body><h1>Authentication successful!</h1><p>You can close this window.</p><p>This window will close automatically in 5 seconds.</p></body></html>`
  - The same success HTML is returned for: unknown state, empty state, `error` param present, and successful persistence. There is no failure response variant on this route.
- CORS block on every response (S1/S5 contract).

### 2.5 `GET|POST /v0/management/oauth-callback` — JSON handoff (no management key required)

Evidence: `internal/api/server_management.go` (routes outside the auth group, behind `managementAvailabilityMiddleware`), `internal/api/handlers/management/oauth_callback.go`.

MUST:
- Requires management availability (secret configured); no secret → 404 empty. Does NOT require a valid management key.
- POST body: JSON `{provider?, redirect_url?, code?, state?, error?}`. GET: same fields from the query (`provider`, `code`, `state`, `error` with `error_description` fallback).
- If `redirect_url` is non-empty: parse as URL (parse failure → 400 `{"status":"error","error":"invalid redirect_url"}`) and extract `state`/`code`/`error`/`error_description` from its query when not given directly.
- Validation order and bodies (all JSON objects marshal with alphabetical keys: `{"error":"...","status":"error"}`):
  1. body not parseable JSON (POST) → 400 `{"error":"invalid body"}`
  2. missing state → 400 `{"error":"state is required"}`
  3. state fails validation (S3 rules: ≤128 chars, no `/` `\` `..`, `[A-Za-z0-9._-]` only) → 400 `{"error":"invalid state"}`
  4. both code and error empty → 400 `{"error":"code or error is required"}`
  5. unknown/expired state → 404 `{"error":"unknown or expired state"}`
  6. session already completed → 409 `{"error":"oauth flow is already completed"}`
  7. provider normalization failure → 400 `{"error":"unsupported provider"}` (`antigravity`, `anti-gravity`, `Antigravity` all normalize to `antigravity`)
  8. session has an error status → 409 `{"error":"<session status>"}`
  9. provider does not match the session provider → 400 `{"error":"provider does not match state"}`
  10. session no longer pending → 409 `{"error":"oauth flow is not pending"}` (or the session error status)
- Success: writes the callback file and returns 200 `{"status":"ok"}`.
- Response is always a JSON status object; never HTML, never a redirect.

### 2.6 Callback-file protocol and session status values (Antigravity-specific strings)

Evidence: `internal/api/handlers/management/oauth_sessions.go` (`WriteOAuthCallbackFileForPendingSession`), `auth_files_provider_oauth.go` (waiter goroutine).

MUST:
- Callback file: `<auth-dir>/.oauth-antigravity-<state>.oauth`, content JSON `{"code":"<code>","state":"<state>","error":"<error>"}` (values trimmed; keys alphabetical on the wire), written atomically (temp file + rename).
- Written ONLY while the session is pending (provider must match, state must validate). Unknown/cancelled/completed/errored states are never written.
- The waiter goroutine consumes the file (and deletes it) and sets session status:
  - `error` param non-empty → status `"Authentication failed"`, flow exits. No upstream call is made.
  - state in file ≠ session state → status `"Authentication failed: state mismatch"`.
  - code empty → status `"Authentication failed: code not found"`.
  - token exchange failure (any cause, including network) → status `"Failed to exchange token"`.
  - userinfo failure or empty email → status `"Failed to fetch user info"`.
  - save failure → status `"Failed to save token to file"`.
  - success → session completed (status cleared). Project-ID fetch failure is logged but does NOT fail the flow in the management path (the executor re-fetches on demand).
- `GET /v0/management/get-auth-status?state=<state>` (S5): pending → 200 `{"status":"wait"}`; completed → 200 `{"status":"ok"}`; errored → 200 `{"status":"error","error":"<status>"}`; unknown/expired → 200 `{"status":"error","error":"unknown or expired state"}`; empty/absent state → 200 `{"status":"ok"}`; invalid state chars → 400 `{"error":"invalid state"}`.
- `DELETE /v0/management/oauth-session?state=<state>` (S5): cancels a pending session → 200 `{"cancelled":true,"status":"ok"}`; already gone → `{"cancelled":false,"status":"ok"}`; missing state → 400 `{"error":"missing state","status":"error"}`; invalid state → 400 `{"error":"invalid state","status":"error"}`. Cancel makes the waiter exit without saving credentials.
- Antigravity wait timeout message: `"OAuth flow timed out"` (set at the 5-minute deadline).

### 2.7 Credential file written on success

Evidence: `internal/auth/antigravity/filename.go`, `auth_files_provider_oauth.go` (metadata assembly), `sdk/auth/antigravity.go` (`BuildAntigravityAuth`).

MUST:
- File name `antigravity-<email>.json` in the auth dir (`antigravity.json` when email is empty). Provider `antigravity`, label = email (fallback `antigravity`).
- Metadata fields: `type` = `antigravity`, `access_token`, `refresh_token`, `expires_in` (number, from Google), `timestamp` (unix millis at save), `expired` (RFC3339 = now + expires_in seconds), `email`, `project_id` (when discovered).
- The credential carries NO `base_url` by default → upstream traffic goes to the daily base (§3). A `base_url` attribute/metadata override (or `user_agent`, or a `headers` map → `header:<name>` attributes) is honored by the executor (§3.2); this is the seam that can make executor traffic locally mockable.

### 2.8 CLI login flow (reference for parity; not an HTTP contract surface)

Evidence: `sdk/auth/antigravity.go` (`AntigravityAuthenticator.Login`, `startAntigravityCallbackServer`), `internal/cmd/antigravity_login.go`.
- Binds `:<CallbackPort>` (option overridable); serves ONLY `/oauth-callback` on a Go ServeMux (other paths → ServeMux 404 page).
- Success page: `<h1>Login successful</h1><p>You can close this window.</p>`; failure page: `<h1>Login failed</h1><p>Please check the CLI output.</p>` — 200, no redirect.
- 5-minute overall timeout; optional manual paste of the callback URL after 15 s; browser auto-open with SSH-tunnel hints when unavailable.
- Validation order: `error` param → fail; state mismatch → `invalid state`; empty code → `missing authorization code`; then exchange → userinfo (email required) → `loadCodeAssist` project discovery (project REQUIRED here — empty project fails the CLI flow, unlike the management flow); then the same credential file as §2.7.
- Refresh lead: 30 minutes before expiry (S3 consumes this).

### 2.9 Redirect vs proxy-through — the complete rule set

| Interaction | HTTP behavior | Redirects? |
|---|---|---|
| `GET /v0/management/antigravity-auth-url` | 200 JSON `{state,status,url}` | No |
| Browser → Google consent (the `url` above) | external (accounts.google.com) | n/a (vendor) |
| Google → `http://localhost:51121/oauth-callback?code&state` (webui flow) | lands on the forwarder | vendor redirect, target fixed by redirect_uri |
| Any request to `:51121` while a webui session is pending | **302 Found** → `http(s)://127.0.0.1:<port>/antigravity/callback?<raw query>`, `Cache-Control: no-store` | **Yes — the only proxy-issued redirect** |
| `GET /antigravity/callback?...` (main port) | 200 success HTML (+ best-effort callback-file write) | No |
| `GET|POST /v0/management/oauth-callback` | JSON status object (200/400/404/409) | No |
| Chat/count-token/model traffic for antigravity models (any client protocol) | proxied THROUGH to `daily-cloudcode-pa.googleapis.com/v1internal:*` with translation; errors flow back as JSON | **Never** — no client request is ever answered 3xx |
| `:51121` with NO flow pending | connection refused (nothing listens) | n/a |
| CLI-mode `:51121/oauth-callback` (CLI process running) | 200 HTML login page (no redirect); other paths → Go ServeMux 404 | No |

MUST: CPA-Edge never issues an HTTP redirect outside the `:51121` forwarder; in particular the auth-url endpoint and all chat routes never redirect.

---

## 3. Behavior inventory — upstream executor wire (`v1internal`)

### 3.1 Endpoints (all fixed unless overridden by credential `base_url`)

Evidence: `internal/runtime/executor/antigravity_executor.go` (path constants), `antigravity_executor_request.go`, `antigravity_executor_tokens.go`, `sdk/cliproxy/antigravity_models.go`, `internal/auth/antigravity/auth.go`.

| Call | Method + path | Body | Used for |
|---|---|---|---|
| Generate (non-stream) | `POST {base}/v1internal:generateContent` | antigravity envelope (§3.3) | non-stream requests for Gemini-family models |
| Stream | `POST {base}/v1internal:streamGenerateContent?alt=sse` (default) or `?$alt=<url-encoded alt>` when a non-empty `alt` option is present | same | streaming requests; ALSO used internally for non-stream requests to Claude-family models and then aggregated (§4.4) |
| Count tokens | `POST {base}/v1internal:countTokens` (+ `?$alt=<alt>` when present) | envelope minus `model`/`project`/`request.sessionId`/`request.safetySettings`/`request.toolConfig`/`request.labels` | `/v1/messages/count_tokens`, Gemini `:countTokens` |
| Model capability probe | `POST {base}/v1internal:fetchAvailableModels` | `{}` | per-credential probe (5-min cache) reading `webSearchModelIds[]`; fires BEFORE the first generate/stream call for a credential; probe request carries `Connection: close` (generate/stream do not); a failed probe (e.g. 404) does NOT block generation — recorded in S2d10-executor-request-shape |
| Auth-time project discovery | `POST https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist` | `{"metadata":{"ideType":"ANTIGRAVITY"}}` | reads `cloudaicompanionProject`/`projectId`/`project` (string or `{id}`) |
| Onboarding | `POST https://daily-cloudcode-pa.googleapis.com/v1internal:onboardUser` | `{"tier_id":"<tier>","metadata":{"ide_type":"ANTIGRAVITY","ide_version":"<hub version>","ide_name":"antigravity"}}` | polled up to 5× (2 s apart, 30 s per attempt) until `done:true` + project id; default tier from `allowedTiers[].isDefault` → `currentTier.id` → literal `free-tier` |
| Token exchange | `POST https://oauth2.googleapis.com/token` | form: `code`, `client_id`, `client_secret`, `redirect_uri`, `grant_type=authorization_code` | login |
| Token refresh | `POST https://oauth2.googleapis.com/token` | form: `client_id`, `client_secret`, `grant_type=refresh_token`, `refresh_token` | when token within 5 min of expiry (`antigravityRequestTokenSafetyWindow`); single-flight per refresh token; `User-Agent: Go-http-client/2.0` (quirk: plain Go default for exchange, explicit 2.0 string for refresh) |
| Userinfo | `GET https://www.googleapis.com/oauth2/v2/userinfo?alt=json` | — | email required for login |
| Hub version | `GET <hub manifest URL>` | — | UA version; 6 h TTL, headers `User-Agent: electron-builder`, `Cache-Control: no-cache`; fallback 2.9.1 |

MUST: base URL resolution is `credential base_url override → https://daily-cloudcode-pa.googleapis.com` for generate/stream/countTokens; the override also applies to loadCodeAssist (default prod base). There is NO automatic daily↔prod cross-tier fallback.

### 3.2 Request headers (generate/stream/countTokens)

MUST:
- `Content-Type: application/json`
- `Authorization: Bearer <access token>` (401-type `statusErr` "missing access token" when absent)
- `User-Agent`: `antigravity/hub/<version> darwin/arm64` by default (short UA). A credential `user_agent` attribute/metadata is used instead when set; if that value is an antigravity-family UA containing `google-api-nodejs-client/`, the suffix is trimmed.
- `Host`: set from the base URL (Go `req.Host`).
- Credential `headers` metadata map → per-name upstream headers (overriding the defaults). Values may reference client headers via `$<Header-Name>` and the internal session id via `$CPA-SESSION-ID` (omitted when unresolvable).
- No `Connection: close`; HTTP/1.1 only (no ALPN h2 advertisement) with per-credential connection pools; pooling disabled by default (`antigravity.connection-pool.enabled: false` → no idle keep-alive reuse), tunable via `idle-conn-timeout` (cap 210 s) and `max-idle-conns-per-host` (cap 100).

### 3.3 Request envelope (body of generate/stream)

The pairwise translators produce a Gemini-style body wrapped in the antigravity envelope; the executor then MUST apply, in order (`geminiToAntigravity` + `buildRequest`):

1. `model` ← resolved upstream model name (§3.5); `userAgent` ← literal `"antigravity"`.
2. `requestType`: keep client-provided value; else `"image_gen"` when the model id contains `image`, else `"agent"` (injected).
3. `project` ← credential project id (required — missing → 400-type error `antigravity auth missing project_id`); deleted when empty.
4. `requestId`: for image models `"image_gen/<unix-millis>/<uuid>/12"`; for every other `requestType` except `web_search` it is `"agent-<uuid>"` (uuid v4, dynamic). For `requestType == "web_search"` NO `requestId` is injected.
5. `request.sessionId`: injected only in the same branch as the `agent-` requestId (non-image, non-web_search): an existing `request.sessionId` wins; else the context-derived id; else a stable id hashed from the first user text; else random. Every form is a negative decimal string `-<int64>` (first 8 bytes of SHA-256, masked to 63 bits, base-10). Image and `web_search` requests carry no executor-injected `sessionId`.
6. `request.safetySettings` MUST be deleted (client-sent safety settings are never forwarded).
7. `toolConfig` at top level is moved into `request.toolConfig` (when `request.toolConfig` is absent), then removed from the top level.
8. `request.generationConfig.maxOutputTokens` is capped to the registry `max_completion_tokens` for the model; for Claude-family models `request.toolConfig.functionCallingConfig.mode` is FORCED to `"VALIDATED"`; for non-Claude models `request.generationConfig.maxOutputTokens` is REMOVED.
9. Schema sanitization runs when tools or generation schemas are present: `parametersJsonSchema`→`parameters` rename per declaration; unsupported JSON-Schema keys stripped (two flavors: the "antigravity" flavor for models containing `claude`, `gemini-3-pro`, or `gemini-3.1-pro`; the plainer flavor otherwise).
10. Thinking-suffix budget handling and reasoning-replay caches (S3/S4 cross-ref) may rewrite `request.contents`; for Gemini-family targets synthetic empty `user` turns are ensured at both boundaries (not for Claude targets).

### 3.4 Response envelope and SSE (upstream → executor)

MUST:
- Non-stream success: JSON object `{"response": {...}}` where the inner object is Gemini-shaped: `candidates[0].content{role,parts[]}`, `finishReason`, `usageMetadata{promptTokenCount,candidatesTokenCount,thoughtsTokenCount,totalTokenCount,cachedContentTokenCount,...}`, `modelVersion`, `responseId`. A top-level Gemini shape without the `response` wrapper is ALSO accepted everywhere (all readers check `response.*` first, then top-level).
- Stream success: SSE with `data: <json>` events of the same shape (per-chunk `candidates` deltas, `usageMetadata` typically on the terminal chunk, plus a `traceId` field per chunk). The executor:
  - parses ONLY `data:` lines (or bare JSON lines); `event:` lines are ignored; `[DONE]` is not expected from upstream (a clean EOF triggers the client-side terminal translation).
  - renames `usageMetadata`→`cpaUsageMetadata` (and `response.usageMetadata`→`response.cpaUsageMetadata`) on every chunk that has no `finishReason` (usage only survives on terminal chunks; stop-chunk-without-usage tracking keys on `traceId`).
  - usage accounting reads `response.usageMetadata` / `usageMetadata` / `usage_metadata` (Gemini-family field names).
  - when upstream never emits a `finishReason`, the proxy synthesizes a terminal chunk: `{"candidates":[{"content":{"role":"model","parts":[{"text":""}]},"finishReason":"STOP"}]}` + last-seen `usageMetadata`/`modelVersion`/`responseId`. Streams that never produced any candidate/usage payload are treated as failures, not empty successes.
- Errors: upstream status + body propagate verbatim (statusErr); 429 bodies are additionally classified (§5).
- Count tokens success: `{"totalTokens": <n>}` (top-level).

### 3.5 Model mapping

MUST:
- Client-visible models come from the antigravity channel of the model catalog: embedded `internal/registry/models/models.json` (channel key `antigravity`), refreshed at startup and every 3 h from `https://raw.githubusercontent.com/router-for-me/models/refs/heads/main/models.json` (+ mirror `https://models.router-for.me/models.json`). Catalog content is external data — the CONTRACT is the mechanism and the per-model fields (`id`, `display_name`, `context_length`, `max_completion_tokens`, `thinking{min,max,levels,zero_allowed,dynamic_allowed}`, `supportedInputModalities`, `supportedOutputModalities`), not the live list.
- Thinking suffix: `model(<budget>)` — the executor strips the last `(...)` group to get the base model; budgets are non-negative ints (`0` = off). The base model is what the upstream `model` field gets.
- Alias/prefix resolution, excluded models (`oauth-excluded-models`), per-auth `oauth-model-alias` rewrites, and response-model rewriting (`force-mapping`) are conductor concerns (S4); the antigravity executor always sends the RESOLVED model in the `model` field.
- Model-class rules keyed on the resolved model id (substring match, case-insensitive for Claude):
  - contains `claude` (or `gemini-3-pro`/`gemini-3.1-flash-image`) → Claude-family path: upstream is ALWAYS streamed (`:streamGenerateContent?alt=sse`) even for non-stream clients, tool config forced `VALIDATED`, antigravity-schema flavor used, thinking-signature rules differ (S3).
  - contains `image` → `requestType: image_gen` + `image_gen/<ms>/<uuid>/12` request id.
  - otherwise Gemini-family path.
- `web_search` requestType comes from the Claude typed web-search tool translation; a client-provided `requestType` passes through unchanged.
- Per-credential capability probe (`:fetchAvailableModels`, body `{}`, short antigravity UA, `webSearchModelIds[]` response) gates web-search-capable models; probe caches: success 5 min, failure 1 min, auth failure backoff 1 min per token. (`sdk/cliproxy/antigravity_models.go`.) RECORDED (S2d10-executor-request-shape `upstream.jsonl`): the probe fires before the first generate call and a probe failure does not block generation.

---

## 4. Streaming rules (contract-test material)

1. Upstream URL: `{base}/v1internal:streamGenerateContent?alt=sse` (or `?$alt=<alt>` when an alt option is present — note the DOLLAR prefix differs from the default `alt=sse`).
2. The executor reads the upstream SSE line-by-line; only `data:` (or bare JSON) lines are translated; `event:` lines and `[DONE]` produce nothing. On clean EOF the executor emits the terminal translation for the client protocol.
3. `usageMetadata` filtering: every non-terminal chunk's `usageMetadata`/`response.usageMetadata` is renamed `cpaUsageMetadata`/`response.cpaUsageMetadata` before translation; terminal chunks (any non-empty `finishReason` in `candidates[0]` or `response.candidates[0]`) keep usage. A chunk with `traceId` and no usage is remembered so the follow-up usage-bearing chunk is dropped (the usage already surfaced via the reporter).
4. Synthetic terminal chunk shape (when upstream omits finishReason): `{"candidates":[{"content":{"role":"model","parts":[{"text":""}]},"finishReason":"STOP"}]}` then `usageMetadata` (raw), `modelVersion`, `responseId` appended in that key order.
5. Mid-stream read error: the error surfaces to the client per S2d family rules (in-stream error event, HTTP stays 200 when headers were already sent); no `[DONE]` is synthesized after a read error.
6. Claude-family non-stream clients: upstream is streamed and aggregated server-side — consecutive text parts concatenate; consecutive `thought:true` parts concatenate into one part (with the last `thoughtSignature`); `functionCall`/`inlineData` parts pass through normalized to camelCase (`inline_data`→`inlineData`, `thought_signature`→`thoughtSignature`); result envelope carries the last-seen `role`/`finishReason`/`modelVersion`/`responseId`/`usageMetadata`; when no usage was seen, `usageMetadata` is zero-filled (`promptTokenCount:0`, `candidatesTokenCount:0`, `totalTokenCount:0`).
7. Keep-alives and bootstrap retries are generic S1/S7 behavior; nothing antigravity-specific.
8. Byte-exact comparisons ignore only: `Date`, `X-Cpa-Trace-Id`, port numbers, `state`, `requestId`/`sessionId`/`responseId`/`traceId`, `timestamp`/`expired`/`created` values, and UA version (hub-fetched).

---

## 5. Error semantics

Client-visible (management/callback surface) — bodies exact (Go map key order alphabetical):

| Condition | Status | Body |
|---|---|---|
| auth-url / get-auth-status / oauth-session without management key | 401 | `{"error":"missing management key"}` |
| auth-url / get-auth-status / oauth-session with wrong key | 401 | `{"error":"invalid management key"}` |
| forwarder bind failure (port 51121 busy) | 500 | `{"error":"failed to start callback server"}` |
| main-port callback | 200 always | success HTML (§2.4) |
| oauth-callback validation family | 400/404/409 | `{"error":"invalid body"\|"state is required"\|"invalid state"\|"code or error is required"\|"unsupported provider"\|"provider does not match state"\|"invalid redirect_url"}` / `{"error":"unknown or expired state"}` / `{"error":"oauth flow is already completed"\|"<session status>"\|"oauth flow is not pending"}` |
| get-auth-status invalid state | 400 | `{"error":"invalid state","status":"error"}` |
| oauth-session missing/invalid state | 400 | `{"error":"missing state","status":"error"}` / `{"error":"invalid state","status":"error"}` |
| wrong method on any of the above routes | 404 | empty body (R-404) |

Upstream-propagated (executor):
- Any upstream status ≥ 400 → the client gets that status with the upstream error body passed through the client-protocol error mapping; `Retry-After` is attached when the 429 body carries one.
- Missing/undiscovered project id → 400-type `antigravity auth missing project_id[: <cause>]` (cause status wins when the project fetch failed with an HTTP status).
- Missing refresh token / missing auth → 401-type errors.
- 429 classification (Google-style body `error.status=RESOURCE_EXHAUSTED` + `error.details[@type=type.googleapis.com/google.rpc.ErrorInfo].reason`):
  - reason `QUOTA_EXHAUSTED` (or body contains `quota_exhausted`) → full-quota-exhausted: credential pool closed for the model.
  - reason `RATE_LIMIT_EXCEEDED` + retry delay (from `google.rpc.RetryInfo.retryDelay`, `ErrorInfo.metadata.quotaResetDelay`, or "after Ns" in `error.message`):
    - < 3 s → instant retry, same credential;
    - 3 s .. 5 min → short per-credential cooldown (switch auth), the client may see `Retry-After`;
    - ≥ 5 min → full-quota-exhausted.
  - anything else → soft retry (normal conductor retry; S4).
  - RECORDED downstream surfacing (S2d10-executor-429-cooldown): the short-cooldown branch yields the 429 `model_cooldown` error family — `{"error":{"code":"model_cooldown","last_upstream_error":"<verbatim upstream body>","message":"All credentials for model <m> are cooling down via provider <p> (last error: ...)"}}` — while the TRANSIENT (5xx) cooldown family surfaces as 503 `auth_unavailable` (S6 golden S6-16; two distinct cooldown error families, both with goldens now).
  - Credits fallback (`quota-exceeded.antigravity-credits: true`) may inject `enabledCreditTypes: ["GOOGLE_ONE_AI"]` into the request body for Claude models as a last resort; `INSUFFICIENT_G1_CREDITS_BALANCE` marks the credential permanently credits-disabled. OPTIONAL behavior (config-gated).
- Cooldowns are S4; the antigravity-specific bit is the short-cooldown trigger and the 429 taxonomy above.

---

## 6. Golden samples index

Fixtures live in `tests/fixtures/S2d10/<case-id>/` per the RECIPES layout (`meta.yaml`, `request.http`, `downstream.md`; `upstream.jsonl`/`mock-response.json` only for the synthetic-credential attempts). Recording config: the oracle template (§3 of `reports/oracle/BOOTSTRAP.md`) plus `-p 127.0.0.1:51121:51121` so the loopback forwarder is reachable from the host; management key `oracle-mgmt-key-1`. Dynamic per session: the `<state>` token (request + response) and the server port inside the 302 `Location` (18317 in the bootstrap template; the oracle's isolated stack may use a different port — mask both as `dynamic_fields`, per the S3 §4 precedent). The loopback port 51121 itself is a provider constant and is NOT masked.

RECORDED by @oracle-runner (2026-09-15, isolated stack; reference port 8387 masked, loopback 51121 literal):

| case-id | purpose | fixture dir | dynamic fields (mask these) |
|---|---|---|---|
| S2d10-auth-url-json | 200 `{state,status,url}`; auth URL shape: sorted params, fixed client id/redirect_uri/scopes | `tests/fixtures/S2d10/S2d10-auth-url-json/` | Date, state (both in JSON and inside url), port |
| S2d10-auth-url-auth-failures | 401 missing + invalid management key on antigravity-auth-url | `tests/fixtures/S2d10/S2d10-auth-url-auth-failures/` | Date |
| S2d10-forwarder-302 | `is_webui=1` → GET `:51121/oauth-callback?code&state` → 302 Found, `Cache-Control: no-store`, Location `http://127.0.0.1:<port>/antigravity/callback?code&state`; second hop: main-port 200 HTML (288-byte constant) | `tests/fixtures/S2d10/S2d10-forwarder-302/` | Date, state, port |
| S2d10-forwarder-any-path | 302 path-rewrite rule: `/whatever/deep/path?z=1&code=ac2&state=..&x=abc` → Location `/antigravity/callback?z=1&code=ac2&state=..&x=abc` (path discarded, raw query order preserved) | `tests/fixtures/S2d10/S2d10-forwarder-any-path/` | Date, state, port |
| S2d10-forwarder-replace | second `is_webui` flow replaces the previous forwarder (302 Location serves the NEW state) | `tests/fixtures/S2d10/S2d10-forwarder-replace/` | Date, state ×2, port |
| S2d10-forwarder-port-busy | 51121 pre-occupied in-container (perl `IO::Socket::INET` listener via `docker exec`, technique recorded in meta `pre_occupation`) → `is_webui=1` auth-url returns 500 `{"error":"failed to start callback server"}` | `tests/fixtures/S2d10/S2d10-forwarder-port-busy/` | Date |
| S2d10-main-callback-html | `GET /antigravity/callback?code&state=<unknown>` → 200 success HTML, no auth needed | `tests/fixtures/S2d10/S2d10-main-callback-html/` | Date |
| S2d10-main-callback-variants | [200 HTML, 200 HTML (error param), 204+CORS (OPTIONS), 404 EMPTY (POST)] | `tests/fixtures/S2d10/S2d10-main-callback-variants/` | Date |
| S2d10-oauth-callback-errors | 10-step ladder `[400,400,400,400,404,404,200,400,400,200]`: invalid body / state required / invalid state / code-or-error required / unknown state (×2, incl. before-provider-normalization) / alias `ANTI-GRAVITY` → 200 ok / unsupported provider / provider mismatch | `tests/fixtures/S2d10/S2d10-oauth-callback-errors/` | Date, state |
| S2d10-session-lifecycle | `[200×6, 404]`: wait → cancel(true) → unknown-or-expired → cancel(false) → late main-port callback still 200 HTML → mgmt-callback 404 | `tests/fixtures/S2d10/S2d10-session-lifecycle/` | Date, state |
| S2d10-callback-error-session | pending session + main-port callback `error=access_denied` → settled 0.65 s → `{"error":"Authentication failed","status":"error"}` (final response only) | `tests/fixtures/S2d10/S2d10-callback-error-session/` | Date, state, settle time |
| S2d10-post-callback-exchange-fail | pending session + POST oauth-callback fake code → 200 ok → settled 0.68 s → `{"error":"Failed to exchange token","status":"error"}` | `tests/fixtures/S2d10/S2d10-post-callback-exchange-fail/` | Date, state, settle time |
| S2d10-get-auth-status-variants | [200 `{"status":"ok"}`, 200 `{"status":"ok"}` (empty `?state=` treated as absent), 400 invalid state] | `tests/fixtures/S2d10/S2d10-get-auth-status-variants/` | Date |
| S2d10-cancel-errors | DELETE oauth-session [400 missing state, 400 invalid state] | `tests/fixtures/S2d10/S2d10-cancel-errors/` | Date |

RECORDED via SYNTHETIC credential (uploaded `{"type":"antigravity", ...,"base_url":"<mock>"}`; chosen catalog model `claude-opus-4-6-thinking`; upstream wire golden = `upstream.jsonl`):

| case-id | purpose | fixture dir | recorded findings |
|---|---|---|---|
| S2d10-executor-request-shape | upstream envelope golden (chat non-stream + count-tokens) | `tests/fixtures/S2d10/S2d10-executor-request-shape/` | probe `:fetchAvailableModels` body `{}` fires BEFORE generation (mock 404 did not block); chat request went to `/v1internal:streamGenerateContent?alt=sse` — the Claude-family ALWAYS-STREAM rule of §3.5/§4.6, confirmed; envelope alphabetical `{project, request:{contents, sessionId:"-<int64>", toolConfig:{functionCallingConfig:{mode:"VALIDATED"}}}, model, userAgent:"antigravity", requestType:"agent", requestId:"agent-<uuid>"}`; `request.safetySettings` absent; count-tokens body exactly `{"request":{"contents":[...]}}` (model/project/sessionId/safetySettings/toolConfig/labels all absent); headers `User-Agent: antigravity/hub/<ver> darwin/arm64` + `Authorization: Bearer` + `Content-Type: application/json` + `Accept-Encoding: gzip` |
| S2d10-executor-stream-usage | stream contract: alt=sse, usage filter, terminal chunk, client-side [DONE] | `tests/fixtures/S2d10/S2d10-executor-stream-usage/` | downstream SSE = `chat.completion.chunk` frames (`id` "", `created` 0, `reasoning_content`/`tool_calls` null, `native_finish_reason`); non-terminal `usageMetadata` stripped client-side; terminal chunk carries usage `{completion_tokens, prompt_tokens, total_tokens}` + `finish_reason: stop` + `data: [DONE]`; raw chunked framing preserved |
| S2d10-executor-429-cooldown | 429 taxonomy + downstream cooldown surfacing | `tests/fixtures/S2d10/S2d10-executor-429-cooldown/` | step 1: 429 Google-shaped body passes through VERBATIM; step 2 (immediate same model): 429 `{"error":{"code":"model_cooldown","last_upstream_error":"<verbatim upstream body>","message":...}}` — the short-cooldown branch surfaces as the `model_cooldown` family (429), distinct from the transient 503 `auth_unavailable` family (S6-16) |

Pending optional pass (requested from @oracle-runner): `S2d10-executor-request-shape-gemini` — same synthetic setup with a GEMINI-family catalog model (e.g. `gemini-3-flash`) to record the `/v1internal:generateContent` non-stream branch (no `alt` query, no `toolConfig` VALIDATED, `generationConfig.maxOutputTokens` removed). Until it lands, the Generate row of §3.1 is source-specified only.

FIXTURE-DEFERRED (CREDENTIALED-ONLY; specified in §2–§5, no golden):
- Full Google OAuth success path (consent → code → exchange → userinfo → loadCodeAssist/onboardUser → credential file). Requires a real Google account; `state`/`url` are per-request random.
- Real upstream `:generateContent`/`:streamGenerateContent`/`:countTokens`/`:fetchAvailableModels` RESPONSE shapes from Google (gemini + claude families), token refresh success, credits balance fetch.
- CLI-mode loopback server responses (`:51121/oauth-callback` login success/failure HTML) — requires the CLI login process, not the server; specified in §2.8.

Case definitions with exact requests: `spec/recordings/S2d10.cases.json`.

---

## 7. Classification summary

- RECORDED (RECORDABLE-LOCALLY): 14 cases — the §2 management/callback surface (13) plus the forwarder bind-failure 500 (in-container port occupation is feasible on the Debian-based reference image via `docker exec`; the earlier "needs in-container port conflict" deferral concern is void). Recording prerequisites: the `-p 127.0.0.1:51121:51121` port mapping for the forwarder cases; two cases settle asynchronously (~0.7 s) and are recorded poll-until-stable.
- RECORDED (synthetic credential): 3 executor cases via uploaded `{"type":"antigravity",...,"base_url":"<mock>"}` credential + a local v1internal mock — the antigravity EXECUTOR wire (envelope, headers, probe, count-tokens, stream usage filter, 429 cooldown family) is therefore NOT fixture-deferred after all; this is a R-FIXTURE refinement precedent for OAuth providers whose executor honors a `base_url` override.
- PENDING: `S2d10-executor-request-shape-gemini` (gemini-family model → `/v1internal:generateContent` branch); requested from @oracle-runner, optional.
- CREDENTIALED-ONLY (FIXTURE-DEFERRED per R-FIXTURE): live-Google OAuth success path, real upstream RESPONSE shapes/refresh/credits, CLI-mode loopback pages.

---

## 8. Open questions and intentional non-equivalences

1. Pairwise antigravity translation tables (OpenAI chat/Gemini/Claude/Responses/Interactions → antigravity request and back) are implemented upstream in `internal/translator/antigravity/*` but have no dedicated S2d section. S2d10 pins the envelope + executor rules; if implementers need field-by-field tables, request an S2d11+ section or amendments to S2d1–S2d9 rather than deriving from this file.
2. The client secret is a public interface constant embedded in the binary (upstream ships it in plaintext). CPA-Edge mirrors it for compatibility. Flag for S7: consider masking it in management responses.
3. The forwarder writes `Location` with literal `127.0.0.1` and the server port — behind a reverse proxy the browser may not reach it. Upstream behaves the same; we mirror (compat) and note it as a degradation candidate (S7), not a fix here.
4. `?$alt=` (dollar) vs `?alt=sse` (no dollar) is an upstream inconsistency; spec pins it byte-exact for fidelity. No "fix".
5. Session TTLs (30 min pending / 1 min completed) and the 5-minute waiter are timer behaviors — goldens avoid timing asserts; contract tests must not sleep-poll.
6. Hub-manifest UA version (default `2.9.1`, refreshed every 6 h from a Google-run appspot URL) is an external dependency. CPA-Edge MUST keep the fallback constant and MAY pin the fetch behind config; the UA is a wire fingerprint, not a functional requirement. Decide in S6/S7 whether the fetch is required at all.
7. The synthetic-credential recordability PROVED OUT (17/20 cases recorded): an uploaded antigravity auth file with a `base_url` override routes executor traffic to a local mock with no Google involvement. This refines R-FIXTURE for OAuth providers whose executor honors `base_url`: request-side wires are RECORDABLE-LOCALLY; only vendor-issued tokens/consent/response content stay CREDENTIALED-ONLY. Other OAuth providers should be re-examined under this precedent (xAI/Meta compat executors excepted — they have separate API-key executors).
8. `get-auth-status` returning HTTP 200 with `{"status":"error",...}` bodies is an upstream quirk shared with S5; mirrored, already covered by R-404-style compatibility reasoning.
9. `/v1internal:generateContent` (gemini-family non-stream branch, §3.1) has no golden yet — the first executor recording necessarily used the catalog's first model (`claude-opus-4-6-thinking`), which takes the always-stream path. A gemini-family pass (`S2d10-executor-request-shape-gemini`) is requested from @oracle-runner; remove this item when it lands.
10. Recorded probes show `Accept-Encoding: gzip` on generate/stream calls (Go transport default) and `Connection: close` ONLY on the `:fetchAvailableModels` probe. Header-exact contract tests should treat `Accept-Encoding` as transport-added, not application logic.
