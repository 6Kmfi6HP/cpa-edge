# S2d3 — OpenAI Chat Completions client → Claude (Anthropic Messages) upstream

Upstream anchor: CLIProxyAPI **v7.3.4**, commit `8335eac731946bd4eff18f500653f93736df53d6`.
All evidence paths are files inside the upstream reference repo (`_cpa_edge_ref/CLIProxyAPI`), read as a behavioral specification only. Oracle-recorded wire facts (probes `probes/mocks/claude/`, `reports/oracle/BOOTSTRAP.md` §6–7 and the wire notes in the mission brief) outrank source-derived claims; both are cited.

## 1. Scope and boundaries

In scope — the full client→upstream→client pipeline for an **OpenAI Chat Completions** request served by a **Claude upstream** credential (`claude-api-key` config entry; RECORDABLE-LOCALLY per R-FIXTURE):

- Downstream route `POST /v1/chat/completions` (auth, body reading, stream switch) — only the parts specific to this direction; generic route/CORS/404 semantics are S1.
- Upstream HTTP wire: method, path, headers, body construction (request translation), and the executor post-processing chain that is observable on the wire.
- Response translation: non-stream aggregation and stream event mapping to `chat.completion` / `chat.completion.chunk`, usage arithmetic, finish-reason mapping.
- Downstream SSE framing and `[DONE]` semantics for this direction.
- Error semantics: upstream status/shape → downstream status/body/envelope, in-stream errors, transport failures.
- Golden-sample index (§7).

Out of scope (owned elsewhere):

- Model routing, alias→provider selection, scheduling, cooldown state machine except the one 429→cooldown interaction pinned in §5.3 (S4).
- `claude-api-key` config schema beyond the keys exercised here (S6); management API writes (S5).
- The Claude *client* surface (`/v1/messages`, `/v1/messages/count_tokens`) — that is S2d4/S2d7/S2d8. `/v1/messages/count_tokens` on the upstream is never called by this direction.
- OAuth-backed Claude credentials (fixed `api.anthropic.com`, CLI fingerprint, cloaking, CCH signing, diagnostics, context-management, MCP alias) — CREDENTIALED-ONLY, documented as deferred in §7.3.
- `/v1/completions` (legacy completions) shares this pipeline after an internal chat-completions conversion (`sdk/api/handlers/openai/openai_handlers.go` `convertCompletionsRequestToChatCompletions`, S1/S2d1); goldens here use `/v1/chat/completions` only.
- OpenAI **Responses**-format payloads posted to `/v1/chat/completions`: pre-converted to Chat Completions when the body has `input`/`instructions` and no `messages` (`openai_handlers.go` `shouldTreatAsResponsesFormat`) and then follow this same pipeline; conversion detail is S2d6.
- Gemini/Interactions/Responses client → Claude upstream variants: S2d7 and the responses translator in `internal/translator/claude/openai/responses/`.

## 2. Behavior inventory

### 2.1 Downstream entry

| Behavior | Contract |
|---|---|
| Route | `POST /v1/chat/completions` (client auth: `Authorization: Bearer <api-key>`; S1 §4.1). Wrong method → 404 empty (R-404). |
| Body read failure | 400 `{"error":{"message":"Invalid request: ...","type":"invalid_request_error"}}` (no `code`). Evidence: `openai_handlers.go` `ChatCompletions`. |
| Stream switch | `stream == true` (JSON boolean true) → SSE downstream; anything else → JSON downstream. Evidence: `ChatCompletions`. |
| Responses-shape sniff | Body without `messages` but with `input` or `instructions` is converted Responses→Chat first. Evidence: `shouldTreatAsResponsesFormat`. |
| Success | 200 in both modes. |

### 2.2 Upstream call (both downstream modes)

| Element | Contract |
|---|---|
| Method+path | `POST {base-url}/v1/messages?beta=true` — the `?beta=true` query is ALWAYS present, on every request. Evidence: `internal/runtime/executor/claude_executor_execute.go` line 32 (`Execute`), `claude_executor_stream.go` (same line in `ExecuteStream`). Recorded: `probes/mocks/claude/upstream.jsonl`. |
| base-url | `claude-api-key` entry's `base-url`; if unset, `https://api.anthropic.com` (DEFERRED, §7.3). Evidence: `claude_executor_execute.go`. |
| Upstream is ALWAYS streamed | The upstream body always carries `"stream": true`, for BOTH downstream modes. Non-stream clients are served from the aggregated upstream SSE buffer. `upstreamStream := responseFormat != to` — for a chat client `responseFormat`=`openai` ≠ `claude`, so always true. Evidence: `claude_executor_execute.go` (`upstreamStream`, `SetBoolIfDifferent(body, "stream", upstreamStream)`), translator `out.SetBytes("stream", stream)` with `stream=true` from the executor. Recorded: t1 (client `stream:false`) shows upstream `"stream":true`. **This is a hard pin from the wire notes.** |
| Path length | Single upstream request per client request under `request-retry: 0`. |

### 2.3 Upstream headers (caller-owned mode)

A credential with `fingerprint-profile: claude-code-cli` (or a Claude OAuth credential) LEAVES caller-owned mode and emits the Claude Code CLI wire instead — recorded in case 21: UA `claude-cli/2.1.258 (external, cli)`, full `Anthropic-Beta` assembly (incl. `oauth-2025-04-20` despite an API-key credential), `X-App: cli`, the complete `X-Stainless-*` set (`Arch`, `Os`, `Package-Version`, `Retry-Count`, `Runtime`, `Runtime-Version`, `Lang`, `Timeout: 600`), `Anthropic-Dangerous-Direct-Browser-Access: true`, `X-Claude-Code-Session-Id: <UUID>`, `Connection: keep-alive`, `Accept: text/event-stream`, `Accept-Encoding: identity`; the body is cloaked (billing-header system block + Claude Code persona system block with 1h cache TTL, a `<system-reminder>` date-context block prepended to the first user message — the date is dynamic — and `metadata.user_id` becomes a JSON string `{device_id, account_uuid, session_id}` with masked UUIDs). Fixtures: `tests/fixtures/S2d3/s2d3-fingerprint-cli-profile/`.

For an unconfirmed non-Claude-Code client on a plain `claude-api-key` credential (no `fingerprint-profile`, no `cloak` config), the wire policy is **caller-owned**: `preserveCallerFingerprint = !(ProfileClaudeCodeCLI || Cloak) && !confirmedClaudeCode` = true. Evidence: `claude_executor_request.go` `applyClaudeHeadersWithNativeProfile` lines 893–1107, `claude_executor_cloaking.go` `resolveClaudeWirePolicy`. Recorded: t1/t2 `upstream.jsonl`.

| Header | Rule |
|---|---|
| `Authorization` | `Bearer <api-key>` when the base-url is NOT `api.anthropic.com`. (`x-api-key` is used ONLY when the base URL is Anthropic's own — DEFERRED, §7.3.) Evidence: `claude_executor_request.go` lines 904–915. |
| `Content-Type` | Always `application/json`. Evidence: line 916. |
| `Anthropic-Version` | Caller's value if the client sent one; otherwise `2023-06-01`. Evidence: line 1069 + `internal/misc/header_utils.go` `EnsureHeader` (source value wins, else existing, else default). |
| Forwarded client headers | Exactly this set is copied from the client request (case-insensitive names): `accept`, `accept-encoding`, `user-agent`, `x-app`, `x-client-request-id`, `anthropic-*` (includes `anthropic-beta` and `anthropic-version`), `x-stainless-*`, `x-claude-code-*`, `x-claude-remote-*`, `x-client-app`, `x-anthropic-additional-protection`. All other client headers are NOT forwarded. Evidence: `copyClaudeCallerFingerprintHeaders` lines 826–847. |
| `Accept` default | If the client sent no `Accept`: `text/event-stream` (streaming upstream on non-Anthropic base). If the client sent one, the client's value wins (even `*/*`). Recorded: t1/t2 upstream show `Accept: */*` (curl's), not `text/event-stream`. |
| `Accept-Encoding` default | If the client sent none: `identity` for the always-streaming upstream on non-Anthropic base; otherwise caller's value verbatim. Recorded: `identity`. |
| `User-Agent` default | If the client sent none: `CLIProxyAPI/<version>`. Recorded: client's `curl/8.7.1` forwarded. |
| `Anthropic-Beta` | Caller's `Anthropic-Beta` header is preserved (merged with body-lifted `betas`, which Chat clients never send). Managed-beta stripping (e.g. effort beta removed when `thinking.type=disabled` or model contains `haiku`) applies only to the CLI-profile path; unknown caller betas pass through. Evidence: lines 933–1059. |
| Credential `headers` map | `claude-api-key[].headers` entries are applied last, but on streaming requests to a non-Anthropic base the transport negotiation is then RESTORED, so a configured `Accept`/`Accept-Encoding` override does not survive on this direction. Evidence: lines 1089–1105, 1220–1233. |
| NOT set in caller-owned mode | `Connection: keep-alive`, `X-App`, `X-Stainless-*`, `X-Claude-Code-Session-Id`, `x-client-request-id` (fresh UUID), `Anthropic-Dangerous-Direct-Browser-Access` — those exist only in the CLI-identity path (lines 1109–1202), which requires OAuth or `fingerprint-profile: claude-code-cli` (DEFERRED). Recorded absence in t1/t2. |
| Secrets | The mock redacts `Authorization` in wire logs; the contract asserts the header name + `Bearer ` prefix only. |

### 2.4 Upstream body — request translation

Translator: `ConvertOpenAIRequestToClaude` in `internal/translator/claude/openai/chat-completions/claude_openai_request.go`, registered `(from=OpenAI, to=Claude)` in `init.go`, invoked by the executor via `helps.TranslateRequestWithAPIKeyModelCompatibility` (`internal/runtime/executor/helps/codex_multi_agent_v2.go`); the executor then rewrites `model` to the upstream (alias-target) name via `SetStringIfDifferent` (`claude_executor_execute.go`). Recorded: client asks for alias `cm`, upstream body carries `claude-mock-model`.

**Baseline body** (field order is pinned; the initial template is `{"model":"","max_tokens":32000,"messages":[],"metadata":{}}` and sjson appends new keys in code order):

```
{"model":<upstream model>,"max_tokens":<n>,"messages":[...],"metadata":{"user_id":<id>},"stream":true}
```

Key order with optional fields present: `model`, `max_tokens`, `messages`, `metadata`, `thinking`(+`output_config`), `top_p`(deleted later — see §2.5), `stop_sequences`, `stream`, `system`, `tools`, `tool_choice`. Recorded: t1/t2 bodies have exactly `model,max_tokens,messages,metadata,stream`. Byte-exactness (minus dynamic fields) is contract material.

Field-by-field semantics (client → upstream):

| Client field | Upstream result |
|---|---|
| `model` | Routed alias; upstream body carries the **alias-target name** (`models[].name`), not the alias the client sent. Evidence: `claude_executor_execute.go` `upstreamModel(baseModel)` + `SetStringIfDifferent`; recorded. |
| `max_tokens` / `max_completion_tokens` | First present wins (checked `max_tokens` first). Written into upstream `max_tokens`; if neither is sent the template default **32000** stays. `max_tokens` is therefore ALWAYS present on the wire. Evidence: translator `firstExisting` + template; recorded `max_tokens:32000` with no client value. |
| `messages` | Translated per-message (table below), then **consecutive same-role merging** (`internal/translator/common/claude_messages.go` `ClaudeMessageAccumulator`): consecutive `user` (incl. converted tool results) or `assistant` turns merge into ONE upstream message whose content is the concatenation; within a merged `assistant` turn, `tool_use` blocks are moved AFTER the text blocks. A message whose translated content array ends up empty is dropped entirely (accumulator skips 0-part messages). |
| `messages[].role=system` or `developer` | NOT a message; content becomes top-level `system` blocks (`{"type":"text","text":...}`), in order of appearance. String content and array-of-text parts both supported; non-text parts in a system message are silently dropped. Evidence: translator `case "system","developer"`. |
| `messages[].role=user/assistant`, string content | One `{"type":"text","text":...}` block. Empty string `""` → no block. |
| `messages[].content[]` parts | `type:"text"` → text block; `type:"image_url"` with `data:` URL → `{"type":"image","source":{"type":"base64","media_type":<mime from URL>,"data":<b64>}}` (missing mime → `application/octet-stream`); `image_url` with http(s) URL → `{"type":"image","source":{"type":"url","url":<url>}}`; `type:"file"` with `file.file_data` data-URL → `{"type":"document","source":{"type":"base64","media_type":...,"data":...}}`. Any other part type (e.g. `audio`, unknown) is silently dropped. Evidence: `convertOpenAIContentPartToClaudePart`, `convertOpenAIImageURLToClaudePart`. |
| `messages[].reasoning_content` (assistant), DEFAULT | **Silently dropped**: assistant reasoning history never reaches the Claude wire for non-compat models (the translator only reads it in the compat variant below). Evidence: `claude_openai_request.go` user/assistant branch (`preserveEmptyThinkingBlocks` gate). |
| `messages[].reasoning_content` (assistant), `models[].is-compat: true` | The compat translator runs instead (`ConvertOpenAIRequestToClaudeWithCompat`): a non-empty assistant `reasoning_content` string becomes a LEADING unsigned `{"type":"thinking","thinking":<content>,"signature":""}` block in that assistant message's content array (before text/tool_use blocks); the thinking-summary config is then applied to the translated body (`ApplySummaryConfigForModel`). Config-gated per model entry; signature-preserving sanitize keeps the unsigned block on the wire. Evidence: `claude_openai_request.go` `ConvertOpenAIRequestToClaudeWithCompat` + `preserveEmptyThinkingBlocks` param; `internal/runtime/executor/helps/codex_multi_agent_v2.go` is-compat dispatch; `helps/model_capabilities.go` `APIKeyModelIsCompat`; `internal/runtime/executor/claude_executor.go` `sanitizeClaudeMessagesForClaudeUpstreamWithDebug` preserve flag; `internal/config/config_types.go` `ClaudeModel.IsCompat`. Golden: case 19. |
| `messages[].tool_calls` (assistant) | Each `type:"function"` call → `{"type":"tool_use","id":<id>,"name":<name>,"input":<object>}` appended after text blocks. Missing `id` → generated (dynamic; avoid). `id` is sanitized: chars outside `[a-zA-Z0-9_-]` → `_` (`internal/util/claude_tool_id.go` `SanitizeClaudeToolID`). `arguments` must be a JSON object string; non-object/invalid/absent → `"input":{}`. Evidence: translator tool-call branch. |
| `messages[].role=tool` | Becomes a `user` message `{"role":"user","content":[{"type":"tool_result","tool_use_id":<sanitized id>,"content":<c>}]}`. `content` string → string content; array → array of converted parts (string entries → text blocks); object → converted part. Repeated `tool` messages with the same `tool_call_id`: only the first position emits, with content taken from the LAST message carrying that id. Evidence: translator `case "tool"`. |
| `system`-only input (no user/assistant messages) | A synthetic `user` message `[{"type":"text","text":""}]` is appended so the upstream body keeps a conversational turn. Evidence: translator end-of-translation branch. |
| `tools[]` | Only `type:"function"` entries. → `{"name":...,"description":...,"input_schema":<normalized>}`. `parameters` (or `parametersJsonSchema`) is normalized by `NormalizeClaudeToolInputSchema` (`internal/util/claude_schema.go`): root forced to `"type":"object"`, `properties` ensured, root-level `anyOf`/`oneOf`/`allOf` flattened into properties, and the object is re-serialized with **lexicographic key order**. Missing parameters → absent `input_schema`. Evidence: translator tools branch. |
| `tool_choice` | `"none"` → omitted (tools still sent); `"auto"` → `{"type":"auto"}`; `"required"` → `{"type":"any"}`; `{"type":"function","function":{"name":N}}` → `{"type":"tool","name":N}`. Other values → omitted. Evidence: translator tool_choice branch. |
| `stop` | Array (non-empty) → `stop_sequences` array; single string → one-element array — **including the empty string** (`stop: ""` → `stop_sequences: [""]`, not omitted); empty array → omitted. Evidence: translator stop branch (string branch has no emptiness check; the array branch requires >0 items). |
| `top_p` | Written by the translator, then **DELETED by the executor** (§2.5) — never reaches the wire for this direction. |
| `temperature` | Never reaches the wire (no translator mapping; deleted in §2.5). |
| `reasoning_effort` | See §2.6. |
| `response_format` | `type:"json_object"` or `json_schema` → an extra system text block is APPENDED at the end of the system blocks with a fixed instruction string (json_object: fixed sentence; json_schema: `Schema Name`/`Schema Description` lines + raw `schema` JSON + closing sentence). Other/absent → nothing. Evidence: `internal/translator/common/claude_system.go` `BuildClaudeStructuredOutputInstruction`. |
| `user` (string) | Used verbatim as `metadata.user_id` (no hashing). |
| `metadata.user_id` (if a client sends it) | Passed through verbatim. |
| `prompt_cache_key` | Seeds `metadata.user_id` (see below) — NOT forwarded as a body field. |
| `metadata.user_id` derivation | Priority: caller `metadata.user_id` → caller `user` → hash. Hash seed: `prompt_cache_key:<v>` → else `session_id|sessionId` → else conversation ids → else `content:<first user-message text (parts joined with \n)>` → else `model:<model>[;instructions:...][;system variants]` → else literal `"unknown"`. Seed → `sha256` hex (64 chars). Evidence: `internal/translator/common/claude_user_id.go` `DeriveClaudeUserID`. Recorded: t1 `metadata.user_id = 120226d8c5cb... = sha256("content:Say hello")` — deterministic and recomputable in tests. |
| Dropped silently | `n`, `stream_options`, `logprobs`, `seed`, `frequency_penalty`, `presence_penalty`, `parallel_tool_calls`, `service_tier`, `store`, `prediction`, `verbosity`, `functions`/`function_call` (legacy), client `cache_control` passthrough rules below, `modalities`, unknown fields. No error is raised. |
| `cache_control` passthrough | A part-level `cache_control` object is copied verbatim onto the translated block; a message-level `cache_control` is applied to the LAST content block of that message (part-level wins there); for tools, `cache_control` on the tool entry or its `function` is copied. Evidence: `internal/translator/common/cache_control.go`. |

### 2.5 Executor post-processing (wire-visible order)

Applied to the translated body in this order (evidence: `claude_executor_execute.go` / `claude_executor_stream.go`):

1. Model rewrite to alias-target (`SetStringIfDifferent`).
2. Thinking application — for capability-less api-key models this STRIPS the translator's `thinking`/`output_config.effort` entirely (§2.6, recorded).
3. Cloaking — OFF by default for plain `claude-api-key` credentials with unconfirmed clients (`resolveClaudeWirePolicy`: `auto` cloaks only OAuth/explicit opt-ins). Recorded: no system-prompt injection in t1/t2.
4. `ensureModelMaxTokens` — no-op here (`max_tokens` always present).
5. `disableThinkingIfToolChoiceForced` — if `tool_choice.type` is `any` or `tool`, `thinking` and `output_config.effort` are deleted (Anthropic constraint). Evidence: `claude_executor_request.go` lines 587–604.
6. `normalizeClaudeSamplingForUpstream(body, nativeOwned=false)` — **`temperature`, `top_p` are ALWAYS deleted** (and `top_k` when thinking is active) for translated callers. Evidence: lines 606–652. **Hard pin: sampling knobs never reach the Claude wire from a Chat Completions client.**
7. `ensureCacheControl` — when the payload contains ZERO `cache_control` markers (always true for stock Chat clients): inject default `{"type":"ephemeral"}` breakpoints — on the LAST non-`defer_loading` tool (only when there is no cacheable system), on the LAST system block (string system is promoted to a one-element array), and on the LAST content block of the LAST eligible user/assistant message (assistant turns ending in a thinking-like block are skipped; string content is promoted). Evidence: `claude_executor_cloaking.go` `ensureCacheControl` + inject helpers (lines 1505–1512, 1964–2167). Recorded: t1/t2 user text block carries `"cache_control":{"type":"ephemeral"}`.
8. `enforceCacheControlLimit(body, 4)` — if more than 4 breakpoints exist, drop markers from non-last entries per section (system, then tools, then messages), keeping each section's last. Evidence: lines 1785+.
9. `stream` forced to `true` (§2.2).
10. `betas` body key → `Anthropic-Beta` header merge (§2.3) — Chat clients never send it.

### 2.6 `reasoning_effort` → thinking config — and the capability strip (recorded)

**Recorded hard pin (case 8)**: for a stock `claude-api-key` model entry whose upstream name is unknown to the model catalog and which configures no `thinking` block, `reasoning_effort` has **NO wire effect** — `high`, `none` and `auto` all produce upstream bodies with NO `thinking` key at all. The mechanism is two-stage:

1. **Translator stage** (`claude_openai_request.go` effort branch): `reasoning_effort` (non-empty, lowercased, trimmed) is converted — budget style for models without registry thinking levels (`none`→`{"thinking":{"type":"disabled"}}`; `auto`→`{"thinking":{"type":"enabled"}}`; `minimal`→512, `low`→1024, `medium`→8192, `high`→24576, `xhigh`→32768, `max`→128000 as `{"thinking":{"type":"enabled","budget_tokens":N}}` via `internal/thinking/convert.go` `ConvertLevelToBudget`), adaptive style (`thinking.type=adaptive` + `output_config.effort`) for level-capable registry models.
2. **Executor capability stage** (`claude_executor_execute.go` → `helps.ApplyRequestThinking` → `internal/thinking/apply.go`): the selected api-key model's capability snapshot is resolved via `modelconfig.ResolveModelInfo(<upstream name>, "claude", <configured models[].thinking block>)` (`internal/modelconfig/model_info.go` — static catalog lookup; the snapshot is explicitly marked NOT user-defined; bound to the request by `sdk/cliproxy/auth/api_key_model_capabilities.go`). If the resolved capability has `Thinking == nil` — the default for unknown names with no `thinking` config — `StripThinkingConfig(body, "claude")` (`internal/thinking/strip.go`) **deletes `thinking` and `output_config.effort` from the body**. Only when the model entry configures `models[].thinking` or the upstream name matches a catalog model with thinking metadata does the thinking config survive (then validated/normalized: budget clamp to `max_tokens-1`, level→effort mapping for level-capable models — `internal/thinking/provider/claude/apply.go`).

Consequence for the contract: Chat clients get thinking on the Claude wire ONLY when the operator declares the capability on the model entry (or the upstream name is catalog-known with thinking metadata). Both sides are now RECORDED: the strip is case 8; the surviving variant is case 20 (`models[].thinking` blocks) — budget-capable `{min:1024,max:32000}` + `reasoning_effort:"high"` → `thinking {"type":"enabled","budget_tokens":24576,"display":"summarized"}` (no clamp, budget in range); level-capable `levels:["low","medium","high","max"]` + `high` → `thinking {"type":"adaptive","display":"summarized"}` + `output_config {"effort":"high"}`; `none` → `thinking {"type":"disabled"}` (no `display` — a fully-disabled config skips the summary re-application). Note the recorded `display:"summarized"` on every ACTIVE thinking object: the thinking-summary config is applied after the effort applier (`internal/thinking/apply.go` `applySummaryConfigForProvider`).

## 3. Schemas — response mapping

### 3.1 Non-stream client (`chat.completion`)

`ConvertClaudeResponseToOpenAINonStream` parses the **aggregated upstream SSE buffer** (it scans lines with a `data:` prefix; the upstream is always streamed, §2.2). Baseline template and key order:

```
{"id":"","object":"chat.completion","created":0,"model":"","choices":[{"index":0,"message":{"role":"assistant","content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0}}
```

| Upstream (SSE events in the buffer) | Downstream field |
|---|---|
| `message_start.message.id` | `id` (kept as upstream id; NOT rewritten to the client alias). Recorded: `msg_mock_01`. |
| `message_start.message.model` | `model` — the **upstream model name** (no rewrite back to the alias; `restoreResponseModel` is a no-op for the Claude executor). Recorded: `claude-mock-model` while the client asked for `cm`. |
| `message_start` arrival time | `created` = gateway server epoch (dynamic; masked in fixtures). If no `message_start` is present the template `0` stays (and `id`/`model` stay empty). |
| `content_block_delta.text_delta.text` (any order) | concatenated (no separator) into `choices[0].message.content`; empty string when no text deltas. |
| `content_block_delta.thinking_delta.thinking` | concatenated into `choices[0].message.reasoning_content` (field present only if any thinking delta was seen; appended after `content`). |
| `content_block_start` `tool_use` + `input_json_delta.partial_json` + `content_block_stop` | `choices[0].message.tool_calls[i]` = `{"id":<block id>,"type":"function","function":{"name":<name>,"arguments":<accumulated>}}`, enumerated in increasing upstream block index; `arguments` defaults to `"{}"` when nothing accumulated. Presence of ≥1 tool call forces `finish_reason:"tool_calls"`. |
| `message_delta.delta.stop_reason` | `finish_reason` — mapped per §3.3; template default `"stop"`; a mapped value equal to `"stop"` does not rewrite (same result). |
| usage (see §3.4) | `usage` overwritten only if any usage was seen (`message_start` or `message_delta`); otherwise the template zeros stay. |

Recorded proof: t1 — `{"id":"msg_mock_01","object":"chat.completion","created":<epoch>,"model":"claude-mock-model","choices":[{"index":0,"message":{"role":"assistant","content":"Hello from mock claude upstream more"},"finish_reason":"stop"}],"usage":{"prompt_tokens":9,"completion_tokens":6,"total_tokens":15,"prompt_tokens_details":{"cached_tokens":0,"cached_creation_tokens":0,"cache_write_tokens":0}}}`.

### 3.2 Stream client (`chat.completion.chunk`)

`ConvertClaudeResponseToOpenAI` is invoked **per upstream SSE line** (`claude_executor_stream.go` TranslateStream loop), with persistent per-request state (`ConvertAnthropicResponseToOpenAIParams`). Only lines starting with `data:` produce output (0, 1 or rarely 2 chunks). Upstream `event:` lines and `ping` events produce NO output. Chunk template and key order:

```
{"id":"","object":"chat.completion.chunk","created":0,"model":"","choices":[{"index":0,"delta":{},"finish_reason":null}]}
```

| Upstream event | Downstream output (each becomes one `data: <json>` line, §4) |
|---|---|
| `message_start` | One chunk: `id` = `message.id`, `created` = server epoch (state), `model` = the routed upstream model name passed by the executor (`req.Model` = the alias-target `models[].name`, NOT the client alias; recorded: `claude-mock-model`), `choices[0].delta = {"role":"assistant"}`, `finish_reason:null`. Also seeds usage from `message.usage`. |
| `content_block_start` (any type) | No output. `tool_use` starts register an accumulator keyed by upstream block index and assigns a sequential tool-call index (0,1,…). |
| `content_block_delta` `text_delta` | One chunk with `choices[0].delta.content = <text>`. |
| `content_block_delta` `thinking_delta` | One chunk with `choices[0].delta.reasoning_content = <thinking>`. |
| `content_block_delta` `input_json_delta` | No output; `partial_json` accumulated into the tool-call accumulator. |
| `content_block_delta` other (e.g. `signature_delta`) | No output (silently ignored). |
| `content_block_stop` | No output UNLESS the block index is a registered `tool_use`: then one chunk with `choices[0].delta.tool_calls[0] = {"index":<sequential>,"id":<id>,"type":"function","function":{"name":<name>,"arguments":<accumulated or "{}">}}`. |
| `message_delta` | Always one chunk: `finish_reason` = mapped `delta.stop_reason` (absent → stays `null`); if `usage` present it is merged and `usage` is attached to THIS chunk (after `choices`). |
| `message_stop` | One **trailing usage chunk** `{"id":...,"object":"chat.completion.chunk","created":...,"model":...,"choices":[],"usage":{...}}` — emitted once, only if usage was ever tracked. Emits nothing if usage was never seen or the trailing chunk was already sent. |
| `ping` | No output. |
| `error` (SSE event with 200 status) | One chunk `{"error":{"message":<error.message>,"type":<error.type>}}` — note: **no `code` field**. Translation continues with subsequent events. |
| any other type | No output. |

Recorded proof: t2 shows the exact 6-line downstream stream: role chunk → 2 content chunks → finish chunk (`delta:{}`, `finish_reason:"stop"`, usage) → trailing usage chunk (`choices:[]`) → `[DONE]`.

### 3.3 `stop_reason` → `finish_reason` map

Evidence: `claude_openai_response.go` `mapAnthropicStopReasonToOpenAI`.

| Anthropic `stop_reason` | OpenAI `finish_reason` |
|---|---|
| `end_turn` | `stop` |
| `tool_use` | `tool_calls` |
| `max_tokens` | `length` |
| `stop_sequence` | `stop` |
| `refusal`, `sensitive` | `content_filter` |
| anything else (incl. absent) | `stop` (stream: stays `null` until a `message_delta` carries a stop_reason) |

### 3.4 Usage arithmetic

Evidence: `claudeUsageTokens.Merge` + `OpenAIUsage` in `claude_openai_response.go`. Fields merged from BOTH `message_start.message.usage` and `message_delta.usage` (absolute overwrite, not additive; `message_delta` wins for overlapping fields).

| Downstream field | Formula |
|---|---|
| `usage.prompt_tokens` | `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` |
| `usage.completion_tokens` | `output_tokens` |
| `usage.total_tokens` | `prompt_tokens + completion_tokens` |
| `usage.prompt_tokens_details.cached_tokens` | `cache_read_input_tokens` |
| `usage.prompt_tokens_details.cached_creation_tokens` | `cache_creation_input_tokens` |
| `usage.prompt_tokens_details.cache_write_tokens` | `cache_creation_input_tokens` (same value as `cached_creation_tokens` — both fields are emitted) |
| No usage seen (non-stream) | template zeros `{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0}` with NO `prompt_tokens_details` |
| No usage seen (stream) | no usage fields anywhere; no trailing usage chunk |

Recorded proof: t1/t2 usage blocks; `prompt_tokens_details` key order is `cached_tokens, cached_creation_tokens, cache_write_tokens` (sjson set order).

### 3.5 Downstream response headers

- Non-stream: `Content-Type: application/json` + the global CORS block + `X-Cpa-Trace-Id` (S1 §2). Recorded: t1.
- Stream: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`, `Access-Control-Allow-Origin: *` + global CORS + trace id. Recorded: t2.
- Filtered upstream headers (no hop-by-hop, no gateway-proxy prefixes `x-litellm-`/`helicone-`/`x-portkey-`/`cf-aig-`/`x-kong-`/`x-bt-`, no CPA-reserved CORS keys, no `Content-Length`/`Content-Encoding`) are added without overwriting gateway-set headers. Evidence: `sdk/api/handlers/header_filter.go`. The canned mock sends none, so fixtures show only gateway headers.
- The downstream `Connection` header mirrors the client's transport negotiation (recorded: `close` against a `Connection: close` client); the gateway does not pin a value — assert it only as a mirror of the request, or not at all.

## 4. Streaming rules (downstream SSE)

Evidence: `openai_handlers.go` `handleStreamingResponse`/`handleStreamResult`, `sdk/api/handlers/stream_forwarder.go` `ForwardStream`. Recorded: t2.

Per **Ruling R-SSE** (SPEC §5): the gateway re-chunks SSE transport frames nondeterministically between runs. Every stream requirement in this section is a DECODED-EVENT-SEQUENCE requirement: contract tests compare the decoded SSE frames (`data:` payload bytes, in order, plus the terminal `[DONE]`), never raw TCP/chunk boundaries; the volatility whitelist (§7.1 dynamic fields) still applies.

1. **Commit rule**: the gateway waits for the first translated chunk BEFORE sending SSE headers. If the upstream fails first (non-2xx status, connect error, validation error), the client gets a normal HTTP status + JSON error body (Content-Type `application/json`), NOT an SSE stream. Recorded pattern per gemini m1; same code path.
2. **Framing**: each translated chunk is sent as `data: <chunk JSON>\n\n` followed by a flush.
3. **Termination (success)**: `data: [DONE]\n\n` after the upstream channel closes cleanly.
4. **Termination (mid-stream terminal error)**: ONE in-stream `data: {"error":{...}}\n\n` chunk (§5.2), then the stream ENDS — **no `[DONE]` is written after an in-stream error**. HTTP status stays 200.
5. **Order**: chunks are emitted strictly in upstream event order; the translation is synchronous per line.
6. **Event names**: upstream SSE `event:` lines are never forwarded; downstream frames contain ONLY `data:` lines (+ the final `[DONE]`).
7. **Keep-alives**: SSE comment heartbeats (`: keep-alive\n\n`) only when `streaming.keep-alive-seconds` > 0 (default 0 = off); not in fixtures.
8. **Upstream `data: [DONE]`** (if a Claude-compatible upstream ever sent one) parses as a JSON-less chunk and produces no output; the downstream `[DONE]` is gateway-generated.
9. **Empty stream (recorded — corrected round 1)**: if the upstream (HTTP 200) closes without producing ANY translatable chunk, the stream **bootstrap gate fails BEFORE any SSE header is committed** and the client receives a plain JSON error: HTTP 500 `{"error":{"message":"empty_stream: upstream stream closed before first payload","type":"server_error","code":"internal_server_error"}}` — no SSE headers, no `data:` frame, no `[DONE]`. A `ping` event does NOT count as a first payload (both the zero-event and the ping-only variants produced the identical 500). Evidence: `sdk/cliproxy/auth/conductor_stream.go` (stream bootstrap; `Error{Code:"empty_stream", Message:"upstream stream closed before first payload", Retryable:true}` — retryable, so `request-retry > 0` attempts another credential before failing). Recorded: case 24 steps 1–2.

## 5. Error semantics

### 5.1 Upstream non-2xx status (pre-first-chunk, both client modes)

`classifyClaudeUpstreamError(status, headers, body)` → `statusErr{code: status, msg: <verbatim body>}` (`claude_executor_request.go` lines 497–514; 429 additionally wraps as `claudeRateLimitError` for scheduling). The handler writes it via `WriteErrorResponse` (`sdk/api/handlers/handlers_errors.go`):

| Condition | Downstream result |
|---|---|
| Upstream body is valid JSON (trimmed, non-empty) | **Status + body passed through VERBATIM** (same bytes). Recorded for the 429 claude-shaped error body; wire-note hard pin ("upstream 429 body+status passes downstream VERBATIM"). |
| Upstream body not valid JSON / empty | Wrapped: `{"error":{"message":<body-or-status-text>,"type":<T>,"code":<C>}}` with `T`/`C` per status: 401→`authentication_error`/`invalid_api_key`; 403→`permission_error`/`insufficient_quota`; 429→`rate_limit_error`/`rate_limit_exceeded`; 404→`invalid_request_error`/`model_not_found`; ≥500→`server_error`/`internal_server_error`; other (e.g. 400)→`invalid_request_error` with `code` omitted. Status = upstream status. Evidence: `sdk/api/handlers/handlers.go` `BuildErrorResponseBodyWithError`. |
| Status preservation | Downstream HTTP status = upstream status (via `internal/clienterror.HTTPStatusFromError`, `StatusCode()` on statusErr). |
| `Retry-After` | Forwarded downstream when the classified error carries one (429 with anthropic rate-limit reset headers); not exercised by the canned mock. |

### 5.2 Transport/stream failures

| Failure | Client mode | Downstream result |
|---|---|---|
| Upstream disconnects mid-SSE (no chunked terminator) | stream | HTTP 200 (already committed), translated chunks so far, then ONE in-stream `data: {"error":{"message":"unexpected EOF","type":"server_error","code":"internal_server_error"}}\n\n`, no `[DONE]`. Wire-note hard pin (recorded for the mock fleet via gemini m3; identical code path for claude). |
| Same | non-stream | `io.ReadAll` fails → error has no status → 500 `{"error":{"message":"unexpected EOF","type":"server_error","code":"internal_server_error"}}` (JSON body, `Content-Type: application/json`). Evidence: `claude_executor_execute.go` read + `handlers_execution.go` `executionErrorMessage` (status defaults 500) + `BuildErrorResponseBodyWithError`. |
| Upstream 200 + SSE `error` event mid-buffer | stream | In-stream `data: {"error":{"message":...,"type":...}}` chunk (no `code`), translation continues; if the stream then closes cleanly the gateway still writes `data: [DONE]`. |
| Same | non-stream | **502** (aggregation validation, §5.3): `{"error":{"message":"claude executor: upstream returned error event: <message>","type":"server_error","code":"internal_server_error"}}`. |
| Slow upstream | either | pass-through timing only; no buffering beyond the line scanner (fixture asserts order, not timing). |

### 5.3 Aggregation validation (non-stream clients only)

Before translating the aggregated buffer, `validateClaudeStreamingResponse` (`claude_executor_stream.go`) requires: ≥1 `data:` line with valid JSON, a `message_start` carrying non-empty `message.id` AND `message.model`, and ≥1 `message_delta`. Violations → 502 with one of these exact messages (wrapped per §5.1): `claude executor: upstream returned malformed stream data` / `upstream returned empty stream response` / `upstream stream message_start is missing id or model` / `upstream stream response is missing message_start` / `upstream stream response ended before message completion` / `upstream returned error event: <msg>` — where `<msg>` is the event's `error.message`, else its `error.type`, else the literal `unknown upstream error` (three-step fallback, evidence: `validateClaudeStreamingResponse`). The six messages are pinned individually by cases 16 (step 2) and 25 (follow-up batch). The STREAM path performs none of these checks.

### 5.4 429 → credential cooldown interaction (scheduling boundary, pinned here)

An upstream 429 puts the credential into a ~1s rate-limit cooldown that `transient-error-cooldown-seconds: -1` does NOT disable (wire-note hard pin). The NEXT request for the same model (any mode) fails with **HTTP 429**, a `Retry-After: 1` response header, and the model-cooldown envelope (recorded, case 14 step 2, byte-exact):

```
{"error":{"code":"model_cooldown","last_upstream_error":"<verbatim upstream 429 body>","message":"All credentials for model cm are cooling down via provider claude (last error: <verbatim upstream 429 body>)","model":"cm","provider":"claude","reset_seconds":1,"reset_time":"1s"}}
```

The envelope carries `model`, `provider`, `reset_seconds` and `reset_time` beyond the fields the fleet wire note names; `reset_seconds`/`reset_time` are timing-derived (for the scripted 429 with NO upstream reset header, assert the literals `1`/`"1s"` — case 14). When the upstream 429 CARRIES reset information (`Retry-After` or `Anthropic-Ratelimit-Unified-*` headers), the cooldown `Retry-After` is the parsed reset PLUS a bounded random grace (1–30s, `internal/runtime/executor/helps/claude_ratelimit.go` `parseClaudeRateLimitResetWithFuzz`) — recorded: upstream `Retry-After: 1` → cooldown `Retry-After: 27` (case 26 step 2; value masked as dynamic). The DIRECT verbatim-429 response carries NO `Retry-After` header at all: `statusErr`/`claudeRateLimitError` expose no response headers and `coreauth.SafeResponseHeaders` materializes `Retry-After` only for cooldown/home errors (recorded absent, case 26 step 1; `sdk/cliproxy/auth/home_concurrency.go`). Cross-recorded consistency: rate-limit cooldowns surface as 429 `model_cooldown` (also seen on the antigravity direction, S2d10), while transient-error cooldowns surface as 503 `auth_unavailable` (S6-16 case family). Scheduling semantics are S4; the golden pins the claude-direction occurrence only.

### 5.5 Client-side/gateway errors before upstream

Unknown model with no provider → 400 `{"error":{"message":"unknown provider for model <m>","type":"invalid_request_error","code":"model_not_found","param":"model"}}`; auth 401s; 404s per R-404 — all owned by S1; not re-specified here.

## 6. Identity/compatibility notes specific to this direction

- The response `model` field keeps the UPSTREAM model name (alias is NOT restored) — matches the fleet-wide rule "response `model` keeps the upstream name unless force-mapping". Recorded: t1/t2 `claude-mock-model` while the client asked for `cm`.
- Where the two modes take it from differs: stream chunks carry the model name the gateway requested (executor `req.Model`, i.e. the alias-target name), non-stream carries the name the upstream REPORTS in `message_start.message.model`. With an echo-mock they coincide; a mock that reports a different model name would split them. Fixtures pin both.
- `stream_options.include_usage` from the client is ignored: the trailing usage chunk + usage-on-finish-chunk behavior is unconditional for this direction (differs from native OpenAI semantics — intentional non-equivalence).
- Client `temperature`/`top_p` never reach the wire (§2.5.6) — intentional non-equivalence.
- The upstream `Accept` header is the caller's (`*/*` from curl) even though the upstream is SSE — the gateway does not force `Accept: text/event-stream` when the client sent any `Accept` (recorded t1/t2).
- `reasoning_effort` is a silent no-op on the wire for stock `claude-api-key` models (§2.6) — clients cannot tell; flagged as intentional non-equivalence.

## 7. Golden samples

### 7.1 Recording setup (oracle)

Reference binary: docker `eceasy/cli-proxy-api:v7.3.4` with `_cpa_edge_ref/run/config.yaml` (port 18317, api-key `oracle-local-key-1`, `request-retry: 0`, `transient-error-cooldown-seconds: -1`); claude mock `python3 _cpa_edge_ref/mock/mock_claude.py 19002` (config entry: `claude-api-key` → `http://host.docker.internal:19002`, api-key `mock-claude-key`, model `claude-mock-model`, alias `cm`). Mode selection via the mock CONTROL FILE `mock/control/claude.json` ONLY — `X-Mock-*` headers are NOT forwarded to a claude upstream (§2.3 forward list) and must not be used for this direction. Cases file: `spec/recordings/S2d3.cases.json`; fixtures: `tests/fixtures/S2d3/<case-id>/` per the RECIPES layout (`meta.yaml`, `request.http`, `downstream.md`, `upstream.jsonl`, `mock-response.json`).

Dynamic fields (mask in fixtures; listed per case): `Date`, `X-Cpa-Trace-Id`, downstream `created` (server epoch), `X-Cpa-*`/version headers on management routes (n/a here), mock port numbers in upstream.jsonl, and any `reset_time` inside the cooldown envelope.

### 7.2 Golden-sample index (26 cases — all recorded)

(All 26 rows are RECORDED fixtures under `tests/fixtures/S2d3/<case-id>/`; rows 19–26 are the round-1 follow-up batch.)

| # | Case id | Pins | Mock mode/script |
|---|---|---|---|
| 1 | `s2d3-baseline-nonstream` | minimal request → upstream body order/defaults (`max_tokens:32000`, `metadata.user_id` sha256, `cache_control` ephemeral, `stream:true` always, `?beta=true` path, header set) + downstream `chat.completion` mapping | happy text |
| 2 | `s2d3-baseline-stream` | 6-line SSE chunk sequence, `[DONE]`, SSE headers, `event:` stripping | happy text |
| 3 | `s2d3-headers-variants` | no-UA fallback (`CLIProxyAPI/v7.3.4`), caller `Anthropic-Beta`/`Anthropic-Version` passthrough | happy text |
| 4 | `s2d3-params-system` | system→`system[]`, `temperature`/`top_p` deletion, `max_tokens` override, `stop` array + string forms, `stop_sequences` order | happy text |
| 5 | `s2d3-multimodal-image` | data-URL image → base64 source block; http URL image → url source block; part passthrough | happy text |
| 6 | `s2d3-tools-roundtrip` | `tools`/`input_schema` normalization (key-sorted), `tool_choice:auto`, assistant `tool_calls`→`tool_use`, `tool` role→`tool_result` user msg + same-role merge, cache markers (tools+messages) | happy text |
| 7 | `s2d3-developer-respformat` | `developer` role → system blocks; `response_format` json_schema instruction block appended last; system cache marker on last system block | happy text |
| 8 | `s2d3-effort-thinking` | `reasoning_effort` high/none/auto → translated then STRIPPED by the capability check: NO `thinking` key on the wire (recorded) | happy text |
| 9 | `s2d3-userid-variants` | `user` field verbatim; `prompt_cache_key` seeding | happy text |
| 10 | `s2d3-res-tooluse-stream` | `tool_use` SSE → tool_calls delta chunk (index/id/name/args), arg accumulation, finish `tool_calls` | script `tool_use` |
| 11 | `s2d3-res-tooluse-nonstream` | aggregated `message.tool_calls` + `finish_reason:"tool_calls"`, content `""` | script `tool_use` |
| 12 | `s2d3-res-thinking` | `thinking_delta` → `reasoning_content` (stream delta + non-stream message field), `signature_delta` ignored | script `thinking` |
| 13 | `s2d3-res-stopreasons-usage` | `max_tokens`→`length`, `stop_sequence`→`stop`; usage arithmetic incl. cache tokens (`cached_tokens`/`cached_creation_tokens`/`cache_write_tokens`), double usage emission (finish chunk + trailing chunk) | script `stop_variant` |
| 14 | `s2d3-err-429-verbatim-cooldown` | claude-shaped 429 body+status VERBATIM; immediate follow-up → **429** + `Retry-After: 1` + `model_cooldown` envelope (recorded: status is 429, not 500) | error 429 |
| 15 | `s2d3-err-wrap-500-nonjson` | non-JSON upstream body → wrapped `server_error`/`internal_server_error` envelope, status preserved | error 500 (raw body) |
| 16 | `s2d3-err-instream-event` | in-stream `error` SSE event → `{"error":{message,type}}` chunk (stream) / 502 validation message (non-stream) | script `error_event` |
| 17 | `s2d3-disconnect` | hard close after 4 events → role+2 content chunks, in-stream `unexpected EOF` error frame, no `[DONE]` (stream) / 500 envelope (non-stream) | disconnect (after=4) |
| 18 | `s2d3-slow` | pass-through ordering under delayed events (assert order/framing only) | slow (delay 300ms) |
| 19 | `s2d3-iscompat-thinking-history` | RECORDED: `is-compat: true` → assistant `reasoning_content` becomes a LEADING unsigned `thinking` block (`{"type":"thinking","thinking":"Prior reasoning","signature":""}`) before the text block; rest of body unchanged | happy text (+config fragment) |
| 20 | `s2d3-thinking-config-survival` | RECORDED: budget-capable → `enabled`+`budget_tokens:24576`+`display:"summarized"`; level-capable → `adaptive`+`display:"summarized"`+`output_config.effort:"high"`; `none` → `disabled` (no display) | happy text (+config fragment) |
| 21 | `s2d3-fingerprint-cli-profile` | RECORDED (UUIDs masked): CLI identity headers + betas, cloaked body (billing header + persona system blocks, 1h TTL cache markers, `<system-reminder>` date block, `metadata.user_id` = JSON `{device_id,account_uuid,session_id}`) | happy text (+config fragment) |
| 22 | `s2d3-model-suffix` | RECORDED: `cm(4096)` ROUTES (200); suffix parsed+stripped; upstream model = alias target; suffix-derived thinking STRIPPED (no `thinking` key) | happy text |
| 23 | `s2d3-stream-429-commit` | RECORDED: stream client + 429-before-first-chunk → plain 429 JSON (`application/json`), verbatim body, no SSE headers, no `[DONE]` | error 429 |
| 24 | `s2d3-empty-stream` | RECORDED (deviation from pre-recording prediction): zero translatable `data:` lines → 500 `empty_stream: upstream stream closed before first payload` JSON, NO SSE (both empty and ping-only variants identical) | scripts `empty`/`ping_only` |
| 25 | `s2d3-malformed-validation` | RECORDED: all five §5.3 messages byte-exact as 502 `server_error`/`internal_server_error` wraps | scripts `bad_json`/`empty`/`no_start`/`start_no_id`/`no_delta` |
| 26 | `s2d3-retry-after` | RECORDED: direct verbatim 429 carries NO `Retry-After`; cooldown response carries fuzz-derived `Retry-After` (27 from upstream `Retry-After: 1`; masked) | error 429 + `retry_after` control key |

The exact per-case requests, scripted upstream replies and required control-file contents are in `spec/recordings/S2d3.cases.json`. Fixture paths: `tests/fixtures/S2d3/<case-id>/`.

**Recording status (2026-09-16)**: all 18 cases RECORDED by @oracle-runner-2 (18/18 fixture directories present, byte-exact transcripts). Recorded on the oracle's isolated stack (reference on 127.0.0.1:8387, claude mock on port 20002 — port/host values are listed as dynamic fields in each meta.yaml). The case-1 cross-stack anchor `metadata.user_id` = `120226d8c5cb...0e8b6c46` (sha256 of `content:Say hello`) held byte-exact, confirming the derivation is host/port-independent. Three recorded refinements over the pre-recording predictions: (1) §5.4 — the cooldown surfaces as HTTP 429 + `Retry-After: 1`, not 500 (round 1); (2) §2.6 — `reasoning_effort` is STRIPPED for stock api-key models (round 1); (3) §4 rule 9 — an empty upstream stream does NOT commit SSE + `[DONE]`: the bootstrap gate fails with 500 `empty_stream: upstream stream closed before first payload` (round-1 follow-up, case 24). Everything else matched prediction across both batches, including upstream body key order, sampling-knob deletion, cache-marker placement, tool-roundtrip merge, response_format instruction block, image part mapping, tool/thinking/stop-reason chunk mappings, usage arithmetic, in-stream error shapes, all error-path envelopes, the is-compat thinking-block prepend, thinking-config survival shapes, the CLI fingerprint wire, suffixed-alias routing, the stream-429 commit rule, the malformed-validation message set, and Retry-After presence/absence. **26/26 fixtures recorded.**

### 7.3 FIXTURE-DEFERRED (documented, not recordable locally — R-FIXTURE)

| Behavior | Why deferred | Evidence |
|---|---|---|
| `x-api-key` auth + default `https://api.anthropic.com` base-url | requires a real Anthropic API key; the `Bearer`-vs-`x-api-key` switch keys on the Anthropic host, unreachable with a local mock | `claude_executor_request.go` lines 904–915; `claude_executor.go` `PrepareRequest` |
| Claude OAuth credential behaviors: CLI betas assembly, `X-App`/`X-Stainless-*`/`x-client-request-id`/`X-Claude-Code-Session-Id` identity headers, CCH signing, diagnostics, context-management, MCP alias, thinking replay, cloaking (auto) | OAuth-only control plane; fixed vendor endpoints (CREDENTIALED-ONLY per R-FIXTURE). Error paths that ARE recordable still get goldens (cases 14–16) | `claude_fingerprint_policy.go`, `applyClaudeHeadersWithNativeProfile` lines 1109–1235, `claude_executor_cloaking.go` |
| **RECORDED (case 21, round-1 follow-up — DEFERRAL CLOSED for this direction):** `fingerprint-profile: claude-code-cli` on an api-key credential emits the CLI wire — see §2.3 for the recorded header/body set; dynamic fields (session UUIDs, date block) masked per the fixture meta. Still open elsewhere: the same profile on other client protocols (S2d4/S2d7/S2d8) and OAuth credentials — reuse this fixture as the executor-surface reference. | `claude_fingerprint_policy.go` `resolveClaudeFingerprintPolicy` |
| **RECORDED (case 20, round-1 follow-up — DEFERRAL CLOSED):** with `models[].thinking` configured the thinking config survives — `enabled`+budget / `adaptive`+`output_config.effort` / `disabled`, with `display:"summarized"` on active blocks (§2.6). The catalog-known-model-name variant (real Anthropic catalog names) remains unrecorded — needs a catalog model and a successful startup catalog fetch. | `internal/modelconfig/model_info.go` `ResolveModelInfo`; `internal/thinking/apply.go`; `internal/thinking/convert.go` `MapToClaudeEffort`; `internal/config/config_types.go` `ClaudeModel.Thinking` |
| **RECORDED (case 22, round-1 follow-up — DEFERRAL CLOSED):** `cm(4096)` routes; suffix parsed+stripped; suffix-derived thinking stripped by the capability check (§2.6 mechanism). | `internal/thinking/suffix.go` `ParseSuffix` |

## 8. Open questions and intentional non-equivalences

1. **Trailing usage chunk duplication**: the usage object is emitted twice for stream clients (on the `message_delta` chunk AND the `message_stop` trailing chunk with `choices:[]`). Native OpenAI emits trailing usage only with `stream_options.include_usage`. Recorded upstream behavior is normative; flagged as intentional non-equivalence.
2. **In-stream `error` events lack `code`** (translator shape `{"error":{"message","type"}}`), unlike the wrapped terminal errors which carry `code`. Kept as recorded.
3. **`n>1`**: multiple choices are unsupported; the request is not rejected, `n` is ignored, exactly one choice is produced. RULING (round-1 gate): MIRROR the silent drop — recorded behavior, no SPEC §5 registration.
4. **Legacy `functions`/`function_call` fields are silently dropped** — clients relying on them get no tools upstream. RULING (round-1 gate): MIRROR the silent drop — no registration.
5. **Unknown content parts (e.g. `audio`) are silently dropped** from user messages. RULING (round-1 gate): MIRROR the silent drop — no registration.
6. **Managed-beta stripping for caller betas** (`effort` beta removed when `thinking.type=disabled` or model contains `haiku`) applies a pinned CLI model list to caller-owned traffic; only the `effort` beta is affected in this mode. No golden; noted.
9. **`reasoning_effort` strip**: the recorded behavior silently drops reasoning effort for capability-less api-key models (§2.6). Should the rewrite mirror the strip exactly (compatibility, recommended) or log/warn? Mirroring is what the golden pins.
7. **`Accept-Encoding` override by credential `headers`** does not survive on streaming requests to non-Anthropic bases (§2.3). Operators may find this surprising; behavior kept as recorded.
8. **Suffixed model aliases** — RESOLVED (case 22): `cm(4096)` ROUTES to the claude provider (200); the suffix is parsed and stripped (`ParseSuffix`), the upstream body carries the alias-target model and the standard shape, and the suffix-derived thinking budget is STRIPPED by the same capability check as `reasoning_effort` (no `thinking` key on the wire). Suffixed aliases on api-key entries are accepted.
