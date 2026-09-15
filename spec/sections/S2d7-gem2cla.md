# S2d7 — Gemini client → Claude upstream

Section id: S2d7. Module: `packages/translators` (gemini→claude direction) + `packages/executors` (claude executor) + routing mounted by `runtimes/*`.
Upstream anchor: CLIProxyAPI v7.3.4, commit `8335eac731946bd4eff18f500653f93736df53d6` (see SPEC.md §0).
Upstream evidence paths in this section are relative to the upstream repo root unless prefixed `_cpa_edge_ref/`.
Recorded wire facts (oracle, `_cpa_edge_ref/probes/mocks/claude/`, `_cpa_edge_ref/probes/mocks/README.md`, `reports/oracle/BOOTSTRAP.md`) outrank this static reading.

---

## 1. Scope and boundaries

IN scope:
- The Gemini-protocol client surface used for generation: `POST /v1beta/models/{model}:generateContent`, `POST /v1beta/models/{model}:streamGenerateContent[?alt=...]`, `POST /v1beta/models/{model}:countTokens` when the resolved provider is a **Claude Messages upstream** (`claude-api-key` config type with `base-url`, or Claude OAuth — CREDENTIALED-ONLY).
- Request translation Gemini → Claude Messages (`contents` → `messages`, system handling, tools, tool config, generation config, media parts, thinking config).
- Response translation Claude → Gemini for both the aggregated (non-stream) and the SSE (stream) paths, including tool-call assembly and usage metadata.
- Upstream HTTP shape emitted by the claude executor for this direction (URL, query, headers, body mutations): auth header style, `?beta=true`, forced upstream streaming, injected `max_tokens`, `metadata.user_id`, `cache_control` injection, sampling-parameter stripping.
- Error propagation semantics end-to-end for this pair.

OUT of scope (owned elsewhere):
- Route registration, gateway auth (API key styles, 401/404/OPTIONS envelopes), CORS header block — S1. This section pins only pair-specific deltas and cross-references S1.
- Model alias resolution, provider selection, credential scheduling, cooldowns, `force-mapping` — S4/S6. Here: the executor receives the provider-resolved model name; fixtures pin the observable.
- The `/v1beta/models` list endpoints (`GET /v1beta/models`, `GET /v1beta/models/{m}`) — S1 (they are registry-generic, not pair-specific).
- `/v1beta/interactions` — separate section.
- Claude OAuth credential flows, cloaking profiles, CCH signing, `fingerprint-profile: claude-code-cli` — S3/S4. This section specifies the DEFAULT caller-owned fingerprint profile that `claude-api-key` credentials use (recorded).
- Thinking-suffix syntax (`model(minimal)`) and per-model capability clamping — S4 registry; this section specifies only the translator's field mapping and notes the application layer.

---

## 2. Behavior inventory

### 2.1 Downstream surface (cross-ref S1)

Routes (evidence: `internal/api/server_routes.go` — group `/v1beta` under `AuthMiddleware`):
- `POST /v1beta/models/{model}:generateContent` → 200 JSON, or error status (see §5).
- `POST /v1beta/models/{model}:streamGenerateContent` → 200 SSE (framing per §4) or error status.
- `POST /v1beta/models/{model}:countTokens` → 200 JSON.
- `{model}` is the client-requested model id. The gateway resolves it to a provider before this section's logic runs. For a config-declared `claude-api-key` model with an `alias`, ONLY the alias is routable: the verbatim upstream model name is NOT registered and yields 400 `{"error":{"message":"unknown provider for model <name>","type":"invalid_request_error","code":"model_not_found","param":"model"}}` with no upstream call (recorded: S2d7-22).
- Auth: gateway API key via `x-goog-api-key: <key>` OR `Authorization: Bearer <key>` (recorded: BOOTSTRAP §4 probe "v1beta/models"). Missing/invalid key → 401 `{"error":"<message>"}` (S1/S3 shapes; `internal/api/server_middleware.go` `accessAuthMiddleware`).
- The `alt` query parameter is normalized by `GetAlt` (evidence: `sdk/api/handlers/handlers.go`): absent, empty, or `alt=sse` all yield the SSE framing of §4.1; any other value (e.g. `alt=json`) yields raw-concatenation framing of §4.2. `$alt` is accepted as an alias of `alt`.

### 2.2 Upstream call shape (Claude Messages)

MUST (all evidenced in `internal/runtime/executor/claude_executor_execute.go` / `claude_executor_request.go`, and recorded verbatim in `_cpa_edge_ref/probes/mocks/claude/upstream.jsonl`):
- URL: `POST {base-url}/v1/messages?beta=true`. The `?beta=true` query is always present.
- The upstream request is ALWAYS a stream request for this pair, even when the client asked for `:generateContent` (non-stream). The executor computes `upstreamStream = (downstream response format != claude)`; for a Gemini client it is always true. The body therefore always carries `"stream":true` and the transport always negotiates SSE. The gateway aggregates for non-stream clients (§3.4).
- Auth header (credential is an API key, upstream is NOT `api.anthropic.com`): `Authorization: Bearer <api-key>` — NOT `x-api-key`. (`x-api-key` is only used when the host is Anthropic first-party; evidence: `PrepareRequest`/`applyClaudeHeadersWithNativeProfile` in `claude_executor.go` + `claude_executor_request.go`.) Recorded.
- `Anthropic-Version: 2023-06-01` always. Recorded.
- No `anthropic-beta` header is emitted for plain `claude-api-key` credentials with default fingerprint profile when neither caller nor body contributed betas (header deleted when the computed beta set is empty). Recorded.
- Caller-owned fingerprint (default for API-key credentials; evidence: `internal/runtime/executor/claude_fingerprint_policy.go` — profile defaults to caller-owned unless `fingerprint-profile: claude-code-cli`; recorded in upstream.jsonl):
  - The CLIENT's `User-Agent` is forwarded verbatim. If the client sent none, the gateway sends `CLIProxyAPI/<version>`.
  - The client's `Accept` is forwarded if present; otherwise `text/event-stream` (upstream is always streamed). Recorded: client `Accept: */*` arrived at the mock.
  - `Accept-Encoding: identity` (streaming default for non-Anthropic base URLs); the client's own `Accept-Encoding` value wins if it sent one.
  - `Content-Type: application/json`.
  - Only this allowlist of client headers is forwarded: `Accept`, `Accept-Encoding`, `User-Agent`, `X-App`, `X-Client-Request-Id`, `X-Client-App`, `X-Anthropic-Additional-Protection`, `anthropic-*`, `x-stainless-*`, `x-claude-code-*`, `x-claude-remote-*`. Everything else (including `x-goog-api-key`, `X-Mock-*`) is dropped.
- Body mutations applied by the executor after translation (evidence: `claude_executor_execute.go`, `claude_executor_cloaking.go`):
  - `model`: the provider-resolved model name (never the raw alias). Recorded: client asked `cm`, upstream body had `claude-mock-model`.
  - `max_tokens`: translator default 32000; overridden by `generationConfig.maxOutputTokens` if the client sent one.
  - `metadata.user_id`: always present (§3.3).
  - `stream`: `true`.
  - `cache_control: {"type":"ephemeral"}` injection when the body has zero pre-existing `cache_control` blocks (§3.6).
  - `temperature` and `top_p` are DELETED for all Gemini-entry requests (native-owned sampling is false; evidence: `normalizeClaudeSamplingForUpstream`, `claude_executor_request.go`). `top_k` is never produced by the translator. Recorded: upstream body has no sampling keys.
  - `thinking` block deletion when `tool_choice` forces a tool (`{"type":"any"}` or `{"type":"tool"}`), matching Anthropic's constraint (`disableThinkingIfToolChoiceForced`).
  - `tools` entries keep their shape; empty `allowed_domains`/`blocked_domains` arrays on `web_search_*` tools are removed (`sanitizeClaudeWebSearchDomains`).
  - `betas` array (not a Gemini concept) would be lifted to the `anthropic-beta` header — n/a for Gemini clients.

### 2.3 Request translation — Gemini → Claude (evidence: `internal/translator/claude/gemini/claude_gemini_request.go`, registered in `internal/translator/claude/gemini/init.go` as Gemini→Claude)

Output skeleton (key order is observable; recorded):
`{"model":..., "max_tokens":..., "messages":[...], "metadata":{"user_id":...}, [top_p], [stop_sequences], [thinking], [tools], [tool_choice], "stream":true}`

MUST rules:
- `contents[]` → `messages[]` with role mapping: `model`→`assistant`; `function`→`user`; `tool`→`user`; any other value (including empty string / missing) is NOT remapped.
- **A content turn whose role is not exactly `user` or `assistant` AFTER mapping is DROPPED entirely.** In particular a Gemini turn without a `role` field (which the official Gemini API treats as `user`) is silently dropped — no Claude message is produced for it. (The accumulator only accepts `user`/`assistant`; evidence: `internal/translator/common/claude_messages.go` `Append`.) Pin: golden S2d7-16.
- Consecutive turns with the SAME mapped role are merged into ONE Claude message (content parts concatenated). An assistant turn's `tool_use` blocks are moved AFTER the turn's other content blocks.
- Parts, per turn, in first-seen order:
  - `{"text": s}` → `{"type":"text","text":s}`. Each text part stays a separate block (no joining).
  - `{"thought":true,...}` parts are skipped entirely (not forwarded).
  - `{"functionCall":{...}}` — ONLY in a `model`-role turn (mapped `assistant`); a `functionCall` part in a `user` turn is DROPPED. Translates to `{"type":"tool_use","id":I,"name":N,"input":A}`:
    - `I`: `functionCall.id` if non-blank, else `functionCall.call_id` if non-blank, else a generated id `toolu_gemini_%016d` (request-local counter, starts at 1, e.g. `toolu_gemini_0000000000000001`).
    - `N`: `functionCall.name` verbatim. `A`: `functionCall.args` raw JSON when present AND an object; otherwise the skeleton's `"input":{}` (absent/non-object args → empty object).
  - `{"functionResponse":{...}}` (no role gate — translated in any turn) → `{"type":"tool_result","tool_use_id":T,"content":C}`:
    - `T`: `functionResponse.id` / `call_id` if present (and removed from the pending-queue); else the OLDEST pending tool_use id (FIFO); else a fresh `toolu_gemini_%016d`.
    - `C`: `functionResponse.response.result` as a string when present (any JSON type is stringified); else `functionResponse.response` raw JSON as a string; else absent (`""` from the skeleton).
  - `inlineData`/`inline_data` → image/document: `image/*` → `{"type":"image","source":{"type":"base64","media_type":M,"data":D}}`; `application/*` and `text/*` → `{"type":"document","source":{...base64...}}`; any other mime → `{"type":"text","text":"Media content: inline data (Type: <M>)"}`. Empty mime or data → part dropped.
  - `fileData`/`file_data` → `{"type":"image"|"document","source":{"type":"url","url":<fileUri>}}` (document also carries `media_type` when known); other mimes → text part `File: <uri> (Type: <M>)`.
- **System instruction**: ONLY the snake_case key `system_instruction` is read (evidence: the translator reads `root.Get("system_instruction")` exclusively). camelCase `systemInstruction` — the form official Gemini SDKs send — is DROPPED: no Claude `system` and no message is produced. Pin: golden S2d7-05.
- `system_instruction` must be an OBJECT with a `parts` ARRAY; a plain string value (accepted by the real Gemini API) is DROPPED, as is an object with no text parts. When parts exist, all non-thought `text` parts are joined with `\n` into ONE text block, emitted as the FIRST Claude message with role `user`, and flushed alone (never merged with the first `contents` turn). It does NOT become the Claude top-level `system` field, and no `system` key is ever sent upstream for this direction. Pin: golden S2d7-04. (This corrects the mission brief's "systemInstruction→system" assumption; recorded behavior wins.)
- `tools[].functionDeclarations[]` → Claude `tools[]`: `{"name":..., "description":..., "input_schema": S}` where `S` comes from `parameters` or `parametersJsonSchema` and is normalized: `additionalProperties` set to `false` unless already exactly `false`; `$schema` set (or overwritten) to `http://json-schema.org/draft-07/schema#`; every `type` value anywhere in the schema is lowercased. A declaration without `parameters` yields `"input_schema":{}`. Tool entries without `functionDeclarations` are ignored.
- `tool_config.function_calling_config` (snake) or `toolConfig.functionCallingConfig` (camel; both accepted) → `tool_choice`:
  - `AUTO` → `{"type":"auto"}`; `NONE` → `{"type":"none"}`;
  - `ANY` with exactly ONE name in `allowedFunctionNames`/`allowed_function_names` → `{"type":"tool","name":<name>}`;
  - `ANY` otherwise → `{"type":"any"}`; other/absent mode → no `tool_choice`.
- `generationConfig`:
  - `maxOutputTokens` → `max_tokens` (JSON number; string values coerce to 0). Absent → 32000.
  - `topP` → `top_p` (then deleted by the executor for this pair — §2.2).
  - `stopSequences` (non-empty array) → `stop_sequences`.
  - `temperature`, `topK`, `candidateCount`, `responseMimeType`, `responseSchema`, `seed`, `presencePenalty` etc. are NOT read: dropped for this direction.
  - `thinkingConfig.thinkingLevel` or `thinking_level` (case-insensitive, trimmed):
    - `""` → nothing; `none` → `{"thinking":{"type":"disabled"}}`; `auto` → `{"thinking":{"type":"enabled"}}`;
    - other levels → `{"thinking":{"type":"enabled","budget_tokens":B}}` with B from the level map (`minimal`=512, `low`=1024, `medium`=8192, `high`=24576, `xhigh`=32768, `max`=128000) (evidence: `internal/thinking/convert.go`); an UNKNOWN level string produces NO thinking block at all;
    - adaptive-style models (registry-known with levels) map to `{"thinking":{"type":"adaptive"},"output_config":{"effort":<mapped>}}` instead — registry-dependent, see S4.
  - `thinkingConfig.thinkingBudget` or `thinking_budget`: `0` → `{"type":"disabled"}`; `-1` → `{"type":"enabled"}` (no budget); other N → `{"type":"enabled","budget_tokens":N}` (adaptive-capable models: budget→effort mapping, S4).
  - The final thinking block is then passed through the thinking application layer (`internal/runtime/executor/helps/model_capabilities.go`, `internal/thinking/apply.go`): for config-declared API-key models the layer RESOLVES a model info without thinking metadata and STRIPS the translated thinking block entirely — recorded: S2d7-08 (`thinkingLevel:"low"` reaches NO `thinking` key on the upstream wire). Thinking controls only survive for models the registry knows to be thinking-capable (S4) or models with no resolvable capability info. Fixtures pin the mock-model behavior (strip).
- `service_tier` (root level, string) → `service_tier` passthrough.
- Everything else in the Gemini body is ignored (`safetySettings`, `labels`, etc. are not forwarded).

### 2.4 Response mapping — Claude → Gemini, non-stream (`:generateContent`)

The executor reads the ENTIRE upstream SSE (it was forced), validates it (§5.2), then `ConvertClaudeResponseToGeminiNonStream` (evidence: `internal/translator/claude/gemini/claude_gemini_response.go`) builds ONE Gemini JSON object:

Skeleton (key order observable; golden S2d7-01):
```
{"candidates":[{"content":{"role":"model","parts":[...]},"finishReason":"STOP"}],
 "usageMetadata":{"promptTokenCount":P,"candidatesTokenCount":C,"totalTokenCount":P+C,"trafficType":"PROVISIONED_THROUGHPUT"},
 "modelVersion":M,"createTime":T,"responseId":R}
```
- `parts`: assembled from the upstream events in order, then CONSECUTIVE text parts merged into one block and consecutive thought parts merged into one block (`consolidateParts`); `functionCall` and other parts stay as-is.
  - `content_block.delta` `text_delta` → `{"text":s}` (empty strings dropped);
  - `thinking_delta` → `{"thought":true,"text":s}`;
  - `signature_delta` / thinking-block `signature` → `{"thought":true,"thoughtSignature":...}` (replay-compat wrapper, S4);
  - tool_use blocks → `{"functionCall":{"name":N,"args":A,"id":I}}` with args = concatenation of all `input_json_delta.partial_json` for that block index (§3.5).
- `finishReason`: ALWAYS `"STOP"` for this pair. The Claude `stop_reason` is NOT mapped in the non-stream path (the skeleton hardcodes STOP; the `message_delta` branch of the non-stream translator reads only usage). `max_tokens` upstream therefore still yields `"STOP"`. Pin: golden S2d7-15.
- `usageMetadata`: read ONLY from the `message_delta` event's `usage`:
  - `promptTokenCount` = `usage.input_tokens` (0 when absent — the current mock omits it, so the recorded value is 0 even though `message_start.message.usage.input_tokens` was 9). Pin: S2d7-01.
  - `candidatesTokenCount` = `usage.output_tokens`; `totalTokenCount` = sum;
  - `cachedContentTokenCount` = `cache_creation_input_tokens` if present, replaced by `cache_creation_input_tokens + cache_read_input_tokens` when the read field is present;
  - `thoughtsTokenCount` = `thinking_tokens` if present;
  - `trafficType`: `"PROVISIONED_THROUGHPUT"` always.
  - Key order differs from the streaming path (§4.3).
- `modelVersion`: the gateway-resolved model name (executor argument), NOT the upstream-echoed `message.model`. For alias-driven requests both are the provider name; they diverge for force-mapped or rewritten models (S4).
- `responseId`: upstream `message.id` from `message_start`. `createTime`: RFC3339 formatting of a whole-second wall-clock timestamp — second precision with numeric zone offset, e.g. `2026-09-16T01:04:46+08:00` (the zero sub-second part is dropped entirely; recorded). DYNAMIC (masked in fixtures).
- The whole upstream stream must contain `message_start` and `message_delta` and at least one `data:` line (§5.2), else 502.

### 2.5 Token counting (`:countTokens`)

MUST (evidence: `internal/runtime/executor/claude_executor_tokens.go`):
- For non-Anthropic base URLs the gateway does NOT call the upstream `count_tokens` endpoint. It counts locally with an O200kBase tokenizer over the TRANSLATED Claude body (segments: system text blocks, per-message role + content text/tool ids/names/inputs, tool names, tool_choice) and returns a Gemini-shaped body:
  `{"totalTokens":N,"promptTokensDetails":[{"modality":"TEXT","tokenCount":N}]}` (evidence: `internal/translator/common/bytes.go` `GeminiTokenCountJSON`). Recorded N for the S2d7-12 request is 4 (O200kBase over segments `["user","Say hello"]` joined with `\n`).
- No upstream request is emitted for this path. Pin: golden S2d7-12 (upstream wire log stays unchanged).
- Validation: translated `messages` must be a non-empty array of `user`/`assistant` turns with typed content blocks, else 400 `{"error":{"message":"<validator message>","type":...}}` (§5).
- The numeric value N is deterministic for a fixed request under the reference tokenizer. Byte-exact reproduction requires an O200k-compatible tokenizer — see §7 open question.

### 2.6 Model list

Not pair-specific: `GET /v1beta/models` returns registry models with `models/` prefix and `supportedGenerationMethods: ["generateContent"]` defaults (S1; evidence: `sdk/api/handlers/gemini/gemini_handlers.go`).

---

## 3. Schemas (field-by-field)

### 3.1 Gemini request (client → gateway)

Accepts the standard Gemini `GenerateContentRequest` JSON. Only the fields in §2.3 influence the Claude body. `model` comes from the URL path, not the body.

### 3.2 Claude request (gateway → upstream)

```json
{
  "model": "<provider-resolved name>",
  "max_tokens": 32000,
  "messages": [
    {"role": "user|assistant", "content": [
      {"type": "text", "text": "..."},
      {"type": "image", "source": {"type": "base64", "media_type": "...", "data": "..."}},
      {"type": "document", "source": {"type": "base64", "media_type": "...", "data": "..."}},
      {"type": "tool_use", "id": "toolu_...", "name": "...", "input": {...}},
      {"type": "tool_result", "tool_use_id": "toolu_...", "content": "..."}
    ]}
  ],
  "metadata": {"user_id": "<64-hex>"},
  "stop_sequences": ["..."],
  "thinking": {"type": "enabled|disabled|adaptive", "budget_tokens": N},
  "tools": [{"name": "...", "description": "...", "input_schema": {...},
             "cache_control": {"type": "ephemeral"}}],
  "tool_choice": {"type": "auto|any|none|tool", "name": "..."},
  "stream": true
}
```
No `system` key is ever produced by this direction (§2.3). No `temperature`/`top_p`/`top_k`.

### 3.3 `metadata.user_id` derivation (evidence: `internal/translator/common/claude_user_id.go`)

Order of precedence:
1. A pre-existing `metadata.user_id` in the CLIENT body (string, non-blank) — passed through.
2. `user` field (not a Gemini field) — n/a.
3. Seed `"content:"` + all non-thought `text` parts of the FIRST `contents` entry whose role is `user` OR MISSING, joined with `\n`.
4. Else seed from `model` + `;instructions:`/`;system:`/`;systemInstruction:`/`;system_instruction:` raw values.
5. Else `"unknown"`.
Then `user_id = hex(sha256(seed))`. Deterministic; recorded values pin the algorithm (e.g. `content:Say hello` → `120226d8…8b6c46`).

### 3.4 `cache_control` injection (evidence: `internal/runtime/executor/claude_executor_cloaking.go`)

Runs when the translated body has ZERO `cache_control` blocks (always true for this direction — the translator never emits any):
- If the body has NO non-empty Claude `system` (always the case here): the LAST non-`defer_loading` tool in `tools` gets `{"type":"ephemeral"}` appended.
- The LAST message whose role is `user`/`assistant` and whose last content block is not a thinking block gets `{"type":"ephemeral"}` appended to its LAST content block.
- Injection stops as soon as any pre-existing `cache_control` is found in that section. Max 4 breakpoints are enforced (drop extras).
Recorded: single-user-message request → `messages[0].content[0].cache_control == {"type":"ephemeral"}` (upstream.jsonl).

### 3.5 Tool-call pairing (request)

Per-request FIFO: `toolu_gemini_%016d` ids are allocated in order of appearance of `functionCall` parts; `functionResponse` parts consume them FIFO unless they carry their own `id`/`call_id`. Counter starts at 1 per request; ids are stable and byte-pinnable.

### 3.6 Tool-call assembly (response, both paths)

- `content_block_start` with `content_block.type == "tool_use"` records `name` and `id` by block index; emits nothing.
- `content_block_delta` with `delta.type == "input_json_delta"` accumulates `delta.partial_json` by index; emits nothing.
- `content_block_stop` for that index emits the assembled part `{"functionCall":{"name":N,"args":A,"id":I}}` (`A` = the accumulated `partial_json` bytes spliced RAW — no re-serialization, no validation; invalid accumulated JSON flows through verbatim; `"id"` only when the block carried one) — and the SAME chunk carries `finishReason:"STOP"`. Key order inside `functionCall`: `name`, `args`, `id`.
- **Raw-splice cascade (recorded)**: when the spliced `args` bytes are not valid JSON, the chunk itself becomes invalid JSON, and every subsequent structured write on that chunk degrades to a ROOT-LEVEL append: the stream tool chunk's `finishReason:"STOP"` lands at the top level of the chunk object (after `responseId`) instead of inside `candidates[0]` (recorded: S2d7-13 frame 1), and the non-stream aggregation appends a SECOND root-level `usageMetadata` (duplicate key: the skeleton's trafficType-only block stays in place, the token-count block is appended at the end) instead of replacing it (recorded: S2d7-21). With VALID accumulated args the sets land at their nested positions (recorded: S2d7-23, S2d7-24).
- `text_delta`/`thinking_delta`/`signature_delta` per §2.4. Empty text deltas emit nothing.

---

## 4. Streaming rules (byte-exact contract material)

Downstream framing is decided by the handler (`sdk/api/handlers/gemini/gemini_handlers.go` `handleStreamGenerateContent` + `forwardGeminiStream`, `sdk/api/handlers/stream_forwarder.go`).

### 4.1 `streamGenerateContent` with `alt=sse`, `alt=$alt=sse`, or no `alt` (GetAlt → "")

- Status 200. Headers (set before the first data chunk): `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`, `Access-Control-Allow-Origin: *`, plus the gateway CORS/expose block and `X-Cpa-Trace-Id` (dynamic). With default config (header passthrough disabled) NO upstream response header reaches the client at all — `downstreamHeadersAfterInterceptors` reduces to an empty diff (`sdk/api/handlers/handlers_interceptors.go`); every header the client sees is gateway-set. Recorded: S2d7-02/S2d7-13.
- Each translated chunk C is emitted as the frame: `data: ` + C + `\n\n`. No `event:` lines. No `[DONE]` marker. No trailing bytes after the last chunk. No keep-alive comments by default (interval 0; `StreamingKeepAliveInterval`).
- Header commit happens only when the FIRST chunk is ready: if the upstream fails before any chunk would be produced, the response is a normal error status (§5.1), not a 200 stream.

### 4.2 `streamGenerateContent?alt=json` (or any alt value other than sse/empty)

- Chunks are written RAW and CONCATENATED with NO separator and no framing (recorded body: three JSON objects back-to-back, no newline between). No SSE headers are set by the gateway, and with default config no upstream header flows downstream either — the client receives Go's sniffed default `Content-Type: text/plain; charset=utf-8` (recorded: S2d7-18). HTTP 200 after first chunk. This mirrors upstream v7.3.4 exactly and is an intentional non-equivalence vs the real Gemini API (§7). Pin: golden S2d7-18.

### 4.3 Exact chunk sequence for the reference mock's happy stream

Upstream events (mock_claude.py happy): `message_start`, `content_block_start`(text), `content_block_delta`(text "Hello from mock claude upstream"), `content_block_delta`(text " more"), `content_block_stop`, `message_delta`(stop_reason "end_turn", usage {output_tokens:6}), `message_stop`.

Downstream (alt=sse) — exactly three frames:
```
data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Hello from mock claude upstream"}]}}],"usageMetadata":{"trafficType":"PROVISIONED_THROUGHPUT"},"modelVersion":"claude-mock-model","createTime":"<DYNAMIC>","responseId":"msg_mock_01"}

data: {"candidates":[{"content":{"role":"model","parts":[{"text":" more"}]}}],"usageMetadata":{"trafficType":"PROVISIONED_THROUGHPUT"},"modelVersion":"claude-mock-model","createTime":"<DYNAMIC>","responseId":"msg_mock_01"}

data: {"candidates":[{"content":{"role":"model","parts":[]},"finishReason":"STOP"}],"usageMetadata":{"trafficType":"PROVISIONED_THROUGHPUT","promptTokenCount":0,"candidatesTokenCount":6,"totalTokenCount":6},"modelVersion":"claude-mock-model","createTime":"<DYNAMIC>","responseId":"msg_mock_01"}

```
Rules this sequence pins:
- `message_start`, `content_block_start`(text), `content_block_stop`, `message_stop` produce NO frames.
- Per-chunk skeleton key order: `candidates`, `usageMetadata`, `modelVersion`, `createTime`, `responseId`; inside `candidates[0]`: `content` then (`finishReason` only when set).
- `usageMetadata` key order in stream chunks: `trafficType` FIRST, then `promptTokenCount`, `candidatesTokenCount`, `totalTokenCount`, (`cachedContentTokenCount`), (`thoughtsTokenCount`). (Non-stream order differs — `trafficType` LAST; §2.4.)
- `modelVersion` in stream chunks = upstream `message_start.message.model` (the mock echoes the request model).
- `promptTokenCount` reads only `message_delta.usage.input_tokens` (absent → 0).
- `finishReason` for `message_delta` is ALWAYS `"STOP"`: the stop_reason→finishReason switch result is overwritten by an unconditional STOP set in the same branch (`max_tokens` → `"MAX_TOKENS"` is dead code; `end_turn`, `tool_use`, `stop_sequence`, unknown all → `"STOP"`). Pin: golden S2d7-15.
- A tool_use block adds `finishReason:"STOP"` on its OWN chunk (§3.6), and `message_delta` then emits a second STOP+usage chunk with `"parts":[]`. Pin: golden S2d7-13.

### 4.4 Mid-stream upstream failure (disconnect)

Upstream hard-closes after N events (mock `disconnect` mode): every translated chunk already produced is delivered; then the gateway emits ONE terminal frame and ends the stream (HTTP stays 200):
```
event: error
data: {"error":{"message":"unexpected EOF","type":"server_error","code":"internal_server_error"}}

```
(recorded for the gemini mock fleet; `WriteTerminalError` in `gemini_handlers.go` writes the `event: error` line for the Gemini surface — the OpenAI surface writes only `data:`). Pin: golden S2d7-11 with mock control `{"mode":"disconnect","after":4}` so TWO text chunks precede the error.

### 4.5 Upstream in-stream error EVENT (claude `type:"error"` event mid-SSE)

A Claude SSE `data: {"type":"error","error":{...}}` event translates to a normal data frame carrying a Gemini-shaped error object — NOT the §4.4 terminal frame — and the stream then continues/ends per the upstream:
`data: {"error":{"code":400,"message":"<error.message or 'Unknown error occurred'>","status":"INVALID_ARGUMENT"}}`
The 400/INVALID_ARGUMENT values are fixed regardless of the upstream error type. Pin: golden S2d7-14 (mock extension variant `errstream`). For the NON-STREAM path the same upstream yields 502 (§5.2). Pin: golden S2d7-20.

---

## 5. Error semantics

### 5.1 Upstream HTTP error (before any downstream data)

- The upstream status code and body are passed downstream VERBATIM (recorded for the gemini fleet; same executor pipeline). The Claude 429 body `{"type":"error","error":{"type":"rate_limit_error","message":"mock rate limit"}}` arrives at the client byte-identical with status 429, `Content-Type: application/json`. Pin: golden S2d7-10.
- Applies to both `:generateContent` and `:streamGenerateContent` (for streaming, an error before the first chunk never commits SSE headers).
- 429 also triggers the credential rate-limit cooldown (~1s reset) that `transient-error-cooldown-seconds: -1` does NOT disable (recorded, `_cpa_edge_ref/probes/mocks/README.md` §Error propagation): an immediate follow-up request fails with **HTTP 429** — the status is INHERITED from the wrapped upstream error (the cooldown error chains the original rate-limit `statusErr`, and `clienterror.HTTPStatusFromError` unwraps to its 429; a statusless transport-cause would fall back to the 500 gateway default) — and a JSON body `{"error":{"code":"model_cooldown","last_upstream_error":"<verbatim upstream body>","message":"All credentials for model cm are cooling down via provider claude (last error: <verbatim>)","model":"cm","provider":"claude","reset_seconds":1,"reset_time":"1s"}}` produced by the cooldown error's own marshal of a Go map, so the fields appear in ALPHABETICAL order (evidence: `sdk/cliproxy/auth/selector.go` `modelCooldownError.Error()`). Byte-exact shape pinned by fixture S2d7-19 (recorded immediately after S2d7-10; no upstream request is emitted during cooldown).
- Gateway auth errors (missing/invalid key): 401 `{"error":"..."}` (S1 shapes).

### 5.2 Upstream stream validation failures (non-stream aggregation path)

`validateClaudeStreamingResponse` (`claude_executor_stream.go`) fails the whole request with HTTP 502 and an OpenAI-style wrap of the validator message when the aggregated upstream stream: contains no `data:` line; contains a `type:"error"` event (message `claude executor: upstream returned error event: <msg>`); lacks `message_start` (or it lacks id/model); lacks `message_delta`; or any `data:` payload is invalid JSON. Pin: golden S2d7-20 (error-event variant, non-stream).

### 5.3 Translation-produced errors

- countTokens validation → 400 with the validator message (§2.5).
- Everything else: gateway 5xx wraps (`{"error":{"message":...,"type":"server_error","code":"internal_server_error"}}`) — S1 owns the wrap shapes; this section only pins the pair-specific triggers above.

---

## 6. Golden-sample index

Recorded by @oracle-runner against CLIProxyAPI v7.3.4 (image digest per BOOTSTRAP §2), claude mock upstream (worker copy `run3/mock/mock_claude.py`; recording stack: reference on port 8397, mock on 21002 — port adaptation noted in every `meta.yaml`; config `claude-api-key`, model `claude-mock-model`, alias `cm`). Fixture layout per BOOTSTRAP §7 RECIPES under `tests/fixtures/S2d7/<case-id>/` (`meta.yaml`, `request.http`, `downstream.md`, `upstream.jsonl`, `mock-response.json`).

**Recording status: ALL 25 cases recorded (S2d7-00 … S2d7-24; raw transcripts in `_cpa_edge_ref/run3/probes/S2d7/`). The valid-args companions S2d7-23/24 confirm the non-degraded shapes: finishReason nested inside `candidates[0]` (stream) and a single in-place `usageMetadata` with the S2d7-01 key order (non-stream).**

Requests below use gateway auth `x-goog-api-key: oracle-local-key-1` and the alias model `cm` unless noted. Wire-log secrets are redacted by the mock. Dynamic fields masked: `Date`, `X-Cpa-Trace-Id`, `createTime`, `User-Agent` (caller-controlled, fixed per case by the curl used).

| case | pins | stream | mock control |
|---|---|---|---|
| S2d7-00-auth-401 | 401 body on the /v1beta surface, no upstream call | – | none |
| S2d7-01-nonstream-minimal | non-stream response skeleton, usage-from-message_delta, upstream wire body+headers, user_id sha256, cache_control, always-stream | no | happy |
| S2d7-02-stream-sse | 3-frame SSE sequence of §4.3 | alt=sse | happy |
| S2d7-03-stream-noalt | no-alt == alt=sse framing | no alt | happy |
| S2d7-04-system-snake | `system_instruction` → leading user message (own turn) | no | happy |
| S2d7-05-system-camel | `systemInstruction` dropped | no | happy |
| S2d7-06-tools-roundtrip | functionDeclarations→tools, tool_config ANY+1→tool_choice, functionCall/functionResponse→tool_use/tool_result pairing with `toolu_gemini_0000000000000001` | no | happy |
| S2d7-07-genconfig-sampling | maxOutputTokens override, stop_sequences kept, temperature/topP/topK stripped | no | happy |
| S2d7-08-thinking-level | thinkingLevel low → translated block STRIPPED by the thinking layer (API-key model, no thinking metadata): NO thinking key upstream | no | happy |
| S2d7-09-inline-media | inlineData image + document mapping, part order, cache_control on last part | no | happy |
| S2d7-10-upstream-429 | 429 body+status VERBATIM downstream | yes | error (status 429) |
| S2d7-11-disconnect | 2 chunks then `event: error` unexpected-EOF frame, HTTP 200 | alt=sse | disconnect after=4 |
| S2d7-12-counttokens | local-estimate token count shape; NO upstream request | no | none |
| S2d7-13-tool-stream | tool_use SSE → functionCall chunk then STOP+usage chunk; RAW args splice (invalid JSON flows through; finishReason degrades to chunk top level) | alt=sse | variant `tool` (invalid-args fragments) |
| S2d7-14-errstream | in-stream error event → 400 INVALID_ARGUMENT data frame | alt=sse | variant `errstream` |
| S2d7-15-maxtokens | stop_reason max_tokens → finishReason STOP (override quirk) | alt=sse | variant `maxtokens` |
| S2d7-16-roleless-dropped | contents turn without role → upstream `messages:[]` | no | happy |
| S2d7-17-role-merge | consecutive same-role turns merged; assistant turn separate | no | happy |
| S2d7-18-alt-json | raw concatenated chunks, no framing, sniffed `Content-Type: text/plain; charset=utf-8` | alt=json | happy |
| S2d7-19-cooldown-after-429 | model_cooldown HTTP 429 (status inherited from the wrapped 429), alphabetical body fields, verbatim last_upstream_error, no upstream call | yes | happy (post-429, <1s after S2d7-10) |
| S2d7-20-errstream-nonstream | aggregated error event → 502 validator wrap | no | variant `errstream` |
| S2d7-21-tool-nonstream | functionCall part in non-stream response; RAW args splice (duplicate root-level usageMetadata under invalid args) | no | variant `tool` (invalid-args fragments) |
| S2d7-22-verbatim-model | verbatim provider model name does NOT resolve: 400 model_not_found, no upstream call (only the alias is routable) | no | happy |

Mock extensions required (claude mock, `_cpa_edge_ref/mock/mock_claude.py`, control key `variant`, deterministic canned SSE): `tool` (tool_use block + input_json_delta×2 + stop_reason tool_use), `errstream` (message_start + text delta + `type:"error"` event), `maxtokens` (happy events with stop_reason "max_tokens"). Exact event lists are specified in `spec/recordings/S2d7.cases.json`.

CREDENTIALED-ONLY (FIXTURE-DEFERRED, per R-FIXTURE): Claude OAuth upstream behaviors — `x-api-key` on api.anthropic.com, CLI fingerprint profile (X-App/x-stainless/x-claude-code-* identity headers, anthropic-beta baselines), CCH billing headers, cloaking system injection, 1h cache TTL + `extended-cache-ttl` beta, adaptive-effort registry-known models, thinking signatures replay. Specified from source reading; no local fixtures possible.

---

## 7. Open questions and intentional non-equivalences

1. **`systemInstruction` (camelCase) is dropped** while `system_instruction` (snake) is honored — the opposite of what official Gemini SDKs send by default. Upstream asymmetry vs its own other directions (e.g. `openai→gemini` accepts both keys, `internal/translator/openai/gemini/openai_gemini_request.go`). We mirror v7.3.4 exactly; flagged for a future compat ruling.
2. **System text becomes a `user` turn, not Claude `system`.** Mirrors v7.3.4. Registered as intentional non-equivalence vs hand-written Claude calls; no `system` key ever reaches the upstream for this pair.
3. **Role-less `contents` turns are dropped** although the real Gemini API defaults them to `user`. Mirrored; a client relying on that default silently loses the turn. Golden S2d7-16 pins it.
4. **`promptTokenCount` is 0 unless `message_delta.usage.input_tokens` exists** — real Anthropic streams put input tokens in `message_start`, so most real captures will show 0 for the Gemini client while the OpenAI direction shows the true count. Upstream behavior; noted, not fixed.
5. **`alt=json` concatenation** is not the real Gemini API's JSON-array streaming. Mirrored byte-for-byte; registered as intentional non-equivalence.
6. **countTokens numeric value** depends on an O200kBase tokenizer over the translated body. Byte-exact contract matching needs an equivalent tokenizer in CPA-Edge (JS); the recorded reference value for the golden request is 4. Open question for the orchestrator: approve a tokenizer dependency (e.g. a tiktoken-compatible package) or register `totalTokens` as a masked field in contract tests (shape-only assertion). Fixture S2d7-12 pins the reference integer either way.
7. **finishReason is always STOP** for this pair (both paths; the MAX_TOKENS mapping is dead code upstream). Mirrored. If a future ruling wants real MAX_TOKENS semantics it must be registered in SPEC §5 first.
8. Non-stream `modelVersion` uses the gateway-resolved model name while stream chunks use the upstream-echoed `message.model`. Identical for current fixtures; noted for force-mapped models (S4 interaction).
9. `X-Mock-*` control headers do NOT traverse the gateway (allowlist); mock modes MUST be set via `mock/control/claude.json` for through-gateway recordings.
10. The `?beta=true` query is always appended. Kept for byte-parity; harmless on Anthropic-compatible gateways.
11. **Raw-args splice and its corruption cascade are mirrored deliberately** (fixtures S2d7-13/21): `functionCall.args` bytes from `input_json_delta` accumulation are never re-parsed, so upstream streams that emit invalid partial JSON produce invalid chunk JSON, and later structured sets on the corrupted chunk degrade to root-level appends. CPA-Edge must reproduce this byte-for-byte (the valid-args path S2d7-23/24 shows the non-degraded shape).
12. **Only the config alias is routable; the verbatim upstream model name is not** (fixture S2d7-22). This is registry behavior (S1/S4/S6) observed on this surface; cross-listed there.
