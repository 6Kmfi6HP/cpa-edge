# S2d8 — Claude client → Gemini upstream (gemini-api-key)

Section id: S2d8. Direction: Anthropic Messages-protocol client → Google Gemini `generateContent` upstream reached through a `gemini-api-key` credential.
Upstream anchor: CLIProxyAPI v7.3.4, commit `8335eac731946bd4eff18f500653f93736df53d6` (SPEC.md §0).
Upstream evidence paths in this section are relative to the upstream repo root. Recorded evidence is under `_cpa_edge_ref/probes/mocks/gemini/` and `_cpa_edge_ref/probes/mocks/README.md`.

Wire-note precedence applied: recorded gemini-upstream facts (UA `Go-http-client/1.1`, `x-goog-api-key` auth, injected `safetySettings` + `model`, `?alt=sse` streaming) come from `_cpa_edge_ref/probes/mocks/gemini/upstream.jsonl` and are treated as authoritative; source citations below agree with them.

---

## 1. Scope and boundaries

IN scope:
- Client surface: `POST /v1/messages` and `POST /v1/messages/count_tokens` with Anthropic Messages wire (evidence: `internal/api/server_routes.go` — `v1.POST("/messages", claudeCodeHandlers.ClaudeMessages)`, `v1.POST("/messages/count_tokens", claudeCodeHandlers.ClaudeCountTokens)`).
- Request translation Claude → Gemini (`ConvertClaudeRequestToGemini`, evidence: `internal/translator/gemini/claude/gemini_claude_request.go`; registration `internal/translator/gemini/claude/init.go`).
- Upstream HTTP contract of the `gemini-api-key` executor: URL, method, headers, body, SSE consumption (evidence: `internal/runtime/executor/gemini_executor.go`).
- Response translation Gemini → Claude, non-stream and SSE (evidence: `internal/translator/gemini/claude/gemini_claude_response.go`).
- Downstream error envelope for Claude clients (evidence: `sdk/api/handlers/claude/code_handlers.go`).
- `count_tokens` end-to-end.

OUT of scope (owned elsewhere or not covered):
- Endpoint inventory, auth middleware, CORS block, R-404 — S1 (cross-referenced below; same bytes).
- Credential selection, rotation, cooldown algorithms, aliases as a routing feature — S4. S2d8 fixes the *bytes* given a resolved credential; the alias→upstream-model rewrite appears here only because it is visible in goldens.
- Gemini OAuth upstreams (Gemini CLI / AI Studio / Antigravity at `cloudcode-pa.googleapis.com`) — CREDENTIALED-ONLY per R-FIXTURE; see §7.
- `gemini-interactions` credentials: a Claude client routed to a `gemini-interactions` auth takes the native Interactions path (`internal/runtime/executor/gemini_executor.go` `shouldExecuteNativeInteractions`), a different upstream wire (`POST /v1beta/interactions`, `Api-Revision: 2026-05-20`). OUT OF CHARTER for v1 per orchestrator ruling; registered as a known gap to be quantified at the D2 global audit. Not specified here.
- Vertex (`vertex-api-key`): same translator, different URL scheme and auth; see §7 open questions.
- Thinking *capability semantics* (suffix parsing, clamping, validation errors, and how a model's capability info gets resolved): S4. S2d8 specifies the two client-visible outcomes of the executor capability pass for this direction only — user-defined/unresolved models keep the mapped `thinkingConfig`; capability-resolved models without thinking support have it stripped (§3.1 `thinking` row, golden-pinned by S2d8-07/10).
- Plugin interceptors, request/response plugins: absent in recordings; behavior below is the no-plugin baseline.

NE-LENIENT acknowledgment: SPEC §5's compatibility-ruling registry (R-404, R-FIXTURE, NE-LENIENT, R-SSE, R-TOK, and any future registered degradations) applies VERBATIM to the `/v1/messages` and `/v1/messages/count_tokens` surfaces; S2d8 registers no direction-specific leniency or non-equivalence beyond §7/§8.

---

## 2. Behavior inventory

### 2.1 Routes, methods, statuses (client side)

| Route | Method | Success | Notes |
|---|---|---|---|
| `/v1/messages` | POST | 200 | Body is a Claude Messages request. `stream:true` → SSE; `stream` absent or `false` → JSON. (evidence: `sdk/api/handlers/claude/code_handlers.go` `ClaudeMessages`) |
| `/v1/messages/count_tokens` | POST | 200 | JSON in/out. |
| any other method on these paths | — | 404 empty | R-404 (SPEC.md §5). |

- Auth: the `/v1/messages` surfaces share S1's FULL 5-transport matrix — `Authorization: Bearer <key>` or the key verbatim, `X-Goog-Api-Key`, `X-Api-Key`, `?key=`, `?auth_token=`; non-Bearer `Authorization` schemes are rejected whole (S1 rule; golden S1-26). The direction module's internal facade gate implements only the Bearer/X-Api-Key subset as a HARNESS CONVENIENCE; the runtime route layer owns the full matrix. Failure shapes are S1's: 401 `{"error":"Missing API key"}` / `{"error":"Invalid API key"}` (recorded bootstrap probes).
- Non-stream success: `Content-Type: application/json`, status 200, body = §3.4 message JSON.
- Stream success: SSE headers set only when the first translated chunk is available (never on error-before-first-chunk): `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`, `Access-Control-Allow-Origin: *` (evidence: `handleStreamingResponse`).
- Unroutable model → 400, ZERO upstream dispatch, Claude envelope `{"type":"error","error":{"type":"invalid_request_error","message":"unknown provider for model <model>"}}` with the requested client model string in the message (golden S2d8-19; §3.1 routing note).
- Non-JSON body → 400, ZERO upstream dispatch: no model can be parsed, so the same routing error fires with an EMPTY model name: `{"type":"error","error":{"type":"invalid_request_error","message":"unknown provider for model"}}` (golden S2d8-20). The Claude envelope TRIMS the message text (no trailing space, no model name) — the Responses surface relays the untrimmed variant with a trailing space in the empty-model case (S2d6 badbody golden); the trim comes from the Claude handler's `strings.TrimSpace` on the error text (evidence: `claudeErrorDetailFromText`).
- Routing-stage 400s carry NO `X-Cpa-Trace-Id` response header (recorded S2d8-19/20; execution-stage responses do carry it).
- A transport-level body-read failure (before any parsing) → 400 `{"error":{"message":"Invalid request: <err>","type":"invalid_request_error"}}` — the base `{"error":{...}}` shape, NOT the Claude envelope (evidence: `ClaudeMessages` `c.GetRawData` branch). Source-derived, unreachable over normal HTTP, not golden-pinned.
- Upstream response headers are NOT forwarded downstream (passthrough disabled by default; evidence: `sdk/api/handlers/handlers_interceptors.go` `downstreamHeadersFromExecutor`). Every response carries the S1 CORS block and `X-Cpa-Trace-Id`.

### 2.2 Upstream HTTP contract (gateway → Gemini mock)

Deterministic from recordings (`_cpa_edge_ref/probes/mocks/gemini/upstream.jsonl`) and source (`internal/runtime/executor/gemini_executor.go`):

| Item | Non-stream | Stream | count_tokens |
|---|---|---|---|
| Method | POST | POST | POST |
| Path | `<base>/v1beta/models/<model>:generateContent` | `<base>/v1beta/models/<model>:streamGenerateContent?alt=sse` | `<base>/v1beta/models/<model>:countTokens` |
| Headers | `Content-Type: application/json`, `x-goog-api-key: <key>`, `Accept-Encoding: gzip`, `User-Agent: Go-http-client/1.1` | same | same |
| `Authorization` | absent (never set) | absent | absent |

MUST:
- `<base>` = the credential's `base-url` (config `gemini-api-key[].base-url`), trailing `/` trimmed; default `https://generativelanguage.googleapis.com` when absent (evidence: `resolveGeminiBaseURL`).
- `<model>` = the credential-resolved upstream model name (alias rewritten; see golden S2d8-02), NOT the raw client string.
- A non-empty `alt`/`$alt` query on the client request is appended to the non-stream URL as `?$alt=<value>` (OPTIONAL; `alt=sse` normalizes to empty and never appears). Recordings use no `alt`.
- `?alt=sse` on the stream path is constant for Claude clients.
- The upstream request NEVER carries an `Accept: text/event-stream` header; stream-ness is expressed by the path only (recorded).
- Client request headers are not forwarded upstream except headers configured on the credential (OPTIONAL, config `custom-headers`; not exercised by goldens).

### 2.3 Upstream body construction order

MUST: the upstream JSON body is built in this top-level key order (observable in recorded bytes; comes from the builder in `gemini_claude_request.go` plus executor passes):

```
contents, model, systemInstruction, tools, toolConfig, generationConfig, safetySettings
```

Keys that do not apply are absent (not `null`). `safetySettings` is always present (§3.2.9).

---

## 3. Schemas

### 3.1 Claude request fields consumed

| Claude field | Mapped to Gemini | Rule |
|---|---|---|
| `model` | top-level `model` | Set to the credential-resolved upstream model (executor `SetStringIfDifferent`). The client string itself is not forwarded. Routing note (recorded S2d8, routing algorithm owned by S4): when a model entry defines an alias, the ALIAS is the only client-addressable id — requesting the upstream NAME client-side is rejected with `400 {"type":"error","error":{"type":"invalid_request_error","message":"unknown provider for model <name>"}}` and NO upstream dispatch (evidence: golden tests/fixtures/S2d8/S2d8-19-alias-rejection/ + `_cpa_edge_ref/probes/S2d8-as-written/`). All other golden requests therefore use the alias `gm`; the upstream wire shows the resolved name. The `model` field is NOT part of the input-token estimate segments (§3.5.2), so alias vs name does not change the estimate. |
| `system` (string) | `systemInstruction` = `{"parts":[{"text":<s>}]}` | No `role` key. Dropped entirely if the text is a Claude-Code attribution block. |
| `system` (array of `{type:"text",text}`) | `systemInstruction` = `{"role":"user","parts":[{"text":...},...]}` | Only `type:"text"` items; attribution items skipped; empty result → key absent. NOTE: array form carries `role:"user"`, string form does not. |
| `messages[].role` | `contents[].role` | `assistant`→`model`; `user`→`user`; `system`/`developer`→`user` reminder turn (below); any non-string role: message skipped. |
| `messages[].content` (string) | one `{"text":<s>}` part | — |
| `messages[].content[]` `{"type":"text"}` | `{"text":<s>}` part | Empty text `""` skipped. |
| `messages[].content[]` `{"type":"thinking"}` | DROPPED | API-key path never preserves thinking blocks (the compat variant that keeps them is not reachable via `gemini-api-key`). |
| `{"type":"tool_use"}` | part `{"thoughtSignature":"skip_thought_signature_validator","functionCall":{"id":<id>,"name":<sanitized>,"args":<raw>}}` | Emitted only when `input` is a valid JSON object; `id` key present only when the Claude `id` is non-empty; `args` = the raw input JSON bytes as received. `functionCall.id` is a non-standard passthrough key the upstream accepts. |
| `{"type":"tool_result"}` | part `{"functionResponse":{"id":<tool_use_id>,"name":<fn>,"response":{"result":<r>}}}` | `tool_use_id` empty → block skipped. `<fn>` resolution: name of the matching earlier `tool_use` in this request; else the `tool_use_id` with its last `-`-segment removed; else the `tool_use_id` itself; then identifier-sanitized. `<r>`: see §3.2.8. Base64 images inside the result become separate `{"inline_data":{"mime_type":...,"data":...}}` parts appended after the `functionResponse` part. |
| `{"type":"image"}` (source.type base64) | `{"inline_data":{"mime_type":<media_type>,"data":<data>}}` | Skipped when `media_type` or `data` empty; non-base64 sources skipped. |
| `tools[]` | `tools:[{"functionDeclarations":[...]}]` | See §3.2.6. A tool without `input_schema` is skipped entirely. |
| `tool_choice` | `toolConfig.functionCallingConfig` | `"auto"`→`{"mode":"AUTO"}`; `"none"`→`{"mode":"NONE"}`; `"any"`→`{"mode":"ANY"}`; `{"type":"tool","name":n}`→`{"mode":"ANY","allowedFunctionNames":[<sanitized n>]}`; anything else → key absent. |
| `thinking` | two-stage: `generationConfig.thinkingConfig` then capability strip | **Stage 1 — translator mapping** (evidence: `internal/translator/gemini/claude/gemini_claude_request.go`): `{"type":"enabled","budget_tokens":N}` → `{"thinkingBudget":N}`; `{"type":"adaptive"}` or `{"type":"auto"}` with `output_config.effort` → `{"thinkingLevel":<lowercase-trimmed effort>}`; adaptive without effort → `{"thinkingBudget":<registry max>}` when the model is registered, else `{"thinkingLevel":"high"}`. **Stage 2 — executor capability pass** (evidence: `internal/runtime/executor/helps/model_capabilities.go` → `internal/thinking/apply.go`): when a model capability info is resolved for the attempt and `IsUserDefinedModel` is false (user-defined/unresolved models keep the Stage-1 config verbatim, letting the upstream validate it), a model WITHOUT thinking support (`Thinking == nil`) has `generationConfig.thinkingConfig` DELETED from the translated body — the `generationConfig` key itself REMAINS, as an empty object when it held nothing else. GOLDEN-PINNED by S2d8-07/S2d8-10: request `{"thinking":{"type":"enabled","budget_tokens":1024}}` → upstream `"generationConfig":{}`. Full capability semantics (thinking-suffix parsing, clamping, validation errors, capability resolution) are S4's; S2d8 fixes these two observable outcomes. |
| `temperature` | `generationConfig.temperature` | Only JSON numbers. |
| `top_p` | `generationConfig.topP` | Only JSON numbers. |
| `top_k` | `generationConfig.topK` | Only JSON numbers. |
| `max_tokens` | NOT mapped | Dropped. No `generationConfig.maxOutputTokens` is ever produced from it. |
| `stop_sequences` | NOT mapped | Dropped. |
| `metadata`, `stream`, `service_tier`, others | NOT mapped | Dropped. `session_id`, if present anywhere in the body, is deleted before send. |

### 3.2 Turn-level MUST rules (request side)

1. **Mid-conversation `system`/`developer` messages** become a `user` turn whose single text part is `<system-reminder>\n<j>\n</system-reminder>` where `<j>` is the message's text blocks joined with `\n` (empty and attribution texts dropped). If no text survives, the turn is dropped (evidence: `internal/translator/common/claude_system.go`). Message-level `cache_control` is not consulted.
2. **Empty turns dropped**: a message producing zero parts is not emitted.
3. **User-turn part ordering**: within a `user` content turn, if any `functionResponse` part is followed by a text part, all text parts are moved before all non-text parts (relative order preserved inside each group) (evidence: `internal/translator/common/gemini.go` `ReorderGeminiUserParts`).
4. **Adjacent `user` turns are merged**: consecutive `user` contents become one content with concatenated parts, and rule 3 is re-applied to the merged part list. Consecutive `model` turns are NEVER merged (evidence: `MergeAdjacentGeminiContents`).
5. **Tool-result alignment**: the `tool_result` blocks inside one user message are re-ordered to match the order of the preceding assistant turn's `tool_use` ids — but only when the counts match one-to-one; otherwise original order is kept (evidence: `internal/translator/common/claude_messages.go` `AlignClaudeToolResults`).
6. **Trailing model turn with unanswered calls stripped**: if the LAST content is a `model` turn containing any `functionCall` part, that whole turn is removed (prefill-with-tool-call is dropped; plain-text trailing model turns survive).
7. **Boundary user turns (executor)**: after translation, if `contents[0].role == "model"`, prepend `{"role":"user","parts":[{"text":""}]}`. If the last content has role `model`/`assistant` AND contains no `functionResponse` part, append `{"role":"user","parts":[{"text":""}]}`. Both apply to non-stream and stream (evidence: `internal/runtime/executor/helps/gemini_content_turns.go`).
8. **`tool_result` content → `response.result` encoding** (evidence: `internal/util/claude_tool_result.go`): string → plain JSON string; array with exactly 1 non-image block → that block's raw JSON; array with 2+ non-image blocks → raw JSON array of those blocks; array with only images → result `""`; single object → raw object; absent → `""`. Base64 image blocks become `inline_data` parts (dropped when `source.data` empty).
9. **`safetySettings` injection**: when the translated body has no `safetySettings` (always, for Claude requests), append exactly:
```json
[{"category":"HARM_CATEGORY_HARASSMENT","threshold":"OFF"},
 {"category":"HARM_CATEGORY_HATE_SPEECH","threshold":"OFF"},
 {"category":"HARM_CATEGORY_SEXUALLY_EXPLICIT","threshold":"OFF"},
 {"category":"HARM_CATEGORY_DANGEROUS_CONTENT","threshold":"OFF"},
 {"category":"HARM_CATEGORY_CIVIC_INTEGRITY","threshold":"BLOCK_NONE"}]
```
(evidence: `internal/translator/gemini/common/safety.go`; recorded in `upstream.jsonl`.)
10. **`thoughtSignature` policy on generated `functionCall` parts**: the translator stamps the fixed sentinel `skip_thought_signature_validator` on every `functionCall` part it synthesizes; a pre-send sanitizer then keeps it only on the FIRST `functionCall` of each `model` turn and strips it from later sibling `functionCall` parts (unsigned sibling calls match native Gemini parallel-call history). `functionResponse` parts never carry signatures (evidence: `internal/signature/gemini_sanitize.go`).
11. **Tool identifier sanitization** (evidence: `internal/util/util.go` `SanitizeFunctionName`): replace `[^a-zA-Z0-9_.:-]` with `_`; if the first character is not a letter/underscore, truncate to 63 and prepend `_`; truncate to 64. Applies to outgoing `functionDeclarations[].name`, `functionCall.name`, `functionResponse.name`, and `allowedFunctionNames` entries.
12. **count_tokens body variant**: same translation, then EXACTLY `tools`, `generationConfig`, `safetySettings` are deleted. `toolConfig` is NOT stripped: a client `tool_choice` survives as `toolConfig.functionCallingConfig` (GOLDEN-PINNED by S2d8-21: `tool_choice {"type":"auto"}` → upstream body carries `{"toolConfig":{"functionCallingConfig":{"mode":"AUTO"}}}` alongside the three stripped keys; S2d8-13 pins the complementary case — no `tool_choice` sent → no `toolConfig` key). Leading-user boundary (rule 7, prepend-only) is applied; trailing-user is NOT. (evidence: `internal/runtime/executor/gemini_executor.go` `CountTokens`; wire goldens S2d8-13/S2d8-21.)

Byte-encoding rules (all RECORDED, contract-test material):

13. **String encoding**: every string the gateway WRITES into the upstream body uses standard JSON string encoding WITH HTML escaping: `<` → `\u003c`, `>` → `\u003e`, `&` → `\u0026` (recorded case 03: the injected `<system-reminder>` text arrives upstream as `\u003csystem-reminder\u003e`).
14. **Raw passthrough preserves client bytes**: values copied verbatim — `functionCall.args` (from `tool_use.input`), `functionResponse.response.result` when raw (from `tool_result` blocks), and the schema passed to `parametersJsonSchema` — keep the CLIENT's original byte formatting (key spacing, key order). Keys the gateway ADDS or MODIFIES are serialized compactly (recorded case 04: schema keeps client spacing while the enum hint `"description":"Allowed: celsius, fahrenheit"` is appended compactly; case 05: `args":{"city": "Paris"}` keeps client spacing). An implementation that re-serializes these values will NOT be byte-exact.
15. **Generated key order** (pinned by fixtures): a `functionCall` part is `{"thoughtSignature":...,"functionCall":{"name":...,"args":...,"id":...}}` (id appended after args; `thoughtSignature` only on the first call of a turn, rule 10); a `functionResponse` part is `{"functionResponse":{"name":...,"response":...,"id":...}}`; `inline_data` parts are `{"inline_data":{"mime_type":...,"data":...}}`.
16. **Image placement within user turns**: images extracted from a `tool_result` stay immediately AFTER their own `functionResponse` part (recorded case 05: order is text, text, functionResponse(tolu_01), inline_data, functionResponse(tolu_02)); `ReorderGeminiUserParts` then only moves TEXT parts ahead of all non-text parts, preserving non-text relative order.

### 3.3 Gemini response fields consumed (both modes)

`responseId`, `modelVersion`, `candidates.0.content.parts[]`, `candidates.0.finishReason`, `usageMetadata.{promptTokenCount,candidatesTokenCount,thoughtsTokenCount,cachedContentTokenCount}`. Parts carry `text`, `thought:true`, `thoughtSignature` (or `thought_signature`), `functionCall.{name,args}`. Unknown parts are ignored.

### 3.4 Non-stream response mapping (Gemini JSON → Claude message JSON)

MUST — output template and field order (evidence: `ConvertGeminiResponseToClaudeNonStream`):

```json
{"id":"<responseId or \"\">","type":"message","role":"assistant","model":"<modelVersion or \"\">",
 "content":[...],"stop_reason":"...","stop_sequence":null,
 "usage":{"input_tokens":N,"output_tokens":M}}
```

- Content blocks built from `candidates.0.content.parts` in order:
  - plain text (non-empty) → text buffer;
  - `thought:true` OR `thoughtSignature`-carrying text → thinking buffer (thinking blocks carry `"signature":<sig>` when a signature was seen);
  - `functionCall` → `{"type":"tool_use","id":"<sanitized name>-<i>","name":<restored>,"input":<args raw or {}>}` with `i` a per-response counter starting at 1;
  - a signature-only part (no text, no functionCall) sets the pending signature and emits nothing.
  - Buffers flush at type switches so a `thinking,text,thinking,text` sequence yields `thinking,text,thinking,text` blocks in order.
- Tool name restore: upstream name → reverse-sanitize via the request's tools (`sanitized→original`), then canonical (lowercased, leading `_` trimmed) → original via the request's tools map. For unsanitized names this is identity (evidence: `internal/util/translator.go`).
- `tool_use.id` = `SanitizeClaudeToolID("<restored name>-<i>")`: characters outside `[a-zA-Z0-9_-]` become `_` (evidence: `internal/util/claude_tool_id.go`).
- `stop_reason`: any `functionCall` seen → `tool_use`; else `MAX_TOKENS` → `max_tokens`; `STOP`/`FINISH_REASON_UNSPECIFIED`/`UNKNOWN`/absent → `end_turn`.
- `usage`: `input_tokens = max(0, promptTokenCount - cachedContentTokenCount)`; `output_tokens = candidatesTokenCount + thoughtsTokenCount`; add `"cache_read_input_tokens":<cached>` only when `cachedContentTokenCount > 0`. When `input_tokens == 0 AND output_tokens == 0 AND usageMetadata is absent`, the whole `usage` key is deleted.
- Empty `content` stays `[]`.

### 3.5 Streaming SSE translation (exact event sequence)

State machine (evidence: `ConvertGeminiResponseToClaudeStream`; framing helper `internal/translator/common/bytes.go` `AppendSSEEventString`).

Framing MUST: every translated event is exactly

```
event: <name>\ndata: <payload-json>\n\n\n
```

(three newlines after the data line). All events produced from ONE upstream chunk are concatenated into one downstream write (chunk boundaries are flush boundaries; contract tests compare the concatenated byte stream).

Event sequence rules:
1. **`message_start`** — emitted with the FIRST upstream chunk, exactly once:
```json
{"type":"message_start","message":{"id":"msg_1nZdL29xx5MUA1yADyHTEsnR8uuvGzszyY","type":"message","role":"assistant","content":[],"model":"claude-3-5-sonnet-20241022","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":0,"output_tokens":0}}}
```
   `message.id` ← that chunk's `responseId`; `message.model` ← that chunk's `modelVersion`; missing → the template defaults shown. The literal default id `msg_1nZdL29xx5MUA1yADyHTEsnR8uuvGzszyY` and default model `claude-3-5-sonnet-20241022` MUST be reproduced.
2. **Input-token estimate injection** — for this direction (claude source, non-claude upstream, claude response) the first `message_start` is rewritten: `message.usage.input_tokens` := an `o200k_base` BPE count of the ORIGINAL client request. **The normative segment collector is `internal/runtime/executor/helps/claude_input_tokens.go`** (`collectClaudeInputTokenSegments` and its helpers); implementers MUST mirror its block-type table exactly. Summary: segments are trimmed, non-empty text pieces joined with `\n`, then tokenized with `o200k_base`: system (string, or `type:"text"` texts); per message the `role` string; content recursively — string content verbatim, array content per block; block types: `text`/`thinking` → `text`/`thinking` value; `document` (text source) → `title`,`context`,`source.data`,`source.content`; `tool_use`, `server_tool_use`, `mcp_tool_use` → `id`,`name`,`input` (compacted JSON); `tool_result`, `mcp_tool_result`, `web_search_tool_result`, `web_fetch_tool_result`, `code_execution_tool_result`, `bash_code_execution_tool_result`, `text_editor_code_execution_tool_result` → `tool_use_id`,`tool_call_id`, content recursively; `web_search_result`/`search_result` → string `source`, `title`, `url`, `page_age`, content recursively; `web_fetch_result` → `url`,`retrieved_at`, content recursively; `code_execution_result`/`bash_code_execution_result`/`text_editor_code_execution_result` → `stdout`,`stderr`,`return_code`, content and `output` recursively; `tool_reference` → `tool_name`; `image`, `input_audio`, `audio`, `video`, `redacted_thinking` → SKIPPED (no segment); blocks with no `type` → the whole block as compacted JSON; unknown types → their `text` field. Then tools (`type`,`name`,`description`,`input_schema` compacted) and `tool_choice`: a STRING value contributes the string itself as one segment; an object contributes `type` and `name` (evidence: `collectClaudeToolChoiceTokenSegments`). Non-stream responses do NOT get this injection. This makes `message_start.usage.input_tokens` a deterministic function of the request bytes. ORCHESTRATOR RULING S2d8-1: the orchestrator installs `js-tiktoken` (pure-JS, runtime-agnostic) into the workspace before Phase-2 dispatch; contract tests assert this field BYTE-EXACTLY (unmasked). The recorded value per golden case is authoritative; if `js-tiktoken`'s `o200k_base` disagrees with a recorded golden by a systematic delta, the implementer must replicate the reference's exact estimation function. The recorded values are therefore cited per case in §6.
3. **Text part (non-thought)** → `content_block_start` `{"index":i,"content_block":{"type":"text","text":""}}` (on transition into text) then `content_block_delta` `{"index":i,"delta":{"type":"text_delta","text":<t>}}` per part.
4. **Thought part (`thought:true` or with `thoughtSignature`)** → `content_block_start` `{"index":i,"content_block":{"type":"thinking","thinking":""}}` then `content_block_delta` `{"index":i,"delta":{"type":"thinking_delta","thinking":<t>}}`; a non-empty `thoughtSignature` on the part additionally emits `content_block_delta` `{"index":i,"delta":{"type":"signature_delta","signature":<sig>}}` after the thinking delta. A signature-only part (no text, no functionCall) emits just the signature delta.
5. **`functionCall` part** → close open block (if any) with `content_block_stop`, then `content_block_start` `{"index":i,"content_block":{"type":"tool_use","id":"<sanitized name>-<N>","name":<restored>,"input":{}}}` and, when `args` present, `content_block_delta` `{"index":i,"delta":{"type":"input_json_delta","partial_json":<args raw>}}`. `N` is a per-PROCESS monotonic counter (first call in a fresh process = 1): contract tests MUST mask the digits (whitelisted volatile; the `<name>-<digits>` shape is asserted). A follow-up functionCall with EMPTY name while a tool block is open is treated as a delta: it emits only `input_json_delta`.
6. **Transitions** — entering a new block type closes the previous one with `content_block_stop` `{"index":<old>}` and increments the index. Indices start at 0 and never repeat.
7. **Final events gate** — on a chunk that (a) has `usageMetadata`, (b) contains the substring `"finishReason"` anywhere, (c) has not fired before, and (d) at least one content event was emitted (HasContent): close any open block with `content_block_stop`, then `message_delta`:
```json
{"type":"message_delta","delta":{"stop_reason":"<end_turn|tool_use|max_tokens>","stop_sequence":null},"usage":{"input_tokens":N,"output_tokens":M}}
```
   `stop_reason`: `tool_use` if any functionCall was seen; else `max_tokens` when `candidates.0.finishReason == "MAX_TOKENS"`; else `end_turn`. Usage values as §3.4, plus `"cache_read_input_tokens"` when cached > 0.
8. **`message_stop`** — when the upstream stream ends (clean OR broken), a synthetic `[DONE]` is fed to the translator; it emits `message_stop` `{"type":"message_stop"}` ONLY if HasContent. A stream with no content events ends after `message_start` with no `message_delta`/`message_stop`.
9. **Per-chunk usage stripping** — before translation, `usageMetadata` is removed from any upstream chunk that has no `finishReason` (mid-stream usage updates never trigger §3.5.7) (evidence: `internal/runtime/executor/helps/usage_helpers.go` `FilterSSEUsageMetadata`).
10. **Upstream SSE consumption** — line-based: `event:` lines, `[DONE]`, blank lines, and non-`data:` lines are skipped; each `data: <json>` line is translated independently.

### 3.6 `count_tokens`

- Downstream request: Claude Messages JSON (model + messages [+ system]); response: `200`, `Content-Type: application/json`, body exactly `{"input_tokens":<totalTokens>}` (evidence: `internal/translator/common/bytes.go` `ClaudeInputTokensJSON`; executor `CountTokens`).
- Upstream: §2.2 row 3 with the §3.2.12 body variant; response `totalTokens` consumed. Unlike `openai-compatibility` (where the gateway synthesizes `totalTokens` locally — S1 recorded fact), the `gemini-api-key` path makes a REAL upstream `:countTokens` call; golden S2d8-13 pins the upstream request.
- Upstream error → Claude error envelope (§4), status passthrough.

---

## 4. Error semantics

### 4.1 Upstream HTTP error (non-2xx), single credential, `request-retry: 0`

MUST (evidence: `internal/runtime/executor/gemini_executor.go` statusErr; `sdk/api/handlers/claude/code_handlers.go` `toClaudeError`/`claudeErrorDetailFromText`):
- Downstream status = upstream status (verbatim).
- Downstream body = Claude error envelope, NOT the upstream body verbatim (differs from OpenAI-chat clients, which pass valid-JSON upstream bodies through verbatim — recorded m1):
```json
{"type":"error","error":{"type":"<T>","message":"<M>"}}
```
- `T` from status: 401 `authentication_error`, 402 `billing_error`, 403 `permission_error`, 404 `not_found_error`, 413 `request_too_large`, 429 `rate_limit_error`, 504 `timeout_error`, 529 `overloaded_error`, ≥500 `api_error`, otherwise `invalid_request_error`.
- `M` extraction (evidence: `claudeErrorDetailFromText` in `sdk/api/handlers/claude/code_handlers.go`): start from `M` = the raw upstream body text. When the body is valid JSON and its `error` value is a JSON OBJECT: a string `error.message` sets `M`; otherwise a string `error.code` sets `M` (numeric codes are IGNORED, e.g. Gemini's `"code": 429`); if the error object carries neither string, `M` stays the RAW BODY TEXT. A string `error.type` additionally OVERRIDES `T`. The top-level `type`/`message` fields are consulted ONLY when the body's `error` is NOT a JSON object: a string top-level `type` other than `"error"` overrides `T`, and a string top-level `message` sets `M`. Non-JSON body → `M` = the raw body text; empty → the HTTP reason phrase.
- No `Retry-After` header is added for gemini upstream errors (the gemini executor attaches no retry-after).
- Envelope field order: `{"type":"error","error":{"type":...,"message":...}}`.

Example (recorded shape): upstream 429 `{"error": {"code": 429, "message": "mock rate limit", "status": "RESOURCE_EXHAUSTED"}}` → downstream 429 `{"type":"error","error":{"type":"rate_limit_error","message":"mock rate limit"}}`.

### 4.2 Streaming errors

- **Error before the first translated chunk** (e.g. upstream 429 on the stream call): plain JSON error response with the upstream status; NO SSE headers (evidence: `handleStreamingResponse` first-chunk peek).
- **Mid-stream transport failure** (upstream disconnects without a chunked terminator): the client keeps HTTP 200 + SSE headers; events already translated are complete; the stream-end `[DONE]` pass still emits `message_stop` (if content was emitted); then ONE terminal event is appended:
```
event: error
data: {"type":"error","error":{"type":"api_error","message":"unexpected EOF"}}

```
  (2 newlines; `message` = the transport error text, recorded as `unexpected EOF`). Status code change after headers are committed has no wire effect. NOTE: this Claude-client shape differs from the OpenAI-client in-stream shape in the wire notes — both are correct for their client protocol.
- **Credential cooldown side effect of 429**: after an upstream 429 the credential enters a ~1s rate-limit cooldown that `transient-error-cooldown-seconds: -1` does NOT disable (recorded, fleet README). A request arriving inside the window gets a 500 whose `error.message` is the model-cooldown text `All credentials for model <m> are cooling down via provider gemini (last error: <last-error>)`; the envelope `T` is `api_error`. DIRECTION-PINNED: on this direction the `last error` / `last_upstream_error` carries the RAW upstream body (recorded as `<verbatim>` in the mock fleet README). Mechanism: `ExtractUpstreamErrorSummary` (`sdk/cliproxy/auth/selector.go`) isolates the error object via a `": {"`-prefix heuristic; Google-style spaced error bodies (`{"error": {"code": ...}}`) make the extracted fragment brace-unbalanced/invalid, so the whole raw text (sanitized for secrets only) is used — upstreams emitting compact error bodies yield a `code: message` summary form instead (S2d9/S2d2). Timing-sensitive: specified, not golden-pinned (S4 owns scheduling).

### 4.3 Downstream/auth errors

S1's bytes apply verbatim: 401 `{"error":"Missing API key"}` / `{"error":"Invalid API key"}`; R-404 for method/path mismatches; CORS block on everything.

---

## 5. Streaming rules (contract-test material)

- Byte-exact comparison of the downstream SSE body against fixtures, masking ONLY these volatile fields (orchestrator ruling S2d8-2 accepts the counter mask):
  - `X-Cpa-Trace-Id`, `Date`, `Content-Length` headers;
  - worker-local reference/mock port numbers (in `Host` headers and upstream wire logs);
  - the digits of `content_block.id` in `content_block_start` events (`<name>-<N>` — the reference uses a process-scoped counter; a per-request counter matching the `<name>-<digits>` shape is acceptable).
- `message.usage.input_tokens` inside `message_start` is NOT masked — it is a deterministic o200k_base estimate and is asserted byte-exactly (ruling S2d8-1).
- Everything else — event names, order, JSON field order, the 3-newline framing, index numbering, delta payloads — MUST be byte-equal.
- SSE keep-alive heartbeats (`: keep-alive\n\n` comments) are OPTIONAL (config `streaming.keep-alive-seconds`, default 0 = off). Fixtures are recorded with them off; contract tests MUST NOT expect them.
- No `[DONE]` marker is ever sent to a Claude client.

---

## 6. Golden samples index

All 21 goldens RECORDED against CLIProxyAPI v7.3.4 (image digest sha256:97825da…): 18 by @oracle-runner-5 with the gemini mock fleet (per-case canned replies via mock control file); S2d8-19 promoted from the as-written run evidence and S2d8-20 recorded fresh at the adversarial gate; S2d8-21 recorded by @oracle-runner-2 to resolve the impl-review `toolConfig` dispute (wire evidence: toolConfig is NOT stripped from count bodies). Layout per RECIPES (BOOTSTRAP.md §7): `tests/fixtures/S2d8/<case-id>/{meta.yaml,request.http,downstream.md,upstream.jsonl}` (mock control mirrored in `meta.yaml`; upstream.jsonl is EMPTY — zero upstream hits — for the two routing-stage 400s, 19/20).

Recorded routing fact (affects every golden): the canonical recordings use client model `gm` (the alias). The as-written run (client model = upstream name `gemini-mock-model`) is preserved as evidence at `_cpa_edge_ref/probes/S2d8-as-written/` — the reference rejects those client-side with `400 unknown provider for model gemini-mock-model` and zero upstream hits; see §3.1 routing note. Affected `meta.yaml` files carry `request_model_substituted: "gemini-mock-model -> gm"`.

`input_tokens(msg-start)` = the recorded byte-exact `message_start.usage.input_tokens` o200k_base estimate (ruling S2d8-1).

| Case | Status | Pins (recorded) | Fixture |
|---|---|---|---|
| S2d8-01-nostream-basic | 200 | string systemInstruction (no role), temperature/topP, safetySettings, response mapping; downstream body byte-matches spec template | tests/fixtures/S2d8/S2d8-01-nostream-basic/ |
| S2d8-02-nostream-alias | 200 | alias `gm` → upstream `gemini-mock-model`; response model keeps upstream name | tests/fixtures/S2d8/S2d8-02-nostream-alias/ |
| S2d8-03-nostream-system-array | 200 | array systemInstruction (role:user), attribution strip, reminder turn HTML-escaped (`\u003csystem-reminder\u003e`), user-turn merge | tests/fixtures/S2d8/S2d8-03-nostream-system-array/ |
| S2d8-04-nostream-tool-call | 200 | functionDeclarations + cleaned schema (enum hint), toolConfig AUTO, tool_use `get_weather-1`/`get weather`, stop tool_use | tests/fixtures/S2d8/S2d8-04-nostream-tool-call/ |
| S2d8-05-nostream-tool-history | 200 | functionCall{id passthrough, bypass signature on FIRST call only}, aligned+reordered tool_results, raw-block result, inline_data placement, merge | tests/fixtures/S2d8/S2d8-05-nostream-tool-history/ |
| S2d8-06-nostream-image | 200 | image → inline_data; part order preserved | tests/fixtures/S2d8/S2d8-06-nostream-image/ |
| S2d8-07-nostream-thinking | 200 | thinking STRIP (request `{"type":"enabled","budget_tokens":1024}` → upstream `"generationConfig":{}`); thinking block + signature; cache_read 3; usage 17/10 | tests/fixtures/S2d8/S2d8-07-nostream-thinking/ |
| S2d8-08-nostream-maxtokens | 200 | stop_reason max_tokens; usage key ABSENT | tests/fixtures/S2d8/S2d8-08-nostream-maxtokens/ |
| S2d8-09-stream-basic | 200 | full happy SSE (7 events, 3-newline framing); input_tokens(msg-start)=4; message_delta 9/6 | tests/fixtures/S2d8/S2d8-09-stream-basic/ |
| S2d8-10-stream-thinking | 200 | thinking STRIP upstream (`"generationConfig":{}`); thinking/signature_delta stream; MAX_TOKENS stop; input_tokens(msg-start)=9 | tests/fixtures/S2d8/S2d8-10-stream-thinking/ |
| S2d8-11-stream-tool-call | 200 | tool_use stream events, compact input_json_delta, stop tool_use; input_tokens(msg-start)=32; tool id `get_weather-1` (digits masked) | tests/fixtures/S2d8/S2d8-11-stream-tool-call/ |
| S2d8-12-stream-empty | 200 | message_start ONLY (HasContent gate); input_tokens(msg-start)=4; no message_delta/message_stop | tests/fixtures/S2d8/S2d8-12-stream-empty/ |
| S2d8-13-count-tokens | 200 | REAL upstream :countTokens (tools/genConfig/safetySettings stripped; no tool_choice sent → no toolConfig key); `{"input_tokens":42}` | tests/fixtures/S2d8/S2d8-13-count-tokens/ |
| S2d8-14-err-429 | 429 | status passthrough + Claude envelope (NOT verbatim): rate_limit_error/"mock rate limit" | tests/fixtures/S2d8/S2d8-14-err-429/ |
| S2d8-15-err-400 | 400 | invalid_request_error mapping | tests/fixtures/S2d8/S2d8-15-err-400/ |
| S2d8-16-slow-chunks | 200 | byte-identical to 09 under 300ms delays; no heartbeat frames; input_tokens(msg-start)=4 | tests/fixtures/S2d8/S2d8-16-slow-chunks/ |
| S2d8-17-disconnect | 200 | text deltas → message_stop → terminal `event: error` api_error "unexpected EOF" (message_stop PRECEDES the error; HTTP stays 200); input_tokens(msg-start)=4 | tests/fixtures/S2d8/S2d8-17-disconnect/ |
| S2d8-18-stream-error-before-first-chunk | 500 | JSON error (api_error "Internal error."), Content-Type application/json, NO SSE headers | tests/fixtures/S2d8/S2d8-18-stream-error-before-first-chunk/ |

Upstream wire (recorded for every executed case; 1 hit per request; none for 19/20): path/header/body bytes match §2.2–§3.2 exactly — `Content-Type` + `x-goog-api-key` + `Accept-Encoding: gzip` + `User-Agent: Go-http-client/1.1`, no `Accept` on stream calls, body key order per §2.3, safetySettings always injected.

| S2d8-19-alias-rejection | 400 | client model = upstream NAME `gemini-mock-model` → routing 400 `unknown provider for model gemini-mock-model`, ZERO upstream hits, no X-Cpa-Trace-Id | tests/fixtures/S2d8/S2d8-19-alias-rejection/ |
| S2d8-20-strict-json-400 | 400 | non-JSON body → routing 400 `unknown provider for model` (trimmed: no model name, no trailing space — contrast S2d6 Responses-surface trailing-space variant), ZERO upstream hits, no X-Cpa-Trace-Id | tests/fixtures/S2d8/S2d8-20-strict-json-400/ |
| S2d8-21-count-tokens-toolchoice | 200 | count body KEEPS toolConfig: `tool_choice {"type":"auto"}` → upstream `{"toolConfig":{"functionCallingConfig":{"mode":"AUTO"}}}` while tools/generationConfig/safetySettings are stripped; `{"input_tokens":42}` | tests/fixtures/S2d8/S2d8-21-count-tokens-toolchoice/ |

FIXTURE-DEFERRED (R-FIXTURE): none of the 21 cases required real credentials. The CREDENTIALED-ONLY surfaces of this direction (Gemini CLI/AIStudio OAuth, §7.2) have no fixtures by design. Error paths that ARE recordable are all recorded.

## 7. Open questions and deferred items

1. **o200k_base delta watch (residual risk).** Contract tests assert `message_start.usage.input_tokens` byte-exactly (ruling S2d8-1). If the `js-tiktoken` `o200k_base` count differs from a recorded golden by a systematic offset, the implementer must replicate the reference's segment-collection + counting function exactly (§3.5.2); the per-case recorded values in §6 make any delta detectable case-by-case.
2. **Gemini OAuth upstreams (CREDENTIALED-ONLY, FIXTURE-DEFERRED).** Claude client → Gemini CLI/AIStudio/Antigravity OAuth credentials go through different executors with fixed vendor endpoints (`cloudcode-pa.googleapis.com`) and different request shaping (thought-signature replay policies, `internal/signature/gemini_validation.go`). Specified from docs only when those sections are written; no local fixtures possible.
3. **SSE keep-alive comments** are config-gated (`streaming.keep-alive-seconds`, default 0 = OFF) and interleave `: keep-alive\n\n` frames when enabled. OPTIONAL behavior, never asserted by contract tests.
4. **Cooldown envelope** (§4.2): the ~1s rate-limit cooldown second-request shape is timing-sensitive and not recorded; S4 owns the algorithm. Cross-ref: S2d8 fixes only the client-visible envelope shape (`api_error` + model_cooldown message extraction).

No intentional non-equivalences remain registered for S2d8: dropped request fields (`max_tokens`, `stop_sequences`, `metadata`) match upstream translation semantics and are golden-pinned MUSTs (ruling S2d8-6).

---

## 8. Orchestrator rulings (2026-09-16)

- **S2d8-1 (tokenizer):** `js-tiktoken` (pure-JS, runtime-agnostic) will be installed before Phase-2 dispatch. `message_start.usage.input_tokens` stays UNMASKED in contract tests (byte-exact); recorded goldens are authoritative, and a systematic js-tiktoken delta forces replicating the reference estimator.
- **S2d8-2 (stream tool_use id):** masking of the process-counter digits is accepted in the volatility whitelist; the `<sanitized-name>-<digits>` shape is asserted.
- **S2d8-3 (functionCall.id passthrough):** KEEP for wire compatibility with the reference (recorded).
- **S2d8-4 (gemini-interactions):** OUT OF CHARTER for v1; known gap to be quantified at the D2 global audit.
- **S2d8-5 (vertex):** no separate direction — Vertex is a config variant of the Gemini executor (base-URL + path templating; the Gemini-executor implementer owns both). Observed path template for `vertex-api-key`: `<base>/v1/publishers/google/models/<model>:generateContent` (no project/location segment for API-key entries; recorded in the mock fleet README). Only the URL template and credential auth differ; translation semantics are S2d8's.
- **S2d8-6 (dropped fields):** `max_tokens`/`stop_sequences` dropping matches upstream behavior — golden-pinned MUST, removed from the non-equivalence registry.
- **S2d8-7 (cooldown):** timing-owned by S4; S2d8 keeps the envelope cross-reference only.
