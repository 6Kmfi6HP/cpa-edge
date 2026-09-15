# S2d6 — Responses client → OpenAI chat upstream

Section id: S2d6. Module: `packages/translators` (openai-responses → openai-chat direction) + executor wiring in `packages/executors` + handler in `runtimes/*`.
Upstream anchor: CLIProxyAPI v7.3.4, commit `8335eac731946bd4eff18f500653f93736df53d6` (see SPEC.md §0).
Upstream evidence paths in this section are relative to the upstream repo root.
Wire-facts in `reports/oracle/BOOTSTRAP.md` §6/§8 and the mission WIRE NOTES are recorded behavior and outrank static reading where they conflict (SPEC.md §0 precedence).

Direction under test: a client speaks the OpenAI **Responses** wire format against the gateway, and the selected model routes to an **`openai-compatibility`** provider (OpenAI Chat Completions wire upstream). Registered translation pair: format constant `openai-response` (client) → `openai` (upstream) — evidence: `internal/constant/constant.go` (`OpenaiResponse = "openai-response"`, `OpenAI = "openai"`), registration in `internal/translator/openai/openai/responses/init.go` (`translator.Register(OpenaiResponse, OpenAI, ConvertOpenAIResponsesRequestToOpenAIChatCompletions, ...)`).

---

## 1. Scope and boundaries

IN scope:
- `POST /v1/responses` and its Codex alias `POST /backend-api/codex/responses` (same handler; evidence: `internal/api/server_routes.go` — both route groups register `openaiResponsesHandlers.Responses`).
- `POST /v1/responses/compact` and `POST /backend-api/codex/responses/compact` when the routed upstream is an `openai-compatibility` provider (near-passthrough semantics, §2.4).
- Request translation: Responses request → OpenAI Chat Completions upstream body, field by field (§3.1).
- Response translation: Chat Completions upstream response → Responses wire, non-stream (§3.3) and SSE stream (§3.4 + §4).
- Upstream wire contract emitted by the gateway: URL, headers, body shape (§3.2).
- Error semantics: pre-execution errors, upstream HTTP errors, in-stream failures, disconnects, missing terminal markers (§5).
- Usage mapping in both directions (§3.5).

OUT of scope (owned elsewhere):
- `GET /v1/responses` / `GET /backend-api/codex/responses` — these are WebSocket upgrade routes (`ResponsesWebsocket`), a different transport; S2d9-family territory. S2d6 covers HTTP POST only.
- Auth middleware, CORS block, R-404 empty-body semantics, `/v1/models` — S1. S2d6 cites the exact shapes it observes but does not own them.
- Model catalog, alias→upstream-name resolution mechanics, scheduling/cooldown algorithms — S4. S2d6 assumes one `openai-compatibility` provider with model `name: mock-gpt-model`, `alias: mock-model` (oracle config) and observes the rewrite.
- Thinking suffixes `model(...)` on the requested model name — cross-cutting; S2d6 requires only the no-suffix behavior of the goldens.
- Plugin interceptors / model router / payload-config overrides (`models[].payload` rules), `support-prompt-cache-key`, `input-modalities`-driven tool-result flattening, `codex-optimize-multi-agent-v2` / `codex-orphan-delegation-compatibility` rewrites, `streaming.keep-alive-seconds`, `streaming.bootstrap-retries`, `passthrough-headers` — all config-gated features that are OFF in the anchor configuration. Behaviors are marked OPTIONAL where relevant.
- Responses clients routed to Codex/xAI/Meta/Gemini/Claude/interactions upstreams — S2d5/S2d1-family/S2d3-family/S2d9 sections.
- Token counting: the Responses inbound surface has NO count-tokens route. (Recorded S1 fact, incorporated for boundary clarity: for `openai-compatibility` upstreams, count-token requests arriving on OTHER client protocols are synthesized locally by the gateway — `{"totalTokens":N,...}` with an EMPTY `upstream.jsonl`; no count request is ever forwarded to the chat upstream. Nothing in S2d6 may imply count forwarding.)

Intentional non-equivalences: §8.

---

## 2. Behavior inventory

### 2.1 Routes and methods

| Method | Path | Behavior | Status codes |
|---|---|---|---|
| POST | `/v1/responses` | Responses request → chat upstream | 200 (JSON or SSE), 400, 401, 429/5xx passthrough, 500 |
| POST | `/backend-api/codex/responses` | alias of the above (same handler) | same |
| POST | `/v1/responses/compact` | compact request → `<base>/responses/compact` upstream | 200, 400, 401, upstream error passthrough |
| POST | `/backend-api/codex/responses/compact` | alias of the above | same |
| GET | `/v1/responses` | WebSocket upgrade (OUT of scope) | — |

MUST:
- A wrong HTTP method on `/v1/responses` returns **404 with an empty body** (R-404; evidence: gin routing + recorded probe `05-wrong-method`).
- `OPTIONS /v1/responses` returns **204 No Content** with the CORS block, no auth (R-404 family; evidence: recorded probe `04-options-request`).
- Missing API key → **401** `{"error":"Missing API key"}`; invalid key → **401** `{"error":"Invalid API key"}` (evidence: `internal/api/server_middleware.go` `accessAuthMiddleware`; recorded probes `06`/`07`).
- Unknown/unroutable `model` → **400** `{"error":{"message":"unknown provider for model <raw-model-from-body>","type":"invalid_request_error","code":"model_not_found","param":"model"}}` (evidence: `sdk/api/handlers/handlers_routing.go` `getRequestDetailsWithOptions`; body built via sjson so the model string is JSON-escaped). An empty/absent model yields the same 400 with an empty model name in the message.
- A body that is not valid JSON is NOT rejected by a JSON-syntax check: the handler reads it, `model` resolves to `""` and the request fails with the same 400 `model_not_found` with an EMPTY model name in the message — `unknown provider for model ` (trailing space; evidence: `openai_responses_handlers.go` `Responses` → `handlers.ReadRequestBody` performs no JSON validation; `request_body.go`; golden S2d6-badbody-notfound records the reference behavior).
- **NE-LENIENT (SPEC.md §5, binding):** the recorded lenient parse is REFERENCE documentation only. CPA-Edge enforces a STRICT request boundary: non-JSON / malformed bodies are rejected with 400 (this surface's OpenAI error shape) BEFORE model resolution. Contract fixtures replay well-formed bodies only; S2d6-badbody-notfound is a reference-behavior golden, not a rewrite target.
- Streaming is selected ONLY by `"stream": true` (JSON boolean) in the body. `"stream": false`, absent, or any non-boolean value → non-streaming (evidence: `Responses`: `streamResult.Type == gjson.True`).

### 2.2 Request pipeline (per request)

1. Read body (Content-Encoding `zstd` supported; unsupported encodings → 400 `{"error":{"message":"Invalid request: unsupported request content encoding: <enc>","type":"invalid_request_error"}}`; evidence: `request_body.go`, `Responses`).
2. Model alias → provider + upstream model name resolution (S4). The upstream body `model` field is the RESOLVED upstream name (`mock-model` → `mock-gpt-model`; recorded in BOOTSTRAP §6).
3. Translate Responses body → chat body (§3.1).
4. Execute against `<base-url trimmed of trailing />/chat/completions` with §3.2 wire.
5. Translate back (§3.3/§3.4) and write downstream.

### 2.3 Non-stream vs stream selection and upstream transport

- Non-stream: `POST <base>/chat/completions` with `"stream":false` in the translated body; no SSE upstream headers.
- Stream: `POST <base>/chat/completions` with `"stream":true` AND `stream_options.include_usage` forced to `true`; upstream request headers gain `Accept: text/event-stream`, `Cache-Control: no-cache` (evidence: `openai_compat_executor.go` `ExecuteStream`; `helps.SetBoolIfDifferent` in `helps/payload_mutations.go`; recorded in BOOTSTRAP §6).
- The chat upstream is NOT always-SSE (unlike codex/xai/meta upstreams — see S2d9): non-stream Responses requests go non-stream upstream.

### 2.4 `/v1/responses/compact` (openai-compatibility upstream)

Evidence: `openai_responses_handlers.go` `Compact` + `openai_compat_executor.go` `Execute` (`opts.Alt == "responses/compact"`).

MUST:
- Upstream target: `POST <base>/responses/compact` — NOT `/chat/completions` (endpoint switch in `Execute`).
- No translator pair `openai-response → openai-response` is registered (evidence: registry init files), so the request falls back to the passthrough rule of `sdk/translator/registry.go` `TranslateRequest`: original body, with `model` overwritten to the resolved upstream name.
- The client `stream` field is deleted from the upstream body (`Compact` + `Execute` both strip it).
- The upstream response body is passed through with no response translation, THEN `EnsureResponsesUsageDetails` is applied because the response format is Responses (evidence: `Execute`: `out = helps.EnsureResponsesUsageDetails(out)`): if the body has a `usage` object (top-level or under `response`), `usage.output_tokens_details.reasoning_tokens: 0` and `usage.input_tokens_details.cached_tokens: 0` are added when missing. A payload with `"object":"response.compaction"` is exempt.
- `"stream": true` in a compact request → **400** `{"error":{"message":"Streaming not supported for compact responses","type":"invalid_request_error"}}` (no `code` field), before any upstream call.

---

## 3. Schemas

### 3.1 Request translation: Responses body → chat body

Source of truth: `internal/translator/openai/openai/responses/openai_openai-responses_request.go` (`ConvertOpenAIResponsesRequestToOpenAIChatCompletions`). The output is **built from a fixed template**, so every Responses field not listed below is DROPPED (whitelist semantics). Output template:

```json
{"model":"","messages":[],"stream":false}
```

MUST (upstream body field order — byte-relevant, sjson appends new fields at the end):
`model`, `messages`, `stream`, then — only when produced — `response_format`, `max_tokens`, `tools`, `parallel_tool_calls`, `tool_choice`, `reasoning_effort`, and finally `stream_options` (streaming only, added by the executor, not the translator).

| Responses request field | Upstream chat field | Rule |
|---|---|---|
| `model` (implicit; the resolved name) | `model` | Always the RESOLVED upstream model name, never the client alias. |
| (stream flag) | `stream` | `false` for non-stream, `true` for stream. |
| `text.format` | `response_format` | `{"type":"text"}` for `text`; `{"type":"json_object"}` for `json_object`; `json_schema` → `{"type":"json_schema","json_schema":{name?,description?,strict?,schema?}}` copying those fields verbatim when present (field order: name, description, strict, schema). Any other `type` → `response_format` OMITTED. |
| `max_output_tokens` | `max_tokens` | Copied as integer when present. |
| `instructions` | first message | `{"role":"system","content":"<instructions>"}` — content is a plain JSON string, prepended before all input-derived messages. Non-string instructions are stringified to their raw JSON text. |
| `input` (string) | messages | Single message `{"role":"user","content":"<input string>"}` (content is a plain string). |
| `input` (array) | messages | Per-item rules below. |
| `tools` (+ `additional_tools` input items) | `tools` | See §3.1.2. Only set when at least one chat tool is produced. |
| `parallel_tool_calls` | `parallel_tool_calls` | Copied ONLY when the translated `tools` array is non-empty. |
| `tool_choice` | `tool_choice` | Copied ONLY when `tools` is non-empty. See §3.1.2. |
| `reasoning.effort` | `reasoning_effort` | Lowercased, trimmed; empty string → omitted. |
| `temperature`, `top_p`, `user`, `store`, `metadata`, `previous_response_id`, `truncation`, `prompt_cache_key`, `service_tier`, `safety_identifier`, `top_logprobs`, `text.verbosity`, `reasoning.summary`, `include`, `background`, `prompt`, unknown fields | — | **DROPPED.** (The wire rule for temperature/top_p is pinned by golden S2d6-nostream-basic.) |

#### 3.1.1 `input` array items

Items are pre-processed by `NormalizeResponsesToolCallOutputs` (`internal/translator/common/responses.go`): outputs (`function_call_output`/`custom_tool_call_output`) missing `call_id` are paired with the nearest preceding unmatched tool call by (1) explicit call-id match across the whole conversation, (2) function-name match, (3) FIFO fallback; outputs with explicit ids that match nothing are left untouched. Call-id extraction order: `call_id` → `tool_call_id` → `callId` → `id` unless the id starts with `fco_` (`ExtractResponsesCallID`).

| Item `type` | Upstream message(s) | Rules |
|---|---|---|
| `message` (or item with a `role` and no `type`) | one message | `role` copied; `developer` → `user`. Content array: `input_text`/`output_text` (or missing part `type`) → `{"type":"text","text":...}`; `input_image` → `{"type":"image_url","image_url":{"url":...}}` with `image_url.detail` set to the normalized detail when non-empty — `auto`/`low`/`high` kept, `original` → `high`, other strings → detail omitted, non-string detail → part still emitted without detail (evidence: `normalizeChatImageDetail`). Other part types (e.g. `input_file`) DROPPED. String content (not array) → plain string content. Empty/absent content array → `content:[]`. |
| `reasoning` | buffered | Summary texts (`summary[].text` where part `type` is `summary_text`) are concatenated into a pending reasoning string; empty result → literal `"[reasoning unavailable]"`. The pending string is attached as `reasoning_content` on the NEXT assistant message (merged with the item's own `reasoning_content` with `\n\n` joins, dedup of the unavailable marker), or emitted as a trailing `{"role":"assistant","content":"","reasoning_content":"..."}` message at end of input. Non-assistant items flush it first (as the trailing assistant message). |
| `function_call` | buffered tool call | Consecutive function_call items are buffered and flushed as ONE assistant message `{"role":"assistant","tool_calls":[...]}`. Each tool call: `{"id":<call_id>,"type":"function","function":{"name":<name>,"arguments":<arguments string>}}`. The flush happens when the next non-function_call item arrives, or at end of input. |
| `custom_tool_call` | buffered tool call | Same buffering; tool call `function.arguments` = `{"input":"<raw input string>"}` (the freeform input wrapped in a one-field object). |
| `function_call_output` | `{"role":"tool","tool_call_id":<call_id>,"content":<content>}` when the call_id is awaited by a pending tool call; otherwise → see orphan rule below. Content rule (`setFunctionCallOutputContent`): output string that is NOT valid JSON → the string; valid JSON or non-string output parsed as an array containing image parts (`image_url`/`input_image` with valid url) → array of `{"type":"text"}`/`{"type":"image_url"}` parts; any other valid-JSON or array/object output → the RAW JSON text of the output (stringified). |
| `custom_tool_call_output` | `{"role":"tool","tool_call_id":...,"content":<text>}` (when awaited) | Content = flattened text of string/array-of-parts output (`responsesToolOutputText`); image arrays fall back to the structured-content rule above. |
| anything else (`web_search_call`, `file_search_call`, …) | — | DROPPED from messages (flushes pending tool calls first, resets merge state). |
| orphan `function_call_output`/`custom_tool_call_output` | `{"role":"user","content":<output content>}` | An output whose call_id matches no pending assistant tool call becomes a USER message with the same content extraction rule; outputs whose extracted content is empty string / empty array are dropped entirely (evidence: `appendStandaloneResponsesToolOutputAsUser`). |

MUST (ordering constraints):
- A message arriving while some tool call still awaits its output is DEFERRED until all awaited outputs arrive (tool-call adjacency: assistant(tool_calls) → tool messages with no interleaved message). Deferred messages re-appear in original order once the outputs are complete (`flushDeferredMessages`).
- An assistant message produced by `message` items with no `tool_calls` can be MERGED with a following buffered tool-call flush: the `tool_calls` array is added to that assistant message instead of a new one (`mergeableAssistantIndex` logic). Reasoning strings are combined in the merge.

#### 3.1.2 Tools

Source: `openai_openai-responses_tools.go`. MUST:
- Tool sources, in order: top-level `tools`, then every `additional_tools` input item's `tools`. Deduplicated by produced chat name, first occurrence wins.
- A `namespace` tool contributes its children with the qualified name `"<namespace>__<child>"` (or `"<namespace>"` suffix style when the namespace already ends with `__`); children already prefixed `mcp__` or with the namespace name are not re-qualified.
- Function tool (or tool with empty `type`) → `{"type":"function","function":{"name":"<name>","description":"<desc or empty string>","parameters":<parameters or {}>}}`. Name from `name` or `function.name`; description from `description` or `function.description`; parameters from the first present of `parameters`, `parametersJsonSchema`, `input_schema`, `function.parameters`, `function.parametersJsonSchema` (verbatim raw JSON).
- Custom tool (`"type":"custom"`) → a function tool whose `parameters` is fixed to `{"type":"object","properties":{"input":{"type":"string"}},"required":["input"]}`.
- Any other tool `type` (e.g. `web_search`) is DROPPED.
- `tool_choice`: non-object values copied verbatim (`"auto"`, `"none"`, `"required"`). Object with `type` `function`/`custom` → `{"type":"function","function":{"name":"<resolved name>"}}` (name from `function.name`/`custom.name`/`name`; namespace-qualified when a namespace is present, else canonicalized against declared tools). Other object types copied verbatim.

### 3.2 Upstream wire (gateway → openai-compatibility provider)

Evidence: `openai_compat_executor.go` `Execute`/`ExecuteStream`; recorded in BOOTSTRAP §6 and `probes/mocks/README.md`.

MUST:
- URL: `POST <base-url with trailing "/" trimmed>/chat/completions` (compact: `.../responses/compact`).
- Headers (both modes): `Content-Type: application/json`; `Authorization: Bearer <api-key>`; `User-Agent: cli-proxy-openai-compat`; `Accept-Encoding: gzip` (Go transport default). Client headers are NOT forwarded (recorded fact, BOOTSTRAP §6).
- Stream-only headers: `Accept: text/event-stream`, `Cache-Control: no-cache`.
- Stream body gains `"stream_options":{"include_usage":true}` (set-if-different; evidence: `helps.SetBoolIfDifferent` call in `ExecuteStream`).
- OPTIONAL (config-gated, OFF in anchor config): custom headers from provider attrs/config; `prompt_cache_key` injection when the provider sets `support-prompt-cache-key`; tool-result flattening when the model's `input-modalities` exclude images (`helps/openai_compat_tool_results.go`); payload-config model rules; codex multi-agent/orphan-delegation rewrites.

### 3.3 Non-stream response translation: chat body → Responses body

Source: `ConvertOpenAIChatCompletionsResponseToOpenAIResponsesNonStream` (+ `helps.EnsureResponsesUsageDetails` applied by the executor). Template:

```json
{"id":"","object":"response","created_at":0,"status":"completed","background":false,"error":null,"incomplete_details":null}
```

MUST (field order — byte-relevant): `id`, `object`, `created_at`, `status`, `background`, `error`, `incomplete_details`, then — only when applicable, in this order — `instructions`, `max_output_tokens`, `max_tool_calls`, `model`, `parallel_tool_calls`, `previous_response_id`, `prompt_cache_key`, `reasoning`, `safety_identifier`, `service_tier`, `store`, `temperature`, `text`, `tool_choice`, `tools`, `top_logprobs`, `top_p`, `truncation`, `user`, `metadata`, `output`, `usage`.

- `id`: upstream `choices`-sibling `id`; if empty, synthesized `resp_<hex>_<n>` (dynamic).
- `created_at`: upstream `created`; if 0, server time (dynamic).
- `status`: `completed`, or `incomplete` when `choices[0].finish_reason` is `length`/`max_tokens`/`content_filter` (with `incomplete_details` `{"reason":"max_output_tokens"}` or `{"reason":"content_filter"}`).
- **Echo quirk (must): the echo fields are read from the TRANSLATED chat request, not the original Responses request.** Consequences that MUST hold:
  - `model` = the RESOLVED upstream model name (`mock-gpt-model`), NOT the client alias.
  - `max_output_tokens` echoes the translated `max_tokens` (i.e., the request's `max_output_tokens`; the request's `max_tokens` is also accepted as a source).
  - `instructions`, `reasoning`, `text`, `temperature`, `top_p`, `user`, `store`, `metadata`, `previous_response_id`, `truncation`, `prompt_cache_key`, `service_tier`, `safety_identifier`, `top_logprobs`, `max_tool_calls`, `parallel_tool_calls` are ABSENT in normal operation (the chat body has none of them).
  - `tools` and `tool_choice`, when tools were declared, echo the **chat-format** shapes (converted tools array; `{"type":"function","function":{"name":...}}` choice), not the Responses shapes.
- `output` items, in order:
  1. Reasoning item when `choices[0].message.reasoning_content` (fallback `reasoning`) is non-empty: `{"id":"rs_<id without leading resp_>","type":"reasoning","encrypted_content":"","summary":[{"type":"summary_text","text":"<text>"}]}` (summary `[]` when the text is empty — only reachable via request-field paths that cannot occur through this translator in practice).
  2. Per choice with non-empty string `message.content`: `{"id":"msg_<response id>_<choice index>","type":"message","status":"completed|incomplete","content":[{"type":"output_text","annotations":[],"logprobs":[],"text":"<content>"}],"role":"assistant"}`.
  3. Per `message.tool_calls[]` entry: `{"id":"fc_<call id>","type":"function_call","status":"...","arguments":"<arguments>","call_id":"<call id>","name":"<resolved name>"[, "namespace":"<ns>"]}` — or, when the call name matches a declared custom tool, `{"id":"ctc_<call id>","type":"custom_tool_call","status":"...","input":"<unwrapped input>","call_id":"...","name":"..."}`. Missing tool-call ids are synthesized `call_<response id>_<choice ix>_<tc ix>`. The item `name`/`namespace` are reverse-resolved from the request's tool declarations (§3.1.2 rules; flat declared names win over later namespace collisions; ambiguous names stay as-is). Custom-tool `input` = the `input` field of the JSON arguments when present, else the raw arguments string.
  - Item `status` = `incomplete` when the response is incomplete, else `completed`.
- `usage`: mapped from the chat `usage` when any of `prompt_tokens`/`completion_tokens`/`total_tokens` exists. The translator sets the base keys in this order: `input_tokens` = prompt_tokens, `input_tokens_details.cached_tokens` (only when upstream has `prompt_tokens_details.cached_tokens`), `output_tokens` = completion_tokens, `output_tokens_details.reasoning_tokens` (only when upstream has it), `total_tokens`. The final BYTE order then follows the two-phase rule of §8-4: the executor post-step (`EnsureResponsesUsageDetails`) appends the two missing detail objects AFTER `total_tokens` (`output_tokens_details.reasoning_tokens: 0` first, then `input_tokens_details.cached_tokens: 0`), so a plain `{prompt_tokens,completion_tokens,total_tokens}` upstream yields `{"input_tokens":9,"output_tokens":6,"total_tokens":15,"output_tokens_details":{"reasoning_tokens":0},"input_tokens_details":{"cached_tokens":0}}` (golden S2d6-nostream-basic). If the chat usage has NONE of the three base fields, the whole upstream `usage` object is copied verbatim instead (then detail-ensured the same way).
- **Executor post-step (must):** `EnsureResponsesUsageDetails` appends `usage.output_tokens_details.reasoning_tokens: 0` and `usage.input_tokens_details.cached_tokens: 0` (in that order) whenever a `usage` object exists and lacks them. Net effect for a plain `{prompt_tokens,completion_tokens,total_tokens}` upstream: `{"input_tokens":N,"output_tokens":M,"total_tokens":T,"output_tokens_details":{"reasoning_tokens":0},"input_tokens_details":{"cached_tokens":0}}`.
- Non-string/structured upstream values: message content must be a string; non-string content is stringified.

### 3.4 Stream event payloads (chat SSE → Responses SSE)

Source: `ConvertOpenAIChatCompletionsResponseToOpenAIResponses`. Templates below are byte-templates; the translator fills them in place (sjson). Sequence numbers start at 1 and increment by exactly 1 per emitted event.

State machine (per upstream stream):
- First accepted chunk (a `chat.completion.chunk` object carrying a `choices` array — an EMPTY `choices` array is accepted): emit `response.created` then `response.in_progress`, both carrying `response.id` = upstream chunk `id`, `response.created_at` = upstream `created`, and `response.model` = **the client-requested model name** (`RequestModelName(originalRequestRawJSON, ...)`, i.e. the alias `mock-model`; falls back to the resolved name when the original is unavailable). `response.created` has `status:"in_progress"`, `background:false`, `error:null`, `output:[]`; `response.in_progress` has `status:"in_progress"`, `output:[]` (no `background`/`error` fields).
- A `[DONE]` arriving BEFORE any chunk carrying a `choices` array is DROPPED untranslated — the translator returns no events (`isDone && !st.Started`), the stream closes with zero translated frames, and the request fails through the conductor `empty_stream` path (§5.3, golden S2d6-stream-empty200).
- `choices[].delta.reasoning_content` (fallback `reasoning`) non-empty: first occurrence allocates output index N and emits `response.output_item.added` with item `{"id":"rs_<response id>_<choice index>","type":"reasoning","status":"in_progress","summary":[]}`, then `response.reasoning_summary_part.added` (part `{"type":"summary_text","text":""}`); every occurrence emits `response.reasoning_summary_text.delta` with the incremental text.
- `choices[].delta.content` non-empty: stops reasoning first (see below), then for the choice index: first text emits `response.output_item.added` with item `{"id":"msg_<response id>_<choice index>","type":"message","status":"in_progress","content":[],"role":"assistant"}` and `response.content_part.added` with part `{"type":"output_text","annotations":[],"logprobs":[],"text":""}`; every occurrence emits `response.output_text.delta` with `delta` = the chunk text and `logprobs:[]`.
- `choices[].delta.tool_calls[]`: stops reasoning; closes an open message item for that choice index (message-done event set); per tool-call entry keyed by `(choice index, tool-call index)`: allocates an output index on first fragment; records id/name; emits `response.output_item.added` for the tool item once BOTH call id and name are known (or forcibly at finalize): item `{"id":"fc_<call id>","type":"function_call","status":"in_progress","arguments":"","call_id":"<call id>","name":"<resolved name>"[, "namespace":...]}` — or the `custom_tool_call` variant `{"id":"ctc_<call id>","type":"custom_tool_call","status":"in_progress","input":"","call_id":"...","name":"..."}` when the name matches a declared custom tool. Synthesized call id when absent: `call_<response id>_<choice ix>_<tool ix>`. Argument fragments are buffered and re-emitted as `response.function_call_arguments.delta` events carrying `item_id` `fc_<call id>`. Custom tool calls receive NO argument-delta events.
- `choices[].finish_reason` non-empty: recorded; finalizes all open items (§4.2 done-sets). `length`/`max_tokens` → terminal `response.incomplete`; `content_filter` → `response.incomplete` with `content_filter` reason; otherwise terminal `response.completed`.
- Usage: any chunk with `usage` records `prompt_tokens`(+`prompt_tokens_details.cached_tokens`), `completion_tokens` (fallback `output_tokens`), `output_tokens_details.reasoning_tokens` (fallback `completion_tokens_details.reasoning_tokens`), `total_tokens`. Chunks whose `object` is present and ≠ `chat.completion.chunk`, or without a `choices` array, are silently DROPPED (after usage capture).
- `[DONE]`: finalizes open items, emits the terminal event (§4.3), and is NOT forwarded downstream.
- Key order in `response.created`/`response.in_progress`: `model` is APPENDED after `output` — `..."error":null,"output":[],"model":"<requested>"}` for created and `..."status":"in_progress","output":[],"model":"<requested>"}` for in_progress (goldens S2d6-stream-*).

### 3.5 Usage mapping summary (both directions)

| Upstream (chat) | Downstream (Responses) |
|---|---|
| `prompt_tokens` | `usage.input_tokens` |
| `prompt_tokens_details.cached_tokens` | `usage.input_tokens_details.cached_tokens` |
| `completion_tokens` (fallback `output_tokens`) | `usage.output_tokens` |
| `output_tokens_details.reasoning_tokens` (fallback `completion_tokens_details.reasoning_tokens`) | `usage.output_tokens_details.reasoning_tokens` |
| `total_tokens` | `usage.total_tokens`; when 0, `input_tokens + output_tokens` (stream path only) |

Stream `response.completed/incomplete` usage key order: `input_tokens`, `input_tokens_details.cached_tokens` (ALWAYS written by the terminal-event builder, 0 when the upstream sent none), `output_tokens`, `total_tokens` (fallback `input_tokens + output_tokens` when the upstream total is 0), then `output_tokens_details.reasoning_tokens: 0` appended LAST by `EnsureResponsesUsageDetails`. The stream path DOES run `EnsureResponsesUsageDetails` — once per translated chunk — via `helps.TranslateStreamWithClaudeInputTokens` (`if responseFormat == FormatOpenAIResponse { chunks[i] = EnsureResponsesUsageDetails(chunk) }`, evidence: `internal/runtime/executor/helps/claude_input_tokens.go`, called for every chunk in `openai_compat_executor.go` `ExecuteStream`). Recorded shape for a plain `{prompt_tokens,completion_tokens,total_tokens}` upstream (golden S2d6-stream-usage-incomplete): `{"input_tokens":9,"input_tokens_details":{"cached_tokens":0},"output_tokens":6,"total_tokens":15,"output_tokens_details":{"reasoning_tokens":0}}`. The TRUE asymmetry vs the non-stream path (§3.3) is the POSITION of the usage-details keys, not their presence: non-stream appends BOTH detail objects AFTER `total_tokens` (order `output_tokens_details` then `input_tokens_details`, see §8-4); stream writes `input_tokens_details.cached_tokens` inline (2nd key, from the terminal-event builder) and appends only `output_tokens_details.reasoning_tokens` after `total_tokens`. When the upstream reports reasoning tokens > 0, the terminal-event builder writes `output_tokens_details.reasoning_tokens` BEFORE `total_tokens` (key order `input_tokens, input_tokens_details.cached_tokens, output_tokens, output_tokens_details.reasoning_tokens, total_tokens`), and `EnsureResponsesUsageDetails` then finds both detail objects present and performs NO append (source-cited: `openai_openai-responses_response.go` `buildResponsesCompletedEvent` usage block + `responses_usage_helpers.go`; no golden — unit-test level for implementers).
Both shapes are MUST and pinned by goldens.

---

## 4. Streaming rules (byte-level)

### 4.1 Downstream SSE framing

- Downstream headers, set ONLY once the first translated data frame exists (headers are committed together with the first flushed frames): `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`, `Access-Control-Allow-Origin: *`, plus the middleware CORS block (S1). HTTP status 200. Evidence: `handleStreamingResponse` `setSSEHeaders` + bootstrap loop.
- Every event is written as exactly: `event: <type>\ndata: <json>\n\n` (single space after each colon; LF endings; no `id:`/`retry:` lines). Evidence: `SSEEventData` (`internal/translator/common/bytes.go`) + `writeResponsesSSEChunk` (`openai_responses_handlers.go`) appending the frame terminator.
- There is NO `[DONE]` marker downstream. The terminal marker is the `response.completed`/`response.incomplete` event.
- After a clean close with no error, one extra `\n` byte is written after the last frame (`WriteDone` → `c.Writer.Write([]byte("\n"))`); evidence: `forwardResponsesStream` options + `stream_forwarder.go`. Byte rule: the body ends with `data: {...}\n\n\n`.
- Events after a terminal event (`response.completed`, `response.incomplete`, `response.failed`, `error`) are DROPPED by the downstream framer (`responsesSSEFramer.terminalEvent`).
- OPTIONAL (config-gated, OFF in anchor): `: keep-alive\n\n` comment heartbeats (`streaming.keep-alive-seconds` > 0).
- **R-SSE binding (SPEC.md §5):** the reference gateway re-chunks SSE transport frames nondeterministically between runs. Contract comparisons for every §4 requirement bind to the DECODED SSE event sequence — event name plus data-payload bytes, in order — never to raw transport chunk boundaries; the volatility whitelist (Date, X-Cpa-Trace-Id, port numbers) still applies on top. The per-event byte templates in this section are the decoded-frame contract.

### 4.2 Event sequence catalog (MUST; sequence numbers strictly +1)

Text-only stream (one choice, text then finish):
```
response.created (seq 1)
response.in_progress (seq 2)
response.output_item.added (message, output_index 0) (seq 3)
response.content_part.added (content_index 0) (seq 4)
response.output_text.delta (per content chunk) (seq 5…)
response.output_text.done (full text)  ┐
response.content_part.done             ├ emitted in this order at finish_reason
response.output_item.done (message)    ┘
response.completed | response.incomplete (at [DONE])
```
Done-set templates (message):
- `response.output_text.done`: `{"type":"response.output_text.done","sequence_number":N,"item_id":"msg_<rid>_<ix>","output_index":O,"content_index":0,"text":"<full>","logprobs":[]}`
- `response.content_part.done`: `{"type":"response.content_part.done","sequence_number":N,"item_id":"...","output_index":O,"content_index":0,"part":{"type":"output_text","annotations":[],"logprobs":[],"text":"<full>"}}`
- `response.output_item.done`: `{"type":"response.output_item.done","sequence_number":N,"output_index":O,"item":{"id":"msg_<rid>_<ix>","type":"message","status":"completed|incomplete","content":[{"type":"output_text","annotations":[],"logprobs":[],"text":"<full>"}],"role":"assistant"}}`

Reasoning-then-text stream: reasoning output item first (lowest output index), message item next; when the first text delta arrives, the reasoning item is closed with, in order: `response.reasoning_summary_text.done` (`text` = full reasoning), `response.reasoning_summary_part.done` (`part` = `{"type":"summary_text","text":...}`), `response.output_item.done` with item `{"id":"rs_...","type":"reasoning","encrypted_content":"","summary":[{"type":"summary_text","text":"<full>"}]}` — note this template's key order is `item`, `output_index`, `sequence_number`.

Tool-call stream: `response.output_item.added` (function_call/custom_tool_call), `response.function_call_arguments.delta` per buffered fragment (never for custom tools), then at finish: `response.function_call_arguments.done` (`{"type":"response.function_call_arguments.done","sequence_number":N,"item_id":"fc_<call id>","output_index":O,"arguments":"<full>"}`) + `response.output_item.done` (function_call item, status per completeness); custom tools instead emit `response.custom_tool_call_input.done` + `response.output_item.done` (custom_tool_call item).

Edge MUSTs:
- A stream that ends (finish_reason or EOF) with an open tool call whose buffered arguments are empty or invalid JSON, and NO finish_reason, does NOT synthesize an empty tool item (silent drop; `finalizeOpenItems` rule).
- A finish_reason with no open items emits only the terminal event at `[DONE]`.
- Message items are keyed by upstream `choices[].index`; each index gets its own output index and message id. Multiple choices produce interleaved-but-indexed items (OPTIONAL to pin beyond index 0).
- The terminal-event builder at `[DONE]` SUPPRESSES `response.completed`/`response.incomplete` when NO message item and NO function item was ever added: a reasoning-only stream still emits the reasoning done-set at finalize (`response.reasoning_summary_text.done`, `response.reasoning_summary_part.done`, `response.output_item.done`), but NO terminal event follows (early return on `len(MsgItemAdded) == 0 && len(FuncItemAdded) == 0`; evidence: `openai_openai-responses_response.go` isDone branch). The stream then terminates via the handler CloseError variant (§5.2), not via a terminal event — golden S2d6-stream-closeterminal.

### 4.3 Terminal event (`response.completed` / `response.incomplete`)

Template:
```json
{"type":"","sequence_number":0,"response":{"id":"","object":"response","created_at":0,"status":"","background":false,"error":null}}
```
- `response` key order: `id`, `object`, `created_at`, `status`, `background`, `error`, then — only when present, in this order — `incomplete_details`, `instructions`, `max_output_tokens`, `max_tool_calls`, `model`, `parallel_tool_calls`, `previous_response_id`, `prompt_cache_key`, `reasoning`, `safety_identifier`, `service_tier`, `store`, `temperature`, `text`, `tool_choice`, `tools`, `top_logprobs`, `top_p`, `truncation`, `user`, `metadata`, `output`, `usage`.
- **Echo source is the ORIGINAL Responses request** (asymmetry with non-stream §3.3 — MUST): `response.model` = client alias (`mock-model`); `reasoning`, `text`, `tools`, `tool_choice`, `temperature`, `top_p`, `user`, `store`, `instructions`, `max_output_tokens` etc. echo the original request values verbatim when present.
- `output`: every completed output item in output-index order: reasoning items as `{"id":"rs_...","type":"reasoning","summary":[{"type":"summary_text","text":...}]}` (NO `encrypted_content` here — asymmetry with the done-event item), message items (same shape as the message `output_item.done` item), function_call items `{"id":"fc_<call id>","type":"function_call","status":"...","arguments":...,"call_id":...,"name":...[, "namespace":...]}` / custom `{"id":"ctc_...","type":"custom_tool_call","status":"...","input":...,"call_id":...,"name":...}`. Only tool calls that reached their done-set are included. Omitted entirely when no items exist.
- `usage`: §3.5 stream shape; present only when usage was seen.
- Incomplete (`length`/`max_tokens`/`content_filter`): type `response.incomplete`, `response.status:"incomplete"`, `response.incomplete_details` `{"reason":"max_output_tokens"}` (or `{"reason":"content_filter"}`); message/tool item statuses inside `output` are `incomplete` too.

### 4.4 Mid-stream failures after the first frame

- HTTP stays **200** with SSE headers already sent; the failure is appended as a terminal SSE error frame (§5.2).

---

## 5. Error semantics

### 5.1 Errors before the first SSE frame (stream) / all non-stream errors

- Non-stream upstream HTTP errors: the upstream STATUS and BODY pass downstream. The body text (the raw upstream response body) is passed through `BuildErrorResponseBodyWithError`: when it is valid JSON it is returned VERBATIM, otherwise it is wrapped as `{"error":{"message":"<text>","type":"invalid_request_error|authentication_error|permission_error|rate_limit_error|server_error","code":"<status-derived code>"}}` (evidence: `sdk/api/handlers/handlers.go`). This matches the recorded wire fact "upstream 429 body+status passes downstream VERBATIM".
- Stream requests whose upstream call fails before any translated frame exists (e.g. HTTP 429 on the upstream SSE request): the client receives a **JSON error response, NOT SSE** — same status, `Content-Type: application/json`, but the body goes through the Responses stream-error sanitizer (`sanitizeResponsesInitialErrorMessage` → `responsesStreamErrorText`): a JSON body's `error` (or `response.error`) object is extracted, sensitive keys redacted, string values truncated at 2048 chars, and RE-MARSHALED — Go map marshaling sorts keys, so the body has alphabetically sorted keys inside `error`. Status <400 or >599 is normalized to 500. (Evidence: `openai_responses_handlers.go` bootstrap branch + `responsesStreamErrorText`.) **CONFIRMED by goldens**: the mock 429 body `{"error": {"message": "mock rate limit", "type": "rate_limit_exceeded", "code": 429, "status": "RESOURCE_EXHAUSTED"}}` reached the client VERBATIM (original order/spacing) on the non-stream path (S2d6-error-nostream-429), while the stream pre-frame path (S2d6-error-stream-429) recorded `{"error":{"code":429,"message":"mock rate limit","status":"RESOURCE_EXHAUSTED","type":"rate_limit_exceeded"}}` — the same error object re-marshaled compact with sorted keys. The wire note "upstream 429 body+status passes downstream VERBATIM" therefore extends to Responses non-stream clients, and the sanitizer distinction is stream-only.
- Model-not-found / auth / body errors: §2.1 statuses and shapes.
- The credential that received an upstream 429 enters a ~1s rate-limit cooldown that `transient-error-cooldown-seconds: -1` does NOT disable (recorded wire fact); the next request during cooldown gets HTTP 500 `{"error":{"code":"model_cooldown","last_upstream_error":"<verbatim>","message":"All credentials for model <m> are cooling down via provider <p> (last error: <summary>)"}}`. Recording order for fixtures: record 429 cases last, or wait >1s after them.

### 5.2 In-stream failures (after ≥1 data frame)

- Terminal error frame, written after a leading `\n`: `\nevent: <failureEvent>\ndata: <chunk>\n\n` where `failureEvent` is `error` for normal clients and `response.failed` when the request looks like a Codex client (`User-Agent` matched by the codex patterns, or `Originator` header = `codex desktop`/`codex-tui`/`codex_cli_rs`, case-insensitive, prefix matches included; evidence: `isCodexResponsesClientRequest`).
- `error` chunk (struct order, error map keys sorted): `{"type":"error","error":{"type":"<invalid_request_error|server_error>","code":"<mapped code>","message":"<sanitized>","param":null},"sequence_number":<data-frame count so far>}`. Code mapping: 401 `invalid_api_key`, 403 `insufficient_quota`, 429 `rate_limit_exceeded`, 404 `model_not_found`, 408 `request_timeout`, ≥500 `internal_server_error`, other 4xx `invalid_request_error`. The error detail may instead embed the upstream error object when the failure text is JSON with an `error`/`response.error` object (keys re-sorted). (Evidence: `openai_responses_stream_error.go` `BuildOpenAIResponsesStreamErrorChunk`.)
- `response.failed` chunk: `{"type":"response.failed","sequence_number":N,"response":{"status":"failed","error":{<same error detail>}}}`.
- Mid-stream transport failure (upstream hard-close): message = the transport error text (recorded for the fleet as `unexpected EOF`); status 500 → `server_error`/`internal_server_error`. Client HTTP stays 200.
- Handler CloseError variant (no terminal event seen): when the upstream data channel closes cleanly but the framer never observed a terminal event (e.g. the §4.2 suppression case), the handler appends the in-stream terminal frame `
event: error
data: {"type":"error","error":{"code":"internal_server_error","message":"upstream stream closed before a terminal event (last event: <last event type>)","param":null,"type":"server_error"},"sequence_number":<data-frame count>}

` — status 502-classified `server_error`/`internal_server_error`, HTTP stays **200** (headers already committed); `<last event type>` is the last forwarded event name and the sequence number equals the data-frame count at close (evidence: `forwardResponsesStream` `CloseError`; golden S2d6-stream-closeterminal: last event `response.output_item.done`, sequence_number 8).
- Upstream `event: error`/`response.error`/`response.failed` SSE frames, and data payloads containing `error`/`response.error` objects (or top-level `code`+`message`), are classified as stream errors by the chat-upstream reader (evidence: `openAICompatStreamDataError`), which terminates the stream with the same terminal-error rules.

### 5.3 Missing terminal marker (Responses-specific MUST)

- A chat upstream stream that ends CLEANLY (chunked terminator present) but never sent `data: [DONE]` is a FAILURE for Responses clients — never completed from EOF alone (evidence: `openai_compat_executor.go` `ExecuteStream` end: `if responseFormat == FormatOpenAIResponse { … "upstream stream closed before [DONE]" }`; contrast: chat-completions clients synthesize `[DONE]`). The already-forwarded frames stay; the stream then terminates with the §5.2 error frame: message `upstream stream closed before [DONE]`, status 502.
- The mock fleet's original happy stream has NO `[DONE]`; every happy-path stream fixture therefore requires the extended mock (§6 recording requirements).
- **Zero-translated-frames rule (recorded):** an upstream 200 SSE stream that produces NO translatable frames (e.g. a body containing ONLY `data: [DONE]`) is classified by the auth conductor as an `empty_stream` failure — NOT by the handler's own 502 construction. The conductor returns `Error{Code:"empty_stream", Message:"upstream stream closed before first payload"}` when the stream channel closes with zero buffered chunks (evidence: `sdk/cliproxy/auth/conductor_stream.go` `executeStreamMixedOnce`: `if closed && len(buffered) == 0`; error rendering `Code + ": " + Message` in `sdk/cliproxy/auth/errors.go` `Error.Error()`; `HTTPStatus` unset). Downstream: HTTP **500**, `Content-Type: application/json`, body `{"error":{"message":"empty_stream: upstream stream closed before first payload","type":"server_error","code":"internal_server_error"}}` (struct order message,type,code) — golden S2d6-stream-empty200. The handler-level 502 "upstream stream closed before first payload" construction (`openai_responses_handlers.go` bootstrap) is preempted on this path by the conductor error.

### 5.4 Status-code table (downstream)

| Condition | Status | Body |
|---|---|---|
| Non-stream success | 200 | Responses JSON (§3.3) |
| Stream success | 200 | SSE (§4) |
| Missing/invalid API key | 401 | `{"error":"Missing API key"}` / `{"error":"Invalid API key"}` |
| Unknown model | 400 | model_not_found shape (§2.1) |
| compact with `stream:true` | 400 | `{"error":{"message":"Streaming not supported for compact responses","type":"invalid_request_error"}}` |
| Upstream HTTP error, non-stream | upstream status | upstream body verbatim if valid JSON, else wrapped (§5.1) |
| Upstream HTTP error, stream, before first frame | upstream status | sanitized JSON error (§5.1) |
| Upstream HTTP error, stream, mid-stream | 200 (already committed) | terminal SSE error frame (§5.2) |
| Upstream hard-close mid-stream | 200 | terminal SSE error frame, message `unexpected EOF` |
| Clean EOF without `[DONE]` | 200 (frames already committed) | terminal SSE error frame, message `upstream stream closed before [DONE]` |
| Upstream 200 SSE with zero translatable frames (only `[DONE]`) | 500 | JSON `{"error":{"message":"empty_stream: upstream stream closed before first payload","type":"server_error","code":"internal_server_error"}}` (conductor `empty_stream` classification, §5.3) |
| Cooldown active | 500 | `model_cooldown` shape (§5.1) |

---

## 6. Golden samples index

Recordings: CLIProxyAPI v7.3.4 (docker image digest `sha256:97825da3009f98acf78b5c172fde650a5fbe7a690950a69ce6d7b535d77d4266`), oracle env per `reports/oracle/BOOTSTRAP.md` §3 with the mock fleet of §8. Recording stack ports are assigned per oracle worker (worker-1 stack: reference + openai mock per `probes/mocks/README.md`; port substitutions per orchestrator routing). ALL port numbers and the `host.docker.internal:<port>` base-urls are masked dynamic fields in fixtures — substitution expected, never byte-compared. Config: openai-compatibility provider `mock-openai` with model `mock-gpt-model` alias `mock-model`, api-key `mock-upstream-key`; `api-keys:["oracle-local-key-1"]`, `request-retry:0`, `transient-error-cooldown-seconds:-1`, `usage-statistics-enabled:false`. `oracle-local-key-1` in fixtures is not a secret.

Fixtures live in `tests/fixtures/S2d6/<case-id>/` per the RECIPES layout (`meta.yaml`, `request.http`, `downstream.md`, `upstream.jsonl`, `mock-response.json`). All S2d6 behaviors are RECORDABLE-LOCALLY (client protocol Responses over an api-key/base-url-override upstream — R-FIXTURE). Mock requirement (oracle): the openai mock must be extended with (a) a `data: [DONE]` terminator on its happy SSE (without it every stream golden degrades to §5.3), (b) per-case scripted reply variants, selectable via control file key or `X-Mock-Variant` header (strip control headers before wire logging), (c) a `POST /v1/responses/compact` route. Required variants are listed per case below; exact scripted payloads are specified in `spec/recordings/S2d6.cases.json`.

| case-id | purpose | mock mode / variant | dynamic fields (mask) |
|---|---|---|---|
| S2d6-nostream-basic | instructions→system message; whitelist drop (temperature/top_p/user/store absent upstream); upstream body field order; downstream non-stream shape incl. `model`=upstream-name quirk + ensured usage details | happy / default | Date, X-Cpa-Trace-Id |
| S2d6-nostream-roles | `developer`→`user`; `output_text`→text part; assistant echo content | happy / default | Date, X-Cpa-Trace-Id |
| S2d6-nostream-image | `input_image` with `detail:"original"` → `image_url` part with `detail:"high"`; part order preserved | happy / default | Date, X-Cpa-Trace-Id |
| S2d6-nostream-string-input | `input` as plain string → single user message, string content | happy / default | Date, X-Cpa-Trace-Id |
| S2d6-nostream-tool-roundtrip | tools + `tool_choice` conversion; function_call/function_call_output history (string + array-output contents); orphan output → user message; reply `tool_calls` → `function_call` items; response echoes chat-shaped `tools`/`tool_choice` | happy / `tools-nonstream` | Date, X-Cpa-Trace-Id |
| S2d6-nostream-custom-tool | custom tool decl → single-input function tool; wrapped-args reply → `custom_tool_call` item with unwrapped `input` | happy / `tools-nonstream` (custom name) | Date, X-Cpa-Trace-Id |
| S2d6-nostream-namespace-tool | namespace tool → `fs__read_file` upstream; qualified reply name → item `name`+`namespace` restoration | happy / `tools-nonstream` (qualified name) | Date, X-Cpa-Trace-Id |
| S2d6-nostream-reasoning | `reasoning.effort` → `reasoning_effort`; reply `reasoning_content` → reasoning item; NO `reasoning` echo in response | happy / `reasoning-nonstream` | Date, X-Cpa-Trace-Id |
| S2d6-nostream-incomplete | finish_reason `length` → `status:"incomplete"` + `incomplete_details` + item statuses | happy / `length-nonstream` | Date, X-Cpa-Trace-Id |
| S2d6-stream-basic | full SSE sequence for text; `response.model`=alias quirk; no `[DONE]` downstream; trailing `\n`; byte-exact frames | happy / default+`[DONE]` | Date, X-Cpa-Trace-Id |
| S2d6-stream-usage-incomplete | usage chunk (empty `choices`) → stream usage shape (§3.5); finish `length` → `response.incomplete` with usage | happy / `length-usage` | Date, X-Cpa-Trace-Id |
| S2d6-stream-toolcalls | tool-call deltas → function_call event set + completed item | happy / `tools-stream` | Date, X-Cpa-Trace-Id |
| S2d6-stream-reasoning | reasoning deltas then text → reasoning item events + message events; completed echoes request `reasoning` | happy / `reasoning-stream` | Date, X-Cpa-Trace-Id |
| S2d6-stream-disconnect | hard close after 2 upstream events → terminal `event: error` frame (`unexpected EOF`), HTTP stays 200 | disconnect (after=2) | Date, X-Cpa-Trace-Id, error message if transport-prefixed |
| S2d6-stream-disconnect-codex | same with Codex client headers → terminal `event: response.failed` frame | disconnect (after=2) | Date, X-Cpa-Trace-Id, error message if transport-prefixed |
| S2d6-stream-nodone | clean chunked EOF without `[DONE]` → §5.3 error frame `upstream stream closed before [DONE]` | happy / `no-done` | Date, X-Cpa-Trace-Id |
| S2d6-stream-slow | slow-chunks mode: bytes == S2d6-stream-basic; timing in meta only (recorded-optional) | slow (300 ms) | Date, X-Cpa-Trace-Id, inter-event timing |
| S2d6-stream-empty200 | upstream 200 SSE with only `[DONE]` → conductor `empty_stream` 500 JSON (§5.3) | happy / `done-only-stream` | Date, X-Cpa-Trace-Id, ports |
| S2d6-stream-closeterminal | events but no terminal event → CloseError in-stream `event: error` frame, message `upstream stream closed before a terminal event (last event: response.output_item.done)`, sequence_number 8, HTTP 200 | happy / `reasoning-only-stream` | Date, X-Cpa-Trace-Id, ports |
| S2d6-badbody-notfound | non-JSON body → 400 `model_not_found` with empty model name (reference-only golden; NE-LENIENT strict boundary for the rewrite) | none (0 upstream hits) | Date, X-Cpa-Trace-Id, ports |
| S2d6-compact-streamfalse | compact with explicit `stream:false` → upstream body has NO `stream` key (deletion pin); reply passthrough + usage details | happy / `compact` | Date, X-Cpa-Trace-Id, ports |
| S2d6-error-nostream-429 | upstream 429 non-stream → 429 with upstream JSON body verbatim | error (429) | Date, X-Cpa-Trace-Id |
| S2d6-error-stream-429 | upstream 429 on stream → JSON 429 (not SSE) with sanitized body (key-sort pin) | error (429) | Date, X-Cpa-Trace-Id |
| S2d6-auth-missing | POST /v1/responses without key → 401 | none | Date, X-Cpa-Trace-Id |
| S2d6-model-notfound | unknown model → 400 model_not_found | none | Date, X-Cpa-Trace-Id |
| S2d6-compact-passthrough | compact → upstream `/v1/responses/compact` passthrough + usage-details injection | happy / compact route | Date, X-Cpa-Trace-Id |
| S2d6-compact-stream-rejected | compact with `stream:true` → 400 (no upstream call) | none | Date, X-Cpa-Trace-Id |

Case definitions with exact requests and scripted upstream replies: `spec/recordings/S2d6.cases.json`. **Recording status (2026-09-16): ALL 27 cases recorded** (23 round-1 + 4 round-1-review follow-up goldens authorized by `reports/adversary/S2d6.md` N1) by @oracle-runner into `tests/fixtures/S2d6/<case-id>/` (full RECIPES layout, `mock-response.json` for every scripted case). Recorded downstream statuses: 20x for all happy/stream cases; 401 auth-missing; 400 model-notfound + compact-stream-rejected; 429 both error cases; the three no-upstream cases verified EMPTY `upstream.jsonl`. Recording-order fact: the two 429 cases ran last with a ~2.5s gap — the first 429's ~1s rate-limit cooldown otherwise starves the second case of its upstream hit (a request during cooldown would return the 500 `model_cooldown` body instead of the upstream 429). The mock's served 429 body was `{"error": {"message": "mock rate limit", "type": "rate_limit_exceeded", "code": 429, "status": "RESOURCE_EXHAUSTED"}}`; re-recordings must replay that body to reproduce the fixtures byte-exactly. Byte-verification spot checks against the section's derived templates passed for stream-basic (9-event sequence), stream-nodone (terminal error frame, sequence_number 8), both disconnect cases (terminal frames, sequence_number 5), stream-closeterminal (8 frames + CloseError terminal frame, sequence_number 8), badbody-notfound (trailing-space message, empty upstream log), compact-passthrough and compact-streamfalse (upstream path + usage-details injection order), both 429 cases, and the usage SHAPES on both paths (§3.3 non-stream order and §3.5 stream order, including the appended detail positions). One recorded divergence, fixture-authoritative: S2d6-stream-empty200 recorded HTTP 500 with an `empty_stream: ` message prefix where the source-derived hint said 502 without prefix (§5.3 documents the conductor mechanism).

Recorded-optional:
- S2d6-stream-slow — RECORDED (mock `slow` mode, 300 ms inter-event delay): byte stream equals S2d6-stream-basic; timing is recorded in `meta.yaml` dynamic fields only, never byte-compared.

DEFERRED (specified, not recorded):
- Multi-choice streams (`choices[].index > 0`): the reference translator keys message buffers per choice index; no golden (no production upstream emits multi-choice chat completions in scope). Implementers must still follow §3.4/§4.2 index rules (unit-test level).
- Codex-WebSocket transport (`GET /v1/responses` upgrade) — out of scope (§1).

---

## 7. Classification (RECORDABLE-LOCALLY vs CREDENTIALED-ONLY)

RECORDABLE-LOCALLY (R-FIXTURE): everything in §6 — Responses client protocol over an `openai-compatibility` api-key upstream with `base-url` override.

CREDENTIALED-ONLY: none for S2d6. (Responses clients against OAuth-attached upstreams — Codex OAuth chatgpt.com etc. — are S2d9/S2d5 territory.)

---

## 8. Open questions and intentional non-equivalences

1. **Non-stream vs stream echo asymmetry** (recorded-by-design): non-stream responses echo `model` as the resolved UPSTREAM name and echo `tools`/`tool_choice` in chat shapes, while stream terminal events echo the ORIGINAL request fields (`model` = client alias, `tools` = Responses shapes). Both are pinned by goldens; CPA-Edge MUST reproduce the asymmetry byte-for-byte. Flagged as a candidate S7 degradation (unify echo source) — NOT decided.
2. **Stream 429 sanitization** (§5.1): RESOLVED by recording — non-stream 429 body passes VERBATIM; stream pre-frame 429 body is the sanitized re-marshal with sorted keys (golden S2d6-error-stream-429). No longer an open question.
3. **`[DONE]` strictness** (§5.3): Responses clients REQUIRE `data: [DONE]` from chat upstreams; chat-completions clients do not (EOF synthesizes DONE). This asymmetry is intentional upstream behavior; CPA-Edge MUST keep it (testable via S2d6-stream-nodone).
4. The non-stream `usage` key order (input, output, total, output_tokens_details, input_tokens_details — details appended by the executor post-step in reverse-name order) is an sjson append artifact. MUST reproduce byte-exactly; flagged for S7 normalization review.
5. `EnsureResponsesUsageDetails` runs on BOTH paths — non-stream once on the final body, stream once per translated chunk (`helps.TranslateStreamWithClaudeInputTokens`). The recorded asymmetry is the POSITION of the appended detail keys (§3.3/§3.5): non-stream final order `input, output, total, output_tokens_details, input_tokens_details` (both appended after `total_tokens`); stream final order `input, input_tokens_details, output, total, output_tokens_details` (`input_tokens_details` inline from the terminal-event builder, `output_tokens_details` appended after `total_tokens`). Both orders are sjson append artifacts; MUST reproduce byte-exactly (goldens S2d6-nostream-basic, S2d6-stream-usage-incomplete); flagged as a candidate S7 normalization.
6. Compact passthrough (§2.4) injects usage-details into an otherwise verbatim upstream body. Whether CPA-Edge's Store/passthrough layer reproduces the sjson append order is deferred to the S2d9/compact golden family; S2d6-compact-passthrough records the openai-compat instance.
7. Model-suffix (`model(...)`) thinking rewriting and its interaction with `reasoning_effort` is cross-cutting (S4-adjacent); S2d6 goldens use suffix-free aliases and do not pin it.
8. The `id:`-less, `retry:`-less SSE framing and the trailing lone `\n` (§4.1) are byte-pinned; any client-visible "improvement" (e.g. emitting `[DONE]` for Responses clients) is a registered degradation, not a fix.
