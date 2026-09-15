# S4 — Credential scheduling (rotation, cooldown, retry, affinity)

Version: 1.0 (2026-09-16). Anchor: CLIProxyAPI v7.3.4, commit `8335eac731946bd4eff18f500653f93736df53d6`.
Upstream evidence paths are relative to the reference repo root (`_cpa_edge_ref/CLIProxyAPI`), MIT, read as a behavioral specification only. Recorded facts cite `reports/oracle/BOOTSTRAP.md` (BS) and raw probe transcripts (P).

## 1. Scope and boundaries

**In scope** — how the gateway chooses WHICH credential serves a request, and how failures change that choice:
- Credential selection strategies `round-robin` (default), `weighted-round-robin`, `fill-first` (`routing.strategy`), including rotation order, cursor state, and hot-reload effects.
- Weight and priority attributes per credential; zero-weight exclusion; weight validation (reject at config load).
- Failure classification and cooldown state machines: transient errors (408/500/502/503/504/520–526), quota (429), unauthorized (401/402/403), not-found (404), invalid_grant, model-not-supported, Cloudflare-challenge; per-model vs credential-wide (quota propagation) scoping; cooldown floor/backoff ladder; `transient-error-cooldown-seconds` (0 = legacy 60 s, negative = off); `disable-cooling` (global, per-provider, per-credential override); `save-cooldown-status` persistence.
- Same-request credential failover (round 0) and additional retry rounds (`request-retry`, per-credential override, `max-retry-credentials`, `max-retry-interval`, cooldown wait + jitter, round admission).
- Request-scoped error rules (`request-scoped-errors` per credential/provider, actions `stop` / `stop-and-cooldown` / `continue` / `continue-and-cooldown`) and the request-fault stop rule (no rotation on caller-attributed 4xx).
- Session affinity (`routing.session-affinity`, TTL, subagents): sticky binding, failover on bound-credential unavailability, bind/unbind on result.
- Intra-credential model-pool rotation and failover (one alias → several upstream model names).
- Cross-provider ("mixed") rotation when several provider families expose the same client model.
- Client-visible error payloads produced by scheduling: `auth_unavailable`/`auth_not_found` (503), `model_cooldown` (429 + `Retry-After`), terminal authentication error (503, `authentication_error`), and relay of the last upstream error when failover exhausts.
- Credential identity for observability: stable `auth_index` derivation and the surfaces that carry it.
- Streaming: which stream failures rotate (before first downstream byte) vs. are delivered in-stream, and bootstrap retries (`streaming.bootstrap-retries`).

**Out of scope** (owned elsewhere or deferred):
- Model name resolution, alias → upstream mapping tables, `prefix` routing (`S1`, `S2d*`); the scheduler only sees the resolved model. Prefix pinning is routing, not scheduling.
- Management API route inventory (`S5`) — S4 specifies only the scheduling-relevant payload fields (`auth-index`, `auth_index`, quota reset effects) that S5 endpoints expose.
- Wire translation and passthrough of upstream error bodies (`S2d*`) — S4 specifies only WHICH error is surfaced and its scheduling classification.
- Auth file schemas, `.cds` persistence file format details, usage queue payloads (`S6`).
- CPA "Home" mode (multi-instance scheduling owned by a central Home server; enabled only via the `-home-jwt` runtime flag — `internal/config/config.go:25-27`, `sdk/cliproxy/service_config.go` `forceHomeRuntimeConfig`). In Home mode local cooldown scheduling is disabled and selection is delegated; cpa-edge specs local mode only. OPTIONAL: a later section may spec the Home protocol.
- OAuth-only behaviors (token expiry tiering, refresh-on-unauthorized, invalid_grant, Antigravity credits fallback, Codex `usage_limit_reached` plan semantics): documented below with evidence and marked FIXTURE-DEFERRED in the golden index (R-FIXTURE).

## 2. Behavior inventory

### 2.1 Configuration surface (exact keys)

| Key | Type | Default | Meaning | Evidence |
|---|---|---|---|---|
| `routing.strategy` | string | `round-robin` | Selection strategy; accepted aliases `weighted-round-robin`/`weightedroundrobin`/`wrr` and `fill-first`/`fillfirst`/`ff`; any other value falls back to round-robin | `internal/config/config_types.go` (`RoutingConfig`), `sdk/cliproxy/service_config.go` (`normalizedRoutingRuntimeState`, `newRoutingSelector`) |
| `routing.session-affinity` | bool | `false` | Wrap the strategy selector with session-sticky routing | same |
| `routing.session-affinity-ttl` | duration string | `1h` | Binding retention; parsed with Go duration syntax, floored to 1 s when `0 < ttl < 1s` | same |
| `routing.session-affinity-subagents` | bool | `true` | Child sessions with a parent reference inherit the parent's credential; `false` distributes subagents via the fallback selector; ignored when session-affinity is off | same |
| `request-retry` | int | `0` | Additional credential retry rounds after round 0 exhausted all eligible credentials | `internal/config/config.go:82-84`, `internal/config/config_load.go` (zero default), `sdk/cliproxy/auth/conductor_lifecycle.go` (`SetRetryConfig`) |
| `max-retry-credentials` | int | `0` | Max distinct credentials tried per retry round; `<=0` = unlimited | `internal/config/config.go:85-88` |
| `max-retry-interval` | int (seconds) | `0` | Max positive cooldown wait between rounds; `<=0` = never wait for cooldown (immediate rounds still allowed) | `internal/config/config.go:89-92`, `conductor_selection.go` (`shouldRetryAfterErrorWithAttempted`) |
| `transient-error-cooldown-seconds` | int | `0` | Cooldown for transient upstream errors (408/500/502/503/504/520–526). `0` = legacy 60 s. Negative disables transient-error cooldowns ONLY (quota/429 cooldowns unaffected) | `internal/config/config.go:74-76`, `conductor_cooldown.go` (`recoverableFailureRetryAfterWithHint`), BS §8, P mocks README |
| `disable-cooling` | bool | `false` | Disable ALL auth/model cooldowns unless a per-provider/per-credential override says otherwise | `internal/config/config.go:64-66`, `conductor_cooldown.go` (`quotaCooldownDisabledForAuthWithConfig`) |
| `save-cooldown-status` | bool | `false` | Persist per-credential cooldown state as `.cds` files next to auth files; restored on start and config reload | `internal/config/config.go:68-70`, `conductor_cooldown.go` (`PersistCooldownStates`, `RestoreCooldownStates`) |
| per-credential `weight` | int | `1` | Weighted-round-robin share; `<=0` excludes the credential while weighted strategy is active; `>1,000,000` is a config-load error | `internal/credentialweight/weight.go`, `internal/config/weight.go` (`ValidateCredentialWeights`, `validateCredentialWeightYAML`) |
| per-credential/provider `priority` | int | `0` | Higher priority tiers are exhausted before lower ones | `sdk/cliproxy/auth/selector.go` (`authPriority`), scheduler priority buckets |
| per-credential/provider `disable-cooling` | bool | inherit | Explicit override (true disables, false enables) over the global flag | `conductor_cooldown.go` (`quotaCooldownDisabledForAuthWithConfig`) |
| per-credential/provider `request-retry` | int (nullable) | inherit | `nil`/negative = inherit global; `0` = no additional rounds for this credential | `conductor_selection.go` (`effectiveRequestRetryLimit`, `requestRetryRoundExclusions`), config synthesizer (`addRequestRetryToMetadata`) |
| per-credential/provider `request-scoped-errors` | list | none | Rules `{status, match[], match-regexr[], action}`; actions `stop`, `stop-and-cooldown`, `continue`, `continue-and-cooldown` | `internal/config/config_types.go:18-24`, `conductor_execution.go` (`matchRequestScopedErrorAction`) |
| `streaming.bootstrap-retries` | int | `0` | Re-run a streaming request on another credential when the first stream chunk carries an eligible error, before any byte reaches the client | `internal/config/sdk_config.go:82-85`, `sdk/api/handlers/handlers_stream.go` |
| `quota-exceeded.switch-project`, `quota-exceeded.switch-preview-model` | bool | `false` | **INERT in v7.3.4**: config + management + TUI surface only; no runtime consumer (grep over `internal/runtime/executor` and `sdk/cliproxy/auth` shows only `antigravity-credits` is read). Spec'd as accepted-but-inert config | `internal/config/config_types.go` (`QuotaExceeded`), `internal/api/handlers/management/quota.go`, `internal/runtime/executor/antigravity_executor_credits.go:275` |
| `quota-exceeded.antigravity-credits` | bool | `false` | Last-resort Claude retry with an Antigravity credential that has Google One AI credits when all free-tier auths hit 429/503 | `internal/runtime/executor/antigravity_executor_credits.go`, `sdk/cliproxy/auth/conductor_home.go:1346` — FIXTURE-DEFERRED (OAuth) |

Config reload semantics (hot-reload via file watcher):
- Changing `routing.*` replaces the selector object; rotation cursors reset on the change; unchanged routing keeps cursors. `sdk/cliproxy/service_config.go` (`applyManagerConfig`).
- Changing `request-retry`/`max-retry-*` updates retry settings live. `internal/watcher/config_reload.go:138`, `internal/api/server_reload.go:121`.
- Cooldown state SURVIVES hot-reload; it is cleared only by process restart (unless `save-cooldown-status` restores it). BS §6, `conductor_cooldown.go` (`ApplyConfigWithCooldownStateStore`).
- A config with any `weight > 1,000,000` (or non-integer weight) is rejected: at load, the server refuses to start; on reload the update is dropped and the old config stays active. `internal/config/weight.go`, `sdk/cliproxy/service_config.go` (`commitConfigUpdate`).

### 2.2 Credential identity and ordering (determinism contract)

- Each config-synthesized credential gets a stable ID `<kind>:<12-hex>` where `<12-hex>` = first 12 hex chars of SHA-256 over `kind` and the family's part list, each part NUL-prefixed and trimmed; identical outputs get a `-N` counter suffix. `internal/watcher/synthesizer/helpers.go` (`StableIDGenerator.Next`). Per-family kinds and parts (`synthesizer/config.go`):
  - `openai-compatibility:<lowercased name>` — parts `(api-key, base-url, proxy-url)` (NO prefix, NO headers); empty `name` falls back to kind `openai-compatibility`; a provider with no `api-key-entries` synthesizes one credential with parts `(base-url)` only.
  - `gemini:apikey` — parts `(api-key, base-url, proxy-url, prefix, sorted-headers)`; `interactions` uses kind `gemini-interactions:apikey` with the same parts.
  - `claude:apikey`, `codex:apikey`, `xai:apikey`, `meta:apikey` — parts `(api-key, base-url, proxy-url, prefix, sorted-headers)`.
  - `vertex:apikey` — parts `(api-key, base-url, proxy-url)` (NO prefix, NO headers).
  - Sorted headers = the entry's `headers` map serialized with keys sorted (`config.FormatSortedHeaders`).
- **MUST**: cpa-edge MUST reproduce this ID derivation, because rotation order is defined over ID lexicographic order and is client-observable via which credential serves which request.
- Rotation order (round-robin and the sort within priority buckets) = ascending auth ID byte order. `sdk/cliproxy/auth/scheduler.go` (`rebuildIndexesLocked` sort, `scheduledSuccessorIndex`).
- `auth_index` (stable observability identity) = first 8 SHA-256 bytes as hex (16 lowercase hex chars) of a seed chosen in this order (`sdk/cliproxy/auth/types.go` `indexSeed`, `EnsureIndex`, `stableAuthIndex`):
  1. plugin-expanded credentials: `auth_index_seed:<seed attribute>`;
  2. file-backed credentials: when the effective file path (Attributes `path`/`source`, else `FileName`, else the auth ID) ends in `.json`, seed = `<auth-type-or-lowercased-provider>:<absolutized file path>` (config-synthesized credentials' `source` attribute is `config:<name>[<token>]`, which never matches);
  3. API-key credentials with a non-empty api-key, family literals exactly: `gemini-api-key`, `interactions-api-key`, `codex-api-key`, `xai-api-key`, `claude-api-key`, `meta-api-key`, `openai-compatibility` (compat matched via `compat_name` or provider `openai-compatibility`) — seed = `<family-literal>:<base-url>+<api-key>`. NOTE: vertex has no case in the switch, so `vertex-api-key` credentials never use this form;
  4. fallback for everything else (empty api-key, vertex, unmatched families): seed = `id:<auth-ID>`.
  Recorded proofs: S4-07 (compat entries), S4-20 (empty-api-key gemini credential: index `2f8a144d9ae23286` = sha256 of `id:gemini:apikey:88c747d7b66d` where the auth ID itself hashes the empty key + base-url).
- Config-synthesis edge (recorded: S4-20): a credential entry with an EMPTY api-key but a non-empty base-url IS synthesized, registered, and scheduled (the synthesizer skips an entry only when both api-key and base-url are empty) — `internal/watcher/synthesizer/config.go`.
- `auth_index` payload surfaces (S5 owns the routes; S4 owns the field semantics):
  - `GET /v0/management/{gemini-api-key|claude-api-key|codex-api-key|xai-api-key|meta-api-key|vertex-api-key|openai-compatibility|interactions-api-key}`: each entry carries `auth-index` (kebab-case). `internal/api/handlers/management/config_auth_index.go`.
  - `GET /v0/management/auth-files`: each auth file entry carries `auth_index` (snake_case). `management/auth_files_fields.go`.
  - `POST /v0/management/reset-quota`: request `{"auth_index": "<index>"}`; responses `400 {"error":"invalid request body"}`, `400 {"error":"auth_index is required"}`, `404 {"error":"auth not found"}`, `200 {"status":"ok","auth_index":"<index>","models":[...]}`. Route registration `internal/api/server_management.go:81`; handler `management/quota.go` (`ResetQuota`). (Distinct from `POST /v0/management/quota/reset`, which is the plugin quota-provider reset — `management/plugin_quota.go`.)
  - Usage records published to the usage queue / plugin callbacks / Home protocol carry `auth_index` identifying the credential that served the request. `internal/redisqueue/plugin.go:172`, `internal/pluginhost/auth_callbacks.go`, `internal/home/requests.go`.
- Client-visible error payloads do NOT contain auth_index or auth IDs; the identity mapping is via the surfaces above. (Stated explicitly because "auth_index in error payloads" in the mission maps to these management/plugin/usage payloads, plus the plugin-host error strings `auth not found for auth_index %s`.)

### 2.3 Selection strategies

Given the eligible credential set E for (provider, model) — eligibility = registered for the model, not disabled, not in the request's `tried` set, passing request eligibility (auth kind / credential policy / free-auth disallow), not blocked (see 2.4):

1. **Priority tiers first**: only the highest priority tier that has a ready credential participates. `scheduler.go` (`highestReadyPriorityLocked`), `selector.go` (`getAvailableAuthsWithPriorityMode`).
2. **round-robin**: within the participating set (sorted ascending by auth ID), pick the first credential whose ID is strictly greater than the last-picked ID for this (model, priority) bucket; wrap to the smallest ID. The cursor advances only on a successful pick. First request with no cursor → smallest ID. `scheduler.go` (`pickRoundRobin`, `scheduledSuccessorIndex`), `selector.go` (`RoundRobinSelector.Pick`, `successorIndex`).
3. **fill-first**: pick the first (smallest-ID) ready credential; no cursor. Intended to burn one account before moving on (stagger rolling-window caps). `scheduler.go` (`pickFirst`), `selector.go` (`FillFirstSelector.Pick`).
4. **weighted-round-robin**: smooth weighted round-robin (nginx-style): all participating credentials have `current[id] += weight`; pick the max `current` (first in ID order wins ties); winner's `current -= totalWeight`. Weights `<=0` exclude the credential while this strategy is active. Ratio converges to weight proportions. `scheduler.go` (`pickWeighted`, `pickSmoothWeightedScheduled`), `selector.go` (`WeightedRoundRobinSelector`, `pickSmoothWeightedAuth`).
   - Deterministic sequence example (weights 3:1, ID of the weight-3 credential first): `A A B A A A B A` (6×A, 2×B per 8).
5. **Mixed providers** (several provider families serve the same model): the provider list is ordered by per-provider credential count registered for the model DESC, then provider name ASC (`internal/registry/model_registry.go` `GetModelProviders` — count is registered, not currently-ready; `internal/util/provider.go` `GetProviderName`). round-robin: a cursor per (provider-list, model) walks providers weighted by their ready counts; fill-first: walk the provider list in order and take the first provider with a ready credential; weighted: smooth WRR over the merged, ID-sorted candidate set. `scheduler.go` (`pickMixedWithStrategy`).
6. **Session affinity** (wrapper over the strategy when `routing.session-affinity: true`): extract a session identity (explicit headers first: `X-Claude-Code-Session-Id`, Claude Code `metadata.user_id`, `Session-Id`, `X-Http-Session-Id`, `X-Session-ID`/`X-Session-Affinity`/`X-Slot-Session-Id`, `X-Conversation-Id`/`X-Thread-Id`/`X-Client-Request-Id`, Gemini `cachedContent`, OpenAI `thread_id`, body `session_id`/`sessionId`, `prompt_cache_key`, `conversation.id`, `metadata.user_id`, `conversation_id`/`chat_id`, execution-session metadata; then LCP prefix matching; then a first-message hash fallback). Cache key = `provider :: session-id :: model` (model key = base model without thinking suffix). Bound credential is reused if still available — an established binding OUTRANKS priority (kept even if a higher-priority credential recovers). On cache miss, bind whatever the fallback strategy picks. On bound-credential unavailability, failover via the fallback strategy and rebind. On a successful result the binding is refreshed (TTL); on a credential-attributed failure the binding is dropped (compare-and-delete); request-scoped / lifecycle failures preserve bindings. `selector.go` (`SessionAffinitySelector.Pick`, `OnResult`, `LookupAffinity`, `InvalidateAuth`), `sdk/cliproxy/session/info.go` (`ExtractSessionInfo` priority list 1-12), `sdk/cliproxy/session/lcp.go`.
7. **Pinned auth**: metadata `pinned_auth_id` restricts selection to one credential (used by Codex live sessions and Home); prefix model syntax (`prefix/model`) is resolved at routing, before scheduling. `sdk/cliproxy/executor/types.go:35-36`, `internal/client/codex/live/sideband.go:384`.

Websocket-transport credential preference (downstream-WS requests only; `websockets: true` on codex/xai api-key entries sets the auth attribute, `authWebsocketsEnabled` also reads auth metadata):
- Shard path (built-in strategy active): `providerPrefersWebsocketTransport` covers **codex AND xai**; the preference applies when the downstream request is a WebSocket and no credential is pinned (`pinned_auth_id` empty). The websocket-enabled sub-view is searched **across ALL priority tiers first** — a ws-enabled credential in a LOWER priority tier beats a non-ws credential in the highest tier; within the chosen view the strategy order applies; an empty ws view falls back to the all-credentials view. `scheduler.go` (`pickSingleWithStrategy`, `highestReadyPriorityLocked`, `pickReadyAtPriorityLocked`, `buildReadyBucket`).
- Legacy path (session-affinity or a plugin selector active): `preferCodexWebsocketAuths` covers **codex ONLY**; it filters the availability pass, which has already collapsed to the HIGHEST priority tier — it never crosses tiers — and falls back to the unfiltered tier when no ws-enabled credential exists there. `selector.go` (`preferCodexWebsocketAuths`, `getSelectorAvailableAuthsWithPriorityMode`).
- DIVERGENCE (intentional upstream): for downstream-WS requests the two paths are NOT observably identical — xai gets the preference only on the shard path, and only the shard path lets a ws-enabled credential jump priority tiers. Contract tests must pin the path-relevant observable per surface. Recorded: S4-21 (shard path, codex).
- Legacy cursor memory note: the legacy round-robin/weighted selectors key cursors by `provider:model` in maps capped at 4096 keys; inserting a NEW rotation key when the map is full resets the whole map (all cursors lost). `selector.go` (`ensureRotationKey`, `Pick`).

Fast path note: with a built-in strategy the scheduler shard path runs; with session-affinity (or a plugin scheduler) the legacy `Selector.Pick` path runs. The strategies implement identical ordering semantics for non-WS requests; the WS preference divergence above is the one documented exception. `conductor_selection.go` (`useSchedulerFastPath`, `isBuiltInSelector`).

### 2.4 Availability gating and cooldown classification

A credential is blocked for a model when (checked at pick time, lazily re-evaluated):
- disabled (auth or model state `StatusDisabled`) — never scheduled;
- OAuth access token expired (OAuth only);
- unauthorized failure recorded (401-class) with no refresh pending;
- credential-wide quota propagation active (`Quota.Reason == "credential_quota"` and `NextRecoverAt` in the future);
- per-model state blocked with a future `NextRetryAfter` (cooldown/quota) — a *quota* block (`Quota.Exceeded`) counts as "cooldown"; other blocks (transient, unauthorized, not-found, invalid-grant, model-not-supported) count as "unavailable".
`selector.go` (`isAuthBlockedForModel`, `availabilityBlock`), `scheduler.go` (`demoteExpiredTokensLocked`, `promoteExpiredLocked`).

Per-model vs credential-wide: failure marks a per-model state keyed by the credential's selection model; a 429 marked credential-scoped (executors: Claude unified rate limit, Meta rate limit; OAuth flows) propagates `credential_quota` to ALL sibling model states and the credential-wide fields. Other failures stay model-scoped: a cooldown on model A leaves model B on the same credential schedulable. `conductor_cooldown.go` (`MarkResult` 429 branch), `internal/runtime/executor/claude_executor_request.go` (`claudeRateLimitError`).

Cooldown durations (per-model state; identical ladder applies credential-wide when no model key exists, `applyAuthFailureState`):

| Failure | Status message | Cooldown (cooling enabled) | Notes | Evidence |
|---|---|---|---|---|
| 401 / invalid_grant | `unauthorized` / `invalid_grant` | 30 min | credential marked unauthorized; selection returns terminal auth error when all are unauthorized | `conductor_cooldown.go` (`MarkResult`, `applyAuthFailureState`) |
| 402, 403 | `payment_required` | 30 min | | same |
| 404 (incl. model-not-supported) | `not_found` / `model_not_supported` | 12 h | model-scoped | same, `isModelSupportResultError` |
| 429 (quota) | `quota exhausted` | `Retry-After` if present, floored at **10 s**; else ladder `1 s × 2^level` capped at **30 min** (level increments at most once per still-open window) | marks `Quota.Exceeded` reason `quota`; cooldown re-arms, never shortens a live window | `conductor_refresh.go:36-37` (`quotaBackoffBase`, `quotaBackoffMax`, `minQuotaCooldownFloor`), `conductor_cooldown.go` (`quotaCooldownAfterFailure`, `nextQuotaCooldown`) |
| 408, 500, 502, 503, 504, 520–526 | `transient upstream error` | `Retry-After` if present and positive; else `transient-error-cooldown-seconds` (0 = legacy **60 s**, negative = **no cooldown**) | blocked-unavailable (not quota) | `conductor_refresh.go:38` (`transientErrorCooldown = time.Minute`), `conductor_cooldown.go` (`recoverableFailureRetryAfterWithHint`) |
| other statuses | `request failed` | same transient rule | | same |
| Cloudflare challenge (403/503 + challenge markers) | `cloudflare challenge` | same 1 s × 2^level ladder as quota, with a per-step 10 s floor (cap 30 min) | marks quota reason `cloudflare challenge` | `conductor_cooldown.go` (`nextCloudflareCooldown` → `nextQuotaCooldown` + 10 s floor) |
| force-cooldown (`request-scoped-errors` action `stop-and-cooldown`/`continue-and-cooldown`) | — | 60 s transient cooldown, even when cooling disabled | `ErrorCodeForceCooldown` bypasses `disable-cooling` | `conductor_cooldown.go` (`MarkResult` force branch), `errors.go` (`ErrorCodeForceCooldown`) |

Failures that never cool a credential: request-scoped faults (`request_scoped`), connection-lifecycle errors (client cancel `context canceled`/`deadline exceeded`, `eof`/`unexpected eof`, websocket close 1000/1001/1006, dropped connection), pre-HTTP transient transport errors (dial/DNS/TLS/reset; `transient_transport`) — transport errors remain eligible for retry rounds but skip cooldown. `conductor_cooldown.go` (`shouldSkipCredentialCooldown`, `isConnectionLifecycleError`, `isTransientTransportError`), `errors.go` codes.

Success clears: a successful result on model M resets M's state (and the credential-wide state when it has no per-model states or no live `credential_quota` window); `LastError`/`StatusMessage` are cleared once no other model is in error. `conductor_cooldown.go` (`MarkResult` success branch, `clearAuthStateOnSuccess`).

`disable-cooling` precedence: per-credential override > per-provider override (openai-compatibility/vertex entries) > global `disable-cooling` > global runtime flag. When disabled, cooldown timestamps are zero and `Unavailable`/`Quota.Exceeded` flags are cleared; force-cooldown still applies. `conductor_cooldown.go` (`quotaCooldownDisabledForAuthWithConfig`, `providerCoolingOverrideForAuth`).

### 2.5 Execution: failover, retry rounds, quota switching

One request = rounds. Round 0 always exists: pick → prepare → execute → on failure mark result and pick the next eligible credential (same-request failover over the whole eligible pool, regardless of `request-retry`). Additional rounds exist only if `request-retry >= 1`.

Per-round rules (`conductor_execution.go` `executeMixedOnce`/`executeStreamMixedOnce`, `conductor_selection.go`):
- Credentials already tried in this round are excluded; `max-retry-credentials` caps distinct credentials per round (0/negative = all).
- Round r admits only credentials whose effective `request-retry` (override, else global) is `>= r`; round 0 admits everyone. Lower-limit credentials are pre-excluded from round r.
- Within a credential, the request iterates its model pool candidates (2.6): a failure moves to the next upstream model on the SAME credential before rotating.
- One refresh-and-retry per credential is attempted on 401 (OAuth credentials with refresh tokens only; API-key credentials skip it). `conductor_refresh.go` (`tryRefreshAfterUnauthorized`).
- A new round starts only when the last round ended with a retry-round-eligible error: HTTP **403, 408, 429, 500, 502, 503, 504** or a transient transport error. `conductor_selection.go` (`isCredentialRetryRoundStatus`, `isRequestRetryRoundError`).
- Before starting the next round the gateway waits for the earliest eligible credential cooldown (jittered +0..min(wait/4, 2 s), never past `max-retry-interval`); a positive wait `> max-retry-interval` (or `max-retry-interval <= 0`) stops retrying instead of waiting. 429 special case: a credential already attempted in the failed round with cooling enabled never triggers an immediate zero-wait next round (floor 10 s). `conductor_selection.go` (`closestCooldownWaitWithAttempted`, `jitteredCooldownWait`, `waitForCooldown`).
- Request-fault errors (caller-attributed 4xx: invalid_request bodies, 400/409/413/422, request-scoped stop actions) end the request immediately at the FIRST failing credential — no rotation, no cooldown. `internal/clienterror/client_error.go` (`IsRequestFault`), `conductor_execution.go` (`isRequestInvalidError` branch).
- Quota-exhausted switching = the 429 path: mark quota cooldown (ladder/floor), rotate within round 0 to the next credential; when all are cooling, surface `model_cooldown` (see 4). `quota-exceeded.switch-project` / `switch-preview-model` contribute NOTHING to this in v7.3.4 (inert, see 2.1).
- Antigravity credits fallback (OAuth-only, FIXTURE-DEFERRED): if the provider set includes Antigravity and the final error is a Claude free-tier exhaustion (429/503) and `quota-exceeded.antigravity-credits: true`, one retry happens with a credits-available Antigravity credential. `conductor_execution.go` (`shouldAttemptAntigravityCreditsFallback`, `tryAntigravityCreditsExecute`).

### 2.6 Intra-credential model pool

For `openai-compatibility` entries, several `models[].name` may share one `alias`. Requests to the alias rotate over the pool: a per-(credential, provider, model) offset increments each request and rotates the candidate list; the first candidate is tried and on failure the request continues with the next pool model on the same credential. `conductor_models.go` (`nextModelPoolOffset`, `rotateStrings`, `executionModelCandidatesWithAlias`), `config.example.yaml` (alias pool comment). OBSERVABLE: with pool [p1, p2], consecutive requests hit p1, p2, p1, ... and a failure of p1 fails over to p2 in the same request.

### 2.7 Streaming

- The upstream is read until its first payload chunk before the result is handed downstream (bootstrap read). A stream whose first chunk carries an error fails over to another credential within the normal round machinery. `conductor_stream.go` (`readStreamBootstrap`), `conductor_execution.go` (`executeStreamMixedOnce`).
- Once downstream bytes were committed, no credential rotation happens for that request: mid-stream upstream errors are re-framed into the stream as a terminal error frame (HTTP stays 200) and DO NOT cool the credential when they are lifecycle/EOF errors. Recorded: P `probes/mocks/` m3 (disconnect → in-stream `{"error":{"message":"unexpected EOF","type":"server_error","code":"internal_server_error"}}`).
- `streaming.bootstrap-retries` (default 0): when the first stream chunk carries an error with status 0 (transport) or 401/402/403/408/429/5xx, the HANDLER may re-issue the whole request (new ExecuteStream) up to N times before any byte is sent; disabled in Home mode. `sdk/api/handlers/handlers_stream.go` (`bootstrapEligible`, `maxBootstrapRetries`), `handlers.go` (`StreamingBootstrapRetries`).
- Codex `stream-bootstrap-buffering` (default false) holds handshake/heartbeat frames to hide in-stream `server_is_overloaded` rejections inside HTTP 200 and fail over before commit; only overload/rate-limit rejections fail over. `config.example.yaml` codex block, `conductor_cloudflare_520_test.go`-adjacent stream tests. OPTIONAL behavior (off by default).

### 2.8 Management interactions with scheduling (routes detailed in S5)

- `GET/PUT/PATCH /v0/management/request-retry` — read/write the global retry rounds.
- `GET /v0/management/quota-exceeded/switch-project` / `switch-preview-model` — inert flags (read/write only).
- `POST /v0/management/reset-quota` — reset cooldown/quota for one `auth_index`: clears every per-model state and the credential-wide cooldown fields; the credential is immediately schedulable again. Response `200 {"status":"ok","auth_index":"...","models":[...]}`; `400 {"error":"auth_index is required"}` when the field is missing; `404 {"error":"auth not found"}` for an unknown index.
- `GET /v0/management/auth-files` — exposes per-credential `unavailable`, `quota`, `status`, plus a `cooldowns` projection: entries `{scope: "credential"|"model", model_key, reason, retry_at, remaining_seconds, backoff_level?, http_status?}` with reason codes `quota`, `credential_quota`, `cloudflare_challenge`, `invalid_grant`, `unauthorized`, `payment_required`, `not_found`, `model_not_supported`, `transient_error`, `unknown`. `sdk/cliproxy/auth/cooldown_view.go` (`CooldownView`, `CooldownSnapshotForAuth`).

## 3. Schemas

### 3.1 Selection-relevant credential state (internal, observable through the surfaces above)

```
Auth {
  id, provider, prefix, status: active|error|disabled,
  disabled, unavailable,
  quota { exceeded, reason: "quota"|"credential_quota"|"cloudflare challenge"|..., next_recover_at, backoff_level, observed_at, signals },
  last_error { code?, message, retryable, http_status? },
  next_retry_after, next_refresh_after,
  model_states { <model-key>: { status, status_message, unavailable, last_error, next_retry_after, quota {…} } },
  attributes { api_key, base_url, provider_key, compat_name, priority?, weight?, config_index, source, header:<name>… },
  metadata { disable_cooling?, request_retry?, request_scoped_errors?, weight?, … }
}
```
`sdk/cliproxy/auth/types.go` (`Auth`, `QuotaState`, `ModelState`), `internal/watcher/synthesizer/config.go`.

### 3.2 Client-visible scheduling errors (exact bodies)

Let `<summary>` = sanitized upstream error summary (JSON `error.code`/`error.type` + `error.message`, or top-level `code`/`message`; secrets stripped; truncated to 256 runes) — `selector.go` (`ExtractUpstreamErrorSummary`, `SanitizeUpstreamErrorSummary`).

1. **All credentials cooling on quota** → HTTP **429**, header `Retry-After: <ceil(resetIn)>` (integer seconds), body (JSON object keys sorted alphabetically as upstream marshals a map):
```
{"error":{"code":"model_cooldown","last_upstream_error":"<summary>","message":"All credentials for model <model> are cooling down[ via provider <provider>][ (last error: <summary>)]","model":"<model>","provider":"<provider>","reset_seconds":<int>,"reset_time":"<Nd>"}}
```
Recorded (gemini): P mocks README + wire notes: `{"error":{"code":"model_cooldown","last_upstream_error":"<verbatim>","message":"All credentials for model gm are cooling down via provider gemini (last error: ...)"}}` with `reset_time: "1s"`. `selector.go` (`modelCooldownError.Error`, `StatusCode`, `Headers`).
2. **No ready credential, non-quota blocks (or none registered)** → HTTP **503**, body (struct order fixed):
```
{"error":{"message":"auth_unavailable: no auth available (providers=<p1,p2>, model=<model>[; last upstream error: <summary>])","type":"server_error","code":"internal_server_error"}}
```
`code` field is `auth_unavailable` or `auth_not_found` (both render 503); `providers` defaults to `unknown`, model to `unknown`; when the provider list contains `claude`, the message gains `; check Claude auth/key session and cooldown state via /v0/management/auth-files`. Recorded (openai-compat): P `probes/bootstrap-run1/mock-recordings/03-chat-stream-verbose.txt` — HTTP/1.1 503 + `{"error":{"message":"auth_unavailable: no auth available (providers=openai-compatibility-mock-openai, model=mock-model; last upstream error: chunked line ends with bare LF)","type":"server_error","code":"internal_server_error"}}`. (NOTE: BS §6 calls this "HTTP 500"; the raw transcript is authoritative: **503**.) `sdk/api/handlers/handlers_errors.go` (`enrichAuthSelectionError`), `handlers.go` (`BuildErrorResponseBodyWithError`).
3. **All credentials unauthorized** → terminal auth error → HTTP **503** (status from the wrapped error), body:
```
{"error":{"message":"auth_unavailable: no auth available (providers=…, model=…)","type":"authentication_error","code":"upstream_authentication_required","retryable":false}}
```
`errors.go` (`NewTerminalAuthError`, `IsTerminalAuthError`), `handlers.go` (`BuildErrorResponseBodyWithError` terminal branch).
4. **Upstream error relayed after failover exhausted** → the LAST upstream attempt's status and body are passed to the client VERBATIM (the preferred upstream error outranks the scheduling error when at least one upstream attempt happened). Recorded: 429 body+status verbatim (P m1), 500/400 bodies verbatim. `conductor_execution.go` (`preferredExecutionAttemptError`, `preferredUpstreamErr`).

### 3.3 Result classification (executors → scheduler)

`Result { auth_id, provider, model, route_model, success, error{code,message,retryable,http_status}, retry_after?, credential_scope? }`; executors signal: `StatusCode()`, `RetryAfter()` (parsed from `Retry-After` header; openai-compat adds a 1-minute fallback for `TPMRateLimitExceeded` bodies), `IsCredentialScoped()`, `IsRequestScoped()`, `IsModelCooldown()`. `sdk/cliproxy/executor` interfaces, `internal/runtime/executor/openai_compat_executor.go` (`statusErr`, `openAICompatRetryAfter`).

Error-code classification precedence when a failure is recorded (`conductor_cooldown.go` `resultErrorFromError`):
1. explicit model-not-found shape → code `model_not_found`;
2. request-scoped or request-invalid failure (typed `IsRequestScoped`, or a request-fault body per `internal/clienterror`: `error.code` ∈ {`cyber_policy`, `context_length_exceeded`, `message_too_big`, `string_above_max_length`, `invalid_prompt`, `invalid_value`, `unsupported_value`, `invalid_request_error`, `previous_response_not_found`} or `error.type` ∈ {`invalid_request`, `invalid_request_error`, `bad_request_error`, `invalid_prompt`}, or statuses 400/409/413/422 — with 402/429 and authentication-error-401 bodies always kept credential-attributed) → code `request_scoped` (no cooldown, rotation stops at the first failing credential);
3. connection-lifecycle shape → code `connection_lifecycle` (no cooldown, rotation continues);
4. pre-HTTP transient transport shape → code `transient_transport` (no cooldown, rotation continues, retry rounds allowed);
otherwise the raw upstream status drives the §2.4 ladder.

### 3.4 Route-contextual classification overrides

Three surfaces change how a failure is classified (they are scheduling contracts because they decide rotation and cooldown):

1. **count_tokens endpoints** (`/v1beta/models/{m}:countTokens`, `/v1/messages/count_tokens`): a **404** that is NOT an explicit model-not-found shape is **availability-neutral** — the request success/failure counters update, but NO cooldown is set, quota observation is skipped (`SkipQuotaObservation`), and no scheduler state changes; rotation continues to the next credential. All other count_tokens failures classify normally. Evidence: `conductor_execution.go:824-837` (`isCountTokensEndpointNotFoundError` + `recordAvailabilityNeutralResult`), `conductor_cooldown.go` (`recordAvailabilityNeutralResult`). Recorded: S4-22.
2. **`/responses/compact`** (Responses-compact requests, `opts.Alt == "responses/compact"`):
   - Request-fault STOP: statuses **400, 404, 405, 409, 413, 422, 501**, or any request-fault body — unless the error is credential-scoped, a Cloudflare challenge, or invalid_grant — stop at the FIRST failing credential (no rotation). `conductor_cooldown.go` (`isResponsesCompactRequestFaultError`).
   - Availability-NEUTRAL set: every OTHER failure on a compact request (including 5xx and transport errors) is recorded neutral — rotation continues, NO cooldown — EXCEPT: credential-scoped errors, Cloudflare challenges, invalid_grant, force-cooldown rule actions, and statuses **401, 402, 403, 429**, which mark cooldowns normally. `conductor_cooldown.go` (`isResponsesCompactAvailabilityNeutralError`). Recorded: S4-23.
3. **`store:false` item-not-persisted 404**: an upstream 404 whose text contains `item with id`, `not found`, and `items are not persisted when \`store\` is set to false` is REQUEST-SCOPED — rotation stops at the first failing credential and no cooldown is applied. `internal/clienterror` (`IsItemNotPersisted`), `conductor_cooldown.go` (`isRequestScopedNotFoundResultError`).

## 4. Streaming rules (S4-relevant)

1. Non-stream and stream requests use the same scheduling loop; count_tokens (`ExecuteCount`) also failovers.
2. First-byte rule: rotation is allowed while no downstream byte is committed; after the first translated chunk, errors are delivered in-stream and the credential is not rotated.
3. In-stream error frame shape (openai-compat SSE): `data: {"error":{"message":"unexpected EOF","type":"server_error","code":"internal_server_error"}}` after the chunks already sent; HTTP 200; no `[DONE]`. Recorded: P m3.
4. Lifecycle/EOF stream errors skip cooldown; HTTP-status stream errors (429/5xx read as first chunk) cool the credential and fail over.
5. `streaming.bootstrap-retries: N` re-runs the request (whole new selection) when the first chunk error is bootstrap-eligible (status 0, 401/402/403/408/429, >=500) before any byte is sent; default 0 = disabled.

## 5. Error semantics (scheduling decisions per upstream status)

| Upstream outcome | Same-request rotation? | Cooldown? | Retry rounds? | Client sees (if everything failed) |
|---|---|---|---|---|
| 400-class request fault (invalid_request / 400/409/413/422 bodies) | NO (stop at first credential) | NO | NO | upstream status+body VERBATIM |
| 400-class with matching `request-scoped-errors` rule action `continue` | YES | NO | only if status also retry-eligible (400 is not) | upstream status+body VERBATIM |
| … action `continue-and-cooldown` | YES | 60 s force cooldown | as status | upstream status+body VERBATIM |
| … action `stop` / `stop-and-cooldown` | NO | no / 60 s force | NO | upstream status+body VERBATIM |
| 401 | YES (after one refresh attempt for OAuth; API-keys skip) | 30 min (unauthorized) | NO (401 not retry-round eligible) | upstream 401 VERBATIM; after all-unauthorized → terminal 503 shape (3.2.3) |
| 402/403 | YES | 30 min (`payment_required`) | 403 YES (retry-round status), 402 NO | upstream VERBATIM |
| 404 carrying request-fault markers (body `error.type` ∈ invalid_request/invalid_request_error/bad_request_error/invalid_prompt, or `error.code` in the request-fault set) | NO (request_scoped stop) | NO | NO | upstream 404 VERBATIM (recorded: S4-20) |
| 404 model-not-found-shaped (`model_not_found` identifiers) | YES | 12 h (model-scoped, `not_found`/`model_not_supported`) | NO | upstream VERBATIM |
| 404 otherwise | YES | 12 h (model-scoped `not_found`) | NO | upstream VERBATIM |
| 429 | YES | quota ladder/floor (2.4) | YES | upstream 429 VERBATIM; all-cooling → 429 model_cooldown (3.2.1) |
| 408/500/502/503/504 | YES | transient (`transient-error-cooldown-seconds`, 0→60 s; negative → none) | YES | upstream VERBATIM; all-blocked → 503 auth_unavailable (3.2.2) |
| 520–526 | YES | transient (same rule) | NO (not a retry-round status) | upstream VERBATIM; all-blocked → 503 auth_unavailable (3.2.2) |
| transport error pre-HTTP (dial/DNS/TLS/reset) | YES | NO (transient_transport) | YES | 503/500 auth_unavailable (no upstream body) |
| client disconnect / EOF mid-stream | NO (already committed) | NO (lifecycle) | NO | in-stream error frame, HTTP 200 |

Route-contextual exceptions (§3.4): count_tokens-404 = neutral (rotate, NO cooldown — recorded S4-22); on `/responses/compact`, 400/404/405/409/413/422/501 stop at the first credential and every other failure except credential-scoped/cloudflare/invalid-grant/401/402/403/429 is NEUTRAL (rotate, no cooldown — recorded S4-23); `store:false` item-not-persisted 404 = request-scoped stop.

## 6. Golden-sample index

Fixtures under `tests/fixtures/S4/<case-id>/` follow the RECIPES layout (`meta.yaml`, `request.http`, `downstream.md`, `upstream.jsonl` (+ `upstream-openai.jsonl`/`upstream-gemini.jsonl` for the dual-mock case), `mock-response.json`; some cases add `mgmt-listing.json` or log excerpts). Wire log lines carry `credential` (Bearer/x-goog-api-key value — synthetic keys, the observable distinguishing credentials) and `response_status`; `meta.yaml` records the config YAML, control events, sleeps, the auth-ID→key mapping, and the observed credential sequence. Case definitions: `spec/recordings/S4.cases.json`.

Recorded against: CLIProxyAPI v7.3.4, commit `8335eac731946bd4eff18f500653f93736df53d6` (image digest `sha256:97825d…4266`), 2026-09-16, by @oracle-runner.

Baseline config for all S4 fixtures: 3-key `openai-compatibility` pool (`mock-openai`, keys `s4-oai-key-1/2/3`, base-url `http://host.docker.internal:18999/v1`), `transient-error-cooldown-seconds: 2`, `request-retry: 0`, `max-retry-interval: 10`, `routing.strategy: round-robin`, `routing.session-affinity: false`. Auth-ID order (recorded, `sha256(kind NUL key NUL base NUL)[:12]`): `s4-oai-key-1` (2add2ed9fa51) < `s4-oai-key-3` (922ad5b89d42) < `s4-oai-key-2` (9d9fdb184163).

| case | fixture dir | pins | status |
|---|---|---|---|
| S4-01 | `tests/fixtures/S4/S4-01-round-robin-rotation-order/` | RR cycles the 3-key pool in ascending auth-ID order: key-1, key-3, key-2, repeat | recorded |
| S4-02 | `…/S4-02-fill-first-ordering/` | fill-first pins the smallest-ID credential for every request | recorded |
| S4-03 | `…/S4-03-weighted-round-robin/` | smooth WRR ratio 3:1 over 8 picks; weight-0 credential never served | recorded |
| S4-04 | `…/S4-04-fill-first-failover-cooldown-recovery/` | same-request failover (500→200), cooldown skip, recovery to head after 2 s | recorded |
| S4-05 | `…/S4-05-transient-all-blocked-503/` | R1 = 3×500 relay (last upstream body VERBATIM, 500); R2 = 503 `auth_unavailable` enriched shape | recorded |
| S4-06 | `…/S4-06-quota-429-cooldown-model-cooldown-recovery/` | 429 relay; all-quota-cooling → 429 `model_cooldown` + `Retry-After: 1`; recovery after 1 s | recorded |
| S4-07 | `…/S4-07-reset-quota-management-auth-index/` | auth-index mapping via `GET /v0/management/openai-compatibility`; `POST /v0/management/reset-quota` shapes (400/404/200) and immediate schedulability after reset | recorded |
| S4-08 | `…/S4-08-request-fault-400-stops-rotation/` | exactly ONE upstream hit on request-fault 400; body VERBATIM | recorded |
| S4-09 | `…/S4-09-request-scoped-errors-continue/` | `request-scoped-errors` action `continue` rotates the full pool on 400 | recorded |
| S4-10 | `…/S4-10-retry-rounds/` | round 0 (3 keys) + ~2 s wait + round 1 (3 keys) = 6 upstream hits, single 500 response | recorded |
| S4-11 | `…/S4-11-session-affinity/` | sticky sessions via `X-Session-ID`; sequence key-1, key-3, key-3, key-2, key-1 | recorded |
| S4-12 | `…/S4-12-stream-disconnect-no-cooldown/` | in-stream `unexpected EOF` frame (HTTP 200); NO cooldown — same credential serves the next request | recorded |
| S4-13 | `…/S4-13-model-pool-rotation/` | per-credential model-pool rotation: upstream model alternates mock-pool-1 → 2 → 1 | recorded |
| S4-14 | `…/S4-14-unauthorized-terminal-and-hot-reload/` | 401 relay; terminal 503 `authentication_error` body; 30-min unauthorized cooldown SURVIVES hot-reload | recorded |
| S4-15 | `…/S4-15-disable-cooling-provider/` | provider `disable-cooling`: every request fails over across the whole pool; never 503 | recorded |
| S4-16 | `…/S4-16-model-scoped-cooldown-isolation/` | iso-model-1 cooldown (R2 = 503) does NOT block iso-model-2 (R4/R5 = 200) | recorded |
| S4-17 | `…/S4-17-transient-off-quota-still-cools/` | `transient-error-cooldown-seconds: -1`: 500s never cool; 429 quota cooldown still active (model_cooldown) | recorded |
| S4-18 | `…/S4-18-mixed-provider-rotation/` | cross-provider mixed rotation: R1 gemini wire (`x-goog-api-key`, `:19001`), R2 openai-compat wire (Bearer, `:18999`) — cursor alternates across provider segments; phase B: gemini 500 → same-request cross-provider failover → openai-mx 200 (client 200); R4 openai-mx 200 while gemini cools | recorded (re-recorded 2026-09-16 with corrected config; first attempt's bytes kept as S4-20) |
| S4-19 | `…/S4-19-invalid-weight-rejected/` | weight 1,000,001: startup exits; hot-reload to invalid rejected, old config keeps serving | recorded (optional case) |
| S4-20 | `…/S4-20-notfound-request-fault-stop/` | 404 with request-fault body (`type: invalid_request_error`) stops rotation at the first failing credential, NO cooldown; empty-api-key credential still scheduled; executor wire follows the credential's base-url | recorded |

FIXTURE-DEFERRED (CREDENTIALED-ONLY, documented in §2.4/§2.5 with source evidence, no local golden possible): S4-D1 OAuth refresh-on-unauthorized; S4-D2 OAuth token-expiry demotion; S4-D3 Antigravity credits fallback.

Recorded notes that refine the rules above:
- S4-18: the mixed pool executes each credential with ITS OWN provider executor (gemini wire for the gemini credential, openai-compat wire for the compat credential); provider segment order = registered-credential count DESC then name ASC ([gemini, openai-compatibility-mock-openai-mx]); the mixed cursor alternates per request; same-request cross-provider failover is hidden from the client.
- S4-07: steps 7 AND 8 were both served by the reset credential — at step 8 the other two keys were still inside their 1 s quota windows, so the reset (and only ready) credential served again. The fixture bytes are the contract; no cursor anomaly.
- S4-16: the 503 for the cooled model (R2) confirms per-model state isolation and that the alias-routed pick shard sees the upstream-model-keyed cooldown (scheduler targeted update).

## 7. Open questions and intentional non-equivalences

1. `quota-exceeded.switch-project` / `switch-preview-model`: accepted config + management surface, but no runtime consumer exists in v7.3.4. Proposal: cpa-edge accepts and round-trips the flags (management parity) without behavioral effect; register as intentional non-equivalence only if we choose to drop them.
2. Bootstrap hot-reload reset: upstream resets rotation cursors on any `routing.*` change. cpa-edge MUST match; but whether cursor reset on strategy ALIAS changes (e.g. `fill-first` → `ff`) matters is untested upstream — treat as unobservable corner.
3. `model_cooldown.reset_time` renders `1s` for any sub-second remainder (upstream rounds up for display but the header uses ceil). Keep upstream's exact rendering.
4. Codex `usage_limit_reached` (plan-limit quota; 12 h-style plan cooldowns, `codex.model-level-coolding`) is recordable via codex-api-key mocks with a custom `error_body`; deferred as an optional follow-up case (not blocking).
5. Home-mode scheduling (CPA Home protocol: redis dispatch, session trees, in-flight leases, concurrency policy) is out of scope; revisit if Home mode enters scope.
6. The mission phrase "auth_index mapping in error payloads" maps to management/plugin/usage payloads (2.2); client-facing error payloads contain no auth index upstream, and cpa-edge MUST NOT add one (compatibility).
7. BS §6 says the cooldown-exhausted error is "HTTP 500"; the raw transcript and code say 503. SPEC precedence (recorded bytes > summary) → 503 is normative.
