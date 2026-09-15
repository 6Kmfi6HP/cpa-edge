# S2d2 — Gemini client → OpenAI upstream

Section id: S2d2. Module: `packages/translators` (gemini→openai-chat pair), `packages/executors` (openai-compat executor), routing mounted by `runtimes/*`.
Upstream anchor: CLIProxyAPI v7.3.4, commit `8335eac731946bd4eff18f500653f93736df53d6` (see SPEC.md §0).
Upstream evidence paths in this section are relative to the upstream repo root. Oracle-recorded WIRE NOTES (mission brief) are marked **[WIRE]** and outrank any static reading.

---

## 1. Scope and boundaries

IN scope:
- The Gemini-protocol client surface served over an `openai-compatibility` upstream provider (base-url + api-key; per SPEC.md §5 R-FIXTURE this pair is RECORDABLE-LOCALLY):
  - `POST /v1beta/models/{model}:generateContent` (non-stream),
  - `POST /v1beta/models/{model}:streamGenerateContent` (SSE, with or without `?alt=sse`),
  - `POST /v1beta/models/{model}:countTokens`,
  - the path parsing and model-resolution rules of `/v1beta/models/*action`,
  - client auth styles accepted on the `/v1beta` route group.
- Request translation Gemini → OpenAI Chat Completions: `contents`, `systemInstruction`, `tools`/`functionDeclarations`, `toolConfig`, `generationConfig`, thinking config.
- Response translation OpenAI Chat Completions → Gemini: non-stream envelope, finish-reason mapping, usage mapping, and the exact SSE chunk sequence.
- The upstream wire contract emitted by the openai-compat executor: method, path, headers, body mutations (alias rewrite, `stream_options.include_usage` injection).
- Token counting semantics for this pair.
- Error semantics visible to a Gemini-protocol client on this pair (request errors, upstream HTTP errors, rate-limit cooldown, mid-stream transport failure, in-stream error payloads).
- Model discovery as observed by a Gemini client when an openai-compat provider is configured: `GET /v1beta/models`, `GET /v1beta/models/{id}`.

OUT of scope (owned elsewhere):
- `POST /v1beta/interactions` — the interactions wire is a separate protocol pair (not openai upstream); belongs to the interactions sections.
- Route-level behaviors shared by all protocols (404 empty body per R-404, auto-OPTIONS 204, CORS block) — S1. This section only restates what a golden on this pair necessarily observes.
- Auth middleware internals, key storage, IP banning — S3 (error shapes cross-referenced in §5).
- Credential scheduling, rotation, cooldown policy mechanics — S4. This section pins only the client-visible cooldown error on this pair.
- Model-registry internals and `/v1` model listing — S1/S6.
- Claude upstream (S2d7), Gemini upstream reverse direction (S2d1), Codex/Responses upstreams (S2d5/S2d9).
- Plugin interceptors, model routers, Home mode — disabled in the golden configuration; any behavior that requires a plugin or router is not pinned here.

---

## 2. Behavior inventory

### 2.1 Client routes and methods

Registered once under the `/v1beta` group with the standard client auth middleware (evidence: `internal/api/server_routes.go` — `v1beta := s.engine.Group("/v1beta"); v1beta.Use(AuthMiddleware(...)); v1beta.GET("/models", ...); v1beta.POST("/models/*action", ...); v1beta.GET("/models/*action", ...)`).

| Route | Method | Success status | Success content type |
|---|---|---|---|
| `/v1beta/models` | GET | 200 | `application/json` |
| `/v1beta/models/{action}` | GET | 200 (model found) / 404 (not found) | `application/json` |
| `/v1beta/models/{model}:generateContent` | POST | 200 | `application/json` |
| `/v1beta/models/{model}:streamGenerateContent` | POST | 200 | `text/event-stream` |
| `/v1beta/models/{model}:countTokens` | POST | 200 | `application/json` |

MUST (path parsing, evidence: `sdk/api/handlers/gemini/gemini_handlers.go` `GeminiHandler`):
- The `*action` wildcard captures everything after `/v1beta/models/`. The gateway strips one leading `/` and splits the remainder on `:`; the model segment is everything before the FIRST colon, the method segment everything after it.
- If the split does not yield exactly 2 segments — zero colons (e.g. `.../justname`) OR two or more colons (e.g. `.../a:b:c`) — the gateway returns **404** with body `{"error":{"message":"<full request path> not found.","type":"invalid_request_error"}}`. This is a handler-written JSON 404, distinct from the route-level empty-body 404 (R-404 applies to unregistered routes).
- If the method segment is none of `generateContent` / `streamGenerateContent` / `countTokens`, the gateway returns **200 with an empty body**, with no upstream dispatch and no `X-Cpa-Trace-Id` response header **[WIRE, S1-recorded]**. OPTIONAL to replicate exactly; a deliberate 400 is a registered non-equivalence if chosen (see §7).
- The request body is read before method dispatch; unknown methods still consume the body.
- Streaming-method requests read the `alt` query parameter (fallback `$alt` when `alt` is absent; evidence: `sdk/api/handlers/handlers.go` `GetAlt`). Only the EXACT lowercase value `sse` (or no alt at all) selects SSE framing; every other non-empty value selects the raw-chunk mode — see §4.1.
- Trailing-slash variants of these routes trigger the S1-owned redirect behavior (GET 301 / POST 307 + `Location`, no CORS headers); not pinned here.
- `POST /v1beta/models/models/{alias}:generateContent` (the `models/`-prefixed resource form) does NOT resolve: the model segment is the literal string `models/{alias}` and the gateway answers **400** `model_not_found` (recorded in `gem2oai-model-resolution-errors` R2). The single-model GET endpoint behaves the same way for lookups but answers **404** `not_found` for a prefixed id (recorded in `gem2oai-models-list` R3). Neither endpoint resolves `models/`-prefixed ids; only the LIST response itself carries the `models/` prefix.

### 2.2 Auth (client side)

MUST (evidence: `internal/api/server_middleware.go` `accessAuthMiddleware`; `internal/access/config_access/provider.go` `Authenticate`/`extractBearerToken`; oracle probes `16-v1beta-models-*`; goldens `gem2oai-auth-styles`, `gem2oai-auth-transports`):
- FIVE transports are accepted on all `/v1beta` routes, tried in this order until one matches:
  1. `Authorization: Bearer <api-key>` (scheme case-insensitive, split on first space, token trimmed). A non-Bearer `Authorization` value — or a single token with no space — is used VERBATIM as the key.
  2. `X-Goog-Api-Key: <api-key>`
  3. `X-Api-Key: <api-key>`
  4. `?key=<api-key>` query parameter
  5. `?auth_token=<api-key>` query parameter
- No credential in any transport → 401 `{"error":"Missing API key"}`; credentials present but none match → 401 `{"error":"Invalid API key"}` (string `error` shape, not the OpenAI object shape). The 401 shapes are identical for all transports.
- The api-key is the gateway key (`api-keys` config), never a provider key.

### 2.3 Upstream wire (gateway → openai-compat upstream)

MUST (evidence: `internal/runtime/executor/openai_compat_executor.go` `Execute` / `ExecuteStream` / `CountTokens`; oracle-recorded `probes/mocks/openai/upstream.jsonl`):
- Non-stream and stream requests go to `POST {base-url}/chat/completions` (trailing `/` of base-url trimmed; base-url includes the `/v1` suffix as configured).
- Request headers, this set when no provider-level custom headers are configured (beyond transport-managed ones):
  - `Content-Type: application/json`
  - `Authorization: Bearer <provider api-key>`
  - `User-Agent: cli-proxy-openai-compat`
  - stream requests additionally: `Accept: text/event-stream`, `Cache-Control: no-cache`
  - `Accept-Encoding: gzip` is added by the Go HTTP transport, not the executor.
- Client headers are NOT forwarded upstream (no `User-Agent`, no `x-goog-api-key`, no custom client headers). Exception: headers configured as provider-level custom headers — OPTIONAL, not exercised by goldens.
- The upstream body `model` field is the **upstream model name** (config `models[].name`), not the client alias: the conductor resolves the alias to the credential's model before translation (evidence: `sdk/cliproxy/auth/oauth_model_alias.go` alias tables; recorded alias rewrite `mock-model` → `mock-gpt-model`).
- Streaming requests MUST carry `"stream":true` and `"stream_options":{"include_usage":true}` (injected by the executor). Non-streaming requests carry `"stream":false` and MUST NOT carry `stream_options`.
- `countTokens` NEVER sends an upstream HTTP request; counting is SYNTHESIZED LOCALLY and the upstream wire log stays empty for it **[WIRE, S1-recorded]** (see §3.4). Do NOT spec count forwarding for this provider.
- Upstream HTTP status < 200 or ≥ 300 fails the request with a status error whose message is the raw upstream body (see §5.2).

### 2.4 Model discovery (Gemini client, openai-compat provider configured)

MUST (evidence: `sdk/api/handlers/gemini/gemini_handlers.go` `GeminiModels` / `GeminiGetHandler`):
- `GET /v1beta/models` returns `{"models":[...]}` where every registered model (all providers) appears with `name` prefixed `models/`; a missing `displayName`/`description` defaults to the raw model id; a missing `supportedGenerationMethods` defaults to `["generateContent"]`.
- `GET /v1beta/models/{id}` resolves ONLY the bare id; any id that does not resolve — including the `models/`-prefixed form — answers 404 `{"error":{"message":"Not Found","type":"not_found"}}` (recorded in `gem2oai-models-list` R3-R4).
- LIST-vs-GET asymmetry: the LIST handler normalizes entries (name prefixed, `displayName`/`description` defaulted, `supportedGenerationMethods` defaulted) — the single-model GET does NOT: it returns the RAW registry map verbatim. For the golden: `GET /v1beta/models/mock-model` → 200 `{"displayName":"mock-model","name":"models/mock-model"}` — exactly 2 keys, no `description`, no `supportedGenerationMethods` (recorded in `gem2oai-models-list` R2).
- openai-compat aliases appear in this list like any other model — a Gemini client can discover `mock-model` and call it.

### 2.5 Response headers (gateway → client)

- Every response carries the CORS block (S1 territory); goldens mask `Date`, `X-Cpa-Trace-Id`.
- `X-Cpa-Trace-Id` appears ONLY on executor-routed responses (requests that reach the auth-manager execution path). Gateway-local responses — middleware 401s, model-resolution 400s, the 200-empty unknown-method response, gin-written JSON 404s — carry NO trace header (recorded in `gem2oai-model-resolution-errors`, `gem2oai-auth-styles`; S1-recorded fact for the 200-empty case).
- Content-Type precision (recorded):
  - executor-routed non-stream responses: bare `Content-Type: application/json` (set by the handler before execution);
  - WriteErrorResponse bodies (upstream errors, cooldown, thinking 400s): bare `application/json`;
  - gin `c.JSON` responses (model LIST, single-model GET, JSON 404 not-found): `application/json; charset=utf-8`;
  - SSE streams: `text/event-stream`;
  - raw-chunk streams (§4.1, non-`sse` alt): NO SSE headers; Content-Type is the transport default (recorded in `gem2oai-stream-alt-json`).
- Upstream response headers are NOT forwarded downstream (passthrough disabled by default; evidence: `sdk/api/handlers/handlers_interceptors.go` `downstreamHeadersFromExecutor` returns nil unless configured).
- Stream responses set `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`, `Access-Control-Allow-Origin: *` only once the first chunk is ready (not on pre-stream errors).
- Non-stream keep-alive (`StartNonStreamingKeepAlive`) and streaming SSE heartbeats are config-gated and disabled in the golden configuration (`non-stream-keep-alive-interval` unset, `streaming.keep-alive-seconds` unset); raw-chunk mode force-disables streaming keep-alives (§4.1).

---

## 3. Schemas

Translator pair registration (evidence: `internal/translator/openai/gemini/init.go`): from `gemini` to `openai` — request `ConvertGeminiRequestToOpenAI`, stream response `ConvertOpenAIResponseToGemini`, non-stream response `ConvertOpenAIResponseToGeminiNonStream`, token count `GeminiTokenCount`.

Encoding rules (byte-exact contract material):
- Translator-built bodies (request translation, non-stream/stream response envelopes, count tokens) are COMPACT (no spaces after `:`/`,`) with sjson INSERTION-order keys.
- Go-map-marshal bodies (cooldown error §5.3, model LIST/GET maps) have ALPHABETICALLY sorted keys.
- Byte-exact contract tests ignore only the dynamic fields whitelisted per fixture `meta.yaml` plus the §4.2/§7 volatility whitelists.

### 3.1 Request translation (Gemini body → OpenAI chat completions body)

Built from a fixed base `{"model":"","messages":[]}`; top-level key order is: `model`, `messages`, generation-config-derived keys in the order listed below, `stream`, `service_tier`, `tools`, `tool_choice`.

| Gemini input | OpenAI output | Rules (MUST unless marked) |
|---|---|---|
| path model segment | `model` | Upstream model name after alias resolution (§2.3). The body's own `model` field, if any, is IGNORED. |
| `generationConfig.temperature` | `temperature` | number, verbatim |
| `generationConfig.maxOutputTokens` | `max_tokens` | integer |
| `generationConfig.topP` | `top_p` | number |
| `generationConfig.topK` | `top_k` | integer; OpenAI-foreign key is KEPT (upstream may reject; gateway passes it) |
| `generationConfig.stopSequences` | `stop` | array of strings; only if non-empty |
| `generationConfig.candidateCount` | `n` | integer |
| `generationConfig.responseModalities` | `modalities` | each entry lowercased; only `text`/`image`/`audio` kept; only if non-empty |
| `generationConfig.thinkingConfig.thinkingLevel` (or `thinking_level`) | `reasoning_effort` | translator writes lowercased+trimmed level, THEN the thinking pipeline re-reads the ORIGINAL gemini body and rewrites `reasoning_effort` to the clamped/validated level per §3.3 — the §3.3 EFFECTIVE mapping is the contract |
| `generationConfig.thinkingConfig.thinkingBudget` (or `thinking_budget`) | `reasoning_effort` | budget→level mapping (§3.3), then the same pipeline clamp/validate pass; used only when no level key present |
| (stream flag) | `stream` | always present: `true` for `:streamGenerateContent`, `false` otherwise |
| top-level `service_tier` | `service_tier` | copied verbatim if it is a string; a Gemini-body oddity, kept for compatibility |
| `systemInstruction` / `system_instruction` | first message `{"role":"system","content":[...]}` | content is ALWAYS an array of OpenAI content parts (even for one text part); text parts become `{"type":"text","text":...}`; inlineData/fileData become media parts (§3.1.2); thought parts skipped; system message omitted when no parts survive |
| `contents[]` | `messages[]` | §3.1.1 |
| `tools[].functionDeclarations[]` | `tools[]` | §3.1.3 |
| `toolConfig.functionCallingConfig` | `tool_choice` | §3.1.4 |

Any other Gemini body field is DROPPED (e.g. `safetySettings`, `labels`, `cachedContent`, `responseSchema`, `responseMimeType`, `frequencyPenalty`, `presencePenalty`, `seed`, `responseLogprobs`, `toolSelector` are not translated in this direction).

#### 3.1.1 `contents[]` → `messages[]`

Per content turn, in order:
- Role: `"model"` → `"assistant"`. Every other role string passes through verbatim (`"user"`, `"function"`, anything else).
- Parts (in order); each part is classified:
  - Thought parts (`"thought": true`) are DROPPED. A turn whose parts are ALL thought parts is dropped entirely (no message emitted).
  - `text` parts → collected; if the turn contains ONLY text parts, the message `content` is the CONCATENATION of all text parts as a single string; otherwise each text part becomes a `{"type":"text","text":...}` entry in the content array.
  - `inlineData` / `inline_data` with non-empty `data`:
    - `image/*` (case-insensitive prefix) → `{"type":"image_url","image_url":{"url":"data:<mime>;base64,<data>"}}`
    - `audio/*` → `{"type":"input_audio","input_audio":{"data":"<data>","format":"<fmt>"}}`; fmt from mime: `audio/wav|wave|x-wav`→`wav`, `audio/flac`→`flac`, `audio/opus|ogg`→`opus`, `audio/pcm|l16`→`pcm16`, else `mp3`
    - `video/*` → `{"type":"video_url","video_url":{"url":"data:<mime>;base64,<data>"}}`
    - anything else → `{"type":"file","file":{"filename":"<derived>","file_data":"<data>"}}`; empty or unknown mime → `application/octet-stream` before classification; filename derived from mime (`document.pdf|txt|csv|json|xml`, `video`, else `document`)
  - `fileData` / `file_data` with non-empty `fileUri`:
    - `image/*` → `{"type":"image_url","image_url":{"url":"<fileUri>"}}`
    - `video/*` → `{"type":"video_url","video_url":{"url":"<fileUri>"}}`
    - `application/*` or `text/*` → `{"type":"file","file":{"filename":"<derived>","file_url":"<fileUri>"}}`
    - other/empty mime → `{"type":"text","text":"File: <fileUri> (Type: <mime>)"}` (no ` (Type: ...)` suffix when mime is empty)
  - `functionCall` → appended to the turn message's `tool_calls`:
    - `id`: explicit `id` / `call_id` / `callId` on the functionCall node if present; otherwise deterministic `"call_" + first 12 bytes of sha256("call|<turnIndex>|<partIndex>|<name>|<argsRaw>") as hex` (24 hex chars). `<turnIndex>` is the index of the turn in the client's `contents` array — it counts EVERY turn, including thought-only turns that are later dropped; `<partIndex>` is the part's index within that turn. `<argsRaw>` is the VERBATIM raw JSON of `args` (whitespace included).
    - `{"id":"<id>","type":"function","function":{"name":"<name>","arguments":"<argsRaw>"}}`; `arguments` is `"{}"` when `args` is absent.
    - A message with tool calls keeps `content` as the concatenated text (possibly `""`).
  - `functionResponse` → emits a SEPARATE `{"role":"tool",...}` message IMMEDIATELY (mid-turn, before the current turn's own message):
    - `tool_call_id`: explicit `id`/`call_id`/`callId` on the functionResponse node (an explicit id ALSO removes the matching id from that function name's FIFO queue); else the oldest unused generated `call_` id for the same function name (FIFO queue, ids consumed in order); else deterministic `"call_" + sha256("response|<turnIndex>|<partIndex>|<name>|<responseRaw>")[:12 bytes hex]`.
    - `content`: JSON-stringified `response.content` if present, else JSON-stringified whole `response` object (a STRING, not raw JSON).
  - Empty turns (no surviving parts, no tool calls, no functionResponses) still emit `{"role":"<role>","content":""}`.
- Turn order is preserved, except that tool messages produced by `functionResponse` parts precede the message of the turn that contained them (which is the empty role message for pure function-response turns).

#### 3.1.2 System parts

Same part conversions as user turns (text, inlineData, fileData); thought parts skipped. `content` is always the parts ARRAY (never a plain string).

#### 3.1.3 Tools

`tools[].functionDeclarations[]` → `{"type":"function","function":{"name":...,"description":...,"parameters":...}}`:
- `name` and `description` always present (empty string when missing).
- `parameters` = raw `parameters` if present, else raw `parametersJsonSchema`, else ABSENT.
- Tool declarations with other declaration types (e.g. `googleSearch`, `codeExecution`) produce nothing.

#### 3.1.4 Tool choice

`toolConfig.functionCallingConfig.mode`:
- `NONE` → `"none"`
- `AUTO` → `"auto"`
- `ANY` → if `allowedFunctionNames` has exactly 1 entry: `{"type":"function","function":{"name":"<that entry>"}}`; otherwise `"required"`
- missing/unknown mode → `tool_choice` ABSENT.

### 3.2 Response translation (OpenAI → Gemini), non-stream

Envelope (built from a fixed template):
```
{"candidates":[{"content":{"parts":[<parts>],"role":"model"},"index":<index>[,"finishReason":"<FR>"]}],"model":"<upstream model>"[,usage]}
```
- `model`: copied from the upstream response `model` field when present (the UPSTREAM model name — NOT rewritten back to the client alias), UNLESS the model entry sets `force-mapping: true`, in which case the response model is rewritten to the client-facing name (not exercised by goldens; recorded for the chat path in the bootstrap recordings). Key order: `candidates`, `model`, `usageMetadata`.
- Per choice (evidence: `ConvertOpenAIResponseToGeminiNonStream`):
  - parts, in order: reasoning texts first (each `{"thought":true,"text":...}`), then `message.content` (if non-empty string, one `{"text":...}` part), then one part per function tool call `{"functionCall":{"id":...,"name":...,"args":<object>}}` — `id` omitted when empty; `args` = the `arguments` JSON string parsed to a raw object, `"{}"` when empty/invalid.
  - `finishReason` from `choice.finish_reason` per the table below; ABSENT when the upstream omits it.
  - `index` = the choice's `index`.
- Multi-choice quirk (n>1): ALL choices overlay into the SAME `candidates[0]` — parts merge positionally across choices and `index` reflects the LAST choice. Preserved as recorded behavior; contract case covers n=1 only (see §7 open question Q2).
- `usageMetadata` (from upstream `usage`, when present):
  - `promptTokenCount` = `prompt_tokens` (or `input_tokens`)
  - `candidatesTokenCount` = `completion_tokens` (or `output_tokens`)
  - `totalTokenCount` = `total_tokens` (or prompt+completion when absent)
  - `thoughtsTokenCount` = `completion_tokens_details.reasoning_tokens` (or `output_tokens_details.reasoning_tokens`), only when > 0
  - `cachedContentTokenCount` = `prompt_tokens_details.cached_tokens` (or `input_tokens_details.cached_tokens`), only when > 0
  - inner key order: promptTokenCount, candidatesTokenCount, totalTokenCount, thoughtsTokenCount, cachedContentTokenCount.

Finish-reason map (MUST):

| OpenAI `finish_reason` | Gemini `finishReason` |
|---|---|
| `stop` | `STOP` |
| `length` | `MAX_TOKENS` |
| `tool_calls` | `STOP` |
| `content_filter` | `SAFETY` |
| any other string | `STOP` |

Reasoning extraction: `message.reasoning_content` as a string, an array of strings/objects, or an object with a `text` field; each non-empty extracted string becomes one thought part. An object WITHOUT a `text` field whose raw bytes start with `{` or `[` produces NO parts (not treated as text).

### 3.3 Thinking config → `reasoning_effort` (two stages; EFFECTIVE mapping is the contract)

Stage 1 — translator (`internal/translator/openai/gemini/openai_gemini_request.go`): `thinkingLevel` (or `thinking_level`) is written lowercased+trimmed; `thinkingBudget` (or `thinking_budget`) maps via `internal/thinking/convert.go`: `-1`→`auto`, `0`→`none`, `1..512`→`minimal`, `513..1024`→`low`, `1025..8192`→`medium`, `8193..24576`→`high`, `≥24577`→`xhigh`.

Stage 2 — thinking pipeline (`helps.ApplyRequestThinking`, `internal/thinking/{apply,validate,provider/openai}`): runs AFTER translation and re-reads the thinking config from the ORIGINAL gemini body (`extractSourceThinkingConfig`), validates against the model's thinking capability, and REWRITES `reasoning_effort` in the already-translated body in place (key position preserved). For openai-compat configured models WITHOUT explicit `thinking` config the capability defaults to `ThinkingSupport{Levels:["low","medium","high"]}` with dynamic thinking NOT allowed and disable NOT allowed (evidence: `sdk/cliproxy/auth/api_key_model_capabilities.go`), which produces these EFFECTIVE mappings (all recorded; goldens `gem2oai-thinking-config`, `gem2oai-thinking-clamps`, `gem2oai-thinking-invalid`):

| Gemini input | Effective upstream `reasoning_effort` |
|---|---|
| level `low`, `medium`, `high` | unchanged |
| level `auto` | `medium` (mid-range clamp, `convertAutoToMidRange`) |
| level `none` | `low` (disable not allowed → lowest supported level) |
| level `minimal` | `low` (clamped to nearest supported) |
| level `xhigh` | `high` |
| level `max` | `high` |
| any other level string | request fails **400** (§5.1) |
| budget `-1` | `medium` |
| budget `0` | `low` |
| budget `1..8192` | `low` for 1..1024 (minimal clamps to low), `medium` for 1025..8192 |
| budget `8193..24576` | `high` |
| budget `≥24577` | `high` (xhigh clamps to high) |
| budget `< -1` | request fails **400** (§5.1) |

The stage-2 rewrite explains the round-1 recorded deviance: `thinkingLevel: "auto"` reached the upstream as `"reasoning_effort":"medium"`. Models with explicit thinking capabilities (registry or per-model config) are outside the golden set; their stage-2 results depend on that configuration.

### 3.4 Token count

`POST /v1beta/models/{alias}:countTokens`:
- Translates the request exactly like `:generateContent` (stream=false), runs the SAME thinking pipeline (an invalid thinking config fails countTokens with the same 400 shapes — recorded in `gem2oai-thinking-invalid` R3), then counts tokens LOCALLY. No upstream HTTP request is emitted (upstream wire log stays empty).
- Counting formula (evidence: `internal/runtime/executor/helps/token_helpers.go`): collect text segments from the TRANSLATED OpenAI body — per message: `role`, `name`, and content parts (`text`/`input_text`/`output_text` → their text; `image_url` → its `url` string; `input_audio`/`output_audio`/`audio` → their `id` string ONLY, the audio DATA is NOT counted; nested arrays/objects of content are walked); per tool call: `id`, `type`, `function.name`, `function.description`, `function.arguments` (string), `function.parameters` (raw); per `tools[]` entry: the tool payload; per `functions[]` entry: `name`, `description`, `parameters` (raw); plus `tool_choice` (string or raw), `response_format` (raw), `input`, `prompt`. Each segment is trimmed, empty segments dropped, the rest JOINED with `\n`, and the whole string tokenized.
- Tokenizer selection by upstream-model prefix: `gpt-5*`→GPT5, `gpt-4.1*`→GPT41, `gpt-4o*`→GPT4o, `gpt-4*`→GPT4, `gpt-3.5*`/`gpt-3*`→GPT35Turbo, `o1*`→O1, `o3*`→O3, `o4*`→O4Mini, EMPTY model→`cl100k_base`, everything else (incl. `mock-gpt-model`)→`o200k_base`.
- Response body, byte-exact: `{"totalTokens":<N>,"promptTokensDetails":[{"modality":"TEXT","tokenCount":<N>}]}` (evidence: `internal/translator/common/bytes.go`).
- `<N>` is deterministic for a fixed input body; goldens pin the recorded integers: plain body → **4** (`gem2oai-count-tokens`); tool-call history body → the recorded value in `gem2oai-count-tokens-tools`.

---

## 4. Streaming rules

### 4.1 Downstream framing — two modes selected by `alt`

MUST (evidence: `sdk/api/handlers/gemini/gemini_handlers.go` `handleStreamGenerateContent`, `forwardGeminiStream`; `sdk/api/handlers/handlers.go` `GetAlt`). The effective `alt` value is: the `alt` query parameter, falling back to `$alt` when `alt` is absent. Only the EXACT lowercase value `sse` normalizes to the empty string; every other non-empty value selects raw-chunk mode.

**SSE mode** (effective alt `""` — i.e. `?alt=sse`, `$alt=sse`, or no alt parameter):
- Every translated chunk is framed `data: <chunk>\n\n` and the SSE headers are set once the FIRST chunk is ready (or at clean close with no data: headers + empty 200 body): `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`, `Access-Control-Allow-Origin: *`.
- One `data:` frame per translated Gemini chunk. No `event:` lines on the success path. No `[DONE]` marker is ever sent downstream.
- Streaming keep-alive comments follow `streaming.keep-alive-seconds` (disabled in the golden configuration).
- Terminal in-stream errors are framed `event: error\ndata: <body>\n\n` (§5.4).

**Raw-chunk mode** (effective alt non-empty and not `sse`, e.g. `?alt=json` — golden `gem2oai-stream-alt-json`):
- Translated chunks are written VERBATIM, concatenated with NO separator bytes and NO `data:` framing: the response body is byte-adjacent JSON objects.
- NO SSE headers are set (no `text/event-stream`); Content-Type is the transport default (recorded in the golden).
- Streaming keep-alives are FORCE-disabled in this mode.
- Terminal in-stream errors append the error body bytes RAW (no `event: error` line).
- The chunks themselves are identical to SSE mode — only the framing differs.

For both modes: pre-first-chunk upstream failures are returned as normal HTTP error responses (JSON, no stream headers) — see §5.2.

### 4.2 Chunk mapping (upstream openai SSE frame → downstream gemini SSE frame(s))

The executor parses upstream frames (`data:` lines, `event:`/`id:`/`retry:`/comment lines ignored), and feeds each complete `data:` payload through the stream translator. Mapping per payload (evidence: `internal/translator/openai/gemini/openai_gemini_response.go` `ConvertOpenAIResponseToGemini`):

| Upstream chunk (chat.completion.chunk) | Downstream output |
|---|---|
| first chunk carrying only `delta.role` (typically `"assistant"`) | **NO output** (dropped; the role-emission branch is unreachable in this build) |
| `delta.content` non-empty string | ONE frame: `{"candidates":[{"content":{"parts":[{"text":"<content>"}],"role":"model"},"index":0}],"model":"<chunk model>"}` |
| `delta.reasoning_content` text(s) | ONE frame per text: `{"candidates":[{"content":{"parts":[{"thought":true,"text":"<text>"}],"role":"model"},"index":0}],"model":"<chunk model>"}` (thought key first); an object value WITHOUT a `text` field whose raw bytes start with `{`/`[` yields NOTHING |
| `delta.tool_calls` deltas | **NO output**; id/name/arguments are buffered per tool index (id/name updated when present; arguments concatenated) |
| `finish_reason` non-empty string | ONE frame: `{"candidates":[{"content":{"parts":[...],"role":"model"},"index":0,"finishReason":"<mapped>"}],"model":"<chunk model>"}`; buffered tool calls are flushed into `parts` as `{"functionCall":{"id":...,"name":...,"args":<object>}}` entries (id omitted when empty); buffer cleared |
| `choices: []` + `usage` (usage-only frame, guaranteed present because the gateway injects `stream_options.include_usage`) | ONE frame: `{"candidates":[],"usageMetadata":{...},"model":"<chunk model>"}` — note key order candidates, usageMetadata, model |
| non-empty `choices` with an EMPTY delta, NO finish_reason, and root `usage` present | ONE frame: `{"candidates":[{"content":{"parts":[],"role":"model"},"index":0}],"model":"<chunk model>","usageMetadata":{...}}` (the per-choice usage branch; different top-level key order from the usage-only frame) |
| `[DONE]` | NO output; the downstream stream simply ends |
| clean upstream EOF without `[DONE]` | treated as `[DONE]` (synthesized): NO error, NO extra frame (only Responses-protocol clients get a failure) |
| frame whose payload is an OpenAI error object (`error` / `response.error` / `code`+`message` / `type` `error|response.error|response.failed` / SSE `event: error|response.error|response.failed`) | terminal in-stream error (§5.4); status taken from the payload's `status`/`status_code`(400-599), else 502 |
| non-SSE JSON line (starts with `{`/`[` outside a data frame) | terminal in-stream error, status 502, message = that raw line |
| truncated frame / bare-LF chunked line | terminal in-stream error, status 502, message from the transport |

- Frame ORDER is upstream arrival order; text/reasoning/finish/usage frames are emitted in the order the corresponding upstream frames complete.
- `usageMetadata` timing: the usage frame is the LAST downstream frame (upstream sends it last when `include_usage` is honored), after the finish frame.
- Buffered tool calls flush ONLY on a finish frame; a stream that ends without a finish frame emits no functionCall parts (dropped).
- **VOLATILITY (registered in §7):** when TWO OR MORE tool calls are buffered, the `functionCall` parts inside the single finish frame are emitted in NONDETERMINISTIC order (Go map iteration over the accumulator). Contract comparison for any finish frame with 2+ `functionCall` parts MUST compare `candidates[0].content.parts` as a SET with a canonical (sorted) ordering instead of byte order (golden `gem2oai-stream-toolcall-multi`; single-tool-call frames — e.g. `gem2oai-stream-toolcall` — stay byte-exact).
- `candidates.0.index` is always 0 in stream frames (the upstream choice index is not used in streaming).

### 4.3 Golden byte layouts

All downstream frames are compact JSON. Byte-exact goldens live under `tests/fixtures/S2d2/` (§6). Example full sequence for a plain two-delta text stream with usage (golden `gem2oai-stream-text-full`):

```
data: {"candidates":[{"content":{"parts":[{"text":"Hello"}],"role":"model"},"index":0}],"model":"mock-gpt-model"}

data: {"candidates":[{"content":{"parts":[{"text":" world"}],"role":"model"},"index":0}],"model":"mock-gpt-model"}

data: {"candidates":[{"content":{"parts":[],"role":"model"},"index":0,"finishReason":"STOP"}],"model":"mock-gpt-model"}

data: {"candidates":[],"usageMetadata":{"promptTokenCount":8,"candidatesTokenCount":2,"totalTokenCount":10},"model":"mock-gpt-model"}
```

(The role-declaration frame from the same upstream produced nothing.)

---

## 5. Error semantics

### 5.1 Request errors (gateway-side)

| Condition | Status | Body (byte-exact) |
|---|---|---|
| missing api-key | 401 | `{"error":"Missing API key"}` |
| unknown api-key | 401 | `{"error":"Invalid API key"}` |
| alias not served by any provider (incl. `models/`-prefixed POST paths) | 400 | `{"error":{"message":"unknown provider for model <requested>","type":"invalid_request_error","code":"model_not_found","param":"model"}}` |
| action with zero or 2+ colons | 404 | `{"error":{"message":"<request path> not found.","type":"invalid_request_error"}}` |
| `GET /v1beta/models/{unknown}` (incl. `models/`-prefixed) | 404 | `{"error":{"message":"Not Found","type":"not_found"}}` |
| unknown `:method` | 200 | empty body |
| unsupported thinking LEVEL for the selected model's thinking capability (openai-compat default: anything but `none|auto|minimal|low|medium|high|xhigh|max`) | 400 | `{"error":{"message":"level \"<X>\" not supported, valid levels: low, medium, high","type":"invalid_request_error"}}` (golden `gem2oai-thinking-invalid` R1) |
| thinking BUDGET `< -1` | 400 | `{"error":{"message":"budget <N> cannot be converted to a valid level","type":"invalid_request_error"}}` (golden `gem2oai-thinking-invalid` R2) |

The 400/404 bodies above use the OpenAI error-object shape even for Gemini-protocol clients — the gateway has ONE request-error body shape for all client protocols (evidence: `sdk/api/handlers/handlers_errors.go`, `handlers.go` `BuildErrorResponseBodyWithError`; bootstrap probe 09).

### 5.2 Upstream HTTP errors (non-2xx)

MUST **[WIRE]**:
- The upstream status and body pass downstream VERBATIM (status preserved; body bytes preserved — the error message IS the raw upstream body, and a valid-JSON body is emitted as-is). Applies to non-stream and to stream requests that fail before the first chunk (no SSE headers in that case).
- Example (golden `gem2oai-error-429`): upstream 429 with `{"error":{"message":"mock rate limit","type":"rate_limit_exceeded","code":"rate_limit_exceeded"}}` → downstream HTTP 429 with the same body.
- `Retry-After` MAY be honored internally; goldens do not exercise it.

### 5.3 Rate-limit cooldown

MUST **[WIRE]**:
- An upstream 429 puts the credential into a rate-limit cooldown. A request for the same model during the cooldown fails with the STATUS OF THE TRIGGERING UPSTREAM ERROR (429 in the golden — the cooldown error wraps the last upstream status error) plus a `Retry-After: <reset_seconds>` response header, and body:
```
{"error":{"code":"model_cooldown","last_upstream_error":"<summary>","message":"All credentials for model <alias> are cooling down via provider <provider-key> (last error: <summary>)","model":"<alias>","provider":"<provider-key>","reset_seconds":<n>,"reset_time":"<n>s"}}
```
  keys in alphabetical order (Go map marshal); `<provider-key>` for a named openai-compat provider is `openai-compatible-<name>` (e.g. `openai-compatible-mock-openai`; evidence: `internal/util/provider.go` `OpenAICompatibleProviderKey`, `sdk/cliproxy/auth/selector.go` `modelCooldownError` — including its `Retry-After` header derivation). `last_upstream_error` is the extracted `code: message` summary of the upstream body (e.g. `rate_limit_exceeded: mock rate limit`).
- The cooldown window ESCALATES with consecutive post-window rate-limit failures (evidence: `sdk/cliproxy/auth/cooldown_backoff_test.go` quota backoff levels; first 429 opens a ~1s window, and the window doubles per post-window failure). The golden records the third consecutive 429 inside a few seconds: `reset_seconds: 4`, `reset_time: "4s"`, `Retry-After: 4` (`gem2oai-cooldown-after-429` R2). Contract tests MUST read the recorded `reset_seconds` value from the fixture rather than assuming 1.
- `transient-error-cooldown-seconds: -1` does NOT disable this cooldown (oracle-recorded); transient transport-error cooldowns ARE disabled by `-1`.
- A 429 body matching the tokens-per-minute pattern (`error.code` containing `TPMRateLimitExceeded`, or a message with "tokens per minute" + "limit" + "exceeded") without a `Retry-After` header opens a 60-second fallback window instead of the short default — client-visible via `reset_seconds` on the next cooldown response (evidence: `internal/runtime/executor/openai_compat_executor.go` `openAICompatRetryAfter`; scheduling mechanics are S4's scope).

### 5.4 Mid-stream failures (after SSE headers committed)

MUST **[WIRE]**:
- Transport failure mid-stream (e.g. hard close without chunked terminator): the client's HTTP status STAYS 200 and the stream terminates with an error frame:
```
event: error
data: {"error":{"message":"unexpected EOF","type":"server_error","code":"internal_server_error"}}
```
  i.e. for a Gemini client the terminal error carries an `event: error` line followed by an OpenAI-shaped error object — DIFFERENT from the OpenAI chat client, which gets the same `data:` object without the `event:` line. The message is the transport error text (`unexpected EOF`); the type/code derive from status ≥ 500.
- Upstream error payload delivered INSIDE a `data:` frame: same framing, body = the upstream payload verbatim (it is valid JSON), status code for type/code derivation taken from the payload (else 502).
- Already-flushed frames before the failure are preserved.

### 5.5 Error body shape derivation (shared)

For gateway-built error bodies (evidence: `BuildErrorResponseBodyWithError`): if the error text is itself valid JSON it is emitted verbatim (this is what makes upstream 429 bodies and cooldown bodies byte-preserve); otherwise it is wrapped as `{"error":{"message":<text>,"type":<type>,"code":<code>}}` with type/code from status: 401→`authentication_error`/`invalid_api_key`, 403→`permission_error`/`insufficient_quota`, 429→`rate_limit_error`/`rate_limit_exceeded`, 404→`invalid_request_error`/`model_not_found`, ≥500→`server_error`/`internal_server_error`, else `invalid_request_error` with no code.

---

## 6. Golden samples index

**Status: 20 fixtures recorded (2026-09-15/16, round 1) by @oracle-runner-3 against CLIProxyAPI v7.3.4; round 2 adds cases 21-26 (alt=json raw mode, auth transports, thinking clamps + 400 pair, tool-call countTokens, multi-tool-call stream) and re-records case 1 with a well-formed body.** (image `eceasy/cli-proxy-api:v7.3.4`, digest `sha256:97825da3...4266`) with the openai mock upstream (`_cpa_edge_ref/mock/mock_openai.py`, port 18999) wired as:

```yaml
openai-compatibility:
  - name: "mock-openai"
    base-url: "http://host.docker.internal:18999/v1"
    api-key-entries:
      - api-key: "mock-upstream-key"
    models:
      - name: "mock-gpt-model"
        alias: "mock-model"
```

Recording requests: `spec/recordings/S2d2.cases.json`. Layout per RECIPES (`reports/oracle/BOOTSTRAP.md` §7): `tests/fixtures/S2d2/<case-id>/{meta.yaml,request.http,downstream.md,upstream.jsonl,mock-response.json}`. Multi-request cases use one labeled block per request inside the same files (or per-request suffixed files, noted in `meta.yaml`). Dynamic fields whitelisted per case in `meta.yaml` (typically `Date`, `X-Cpa-Trace-Id`).

| # | Case id | Pins | Mode / scenario |
|---|---|---|---|
| 1 | `gem2oai-basic-params` | generationConfig mapping table; systemInstruction→system array; user text→string content; upstream wire (headers, alias rewrite, `"stream":false`, no stream_options); non-stream response envelope + usageMetadata; client headers not forwarded. Round-1 recording accidentally used a truncated body (lenient-parsing witness, §7); RE-RECORDED well-formed in round 2 | happy / `s2d2-nonstream-text` |
| 2 | `gem2oai-system-snake-multimodal` | `system_instruction` snake key; system inline image → data: URL; user thought part dropped; user inline audio → `input_audio`; mixed turn → content array | happy / `s2d2-nonstream-text` |
| 3 | `gem2oai-tools-toolconfig` | functionDeclarations (parameters + parametersJsonSchema); tool_choice NONE/AUTO/ANY-single/ANY-multi mappings; upstream tools bytes | happy / `s2d2-nonstream-text` |
| 4 | `gem2oai-tool-roundtrip-request` | functionCall→tool_calls with deterministic sha256 ids; functionResponse→tool messages FIFO; content JSON-stringification; empty function-role turn quirk; upstream messages bytes | happy / `s2d2-nonstream-text` |
| 5 | `gem2oai-thinking-config` | thinkingLevel→reasoning_effort; thinkingBudget→level thresholds; **`auto` CLAMPS to `medium`** (recorded deviance from passthrough) | happy / `s2d2-nonstream-text` |
| 6 | `gem2oai-role-mapping` | `model`→`assistant`; text-part concatenation; unknown roles verbatim | happy / `s2d2-nonstream-text` |
| 7 | `gem2oai-resp-nonstream-toolcall` | message.tool_calls→functionCall parts; id preserved; tool_calls→STOP finishReason | happy / `s2d2-nonstream-toolcall` |
| 8 | `gem2oai-resp-nonstream-reasoning` | reasoning_content→thought part first; length→MAX_TOKENS; reasoning_tokens→thoughtsTokenCount | happy / `s2d2-nonstream-reasoning` |
| 9 | `gem2oai-stream-text-full` | role chunk dropped; per-delta text frames; finish frame; usage-only frame; [DONE] swallowed; no [DONE] downstream; SSE headers; `?alt=sse` equivalence | happy / `s2d2-stream-full` |
| 10 | `gem2oai-stream-toolcall` | tool_call deltas buffered (no frames); flush on finish frame; args reassembly; id preserved | happy / `s2d2-stream-toolcall` |
| 11 | `gem2oai-stream-reasoning` | reasoning deltas → `{"thought":true,...}` frames; interleaved with text frames in arrival order | happy / `s2d2-stream-reasoning` |
| 12 | `gem2oai-stream-slow` | progressive flush per translated frame (chunk count/order; inter-arrival ≥ delay; re-run duration 1.578s at 300ms, frames byte-identical to case 9) | slow (300ms) / `s2d2-stream-full` |
| 13 | `gem2oai-stream-disconnect` | mid-stream hard close: flushed frames preserved; terminal `event: error` frame with `unexpected EOF`; HTTP stays 200 | disconnect (after 2) / `s2d2-stream-full` |
| 14 | `gem2oai-error-in-stream-payload` | upstream error object inside a data frame → terminal `event: error` frame with payload verbatim, HTTP 200 | happy / `s2d2-stream-midstream-error` |
| 15 | `gem2oai-error-429` | upstream 429 body+status VERBATIM for non-stream AND stream (no SSE headers on pre-stream failure) | error (429) |
| 16 | `gem2oai-cooldown-after-429` | model_cooldown body: status 429 + `Retry-After: 4`, alphabetical keys, `reset_seconds: 4`/`reset_time: "4s"` at the 3rd consecutive 429, provider `openai-compatible-mock-openai`; NOT disabled by cooldown config | error (429) then immediate replay |
| 17 | `gem2oai-model-resolution-errors` | unknown alias 400; `models/`-prefixed POST 400; unknown `:method` 200-empty; colon-less action 404 JSON | none (gateway-local) |
| 18 | `gem2oai-count-tokens` | totalTokens+promptTokensDetails body; deterministic o200k count; NO upstream request | none (gateway-local) |
| 19 | `gem2oai-models-list` | Gemini-format model list includes openai-compat alias with `models/` prefix + defaults; GET single model: bare id 200, prefixed/unknown id 404 `not_found` | none (gateway-local) |
| 20 | `gem2oai-auth-styles` | x-goog-api-key and Bearer both accepted on `/v1beta`; 401 shapes | none (gateway-local) |
| 21 | `gem2oai-stream-alt-json` | raw-chunk mode: no SSE headers, byte-adjacent JSON chunk objects, keep-alives force-disabled, terminal-error bytes raw (B1) | happy / `s2d2-stream-full` + `?alt=json` |
| 22 | `gem2oai-auth-transports` | `X-Api-Key`, `?key=`, `?auth_token=`, non-Bearer verbatim `Authorization` all accepted; 401 shapes identical (B2) | none (gateway-local) |
| 23 | `gem2oai-thinking-clamps` | effective thinking mapping clamps: `none`→low, `minimal`→low, `xhigh`→high, `max`→high, budget `0`→low, `300`→low, `30000`→high (B3) | happy / `s2d2-nonstream-text` |
| 24 | `gem2oai-thinking-invalid` | unknown level → 400 `level "X" not supported...`; budget `-5` → 400 `budget -5 cannot...`; same 400 on `countTokens` (B3/B4) | none (validation before dispatch) |
| 25 | `gem2oai-count-tokens-tools` | countTokens over tool-call history + tools: recorded N; upstream wire log empty; formula per §3.4 (B4) | none (gateway-local) |
| 26 | `gem2oai-stream-toolcall-multi` | 2 buffered tool calls flush into ONE finish frame; parts order nondeterministic — sorted-parts comparison (N5 volatility whitelist) | happy / `s2d2-stream-toolcall-multi` |

CREDENTIALED-ONLY behaviors on this pair: none — the openai-compatibility upstream is fully mockable per R-FIXTURE. All 26 cases are RECORDABLE-LOCALLY; none is FIXTURE-DEFERRED.

---

## 7. Open questions and intentional non-equivalences

1. **Q1 — `top_k` forwarding:** the gateway forwards the OpenAI-foreign `top_k` key upstream. Some openai-compatible upstreams reject unknown fields. CPA-Edge MUST reproduce the forwarding (recorded behavior); if an upstream rejects it, that is the upstream's error to pass through. Resolved: keep forwarding.
2. **Q2 — multi-choice overlay (n>1):** non-stream responses merge ALL choices into `candidates[0]` positionally; streaming ignores per-choice indexing entirely (frames always `index:0`, and only the first-choice flow is mapped). This is lossy for n>1. Intentional non-equivalence: CPA-Edge reproduces it (goldens pin n=1 only). A "correct" multi-candidate mapping would be a registered improvement, not a silent one.
3. **Q3 — unknown `:method` returns 200 empty:** preserved as recorded (gin writes nothing when no case matches). A 400 would be cleaner but is a client-visible change; keep 200-empty unless the gate rules otherwise.
4. **Q4 — stream framing vs real Gemini:** with no `alt` the gateway answers SSE (real Gemini answers a JSON array); with `?alt=sse` both answer SSE; with any other non-empty alt (e.g. `alt=json`) the gateway answers RAW CONCATENATED JSON objects, NOT a JSON array (§4.1, golden `gem2oai-stream-alt-json`). Gemini SDKs always use `?alt=sse`, so blast radius is low. CPA-Edge reproduces the recorded behavior in all three cases.
5. **Q5 — countTokens fidelity (RESOLVED by recording):** counts come from a local tokenizer over the TRANSLATED request, not from the upstream; the upstream wire log stays empty. The golden pins the exact integer (4) for the fixed body; CPA-Edge must reproduce that integer (tokenizer behavior is part of the contract).
6. **Q6 — role-chunk dead branch:** the stream translator has an unreachable first-chunk role-emission path; the role frame is always dropped. Recorded; do not "fix".
7. **Q7 — thought-part loss:** hidden-thought parts in REQUESTS are dropped silently (they cannot be represented in the OpenAI wire). Gemini clients that replay model thoughts lose them. Documented, not fixable without protocol extension.
8. **Q8 — `finish_reason` present on the same frame as a content/tool delta:** the finish mapping only fires for frames where the delta carries no content/tool_calls; a frame combining `delta.content` with a non-null `finish_reason` emits ONLY the content frame and the finish reason is LOST. Recorded edge; goldens avoid it; flagged for the adversary.
9. **REGISTERED INTENTIONAL NON-EQUIVALENCE — lenient body parsing (adversary B5 ruling, round 1):** the reference parses request bodies leniently (gjson best-effort): a malformed body — e.g. TRUNCATED JSON — is still translated and executed (witnessed in the round-1 `gem2oai-basic-params` recording, where a truncated body produced the fully-predicted upstream and downstream bytes). CPA-Edge REJECTS non-JSON bodies with HTTP 400 at the boundary (strict parsing) — this is a deliberate, registered deviation; the reference's lenient path is NOT reproduced. Contract tests replay well-formed bodies only (case 1 re-recorded well-formed in round 2). Proposed for SPEC §5 registration by the orchestrator.
10. **REGISTERED VOLATILITY WHITELIST — multi-tool-call stream part order (adversary N5 ruling, round 1):** when 2+ tool calls are buffered, the `functionCall` parts inside the single finish frame are emitted in Go map-iteration order — nondeterministic run to run. Contract comparison for finish frames with 2+ `functionCall` parts compares `candidates[0].content.parts` as a SORTED SET (canonical order by `functionCall.name`, then `functionCall.id`) instead of byte order. Single-tool-call frames remain byte-exact. Golden `gem2oai-stream-toolcall-multi` records one concrete emission; the whitelist (not the fixture bytes) is the contract.
