# S2d4 — Claude client → OpenAI upstream (Messages API → Chat Completions)

Section id: S2d4. Module: `packages/translators` (claude→openai direction) + `packages/executors` (openai-compat executor) + `packages/core` routing glue.
Upstream anchor: CLIProxyAPI v7.3.4, commit `8335eac731946bd4eff18f500653f93736df53d6` (see SPEC.md §0).
Upstream evidence paths in this section are relative to the upstream repo root (`_cpa_edge_ref/CLIProxyAPI`). Recorded-fact citations marked **[R]** refer to `reports/oracle/BOOTSTRAP.md`, `_cpa_edge_ref/probes/mocks/README.md`, and the WIRE NOTES recorded by the oracle; per SPEC precedence they outrank this document wherever they conflict.

---

## 1. Scope and boundaries

IN scope:
- `POST /v1/messages` and `POST /v1/messages/count_tokens` as served to Claude-protocol (Anthropic Messages API) clients, **when the model resolves to an `openai-compatibility` provider credential** (base-url override; RECORDABLE-LOCALLY per ruling R-FIXTURE).
- Request translation Claude Messages → OpenAI Chat Completions: every field mapping, drop, and injection documented field-by-field below.
- The upstream HTTP wire contract of the `openai-compatibility` executor for this direction: URL, headers, body mutations (alias rewrite, `stream_options` injection).
- Response translation OpenAI → Claude: non-stream message JSON and the SSE event sequence (`message_start` … `message_stop`) with exact event fields.
- Error semantics on the Claude wire for this direction (pre-stream HTTP errors, in-stream terminal error events, upstream status passthrough, cooldown surfacing).
- `count_tokens` local synthesis for this provider type.

OUT of scope (owned elsewhere):
- Route inventory, method/404 semantics, CORS block, OPTIONS auto-answer, trailing-slash redirects — S1 (R-404 applies here unchanged).
- Client auth middleware mechanics and key styles beyond what is client-visible on these two routes — S1/S3 (the two 401 shapes are pinned here because they are route-visible).
- Credential scheduling, cooldown algorithms, rotation, retry rounds — S4 (only the *client-visible* cooldown error of this direction is pinned here).
- Model listing (`GET /v1/models` Anthropic-format routing) — S1.
- All other upstream provider types (gemini/claude/codex/xai/meta/… executors) — their own sections.
- OAuth-credential providers for the same protocol pair (CREDENTIALED-ONLY per R-FIXTURE; e.g. Claude Code OAuth upstreams are S2d3/S2d9 territory; any OpenAI-family OAuth path is not part of this section).
- Plugin interceptors, model routers, Home dispatch: assumed absent (passthrough); their hooks would observe the payloads defined here.

Intentional non-equivalences and open questions: §7.

---

## 2. Behavior inventory

### 2.1 Routes

| Route | Method | Auth | Success | Notes |
|---|---|---|---|---|
| `/v1/messages` | POST | required | 200 (JSON body or SSE stream) | Wrong method → 404 empty (R-404, S1) |
| `/v1/messages/count_tokens` | POST | required | 200 `{"input_tokens":N}` | Local synthesis; never calls the upstream |

MUST (evidence: `internal/api/server_routes.go` — both routes in the `/v1` group behind `AuthMiddleware`; `sdk/api/handlers/claude/code_handlers.go`):
- The two routes are the ONLY Claude-protocol entry points in scope. `/v1/messages` is NOT aliased at any other path.
- A request to either route without credentials → **401 `{"error":"Missing API key"}`**; with a credential that does not match the configured api-keys → **401 `{"error":"Invalid API key"}`**. This is the shared middleware's plain string shape (`{"error":"<string>"}`), NOT the Claude error object shape — a Claude client sees the non-Anthropic shape for auth failures. (Evidence: `internal/api/server_middleware.go` `accessAuthMiddleware`; `sdk/access/errors.go`; recorded probe 05/06 **[R]**.)
- Accepted credential transports: `Authorization: Bearer <key>`, `X-Api-Key: <key>`, `X-Goog-Api-Key: <key>`, query `?key=`, query `?auth_token=`. (Evidence: `internal/access/config_access/provider.go`.) `anthropic-version` and `anthropic-beta` headers are NOT validated and NOT forwarded upstream.
- `POST /v1/messages` routes stream vs non-stream from the request body's `stream` field read via JSON path `stream`: non-stream iff the field is absent or JSON `false`. Any other JSON type for `stream` (e.g. `null`, `"false"`) selects the STREAMING path. (Evidence: `code_handlers.go` `ClaudeMessages`: `!streamResult.Exists() || streamResult.Type == gjson.False`.) Testable edge; flagged in §7 as unrecorded.
- `POST /v1/messages/count_tokens` never dispatches an upstream HTTP request for `openai-compatibility` credentials; it is synthesized locally (§3.6) **[R — S1 recorded fact + executor design]**.
- Model resolution: the body's `model` string is looked up in the provider registry. If no provider serves it → **400 Claude error shape** with message `unknown provider for model <model>` (§5.2). If it matches an `openai-compatibility` alias, the alias is rewritten to the configured upstream model name on the way out (§3.3).

### 2.2 Upstream execution contract (openai-compatibility executor)

MUST (evidence: `internal/runtime/executor/openai_compat_executor.go`; recorded **[R]** in `probes/bootstrap/mock-recordings` and `probes/mocks/README.md`):

- Upstream URL: `POST <base-url with one trailing "/" removed> + "/chat/completions"`.
- Upstream headers, non-stream: exactly `Content-Type: application/json`, `Authorization: Bearer <provider api-key>`, `User-Agent: cli-proxy-openai-compat`, plus the HTTP client's automatic `Accept-Encoding: gzip`, `Host`, `Content-Length`. **No `Accept` header.**
- Upstream headers, stream: the above PLUS `Accept: text/event-stream` and `Cache-Control: no-cache`.
- Client request headers are NOT forwarded upstream (recorded **[R]**). The only exception is a provider-level `headers:` config map (absent in the oracle config → not in scope of the goldens; behavior documented as: configured custom headers are set on the upstream request).
- Body: the translated Chat Completions object (§3). For stream requests the executor additionally sets `stream_options.include_usage = true` (last-added key) **[R]**.
- Non-stream upstream responses are read fully; HTTP status < 200 or ≥ 300 → the status and the raw body become the error for §5 (no body translation). HTTP 200 → translated per §3.4.
- The response `model` field reaching the Claude client keeps the UPSTREAM model name (no rewrite back to the alias) unless the provider model sets `force-mapping: true` (OPTIONAL config-dependent; not covered by goldens; see §7).
- Non-stream bodies that begin with the gzip magic bytes `1f 8b` are gunzipped before translation even when no `Content-Encoding` header is present (Claude-handler quirk; evidence: `code_handlers.go` `handleNonStreamingResponse`).

### 2.3 Downstream response envelope

MUST (evidence: `code_handlers.go` + `sdk/api/handlers/handlers_interceptors.go` `downstreamHeadersFromExecutor` — with `passthrough-headers: false` (default) upstream response headers are NOT forwarded):
- Non-stream success: status 200, `Content-Type: application/json`, plus the global CORS block (S1) and possibly `X-CPA-TRACE-ID` (dynamic).
- Stream success: status 200, `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`, `Access-Control-Allow-Origin: *`, plus the global CORS block.
- No upstream headers leak downstream by default (no `x-request-id` etc.).

---

## 3. Schemas

### 3.1 Request translation: Claude Messages → OpenAI Chat Completions

The translator (`internal/translator/openai/claude/openai_claude_request.go`, `ConvertClaudeRequestToOpenAI`; registered `Claude→OpenAI` in its `init.go`) emits a JSON object. The reference emission key order (deterministic; informative for byte-parity, not contract-pinned) is: `model`, `messages`, then appended keys in processing order: `max_tokens`, `temperature`|`top_p`, `stop`, `stream`, `reasoning_effort`, `tools`, `tool_choice`, `user`, and finally `stream_options` (executor, stream only).

Field-by-field MUSTs:

| Claude request field | Upstream Chat Completions field | Rule |
|---|---|---|
| `model` | `model` | The **alias-resolved upstream model name** (`mock-model` → `mock-gpt-model`), never the client alias **[R]**. Resolution happens in the auth manager before translation. |
| `max_tokens` | `max_tokens` | Copied when present (integer). Absent → **omitted** (no default injected). |
| `temperature` | `temperature` | Copied when present. |
| `top_p` | `top_p` | Copied **only when `temperature` is absent**. If both present, `temperature` wins and `top_p` is dropped. |
| `top_k` | — | **Always dropped.** |
| `stop_sequences` | `stop` | Array of strings, copied when a non-empty array. Empty array / non-array → omitted. |
| `stream` | `stream` | Always set: `true`/`false` mirrors the server-side execution mode (which follows the client `stream` truthiness rule §2.1). |
| `thinking` | `reasoning_effort` | See §3.2 thinking table. Absent `thinking` → no `reasoning_effort`. |
| `system` | first `messages` entry | See §3.2. |
| `messages` | `messages` (after system) | See §3.2. |
| `tools` | `tools` | See §3.2. |
| `tool_choice` | `tool_choice` | `{"type":"auto"}` → `"auto"`; `{"type":"any"}` → `"required"`; `{"type":"tool","name":X}` → `{"type":"function","function":{"name":X}}`; present but unrecognized/missing `type` → `"auto"`. |
| `user` | `user` | Copied when present (top-level string). |
| `metadata` (incl. `metadata.user_id`) | — | **Dropped.** |
| `cache_control` (any block) | — | **Dropped** (not representable upstream). |
| everything else (unknown fields) | — | **Dropped.** The upstream body contains only the keys listed here. |

#### Thinking → `reasoning_effort` (two stages; the EFFECTIVE mapping is the contract)

Stage 1 — translator (`openai_claude_request.go` + `internal/thinking/convert.go` `ConvertBudgetToLevel`): writes a PROVISIONAL `reasoning_effort` — `budget_tokens`: `-1`→`auto`, `0`→`none`, `1..512`→`minimal`, `513..1024`→`low`, `1025..8192`→`medium`, `8193..24576`→`high`, `≥24577`→`xhigh`; enabled without budget → `auto`; `adaptive`/`auto` → `output_config.effort` (lowercased/trimmed) or `xhigh`; disabled → `none`.

Stage 2 — thinking pipeline (`helps.ApplyRequestThinking` → `internal/thinking/{apply,validate}.go` + `internal/thinking/provider/openai/apply.go`): runs AFTER translation, re-reads the thinking config from the ORIGINAL Claude body (`extractClaudeConfig`), validates it against the selected model's capability, and REWRITES `reasoning_effort` in the already-translated body in place (key position preserved). For openai-compatibility models configured WITHOUT a per-model `thinking:` block, the capability is `ThinkingSupport{Levels:["low","medium","high"]}` with disable not allowed and dynamic not allowed (evidence: `sdk/cliproxy/auth/api_key_model_capabilities.go` `compileOpenAICompatibleModelCapabilities`; `internal/modelconfig/model_info.go` — `UserDefined=false` for configured models, so the validated stage-2 path runs). The EFFECTIVE mapping for that default capability — the values the upstream actually receives (goldens: S2d4-thinking-budget round 1; S2d4-thinking-* round 2 below; cross-evidence: the same executor+capability shape is recorded in S2d2 goldens `gem2oai-thinking-clamps` and `gem2oai-thinking-invalid`):

| Claude `thinking` | Effective upstream `reasoning_effort` |
|---|---|
| `{"type":"disabled"}` | `low` (disable not allowed → first supported level) |
| `{"type":"enabled","budget_tokens":0}` | `low` (0 → `none` → clamped to lowest supported) |
| `{"type":"enabled","budget_tokens":-1}` | `medium` (auto → mid-range level; dynamic not allowed) |
| `{"type":"enabled"}` (no budget) | `medium` |
| `{"type":"enabled","budget_tokens":1..1024}` | `low` (`minimal`/`low` clamp to the supported set) |
| `{"type":"enabled","budget_tokens":1025..8192}` | `medium` |
| `{"type":"enabled","budget_tokens":8193..24576}` | `high` |
| `{"type":"enabled","budget_tokens":≥24577}` | `high` (`xhigh` clamps to the nearest supported level) |
| `{"type":"enabled","budget_tokens":<-1}` | request fails **400** — `budget <N> cannot be converted to a valid level` (§5.2; fails before dispatch) |
| `{"type":"adaptive"}` or `{"type":"auto"}` + `output_config.effort:"none"` | `low` |
| `… + output_config.effort:"auto"` | `medium` |
| `… + output_config.effort:"minimal"` | `low` |
| `… + output_config.effort:"low"/"medium"/"high"` | unchanged |
| `… + output_config.effort:"xhigh"` | `high` |
| `… + output_config.effort:"max"` | `high` |
| `… + output_config.effort:<any other string>` | request fails **400** — `level "<value>" not supported, valid levels: low, medium, high` (§5.2; fails before dispatch) |
| `{"type":"adaptive"}` WITHOUT `output_config.effort` | `high` (stage 2 re-reads the stage-1 provisional `xhigh` from the translated body and clamps it; recorded in S2d4-thinking-adaptive-noeffort) |

MUST: stage-1 values are never visible to the upstream on their own — only the effective (stage-2) values are. Models configured WITH a per-model `thinking:` block (or a registry entry) take their effective values from that capability definition — config-dependent, out of golden scope.

### 3.2 Message and content conversion

System (evidence: `openai_claude_request.go` `appendSystemContent` + `internal/util/claude_attribution.go`):
- Top-level `system` (string OR array of blocks) produces AT MOST ONE upstream message `{"role":"system","content":[...]}` placed FIRST in `messages`. The content is ALWAYS an array of `{"type":"text","text":...}` parts — even when the client sent a bare string (a one-part array).
- Dropped parts: empty/whitespace-only text; any text whose left-trimmed value starts with `x-anthropic-billing-header:` (Claude Code attribution block); non-text blocks. If nothing survives, NO system message is emitted.

Per-message conversion (evidence: same file, message loop; `internal/translator/common/claude_system.go`, `claude_messages.go`):
- String content (`"content":"..."`) for roles `user`/`assistant` → upstream message `{"role":<role>,"content":"<string>"}` — string form preserved.
- Array content → array of converted parts (below). If no part survives, the message contributes nothing on its own.
- `role: "system"` INSIDE `messages` is not a real Anthropic role but the gateway accepts it: its text content (string or text blocks, non-empty, non-attribution) becomes a `{"role":"user","content":[{"type":"text","text":...}]}` message whose text is wrapped as `<system-reminder>\n<text>\n</system-reminder>` (one wrapper for all its text parts joined by `\n`). Non-text-only system messages are dropped. Ordering: when such a reminder arrives while tool_use ids are pending (i.e. between an assistant tool_use message and the user tool_result message), it is buffered and emitted AFTER the tool result messages; otherwise in place.
- Content part types:
  - `text` → `{"type":"text","text":...}` (whitespace-only and attribution-prefixed texts dropped).
  - `image` → `{"type":"image_url","image_url":{"url":U}}` where `U` = `data:<media_type>;base64,<data>` for `source.type=="base64"` (empty `media_type` → `application/octet-stream`); `source.url` for `source.type=="url"`; fallback to a top-level `url` field on the block; block dropped when no URL results.
  - `document` → **dropped.**
  - `thinking` → assistant messages only; see below. In user/system content → **dropped** (injection guard).
  - `redacted_thinking` → **always dropped** (any role).
  - `tool_use` → assistant messages only; see below. In user/system content → **dropped** (injection guard).
  - `tool_result` → any role; see below.
- Assistant message shape: a SINGLE upstream `{"role":"assistant", ...}` message carrying `"content"` (array of surviving text/image parts, or the empty string `""` when none), `"reasoning_content"` (see below) and `"tool_calls"` (see below) — never split into multiple assistant messages.
  - `tool_calls` entry per `tool_use` block: `{"id":<block id verbatim>,"type":"function","function":{"name":<name>,"arguments":<input RAW bytes as a JSON string>}}`; `input` absent → `"{}"`. Emission-order note (recorded in S2d4-tool-roundtrip / S2d4-toolresult-image-relay): the reference re-serializes each entry through a JSON map, emitting Go sorted-map key order `{"function":{"arguments":...,"name":...},"id":...,"type":...}` — deep-equal content, informative key order only per §4.5.
  - String values in the upstream body are HTML-escaped by the reference's serializer: `<`, `>`, `&` become `\u003c`, `\u003e`, `\u0026` (recorded: the `<system-reminder>` wrapper text is emitted as `\u003csystem-reminder\u003e` in S2d4-tool-roundtrip). Deep-equal comparison is unaffected; byte-parity implementers must reproduce it.
  - `reasoning_content`: with the provider model's `is-compat: false` (default), a thinking block maps to `reasoning_content` ONLY IF it has a non-empty `signature` that passes the GPT signature-compatibility envelope check (`internal/signature/provider_compatibility.go`, `SignatureProviderGPT`); empty-signature thinking blocks are dropped. With `is-compat: true`, every non-empty thinking text maps (whitespace-only skipped); multiple thinking blocks are joined with `\n\n`. (Evidence: `openai_claude_request.go` `shouldMapClaudeThinkingToGPTReasoning`, `ConvertClaudeRequestToOpenAIWithCompat`; executor selection via `internal/runtime/executor/helps/codex_multi_agent_v2.go` `TranslateRequestWithAPIKeyModelCompatibility` + `model_capabilities.go`.)
- `tool_result` handling: each `tool_result` block becomes ONE upstream message `{"role":"tool","tool_call_id":<tool_use_id>,"content":<string>}`. Content string construction: array items that are strings or `{"type":"text"}` contribute their text; image items are extracted for relay (below); other items contribute their raw JSON; texts joined with `\n\n`. When the joined text is empty AND images were extracted → content is the exact placeholder `[Tool returned image content; the images follow in the next user message.]`. When content is absent entirely → `""`.
- Image relay: extracted tool_result images are re-emitted as a `{"role":"user","content":[...]}` message whose FIRST part is the notice text `Images returned by the preceding tool call(s):` followed by the image parts. If the same user message also carries surviving text/image content, the relay parts are PREPENDED to that message's content instead (single user turn preserved).
- tool_result alignment: when the immediately preceding assistant message announced tool_use ids and the next user message contains exactly as many `tool_result` blocks, the blocks are REORDERED to match the tool_use id order (positions otherwise preserved). Incomplete matches pass through unchanged. (Evidence: `internal/translator/common/claude_messages.go` `AlignClaudeToolResults`.)
- Emission order within one user message: [tool result messages] → [image-relay user message] → [buffered system-reminder messages] → [the message's own content message]. The message's own content message is omitted when nothing survived.
- `messages: []` (or all messages dropped) → upstream `messages` stays `[]` (no synthetic turn, no validation error). The gateway performs NO Anthropic schema validation of its own.
- Tools array: each `{"name","description","input_schema"}` → `{"type":"function","function":{"name","description","parameters"}}`:
  - `input_schema` is RE-SERIALIZED through a JSON map (reference: Go `encoding/json` — sorted object keys, HTML-escaped `<`,`>`,`&`) after schema normalization: `type:"object"` without `properties` GAINS `"properties":{}`; `pattern` values and `patternProperties` keys using unsupported unicode property escapes are deleted recursively (evidence: `normalizeObjectSchemaProperties` + `internal/util` schema keyword lists).
  - missing/absent `input_schema` → `parameters` = `{"type":"object","properties":{}}`.

### 3.3 Alias rewrite and model fields

MUST **[R + evidence: auth manager `sdk/cliproxy/auth/conductor_execution.go` `preparedExecutionModelsWithAlias`; bootstrap §6]**:
- The upstream body `model` is the provider-configured upstream name. The downstream response `model` (non-stream JSON and SSE `message_start.message.model`) is the UPSTREAM name echoed by the upstream (e.g. `mock-gpt-model`), unless `force-mapping: true`.

### 3.4 Non-stream response translation: OpenAI chat completion → Claude message

(evidence: `internal/translator/openai/claude/openai_claude_response.go` `ConvertOpenAIResponseToClaudeNonStream`)

Output object (exact key order): `{"id","type":"message","role":"assistant","model","content":[...],"stop_reason":...,"stop_sequence":null,"usage":{"input_tokens":...,"output_tokens":...}}` plus optional usage cache fields.

MUST:
- `id`, `model` copied from the upstream response. `type` is always `"message"`, `role` always `"assistant"`, `stop_sequence` always `null`.
- Only `choices[0]` is considered. No choices → empty `content`.
- Content blocks, in order:
  1. From `choices[0].message.content` when it is a STRING: one `{"type":"text","text":...}` block (empty string → no block).
  2. When it is an ARRAY: `text` items accumulate into one text block (consecutive text items merged); `tool_calls` items flush pending accumulators and emit `tool_use` blocks; `reasoning` items accumulate into a thinking block (flushed before text); other item types flush and are dropped. (Coexistence of string+array forms is upstream-defined; goldens pin the string form and the reasoning/tool_calls path via `message` fields below.)
  3. `choices[0].message.reasoning_content` → thinking blocks `{"type":"thinking","thinking":<text>}` (accepts a bare string, an array of strings/objects, or objects with a `text` field; empty texts skipped), appended AFTER the content-derived blocks.
  4. `choices[0].message.tool_calls` → `tool_use` blocks appended last.
- `tool_use` block: `{"type":"tool_use","id":<sanitized>,"name":<mapped>,"input":<object>}`:
  - `id` = SanitizeClaudeToolID(upstream id): every character outside `[a-zA-Z0-9_-]` replaced with `_` (empty id → server-generated `toolu_<unix-nano>_<counter>`; generation is dynamic — not golden-pinned).
  - `name` = MapToolName(request tool-name map, upstream name): the map is built from the client request's `tools[].name` (canonical key = trim, strip leading `_`, lowercase); an upstream name matching a canonical key case-insensitively is restored to the request's exact casing; otherwise the upstream name passes through. (Evidence: `internal/util/translator.go` `ToolNameMapFromClaudeRequest`, `MapToolName`.)
  - `input` = `FixJSON(arguments)` (single→double quote repair, `internal/util/translator.go`) parsed as JSON; a valid JSON object → that object; anything else → `{}`.
- `stop_reason` mapping (`mapOpenAIFinishReasonToAnthropic`): `stop`→`end_turn`; `length`→`max_tokens`; `tool_calls`→`tool_use`; `content_filter`→`end_turn`; legacy `function_call`→`tool_use`; unknown→`end_turn`. Absent finish_reason → `tool_use` when any tool_use block was produced, else `end_turn`.
- Usage (`extractOpenAIUsage`): `input_tokens` = `usage.prompt_tokens` minus `usage.prompt_tokens_details.cached_tokens` (clamped at 0); `output_tokens` = `usage.completion_tokens`; `cache_read_input_tokens` = cached_tokens, present only when > 0 (key order: appended after `output_tokens`); `cache_creation_input_tokens` = `prompt_tokens_details.cache_write_tokens`, falling back to `cache_creation_tokens`, present only when > 0. No `usage` → `{input_tokens:0, output_tokens:0}`.

### 3.5 Streaming usage semantics

Covered in §4 (message_delta usage) — same `extractOpenAIUsage` math as §3.4.

### 3.6 count_tokens

MUST (evidence: `openai_compat_executor.go` `CountTokens` + `helps/token_helpers.go` + `internal/translator/common/bytes.go` `ClaudeInputTokensJSON`; recorded S1 fact **[R]**):
- The request body is translated with the same request translator (stream forced to `false`), then token-counted LOCALLY: segments = for each message: `role`, `name` (if any), content texts (strings; text parts; `image_url` URLs count as their URL string; tool_result name+content recursed), `tool_calls` (id, type, function name/description/arguments/parameters), plus top-level `tools`, `functions`, `tool_choice`, `response_format` (type/name/schemas), `input`, `prompt`. Non-empty trimmed segments are joined with `\n` and counted with a model-selected tokenizer (model-name heuristic; unrecognized models like `mock-gpt-model` → `o200k_base`).
- Response: 200, `Content-Type: application/json`, body exactly `{"input_tokens":<N>}` (no other keys).
- No upstream HTTP request is made; upstream wire log for such requests is empty.

---

## 4. Streaming rules

### 4.1 Upstream SSE consumption (executor)

MUST (evidence: `openai_compat_executor.go` `ExecuteStream` scan loop; recorded **[R]** for the openai wire):
- When the client selected streaming, the upstream request carries `stream:true` and the SSE headers per §2.2. Frames are parsed line-wise: `data:` lines are collected (multiple `data:` lines in one frame are joined with `\n`); `event:` lines are captured as the frame's event name; `:`/`id:`/`retry:` lines are ignored. A blank line ends the frame.
- `data: [DONE]` terminates the stream (no translation output from that frame itself beyond the terminal events below).
- A clean EOF without a preceding `[DONE]` synthesizes `[DONE]` for non-Responses clients (i.e. this direction) — the stream still terminates normally. **[R — the oracle mock's canned SSE has no [DONE] and the golden S2d4-stream-text records the synthesized terminal events.]**
- Upstream frames whose data payload is a JSON object with `error`/`response.error`, or `type` `error`/`response.error`/`response.failed`, or an `event:` name of `error`/`response.error`/`response.failed`, or top-level `code`+`message` → the stream FAILS with that status (from the payload when 400..599, else 502) and the payload as the error text. A bare JSON line outside a frame → 502 failure. Malformed/incomplete JSON data frames → 502 failure.

### 4.2 Downstream event sequence

Framing: every event is emitted as exactly `event: <name>\ndata: <json>\n\n` (UTF-8). One upstream frame may produce several downstream events back-to-back; the client-visible byte stream is the concatenation (chunk boundaries are not observable). The translator state is per-request.

Event templates (exact key order; values filled as specified):

```
event: message_start
data: {"type":"message_start","message":{"id":"<upstream first-chunk id>","type":"message","role":"assistant","model":"<upstream first-chunk model>","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":<EST>,"output_tokens":0}}}

event: content_block_start        (text)
data: {"type":"content_block_start","index":<i>,"content_block":{"type":"text","text":""}}

event: content_block_start        (thinking)
data: {"type":"content_block_start","index":<i>,"content_block":{"type":"thinking","thinking":""}}

event: content_block_start        (tool_use)
data: {"type":"content_block_start","index":<i>,"content_block":{"type":"tool_use","id":"<id>","name":"<name>","input":{}}}

event: content_block_delta        (text)
data: {"type":"content_block_delta","index":<i>,"delta":{"type":"text_delta","text":"<chunk text>"}}

event: content_block_delta        (thinking)
data: {"type":"content_block_delta","index":<i>,"delta":{"type":"thinking_delta","thinking":"<chunk text>"}}

event: content_block_delta        (tool args; ONE event at finalize)
data: {"type":"content_block_delta","index":<i>,"delta":{"type":"input_json_delta","partial_json":"<complete arguments JSON>"}}

event: content_block_stop
data: {"type":"content_block_stop","index":<i>}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"<mapped>","stop_sequence":null},"usage":{"input_tokens":<U>,"output_tokens":<V>}[,"cache_read_input_tokens":C][,"cache_creation_input_tokens":W]}}

event: message_stop
data: {"type":"message_stop"}
```

Sequence MUSTs (evidence: `openai_claude_response.go` `convertOpenAIStreamingChunkToAnthropic` + helpers):
1. `message_start` is emitted on the FIRST chunk that has a `choices[0].delta` object — regardless of whether the delta carries a `role` field. Its `id`/`model` are captured from the FIRST chunk of the stream (even if that earlier chunk produced no events) and never updated afterwards. `usage.input_tokens` is the local estimate `<EST>` (§4.3); `output_tokens` is 0.
2. Blocks are strictly sequential: at most one block is open at a time; a text block opens lazily on the first non-empty `delta.content`; a thinking block opens on the first `delta.reasoning_content` (string, array, or `{text}` objects; empty texts skipped); before a new block starts, the previous open block is stopped with `content_block_stop`. Block indexes are allocated in open order (thinking before text, etc.).
3. Tool calls: for each `delta.tool_calls[i]` the id (string, non-empty) and function name are recorded until the block start is emitted; a `content_block_start` (tool_use) is emitted MID-STREAM as soon as the accumulator has a non-empty id AND a non-empty name AND no other tool block is open. The name is tool-name-mapped as in §3.4. `function.arguments` deltas are accumulated but NOT forwarded incrementally: the complete arguments (after `FixJSON`) are emitted as ONE `input_json_delta` at the block's finalize, immediately followed by `content_block_stop`. A finish_reason frame (or [DONE]) finalizes ALL tool blocks, emitting any belated starts: a tool call that never got a name but has id and/or arguments gets a synthesized name `tool_<openai-index>` (OPTIONAL defensive behavior; cited, unrecorded).
4. Text/thinking deltas arriving while a tool_use block is open are buffered (not emitted inline) and flushed at finalize, after the tool blocks, as complete start/delta/stop triples with fresh indexes; consecutive buffered deltas of the same type are merged into one block.
5. `finish_reason` is captured from `choices[0].finish_reason` when a non-empty string: `length` and `content_filter` are kept verbatim in the internal state; with an announced tool block (`content_block_start` emitted): tool-call arguments that are empty, `{}`, or a valid JSON object → `tool_calls`; non-empty arguments that are not a valid JSON object → `length`; `tool_calls` WITHOUT any announced tool block → `stop`; anything else kept verbatim. The capture frame also finalizes all open blocks (stops text/thinking; flushes tool blocks per rule 3/4).
6. Usage capture: whenever a chunk has a non-null `usage`, its values are cached. `message_delta` + `message_stop` are emitted together at the FIRST chunk where (`finish_reason` already captured OR trailing-usage condition met) AND `usage` is present — the trailing-usage condition is: `usage` present, no `choices[0]`, and at least one of: finish captured, a tool block announced, a text/thinking block started, content accumulated, or interleaved chunks buffered. Otherwise both events are emitted at `[DONE]` (real or synthesized). `[DONE]` emits only what is still missing: finalize blocks → `message_delta` (if not yet sent) → `message_stop` (if not yet sent).
7. `message_delta.delta.stop_reason` = mapOpenAIFinishReasonToAnthropic(effective internal reason; default `stop` when empty): same mapping table as §3.4. `message_delta.usage` uses the last cached upstream usage with the §3.4 cache math; when no usage was ever received it is `{"input_tokens":0,"output_tokens":0}`.
8. If the upstream data channel closes with NO events produced at all, the handler still commits SSE headers and an empty stream body (no events) — degenerate case, cited, not golden-pinned.

### 4.3 message_start input-token estimate

MUST (evidence: `internal/runtime/executor/helps/claude_input_tokens.go` — enabled only for claude-source + non-claude upstream + claude response format, i.e. exactly this direction):
- `<EST>` = o200k_base token count of the trimmed non-empty segments of the ORIGINAL client request, joined with `\n`: system texts (string or text blocks); per message: the `role` string and the content's text segments (text blocks, thinking blocks' `thinking`, document title/context and text-source `data`/`content`, tool_use id+name+compact-input, tool_result tool_use_id+tool_call_id+content recursion); tools (`type`, `name`, `description`, compact `input_schema`); `tool_choice`. Image/audio/video/redacted_thinking content contributes nothing.
- The estimate patches the FIRST `message_start` only, only when its `usage.input_tokens` is 0 (always true here) and the estimate is > 0. It is DETERMINISTIC for a fixed request body and is NOT a masked dynamic field in goldens.

### 4.4 Streaming failure modes

- Failure BEFORE the first downstream byte (upstream status error, connection refused, …): the client receives a plain HTTP error response — status from the error (e.g. 429), `Content-Type: application/json`, body in the Claude error shape (§5). NO `text/event-stream` headers. **[Golden S2d4-stream-error-429.]**
- Failure AFTER the first byte (mid-stream transport error, malformed frame, upstream in-stream error payload): the client's HTTP status stays 200 and the stream is terminated by the SSE frame:
  `event: error\ndata: {"type":"error","error":{"type":"api_error","message":"<error text>"}}\n\n`
  No `content_block_stop`/`message_delta`/`message_stop` is synthesized for the open block(s). For a hard disconnect the error text is `unexpected EOF` **[R — mirrors the recorded OpenAI-client fact; the Claude-client frame shape is pinned by golden S2d4-stream-disconnect]**.

### 4.5 Contract comparison rules for goldens

- Downstream responses (status, headers, body) and SSE streams are compared BYTE-EXACTLY after masking only whitelisted dynamic fields: `Date`, `X-CPA-TRACE-ID`, port numbers/Host, wire-log `ts`. SSE chunk boundaries are ignored (compare the concatenated stream).
- `message_start.usage.input_tokens` and `count_tokens` `input_tokens` are deterministic (§4.3/§3.6) and are compared exactly.
- `upstream.jsonl` entries are compared deep-equal (JSON), arrays order-sensitive; object key order is informative (the reference's emission order is documented in §3.1) but not contract-pinned; headers compared semantically (presence/absence/value where stable).

---

## 5. Error semantics

### 5.1 Claude error body shape

MUST (evidence: `sdk/api/handlers/claude/code_handlers.go` `WriteErrorResponse`, `toClaudeError`, `claudeErrorDetailFromText`, `claudeErrorTypeFromStatus`):
- Handler-level errors on both routes answer with HTTP status + JSON body (struct order): `{"type":"error","error":{"type":"<error type>","message":"<message>"}}`, `Content-Type: application/json`.
- Message extraction: when the underlying error text is valid JSON — an object with an `error` object contributes `error.type` (when a non-empty string) and `error.message` (or `error.code` when the message is absent); otherwise a top-level `type` (≠`"error"`) and `message` are used; otherwise the raw error text is the message verbatim.
- Status → type map when the payload does not override it: 401 `authentication_error`; 402 `billing_error`; 403 `permission_error`; 404 `not_found_error`; 413 `request_too_large`; 429 `rate_limit_error`; 504 `timeout_error`; 529 `overloaded_error`; ≥500 `api_error`; otherwise `invalid_request_error`.
- The middleware-level 401s are the ONE exception (§2.1): plain `{"error":"<string>"}`.

### 5.2 Pinned error behaviors (this direction)

| Condition | Status | Body (Claude shape) | Evidence / golden |
|---|---|---|---|
| Missing key | 401 | `{"error":"Missing API key"}` (middleware shape) | S2d4-auth-missing |
| Invalid key | 401 | `{"error":"Invalid API key"}` (middleware shape) | S1 recorded; same middleware |
| Unknown model | 400 | `{"type":"error","error":{"type":"invalid_request_error","message":"unknown provider for model <model>"}}` — internal OpenAI-style `code:"model_not_found"`/`param` fields are dropped on the Claude wire | S2d4-unknown-model |
| Upstream 429 (or any upstream status error with JSON body) | upstream status verbatim (429 …) | type+message extracted from the upstream `error` object; `code` dropped; non-JSON upstream bodies → message verbatim, type from the status map | S2d4-error-429 |
| Immediate retry while the credential is in the rate-limit cooldown | **429 (recorded)** | `{"type":"error","error":{"type":"rate_limit_error","message":"All credentials for model <requested model> are cooling down via provider <namespaced provider> (last error: <verbatim upstream error body>)"}}` plus a `Retry-After: <reset estimate>` header (recorded: `Retry-After: 1`). Recorded facts pinned by S2d4-cooldown-second: (a) the provider string is the NAMESPACED provider key `openai-compatible-<entry name>` (e.g. `openai-compatible-mock-openai`; evidence: `internal/util/provider.go` `openAICompatibleProviderPrefix`); (b) the last-error segment embeds the upstream 429 body VERBATIM (raw bytes incl. spacing) for this payload layout — not a compact code+message summary; (c) the request does NOT reach the upstream (empty wire log); (d) `transient-error-cooldown-seconds: -1` does NOT disable this cooldown **[R]**; (e) the measured effective window for this provider type is **2–4 s** (cooldown active at t=2s, cleared by t=4s; probe `_cpa_edge_ref/run4/probes/S2d4/cooldown-probe.json`) — the `Retry-After: 1` header reflects the internal reset estimate, not the full window | S2d4-cooldown-second |
| Streaming request failing before first event | upstream status | Claude error JSON, `Content-Type: application/json`, NO SSE headers | S2d4-stream-error-429 |
| Mid-stream failure after first event | 200 (already committed) | in-stream `event: error` frame (§4.4) | S2d4-stream-disconnect |
| count_tokens with unknown model | 400 | same unknown-provider shape as /v1/messages | cited (same routing path) |

Upstream Retry-After: a 429 carrying a `Retry-After` header (or a TPM-style body) sets a retry hint that surfaces as a downstream `Retry-After` header when present; the oracle mock's 429 body carries none, so goldens assert absence.

---

## 6. Golden samples index

Recordings: CLIProxyAPI v7.3.4 (docker image digest `sha256:97825da3009f98acf78b5c172fde650a5fbe7a690950a69ce6d7b535d77d4266`), oracle env per `reports/oracle/BOOTSTRAP.md` §3 + §7 RECIPES; mission recordings requested via `spec/recordings/S2d4.cases.json`. All S2d4 behaviors are RECORDABLE-LOCALLY (openai-compatibility provider with base-url override per R-FIXTURE).

Recording environment (@oracle-runner-4 stack, recorded 2026-09-16): reference on `127.0.0.1:8407` (mission config `config.s2d4.yaml`: fleet config + second openai-compatibility entry `mock-openai-compat`), openai mock on port `21999` (base-url `http://host.docker.internal:21999/v1`), extended with the requested control-file "script" mode; client api key `oracle-local-key-1`; upstream provider key `mock-upstream-key`; alias `mock-model` → upstream model `mock-gpt-model`; second alias `mock-model-compat` (is-compat: true) → `mock-gpt-model`. Raw transcripts: `_cpa_edge_ref/run4/probes/S2d4/` (README + per-case raw request/response + upstream slices + `cooldown-probe.json`). Port numbers anywhere in a transcript are masked dynamic fields; all other bytes are compared exactly (§4.5).

Fixtures live in `tests/fixtures/S2d4/<case-id>/` per the RECIPES layout (`meta.yaml`, `request.http`, `downstream.md`, `upstream.jsonl`, `mock-response.json`) — **22/22 recorded**.

| case-id | pins | stream | mock mode |
|---|---|---|---|
| S2d4-min-nonstream | baseline request+response mapping, x-api-key auth, alias rewrite, system string→array, usage 9/6, upstream headers | no | happy |
| S2d4-params | system 2-block array, temperature/top_k/stop/user/metadata rules | no | happy |
| S2d4-system-attribution-temperature | attribution drop + temperature-over-top_p precedence | no | happy |
| S2d4-stream-text | full event sequence incl. synthesized-[DONE] terminal events; stream_options + SSE upstream headers; message_start estimate | yes | happy |
| S2d4-thinking-budget | budget→reasoning_effort (8192→medium); unsigned thinking drop | no | happy |
| S2d4-tools-request | tools array shape, schema re-serialization/normalization, tool_choice any→required | no | happy |
| S2d4-tool-roundtrip | assistant tool_calls, tool messages, result reordering, <system-reminder> wrap + ordering | no | happy |
| S2d4-images | base64/url image conversion | no | happy |
| S2d4-toolresult-image-relay | placeholder + relay user message | no | happy |
| S2d4-count-tokens | local synthesis `{"input_tokens":43}`, empty upstream log | no | happy |
| S2d4-nostream-rich | thinking+text+tool_use blocks, id sanitize, name map, stop_reason tool_use, usage cache math | no | script |
| S2d4-stream-tools | buffered args → single input_json_delta, stop_reason tool_use | yes | script |
| S2d4-stream-reasoning | thinking→text block sequencing (indexes 0,1) | yes | script |
| S2d4-stream-usage | trailing usage-only chunk → message_delta usage + message_stop at that chunk | yes | script |
| S2d4-empty-messages | permissive validation (messages:[] forwarded) | no | happy |
| S2d4-compat-thinking | is-compat: assistant thinking preserved as reasoning_content | no | happy (config variant) |
| S2d4-auth-missing | 401 middleware shape on the Claude route | no | none (no upstream) |
| S2d4-unknown-model | 400 unknown-provider Claude shape; code/param dropped | no | none (no upstream) |
| S2d4-error-429 | upstream 429 status passthrough + Claude reshape (type/message extraction) | no | error |
| S2d4-cooldown-second | model_cooldown error on the Claude wire (recorded status+body) | no | error (not reached) |
| S2d4-stream-error-429 | pre-stream failure → plain JSON 429, no SSE headers | yes | error |
| S2d4-stream-disconnect | 200 + partial events + `event: error` `unexpected EOF` frame | yes | disconnect |

RECORDING STATUS: **22/22 recorded** by @oracle-runner-4 (initially requested from oracle-runner-5, rerouted). Verification outcome: 21/22 byte-exact against the pre-recording derivations in `spec/recordings/S2d4.cases.json`, including all four deterministic token counts (message_start estimates 3/33/7/6 and count_tokens 43), all SSE byte streams, all upstream paths/bodies/header include+omit assertions, and the four empty-wire-log assertions (count-tokens, auth-missing, unknown-model, cooldown-second). Recorded divergences (recorded bytes are the golden; also captured per-case in `meta.yaml`): the cooldown-second body's provider string (`openai-compatible-mock-openai`) and verbatim last-error embedding (§5.2); upstream tool_calls key order and HTML-escaped `<system-reminder>` text (informative-only per §4.5, documented in §3.2). Deferred: none (all cases RECORDABLE-LOCALLY).

---

## 7. Open questions and intentional non-equivalences

Open questions:
1. **`stream` truthiness edge** — `"stream": null` / `"stream": "false"` select the STREAMING path in the reference (§2.1). Recorded? No (low value); flagged for a possible later batch. Contract tests from this section MAY pin it via direct replay once recorded.
2. ~~Cooldown second-request status~~ — RESOLVED by recording: **429** with `Retry-After: 1` (S2d4-cooldown-second, §5.2).
3. **Cooldown window vs Retry-After** — the measured effective cooldown for this provider type is 2–4 s while the surfaced `Retry-After` is 1 (§5.2(e)); the internal re-arm policy behind the gap is S4 territory, not pinned here.
4. **`force-mapping: true`** response model rewrite and **provider `headers:`** custom-header injection are config-dependent OPTIONAL behaviors (documented §2.2/§3.3, unrecorded). Recording them needs a config variant similar to S2d4-compat-thinking; deferred by mutual agreement unless the implementer needs them.
5. **Multiple choices** (`choices` length > 1): only `choices[0]` is translated (§3.4). The reference behavior is pinned by code reading; an upstream sending 2+ choices is out of the golden set.
6. **`toolu_` empty-id generation** (§3.4) embeds wall-clock time — dynamic; the golden avoids empty ids by construction.
7. **In-stream keep-alive comments** (`: keep-alive`) are emitted only when `streaming.keep-alive-seconds` is configured (> 0); the oracle config has it disabled and goldens assert no comment frames. OPTIONAL otherwise.
8. **Last-error summary formatting** — the recorded cooldown message embeds the upstream 429 body verbatim (§5.2); the reference's upstream-error summarizer can also emit compact `<code>: <message>` forms for other payload layouts. The verbatim form is the pinned golden; whether a compact form is reachable for JSON layouts without `": {"` cut points is left to S4/S1 recordings.

Intentional non-equivalences: none registered beyond the above notes; anything else found during implementation must be registered in SPEC.md §5 before shipping.
