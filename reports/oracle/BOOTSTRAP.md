# ORACLE BOOTSTRAP — upstream reference recording setup

Owner: @oracle-runner. Sandbox: `~/projects/llm-api/_cpa_edge_ref` (all raw artifacts).
This file is the durable summary; raw transcripts live in the sandbox.

## 1. Version anchor

| Item | Value |
|---|---|
| Upstream repo | https://github.com/router-for-me/CLIProxyAPI (MIT) |
| Cloned at | `_cpa_edge_ref/CLIProxyAPI` (full clone, tags fetched, read-only) |
| Latest release tag | `v7.3.4` |
| Tag commit | `8335eac731946bd4eff18f500653f93736df53d6` |
| Tag date | 2026-09-15 20:08:12 +0800 |
| HEAD vs tag | HEAD == v7.3.4 exactly (no commits after tag) |

All future oracle recordings must cite: **CLIProxyAPI v7.3.4, commit 8335eac731946bd4eff18f500653f93736df53d6**.

## 2. Binary source

Built-from-source was rejected first: `go.mod` requires `go 1.26.0`; local toolchain is go1.24.4
(see IRON RULES: report, don't degrade). The official image matches the anchor tag.

| Item | Value |
|---|---|
| Image | `eceasy/cli-proxy-api:v7.3.4` (from upstream `docker-compose.yml`) |
| Digest | `sha256:97825da3009f98acf78b5c172fde650a5fbe7a690950a69ce6d7b535d77d4266` |
| Image == tag? | Yes: `latest` and `v7.3.4` share this digest; binary self-reports `Version: v7.3.4, Commit: 8335eac, BuiltAt: 2026-09-15T14:07:06Z` |

## 3. Run instructions

```bash
# one-time
docker pull eceasy/cli-proxy-api:v7.3.4

# start (config template: _cpa_edge_ref/run/config.yaml)
docker run -d --name cpa-oracle \
  -p 127.0.0.1:18317:18317 \
  -v ~/projects/llm-api/_cpa_edge_ref/run/config.yaml:/CLIProxyAPI/config.yaml \
  -v ~/projects/llm-api/_cpa_edge_ref/run/auths:/root/.cli-proxy-api \
  eceasy/cli-proxy-api:v7.3.4

docker logs -f cpa-oracle        # wait for "API server started successfully on: :18317"
# stop
docker rm -f cpa-oracle
```

Config template (current `run/config.yaml`): port 18317; `api-keys: ["oracle-local-key-1"]`;
`remote-management: {allow-remote: true, secret-key: "oracle-mgmt-key-1", disable-control-panel: true}`;
`request-retry: 0`, `transient-error-cooldown-seconds: -1` (cooldowns off for recording),
`usage-statistics-enabled: false`; NO real provider credentials.
Caveats learned:
- The server HASHES the plaintext `secret-key` in place (bcrypt) on startup — it mutates the
  mounted config file; the plaintext value remains the accepted key.
- The server HOT-RELOADS `config.yaml` via a file watcher (adding an `openai-compatibility`
  provider took effect live, logged as `provider added: ...`).
- Startup fetches model catalogs from `raw.githubusercontent.com/router-for-me/models` (3 JSON
  files); failures there are logged but don't block startup.
- In-container auth dir default is `/root/.cli-proxy-api`.

## 4. Probe summary (transcripts: `_cpa_edge_ref/probes/bootstrap/`)

17 probes, each saved as `NN-slug.md` (exact curl command, raw `-v` exchange, status, headers,
body). Stability: the full set was run twice from a fresh container; byte-identical except
`Date` headers and one deliberate config value change.

| Probe | Result |
|---|---|
| GET `/` | 200 `{"message":"CLI Proxy API Server","endpoints":["POST /v1/chat/completions","POST /v1/completions","GET /v1/models"]}` |
| GET unknown route (`/v1/...`, top-level) | 404, **empty body** |
| OPTIONS `/v1/chat/completions` (no auth) | **204 No Content** + CORS headers (gin auto-OPTIONS) |
| GET `/v1/chat/completions` (wrong method, valid auth) | **404 empty body** (not 405) |
| GET `/v1/models` no auth | 401 `{"error":"Missing API key"}` |
| GET `/v1/models` invalid key | 401 `{"error":"Invalid API key"}` |
| GET `/v1/models` valid key (no providers) | 200 `{"data":[],"object":"list"}` |
| POST `/v1/chat/completions` no auth | 401 `{"error":"Missing API key"}` |
| POST `/v1/chat/completions`, unknown model, no providers | 400 `{"error":{"message":"unknown provider for model gpt-4o-mini","type":"invalid_request_error","code":"model_not_found","param":"model"}}` |
| GET `/v0/management/config` no auth | 401 `{"error":"missing management key"}` |
| GET `/v0/management/config` wrong key | 401 `{"error":"invalid management key"}` |
| GET `/v0/management/config` `Authorization: Bearer <mgmt-key>` | 200 full effective-config JSON |
| GET `/v0/management/api-keys` `X-Management-Key: <mgmt-key>` | 200 `{"api-keys":["oracle-local-key-1"]}` |
| GET unknown `/v0/management/...` sub-route (valid key) | 404 empty body |
| GET `/keep-alive` | 404 (route only registered when the keep-alive watchdog is enabled, e.g. TUI mode) |
| GET `/v1beta/models` no auth | 401 |
| GET `/v1beta/models` `x-goog-api-key: <api-key>` | 200 `{"models":[]}` (Bearer also accepted; both styles work on both `/v1` and `/v1beta`) |

Behavioral notes for the rewrite:
- EVERY response (including 404/401/204) carries the CORS block:
  `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Headers: *`,
  `Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS`,
  `Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE,
  X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION,
  X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id`.
- Two error shapes coexist: auth errors are `{"error": "<string>"}` (401), request errors are
  OpenAI-style `{"error": {message, type, code, param}}` (400) / `{"error": {message, type,
  code}}` (500 `server_error`).
- 404s from gin have empty bodies; there is no JSON 404 handler.
- Client API surface (routes, from source read): `/v1/models`, `/v1/chat/completions`,
  `/v1/completions`, `/v1/images/generations`, `/v1/images/edits`, `/v1/videos*`,
  `/v1/messages`, `/v1/messages/count_tokens`, `/v1/responses` (GET+POST) + `/compact`,
  `/v1/alpha/search`, `/v1/live*`, `/v1/realtime*`, `/openai/v1/videos*`,
  `/backend-api/codex/responses*`, `/v1beta/models`, `/v1beta/interactions`,
  `/v1beta/models/*action`, OAuth callbacks `/anthropic|codex|antigravity|devin/callback`.
  Management surface: `/v0/management/*` (146 routes, incl. `oauth-callback` outside auth group).

## 5. RECORDABLE-LOCALLY vs CREDENTIALED-ONLY

Upstream provider types split by whether the reference can be pointed at a local mock:
API-key config sections all accept `base-url` overrides -> mockable. OAuth credential types
target fixed vendor endpoints -> require real accounts.

| Direction (client -> upstream) | Upstream config type | Classification |
|---|---|---|
| OpenAI chat -> OpenAI (chat) | `openai-compatibility` (base-url) | **RECORDABLE-LOCALLY** (proven end-to-end, see §6) |
| OpenAI chat -> Gemini | `gemini-api-key` (base-url, default generativelanguage.googleapis.com) | RECORDABLE-LOCALLY (mock speaks Gemini wire `:generateContent`/`:streamGenerateContent`) |
| OpenAI chat -> Claude | `claude-api-key` (base-url) | RECORDABLE-LOCALLY (mock speaks `/v1/messages`) |
| OpenAI chat -> Codex-Responses | `codex-api-key` (base-url) | RECORDABLE-LOCALLY (mock speaks Responses wire) |
| OpenAI chat -> Kimi (native executor) | OAuth auth file (`type: kimi`), fixed api.kimi.com endpoints | CREDENTIALED-ONLY |
| OpenAI chat -> Kimi (compat executor) | `openai-compatibility` | RECORDABLE-LOCALLY, but exercises the OpenAI-compat executor, NOT native Kimi |
| OpenAI chat -> Grok | `xai-api-key` (base-url) | RECORDABLE-LOCALLY (mock speaks xAI Responses wire) |
| OpenAI chat -> Meta/Muse | `meta-api-key` (base-url) | RECORDABLE-LOCALLY |
| Gemini -> Claude | `claude-api-key` | RECORDABLE-LOCALLY |
| Gemini -> OpenAI | `openai-compatibility` | RECORDABLE-LOCALLY |
| Claude -> Gemini | `gemini-api-key` | RECORDABLE-LOCALLY |
| Claude -> OpenAI | `openai-compatibility` | RECORDABLE-LOCALLY |
| Responses/Codex -> passthrough | `codex-api-key` (base-url) | RECORDABLE-LOCALLY (Responses -> Codex Responses is near-passthrough) |
| Any -> Antigravity | OAuth (Google), fixed `https://cloudcode-pa.googleapis.com` | CREDENTIALED-ONLY |
| Any -> Gemini CLI/AIStudio OAuth | OAuth, fixed cloudcode-pa.googleapis.com | CREDENTIALED-ONLY |
| Any -> Claude OAuth | OAuth, fixed api.anthropic.com | CREDENTIALED-ONLY |
| Any -> Codex OAuth | OAuth, fixed chatgpt.com | CREDENTIALED-ONLY |
| Any -> xAI/Meta/Devin OAuth | OAuth, fixed vendor endpoints | CREDENTIALED-ONLY |
| Any -> Vertex | `vertex-api-key` (base-url "Vertex-compatible endpoints") | RECORDABLE-LOCALLY (wire = Vertex/Gemini; needs service-account-shaped keys) |

Antigravity redirect behavior (describable, not locally recordable): Antigravity login is a
Google OAuth flow (client id in source; scopes cloud-platform/cclog/...), redirecting to
`http://localhost:51121/oauth-callback` (or `/antigravity/callback` on the main port), then the
management panel redirects with HTTP 302. The antigravity upstream itself is
`cloudcode-pa.googleapis.com` with API version `v1internal`. Recording this needs a real Google
account: CREDENTIALED-ONLY.

## 6. Recording harness (proven end-to-end)

- Mock upstream: `_cpa_edge_ref/mock/mock_openai.py` — stdlib-only OpenAI-compatible server;
  fixed responses; logs every incoming request (method, path, headers, body) to
  `upstream_log.jsonl`. Speaks non-stream and SSE (proper HTTP chunked framing).
- Wiring: config `openai-compatibility` entry with `base-url: http://host.docker.internal:18999/v1`
  (Docker Desktop resolves that to the host loopback).
- Proof recordings: `_cpa_edge_ref/probes/bootstrap/mock-recordings/` (README.md summarizes;
  downstream verbose+body for models/non-stream/stream; `upstream-requests.jsonl` = what the
  reference emitted upstream). Key recorded facts:
  - alias -> upstream model rewrite on the way out ("mock-model" -> "mock-gpt-model");
  - upstream headers: `User-Agent: cli-proxy-openai-compat`, `Authorization: Bearer
    mock-upstream-key`, `Accept-Encoding: gzip`; client headers not forwarded;
  - streaming upstream: adds `Accept: text/event-stream`, `Cache-Control: no-cache`, injects
    `"stream_options":{"include_usage":true}` into the body;
  - downstream model list entry: `{"created":<server epoch>,"id":"<alias>","object":"model",
    "owned_by":"<provider name>"}` (created is dynamic);
  - response `model` field keeps the UPSTREAM name (no rewrite) unless the model sets
    `force-mapping: true`;
  - SSE re-framing: upstream `event:` lines dropped, only `data:` lines forwarded, `[DONE]`
    kept;
  - cooldown: after an upstream transport/parse error the credential enters cooldown; next
    requests get HTTP 500 `auth_unavailable: no auth available (providers=..., model=...;
    last upstream error: ...)`. Cooldown survives config hot-reload; cleared by restart;
    `transient-error-cooldown-seconds: -1` disables it.

## 7. RECIPES — future recording missions

Inputs I need from the spec-writer: a step-id, a request set per case (client protocol, exact
request headers/body or a reference to the spec section, stream flag), and which upstream
provider type to attach.

Procedure per case:
1. Compose a config fragment for the target provider type pointing at a fresh mock instance
   (port per mission); mock scripts live in `_cpa_edge_ref/mock/` and are extended per wire
   format (gemini/claude/responses/xai mocks to be written as missions require).
2. Start reference binary (pinned image, §3) + mock; replay the request set with curl.
3. Save raw transcripts under `_cpa_edge_ref/probes/<step-id>/`.
4. Produce fixture directory `tests/fixtures/<step-id>/<case-id>/` with EXACTLY this format:

```
tests/fixtures/<step-id>/<case-id>/
  meta.yaml          # version anchor, date, client protocol, upstream provider type,
                     # stream flag, config fragment used, list of dynamic fields
  request.http       # downstream request: method, path, headers, body (exact bytes sent)
  downstream.md      # downstream response: status, response headers, body (exact bytes)
  upstream.jsonl     # what the reference emitted to the mock (one JSON line per upstream
                     # request: method, path, headers, body)
  mock-response.json # the scripted mock reply that drove the recording
```

Normalization contract: I record raw bytes. Dynamic fields (Date, X-Cpa-Trace-Id, `created`
timestamps, port numbers) are listed in `meta.yaml` as `dynamic_fields` so the contract layer
can mask them; I do not silently rewrite transcripts.
5. Reply to the orchestrator with fixture paths + anything surprising.

Constraints I keep: reference repo read-only; cpa-edge writes only to `reports/oracle/**` and
assigned `tests/fixtures/**`; no upstream source text is ever copied into cpa-edge files —
recordings are wire transcripts only.

## 8. Surprises / open questions

- Wrong HTTP method on a registered route returns 404 with empty body (gin semantics), not 405.
- OPTIONS is auto-answered 204 + CORS without auth.
- Config file is live-mutated by the server (secret-key bcrypt hashing) — anyone mounting a
  template should expect the plaintext to disappear.
- `transient-error-cooldown-seconds: 0` means "legacy 60s", not "off" (-1 is off).
- Model list `created` field is a server-side epoch, not from upstream catalog data.
- Open question for spec-writer: should the rewrite mirror the 404-empty-body and 404-for-
  wrong-method behaviors exactly (client-visible compatibility) or improve them? I recorded
  reality; the spec must decide.
- Open question: `x-goog-api-key` is accepted on `/v1` too (not only `/v1beta`). Recorded.
