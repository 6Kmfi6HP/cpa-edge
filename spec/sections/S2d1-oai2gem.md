# S2d1 — OpenAI chat client → Gemini upstream

Writer: @spec-writer (S2d1). Anchor: CLIProxyAPI v7.3.4, commit `8335eac731946bd4eff18f500653f93736df53d6` (docker image `eceasy/cli-proxy-api:v7.3.4`, digest `sha256:97825d…4266`).
Upstream evidence is cited as `<repo path>` relative to the reference clone; recorded wire facts are cited as `ORACLE-WIRE` (see `reports/oracle/BOOTSTRAP.md` §4/§6/§8 and the orchestrator wire notes). Per SPEC §0, recorded behavior outranks this text; this text outranks any implementation.

## 1. Scope and boundaries

**In scope** (all via the `gemini-api-key` provider type with `base-url` override — RECORDABLE-LOCALLY per ruling R-FIXTURE):
- `POST /v1/chat/completions` with an OpenAI Chat Completions body, served by a Gemini (GenerateContent) upstream: model alias resolution, request translation, non-stream response mapping, SSE streaming translation, and error mapping.
- The exact upstream HTTP request the gateway emits (method, URL, headers, body) and the exact downstream bytes the gateway returns.

**Out of scope (cross-references):**
- Route inventory, auth middleware (401 shapes), 404/CORS/OPTIONS behavior: S1 (already recorded in `reports/oracle/BOOTSTRAP.md` §4).
- Credential selection, rotation, retry rounds, cooldown *policy*: S4. Only the client-visible error *shapes* produced by this pipeline are specified here (§5) and cross-listed with S4.
- Responses-format detection on `/v1/chat/completions` (payloads with `input`/`instructions` and no `messages`): S2d5.
- Images/videos, `/v1/completions`, count-tokens: separate sections.

**FIXTURE-DEFERRED (per R-FIXTURE, CREDENTIALED-ONLY):** Gemini CLI / AI Studio OAuth upstreams (antigravity/cloudcode executor; `cloudcode-pa.googleapis.com`) share the OpenAI↔Gemini translator pair used here (`internal/translator/gemini/openai/chat-completions/*`, `internal/runtime/executor/antigravity_executor.go`) but use a different transport (OAuth bearer, websocket relay / `v1internal`). Their client-visible translation is expected to match §3/§4 but cannot be recorded locally; cases are marked `FIXTURE-DEFERRED` in `spec/recordings/S2d1.cases.json` with reasons. `vertex-api-key` (RECORDABLE-LOCALLY, service-account wire) is deferred to a later mission — noted in §7.

## 2. Behavior inventory

### 2.1 Downstream endpoint behavior
| Behavior | Rule | Evidence |
|---|---|---|
| Route | `POST /v1/chat/completions` only | `internal/api/server_routes.go:66` |
| Auth | `Authorization: Bearer <api-key>` (S1; 401 shapes recorded) | ORACLE-WIRE, `sdk/access/errors.go` |
| Body read | Malformed JSON → `400` `{"error":{"message":"Invalid request: <err>","type":"invalid_request_error"}}` (no `code`/`param`) | `sdk/api/handlers/openai/openai_handlers.go` (`ChatCompletions` + `handlers.ReadRequestBody`) |
| `stream` flag | Streaming iff body field `stream` is JSON literal `true` (`"stream":"true"` as string is NOT streaming) | `sdk/api/handlers/openai/openai_handlers.go` (`gjson…stream…Type == gjson.True`) |
| Unknown model | `400` `{"error":{"message":"unknown provider for model <m>","type":"invalid_request_error","code":"model_not_found","param":"model"}}` | `sdk/api/handlers/handlers_routing.go:211`, ORACLE-WIRE |
| Non-stream success | `200`, `Content-Type: application/json`, body = translated JSON (§3.3). Upstream response headers are NOT forwarded (passthrough off by default) | `openai_handlers.go handleNonStreamingResponse`, `sdk/api/handlers/handlers_interceptors.go:289`, `sdk/api/handlers/header_filter.go` |
| Stream success | First translated chunk commits `200` with `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Access-Control-Allow-Origin: *`; then one `data: <chunk>\n\n` frame per translated chunk, flushed individually. The handler also sets `Connection: keep-alive`, but the final wire value is transport-dependent (fixtures recorded `Connection: close` from the curl driver) — treat `Connection` as a volatile header. `Transfer-Encoding: chunked` framing is preserved verbatim in fixtures. | `openai_handlers.go handleStreamingResponse setSSEHeaders`, `sdk/api/handlers/stream_forwarder.go`, fixtures C11/C19 |
| Keep-alive | SSE comment frames `: keep-alive\n\n` only when configured (default off) | `stream_forwarder.go`, `sdk/api/handlers/handlers.go` (`StreamingKeepAliveInterval`) |

### 2.2 Model alias → upstream rewrite
Pipeline (per request):
1. The `model` field from the client is the **client alias** (must be configured under `gemini-api-key[].models[].alias`, else `model_not_found` as above).
2. A thinking suffix `alias(<suffix>)` is legal: suffix is stripped for provider lookup, and the configured upstream model keeps the suffix appended. NOTE (RECORDED, fixture C08): for thinking-less config-declared models the suffix's thinking intent is DROPPED by the capability pass (§3.2 step 2) — the suffix only affects routing/URL/model-name stripping, it does NOT produce a thinkingConfig. Evidence: `sdk/api/handlers/handlers_routing.go getRequestDetailsWithOptions`, `sdk/cliproxy/auth/conductor_models.go preserveRequestedModelSuffix`, `internal/thinking/apply.go`.
3. Alias → upstream (`models[].name`) resolution is exact-case-insensitive on the alias, suffix-preserved. `sdk/cliproxy/auth/conductor_models.go resolveAPIKeyModelAliasWithResult`, `oauth_model_alias.go resolveModelAliasResultFromConfigModels`.
4. Upstream URL model = `ParseSuffix(upstream).ModelName` (suffix stripped). `internal/runtime/executor/gemini_executor.go` (`baseModel := thinking.ParseSuffix(req.Model).ModelName`), `internal/thinking/suffix.go`.
5. The translated body carries top-level `"model": <upstream base model>` (translator sets it; executor re-asserts). `gemini_openai_request.go`, `gemini_executor.go SetStringIfDifferent`.

**Which model name echoes back (downstream `model` field):** the value comes from the upstream response field `modelVersion` — NOT from the client alias. Absent `modelVersion` → literal string `"model"` (template default). With `force-mapping: true` on the model entry, `model` in the response/chunk is rewritten to the configured alias. Evidence: `internal/translator/gemini/openai/chat-completions/gemini_openai_response.go` (model ← modelVersion), `sdk/cliproxy/auth/conductor_models.go rewriteForceMappedResponse`, `sdk/cliproxy/auth/response_model_rewriter.go` (`modelFieldPaths = ["model","modelVersion","response.model","response.modelVersion","message.model"]`). ORACLE-WIRE confirms: default echo = upstream model; force-mapping rewrites.

### 2.3 Upstream HTTP request (gateway → Gemini)
| Element | Rule | Evidence |
|---|---|---|
| Method | `POST` | `gemini_executor.go` |
| URL non-stream | `{base-url}/v1beta/models/{upstream-model}:generateContent` (no query unless the client sent a non-`sse` `?alt=X`, which becomes `?$alt=X`) | `gemini_executor.go` (`glAPIVersion = "v1beta"`) |
| URL stream | `{base-url}/v1beta/models/{upstream-model}:streamGenerateContent?alt=sse` (client query `?alt=sse` maps to this too; any other `?alt=X` → `?$alt=X`) | `gemini_executor.go`, `sdk/api/handlers/handlers.go GetAlt` |
| base-url | `gemini-api-key[].base-url`, trailing `/` trimmed; default `https://generativelanguage.googleapis.com` | `gemini_executor.go resolveGeminiBaseURL` |
| Auth header | `x-goog-api-key: <api-key>`; no `Authorization` | `gemini_executor.go PrepareRequest` |
| Other headers | `Content-Type: application/json`; `Accept-Encoding: gzip`; `User-Agent: Go-http-client/1.1` (Go default; no UA is set); client request headers are NOT forwarded; per-credential `headers:` config entries are applied | `gemini_executor.go applyGeminiHeaders`, `internal/util/header_helpers.go ApplyCustomHeadersFromAttrs`, ORACLE-WIRE |
| Body | Translated JSON (§3.1), then executor post-processing (§3.2) | `gemini_executor.go Execute/ExecuteStream` |

### 2.4 Response headers downstream
With `passthrough-headers` off (default), NO upstream response headers are forwarded. Downstream headers are only those set by the handler/middleware (Content-Type, CORS block; `X-Cpa-Trace-Id` dynamic). `handlers_interceptors.go downstreamHeadersFromExecutor`, `header_filter.go`. ORACLE-WIRE: every response carries the CORS block.

## 3. Schemas (field-by-field)

### 3.1 Request translation: OpenAI chat body → Gemini body
Source: `internal/translator/gemini/openai/chat-completions/gemini_openai_request.go` (`ConvertOpenAIRequestToGemini`). The output document is built from scratch — fields absent from the tables below are **dropped** (never forwarded).

**Top level**
| OpenAI request field | Gemini field | Rule |
|---|---|---|
| (constant) | `contents` | array; always present (possibly `[]`) |
| `model` (post alias resolution) | `model` | string; upstream base model |
| `generationConfig` (nonstandard client field) | `generationConfig` | copied verbatim first (object), later mappings may overwrite keys inside it |
| `reasoning_effort` (string) | `generationConfig.thinkingConfig` | `"auto"` → `thinkingBudget: -1`; any other non-empty value → `thinkingLevel: <lowercased/trimmed>` — **then the capability pass strips it** (see §3.2 step 2 and the RECORDED rule below). Evidence: `gemini_openai_request.go`, `internal/thinking/apply.go`, `internal/modelconfig/model_info.go`, fixture S2d1-C07 |
| `temperature` | `generationConfig.temperature` | only if JSON number |
| `top_p` | `generationConfig.topP` | only if JSON number |
| `top_k` (nonstandard) | `generationConfig.topK` | only if JSON number |
| `max_tokens` else `max_completion_tokens` | `generationConfig.maxOutputTokens` | `max_tokens` wins; only if number |
| `n` | `generationConfig.candidateCount` | only when `n > 1` |
| `response_format.type == "json_object"` | `generationConfig.responseMimeType = "application/json"` | |
| `response_format.type == "json_schema"` | `generationConfig.responseMimeType = "application/json"` + `generationConfig.responseJsonSchema = response_format.json_schema.schema` | |
| `modalities` (array) | `generationConfig.responseModalities` | items `text`/`image` case-insensitive → `"TEXT"`/`"IMAGE"` |
| `image_config.aspect_ratio` / `image_config.image_size` (nonstandard) | `generationConfig.imageConfig.aspectRatio` / `.imageSize` | |
| `messages` | `systemInstruction` + `contents` | §3.1.1 |
| `tools` | `tools` | §3.1.2 |
| (constant) | `safetySettings` | ALWAYS attached when absent from the translated body: `[{HARM_CATEGORY_HARASSMENT, OFF}, {HARM_CATEGORY_HATE_SPEECH, OFF}, {HARM_CATEGORY_SEXUALLY_EXPLICIT, OFF}, {HARM_CATEGORY_DANGEROUS_CONTENT, OFF}, {HARM_CATEGORY_CIVIC_INTEGRITY, BLOCK_NONE}]` (`internal/translator/gemini/common/safety.go`). ORACLE-WIRE: injection confirmed |

**Dropped fields (intentional non-equivalence):** `stop`, `tool_choice`, `parallel_tool_calls`, `seed`, `frequency_penalty`, `presence_penalty`, `logprobs`, `top_logprobs`, `user`, `stream_options`, `store`, `metadata`, `service_tier`, and every other unmapped field. `tool_choice` in particular is NOT translated to `toolConfig` in this direction (it IS in claude→gemini — intentional asymmetry).

**3.1.1 messages → systemInstruction + contents**
- Leading `system`/`developer` messages (all such messages before the first `user`/`assistant`) AND `len(messages) > 1` → collected into `systemInstruction = {"role":"user","parts":[{"text":…},…]}` (text parts only). A *lone* system message (`len == 1`) becomes a normal user content instead.
- `system`/`developer` after conversation start → user content.
- Each `user` message → ONE content node `{"role":"user","parts":[…]}` (parts are never split into multiple contents):
  - content string → `{"text":…}`; content array items: `text` (skipped when empty string), `image_url` with `data:` URL → `{"inlineData":{"mime_type":…,"data":…},"thoughtSignature":"skip_thought_signature_validator"}` (the literal signature is injected on user images), `video_url` with `data:` URL → `inlineData` (no signature), `file` (`file.filename`+`file.file_data`) → `inlineData` via extension-derived mime, `input_audio` (`data`,`format`) → `inlineData` with mime map `""`/"wav"→`audio/wav`, `mp3`→`audio/mpeg`, `ogg`→`audio/ogg`, `flac`→`audio/flac`, `aac`→`audio/aac`, `webm`→`audio/webm`, `pcm16`→`audio/pcm`, `g711_ulaw`/`g711_alaw`→`audio/basic`, else `audio/<format>`.
- Each `assistant` message → ONE content node `{"role":"model","parts":[…]}` in this order:
  1. `reasoning_content` (non-empty string) → `{"text":…,"thought":true,"thoughtSignature":"skip_thought_signature_validator"}`
  2. `content` string → `{"text":…}`; content array → text parts (+ image_url data URLs)
  3. each `tool_calls[]` with `type == "function"` and non-empty sanitized name → `{"functionCall":{"name":<sanitized>,"args":<raw arguments JSON>},"thoughtSignature":<extra_content.google.thought_signature | function.extra_content.google.thought_signature | thoughtSignature | thought_signature | else "skip_thought_signature_validator">}`
- Function-name sanitization (`internal/util/util.go SanitizeFunctionName`): `[^a-zA-Z0-9_.:-]` → `_`; must start with letter/underscore (else prefix `_`); truncated to 64 chars.
- **Synthetic tool-result turn:** immediately after an assistant content that had tool_calls, ONE user content `{"role":"user","parts":[…,{"functionResponse":{"name":<sanitized function name>,"response":{"result":<tool message content raw JSON>}}}…]}` is emitted — one part per tool_call whose id matches a `tool` message (`tool_call_id` → content). Missing match → `result` defaults to `"{}"`. A string tool content becomes a JSON string; a JSON-object content is embedded raw as an object. `tool` messages themselves are never emitted as standalone contents and are dropped if unmatched.
- **Trailing model content dropped:** if the LAST built content has role `model`, it is removed (only the last one).

**3.1.2 tools → tools[]**
- One `{"functionDeclarations":[…]}` node first, then any `{googleSearch}`, `{codeExecution}`, `{urlContext}` nodes (from `tools[].google_search` / `code_execution` / `url_context`).
- Each function declaration: `name` (sanitized), `description`, `parameters` renamed to **`parametersJsonSchema`** (raw passthrough); no `parameters` → default `{"type":"object","properties":{}}`; `strict` deleted; schema run through `CleanJSONSchemaForGemini` (drops `nullable`/`title`, flattens anyOf/oneOf, forces enum strings to string type, adds missing array `items`, converts refs/const and moves unsupported constraints to description hints — full matrix in `internal/util/gemini_schema.go`).

### 3.2 Executor post-processing of the translated body (order matters)
1. Translate request (§3.1). 2. **Thinking capability pass (RECORDED, fixtures C07/C08):** for config-declared `gemini-api-key` models the gateway attaches an explicit capability snapshot (`internal/modelconfig/model_info.go ResolveModelInfo`): `UserDefined = false`, and `Thinking = nil` unless the model entry declares a `thinking:` block. With `Thinking == nil`: any translated `generationConfig.thinkingConfig` (from `reasoning_effort`) is **deleted** (`internal/thinking/strip.go StripThinkingConfig`, gemini path) leaving `generationConfig` possibly `{}` (C07); and a model-name thinking suffix is **silently dropped** — the suffix still routes/strips per §2.2 but NO thinkingConfig is added (C08). The level→budget conversion (none→0, minimal→512, low→1024, medium→8192, high→24576, xhigh→32768, max→128000, `internal/thinking/convert.go`) applies only on paths where the model resolves as user-defined/unknown to the capability table — NOT reachable for `gemini-api-key` models, whose serving requires a `models[]` entry. If the upstream base name matches the startup catalog, `registry.LookupStaticModelInfo` supplies that capability instead (catalog-dependent; not golden-covered). Evidence: `internal/runtime/executor/helps/model_capabilities.go ApplyRequestThinking`, `internal/thinking/apply.go` (`modelInfo.Thinking == nil` branch), `sdk/cliproxy/auth/api_key_model_capabilities.go`, fixtures S2d1-C07/C08. 3. Image-aspect fix — only for literal upstream model `gemini-2.5-flash-image-preview` (out of scope for goldens). 4. Per-model payload-config overrides (`config` blocks; no-op when unconfigured). 5. Re-assert `model`. 6. `capGeminiMaxOutputTokens`: only if the upstream model is in the startup-fetched catalog with an output-token limit and `maxOutputTokens` exceeds it → clamped. 7. Thought-signature sanitize of `contents`. 8. Boundary turns: prepend `{"role":"user","parts":[{"text":""}]}` if `contents[0].role == "model"`; append the same empty user turn if the LAST content role is `model`/`assistant` AND it has no `functionResponse` part. 9. `session_id` deleted. Evidence: `internal/runtime/executor/gemini_executor.go`, `internal/runtime/executor/helps/gemini_content_turns.go`.

### 3.3 Non-stream response mapping (Gemini → `chat.completion`)
Source: `internal/translator/gemini/openai/chat-completions/gemini_openai_response.go` (`ConvertGeminiResponseToOpenAINonStream`).

Template: `{"id":"","object":"chat.completion","created":<ts>,"model":<m>,"choices":[…]}`.
| Gemini field | OpenAI field | Rule |
|---|---|---|
| `responseId` | `id` | absent → `""` |
| `createTime` (RFC3339Nano) | `created` | unix seconds; absent/unparsable → `0` |
| `modelVersion` | `model` | absent → literal `"model"` |
| `usageMetadata.candidatesTokenCount + thoughtsTokenCount` | `usage.completion_tokens` | sum |
| `usageMetadata.totalTokenCount` | `usage.total_tokens` | |
| `usageMetadata.promptTokenCount` | `usage.prompt_tokens` | |
| `usageMetadata.thoughtsTokenCount` (>0) | `usage.completion_tokens_details.reasoning_tokens` | omitted when absent/0 |
| `usageMetadata.cachedContentTokenCount` (>0) | `usage.prompt_tokens_details.cached_tokens` | omitted when absent/0 |
| `candidates[]` | `choices[]` (one per candidate, in order) | `index` ← candidate `index` (default 0) |

Per choice: `message` = `{"role":"assistant","content":<concatenated non-thought text parts>,"reasoning_content":<concatenated thought:true text parts>,"tool_calls":[…],"images":[…]}` where:
- `content`/`reasoning_content` are plain strings set only when at least one part contributed; else `null`.
- `tool_calls[]` items: `{"id":"<name>-<unix-nano>-<counter>","type":"function","function":{"name":…,"arguments":<args raw>}}` — **no `index` field**; `id` is dynamic (mask in fixtures); name restored via the legacy sanitized-name map, which for OpenAI-format requests is EMPTY → the (sanitized) upstream name echoes verbatim (`internal/util/translator.go SanitizedToolNameMap` reads `tools[].name`, absent in OpenAI format).
- `images[]` items: `{"index":N,"type":"image_url","image_url":{"url":"data:<mime>;base64,<data>"}}` (nonstandard `images` field); mime default `image/png`.
- `finish_reason` = lowercase(upstream `finishReason`) e.g. `stop`/`max_tokens`/`safety`; **overridden to `tool_calls`** when any functionCall part exists; `native_finish_reason` mirrors the same value (also `"tool_calls"` when overridden). Absent finishReason → both `null`.
- `audioTranscription.text` is treated as text when `text` is absent (transcribe models).
- No candidates → `choices: []` (usage still mapped).

### 3.4 Stream chunk mapping (Gemini chunk → `chat.completion.chunk`)
Source: `ConvertGeminiResponseToOpenAI` (same file). Per candidate of each upstream chunk, ONE chunk object:
`{"id":…,"object":"chat.completion.chunk","created":…,"model":…,"choices":[{"index":<cand.index>,"delta":{…},"finish_reason":…,"native_finish_reason":…}],"usage":…}` where:
- `id`/`created`/`model` come from the CURRENT chunk's `responseId`/`createTime`/`modelVersion`; `created` persists from an earlier chunk's `createTime` (state); defaults `""`/`0`/`"model"`.
- `delta` base: `{"role":null,"content":null,"reasoning_content":null,"tool_calls":null}` — the null keys are always present. `role` becomes `"assistant"` on the FIRST payload-bearing chunk of this object (reset per chunk):
  - text part: `thought:true` → `delta.reasoning_content`; else `delta.content`.
  - functionCall part → append `delta.tool_calls[i]`: `{"id":"<name>-<unix-nano>-<counter>","index":<per-candidate counter, increments across chunks>,"type":"function","function":{"name":…,"arguments":<args raw>}}`.
  - inlineData part → append `delta.images[i]`: `{"index":N,"type":"image_url","image_url":{"url":"data:<mime>;base64,<data>"}}`.
  - pure `thoughtSignature` parts (no text/functionCall/inlineData payload) are skipped.
- `usage` is present only when the (post-filter, §4) chunk carried `usageMetadata`; mapped as §3.3.
- A chunk whose candidates have no payload parts still emits a chunk with all-null delta.
- Multi-candidate upstream chunks fan out to one downstream chunk per candidate, in candidate order.
- **Stream/non-stream asymmetry (tool calls):** non-stream overwrites `native_finish_reason` to `"tool_calls"` (§3.3); streaming keeps `native_finish_reason` = lowercase upstream reason while `finish_reason` = `"tool_calls"` (§4 rule 5). Pinned by C04 vs C12.

## 4. Streaming rules (contract-test material)

Downstream frame grammar (byte-exact; volatile fields whitelisted in fixture `meta.yaml`):
1. First translated chunk commits `200` + SSE headers (§2.1). If the stream produces NO data before closing, the response is headers + `data: [DONE]\n\n` only (`openai_handlers.go handleStreamingResponse`).
2. Each translated chunk → one frame `data: <chunk-json>\n\n`, flushed before reading further.
3. On clean upstream EOF: final frame `data: [DONE]\n\n`. The gateway itself appends this marker; a Gemini wire `[DONE]` does not exist (the executor feeds an internal `[DONE]` to the translator, which yields no output).
4. **Upstream usage filtering:** each upstream SSE line is first filtered — if the payload has `candidates.0.finishReason` it is kept verbatim; otherwise any `usageMetadata` is RENAMED to `cpaUsageMetadata` (hidden from the client). Consequence: a usage-only chunk (no `finishReason`) produces NO downstream frame at all. Evidence: `gemini_executor.go` stream loop, `internal/runtime/executor/helps/usage_helpers.go FilterSSEUsageMetadata/StripUsageMetadataFromJSON`.
5. **finish_reason timing rule:** a downstream chunk carries `finish_reason`/`native_finish_reason` ONLY when the upstream payload has BOTH (a) `usageMetadata` surviving the filter, AND (b) an upstream `finishReason` for that candidate seen in this or an earlier chunk. Value: `"tool_calls"` if any functionCall was seen for the candidate (state); else `"max_tokens"` if upstream reason is `MAX_TOKENS`; else `"stop"` (upstream `SAFETY` etc. map to `"stop"`). `native_finish_reason` = lowercase(upstream reason) — note the asymmetry: with tool calls, `finish_reason="tool_calls"` but `native_finish_reason` keeps the upstream reason (e.g. `"stop"`). If finish and usage arrive in different upstream chunks, the client NEVER sees `finish_reason` or `usage` (split-terminal quirk).
6. `event:` lines, empty lines, and non-JSON payloads from the upstream are skipped (no downstream frame). `internal/runtime/executor/helps/usage_helpers.go jsonPayload`.
7. Keep-alive comments only when configured (default none).
8. Mid-stream terminal error (see §5): one final frame `data: {"error":…}\n\n`; **no `data: [DONE]`** after it.
9. OPTIONAL (not golden-recorded): client-side disconnect mid-stream cancels the upstream; the client just sees a truncated stream.

## 5. Error semantics

**Before any data is sent (non-stream, or stream with upstream error before first chunk):**
- Upstream non-2xx: status passes through unchanged; body passes through **verbatim** when it is valid JSON (Gemini's `{"error":{"code":…,"message":…,"status":…}}` is valid JSON → byte-identical, only surrounding whitespace trimmed). Evidence: `gemini_executor.go statusErr{code, msg=raw body}`, `sdk/api/handlers/handlers.go BuildErrorResponseBodyWithError` (`json.Valid` short-circuit), ORACLE-WIRE ("429 body+status passes downstream VERBATIM").
- Upstream non-2xx with NON-JSON body → OpenAI envelope by status: 401→`{"error":{"message":…,"type":"authentication_error","code":"invalid_api_key"}}`; 403→`permission_error`/`insufficient_quota`; 429→`rate_limit_error`/`rate_limit_exceeded`; 404→`invalid_request_error`/`model_not_found`; ≥500→`server_error`/`internal_server_error`; else `invalid_request_error` without code. `BuildErrorResponseBodyWithError`.
- Request-invalid classification: upstream 400 (and 409/413/422) bodies do NOT rotate or cool credentials (request fault); 429 and 401-with-`authentication_error` DO. `internal/clienterror/client_error.go IsRequestFault`.

**After SSE headers are committed (mid-stream):**
- Upstream transport failure (hard close, reset): HTTP stays 200; one final frame `data: {"error":{"message":"<go transport error, e.g. 'unexpected EOF'>","type":"server_error","code":"internal_server_error"}}\n\n`; NO `[DONE]`. Evidence: `gemini_executor.go` scanner error → `StreamChunk{Err}`, `sdk/api/handlers/handlers_stream.go chunk.Err → executionErrorMessage`, `openai_handlers.go handleStreamResult WriteTerminalError`, ORACLE-WIRE.
- JSON validation of openai-chunk payloads: not enforced for the openai protocol (that validator runs for responses format only). `handlers_stream.go sseJSONValidationState`.

**Cooldown interaction (cross-listed S4; client-visible shape pinned here):** an upstream 429 puts the credential into a short (~1s) rate-limit cooldown that `transient-error-cooldown-seconds: -1` does NOT disable (ORACLE-WIRE). RECORDED (fixture S2d1-C16): the first request still returns the upstream 429 verbatim; a request hitting the cooldown returns **HTTP 429** with `Retry-After: 1` and body `{"error":{"code":"model_cooldown","last_upstream_error":"<verbatim upstream body>","message":"All credentials for model <m> are cooling down via provider <p> (last error: <verbatim>)","model":"<m>","provider":"<p>","reset_seconds":<n>,"reset_time":"<n>s"}}` (envelope from `sdk/cliproxy/auth/selector.go modelCooldownError`; keys marshal alphabetically). NO upstream request is made while cooling (empty `upstream.jsonl`). Family consistency (ORACLE-WIRE across workers): the rate-limit family surfaces `model_cooldown` at 429 for gemini, claude and antigravity; only the transient/500-class family surfaces 503 `auth_unavailable`. `reset_seconds`/`reset_time`/`Retry-After` are dynamic fields (mask).

## 6. Golden samples index

All 21 fixtures (20 required + 1 optional) recorded by @oracle-runner-2 against the pinned image, following the RECIPES layout (`meta.yaml`, `request.http`, `downstream.md` with full SSE byte streams incl. raw chunked framing, `upstream.jsonl` per case, `mock-response.json`). Dir: `tests/fixtures/S2d1/<case-id>/`. Case definitions: `spec/recordings/S2d1.cases.json`. Recording stack ports (gateway 8387, gemini mock 20001 in worker-2's run) are dynamic fields listed in each `meta.yaml` — the SPEC does not pin ports. Deviation resolved during recording: C16 surfaces the rate-limit cooldown at HTTP 429 (not 500 as first predicted); C07/C08 pin thinking strip/drop (see §3.2 step 2).

| Fixture (tests/fixtures/S2d1/…) | Pins | Status |
|---|---|---|
| `C01-nostream-basic/` | systemInstruction extraction; sampling → generationConfig; safetySettings injection; upstream URL/headers; `chat.completion` envelope incl. `id:""`, `created:0`, model echo = upstream name | recorded |
| `C02-nostream-multiturn/` | multi-turn contents roles; trailing system → user content; last-turn-user (no synthetic turn) | recorded |
| `C03-nostream-tools-history/` | functionDeclarations rename+clean; functionCall parts + literal thought signature; synthetic functionResponse user turn; tool message consumption | recorded |
| `C04-nostream-tool-call/` | response functionCall → `message.tool_calls` (no index), finish_reason/tool_calls override, native_finish_reason tool_calls | recorded |
| `C05-nostream-max-tokens/` | max_tokens → maxOutputTokens; MAX_TOKENS → finish_reason `max_tokens` | recorded |
| `C06-nostream-usage-details/` | thought parts → reasoning_content; thoughtsTokenCount/cachedContentTokenCount → usage details | recorded |
| `C07-nostream-reasoning-effort/` | reasoning_effort 'low' on a config-declared thinking-less model → translated thinkingConfig is STRIPPED by the capability pass; outbound body has `generationConfig:{}` and no thinkingConfig | recorded |
| `C08-nostream-model-suffix/` | alias suffix `(high)`: suffix stripped from upstream URL + body model; thinking intent DROPPED (no generationConfig in outbound body at all) | recorded |
| `C09-nostream-n2-candidates/` | n>1 → candidateCount; 2 candidates → 2 choices | recorded |
| `C10-nostream-image-data-url/` | image_url data: → inlineData + literal thoughtSignature on user image part | recorded |
| `C11-stream-basic/` | 3-chunk SSE sequence: role+content chunks (model `"model"` mid-stream), final chunk = finish_reason+usage+modelVersion merge, `data: [DONE]` | recorded |
| `C12-stream-tool-call/` | stream tool_calls chunks (index, dynamic id), finish_reason `tool_calls` + native_finish_reason `stop` asymmetry | recorded |
| `C13-stream-max-tokens/` | stream MAX_TOKENS final chunk | recorded |
| `C14-stream-no-terminal-merge/` | split finish/usage upstream chunks → no finish_reason, no usage, [DONE] only | recorded |
| `C15-error-429-nostream/` | 429 + Gemini error JSON verbatim (status+body) | recorded |
| `C16-error-429-cooldown/` | request during rate-limit cooldown → 429 + Retry-After: 1 + model_cooldown envelope, zero upstream calls (timing-sensitive pair with C15) | recorded |
| `C17-error-400-nostream/` | 400 INVALID_ARGUMENT verbatim pass-through | recorded |
| `C18-stream-error-before-first-byte/` | stream upstream error → plain JSON 429 error response, NOT SSE | recorded |
| `C19-stream-disconnect-mid-stream/` | 200 SSE kept; 2 chunks; terminal `data: {"error":…}` frame; NO [DONE] | recorded |
| `C20-nostream-force-mapping/` | force-mapping: true → response `model` rewritten to client alias | recorded |
| `C21-stream-force-mapping/` | force-mapping on a stream: every chunk's `model` rewritten to the client alias (StreamRewriter) | recorded |

Deferred (FIXTURE-DEFERRED, R-FIXTURE): Gemini CLI/AIStudio OAuth upstream transport (cloudcode-pa); `vertex-api-key` wire — see §1 and the cases file.

## 7. Open questions and intentional non-equivalences

1. **`tool_choice` and `stop` are silently dropped** in the openai→gemini direction (not translated to `toolConfig`/`stopSequences`; claude→gemini does translate tool_choice — `internal/translator/gemini/claude/gemini_claude_request.go:282`). Intentional compatibility mirror; do not "fix" without a ruling.
2. **Legacy tool-name restore quirk:** responses echo the sanitized tool name (not the client's original) because the legacy map reads `tools[].name` (Claude shape). `internal/util/translator.go`. Pinned by C04. If deemed a defect upstream, register a ruling; do not diverge.
3. **Catalog- and config-dependent thinking behavior (partially RESOLVED by recording):** the upstream doc comment in `internal/thinking/apply.go` claims config-declared models are "UserDefined=true" (passthrough), but `internal/modelconfig/model_info.go ResolveModelInfo` — the path actually used for `gemini-api-key` models — sets `UserDefined = false` and `Thinking = nil` (no `thinking:` block). Recorded outcome (C07/C08): thinking intent is stripped / suffix dropped, NOT converted to a budget. The level→budget path is unreachable for `gemini-api-key` (serving requires a `models[]` entry, which always attaches the capability snapshot). Remaining catalog dependency: if the upstream base name matches the startup catalog (`raw.githubusercontent.com/router-for-me/models`), `registry.LookupStaticModelInfo` supplies capabilities instead (and `capGeminiMaxOutputTokens` may clamp). Goldens deliberately use non-catalog upstream model names (`gemini-mock-model*`) for determinism; catalog-known model behavior is specified but NOT golden-covered. Model entries that DO declare `thinking: levels[...]` take the levels-capability path (config-dependent, not golden-covered).
4. **Multi-candidate streaming** (candidateCount>1 streams, `candidates.0`-only usage filter) is specified from source; golden C09 covers non-stream n=2 only. Stream multi-candidate fixtures deferred.
5. **Slow-chunks mode** produces byte-identical output to happy mode (only inter-chunk timing differs) — no golden; OPTIONAL.
6. **Client-side disconnect** mid-stream: transport-level truncation; not fixture-recorded (OPTIONAL).
7. **Schema cleaner full matrix** (`CleanJSONSchemaForGemini`): goldens cover a simple object schema only; the full rewrite matrix (anyOf/oneOf flattening, enum hints, const→enum) may deserve its own section if any downstream consumer depends on it.
8. Open: should the trailing-model-content drop (§3.1.1) be kept when it empties `contents` entirely (assistant-only conversation → `contents: []`)? Mirrored as-is; the mock upstream defines the observable outcome.
