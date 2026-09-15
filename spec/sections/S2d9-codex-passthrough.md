# S2d9 — Codex/Responses passthrough semantics

Section id: S2d9. Module: Responses client -> Codex Responses upstream (passthrough via `codex-api-key` + `base-url` override).
Upstream anchor: CLIProxyAPI v7.3.4, commit `8335eac731946bd4eff18f500653f93736df53d6`.
Classification: RECORDABLE-LOCALLY (per SPEC Ruling R-FIXTURE; `codex-api-key` accepts `base-url` -> mock speaks Responses wire).
Evidence conventions: `ref:<path>` = file in the read-only upstream reference (`~/projects/llm-api/_cpa_edge_ref/CLIProxyAPI/<path>`); `recorded:` = oracle-recorded behavior (reports/oracle/BOOTSTRAP.md §6–§7 and orchestrator wire notes 2026-09-16); fixtures under `tests/fixtures/S2d9/` outrank prose (SPEC §0 precedence).

## 1. Scope and boundaries

In scope:
- Downstream client protocol: OpenAI **Responses** (`POST /v1/responses`), served by the Responses handler (`ref:internal/api/server_routes.go` — `openaiResponsesHandlers.Responses`).
- Codex CLI direct-route aliases: `POST /backend-api/codex/responses` and `POST /backend-api/codex/responses/compact` (same handlers, same middleware group).
- `POST /v1/responses/compact` (context compaction passthrough).
- Upstream: the `codex` executor over a `codex-api-key` provider entry with `base-url` override; upstream URL `{base-url}/responses` and `{base-url}/responses/compact` (`ref:internal/runtime/executor/codex_executor_execute.go` — `url := strings.TrimSuffix(baseURL, "/") + "/responses"`; default when no base-url: `https://chatgpt.com/backend-api/codex`).
- Request field rewrite inventory, SSE event-by-event passthrough fidelity, error passthrough, synthesized in-stream failures, non-stream aggregation, usage accounting.

Out of scope (owned elsewhere or excluded):
- `GET /v1/responses` / `GET /backend-api/codex/responses` — WebSocket upgrade path (separate live/realtime mission).
- `/v1/alpha/search` — Codex-native search wire (not a Responses passthrough; separate section when scheduled).
- `POST /v1/live*`, `/v1/realtime*` — live/realtime mission.
- Client authn/authz middleware, 401 shapes, R-404 empty-body 404s, route table: S1.
- Credential selection, rotation, retry, cooldown policy: S4 (S2d9 fixes single-credential, `request-retry: 0`, cooldowns-off recording config; cooldown side effects are called out only where observable through this route).
- OAuth Codex credentials (chatgpt.com) — CREDENTIALED-ONLY per R-FIXTURE; only the API-key flavor is locally recordable.
- Usage queue persistence: S6.

## 2. Behavior inventory (routes, methods, status codes)

| # | Route | Method | Success | Notes |
|---|---|---|---|---|
| B1 | `/v1/responses` | POST | 200 | Streaming iff request JSON `"stream": true` (`ref:sdk/api/handlers/openai/openai_responses_handlers.go` — `Responses`). |
| B2 | `/backend-api/codex/responses` | POST | 200 | Exact alias of B1, registered in the same auth group (`ref:internal/api/server_routes.go` — `codexDirect`). |
| B3 | `/v1/responses/compact` | POST | 200 | `ref:sdk/api/handlers/openai/openai_responses_handlers.go` — `Compact`. |
| B4 | `/backend-api/codex/responses/compact` | POST | 200 | Alias of B3. |
| B5 | `/v1/responses` (and both aliases) | GET | — | WebSocket; OUT OF SCOPE. |
| B6 | `/v1/alpha/search` | POST | 200 | Out of scope (see §1). |

Error status codes reachable through B1–B4 (all bodies JSON, exact shapes in §5):
- 400 `invalid_request_error` — body read failure; `stream: true` on compact; model unknown to the registry: `{"error":{"message":"unknown provider for model <model>","type":"invalid_request_error","code":"model_not_found","param":"model"}}` (recorded: BOOTSTRAP §4).
- 401 — downstream API-key auth failures (S1: `{"error":"Missing API key"}` / `{"error":"Invalid API key"}`).
- Upstream-mapped statuses: 401/404/408/429/5xx — see §5.1 (upstream status is preserved except the remaps listed there).
- 502/503 — upstream transport failures, empty-incomplete, no credentials after selection errors (S4).

Per R-404 (SPEC §5): wrong method on a known route = 404 empty body; unknown route = 404 empty body. Every response carries the global CORS block (recorded: BOOTSTRAP §4).

## 3. Schemas

### 3.1 Downstream request (client -> gateway)

Body: OpenAI Responses request JSON (`model`, `input`, `instructions`, `tools`, `reasoning`, `stream`, `store`, `include`, `previous_response_id`, `prompt_cache_key`, ...). The handler reads the raw body, applies OPTIONAL config-gated pre-steps (`prepareCodexMultiAgentV2Tools`, `prepareCodexOrphanDelegation` — both off by default; `ref:sdk/api/handlers/openai/openai_responses_handlers.go`), then dispatches on `"stream" == true` (JSON booleans; string "true" is NOT accepted).

Auth: `Authorization: Bearer <api-key>` or `X-Api-Key` (S1).

### 3.2 Upstream request construction (gateway -> Codex upstream)

The selected `codex-api-key` credential supplies `api_key` and `base_url` attributes (`ref:internal/runtime/executor/codex_executor_auth.go` — `codexCreds`). Upstream call: `POST {base-url}/responses` (B1/B2), `POST {base-url}/responses/compact` (B3/B4). The path suffix `/responses` is appended to the configured base-url verbatim after trimming trailing `/` — operators point `base-url` at the mock root, NOT at a `/v1` prefix (contrast: `openai-compatibility` base-url includes `/v1`).

Field-by-field rewrite table (order of operations: `ref:internal/runtime/executor/codex_executor_execute.go` — `Execute`/`executeCompact`; `ref:internal/runtime/executor/codex_executor_stream.go` — `ExecuteStream`; translator `ref:internal/translator/codex/openai/responses/codex_openai-responses_request.go`):

| Request field | Treatment upstream | Evidence |
|---|---|---|
| `model` | REWRITTEN: client alias -> configured upstream model (`codex-api-key.models[].alias` -> `.name`). Client model equal to `.name` passes through. Thinking suffix `model(...)` is preserved on the resolved upstream model. | `ref:sdk/cliproxy/auth/oauth_model_alias.go` — `resolveModelAliasResultFromConfigModels`; `ref:internal/runtime/executor/codex_executor_execute.go` — `SetStringIfDifferent(body, "model", baseModel)` |
| `stream` | FORCED `true` on `/responses` (upstream is ALWAYS SSE, even for non-stream clients — recorded wire note 2026-09-16). DELETED on `/responses/compact`. | `ref:internal/translator/codex/openai/responses/codex_openai-responses_request.go` — `setCodexRequiredBool(rawJSON, "stream", true)`; `ref:internal/runtime/executor/codex_executor_execute.go` — `executeCompact` deletes `stream` |
| `store` | FORCED `false` (client `store: true` is overridden; the Codex upstream rejects store=true). NOT touched on compact. | `ref:internal/translator/codex/openai/responses/codex_openai-responses_request.go` — `setCodexRequiredBool(rawJSON, "store", false)` |
| `include` | FORCED `["reasoning.encrypted_content"]` unless already exactly that one-element array. | same file — `setCodexRequiredInclude` |
| `parallel_tool_calls` | FORCED `true`; then deleted if the (possibly injected) `tools` array ends up empty; FORCED `false` for native Lite requests (§3.3). | same file — `setCodexRequiredBool(..., "parallel_tool_calls", true)`; `ref:internal/runtime/executor/codex_executor_request.go` — `normalizeCodexParallelToolCalls*` |
| `instructions` | PRESERVED verbatim when present. When absent/null: set to `""` (non-Lite requests); left absent for native Lite requests. | `ref:internal/runtime/executor/codex_executor_request.go` — `normalizeCodexInstructions` |
| `input` (string) | REWRITTEN to `[{"type":"message","role":"user","content":[{"type":"input_text","text":<string>}]}]`. | translator file — `ConvertOpenAIResponsesRequestToCodex` |
| `input` (array) | PRESERVED item-by-item EXCEPT: role `system` -> `developer` in message items; `prompt_cache_breakpoint` stripped from `input[].content[]` parts; reasoning-item sanitization (below); item-id normalization (below). | same file — `convertSystemRoleToDeveloper`, `stripCodexResponsesCacheBreakpoints` |
| `input[].type=="reasoning"` items | `content[]` non-empty: `reasoning_text` parts promoted into `summary` (as `summary_text`) when summary empty, then `content` forced `[]`. `encrypted_content` present but invalid (whitespace / null / non-string / GPT-signature parse failure): field DROPPED; and because store is forced false, the item `id` is DROPPED too. `encrypted_content` absent: item `id` DROPPED (store=false orphan-id rule). Valid `encrypted_content`: item preserved verbatim. | `ref:internal/runtime/executor/openai_responses_signature.go` — `sanitizeOpenAIResponsesReasoningEncryptedContent`; signature rules `ref:internal/signature/gpt_validation.go` (prefix `gAAAA`, base64url, decoded >= 73 bytes, first byte 0x80, AES-block ciphertext) |
| `input[].id` | Normalized: ids of typed items get type prefixes (`msg_`, `rs_`, `fc_`, `ctc_`, `ctco_`) when missing; ids > 64 runes are deterministically shortened with a SHA-256 hash suffix; encrypted reasoning items with overlong ids are dropped entirely. Already-prefixed short ids pass verbatim. | `ref:internal/runtime/executor/helps/codex_input_ids.go` — `SanitizeCodexInputItemIDs` |
| `tools` | PRESERVED; then (default config, non-Lite) an image-generation tool is APPENDED if none present: `{"type":"image_generation","output_format":"png"}` (appended at end of array, or `tools` created with that single element when absent). Disabled by `disable-image-generation: true/all` (`passthrough`/`chat` modes do not stop this injection). Skipped for Lite requests. | `ref:internal/runtime/executor/codex_executor_request.go` — `ensureImageGenerationTool`; default `ref:internal/config/config_load.go` (`DisableImageGenerationOff`) |
| `tools[].type` builtin aliases | REWRITTEN `web_search_preview` and `web_search_preview_2025_03_11` -> `web_search`, in `tools`, `tool_choice.type`, and `tool_choice.tools[].type`. | translator file — `normalizeCodexBuiltinTools` |
| function tool JSON schemas | PRESERVED except OPTIONAL deep normalization: pure >=8-branch const `oneOf`/`anyOf` unions -> `enum`; unsupported unicode property escapes in `pattern` stripped. | `ref:internal/runtime/executor/helps/codex_tool_schema.go` |
| `reasoning` | PRESERVED verbatim (effort/summary etc.). OPTIONAL: registry/thinking-suffix may set `reasoning.effort` for configured models. | `ref:internal/thinking/provider/codex/apply.go` |
| `previous_response_id` | DELETED (stateful continuation is not forwarded; history must be replayed in `input`). NOT deleted on compact. | `ref:internal/runtime/executor/codex_executor_execute.go` — `sjson.DeleteBytes(body, "previous_response_id")` |
| `prompt_cache_key` | Client value PRESERVED verbatim and also sent as the `Session-Id` upstream header. When the client sends none, the gateway attaches a derived session UUID (dynamic; mask in fixtures) in both body `prompt_cache_key` and `Session-Id` header. | `ref:internal/runtime/executor/codex_executor_request.go` — `cacheHelper`; recorded wire note: `Session-Id: <uuid>` on codex upstream |
| `prompt_cache_retention`, `safety_identifier`, `generate` | DELETED. | `ref:internal/runtime/executor/codex_executor_stream.go` — delete list |
| `stream_options` | DELETED on `/responses`, EXCEPT `stream_options.reasoning_summary_delivery` which is preserved as the only member. Not touched on compact. | same file — reasoningSummaryDelivery carve-out |
| `max_output_tokens`, `max_completion_tokens`, `temperature`, `top_p` | DELETED (Codex Responses rejects token limit fields). Not deleted on compact. | translator file — `deleteCodexRequestFields` |
| `service_tier` | DELETED unless value == `"priority"`. | same file |
| `truncation`, `prompt_cache_options`, `user`, `context_management` | DELETED. | same file — `applyResponsesCompactionCompatibility` et al. |
| `metadata`, `text`, `tool_choice`, `prompt_cache_key` (others) | PRESERVED verbatim. | absence from any rewrite list above |

Upstream headers (`ref:internal/runtime/executor/codex_executor_request.go` — `applyCodexHeadersFromSources`; recorded wire note):
- `Content-Type: application/json`
- `Authorization: Bearer <api-key from codex-api-key entry>`
- `Accept: text/event-stream` (ALWAYS for `/responses`, incl. non-stream clients) / `Accept: application/json` (compact)
- `Connection: Keep-Alive`
- `User-Agent: codex-tui/0.154.0 (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; 0.154.0)` — CLI cloaking; default on (`codex.disable-cloaking` false). Cloaking runs last and FORCES this value and `Originator` even when the client sent its own.
- `Originator: codex-tui` — forced by default cloaking. With `codex.disable-cloaking: true`: the client's `Originator` is forwarded when present; otherwise API-key auth sends NO Originator (the codex-tui default applies only to OAuth credentials).
- `Session-Id: <uuid-or-client-prompt-cache-key>` (see `prompt_cache_key` row)
- Forwarded when the client sends them: `Version`, `X-Codex-Turn-Metadata`, `X-Codex-Turn-State`, `X-Client-Request-Id`, `X-Codex-Window-Id`, `Thread-Id`, `Session-Id`, `X-OpenAI-Internal-Codex-Responses-Lite`, `X-Codex-Beta-Features`, `Originator` (the last one only survives when cloaking is disabled; cloaking overwrites it with `codex-tui`)
- Per-entry `headers:` config: static values set verbatim; values starting with `$` copy the named client header when present (`ref:internal/util` — `ApplyCustomHeadersFromAttrs`)
- All other client headers are NOT forwarded (recorded: client headers not forwarded, BOOTSTRAP §6).

Downstream->upstream auth note: the client's own `Authorization` is replaced wholesale; upstream sees only the provider key.

### 3.3 Native "Responses-Lite" client dialect

A request is *native Lite* iff source and response formats are Responses/Codex AND (`X-OpenAI-Internal-Codex-Responses-Lite: true` header OR body `client_metadata.ws_request_header_x_openai_internal_codex_responses_lite == true`) (`ref:internal/runtime/executor/helps/codex_native.go`, `ref:internal/util/codex.go`). Lite requests: `instructions` left untouched, `parallel_tool_calls` forced `false`, NO image-generation tool injection, Lite header forwarded upstream. All S2d9 goldens exercise the non-Lite default except S2d9-07.

### 3.4 Config fragment (golden recording contract)

```yaml
codex-api-key:
  - api-key: "mock-codex-key-1"
    base-url: "http://host.docker.internal:<mock-port>"   # mock root; executor appends /responses
    models:
      - name: "mock-codex-upstream"
        alias: "codex-mock"
      - name: "mock-codex-upstream"
        alias: "codex-mock-forced"
        force-mapping: true
```

Port conventions are per recording worker and are MASKED DYNAMIC FIELDS in fixtures (`<mock-port>` = 23001 for the assigned worker-5; the reference instance listens on the worker's downstream port, 8417 for worker-5). No contract assertion depends on a literal port value.

Schema notes (`ref:config.example.yaml` — `codex-api-key` block; `ref:internal/config` — `CodexKey`):
- `models[].name` = upstream model id; `models[].alias` = client-facing id. Without `models:`, the entry serves the built-in Codex Pro default catalog (any default-catalog model id passes through verbatim) — `ref:sdk/cliproxy/service_models.go` — `buildCodexConfigModels`.
- `force-mapping: true` rewrites model fields in responses back to the alias (§4.3).
- OPTIONAL per-entry knobs (not exercised by goldens): `weight`, `prefix`, `disable-cooling`, `request-retry`, `request-scoped-errors`, `alpha-search`, `headers`, `proxy-url`, `excluded-models`.

## 4. Streaming rules (SSE passthrough contract)

### 4.1 Transport

- Upstream call is ALWAYS `Accept: text/event-stream` with body `"stream": true` (recorded wire note; `ref:internal/runtime/executor/codex_executor_stream.go`).
- Downstream SSE response headers (committed only after the first complete upstream data frame — §4.4): `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`, `Access-Control-Allow-Origin: *`, plus filtered upstream headers (§4.5).
- Heartbeat comments `: keep-alive` are injected only when `streaming.keep-alive-seconds > 0` (default 0 = off; `ref:sdk/api/handlers/handlers.go` — `defaultStreamingKeepAliveSeconds = 0`).

### 4.2 Event-by-event fidelity

- Each upstream line is forwarded as one downstream chunk. `data:`-lines are re-prefixed as `data: <payload>` (single space; a mock sending `data:{...}` is normalized to `data: {...}`). Non-data lines (`event:`, comments, ids) pass through byte-identical (`ref:internal/translator/codex/openai/responses/codex_openai-responses_response.go` — `ConvertCodexResponseToOpenAIResponses`; `ref:internal/runtime/executor/codex_executor_stream.go`).
- Downstream framing: every complete frame is emitted with a `\n\n` terminator (upstream `\r\n\r\n` accepted, re-emitted `\n\n`-terminated; blank upstream separator lines are not forwarded as separate chunks). A comment or `event:` line arriving without its data line is held and glued (with `\n`) onto the following frame. `ref:sdk/api/handlers/openai/openai_responses_handlers.go` — `responsesSSEFramer`, `writeResponsesSSEChunk`.
- `event:` names are PRESERVED (recorded wire note: "codex SSE->Responses-client passthrough preserves event: names"). Data payload JSON bytes are preserved EXCEPT the §4.3 model injection, the §4.6 patch, and §5 error synthesis. Splitting a payload across TCP chunk boundaries upstream must not change downstream bytes.
- `data: [DONE]` is not synthesized by the gateway. If the upstream sends it, it is forwarded verbatim as a data line (it is NOT a terminal event; the stream still needs `response.completed`/`response.incomplete`/error or the §5.3 close-error fires).
- Terminal success events: `response.completed`, `response.incomplete`, `response.done` — after forwarding the terminal frame the stream CLOSES (no further upstream data forwarded) and the gateway appends one final `\n` byte (`ref:sdk/api/handlers/openai/openai_responses_handlers.go` — `WriteDone`).
- A terminal event with zero output (`response.incomplete` with no output items, no non-empty deltas, and `response.usage.output_tokens == 0` exactly) is converted to a 502-class in-stream failure instead of success (`ref:internal/runtime/executor/helps/codex_terminal_incomplete.go`). OPTIONAL edge; not goldened.

### 4.3 Model echo

- In `response.created` and `response.in_progress` events: if `response.model` is absent, the gateway injects `response.model = <client-requested model>` (the alias, not the upstream name). If present, it is preserved (`ref:internal/translator/codex/openai/responses/codex_openai-responses_response.go` — `setResponsesModel`; model source = original client body, `ref:internal/translator/common/request.go` — `RequestModelName`).
- With `force-mapping: true`, model fields (`model`, `modelVersion`, `response.model`, `response.modelVersion`, `message.model`) in EVERY data payload are rewritten to the configured alias, overriding upstream values (`ref:sdk/cliproxy/auth/response_model_rewriter.go`; wired in `ref:sdk/cliproxy/auth/conductor_stream.go`).
- The NON-STREAM path never injects a model: the client receives the upstream `response` object with whatever `model` field the upstream set (absent stays absent) (`ref:internal/translator/codex/openai/responses/codex_openai-responses_response.go` — `ConvertCodexResponseToOpenAIResponsesNonStream`).

### 4.4 First-frame gating (error-vs-SSE decision)

The gateway buffers upstream frames until the FIRST complete `data:` frame is seen (`ref:sdk/api/handlers/openai/openai_responses_handlers.go` — `handleStreamingResponse` first-frame loop):
- If an error arrives BEFORE any data frame: the client gets a plain JSON error response (same shapes as non-stream; §5.1) — NOT an SSE stream.
- Once the first data frame is forwarded, headers are committed 200/SSE and all later failures are delivered in-stream (§5.2–§5.3).

### 4.5 Downstream header filtering

Upstream response headers are copied downstream minus: hop-by-hop (`Connection`, `Keep-Alive`, `Proxy-Authenticate`, `Proxy-Authorization`, `Te`, `Trailer`, `Transfer-Encoding`, `Upgrade`), `Set-Cookie`, `Content-Length`, `Content-Encoding`, CPA-reserved CORS headers, gateway-proxy prefixes (`x-litellm-`, `helicone-`, `x-portkey-`, `cf-aig-`, `x-kong-`, `x-bt-`), and headers named in the upstream `Connection` header. Headers already set by the gateway are not overwritten (`ref:sdk/api/handlers/header_filter.go` — `FilterUpstreamHeaders`, `WriteUpstreamHeaders`).

### 4.6 Terminal output repair

For non-Lite clients, if a terminal event's `response.output` is missing or empty while `response.output_item.done` events were seen, the gateway RECONSTRUCTS `response.output` from the recorded items (sorted by `output_index`, unindexed items appended in order). Also fills missing item `id`s in an existing non-empty `response.output` from the matching `output_item.done` items. Applies on BOTH stream and non-stream paths; the client-side framer repeats the same repair defensively (`ref:internal/runtime/executor/codex_executor_terminal.go` — `patchCodexCompletedOutput`; `ref:sdk/api/handlers/openai/openai_responses_handlers.go` — `repairCompletedPayload`). For native Lite clients the executor-side patch is skipped (client-side repair still applies).

### 4.7 Non-stream aggregation

Client requests without `"stream": true` still stream from upstream; the gateway aggregates (`ref:internal/runtime/executor/codex_executor_execute.go` — `Execute`):
- Reads the upstream SSE until the first `response.completed`/`response.incomplete` data frame; collects `response.output_item.done` items; applies §4.6; returns the `response` object of that terminal event as the entire downstream JSON body.
- Downstream: 200, `Content-Type: application/json`, body = that `response` object.
- Usage defaulting: `response.usage` (and `usage`) objects get missing `output_tokens_details.reasoning_tokens: 0` and `input_tokens_details.cached_tokens: 0` injected (`ref:internal/runtime/executor/helps/responses_usage_helpers.go` — `EnsureResponsesUsageDetails`).
- If the upstream stream carries no terminal event, the request fails with the §5.3 incomplete-stream error (JSON, since no data frame reached the client).

## 5. Error semantics

### 5.1 Upstream HTTP-level errors (status 4xx/5xx on the upstream call; no data frames forwarded)

The upstream status + body become the downstream status + body via the status-error mapping (`ref:internal/runtime/executor/codex_executor_terminal.go` — `newCodexStatusErrWithCooling`, `codexStatusErrorClassification`; `ref:sdk/api/handlers/handlers_errors.go` — `WriteErrorResponse`, `BuildErrorResponseBodyWithError`):

| Upstream | Downstream status | Downstream body |
|---|---|---|
| 401 (any body) | 401 | REWRITTEN: `{"error":{"message":<upstream error.message or body text>,"type":"authentication_error","code":"auth_unavailable"}}` |
| Body with `error.code`/`code` in {`context_length_exceeded`, `context_too_large`} or context-length message, or HTTP 413 | same/413->as-is | REWRITTEN: `{"error":{"message":<msg>,"type":"invalid_request_error","code":"context_too_large"}}` |
| Body matching `invalid signature in thinking block` / `invalid_encrypted_content` | upstream status | REWRITTEN: `{"error":{"message":<msg>,"type":"invalid_request_error","code":"thinking_signature_invalid"}}` |
| Body matching `previous_response_not_found` | upstream status | REWRITTEN: `{"error":{"message":<msg>,"type":"invalid_request_error","code":"previous_response_not_found"}}` |
| `error.type == "usage_limit_reached"` OR `model ... at capacity` message | 429 (remapped from any status) | body VERBATIM |
| Everything else (incl. 404 `model_not_found`, 500, 503) | upstream status | body VERBATIM (byte-identical; recorded: "429 body+status passes downstream VERBATIM") |

- Valid-JSON upstream bodies pass through byte-identical; non-JSON bodies are wrapped: `{"error":{"message":<raw text>,"type":<invalid_request_error|server_error>,"code":<per status, omitempty>}}`.
- These responses are plain JSON (never SSE) because no data frame was forwarded (§4.4).
- Credential side effects (cooldown policy) are S4 scope, but two RECORDED FACTS are observable through this route and pinned by goldens:
  - An upstream 429 puts the credential into a rate-limit cooldown (~1s reset) that `transient-error-cooldown-seconds: -1` does NOT disable; an immediate repeat during the window returns the selection error `{"error":{"code":"model_cooldown","last_upstream_error":"<verbatim upstream body>","message":"All credentials for model <m> are cooling down via provider <p> (last error: ...)"}}` with NO upstream call — pinned by fixture S2d9-12.
  - An upstream 404 `model_not_found` ALSO puts the credential into a cooldown that survives `transient-error-cooldown-seconds: -1` and outlives multi-second waits (recorded worker-1, 2026-09-16: subsequent requests returned 503 cooldown-family errors with zero upstream calls until restart). Exact status/body/duration to be pinned by the re-recorded error cases; duration policy is S4.

### 5.2 In-stream terminal failures (upstream sends an error frame inside HTTP 200 SSE)

An upstream `data:` payload with `type == "error"` (with `error`/`code`/`message` details) or `type == "response.failed"` is a terminal failure (`ref:internal/runtime/executor/codex_executor_terminal.go` — `codexTerminalFailureBody`). The error frame itself is NOT forwarded. After the already-forwarded frames, the gateway appends ONE synthesized failure frame and closes:

- Plain clients (default curl UA): `event: error` + `data: {"type":"error","error":{...},"sequence_number":N}`.
- Codex-flavored clients (User-Agent matched as Codex client, or `Originator` == `codex desktop`/`codex-tui`/`codex_cli_rs`, optionally versioned): `event: response.failed` + `data: {"type":"response.failed","sequence_number":N,"response":{"status":"failed","error":{...}}}` (`ref:sdk/api/handlers/openai/openai_responses_handlers.go` — `isCodexResponsesClientRequest`, `BuildOpenAIResponsesStreamFailedChunk`).
- The `error` detail object: if the upstream error body was a JSON object with an `error` (or `response.error`) object, that object is sanitized (secret-ish keys redacted `[REDACTED]`, strings truncated at 2048 runes) and used verbatim as the detail; otherwise `{type, code, message, param}` is synthesized from the mapped status (401->invalid_api_key, 403->insufficient_quota, 429->rate_limit_exceeded, 404->model_not_found, 408->request_timeout, >=500->internal_server_error, other 4xx->invalid_request_error; type server_error for >=500 else invalid_request_error) (`ref:sdk/api/handlers/openai_responses_stream_error.go`; sanitizers in `openai_responses_handlers.go`).
- `sequence_number`: taken from the upstream error payload when it carried one; else N = number of data frames already forwarded.
- Downstream HTTP status stays 200 (headers already committed).
- Status mapping for the synthesized detail follows `ref:internal/runtime/executor/codex_executor_terminal.go` — `codexTerminalFailureStatus` (auth->401, not-found/model_not_found->404, permission->403, rate-limit->429, invalid_request->400, usage-limit/capacity->429, default->502).
- If the error frame is the FIRST data frame, §4.4 applies: no SSE headers; client gets the §5.1 JSON error shape instead.

### 5.3 Upstream stream cut / no terminal event

- Upstream closes (cleanly or abruptly) before a terminal success event: gateway emits the §5.2 synthesized failure frame with status 408 (`request_timeout`) and message `stream error: stream disconnected before completion: stream closed before response.completed` (`ref:internal/runtime/executor/codex_executor_terminal.go` — `codexIncompleteStreamMessage`, `newCodexIncompleteStreamError`). Downstream HTTP stays 200 if any frame was forwarded (recorded: "disconnect-mid-stream => client HTTP stays 200 with in-stream error"); if NO data frame was forwarded, §4.4 yields a plain JSON 408 error response.
- EXACT payload text for the Responses client is pinned by fixture S2d9-08 (a recorded `unexpected EOF`-shaped error exists on the OpenAI-chat-client flavor of this scenario; per SPEC §0 precedence the S2d9 fixture settles the Responses-client bytes).
- Upstream ends without terminal AND without any data frame: JSON 408, body `{"error":{"message":"stream error: stream disconnected before completion: stream closed before response.completed","type":"invalid_request_error"}}`.

### 5.4 Request-fault errors before any upstream call

- `POST /v1/responses/compact` with `"stream": true`: 400 `{"error":{"message":"Streaming not supported for compact responses","type":"invalid_request_error"}}` — NO upstream request is emitted (`ref:sdk/api/handlers/openai/openai_responses_handlers.go` — `Compact`).
- Unknown model: 400 `model_not_found` shape (recorded, BOOTSTRAP §4).
- Body read failure: 400 `{"error":{"message":"Invalid request: <err>","type":"invalid_request_error"}}`.

## 6. `/responses/compact` passthrough

- Request: near-verbatim (NO codex translator runs): `stream` deleted, `model` rewritten per §3.2, `instructions` defaulted per §3.2 when absent, reasoning-item sanitization (§3.2) applied; NO `store` forcing, NO `include` forcing, NO `previous_response_id` deletion, NO tool injection (`ref:internal/runtime/executor/codex_executor_execute.go` — `executeCompact`: target format `openai-response`, i.e. registry passthrough).
- Upstream: `POST {base-url}/responses/compact`, `Accept: application/json`, non-SSE.
- Response: 200, `Content-Type: application/json`, upstream body VERBATIM. Usage-detail defaulting (§4.7) is SKIPPED for bodies whose `object == "response.compaction"` (`ref:internal/runtime/executor/helps/responses_usage_helpers.go`).

## 7. Usage accounting

- Token usage is parsed from the terminal event's `response.usage` (`input_tokens`/`output_tokens`/`total_tokens` plus `*_details`) and published to the usage pipeline keyed by provider `codex`, model = resolved upstream model, auth = the API-key credential (`ref:internal/runtime/executor/helps/usage_helpers.go` — `ParseCodexUsage`; `ref:internal/runtime/executor/codex_executor_stream.go` — terminal `reporter.Publish`). Empty-usage terminals still publish a zero/default record (`EnsurePublished`).
- TTFT observation marks on the first substantive token event (`response.output_text.delta`, `response.reasoning_text.delta`, `response.reasoning_summary_text.delta`, `response.function_call_arguments.delta` with non-empty delta) (`ref:internal/runtime/executor/helps/codex_terminal_incomplete.go` — `HasMeaningfulCodexOutputDelta`; `observeCodexTokenEvent`).
- Client-observable usage surface: the forwarded terminal event bytes (verbatim) + the §4.7 non-stream usage defaulting. Queue persistence/stats: S6.
- Failure requests publish failure records (no token accounting).

## 8. Golden-sample index

Recorded by the assigned oracle worker against `eceasy/cli-proxy-api:v7.3.4` (digest sha256:97825da3...) with the §3.4 config fragment (worker-5: mock port 23001, reference port 8417). Layout per BOOTSTRAP §7 (`meta.yaml`, `request.http`, `downstream.md`, `upstream.jsonl`, `mock-response.json`).

Recording status (worker-1 full run 2026-09-16, reconciliation in flight with worker-5): S2d9-01..08, 10, 13, 14, 15, 16 CONFIRMED matching this section's contracts (10 = 404 verbatim; 13/14 synthesized terminal frames as specified; 16 = 400, zero upstream calls). S2d9-09, 11, 12 recorded but POLLUTED by the §5.1 404-cooldown (they captured 503 selection errors, not the scripted upstream errors) — re-recording with container isolation. S2d9-17 returned 408 instead of 200 (see open question 6) — under investigation. (`meta.yaml`, `request.http`, `downstream.md`, `upstream.jsonl`, `mock-response.json`).

| case | fixture dir | scenario | mock mode |
|---|---|---|---|
| S2d9-01 | tests/fixtures/S2d9/S2d9-01-minimal-nonstream/ | minimal non-stream: default rewrites, SSE-forced upstream, aggregation, output repair, usage defaulting | happy |
| S2d9-02 | tests/fixtures/S2d9/S2d9-02-minimal-stream/ | minimal stream: event fidelity, framing, model echo injection | happy |
| S2d9-03 | tests/fixtures/S2d9/S2d9-03-force-mapping/ | force-mapping alias rewrite in all frames | happy |
| S2d9-04 | tests/fixtures/S2d9/S2d9-04-tools-roles/ | tools + system->developer + web_search alias + tool injection | happy |
| S2d9-05 | tests/fixtures/S2d9/S2d9-05-reasoning/ | reasoning passthrough, encrypted_content valid/invalid, orphan id strip | happy |
| S2d9-06 | tests/fixtures/S2d9/S2d9-06-store-fields/ | store=false forcing, dropped fields, prompt_cache_key/Session-Id | happy |
| S2d9-07 | tests/fixtures/S2d9/S2d9-07-native-lite/ | Lite dialect: instructions kept, parallel_tool_calls=false, no tool injection | happy |
| S2d9-08 | tests/fixtures/S2d9/S2d9-08-disconnect-midstream/ | upstream cut before terminal: 200 + synthesized in-stream failure | disconnect-mid-stream |
| S2d9-09 | tests/fixtures/S2d9/S2d9-09-upstream-401/ | HTTP 401 classified error, JSON not SSE | upstream-error |
| S2d9-10 | tests/fixtures/S2d9/S2d9-10-upstream-404/ | HTTP 404 model_not_found verbatim passthrough | upstream-error |
| S2d9-11 | tests/fixtures/S2d9/S2d9-11-upstream-429/ | HTTP 429 usage_limit_reached verbatim passthrough | upstream-error |
| S2d9-12 | tests/fixtures/S2d9/S2d9-12-cooldown-after-429/ | immediate repeat -> model_cooldown selection error, no upstream call | upstream-error (sequenced) |
| S2d9-13 | tests/fixtures/S2d9/S2d9-13-instream-error-plain/ | in-stream error frame via /backend-api/codex/responses alias, plain client -> event: error | upstream-error (in-stream) |
| S2d9-14 | tests/fixtures/S2d9/S2d9-14-instream-error-codex-client/ | codex_cli_rs Originator -> event: response.failed | upstream-error (in-stream) |
| S2d9-15 | tests/fixtures/S2d9/S2d9-15-compact-happy/ | compact passthrough, response.compaction body verbatim | happy |
| S2d9-16 | tests/fixtures/S2d9/S2d9-16-compact-stream-rejected/ | compact stream:true -> 400, no upstream call | none |
| S2d9-17 | tests/fixtures/S2d9/S2d9-17-slow-chunks/ | delayed/split/comment/no-space frames reassembled faithfully | slow-chunks |

FIXTURE-DEFERRED (CREDENTIALED-ONLY, per R-FIXTURE — specified, not recorded):
- D1: `codex-api-key` WITHOUT `base-url` -> upstream target `https://chatgpt.com/backend-api/codex/responses` (real ChatGPT backend; needs a live account). Only the URL differs from B1 by construction (`ref:internal/runtime/executor/codex_executor_auth.go` — default baseURL).
- D2: OAuth Codex credential flavor: `Authorization: Bearer <access_token>`, `Chatgpt-Account-Id` header, token refresh — CREDENTIALED-ONLY.

## 9. Open questions and intentional non-equivalences

1. Retry-After propagation: upstream 429 `usage_limit_reached` bodies carry `resets_at`/`resets_in_seconds` that the executor parses (`ref:internal/runtime/executor/codex_executor_terminal.go` — `parseCodexRetryAfter`), but the S2d9-11 recording did not surface a downstream `Retry-After` header. Whether one is emitted outside Home mode is unresolved; parked with S4 (scheduling). No S2d9 "must" depends on it.
2. Disconnect error payload: the S2d5-family recording shows `{"message":"unexpected EOF","type":"server_error","code":"internal_server_error"}` for an OpenAI-chat client; the derived Responses-client contract (§5.3) says 408/`request_timeout`. S2d9-08 pins the actual bytes; if they diverge from §5.3 the fixture wins and this section must be amended at gate time.
3. Cooldown interplay: the 429 rate-limit cooldown (~1s) is not disabled by `transient-error-cooldown-seconds: -1` (recorded). Exact window and reset source are S4 scope; S2d9-12 pins only the observable selection error.
4. Intentional non-equivalence: none for B1–B4 within the recorded envelope. Behaviors intentionally NOT mirrored unless separately specified: websocket GET routes, `/v1/alpha/search`, identity-confuse (`codex.identity-confuse`, default off), multi-agent-v2 rewrites (`codex.optimize-multi-agent-v2`, default off), bootstrap stream buffering (`codex.stream-bootstrap-buffering`, default false) — all OPTIONAL and config-gated off in the golden envelope.
5. `service_tier: "priority"` is the only value forwarded (§3.2); other tiers are dropped without error. Recorded? No — source-derived; S2d9-06 does not exercise it. Marked OPTIONAL pending a future golden.
6. S2d9-17 (slow/split upstream writes): worker-1's recording returned HTTP 408 even though the mock wrote the documented byte sequence exactly (300ms/150ms pacing, comment line, split data payload). Unresolved whether the reference enforces an upstream trickle/stall policy (which would need a measured threshold and a spec rule) or the 408 came from an SSE-reader interaction with the specific write pattern. Worker-5 is re-investigating with paced variants; the final fixture decides whether §4.2 gains a stall-timeout rule or the original 200-expectation stands.
