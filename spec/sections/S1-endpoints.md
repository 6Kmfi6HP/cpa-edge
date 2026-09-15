# S1 — Endpoint inventory (external HTTP/WS routes, methods, auth, status codes)

Upstream anchor: CLIProxyAPI **v7.3.4**, commit `8335eac731946bd4eff18f500653f93736df53d6`.
All evidence paths below are files inside the upstream reference repo (`_cpa_edge_ref/CLIProxyAPI`), read as a behavioral specification only. Recorded probes (`reports/oracle/BOOTSTRAP.md` §4) take precedence over source-derived claims where they conflict; both are cited.

## 1. Scope and boundaries

In scope (this section is the normative route inventory for the whole gateway):
- Every externally visible HTTP route and WebSocket-upgrade route: methods, path patterns, auth requirements, success/error status codes, response headers that are gateway-controlled (CORS, trace, version headers), and framework-level routing semantics (404/405, OPTIONS, trailing slash, HEAD).
- The accept/reject matrix for each auth surface (client API, realtime, management, keep-alive).
- Route-level streaming contract: which routes stream, SSE framing at the route boundary, event names for terminal stream errors, and the `alt` query-parameter switch on the Gemini surface.
- The exact wire shape of every gateway-generated (non-upstream) body: info endpoints, model lists, error envelopes, OAuth callback pages.

Out of scope (owned by later sections; S1 only fixes routing + envelope):
- Request/response translation semantics per protocol pair (S2d1–S2d10).
- Upstream wire behavior, header injection, model aliasing and rewrites (S2*, and oracle wire notes in `reports/oracle/BOOTSTRAP.md`).
- Auth flows, credential lifecycle, cooldown/scheduling states (S3/S4).
- Management endpoint payloads beyond auth + envelope (S5).
- Config schema, storage, persistence (S6).
- Platform-conditional degradations (S7). The non-HTTP Redis-RESP multiplexer that shares the same TCP port (`internal/api/redis_queue_protocol.go`, `internal/api/mux_listener.go`) is noted here as existing and is specified in S7.
- Plugin-registered management routes and plugin resources under `/v0/management/*` and `/v0/resource/plugins/*` dispatched via the plugin host (S5/S7); S1 lists the dispatch rule, not plugin content.

## 2. Global request pipeline (client-visible facts)

Middleware order (evidence: `internal/api/server.go` `NewServer`, `internal/api/server_middleware.go`):
logger → recovery → CPA-trace injection → (request logging) → **CORS** → home-heartbeat gate (only when Home mode on) → example-API-key safe-mode gate → route handlers.

Facts that are contract-test material:

- **CORS on every response — except trailing-slash redirects.** The gateway sets, on every response of every route (200, 204, 400, 401, 403, 404, 500, 503, 426 — everything, including framework 404s and OPTIONS):
  - `Access-Control-Allow-Origin: *`
  - `Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS`
  - `Access-Control-Allow-Headers: *`
  - `Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id`
  Evidence: `internal/api/server_middleware.go` `corsMiddleware`. Recorded: probes 01/03/04/05/… all carry the block; S1-02/03/04/05/06/… fixtures confirm.
  **Exception (recorded, S1-08):** trailing-slash redirects (301/307, §5) are emitted by the router layer before the middleware chain runs and carry **no** `Access-Control-*` headers at all.
- **OPTIONS anywhere → 204.** Any `OPTIONS` request — known route, unknown route, with or without credentials — aborts with `204 No Content` and the CORS block, and is never authenticated, never routed to a handler. Evidence: `corsMiddleware` aborts before `c.Next()`; gin global middleware runs before routing (framework behavior of gin v1.10.1, `go.mod`). Recorded: probe 04.
- **`X-CPA-TRACE-ID`** (constant name; recorded wire casing `X-Cpa-Trace-Id`, e.g. `20260916004708-47b77fbeb6ecb734-8133268e`; format `<yyyyMMddHHmmss>-<credential index>-<request id>`) is added when an upstream credential index is assigned for the request; absent on requests that fail before credential selection (auth 401s, framework 404s, model_not_found 400s, silent-fall-through actions). The value is dynamic and is masked in fixtures. Evidence: `internal/logging/cpa_trace.go` (`CPATraceIDHeader = "X-CPA-TRACE-ID"`); fixtures S1-13/S1-14. Note the CORS `Access-Control-Expose-Headers` VALUE spells the uppercase constant names literally (`X-CPA-TRACE-ID, X-CPA-VERSION, ...`) — header values are not canonicalized.
- **Management responses** additionally always carry the four build headers (set by the management middleware before key validation, so 401/403/404 responses carry them too). Recorded wire casing (S1-20, Go MIME header canonicalization): `X-Cpa-Version: v7.3.4`, `X-Cpa-Commit: 8335eac`, `X-Cpa-Build-Date: 2026-09-15T14:07:06Z`, `X-Cpa-Support-Plugin: 1`. Values are build-time constants; only the casing of the NAMES is stable, values change per build. Evidence: `internal/api/handlers/management/handler.go` `Middleware`; fixture S1-20.
- **Serialization order.** Gateway-generated bodies built from maps (Go `map[string]any` / gin.H) are serialized with keys in **lexicographic order** (e.g. `{"data":[],"object":"list"}`, `{"endpoints":[...],"message":"CLI Proxy API Server"}`). Bodies built from structs keep field order (e.g. `{"error":{"message":...,"type":...,"code":...,"retryable":...}}`). Bodies that are pre-built JSON literals pass through with their literal order (e.g. the `model_not_found` body keeps `"param"` after `"code"`). Evidence: recorded probe bodies 01/08; `sdk/api/handlers/handlers.go` `BuildErrorResponseBodyWithError`; `sdk/api/handlers/handlers_routing.go` `getRequestDetailsWithOptions`.

## 3. Behavior inventory — routes

Method column lists ONLY the methods the gateway registers for the path. Per Ruling R-404 (§5), any other method on a known path is a 404, not 405.

### 3.1 Meta & utility routes (no client auth)

| Method | Path | Auth | Success | Notes |
|---|---|---|---|---|
| GET | `/` | none | 200 | Body: `{"endpoints":["POST /v1/chat/completions","POST /v1/completions","GET /v1/models"],"message":"CLI Proxy API Server"}` (keys sorted). Evidence: `internal/api/server_routes.go` `setupRoutes`; probe 01. |
| GET | `/healthz` | none | 200 | Body `{"status":"ok"}`. Evidence: `internal/api/server_routes.go` `healthzHandler`. |
| HEAD | `/healthz` | none | 200 | No body (explicitly registered). |
| GET | `/management.html` | none | 200 | Serves the control-panel HTML asset from disk, downloading it on first use. 404 empty if `remote-management.disable-control-panel: true`, Home mode enabled, asset missing, or download failed; 500 empty on stat errors. Evidence: `internal/api/server_routes.go` `serveManagementControlPanel`. |
| GET | `/keep-alive` | local password (TUI mode) | 200 / 401 | **Route is only registered when a local management password is set** (TUI-mode embed, `internal/cmd/run.go` sets a 10s idle shutdown). In server-mode deployments (the anchored docker image) the route is absent → 404 empty (probe 16). When present: `Authorization: Bearer <localPassword>` or `X-Local-Password: <localPassword>` → `200 {"status":"ok"}`; otherwise `401 {"error":"invalid password"}`. Evidence: `internal/api/server_keepalive.go` `handleKeepAlive`. |
| OPTIONS | any path | none | 204 | §2. |

### 3.2 OpenAI-compatible surface — group `/v1` (client auth required, §4.1)

| Method | Path | Success | Route-level failures |
|---|---|---|---|
| GET | `/v1/models` | 200 | 401 auth; format switches per §6.2 |
| POST | `/v1/chat/completions` | 200 | 400 invalid-body/model_not_found; 401 auth; 5xx pool (§8) |
| POST | `/v1/completions` | 200 | same as chat/completions (converted via chat machinery) |
| POST | `/v1/images/generations` | 200 | 400 (non-JSON body, missing `prompt`, unsupported model); **404 empty when `disable-image-generation: true`** (bool literal — the "disable everywhere" state; `"chat"` and `"passthrough"` keep `/v1/images/*` enabled) |
| POST | `/v1/images/edits` | 200 | same gate + same 400 class as generations |
| POST | `/v1/videos` | 200 | 400/5xx (xAI videos create) |
| POST | `/v1/videos/generations` | 200 | same class |
| POST | `/v1/videos/edits` | 200 | same class |
| POST | `/v1/videos/extensions` | 200 | same class |
| GET | `/v1/videos/:request_id` | 200 | xAI video status retrieval |
| POST | `/v1/messages` | 200 | 400 model_not_found (Claude-shaped, §8); 401 auth |
| POST | `/v1/messages/count_tokens` | 200 | 400 model_not_found (Claude-shaped) |
| GET | `/v1/responses` | 101 (WS) | Requires WebSocket upgrade; non-WS request → 400 (gorilla handshake failure, plain-text body). 401 auth applies first. Evidence: `sdk/api/handlers/openai/openai_responses_websocket.go` `ResponsesWebsocket` |
| POST | `/v1/responses` | 200 | 400 invalid-body/model_not_found |
| POST | `/v1/responses/compact` | 200 | 400 `"Streaming not supported for compact responses"` when body has `stream:true` |
| POST | `/v1/alpha/search` | passthrough | Codex Alpha Search: near-passthrough to `https://chatgpt.com/backend-api/codex/alpha/search` (or `<codex-api-key base-url>/alpha/search`); no codex credential → 503 `{"error":"Codex auth unavailable"}` or 503 selector-error body. Evidence: `internal/api/server_routes.go` `codexAlphaSearch` |
| POST | `/v1/live` | 200 | Codex live API call (SDP media relay). Body `{}` with no codex credential → 503 `{"error":"<selector error>"}`. 400 on unreadable/oversized body (413 for oversized). Evidence: `internal/client/codex/live/live.go` `Handle` |
| GET | `/v1/live/:call_id` | 101 (WS) | Sideband WS; non-WS → 426; malformed call id → 400 `{"error":"Invalid Codex live call ID"}`; unknown call id → 404 `{"error":"Codex live session not found"}`; claimed by another connection → 409 — plain envelope (no `/v1/realtime` prefix). Evidence: `internal/client/codex/live/sideband.go` `HandleSideband`, `callIDPattern` |

Evidence for the whole group: `internal/api/server_routes.go` `setupRoutes` (v1 group + `AuthMiddleware`).

Image-route extra: chat-surface image-only models (e.g. `gpt-image-1.5`, `gpt-image-2*`, `grok-imagine-image*`) used on non-image routes get 503 `"model <m> is only supported on /v1/images/generations and /v1/images/edits"`; supported images models used on `/v1/images/*` with an unsupported model name get 400 `"Model <m> is not supported on /v1/images/generations or /v1/images/edits. Use ..."`. Evidence: `sdk/api/handlers/handlers_routing.go` `validateImageOnlyModel`; `sdk/api/handlers/openai/openai_images_handlers.go` `rejectUnsupportedImagesModel`.

**`disable-image-generation` is a four-state config value** (evidence: `internal/config/disable_image_generation_mode.go`): `false` (default, enabled) · `true` (bool — disabled everywhere: both `/v1/images/*` routes abort with **404 empty** before reading the body, `openai_images_handlers.go` `ImagesGenerations`/`ImagesEdits`) · `"chat"` (disabled on non-images endpoints, `/v1/images/*` enabled) · `"passthrough"` (never inject or strip `image_generation` on non-images endpoints; `/v1/images/*` behaves like `"chat"`). The literal for the all-disabled state is `true`, not `all`.

### 3.3 Claude-compatible surface

`/v1/messages`, `/v1/messages/count_tokens`, and the Claude-shaped `/v1/models` (§6.2) live under the `/v1` group above. No `anthropic-version` header validation happens at the gateway: the header is optional on requests and only switches the model-list format (and is added when forwarding upstream to Claude). Evidence: `internal/access/config_access/provider.go` + `sdk/api/handlers/claude/code_handlers.go` (no version check); probe: header-acceptance recorded in §4.

### 3.4 Gemini-compatible surface — group `/v1beta` (client auth required)

| Method | Path | Success | Notes |
|---|---|---|---|
| GET | `/v1beta/models` | 200 | `{"models":[...]}` (§6.2). Recorded probe 17: `{"models":[]}` with no providers; `Authorization: Bearer` accepted here too. |
| GET | `/v1beta/models/*action` | 200 | Model lookup. Unknown model → **404 with JSON body** `{"error":{"message":"Not Found","type":"not_found"}}` (handler-level 404, NOT R-404 empty). Evidence: `sdk/api/handlers/gemini/gemini_handlers.go` `GeminiGetHandler`. |
| POST | `/v1beta/models/*action` | 200 | Action = `<model>:<method>`. Supported methods: `generateContent`, `streamGenerateContent`, `countTokens`. **Unknown `<method>` (e.g. `:bogus`) → 200 with EMPTY body** (`Content-Length: 0`): the action parses, no switch case matches, nothing is written and nothing is dispatched — no upstream request, no `X-CPA-TRACE-ID` (silent fall-through; recorded S1-13, source `GeminiHandler` has no default case). Action without `:` → 404 JSON `{"error":{"message":"<request path> not found.","type":"invalid_request_error"}}` (recorded S1-13: `{"error":{"message":"/v1beta/models/bogusaction not found.","type":"invalid_request_error"}}`). Empty action (path `/v1beta/models/`) → the wildcard binds `action="/"`, which passes the required-URI binding (non-empty string) and then fails the two-part split → **404 JSON `{"error":{"message":"/v1beta/models/ not found.","type":"invalid_request_error"}}`** (recorded S1-25). POST `/v1beta/models` (no trailing slash) → **307 + `Location: /v1beta/models/`** (recorded S1-25): the wildcard POST route exists at the slash-terminated path, so gin's trailing-slash redirect fires in the no-slash direction too (§5), with empty body and no CORS headers. Unknown `<model>` → 400 OpenAI-shaped `model_not_found` (§8). Evidence: `sdk/api/handlers/gemini/gemini_handlers.go` `GeminiHandler` + fixtures S1-13/S1-25. |
| POST | `/v1beta/interactions` | 200 | Agent/model interactions entry. Validation failures → 400 `{"error":{"message":...,"type":"invalid_request_error"}}` with message exactly one of (recorded S1-25): `invalid JSON body` (note: this surface's phrasing differs from the images surface's `Invalid request: body must be valid JSON`), `request requires exactly one of model or agent` (both present or both absent), `stream must be a boolean`. Evidence: `sdk/api/handlers/gemini/interactions_handlers.go` `parseInteractionsRequestTarget` + fixture S1-25. |

**countTokens via openai-compatibility upstreams is computed LOCALLY (recorded, S1-24):** POST `/v1beta/models/<m>:countTokens` returns `200 {"totalTokens":<n>,"promptTokensDetails":[{"modality":"TEXT","tokenCount":<n>}]}` and never contacts the upstream (`upstream.jsonl` empty) — the request is translated to OpenAI chat form, tokenized in-process, and the count body is synthesized (`internal/runtime/executor/openai_compat_executor.go` `CountTokens`, `helps.CountOpenAIChatTokens`; body builder `internal/translator/common/bytes.go` `GeminiTokenCountJSON`). Providers with native count endpoints (gemini, claude) forward instead — S2 sections own those.
### 3.5 Codex CLI direct routes — group `/backend-api/codex` (client auth required)

Registered so Codex CLI clients can point `chatgpt_base_url` at the gateway:

| Method | Path | Success |
|---|---|---|
| GET | `/backend-api/codex/responses` | 101 (WS) — same handler as GET /v1/responses |
| POST | `/backend-api/codex/responses` | 200 — same handler as POST /v1/responses |
| POST | `/backend-api/codex/responses/compact` | 200 |
| POST | `/backend-api/codex/alpha/search` | passthrough — same handler as /v1/alpha/search |

Evidence: `internal/api/server_routes.go` `setupRoutes` (codexDirect group).

### 3.6 OpenAI-native video surface — group `/openai/v1` (client auth required)

| Method | Path | Success |
|---|---|---|
| POST | `/openai/v1/videos` | 200 (video create) |
| GET | `/openai/v1/videos/:video_id` | 200 |
| GET | `/openai/v1/videos/:video_id/content` | 200 (content bytes) |

Evidence: `sdk/api/handlers/openai/openai_videos_handlers.go` (`VideosCreate`, `VideosRetrieve`, `VideosContent`).

### 3.7 Realtime/live surface (special auth, §4.2)

All bodies below are the **nested realtime envelope** `{"error":{"code":...,"message":...,"param":null,"type":...}}` (map-sorted wire order, exactly as recorded), produced by `writeRealtimeError` (`internal/client/codex/live/client_secret.go`). The generic live errors routed through `writeLiveError` (`internal/client/codex/live/live.go`) switch to this nested form **only when the request path starts with `/v1/realtime`**; `/v1/live` and `/v1/alpha/search` keep the plain `{"error":"<msg>"}` shape (recorded S1-23).

| Method | Path | Auth | Behavior |
|---|---|---|---|
| GET | `/v1/realtime` | realtime | With `?call_id=` → sideband semantics; without → WS relay. **Non-WS request → 426** + `Upgrade: websocket` header; body code `websocket_upgrade_required` (type `invalid_request_error`). With `?call_id=` present the 426 body instead carries code `realtime_request_failed` (sideband path, see below). Evidence: `internal/client/codex/live/websocket.go` `HandleRealtimeWebsocket`/`HandleDirectWebsocket`. |
| POST | `/v1/realtime` | realtime | Codex live call (same `Handle` as `/v1/live`), but error bodies are the **nested** envelope with code `realtime_request_failed` (type `api_error` for ≥500, `invalid_request_error` for 4xx, `authentication_error` for 401) because of the path-prefix switch in `writeLiveError`. |
| POST | `/v1/realtime/calls` | realtime | same as POST `/v1/realtime` |
| GET | `/v1/realtime/calls/:call_id` | realtime | WS sideband. **Non-WS → 426**; malformed call id (fails `^[A-Za-z0-9_-]{1,128}$`) → 400 `realtime_request_failed` ("Invalid Codex live call ID"); unknown call → 404 `realtime_request_failed` ("Codex live session not found"); call already joining → 409 `realtime_request_failed` ("Codex live session already joining") — all nested, because `HandleSideband` reports via `writeLiveError`, which switches to the nested envelope on `/v1/realtime` paths (the same events on `/v1/live/:call_id` are plain `{"error":"<msg>"}`). Evidence: `internal/client/codex/live/sideband.go` `HandleSideband`, `callIDPattern`. |
| POST | `/v1/realtime/calls/:call_id/hangup` | standard | **REAL endpoint** (not a stub): invalid call-id pattern → 400 `invalid_call_id`; unknown call → 404 `realtime_call_not_found`; call owned by another API principal → 403 `realtime_call_scope_mismatch` (`"Realtime call belongs to another API principal"`); session service down → 503 `realtime_session_unavailable`; success forwards the hangup upstream. Evidence: `internal/client/codex/live/capabilities.go` `HandleHangup`. |
| POST | `/v1/realtime/calls/:call_id/accept` | standard | **501 capability stub**, nested body: `{"error":{"message":"Realtime SIP accept are not supported by the ChatGPT/Codex OAuth upstream","param":null,"type":"not_supported_error","code":"realtime_capability_not_supported"}}` |
| POST | `/v1/realtime/calls/:call_id/reject` | standard | 501 stub, same body with `Realtime SIP reject` |
| POST | `/v1/realtime/calls/:call_id/refer` | standard | 501 stub, same body with `Realtime SIP refer` |
| POST | `/v1/realtime/client_secrets` | standard | Mints a Realtime client secret. Bad JSON body → 400 `{"error":{"code":"invalid_request","message":"Invalid Realtime client secret request","param":null,"type":"invalid_request_error"}}`; unreadable/oversized body → 400/413 with the read-error message (code `invalid_request`); secret service unavailable → 503 `realtime_client_secret_unavailable`. Evidence: `internal/client/codex/live/client_secret.go` `CreateClientSecret`. |
| POST | `/v1/realtime/sessions` | standard | Legacy session credential (same minting path; no JSON validation of the raw body). Evidence: `CreateLegacySession`. |
| POST | `/v1/realtime/transcription_sessions` | standard | **501 stub**: message `Realtime transcription-only sessions are not supported by the ChatGPT/Codex OAuth upstream`, type `not_supported_error`, code `realtime_capability_not_supported`. |
| GET | `/v1/realtime/translations` | realtime | **501 stub**: `Realtime translation sessions are not supported by the ChatGPT/Codex OAuth upstream` |
| POST | `/v1/realtime/translations` | realtime | 501 stub, same body |
| POST | `/v1/realtime/translations/client_secrets` | standard | 501 stub, same body (same handler as translations) |

Evidence: `internal/api/server_routes.go` (realtime block), `internal/client/codex/live/capabilities.go` (`writeCapabilityNotSupported` = 501 `not_supported_error`/`realtime_capability_not_supported`), `internal/client/codex/live/live.go` (`writeLiveError` path-prefix envelope switch), `client_secret.go` (`writeRealtimeError`), `sideband.go`, `websocket.go`. Error-envelope rules in §4.2.

### 3.8 OAuth callback endpoints (no auth)

| Method | Path | Success | Notes |
|---|---|---|---|
| GET | `/anthropic/callback` | 200 | Fixed HTML page (auto-close script), `Content-Type: text/html; charset=utf-8`. Query params `code`, `state`, `error`/`error_description` are consumed to persist the OAuth result when `state` is non-empty; response is identical either way. Evidence: `internal/api/server_routes.go` `setupRoutes` callbacks. |
| GET | `/codex/callback` | 200 | same page |
| GET | `/antigravity/callback` | 200 | same page |
| GET | `/devin/callback` | 200 | Requires `code` or `error`/`error_description` param: missing both → 400 `{"error":"code or error is required"}`; failed persist → 400 `{"error":"invalid or expired OAuth callback"}`. `Cache-Control: no-store` set. Evidence: `devinCallbackHandler` in `setupRoutes`. |
| GET | `/callback` | 200 | same handler as `/devin/callback` |

### 3.9 Management surface — `/v0/management` (management auth, §4.3)

Registered **only when** `remote-management.secret-key` is set in config, or env `MANAGEMENT_PASSWORD` is set, or a local management password is provided (TUI). Otherwise every `/v0/management` path is absent → 404 empty (availability middleware). Home mode also disables the whole surface (404 empty). Evidence: `internal/api/server.go` `NewServer` (`hasManagementSecret`, `managementRoutesEnabled`); `internal/api/server_management.go` `managementAvailable`.

The surface has ~146 routes. Full payload semantics live in S5; S1 fixes the envelope:

- Auth: `Authorization: Bearer <key>` or `X-Management-Key: <key>` (Bearer prefix stripped case-insensitively; a non-Bearer Authorization value is compared verbatim).
- `GET /v0/management/config`, `GET /v0/management/api-keys`, `GET|PUT|PATCH|DELETE` on config sections (`api-keys`, `gemini-api-key`, `claude-api-key`, `codex-api-key`, `xai-api-key`, `meta-api-key`, `interactions-api-key`, `openai-compatibility`, `vertex-api-key`, `oauth-excluded-models`, `oauth-model-alias`, `oauth-request-scoped-errors`), logging toggles (`request-log`, `logging-to-file`, `logs-max-total-size-mb`, `error-logs-max-files`, `usage-statistics-enabled`, `debug`), retry/routing knobs (`request-retry`, `max-retry-credentials`, `max-retry-interval`, `routing/strategy`, `force-model-prefix`, `quota-exceeded/*`), auth-file CRUD (`auth-files*`, `vertex/import`), OAuth URL endpoints (`*-auth-url`, `get-auth-status`, `oauth-session`), quota endpoints (`quota/*`, `reset-quota`), plugins (`plugins*`, `plugin-store*`), logs (`logs`, `request-error-logs*`, `request-log-by-id/:id`), proxy-url, ws-auth, api-call, usage-queue, api-key-usage, latest-version, model-definitions/:channel.
- Unknown method on a known management path → 404 empty (R-404); unknown `/v0/management/<path>` → 404 empty (probe 15). **Ordering nuance:** with no plugin host installed, the unknown-path 404 is emitted by the NoRoute dispatcher WITHOUT running management auth (a keyless unknown-path request 404s instead of 401ing); when a plugin host IS installed, the NoRoute dispatcher runs the management middleware first (a keyless unknown-path request 401s, and only a valid key reaches plugin dispatch or 404). The anchored no-plugin recordings hold; the plugin-present ordering is plugin-conditional (S5/S7).
- `GET|POST /v0/management/oauth-callback` sits **outside** the management-key middleware (only availability middleware): 400 `{"error":"<message>","status":"error"}` with message one of `state is required`, `invalid state`, `code or error is required`, `unsupported provider`, `provider does not match state`, `invalid redirect_url`, `invalid body` (POST with a non-JSON body, `ShouldBindJSON` failure); 404 `{"error":"unknown or expired state","status":"error"}` (recorded S1-20); 409 `{"error":"<oauth flow is already completed|session status|oauth flow is not pending>","status":"error"}`; 200 `{"status":"ok"}`; 500 `{"error":"<handler not initialized|failed to persist oauth callback>","status":"error"}`. Map-sorted wire order puts `error` before `status` (§2); only `{"status":"ok"}` keeps its literal order. Evidence: `internal/api/server_management.go` route block; `internal/api/handlers/management/oauth_callback.go`; fixture S1-20 (mgmt-callback-badstate).

Evidence for the route list: `internal/api/server_management.go` `registerManagementRoutes` (S5 enumerates every route).

### 3.10 Conditional / plugin surfaces

- **Plugin WebSocket routes** (e.g. default `/v1/ws`): registered per-plugin via `AttachWebsocketRoute`; auth on them is conditional on the `websocket-auth` config toggle (off → open, on → client auth). OPTIONAL behavior, plugin-dependent. Evidence: `internal/api/server_routes.go` `AttachWebsocketRoute`.
- **Plugin management routes** under `/v0/management/*` and **plugin resources** under `/v0/resource/plugins/*`: dispatched by the plugin host when no static route matches, still behind the management middleware for management paths. Evidence: `internal/api/server_management.go` `pluginManagementNoRoute`.
- **Home-mode gates** (OPTIONAL, config-off in the reference deployment): when Home mode is on, all non-management routes get 503 empty when the Home heartbeat is down, `/v1/models` switches to the Home catalog, and the management surface 404s. Evidence: `internal/api/server_middleware.go` `homeHeartbeatMiddleware`; `server_routes.go` unified models handler. S1 does not spec Home-mode bodies further (open question OQ-4).
- **Example-API-key safe mode** (recorded, S1-25 config variant V2 — template values are `your-api-key-1/2/3`, `internal/safemode/example_api_keys.go`; activates in server mode when any configured key is a template value): `GET /` and `GET /management.html` (without `?safe-mode=configure`) serve an HTML warning page (`200`, `Cache-Control: no-store`, page title `Example API key detected`, listing the offending key); all proxy paths under `/v1`, `/v1beta`, `/openai/v1`, `/backend-api/codex` return 403 `{"error":"unsafe_example_api_key","message":"Proxy API endpoints are disabled because api-keys contains template values. Open /management.html?safe-mode=configure, update api-keys in Management, then retry."}` (two top-level keys, map-sorted) + response header `X-Cpa-Safe-Mode: example-api-key` (Go-canonicalized wire casing of the `X-CPA-SAFE-MODE` constant; recorded). The gate runs before client auth — the 403 is identical with or without credentials. OPTIONS still answers 204 (CORS middleware precedes the safe-mode gate; recorded). The `?safe-mode=configure` bypass on `/management.html` (serves the normal panel instead of the warning page) is source-verified (`exampleAPIKeySafeModeMiddleware` path check) and **golden-OPTIONAL** — not recorded in S1-25; the recorded plain `/management.html` request returns the warning page. Evidence: `internal/api/server_middleware.go` `exampleAPIKeySafeModeMiddleware`; `cmd/server/main.go` `shouldEnableExampleAPIKeySafeMode`; fixtures S1-25 (group E).
- **Redis-RESP multiplexer** on the same TCP port (SUBSCRIBE `usage`/`errors`), management-key auth over RESP. Not an HTTP route; specified in S7. Evidence: `internal/api/redis_queue_protocol.go`.
- **pprof listener (OPTIONAL diagnostic surface):** `pprof.enable: true` starts a separate Go `net/http/pprof` listener (default addr `127.0.0.1:8316`, `internal/config/config_defaults.go` `DefaultPprofAddr`) — independent of the client API surface and off by default. S7 owns platform availability. Evidence: `sdk/cliproxy/pprof_server.go`, `internal/config/config_load.go`.

## 4. Auth surfaces and accept/reject matrix

### 4.1 Client API auth (all `/v1`, `/v1beta`, `/openai/v1`, `/backend-api/codex` routes)

Evidence: `internal/access/config_access/provider.go` `Authenticate`; `sdk/access/errors.go`; recorded probes 06/07/17.

Accepted credential presentations (any ONE of):
1. `Authorization: Bearer <api-key>` (scheme prefix case-insensitive; a non-Bearer scheme makes the whole header value the candidate, which then fails the key match → "Invalid API key")
2. `X-Goog-Api-Key: <api-key>` — **accepted on `/v1` too, not only `/v1beta`** (bootstrap open question, recorded)
3. `X-Api-Key: <api-key>`
4. query parameter `?key=<api-key>`
5. query parameter `?auth_token=<api-key>`

Precedence: `Authorization` candidate, then `X-Goog-Api-Key`, then `X-Api-Key`, then `?key=`, then `?auth_token=`; first candidate matching a configured key authenticates.

Rejections (both `401`, `Content-Type: application/json; charset=utf-8`, CORS block present, empty-credential cases have no `X-CPA-TRACE-ID`):
- No credential presentation at all → `{"error":"Missing API key"}`
- Presentations present but none matches a configured key → `{"error":"Invalid API key"}`

Config-conditional MUST (recorded, S1-25 config variant V1): when the configured `api-keys` list is empty, the config-key provider is not registered and **all client routes are open** — a credential-less `GET /v1/models` returns 200 and a credential-less `POST /v1/chat/completions` proceeds to routing and fails with 400 `model_not_found`, proving no auth layer runs at all. Evidence: `internal/access/config_access/provider.go` `Register` unregisters on empty; `internal/api/server_middleware.go` treats provider-success as pass; fixtures S1-25 (group E).

`anthropic-version` is never validated; `X-Api-Key` is a full alternative to Bearer everywhere in the client surface.

### 4.2 Realtime/live auth

- `/v1/live` and `/v1/live/:call_id` are in the standard `/v1` group: plain client auth and the plain `{"error":"<msg>"}` 401 envelope (§4.1). Evidence: `internal/api/server_routes.go` (v1 group membership).
- The `/v1/realtime*` routes use the realtime middleware: a Realtime **client-secret** presentation (minted via `/v1/realtime/client_secrets`) is accepted first; otherwise standard client auth applies.
- Standard-auth failures on realtime routes return a **different envelope** (OpenAI-nested): `401 {"error":{"code":"invalid_api_key","message":"Missing API key"|"Invalid API key","param":null,"type":"authentication_error"}}` (recorded S1-19); a broken presented client secret → `401 {"error":{"code":"invalid_realtime_client_secret","message":<reason>,"param":null,"type":"invalid_request_error"}}`; auth-service internal errors → `type server_error` / `code authentication_service_error`. Evidence: `internal/api/server_middleware.go` `realtimeStandardAuthMiddleware`, `realtimeAuthMiddleware`.
- ALL `/v1/realtime*` handler errors use the nested realtime envelope (§6.3.6-7); `/v1/live*` + `/v1/alpha/search` use the plain `{"error":"<msg>"}` shape — the boundary is the `/v1/realtime` path-prefix check in `writeLiveError`.
- The remaining `/v1/realtime/*` management-ish endpoints (`client_secrets`, `sessions`, `transcription_sessions`, `calls/:id/hangup|accept|reject|refer`) use the standard realtime middleware (nested envelope) without client-secret matching. Evidence: `internal/api/server_routes.go`.

### 4.3 Management auth (`/v0/management/*`)

Evidence: `internal/api/handlers/management/handler.go` `Middleware`, `AuthenticateManagementKey`; recorded probes 11–15.

- Presentations: `Authorization: Bearer <key>` (non-Bearer value compared verbatim) or `X-Management-Key: <key>`. A local password (TUI) also authenticates local clients; env `MANAGEMENT_PASSWORD` overrides the allow-remote gate.
- Reject/accept matrix:
  - missing presentation → `401 {"error":"missing management key"}`
  - presentation present, wrong value → `401 {"error":"invalid management key"}`
  - remote client (not loopback) while `allow-remote` false → `403 {"error":"remote management disabled"}`
  - no secret configured at all (but routes registered via local password) → `403 {"error":"remote management key not set"}`
  - ≥5 failed attempts from one client IP → `403 {"error":"IP banned due to too many failed attempts. Try again in <duration>"}` (Go duration string; 30-min window; the ban check runs BEFORE key validation, so even a valid key gets 403 while banned — recorded S1-25 `mgmt-ip-ban-threshold`)
  - correct key → 200 (routes serve)
- All management responses (incl. 401/403/404-empty) carry the four build headers with wire casing `X-Cpa-Version`, `X-Cpa-Commit`, `X-Cpa-Build-Date`, `X-Cpa-Support-Plugin` (recorded S1-20).

### 4.4 Keep-alive auth

TUI-mode only (§3.1): `Authorization: Bearer <localPassword>` or `X-Local-Password`; wrong/missing → `401 {"error":"invalid password"}`.

### 4.5 No-auth routes

`GET /`, `GET|HEAD /healthz`, all `OPTIONS` requests, OAuth callbacks (§3.8), `/management.html`, `/v0/management/oauth-callback` (availability-gated only).

## 5. Routing semantics (Ruling R-404 and friends)

- **R-404 (binding ruling, recorded):** the gateway uses gin v1.10.1 with `HandleMethodNotAllowed` off.
  1. **Unknown route → 404 with EMPTY body** (`Content-Length: 0`, CORS block present, no Content-Type JSON). Recorded probes 02/03/16.
  2. **Known path, unregistered method → 404 with empty body** (NOT 405). Recorded probe 05. Applies to every route table above (e.g. GET `/v1/chat/completions`, POST `/v1/models`, PUT `/v1/messages`).
  3. Handler-produced 404s are exempt: they are JSON bodies (gemini model lookup `{"error":{"message":"Not Found","type":"not_found"}}`, gemini unknown `:method`, live sideband `{"error":"Codex live session not found"}`, management oauth-callback `{"status":"error","error":"unknown or expired state"}`).
- **HEAD:** only `/healthz` has an explicit HEAD registration. `HEAD` on any other path (incl. `/`) matches no route → 404 empty. OPTIONAL for CPA-Edge to add HEAD elsewhere; do not (S7 may register a degradation).
- **Trailing slash (recorded, S1-08 + S1-25):** gin's `RedirectTrailingSlash` is on by default and fires in **both directions** whenever the alternative path has a route for the same method; the redirect is emitted by the router layer BEFORE the middleware chain, so:
  - `GET /v1/models/` → `301 Moved Permanently`, `Location: /v1/models`, `Content-Type: text/html; charset=utf-8`, body `<a href="/v1/models">Moved Permanently</a>.` — and **no CORS headers** (§2 exception).
  - `POST /v1/chat/completions/` → `307 Temporary Redirect`, `Location: /v1/chat/completions`, empty body — no CORS headers, no Content-Type.
  - `POST /v1beta/models` (no trailing slash) → `307 Temporary Redirect`, `Location: /v1beta/models/`, empty body, no CORS — the wildcard POST route at the slash-terminated path makes the redirect apply in the no-slash direction too (recorded S1-25).
- **Case sensitivity:** route matching is case-sensitive (paths are matched verbatim); headers are canonicalized by the HTTP layer.
- **Query parameters of the routing layer:** `alt` / `$alt` (Gemini stream framing, §7), `key` / `auth_token` (auth), `client_version` (models-list switch, §6.2), `call_id` (realtime sideband switch), `safe-mode` (management.html).
- **Request body decoding:** handlers reading JSON accept bodies with `Content-Encoding: zstd` (decoded first; on decode failure with invalid JSON → 400 OpenAI-shaped invalid_request_error — recorded S1-25 message: `Invalid request: failed to decode zstd request body: invalid input: magic number mismatch`; a body that decodes to valid JSON passes through). A comma-separated `Content-Encoding` list is decoded **last-to-first** (`decodeRequestBody` iterates the split list in reverse). Unsupported content encodings → 400. Evidence: `sdk/api/handlers/request_body.go` `ReadRequestBody`/`decodeRequestBody` + fixture S1-25.

## 6. Schemas (gateway-generated bodies, field by field)

### 6.1 Root info — `GET /`
```
{"endpoints":["POST /v1/chat/completions","POST /v1/completions","GET /v1/models"],"message":"CLI Proxy API Server"}
```
- `endpoints`: string array, exactly the three entries above, in that order.
- `message`: the literal string `CLI Proxy API Server`.
- Key order on the wire: `endpoints` then `message` (map serialization is sorted).

### 6.2 Model lists — `GET /v1/models` and `GET /v1beta/models`

`GET /v1/models` format switch (evidence: `internal/api/server_routes.go` `unifiedModelsHandler`, `isAnthropicModelsRequest`; `sdk/api/handlers/openai/openai_handlers.go` `OpenAIModels`; `internal/client/claude/models` `BuildResponse`; `sdk/api/handlers/gemini/gemini_handlers.go` `GeminiModels`):
1. Default (OpenAI): `{"object":"list","data":[{...}]}` — wire order `data` first (map-sorted). Each entry: `id`, `object:"model"`, `created` (server-side epoch, dynamic), `owned_by` (provider name). With zero providers: `{"data":[],"object":"list"}` (probe 08).
2. `Anthropic-Version` header non-empty OR `User-Agent` starting with `claude-cli` → Claude shape: `{"data":[...],"first_id":"<first id>","has_more":false,"last_id":"<last id>"}`. Each entry: `id`, `object:"model"`, `owned_by`, `created_at` (RFC3339 UTC, only if created known), `type:"model"`, `display_name`, `max_input_tokens` (default 200000 when the model declares no limit, `internal/registry/model_registry.go` `DefaultClaudeMaxInputTokens`), `max_tokens` (default 64000, `DefaultClaudeMaxOutputTokens`). **ID cloaking (CONFIG-CONDITIONAL)**: with `claude-code.disable-cloaking-model-list: false` (default), ids not starting with `claude-` are rewritten to `claude-fable-5-dd-<reversed id>` in listings, and decoded back on `/v1/messages*` requests. Recorded S1-10: the alias `mock-model` lists as `claude-fable-5-dd-ledom-kcom`. With `claude-code.disable-cloaking-model-list: true` the listing returns ids verbatim (no rewrite, no decode) — evidence: `sdk/api/handlers/claude/code_handlers.go` `ClaudeModels` passes the config flag; `internal/client/claude/models` `BuildResponse(disableCloaking)`. Config key defined in `internal/config/sdk_config.go` (`yaml:"disable-cloaking-model-list"`) (`internal/client/claude/models` `EnsureClaudeModelIDPrefix`/`ResolveClaudeModelIDPrefix`).
3. `?client_version=<v>` present → Codex client catalog (per-client-version model entries; depends on the fetched/embedded codex catalog — OPTIONAL to mirror, see OQ-2).
4. Grok-shell `User-Agent` → grok shell catalog shape (`internal/api/server_routes.go` `handleGrokModels`; OQ-2).
5. Home mode on → Home catalog (out of S1 scope, OQ-4).

`GET /v1beta/models`: `{"models":[...]}` — each entry: `name` (`models/`-prefixed), `displayName`, `description`, `supportedGenerationMethods` (default `["generateContent"]`), optional `version`, `inputTokenLimit`, `outputTokenLimit`, modality lists. Empty registry → `{"models":[]}` (probe 17).

`GET /v1beta/models/<model>` (200): the single model entry (gemini shape above).

### 6.3 Error envelopes (exact shapes; §8 for when each applies)

1. **Auth-401 (client + keep-alive):** `{"error":"<message>"}` — messages exactly `Missing API key`, `Invalid API key`, `invalid password`.
2. **Realtime-auth 401:** `{"error":{"message":...,"param":null,"type":"authentication_error","code":"invalid_api_key"}}` (map-sorted wire order: `code`,`message`,`param`,`type`).
3. **OpenAI-shaped request/server errors:** `{"error":{"message":"<msg>","type":"<invalid_request_error|authentication_error|permission_error|rate_limit_error|server_error>","code":"<code>"}}` — the struct (`ErrorResponse`/`ErrorDetail`) has NO `param` field; `param` appears ONLY inside the hand-built `model_not_found` literal and in passthrough upstream bodies: `{"error":{"message":"unknown provider for model <model>","type":"invalid_request_error","code":"model_not_found","param":"model"}}` (status 400, key order fixed by the literal). An optional `retryable` boolean appears when the error carries a retryability classification.
4. **Claude-shaped errors** (`/v1/messages`, `/v1/messages/count_tokens`): `{"type":"error","error":{"type":"<api_error|invalid_request_error|authentication_error|billing_error|permission_error|not_found_error|request_too_large|rate_limit_error|timeout_error|overloaded_error>","message":"<msg>"}}` (struct order: type, message). A `model_not_found` upstream of this renderer collapses to `{"type":"error","error":{"type":"invalid_request_error","message":"unknown provider for model <model>"}}`.
5. **Management errors:** `{"error":"<message>"}` for auth (§4.3) and general handler errors; `{"status":"error","error":"<message>"}` for oauth-callback (§3.9).
6. **Live/alpha-search errors (path-dependent envelope):** `/v1/live*` and `/v1/alpha/search` return plain `{"error":"<message>"}` (status 503/400/413 as per §3.2; recorded S1-23). Every `/v1/realtime*` route instead returns the **nested** envelope of §3.7: type `api_error` (≥500) / `invalid_request_error` (4xx) / `authentication_error` (401), code `realtime_request_failed` — the switch is the path-prefix check in `writeLiveError` (`internal/client/codex/live/live.go`).
7. **Realtime non-WS 426:** nested envelope (§3.7); code `websocket_upgrade_required` when no `?call_id=` was presented, code `realtime_request_failed` when `?call_id=` routed the request to the sideband path; always with the `Upgrade: websocket` response header.

### 6.4 Misc bodies

- `GET /healthz` → `{"status":"ok"}`; `HEAD /healthz` → empty.
- `GET /keep-alive` (TUI) → `{"status":"ok"}`.
- OAuth callback success page (exact): `<html><head><meta charset="utf-8"><title>Authentication successful</title><script>setTimeout(function(){window.close();},5000);</script></head><body><h1>Authentication successful!</h1><p>You can close this window.</p><p>This window will close automatically in 5 seconds.</p></body></html>` (kept as public interface text for compatibility).
- `GET /` — see §6.1.
- Codex-Responses passthrough + WS events: `event:` names `response.create`, `response.append`, `error`, `response.completed`, `response.done`, terminal marker `[DONE]`, close reasons mirrored from upstream (S2d9 owns semantics).

## 7. Streaming rules (route boundary)

Streaming routes: `/v1/chat/completions`, `/v1/completions`, `/v1/messages` (SSE), `/v1/responses` + `/backend-api/codex/responses` (SSE), `/v1beta/models/<m>:streamGenerateContent` (SSE or raw), `/v1beta/interactions` (stream flag), images routes with `stream:true`, plus the WS routes (§3.2/3.5/3.7).

- **Success headers** (SSE routes, before first data byte): `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`, `Access-Control-Allow-Origin: *`. Evidence: `setSSEHeaders` in the streaming handlers (openai/claude/gemini/responses).
- **Frame format:** `data: <chunk>\n\n` per SSE frame; terminal `data: [DONE]\n\n` on OpenAI-family streams (chat/completions, completions, responses-as-openai). Upstream `event:` lines are dropped on openai-compat upstreams (bootstrap §6) and preserved on codex passthrough (wire notes). Claude SSE chunks are written verbatim (they already carry `event:` framing from translation).
- **Pre-stream errors:** if selection/execution fails before the first data chunk, the error is returned as a normal HTTP status + JSON body (§6.3) — no SSE headers are sent. Testable via: unknown model with `stream:true` → 400 JSON, not SSE.
- **Mid-stream terminal errors:**
  - Gemini SSE surface: `event: error\ndata: <OpenAI-shaped JSON>\n\n` frame.
  - Claude surface: `event: error\ndata: {"type":"error","error":{"type":...,"message":...}}\n\n` frame.
  - OpenAI-family surfaces: error chunk inline as `data: {"error":{...}}` then `data: [DONE]` (S2 sections own the exact chunk).
- **`alt` switch (Gemini streamGenerateContent, also honored elsewhere via GetAlt):** `?alt=sse` and absent → SSE framing (this is the gateway default and matches `alt=sse`); `?alt=json` (or any other non-empty value except `sse`) → raw concatenated JSON chunks with NO `data:` framing and no SSE headers; recorded `Content-Type: text/plain; charset=utf-8` (connection-level default sniffing — the handler sets no content type on raw streams, S1-17); `?$alt=` is accepted as an alias; `?alt=` (parameter present but empty) still selects SSE framing (`GetAlt` sees the parameter, returns the empty value, and the empty value falls into the SSE branch — it does NOT fall back to `$alt`). Evidence: `sdk/api/handlers/handlers.go` `GetAlt` + `handleStreamGenerateContent`. Note this is INVERTED relative to the real Gemini API (where default is chunked JSON); the gateway default is SSE. Golden S1-17 pins it.
- **WS routes:** upgrade via `Connection: upgrade` + `Upgrade: websocket`; non-WS requests → 400 (responses WS, gorilla plain-text) or 426 (realtime/sideband, §3.7). 101 responses have no CORS guarantee beyond the pre-upgrade headers already set.
- **Contract binding for streams (R-SSE):** contract tests compare the **decoded event sequence** — for SSE, the ordered list of (event name, data payload) pairs after `data:`/`event:` framing is parsed, terminal `[DONE]` included; for WS, the ordered message frames. Raw chunk boundaries, flush timing, and chunk sizes are NOT part of the contract. Byte-exact comparison applies only to the per-event payloads with whitelisted dynamic fields masked.
- **Client disconnect:** nginx-style status 499 is used internally for canceled requests (`internal/clienterror` `StatusClientClosedRequest`); a disconnected streaming client leaves the response at 200 with whatever bytes were already flushed (wire note: disconnect-mid-stream keeps client HTTP 200 and the error surfaces in-stream).

## 8. Error semantics (status-code decision table)

Gateway-level (before/without upstream involvement):

| Condition | Status | Body shape |
|---|---|---|
| No client credential | 401 | `{"error":"Missing API key"}` |
| Client credential not matching | 401 | `{"error":"Invalid API key"}` |
| Body unreadable / invalid JSON at handler | 400 | OpenAI-shaped `"Invalid request: <err>"` (invalid_request_error) |
| Model resolves to no provider | 400 | OpenAI-shaped `model_not_found` (§6.3.3); Claude-shaped collapse on Claude surface (§6.3.4); Gemini surface uses the OpenAI shape |
| Image-only model on non-image route | 503 | OpenAI-shaped, message `model <m> is only supported on /v1/images/generations and /v1/images/edits` |
| No upstream credential available (none registered / all in cooldown) | 500 (recorded) / 503 (other selection paths) | OpenAI-shaped; recorded shape `{"error":{"message":"auth_unavailable: no auth available (providers=..., model=...; last upstream error: ...)","type":"server_error","code":"internal_server_error"}}`; cooldown-exhaustion variant `{"error":{"code":"model_cooldown","last_upstream_error":"<verbatim>","message":"All credentials for model <m> are cooling down via provider <p> (last error: ...)}}` (wire notes). Exact status/body per pool state is S4 territory; S1 pins the recorded goldens only. |
| Codex-only routes with no codex credential | 503 | `{"error":"auth_not_found: no auth available"}` (recorded S1-23 for POST /v1/alpha/search and POST /v1/live with valid client key); the literal `Codex auth unavailable` appears when selection succeeds with nil auth |
| Framework: unknown route / wrong method | 404 | empty |
| OPTIONS anywhere | 204 | empty |
| Realtime route without WS upgrade | 426 | nested §3.7 JSON — code `websocket_upgrade_required` (no `?call_id=`) or `realtime_request_failed` (sideband) + `Upgrade: websocket` header |
| Responses WS route without WS upgrade | 400 | gorilla plain-text handshake failure (+ `Sec-Websocket-Version: 13`) |
| Realtime capability stubs (translations, transcription_sessions, calls accept/reject/refer) | 501 | nested `not_supported_error` / `realtime_capability_not_supported` (§3.7) |
| Client aborts before completion | 499 (internal) / truncated 200 stream | — |

Upstream-propagated errors keep the upstream status and, when the upstream body is valid JSON, pass it through verbatim (openai-compat non-stream passes same bytes; 429 passes body+status verbatim — wire notes). S2 sections own per-surface propagation; S1 fixes only the envelopes above.

`Retry-After` response headers from upstream auth errors are surfaced on error responses when present (`sdk/api/handlers/handlers_errors.go` `WriteErrorResponse`).

## 9. Golden samples index

Case definitions: `spec/recordings/S1.cases.json` (25 recordable cases — S1-01…S1-24 plus the gate round-1 follow-up batch S1-25 — and 5 FIXTURE-DEFERRED, one of which, S1-D3, is now closed by S1-25). **All 25 cases recorded 2026-09-15** by @oracle-runner against CLIProxyAPI v7.3.4 (image digest sha256:97825da3...) — 25 fixture dirs, 283 files under `tests/fixtures/S1/` (203 + 80 in S1-25). Layout per RECIPES (`reports/oracle/BOOTSTRAP.md` §7): per case `meta.yaml` (anchor, config, dynamic_fields, per-request http_status; S1-25 additionally records the config variant per request), one `<request>.request.http` + `<request>.downstream.md` per request, `upstream.jsonl` + `mock-response.json` for provider-attached cases. Dynamic fields masked by the contract layer: `Date`, `X-Cpa-Trace-Id`, `created`, `created_at`, ban-remaining durations.

| Case id | Focus | Files | Status |
|---|---|---|---|
| S1-01 | root info payload | 3 | recorded |
| S1-02 | OPTIONS everywhere → 204 + CORS (known/unknown/mgmt paths) | 7 | recorded |
| S1-03 | R-404 unknown route → 404 empty | 7 | recorded |
| S1-04 | R-404 wrong method → 404 empty; HEAD only on /healthz | 9 | recorded |
| S1-05 | auth missing → 401 Missing API key (all surfaces) | 11 | recorded |
| S1-06 | auth invalid → 401 Invalid API key (all five styles) | 11 | recorded |
| S1-07 | auth accept matrix (Bearer/x-goog/x-api-key/?key/?auth_token on /v1 and /v1beta; X-Api-Key on /v1/messages) | 16 | recorded |
| S1-08 | trailing-slash redirect 301/307, no-CORS exception | 5 | recorded |
| S1-09 | OpenAI models list shape (provider attached) | 4 | recorded |
| S1-10 | Claude models list shape (header + claude-cli UA, id cloaking) | 6 | recorded |
| S1-11 | model_not_found matrix (openai/claude/responses/gemini surfaces, stream flag) | 14 | recorded |
| S1-12 | Gemini models list/get + handler-404 JSON body | 8 | recorded |
| S1-13 | Gemini :action routing (bogus method 200-empty / no-colon 404 JSON / generateContent) | 9 | recorded |
| S1-14 | chat completions happy (alias rewrite upstream) | 5 | recorded |
| S1-15 | chat completions SSE framing + [DONE] | 5 | recorded |
| S1-16 | claude messages happy (translated upstream) | 5 | recorded |
| S1-17 | gemini streamGenerateContent alt switch (sse default / alt=json raw) | 9 | recorded |
| S1-18 | responses endpoints (non-stream/SSE/compact-400/codex alias) | 11 | recorded |
| S1-19 | WS upgrade required (responses 400, realtime 426, realtime auth envelopes) | 9 | recorded |
| S1-20 | management auth matrix + unknown subroute/wrong-method 404 empty + oauth-callback bad state | 17 | recorded |
| S1-21 | healthz GET/HEAD, HEAD / 404, keep-alive absent 404 | 9 | recorded (re-recorded in S1-25 group F and swapped in; HEAD body section clean) |
| S1-22 | OAuth callbacks (HTML 200, devin 400, state validation) | 11 | recorded |
| S1-23 | codex-only routes without codex credentials (503 auth_not_found, alias routing) | 7 | recorded |
| S1-24 | countTokens via provider (local synthesis, empty upstream.jsonl) | 5 | recorded |
| S1-25 | gate round-1 follow-up batch (38 requests): realtime 501 capability stubs, sideband 426, client_secrets/hangup bodies, N1 pinning gaps (image-only 503, images 400s, interactions 400s, gemini empty-action + no-slash 307, mgmt remote-disabled 403, mgmt IP-ban threshold, oauth-callback state-required 400, zstd 400), config variants (empty api-keys open gate; example-key safe mode — closes S1-D3), S1-21 re-record (group F, swapped into S1-21/) | 80 | recorded |

Recording corrections applied to this section from fixture bytes (fixtures are authoritative per SPEC precedence):
- S1-13: unknown `:method` is a silent fall-through → 200 with empty body and no upstream dispatch (the oracle's inline narrative said "dispatched upstream"; the fixture's single upstream.jsonl entry belongs to the generateContent probe and the S1-13 downstream response carries no `X-Cpa-Trace-Id` — fixture + source agree).
- S1-08: trailing-slash redirects carry NO CORS headers (§2 exception, §5 recorded bytes).
- S1-20: oauth-callback unknown-state body wire order is `{"error":"unknown or expired state","status":"error"}` (map-sorted).
- S1-23: exact 503 selector string recorded: `{"error":"auth_not_found: no auth available"}`.
- S1-24: countTokens synthesized locally (§3.4 note).

Gate round-1 corrections applied from `reports/adversary/S1.md` (B1–B4, N3/N5/N6/N7):
- B1: realtime capability routes (`translations` GET+POST, `translations/client_secrets`, `transcription_sessions`, `calls/:id/{accept,reject,refer}`) are ALWAYS 501 stubs with the nested `not_supported_error`/`realtime_capability_not_supported` body; `calls/:id/hangup` is the only real control endpoint (400/403/404 matrix in §3.7).
- B2: all `/v1/realtime*` errors use the nested realtime envelope (path-prefix switch in `writeLiveError`); 426 code is `websocket_upgrade_required` only without `?call_id=` and `realtime_request_failed` on the sideband path; `client_secrets` 400 is nested `invalid_request`.
- B3: `claude-code.disable-cloaking-model-list: true` (default false) returns verbatim ids in the Claude model list.
- B4: the all-disabled image gate literal is `disable-image-generation: true` (bool), four-state value false/true/"chat"/"passthrough".
- N3: pprof listener one-liner (§3.10). N5: `invalid body` added to the oauth-callback 400 list. N6: R-SSE decoded-event-sequence contract binding (§7). N7: `param` is not an ErrorDetail struct field (§6.3.3); plugin-present mgmt unknown-path runs auth before 404, anchored no-plugin path 404s without any key (§3.9); `?alt=` (empty) selects SSE framing (§7); zstd comma-lists decode last-to-first (§5). N8: inventory-level looseness accepted (S5/S2 own the detail).
Open pinning gaps from N1 (plus the B1/B2 realtime bodies) are batched into case S1-25 (§9) — **recorded 2026-09-15: 38 request/response pairs, 80 files** (the 37 batch probes plus the `mgmt-ip-ban-threshold` follow-up; auxiliary files: `meta.yaml`, the ban-probe raw bytes ×2, and the zstd garbage payload). S1-25 recording reconciliations applied to this section:
- `POST /v1beta/models` (no trailing slash) → **307 + `Location: /v1beta/models/`**, empty body, no CORS — the derived 404-empty was wrong; the trailing-slash redirect fires in the no-slash direction because the wildcard POST route exists at the slash-terminated path (§5 generalized to both directions).
- `POST /v1beta/models/` empty-action → 404 JSON `/v1beta/models/ not found.` — derived value confirmed.
- zstd decode-failure message (exact): `Invalid request: failed to decode zstd request body: invalid input: magic number mismatch`.
- interactions invalid-JSON message: `invalid JSON body` (distinct from the images surface's `Invalid request: body must be valid JSON`).
- Sideband 426s (`?call_id=` and `/calls/:id`): code `realtime_request_failed` on both, consistent with the no-`call_id` `websocket_upgrade_required` pin from S1-19.
- Safe-mode 403 carries `X-Cpa-Safe-Mode: example-api-key` (wire casing) and is identical with or without credentials; OPTIONS still 204; **S1-D3 deferral closed** by these fixtures.
- Empty-`api-keys` open gate confirmed (200 without credentials; routing proceeds to 400 `model_not_found`).
- Management remote-disabled 403 recorded (valid key, non-loopback source). IP-ban threshold recorded (`mgmt-ip-ban-threshold`): five wrong keys → five 401s, then a request with a VALID key → 403 `{"error":"IP banned due to too many failed attempts. Try again in <duration>"}` (Go duration string, dynamic; window 30m) — the ban check precedes key validation.

FIXTURE-DEFERRED (documented in spec, no fixture; reasons in `spec/recordings/S1.cases.json` → `fixture_deferred`):
S1-D1 keep-alive TUI 200/401; S1-D2 client_version/grok-shell model catalogs; S1-D4 Home-mode gates; S1-D5 plugin WS route. ~~S1-D3 example-API-key safe mode~~ — **CLOSED: recorded in the S1-25 batch (config variant V2), see §3.10.** Sub-deferral (recorded nowhere, documented in §4.3): `remote management key not set` 403 — TUI-embed-only (server mode without a secret never registers the management routes). The management IP-ban threshold is now fixture-pinned (S1-25 `mgmt-ip-ban-threshold`).

Pre-recording bootstrap evidence (already captured in `_cpa_edge_ref/probes/bootstrap/`) backing §2/§5: probes 01–17 (root, unknown route, OPTIONS, wrong method, models auth pair, models valid, chat 400, management auth matrix, gemini models, keep-alive 404) and the mock-recordings set (models/chat/chat-stream happy paths + cooldown 500).

## 10. Open questions and intentional non-equivalences

- **OQ-1 (trailing slash) — RESOLVED by recording (S1-08):** GET → 301 + `Location` + gin HTML body `<a href="/v1/models">Moved Permanently</a>.` with `Content-Type: text/html; charset=utf-8` and NO CORS headers; POST → 307 + `Location` + empty body, no CORS. CPA-Edge MUST reproduce status + `Location` + the no-CORS exception; the 301 HTML body bytes are platform-OPTIONAL (registered here as a candidate degradation for runtimes that cannot emit a body on redirects).
- **OQ-2 (models-list variants):** `?client_version=` codex catalog and grok-shell UA catalog shapes depend on remote catalog downloads; both are marked OPTIONAL and are not golden-pinned in S1 (they are content-dependent). If a contract test needs them, record in a follow-up mission.
- **OQ-3 (500 vs 503 for pool exhaustion):** the recorded cooldown golden is 500 `internal_server_error`; other auth-selection paths produce 503 with the same body class. S4 owns the decision table; S1 pins only the recorded bytes.
- **OQ-4 (Home mode):** Home-mode gates (503 heartbeat gate, Home catalog on `/v1/models`) are config-off in the reference deployment and are not S1 goldens; S7/S5 own them.
- **OQ-5 (safe mode) — RESOLVED by recording (S1-25 variant V2):** the example-API-key warning page, 403 gate (+`X-Cpa-Safe-Mode` header), OPTIONS bypass, and `/management.html` page behavior are fixture-pinned; the deferral S1-D3 is closed. Remaining sub-deferred: `remote management key not set` 403 (TUI-embed-only). The IP-ban threshold is fixture-pinned (S1-25).
- **OQ-6 (keep-alive TUI):** the 200 path of `/keep-alive` is TUI-only; the docker oracle records the 404-empty case. The TUI 200/401 paths are `FIXTURE-DEFERRED`.
- **Non-equivalence registry candidate:** none for S1 core; HEAD-everywhere and 405 statuses must NOT be "improved" (R-404). Any platform that cannot serve empty-body 404s (some edge runtimes inject bodies) must register an S7 degradation instead of silently diverging.
