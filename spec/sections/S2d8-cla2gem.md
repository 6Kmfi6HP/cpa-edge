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
- `gemini-interactions` credentials: a Claude client routed to a `gemini-interactions` auth takes the native Interactions path (`internal/runtime/executor/gemini_executor.go` `shouldExecuteNativeInteractions`), a different upstream wire (`POST /v1beta/interactions`, `Api-Revision: 2026-05-20`). Not specified here; needs its own section.
- Vertex (`vertex-api-key`): same translator, different URL scheme and auth; see §7 open questions.
- Thinking-effort *validation* against the model registry (`internal/runtime/executor/helps/model_capabilities.go` → `internal/thinking`): S2d8 specifies the translator-level mapping only; registry-driven clamping for registered models is S4. For models unknown to the registry (all mock/recorded cases) it is a no-op.
- Plugin interceptors, request/response plugins: absent in recordings; behavior below is the no-plugin baseline.

---

## 2. Behavior inventory

### 2.1 Routes, methods, statuses (client side)

| Route | Method | Success | Notes |
|---|---|---|---|
| `/v1/messages` | POST | 200 | Body is a Claude Messages request. `stream:true` → SSE; `stream` absent or `false` → JSON. (evidence: `sdk/api/handlers/claude/code_handlers.go` `ClaudeMessages`) |
| `/v1/messages/count_tokens` | POST | 200 | JSON in/out. |
| any other method on these paths | — | 404 empty | R-404 (SPEC.md §5). |

- Auth: gateway API key via `Authorization: Bearer <key>` or `X-Api-Key: <key>` (evidence: `internal/access/config_access/provider.go`). Failure shapes are S1's: 401 `{"error":"Missing API key"}` / `{"error":"Invalid API key"}` (recorded bootstrap probes).
- Non-stream success: `Content-Type: application/json`, status 200, body = §3.4 message JSON.
- Stream success: SSE headers set only when the first translated chunk is available (never on error-before-first-chunk): `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`, `Access-Control-Allow-Origin: *` (evidence: `handleStreamingResponse`).
- Unreadable request body → 400 `{"error":{"message":"Invalid request: <err>","type":"invalid_request_error"}}` (note: this is the base shape; the Claude handler writes it via the generic error writer).
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
| `model` | top-level `model` | Set to the credential-resolved upstream model (executor `SetStringIfDifferent`). The client string itself is not forwarded. |
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
| `thinking` | `generationConfig.thinkingConfig` | `{"type":"enabled","budget_tokens":N}` → `{"thinkingBudget":N}`. `{"type":"adaptive"|"auto"}` with `output_config.effort` = lowercase-trimmed effort → `{"thinkingLevel":<effort>}`; without effort → `{"thinkingBudget":<registry max>}` when the model is registered, else `{"thinkingLevel":"high"}`. Unregistered (all goldens): `"high"`. |
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
12. **count_tokens body variant**: same translation, then `tools`, `generationConfig`, `safetySettings` are deleted; leading-user boundary (rule 7, prepend-only) is applied; trailing-user is NOT. (evidence: `internal/runtime/executor/gemini_executor.go` `CountTokens`.)

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
2. **Input-token estimate injection** — for this direction (claude source, non-claude upstream, claude response) the first `message_start` is rewritten: `message.usage.input_tokens` := an `o200k_base` BPE count of the ORIGINAL client request, computed as: collect text segments — system (string, or `type:"text"` texts), for each message the `role` string, then content per block type (text/thinking `text|thinking`; `tool_use` `id`,`name`,`input` (compacted JSON); `tool_result` `tool_use_id`,`tool_call_id`, and content recursively; documents: title/context/data; images/audio skipped), then tools (`type`,`name`,`description`,`input_schema` compacted) and `tool_choice` (`type`,`name`); each segment trimmed, empty dropped; all joined with `\n`; tokenized with `o200k_base` (evidence: `internal/runtime/executor/helps/claude_input_tokens.go`). Non-stream responses do NOT get this injection. This makes `message_start.usage.input_tokens` a deterministic function of the request bytes. The implementation needs an o200k_base tokenizer (dependency request; see §7).
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
- `M` extraction from the upstream body when it is valid JSON: `error.message` (string) → else `error.code` (string; numeric codes are IGNORED, e.g. Gemini's `"code": 429`) → else top-level `message`; additionally a string `error.type` OVERRIDES `T`. Non-JSON body → `M` = the raw body text; empty → the HTTP reason phrase.
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
- **Credential cooldown side effect of 429**: after an upstream 429 the credential enters a ~1s rate-limit cooldown that `transient-error-cooldown-seconds: -1` does NOT disable (recorded, fleet README). A request arriving inside the window gets a 500 whose `error.message` is the model-cooldown text `All credentials for model <m> are cooling down via provider gemini (last error: <summary>)`; the envelope `T` is `api_error`. Timing-sensitive: specified, not golden-pinned (S4 owns scheduling).

### 4.3 Downstream/auth errors

S1's bytes apply verbatim: 401 `{"error":"Missing API key"}` / `{"error":"Invalid API key"}`; R-404 for method/path mismatches; CORS block on everything.

---

## 5. Streaming rules (contract-test material)

- Byte-exact comparison of the downstream SSE body against fixtures, masking ONLY these volatile fields:
  - `X-Cpa-Trace-Id`, `Date`, `Content-Length` headers;
  - the digits of `content_block.id` in `content_block_start` events (`<name>-<N>` process counter);
  - `message.usage.input_tokens` inside `message_start` — deterministic (o200k_base) but implementation-defined; mask unless the implementation pins the same tokenizer (see §7).
- Everything else — event names, order, JSON field order, the 3-newline framing, index numbering, delta payloads — MUST be byte-equal.
- SSE keep-alive heartbeats (`: keep-alive\n\n` comments) are OPTIONAL (config `streaming.keep-alive-seconds`, default 0 = off). Fixtures are recorded with them off; contract tests MUST NOT expect them.
- No `[DONE]` marker is ever sent to a Claude client.

---

## 6. Golden samples index

Recorded by @oracle-runner against CLIProxyAPI v7.3.4 (image digest sha256:97825da…) with the gemini mock fleet. Layout per RECIPES (BOOTSTRAP.md §7): `tests/fixtures/S2d8/<case-id>/{meta.yaml,request.http,downstream.md,upstream.jsonl,mock-response.json}`.

| Case | Pins | Fixture |
|---|---|---|
| S2d8-01-nostream-basic | system string form, gen params, safetySettings, response mapping, usage | tests/fixtures/S2d8/S2d8-01-nostream-basic/ |
| S2d8-02-nostream-alias | alias `gm` → upstream `gemini-mock-model`; response model keeps upstream name | tests/fixtures/S2d8/S2d8-02-nostream-alias/ |
| S2d8-03-nostream-system-array | system array form (role:user), attribution strip, mid-conversation system → reminder turn, user-turn merge | tests/fixtures/S2d8/S2d8-03-nostream-system-array/ |
| S2d8-04-nostream-tool-call | tools→functionDeclarations, schema cleaning, tool name sanitize+restore round-trip, tool_use block, stop_reason tool_use | tests/fixtures/S2d8/S2d8-04-nostream-tool-call/ |
| S2d8-05-nostream-tool-history | tool_use/tool_result round-trip, result encoding variants, images, part reordering, alignment, merge, boundary turn | tests/fixtures/S2d8/S2d8-05-nostream-tool-history/ |
| S2d8-06-nostream-image | image block → inline_data | tests/fixtures/S2d8/S2d8-06-nostream-image/ |
| S2d8-07-nostream-thinking | thinking request mapping; thinking+signature blocks; cached tokens; thoughtsTokenCount | tests/fixtures/S2d8/S2d8-07-nostream-thinking/ |
| S2d8-08-nostream-maxtokens | MAX_TOKENS → max_tokens; usage deletion when usageMetadata absent | tests/fixtures/S2d8/S2d8-08-nostream-maxtokens/ |
| S2d8-09-stream-basic | full happy SSE sequence + framing + message_delta + message_stop | tests/fixtures/S2d8/S2d8-09-stream-basic/ |
| S2d8-10-stream-thinking | thinking blocks in stream, signature_delta, MAX_TOKENS stop | tests/fixtures/S2d8/S2d8-10-stream-thinking/ |
| S2d8-11-stream-tool-call | tool_use stream events, input_json_delta, stop_reason tool_use | tests/fixtures/S2d8/S2d8-11-stream-tool-call/ |
| S2d8-12-stream-empty | HasContent gating: message_start only | tests/fixtures/S2d8/S2d8-12-stream-empty/ |
| S2d8-13-count-tokens | count_tokens end-to-end + upstream body variant | tests/fixtures/S2d8/S2d8-13-count-tokens/ |
| S2d8-14-err-429 | 429 → Claude envelope (not verbatim) | tests/fixtures/S2d8/S2d8-14-err-429/ |
| S2d8-15-err-400 | 400 INVALID_ARGUMENT → invalid_request_error | tests/fixtures/S2d8/S2d8-15-err-400/ |
| S2d8-16-slow-chunks | no heartbeat injection under delay | tests/fixtures/S2d8/S2d8-16-slow-chunks/ |
| S2d8-17-disconnect | mid-stream EOF: message_stop + event: error, HTTP stays 200 | tests/fixtures/S2d8/S2d8-17-disconnect/ |
| S2d8-18-stream-error-before-first-chunk | upstream 429 on stream → JSON error, no SSE headers | tests/fixtures/S2d8/S2d8-18-stream-error-before-first-chunk/ |

FIXTURE-DEFERRED (R-FIXTURE): none of the 18 cases require real credentials; the CREDENTIALED-ONLY surfaces of this direction are listed in §7 and have no fixtures by design. Error paths that ARE recordable are all recorded above.

---

## 7. Open questions and intentional non-equivalences

1. **o200k_base dependency (needs orchestrator action).** `message_start.usage.input_tokens` for streams is an `o200k_base` BPE estimate of the original request (§3.5.2). The reference uses tiktoken-go's `O200kBase`. CPA-Edge needs an equivalent pure-JS tokenizer (e.g. `js-tiktoken` with the bundled o200k_base vocabulary) to match byte-exactly. Request: install dependency at implementation time; until then contract tests mask the field per §5.
2. **Stream tool_use id counter.** The reference uses a process-wide counter, so recorded values depend on process history; fixtures are recorded in a fresh container with deterministic case order. Contract tests mask the digits. Non-stream ids (`<name>-1`, `-2`, …) are per-response and byte-asserted. Intentional non-equivalence allowed: a per-request counter is acceptable as long as ids match `<sanitized-name>-<digits>`.
3. **`functionCall.id` passthrough.** The request translator forwards Claude `tool_use.id` inside `functionCall.id`, a non-standard Gemini field the reference relies on for round-trip pairing. Real Google endpoints may reject or ignore it; the mock accepts it. We keep it for wire compatibility with the reference (recorded).
4. **Gemini OAuth upstreams (CREDENTIALED-ONLY, FIXTURE-DEFERRED).** Claude client → Gemini CLI/AIStudio/Antigravity OAuth credentials go through different executors with fixed vendor endpoints (`cloudcode-pa.googleapis.com`) and different request shaping (thought-signature replay policies, `internal/signature/gemini_validation.go`). Specified from docs only when those sections are written; no local fixtures possible.
5. **Interactions upstream for Claude clients.** A `gemini-interactions` credential switches Claude clients onto the native Interactions wire (`POST /v1beta/interactions`, `Api-Revision: 2026-05-20`, near-passthrough body). Needs its own section (recordable via the interactions mock); intentionally out of S2d8 scope.
6. **Vertex variant.** `vertex-api-key` reuses this translator with `/v1/publishers/google/models/{m}:…` paths and credential-scoped auth (recordable via the vertex mock). Propose folding into S2d8 as an appendix or a small S2d8b; not covered here.
7. **Dropped request fields.** `max_tokens`, `stop_sequences`, `metadata` are silently dropped (§3.1). This matches the reference; no cap is applied to output length for unregistered models (`capGeminiMaxOutputTokens` only caps an existing `generationConfig.maxOutputTokens`, which Claude requests never set). Registering this as intentional non-equivalence-vs-Claude-API, not a defect.
8. **Cooldown envelope.** The ~1s rate-limit cooldown second-request shape (§4.2) is timing-sensitive; not recorded. S4 must own its algorithm; S2d8 fixes only the envelope shape (`api_error` + model_cooldown message extraction).
9. **Keep-alive comments** are config-gated and OFF by default; if enabled they interleave `: keep-alive\n\n` frames. OPTIONAL behavior, never asserted by contract tests.
