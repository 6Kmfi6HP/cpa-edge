# S2d5 — OpenAI Chat Completions client → Codex/Responses upstream

Section id: S2d5. Module: `packages/translators` (openai-chat → codex direction pair) + `packages/executors` (codex executor semantics).
Upstream anchor: CLIProxyAPI v7.3.4, commit `8335eac731946bd4eff18f500653f93736df53d6` (see SPEC.md §0).
Upstream evidence paths in this section are relative to the upstream repo root unless prefixed `_cpa_edge_ref/` (oracle sandbox artifacts).
Oracle-recorded facts (WIRE NOTES in the mission brief, `_cpa_edge_ref/probes/mocks/codex/`, `_cpa_edge_ref/probes/mocks/README.md`) outrank static reading; where they conflict with source-derived statements, the recorded fact wins and is marked [RECORDED].

Classification (R-FIXTURE, SPEC.md §5): client OpenAI chat → `codex-api-key` upstream is **RECORDABLE-LOCALLY**. Codex OAuth (fixed `https://chatgpt.com/backend-api/codex`, account headers, token refresh) is CREDENTIALED-ONLY; those behaviors are FIXTURE-DEFERRED (details in §6, question 9 in §7).

---

## 1. Scope and boundaries

IN scope:
- `POST /v1/chat/completions` requests whose `model` resolves to a `codex-api-key` credential (with `base-url` override; mock-fleet goldens use `http://…:19003`).
- Request translation: OpenAI Chat Completions JSON → OpenAI Responses-API ("codex") JSON, field by field.
- Upstream HTTP contract: method, path, headers (auth, cloaking, session identity, client-header whitelist), body field order.
- Upstream is ALWAYS requested as SSE (`stream:true` body + `Accept: text/event-stream`) regardless of the client `stream` flag; non-stream clients receive an aggregated response. [RECORDED: `_cpa_edge_ref/probes/mocks/codex/upstream.jsonl` — the non-stream `/v1/responses` probe still emitted `"stream":true` + `Accept: text/event-stream`; identical executor code serves chat clients.]
- Response translation: Responses `response.completed`/`response.incomplete` JSON → `chat.completion` (non-stream); Responses SSE events → `chat.completion.chunk` SSE frames (stream), including tool calls, reasoning deltas, images, usage, service tier, finish reasons.
- Error semantics client-visible on this route for this provider: upstream non-2xx passthrough, in-stream terminal failures, empty-incomplete, disconnect/incomplete-stream, model resolution failure, rate-limit cooldown shape (cross-ref S4).
- Session/prompt-cache identity: `prompt_cache_key` body field + `Session-Id` header.
- Tool name shortening (request side) and restoration (response side).

OUT of scope (owned elsewhere):
- Route inventory, auth middleware, CORS, 404/405 semantics (R-404) — S1.
- Responses-client passthrough (`/v1/responses`) — S2d9; `/responses/compact`; websocket transport (`websockets: true`); `/v1/images/*` via codex; alpha search; live/realtime.
- Scheduling, rotation, cooldown timers, request-retry — S4. Only the client-visible cooldown error shape is restated here.
- Codex OAuth credential lifecycle (chatgpt.com default URL when `base-url` empty, `Chatgpt-Account-Id` header, token refresh) — S3; FIXTURE-DEFERRED for goldens (§6).
- Management API surface for `codex-api-key` lists — S5.
- Usage statistics recording/reporting — S6.
- OPTIONAL config-gated behaviors documented but NOT goldened (see §7): identity-confuse, Responses-Lite header, `disable-image-generation`, `disable-codex-cloaking`, model-header overrides, prompt-cache header forwarding, per-model payload overrides, thinking-suffix model names, codex MultiAgentV2 request rewriting (`codex.optimize-multi-agent-v2`, config + client-UA gated; evidence `helps.OptimizeCodexMultiAgentV2RequestForAuth`). The reasoning-replay cache is Claude-CLIENT-only (`codexReasoningReplayEnabledForSource` requires `FormatClaude`) — inert for OpenAI chat clients on this route. The grok keepalive SSE transform (`grokbuild.TransformKeepaliveSSELine`) is client-UA-gated for grok-build clients and out of scope.

---

## 2. Behavior inventory

### 2.1 Route and model resolution

- Route: `POST /v1/chat/completions` (evidence: `internal/api/server_routes.go`).
- The client `model` (e.g. alias `cx`) is resolved by the auth manager to the configured upstream model (e.g. `gpt-mock-codex`) before the executor runs; the translator receives the RESOLVED model name, never the alias (evidence: `sdk/api/handlers/handlers_execution.go` `executeWithAuthManagerFormats` — `req.Model = normalizedModel`; executor `helps.SetStringIfDifferent(body, "model", baseModel)`; recorded `upstream.jsonl` shows `model: gpt-mock-codex` for alias `cx` requests).
- Unknown model → HTTP 400 `{"error":{"message":"unknown provider for model <m>","type":"invalid_request_error","code":"model_not_found","param":"model"}}` [RECORDED: bootstrap probe; golden S2D5-20].
- If the request body has no `messages` array but has `input` or `instructions`, the handler treats it as a Responses-format payload and converts it first (evidence: `sdk/api/handlers/openai/openai_handlers.go` `shouldTreatAsResponsesFormat`) — S2d9-adjacent quirk; not goldened here.

### 2.2 Upstream request

MUST:
- Method `POST`, URL `strings.TrimSuffix(baseURL,"/") + "/responses"`. Default `baseURL` when a `codex-api-key` entry omits `base-url`: `https://chatgpt.com/backend-api/codex` (evidence: `internal/runtime/executor/codex_executor_execute.go`).
- Headers (exact, default config; evidence: `internal/runtime/executor/codex_executor_request.go` `applyCodexHeadersFromSources` + `applyCodexCloakingHeaders`; [RECORDED `_cpa_edge_ref/probes/mocks/codex/upstream.jsonl`]):

| Header | Value |
|---|---|
| `Content-Type` | `application/json` |
| `Authorization` | `Bearer <codex-api-key entry api-key>` |
| `User-Agent` | `codex-tui/0.154.0 (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; 0.154.0)` (cloaking default ON; `codex.disable-codex-cloaking: true` is OPTIONAL behavior) |
| `Originator` | `codex-tui` |
| `Session-Id` | the request session UUID (§2.9) |
| `Accept` | `text/event-stream` (ALWAYS — both client stream and non-stream) [RECORDED] |
| `Connection` | `Keep-Alive` |
| Transport-added (not gateway semantics) | `Host`, `Content-Length`, `Accept-Encoding: gzip` |

- Client→upstream header forwarding whitelist — the ONLY client headers that reach the codex upstream (all optional; absent unless the client sends them; evidence `misc.EnsureHeader` calls + `X-Codex-Beta-Features`):
  `X-Codex-Beta-Features`, `Version`, `X-Codex-Turn-Metadata`, `X-Codex-Turn-State`, `X-Client-Request-Id`, `X-Codex-Window-Id`, `Thread-Id`, `Session-Id` (overrides the derived value), `X-Openai-Internal-Codex-Responses-Lite`, `Originator`. Everything else (client `User-Agent`, `Accept`, `Content-Type`, cookies, arbitrary headers) is NOT forwarded.
- Header application ORDER (evidence `applyCodexHeadersFromSources`): fixed headers → client whitelist → per-credential `headers` config attrs → **cloaking LAST**. With cloaking ON (default) `User-Agent` and `Originator` are overridden UNCONDITIONALLY to the codex-tui values, so a client-supplied `Originator`/`User-Agent` survives ONLY when `codex.disable-codex-cloaking: true` (then a non-empty client `Originator` passes verbatim; golden coverage of the disable path is OPTIONAL).
- Extra fixed headers from the `codex-api-key` entry `headers` map are applied last and may override (OPTIONAL config; evidence `util.ApplyCustomHeadersFromAttrs`). `Chatgpt-Account-Id` is set ONLY for OAuth credentials, never for `codex-api-key` (FIXTURE-DEFERRED; evidence `applyCodexHeadersFromSources`).

### 2.3 Upstream body construction

The translator builds the body in a FIXED field order (sjson append semantics; evidence: `internal/translator/codex/openai/chat-completions/codex_openai_request.go`, then executor mutations in `codex_executor_execute.go` / `codex_executor_stream.go`). Canonical order:

`instructions, stream, [reasoning — see below], parallel_tool_calls, include, model, input, [text], [tools], [tool_choice], store, [prompt_cache_key]`

Position notes (all [RECORDED]): when the client sends no `tools`, the injected image-generation tool CREATES the `tools` key AFTER `store` (recorded order: `…, input, store, tools, prompt_cache_key`); when the client sends tools, the injected tool is appended INSIDE the array as the LAST element and the `tools` key keeps its translator position (before `tool_choice`/`store`; recorded order: `…, input, tools, tool_choice, store, prompt_cache_key`).

MUST rules, field by field:
- `instructions`: ALWAYS `""` (system messages do NOT populate it; evidence: translator template `{"instructions":""}` and the commented-out extraction; `normalizeCodexInstructions` only guarantees presence).
- `stream`: ALWAYS `true` upstream, regardless of the client `stream` flag [RECORDED]. The non-stream executor path forces it after translation; the stream path translates with `stream=true`.
- `reasoning`: **[RECORDED] ABSENT from the upstream body in every recorded case** — the client's `reasoning_effort` (including explicit `high`/`none`) does NOT reach the codex upstream when the resolved model has NO thinking capability. This is the DEFAULT for codex-api-key models declared in config `models[]` whose name is not a known catalog model and whose entry has no `thinking` support: the capability resolver marks API-key models `UserDefined=false` with `Thinking=nil` (`sdk/cliproxy/auth/api_key_model_capabilities.go` `addConfiguredModelCapability` + `internal/modelconfig/model_info.go` `ResolveModelInfo`), and the thinking pipeline then strips the whole `reasoning` object via `StripThinkingConfig` (`internal/thinking/apply.go` modelInfo.Thinking==nil branch → `internal/thinking/strip.go` case `codex`). Goldens S2D5-01/02/04/05/09 pin the strip.
  - Internal two-phase construction (before the strip): the translator always sets `reasoning.effort` = client `reasoning_effort` verbatim (`"medium"` when absent, `""` when empty), and the summary pipeline adds `reasoning.summary:"auto"` for non-empty non-`"none"` efforts (evidence: translator + `internal/thinking/summary.go`). This phase is client-invisible for capability-less models — it matters only when the model HAS thinking capability.
  - Capability-ON variant (model name matches the catalog, e.g. `gpt-5-codex`, or the models[] entry declares `thinking` support): `reasoning.effort` passes through as above (source-derived; NOT pinned by S2d5 goldens — the mock model has no capability). Model-name thinking suffixes (e.g. `gpt-5-codex(high)`) are OPTIONAL (config-dependent).
- `parallel_tool_calls`: ALWAYS `true` after translation. It is REMOVED only when the final `tools` array is empty — with default config that never happens because image-generation is injected (below). Evidence: `normalizeCodexParallelToolCalls`.
- `include`: ALWAYS `["reasoning.encrypted_content"]`. [RECORDED]
- `model`: the RESOLVED upstream model name.
- `input`: array (§3.1).
- `text`: present only when the client sent `response_format` or `text.verbosity` (§3.3).
- `tools`: translated client tools (§3.2) PLUS, under default config, `{"type":"image_generation","output_format":"png"}` appended as the LAST array element whenever the request does not already declare an image tool and the resolved model does not end with `spark` [RECORDED — wire log shows the injected tool on every request]. Controlled by `disable-image-generation` (OPTIONAL).
- `tool_choice`: mapped when present (§3.2).
- `store`: ALWAYS `false`. [RECORDED]
- `prompt_cache_key`: session identity UUID (§2.9), appended last. [RECORDED]
- DELETED unconditionally after translation (no-ops for chat input, but the rewrite must not emit them): `previous_response_id`, `generate`, `prompt_cache_retention`, `safety_identifier`, `stream_options` (the `stream_options.reasoning_summary_delivery` re-injection only concerns Responses clients; chat requests never carry it).
- DROPPED client fields (never forwarded, no upstream key): `temperature`, `top_p`, `top_k`, `max_tokens`, `max_completion_tokens`, `n`, `stop`, `seed`, `logprobs`, `top_logprobs`, `presence_penalty`, `frequency_penalty`, `user`, `metadata`, `modalities`, `prediction`, `web_search_options`, `stream_options`, client `parallel_tool_calls` (the output value is unconditional), client `store`, `service_tier` (downstream-only; see §2.7), `audio`. (Evidence: translator — these keys are simply never read; commented-out mapping blocks for temperature/top_p/max_tokens.)

### 2.4 Always-SSE upstream + aggregation (non-stream clients)

MUST:
- The upstream request is identical for stream and non-stream clients (same body incl. `stream:true`, same `Accept: text/event-stream`). [RECORDED]
- Non-stream aggregation (evidence `codex_executor_execute.go` `Execute`): read the ENTIRE upstream body; split on `\n`; process only lines with the `data:` prefix:
  1. track whether any meaningful output delta was seen (`response.output_text.delta` / `response.reasoning_text.delta` / `response.reasoning_summary_text.delta` / `response.function_call_arguments.delta` with non-blank `delta`);
  2. terminal failure events (`error`, `response.failed`) → error (§5);
  3. `response.output_item.done` events → collect `item` keyed by `output_index` (fallback list when absent);
  4. on `response.completed` / `response.incomplete`: empty-incomplete check (§5), usage capture, then PATCH: if `response.output` is missing/empty and items were collected, replace `response.output` with the collected items sorted by `output_index` (collected-without-index items appended after); if `response.output` is non-empty, only hydrate missing item `id`s from collected items at the same index (evidence `patchCodexCompletedOutput`, `hydrateCodexCompletedOutputItemIDs`); then translate to a single `chat.completion` (§2.5). Golden S2D5-12 pins the empty-output patch.
  5. no terminal event seen → error (§5 incomplete-stream).

### 2.5 Non-stream response mapping (`chat.completion`)

MUST (evidence: `ConvertCodexResponseToOpenAINonStream`):
- Template and EXACT field order:
  `{"id":"<response.id>","object":"chat.completion","created":<response.created_at>,"model":"<response.model>","choices":[{"index":0,"message":{"role":"assistant","content":…,"reasoning_content":…,"tool_calls":…},"finish_reason":…,"native_finish_reason":…}],"service_tier"?,"usage"?,"choices message images"?}`
  Concretely: top-level keys in order `id, object, created, model, choices`; `service_tier` (only if upstream sent one) appended after `choices`; `usage` appended last. Inside `choices[0].message`: `role, content, reasoning_content, tool_calls` (template order), `images` appended after `tool_calls` when images exist. `created` falls back to gateway wall-clock only when upstream omitted `created_at` (dynamic; goldens avoid this).
- `id` = upstream `response.id`; `model` = upstream `response.model` (the UPSTREAM name, not the alias); `created` = upstream `response.created_at` (unix seconds).
- `message.content`: concatenated `text` of the FIRST `output_text` part of EACH `message` output item (only the first content part per item is taken). Stays JSON `null` when nothing was produced.
- `message.reasoning_content`: from EACH `reasoning` output item — the FIRST `summary_text` entry of `summary`, plus EVERY `reasoning_text` entry of `content`, concatenated. `null` when absent.
- `message.tool_calls`: for EACH output item of type `function_call` or `custom_tool_call`: `{"id":"<call_id>","type":"function","function":{"name":"<restored name>","arguments":"<arguments or input>"}}` (custom tool calls use the `input` field as arguments; both are typed `"function"` downstream). Absent (`null`) when none.
- `message.images`: for EACH `image_generation_call` output item with non-empty `result`: `{"index":<n>,"type":"image_url","image_url":{"url":"data:<mime>;base64,<result>"}}` where `<n>` is a sequential counter across the aggregated images (stream chunks use `index:0` always — see §2.6), and `<mime>` derives from `output_format` (`png`→`image/png`, `jpg`/`jpeg`→`image/jpeg`, `webp`→`image/webp`, `gif`→`image/gif`, values containing `/` pass verbatim, empty/unknown → `image/png`).
- `finish_reason` / `native_finish_reason` (§2.8). `service_tier` = upstream `response.service_tier` (trimmed, non-empty only).
- The response body is written with `Content-Type: application/json` and NO upstream headers forwarded (default `passthrough-headers: false` → `downstreamHeadersFromExecutor` returns nil; evidence `sdk/api/handlers/handlers_interceptors.go`). Downstream headers are only the shared block (S1): CORS, `X-Cpa-Trace-Id`, `Date`, `Content-Type`, `Content-Length`.

### 2.6 Stream mapping (SSE)

MUST (evidence: `sdk/api/handlers/openai/openai_handlers.go` `handleStreamingResponse`/`handleStreamResult`, `sdk/api/handlers/stream_forwarder.go` `ForwardStream`, and `ConvertCodexResponseToOpenAI`):
- Downstream headers on first payload: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`, `Access-Control-Allow-Origin: *` (+ shared block; HTTP 200). No upstream headers forwarded (default).
- Every translated chunk is framed `data: <chunk-json>\n\n`. The stream terminates with `data: [DONE]\n\n` when the upstream terminal event was reached without error. Keep-alive heartbeats are OFF by default (`streaming.keep-alive-seconds` 0; OPTIONAL when configured, comment frames `: keep-alive\n\n`).
- Chunk template and EXACT field order:
  `{"id":…,"object":"chat.completion.chunk","created":…,"model":…,"choices":[{"index":0,"delta":…,"finish_reason":…,"native_finish_reason":…}],"service_tier"?,"usage"?}`
  (`service_tier` then `usage` appended after `choices` when present.)
- State initialized from `response.created` (emits NO chunk): `id` ← `response.id`, `created` ← `response.created_at`, `model` ← `response.model`. BEFORE any `response.created` event, chunks carry `id:""`, `created:0`, `model:<resolved model name>`. After it, `model` is the upstream-echoed name.
- `service_tier` latches from the first event whose `response.service_tier` is a non-empty string (typically `response.created`); once latched, EVERY subsequent chunk carries it.
- Event table (only `data:` lines are processed; `event:`/`id:`/blank lines emit nothing; unknown event types emit nothing):

| Upstream event | Downstream chunk(s) |
|---|---|
| `response.created` | none (state capture only) |
| `response.in_progress`, `response.output_item.added` (message type), `response.content_part.added/done`, `response.output_text.done`, `response.reasoning_summary_part.added/done` | none |
| `response.output_text.delta` | one chunk: `delta={"role":"assistant","content":"<delta>"}` |
| `response.reasoning_text.delta` / `response.reasoning_summary_text.delta` | one chunk: `delta={"role":"assistant","reasoning_content":"<delta>"}` |
| `response.reasoning_text.done` / `response.reasoning_summary_text.done` | one chunk: `delta={"role":"assistant","reasoning_content":"\n\n"}` |
| `response.output_item.added` with `item.type` `function_call` or `custom_tool_call` | one announcement chunk: `delta={"role":"assistant","tool_calls":[{"index":<n>,"id":"<call_id>","type":"function","function":{"name":"<restored>","arguments":""}}]}`; `<n>` is a per-stream counter starting at 0, incremented per tool-call item |
| `response.function_call_arguments.delta` / `response.custom_tool_call_input.delta` | one chunk (only when the item is registered, not done, and `delta` non-empty): `delta={"tool_calls":[{"index":<n>,"function":{"arguments":"<delta>"}}]}` (NO `role`, NO `id`) |
| `response.function_call_arguments.done` / `response.custom_tool_call_input.done` | one chunk ONLY if no argument delta was streamed for that item AND the full `arguments`/`input` is non-empty: the full value as a single arguments chunk; empty arguments emit NOTHING; suppressed entirely when deltas were streamed |
| `response.output_item.done` with `item.type` `function_call`/`custom_tool_call` | if the item was announced: nothing when args were streamed; otherwise an arguments-only chunk with the full args (EMPTY args → nothing). If NOT announced (upstream skipped `added`): one complete chunk `delta={"role":"assistant","tool_calls":[{"index":<n>,"id":…,"type":"function","function":{"name":"<restored>","arguments":"<full args>"}}]}` |
| `response.output_item.done` / `response.image_generation_call.partial_image` with an image payload | one image chunk: `delta={"role":"assistant","images":[{"index":0,"type":"image_url","image_url":{"url":"data:<mime>;base64,<b64>"}}]}` — in STREAM mode the per-chunk `images` array always starts empty, so `index` is ALWAYS `0` (multiple images = multiple chunks, each `index:0`); identical consecutive payloads for the same `item_id` are suppressed (SHA-256 dedup). In NON-STREAM mode the `message.images` entries carry a SEQUENTIAL index across all output items (§2.5). |
| `response.completed` / `response.incomplete` | one terminal chunk: `delta={}`, `finish_reason`+`native_finish_reason` per §2.8, plus `usage` when the event carries `response.usage` |

- Tool-call stream state is keyed by `item_id` (from event or item `id`), then `output_index` raw, then the most recent item; malformed flows (missing `added`) fall back to a complete-chunk emission (above).
- `response.done` is a terminal ALIAS accepted by the stream executor's terminal switch (evidence: `codex_executor_stream.go` `case "response.completed", "response.incomplete", "response.done"`), but it is a websocket-transport marker (`normalizeCodexWebsocketCompletion`) — out of scope for HTTP goldens. The chunk translator itself emits NO frame for it, so a hypothetical HTTP stream terminated only by `response.done` would end with `[DONE]` and no finish chunk; the non-stream aggregation does NOT treat it as terminal (`codex_executor_execute.go` switch omits it).
- After the terminal chunk the upstream read loop stops; downstream gets `data: [DONE]\n\n`.
- In-stream errors (§5) are written as `data: {"error":…}\n\n` and the stream does NOT continue with `[DONE]`.

### 2.7 usage semantics (both modes)

MUST (evidence: usage blocks in both converters):
- Mapped from the upstream `response.usage` of ANY data event that carries it — the chunk/construction logic is event-type-independent; in practice only terminal events carry `response.usage`, and the goldens exercise only that case. A non-terminal event carrying `response.usage` would emit it on its own chunk.:
  `completion_tokens` ← `output_tokens`; `total_tokens` ← `total_tokens`; `prompt_tokens` ← `input_tokens`;
  `prompt_tokens_details.cached_tokens` ← `input_tokens_details.cached_tokens` (only when present);
  `prompt_tokens_details.cache_write_tokens` AND `prompt_tokens_details.cached_creation_tokens` ← `input_tokens_details.cache_write_tokens` (both keys, same value; the value is copied VERBATIM as an integer — non-integer/non-numeric/null values are dropped);
  `completion_tokens_details.reasoning_tokens` ← `output_tokens_details.reasoning_tokens` (only when present).
- EXACT `usage` object field order: `completion_tokens, total_tokens, prompt_tokens, prompt_tokens_details{cached_tokens, cache_write_tokens, cached_creation_tokens}, completion_tokens_details{reasoning_tokens}` — absent keys simply omitted.
- The stream terminal chunk carries `usage` and `finish_reason` in the SAME chunk; there is no separate usage-only chunk (contrast with openai-compat upstreams which inject `stream_options.include_usage`).
- Client `stream_options` is never honored for codex upstreams.

### 2.8 finish_reason matrix

MUST (evidence: both converters):
- Non-stream: status `completed` → `stop`, or `tool_calls` when any `function_call`/`custom_tool_call` output item exists. Status `incomplete` → `native_finish_reason` = `response.incomplete_details.reason` verbatim; `finish_reason` = `length` for reasons `max_tokens`/`max_output_tokens`, `content_filter` for `content_filter`, otherwise `stop`.
- Stream: `response.completed` → `stop`, or `tool_calls` when at least one tool-call item was announced in this stream; `native_finish_reason` mirrors `finish_reason` in both cases. `response.incomplete` → as non-stream.
- `native_finish_reason` is a non-standard extra field (CPA compatibility surface) and MUST be present on every terminal choice object (string, or `null` in non-terminal chunks).

### 2.9 Session / prompt-cache identity

MUST:
- Every upstream codex request carries a body `prompt_cache_key` AND a `Session-Id` header; when no client session signal exists they are the SAME UUID string. [RECORDED — wire log: equal values]
- Precedence: (1) client request body `prompt_cache_key` (chat JSON) — used verbatim for BOTH body field and `Session-Id` header; (2) explicit session headers (client `Session-Id`, `X-Session-ID`, `X-Claude-Code-Session-Id`, …) — the client `Session-Id` header value is forwarded verbatim as the upstream `Session-Id` header (while `prompt_cache_key` is derived); (3) otherwise a UUID DERIVED deterministically from the client api key + source format + instructions + first user/assistant message content — stable across identical requests [RECORDED — two different probe requests with the same first user message produced the same Session-Id].
- Derivation (source-derived, OPTIONAL to mirror byte-for-byte; the MUSTs are presence, equality without client session, stability, and verbatim client-value passthrough): identity root = SHA-256 over a canonical JSON `{version:"cpa-session-root-v1", format, caller_scope, instructions, user}` where `caller_scope` = SHA-256(`"cli-proxy-api:caller-scope:v1\x00" + client api key`), `instructions` = the system/developer messages (each truncated to 50 runes), `user` = the FIRST user message's canonical parts — assistant content is NEVER included (evidence: `sdk/cliproxy/session/identity.go` `messagesRoot`/`hashRoot`/`DeriveID` + `sdk/cliproxy/session/info.go` `CallerScope`). The root (`"ctx:v1:<hex>"`) is then hashed into the wire UUID: SHA-1 UUID v5 over `"cli-proxy-api\x00codex\x00derived-session\x00<root>"` under the OID namespace (`stableProviderSessionUUID`). When the conversation has NO user content (e.g. assistant-only history) the root is empty and the identity falls back to a SHA-1 UUID v5 over `"cli-proxy-api:codex:prompt-cache:" + client api key` (`codex_executor_request.go` `cacheHelper`).
- `prompt_cache_key` is appended AFTER `store` in the body (last key).

### 2.10 Tool name shortening + restoration

MUST (evidence: `shortenNameIfNeeded`, `sanitizeToolName`, `buildShortNameMap`, `buildReverseMapFromOriginalOpenAI`):
- Every tool name in the upstream body (tool declarations, `tool_choice`, and `function_call`/`custom_tool_call` input items) is sanitized: characters outside `[a-zA-Z0-9_-]` become `_`; names longer than 64 chars are shortened — names starting `mcp__` keep `mcp__` + the segment after the LAST `__` (then truncate to 64); others truncate to 64. Uniqueness is enforced with `_1`, `_2`, … suffixes (within limit).
- The mapping is built from ALL tool names in the request (tools + tool_choice + assistant tool_calls history).
- On the way back, downstream `function.name` fields in `tool_calls` (stream chunks AND non-stream message) are RESTORED to the original client name via the reverse map. Golden S2D5-07/08 pin shortening + restoration.

### 2.11 Tool-schema union normalization (unconditional, default-ON)

MUST (evidence: `internal/runtime/executor/helps/codex_tool_schema.go` — `NormalizeCodexToolSchemas`, called unconditionally in BOTH `codex_executor_execute.go` `Execute` and `codex_executor_stream.go` `ExecuteStream`, before the wire request is built):
- For every tool of type `function` or `custom` that carries an object `parameters` (namespace tools recurse into their nested `tools`):
  1. **Pattern strip**: `pattern` attributes containing Unicode property escapes (`\p{...}` / `\P{...}`) are removed from schema-aware locations only (never from user data like `description`/`default`/`enum`).
  2. **Pure-const union → enum rewrite**, exact trigger per property schema in `parameters.properties`:
     - the property object carries EXACTLY ONE of `oneOf`/`anyOf` (both present → left untouched, compound constraints preserved);
     - the union array has **≥ 8 branches** (`codexComplexUnionBranchThreshold = 8`);
     - EVERY branch is a pure const definition: an object whose ONLY keys are `const` plus optionally `description`/`title`, with a string/number/boolean/null const value;
     - all branch values are semantically unique (duplicates → untouched).
     Effect: `enum` is set to the branch const values IN ORDER, reusing the raw JSON tokens verbatim (no numeric precision loss), and the `oneOf`/`anyOf` key is DELETED. When the property already has an `enum` provably equal to the const set, only the union key is deleted. Any other shape is left byte-untouched.
- Purpose (upstream rationale): large MCP-emitted constant unions abort Codex; the rewrite is semantic, not cosmetic. Golden S2D5-25 pins an 8-branch `oneOf` rewrite; schemas below the 8-branch threshold pass through unchanged (recorded S2D5-06 tools).

---

## 3. Schemas

### 3.1 `input` items (chat messages → Responses input)

Each chat message becomes one or more top-level items in order. Roles other than the listed handling default to pass-through role strings.

| Chat message | Upstream item(s) |
|---|---|
| `role:"system"` | `{"type":"message","role":"developer","content":[parts]}` |
| `role:"user"`/`"assistant"`/other | `{"type":"message","role":"<role>","content":[parts]}` (assistant messages with zero content parts are DROPPED — they exist only as tool-call carriers) |
| assistant `tool_calls[i]` | separate top-level `{"type":"function_call","call_id":…,"name":…,"arguments":…}` or `{"type":"custom_tool_call","call_id":…,"name":…,"input":…}` (in array order, after the message item). Type selection: a client tool call of `type:"function"` whose `function.name` matches a DECLARED `custom` tool is emitted as `custom_tool_call` with `input` = the arguments; names declared BOTH as function and custom tools are removed from the custom set — the FUNCTION declaration wins, so such tool calls stay `function_call`. Golden S2D5-25 pins both branches. |
| `role:"tool"` | matched to the most recent unconsumed assistant tool call (by `tool_call_id`); `{"type":"function_call_output","call_id":…,"output":…}` or `{"type":"custom_tool_call_output",…}` for custom calls |

Content parts:
- string content → one part `{"type":"input_text","text":…}` (`output_text` for assistant messages) — non-empty strings only; `""` produces zero parts (message item still emitted with `content:[]` for non-assistant roles).
- array content per part type: `text`→`input_text`/`output_text`; `image_url`→`{"type":"input_image","image_url":<url string>}` (USER role only; the value is `image_url.url`; NO `detail`/`file_id` on message parts — those exist only on tool-output parts); `file`→`{"type":"input_file","file_data":…,["filename":…]}` (user only; requires `file.file_data`; no `file_id`/`file_url` on message parts); `input_audio`→`{"type":"input_audio","data":…,["format":…]}` (user only, requires data). Non-user roles get NO image/file/audio parts (dropped).
- tool output `content`: string → `output` string verbatim (unless it is a JSON-encoded array containing image parts, which is parsed into parts); array → parts (`text`/`input_text`/`output_text`→`input_text`; `image_url`/`input_image`→`input_image` with `image_url`/`file_id`/`detail`; `file`→`input_file` with `file_id`/`file_data`/`file_url`/`filename`); other → `output` = raw JSON text of the value.
- Tool-call id handling: missing ids get synthetic `call_missing_<msg-index>_<call-index>` (+`_N` uniqueness); duplicate ids become ambiguous — their `function_call` items and matching outputs are DROPPED.
- Tool messages with no matching pending call are DROPPED. A non-tool message resets the pending set.
- Items carry NO `id` (chat translation never emits item ids; the input-id sanitizer only affects native Responses input, OPTIONAL here).

### 3.2 `tools` and `tool_choice`

- `{"type":"function","function":{…}}` → `{"type":"function","name":…,["description":…],["parameters":<raw>],["strict":…]}` — `strict` defaults to `false` when the client omitted it (explicitly forwarded, NOT omitted). A function tool without the `function` object → `{"type":"function"}` only.
- `{"type":"custom",…}` → verbatim object with `name` shortened. A name declared BOTH as a function tool and a custom tool is removed from the custom set (function wins) — this drives the assistant-history type selection in §3.1.
- Any other non-empty `type` on an object tool (built-ins, e.g. `{"type":"web_search"}`) → verbatim passthrough. Tools with EMPTY `type` are DROPPED.
- All names shortened per §2.10; the injected `{"type":"image_generation","output_format":"png"}` is appended LAST.
- `tool_choice`: string → verbatim; object `{"type":"function","function":{"name":…}}` → rebuilt `{"type":"function","name":"<shortened>"}` (switched to `{"type":"custom","name":…}` when the name matches a declared custom tool); object `{"type":"custom","name":…}` → rebuilt `{"type":"custom","name":"<shortened>"}`; in BOTH rebuilt forms the `name` key is OMITTED when the resolved name is empty; objects with an EMPTY `type` are DROPPED (no `tool_choice` emitted); other non-empty object types → verbatim.

### 3.3 `text` (response_format)

- `response_format.type == "text"` → `text.format.type = "text"`.
- `response_format.type == "json_schema"` with `json_schema` → `text.format` = `{"type":"json_schema","name":…?,["strict":…],"schema":<raw>}`.
- A `text` object is emitted whenever `response_format` OR `text.verbosity` is present. `response_format.type:"json_object"` (or any unmapped type) leaves an EMPTY `text:{}` object (no `format` key). When only `text.verbosity` is present (no `response_format`), the object carries just `verbosity`.
- Key order inside `text`: `format` first (when mapped), then `verbosity`.

### 3.4 Terminal response shapes

`chat.completion` (non-stream) — see §2.5 template; `chat.completion.chunk` (stream) — see §2.6 template. `choices` is always a single choice (`index:0`); the gateway exposes no `n`-way choices for codex.

### 3.5 Dynamic fields (masked in goldens, listed in `meta.yaml`)

`X-Cpa-Trace-Id`, `Date`, `Session-Id` / `prompt_cache_key` (derived session UUID), `Host`/`Content-Length`/`Accept-Encoding` (transport), upstream `usage` only when the mock varies it (goldens fix it).

---

## 4. Streaming rules (byte-exact contract material)

For the canned mock stream (goldens S2D5-02 etc.), the downstream SSE is EXACTLY (whitelisted dynamic: none — every byte below is fixed by the mock):

```
data: {"id":"resp_mock_01","object":"chat.completion.chunk","created":1770000000,"model":"gpt-mock-codex","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello from mock codex upstream"},"finish_reason":null,"native_finish_reason":null}]}

data: {"id":"resp_mock_01","object":"chat.completion.chunk","created":1770000000,"model":"gpt-mock-codex","choices":[{"index":0,"delta":{"role":"assistant","content":" more"},"finish_reason":null,"native_finish_reason":null}]}

data: {"id":"resp_mock_01","object":"chat.completion.chunk","created":1770000000,"model":"gpt-mock-codex","choices":[{"index":0,"delta":{},"finish_reason":"stop","native_finish_reason":"stop"}],"usage":{"completion_tokens":6,"total_tokens":15,"prompt_tokens":9}}

data: [DONE]

```

Rules:
- One SSE frame per translated chunk, `data: <json>\n\n`; `[DONE]` frame `data: [DONE]\n\n`.
- The mock's `response.created`/`output_item.added`/`content_part.*`/`output_text.done` events produce NO frames.
- Byte-exact contract tests compare frames after masking §3.5 dynamic fields; the JSON field ORDER above is part of the contract.
- Non-stream clients get the §2.5 aggregate (single JSON body) — byte example (mock canned):

```
{"id":"resp_mock_01","object":"chat.completion","created":1770000000,"model":"gpt-mock-codex","choices":[{"index":0,"message":{"role":"assistant","content":"Hello from mock codex upstream more","reasoning_content":null,"tool_calls":null},"finish_reason":"stop","native_finish_reason":"stop"}],"usage":{"completion_tokens":6,"total_tokens":15,"prompt_tokens":9}}
```

---

## 5. Error semantics

| # | Condition | Client-visible result |
|---|---|---|
| E1 | Upstream HTTP non-2xx (e.g. mock 429) | Status = upstream status, body passed through VERBATIM when it is valid JSON (the raw upstream error JSON); otherwise wrapped `{"error":{"message":<text>,"type":<mapped>,"code":<mapped>}}` (mapping: 401→authentication_error/invalid_api_key, 403→permission_error/insufficient_quota, 429→rate_limit_error/rate_limit_exceeded, 404→invalid_request_error/model_not_found, ≥500→server_error/internal_server_error, else invalid_request_error). Applies to stream AND non-stream clients when it happens before the first chunk (pre-commit). Evidence: `newCodexStatusErrWithCooling` + `handlers_errors.go` `BuildErrorResponseBodyWithError`. Goldens S2D5-15/16. |
| E2 | Upstream 429 additionally arms the rate-limit cooldown — NOT disabled by `transient-error-cooldown-seconds: -1`; the NEXT request within the window on the same model gets **HTTP 429** (the rate-limit status is inherited from the triggering error, NOT 500) with a `Retry-After: <n>` header (recorded: `4`) and body `{"error":{…}}` marshaled with ALPHABETICAL keys: `code:"model_cooldown"`, `last_upstream_error:"<VERBATIM upstream error body>"` (the raw body string, spacing preserved — the upstream summary heuristic falls back to the raw text when the stripped remainder is not valid JSON), `message:"All credentials for model <alias> are cooling down via provider codex (last error: <verbatim body>)"` (`<alias>` = the REQUESTED model string, e.g. `cx`), `model`, `provider:"codex"`, `reset_seconds` (recorded: 4), `reset_time` (recorded: `"4s"`). Recorded R2 also omits `X-Cpa-Trace-Id`. [RECORDED — golden S2D5-24; mechanism: `modelCooldownError.Error()` in `sdk/cliproxy/auth/selector.go` — the cooldown error type HARDCODES HTTP 429 (`modelCooldownError.StatusCode()`), independent of the triggering status, and emits `Retry-After` from its own `Headers()` = ceil(reset seconds); the error-text pipeline sanitizes and truncates the embedded upstream text at 256 runes (>256 → first 253 runes + `...`, `SanitizeUpstreamErrorSummary` — long upstream bodies are cut in BOTH `last_upstream_error` and the message suffix)] S4 owns the algorithm; the codex rate-limit window recorded as ~4s (NOT the gemini wire-note's ~1s — see §7). |
| E3 | Stream terminal failure event (`error` or `response.failed`) with chunks already sent | HTTP stays 200; the failure body (extracted `error` object; `{"error":{"message":"upstream stream failed without error details"}}` fallback; `sequence_number` added when present) is emitted as one in-stream frame `data: {"error":…}\n\n`; NO `[DONE]`. Evidence: `codexTerminalFailureBody` + `handleStreamResult` `WriteTerminalError`. Golden S2D5-18. |
| E4 | Terminal failure event with NO payload yet — STREAM clients: failure as the first event (E3 covers failures after payload); NON-STREAM clients: failure at ANY position in the upstream stream (the whole upstream body is read before any downstream byte is written — a failure never appears mid-body) | Pre-commit error: status derived from the failure (`error.status_code`/`error.status`, else type/code mapping: not_found→404, authentication→401, permission→403, rate_limit→429, invalid_request→400, else 502; `cyber_policy`→400), body = failure body verbatim (JSON) → e.g. 502 + upstream error JSON. Golden S2D5-19 (stream, first event). |
| E5 | Upstream SSE ends (or hard-disconnects) without a terminal event | If ≥1 chunk was already sent: HTTP 200, in-stream frame `data: {"error":{"message":"stream error: stream disconnected before completion: stream closed before response.completed","type":"invalid_request_error"}}\n\n` (status 408 internally; no `code` key since <500), NO `[DONE]`. If NO chunk was sent: pre-commit HTTP 408 + same body. Evidence: `newCodexIncompleteStreamError` (note: NOT the generic "unexpected EOF" text — that is the gemini executor's message). Golden S2D5-17. |
| E6 | `response.incomplete` terminal with zero output (no output items, no meaningful deltas, `usage.output_tokens` == numeric 0) | Gateway error (pre-commit 502 / in-stream after payload): message `stream error: upstream terminated with incomplete empty response (0 tokens)`. Evidence: `helps/codex_terminal_incomplete.go`. Not goldened (needs a zero-token script variant; low value vs cost) — OPTIONAL golden. |
| E7 | Model resolution failure (unknown model) | 400 `{"error":{"message":"unknown provider for model <m>","type":"invalid_request_error","code":"model_not_found","param":"model"}}` (S1 shared shape). Golden S2D5-20. |
| E8 | Classified upstream bodies are rewritten before passthrough (OPTIONAL to mirror for same-client-visible bytes): `context_too_large` (413 or context-length markers) → `{"error":{"message":…,"type":"invalid_request_error","code":"context_too_large"}`; auth markers → `auth_unavailable`/`authentication_error`; `usage_limit_reached` and model-capacity bodies are re-stated as 429. Evidence: `codexStatusErrorClassification`, `classifyCodexStatusError`. |

Pre-commit error headers: `Content-Type: application/json` + shared block only (no SSE headers).

---

## 6. Golden samples index

All 26 fixtures are RECORDED under `tests/fixtures/S2d5/<case-id>/` in the RECIPES layout (24 round-0 + 2 round-1 gate cases, the latter verified against the §2.11/§5-E6 contracts byte-level) (meta.yaml, request.http, downstream.md, upstream.jsonl, mock-response.json; multi-request cases use R1..Rn blocks). Recorded by @oracle-runner-3 on 2026-09-15 against CLIProxyAPI v7.3.4 (image digest `sha256:97825d…`), codex-api-key entry api-key `mock-codex-key`, model `gpt-mock-codex` alias `cx`, downstream auth `Bearer oracle-local-key-1`. Recording stack ports (downstream 8397, codex mock 21003) and per-case upstream wire-line counts are documented in each `meta.yaml`; raw transcripts: `_cpa_edge_ref/run3/probes/S2d5/`. Canned scripts were served from `s2d5_scripts.json` (generated byte-exactly from `spec/recordings/S2d5.cases.json`) via the codex mock's script selector (control-file `script` key or `X-Mock-Script` header, stripped from wire logs). All 26 cases matched their pre-recording expectations except S2D5-24 (see §5 E2 and §7); S2D5-25 and S2D5-26 matched the round-1 gate expectations exactly (wire-verified enum rewrite, type selection, and the pre-commit empty-incomplete 502).

| Case id | Pins | Mode/script |
|---|---|---|
| S2D5-01-nonstream-basic-aggregation | always-SSE upstream + aggregation; upstream body canonical order; chat.completion bytes | happy (canned) |
| S2D5-02-stream-basic | chunk template/order; delta mapping; terminal chunk + usage; [DONE] | happy (canned) |
| S2D5-03-system-developer-multimodal | system→developer; multimodal parts (input_text/input_image/input_file); instructions stays "" | happy (canned) |
| S2D5-04-reasoning-effort-high | [RECORDED] `reasoning_effort:"high"` produces NO `reasoning` object upstream (capability-less model strip) | happy (canned) |
| S2D5-05-reasoning-effort-none | [RECORDED] `reasoning_effort:"none"` produces NO `reasoning` object upstream (same strip) | happy (canned) |
| S2D5-06-tools-history | tools flatten (strict:false default); input items function_call/function_call_output; tool_choice mapping; image-gen tool appended last | happy (canned) |
| S2D5-07-stream-toolcall | announcement/args-delta/terminal chunks; name shortening + restoration; finish tool_calls | script `s2d5-toolcall` |
| S2D5-08-nonstream-toolcall | aggregated message.tool_calls; restored long name; custom input-as-arguments | script `s2d5-toolcall` |
| S2D5-09-stream-reasoning-deltas | downstream reasoning_content deltas + "\n\n" separator chunk; upstream reasoning object stripped (client sent reasoning_effort:"low") | script `s2d5-reasoning` |
| S2D5-10-nonstream-reasoning-item | message.reasoning_content from summary/content | script `s2d5-reasoning` |
| S2D5-11-stream-incomplete-length | finish length + native max_output_tokens + usage on incomplete | script `s2d5-incomplete-length` |
| S2D5-12-nonstream-empty-output-patch | output patch from output_item.done when completed output is empty | script `s2d5-empty-output-patch` |
| S2D5-13-usage-rich | full usage mapping incl. cache_write_tokens→cache_write_tokens+cached_creation_tokens | script `s2d5-usage-rich` |
| S2D5-14-service-tier | service_tier latched on every chunk, appended after choices | script `s2d5-service-tier` |
| S2D5-15-upstream-429-nonstream | 429 verbatim passthrough (non-stream) | control error 429 |
| S2D5-16-upstream-429-stream-precommit | pre-commit 429 JSON (no SSE headers) on stream client | control error 429 |
| S2D5-17-disconnect-midstream | 2 chunks + in-stream 408 error frame, no [DONE] | control disconnect after=5 |
| S2D5-18-terminal-failure-midstream | in-stream failure body verbatim after payload | script `s2d5-fail-mid` |
| S2D5-19-terminal-failure-first | pre-commit derived status (502) + failure body | script `s2d5-fail-first` |
| S2D5-20-model-not-found | 400 model_not_found shape | none (no upstream call) |
| S2D5-21-prompt-cache-key-passthrough | body prompt_cache_key + Session-Id header == client value | happy (canned) |
| S2D5-22-client-session-id-header | client Session-Id header forwarded verbatim upstream | happy (canned) |
| S2D5-23-response-format-json-schema | text.format mapping + verbosity | happy (canned) |
| S2D5-24-rate-limit-cooldown-pair | recorded model_cooldown shape after 429: HTTP **429** + `Retry-After`, alphabetical body keys, verbatim `last_upstream_error`, model = requested alias, reset 4s | control error 429 (pair) |
| S2D5-25-union-schema-enum-rewrite | §2.11 MUST: 8-branch pure-const oneOf → enum rewrite upstream; B2 type selection: function-named-after-custom → `custom_tool_call`/`input`; shared name → function wins; `custom_tool_call_output`/`function_call_output` mapping | happy (canned) |
| S2D5-26-empty-incomplete-zero-tokens | §5 E6: empty incomplete (0 tokens, no output) → pre-commit 502 `stream error: upstream terminated with incomplete empty response (0 tokens)` | script `s2d5-empty-incomplete` |

FIXTURE-DEFERRED (CREDENTIALED-ONLY, R-FIXTURE): default chatgpt.com base URL behavior, OAuth token lifecycle, `Chatgpt-Account-Id` header emission, OAuth free-plan image-tool suppression, `session`/conversation continuity with `previous_response_id` against the real Codex backend. Specified in §2.2/§8 from source; no local fixture possible.

---

## 7. Open questions and intentional non-equivalences

1. **Session UUID derivation** — the derivation chain (caller-scope SHA-256 + canonical message-content hash → FNV-64 `msg:` identity → SHA-1 UUID v5) is complex and version-sensitive. CPA-Edge MUST satisfy the observable contract (§2.9) but MAY pick a different derivation algorithm; exact-UUID mirroring is OPTIONAL. Contract tests mask the value.
2. **In-stream error type mapping for 408** — the codex incomplete-stream error surfaces with `"type":"invalid_request_error"` and NO `code` (status <500 falls through the default branch). This looks odd but is recorded-verified behavior; flagged as a possible upstream bug we mirror intentionally.
3. **[RECORDED — supersedes the pre-recording draft]** `reasoning_effort` is NOT forwarded to codex-api-key upstreams by default: the whole `reasoning` object is stripped for models without thinking capability (§2.3). The effort-passthrough + `summary:"auto"` mapping is the capability-ON variant, specified from source only; if a future recording uses a capability-bearing model name, pin it there. CPA-Edge MUST mirror the strip for capability-less models (client-visible: upstream wire has no reasoning key; goldens S2D5-04/05 prove the client's effort value is dropped silently).
4. **Ignored sampling params** — `temperature`, `top_p`, `max_tokens` etc. are silently dropped (not forwarded, not rejected). Mirrored as MUST (drop) — clients get no error.
5. **Image-generation tool injection** — every request (default config) silently gains `{"type":"image_generation","output_format":"png"}` in `tools`. Mirrored as MUST.
6. **assistant multimodal** — image/file/audio parts in assistant messages are dropped (only text survives as `output_text`); user-role-only conversions. Mirrored as MUST.
7. **usage duplication** — `cache_write_tokens` is emitted twice (`cache_write_tokens` + `cached_creation_tokens`) for Claude-client compatibility. Mirrored as MUST.
8. **non-equivalence**: CPA-Edge MAY choose to reject obviously-invalid `reasoning_effort` values that upstream would reject server-side; the recorded contract only proves verbatim passthrough — flagging as open question rather than MUST.
9. Codex OAuth-only behaviors (§6 FIXTURE-DEFERRED) are specified from source; wire verification requires a real ChatGPT account (per R-FIXTURE).
10. The `X-Mock-*` control headers used by the oracle are stripped by the mock before wire logging; they never appear in fixtures' upstream.jsonl. (Recording-infra note, not gateway behavior.)
11. Stream bootstrap buffering (`codex.stream-bootstrap-buffering`) and websocket transports are OPTIONAL behaviors, out of scope; the recorded default path is unbuffered.
12. The `/v1/chat/completions` route also accepts OpenAI-Responses-shaped bodies (auto-converted). S2d5 goldens do not cover it; S1/S2d9 should pin it or it stays an open question there.
13. **[RECORDED] Rate-limit cooldown window is provider-specific and stateful.** The mission wire note ("reset ~1s", from the gemini mock) does NOT generalize: the codex path recorded `reset_seconds: 4` / `reset_time: "4s"` / `Retry-After: 4`, and a request fired 1.2s after a PRIOR 429 still caught residual cooldown. Consequences: (a) the cooldown shape golden S2D5-24 is a PAIR recording — contract tests must replay both requests back-to-back and mask `reset_seconds`, `reset_time`, `Retry-After`, `X-Cpa-Trace-Id`, `Date` as dynamic (the remaining-window values are time-dependent); (b) re-recordings must space error-mode cases ≥5s apart (S4 owns the exact algorithm).
14. **[RECORDED] `last_upstream_error` carries the VERBATIM upstream body** for codex 429s (mock `json.dumps` spacing preserved inside the JSON string), because the upstream-summary heuristic strips at the first `": {"`, leaves a dangling `}` and therefore fails its own validity check, falling back to the sanitized raw text. The message field embeds the same verbatim body in its `(last error: …)` suffix. The summary form (`code: message`) seen on other providers does not occur on this path. Do NOT "improve" this without registering a non-equivalence.
15. **[RECORDED] The cooldown response (R2 in S2D5-24) carries NO `X-Cpa-Trace-Id` header** while the triggering 429 (R1) does. Recorded as-is; contract tests must tolerate the absence on this response.
16. Error bodies forwarded verbatim (E1, E3, E4, S2D5-15/16/18/19) preserve the mock's `json.dumps` byte spacing (`{"error": {"message": …}}` with spaces). Byte-diff tooling must compare against the recorded bytes, not re-serialized JSON.
17. **[RECORDED] Recording-vs-source lesson:** the pre-recording draft of §2.3 claimed `reasoning.effort` always reaches the upstream (translator default `"medium"`); the fixtures proved the capability-gated strip instead. The earlier `_cpa_edge_ref/probes/mocks/codex/upstream.jsonl` wire log already showed no `reasoning` key and should have been treated as decisive — recorded wire beats static reading (SPEC.md §0 precedence). Future S2 sections: derive request-body claims from recorded wire logs FIRST.
