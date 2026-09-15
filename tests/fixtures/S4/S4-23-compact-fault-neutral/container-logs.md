# S4-23-compact-fault-neutral container logs (tail)
```
CLIProxyAPI Version: v7.3.4, Commit: 8335eac, BuiltAt: 2026-09-15T14:07:06Z
[2026-09-16 04:10:45] [--------] [info ] [main.go:634] CLIProxyAPI Version: v7.3.4, Commit: 8335eac, BuiltAt: 2026-09-15T14:07:06Z
[2026-09-16 04:10:45] [--------] [info ] [antigravity_version.go:62] periodic antigravity version refresh started (interval=3h0m0s)
[2026-09-16 04:10:45] [--------] [info ] [service_lifecycle.go:93] core auth auto-refresh started (interval=15m0s)
[2026-09-16 04:10:45] [--------] [info ] [server_management.go:22] management routes registered after secret key configuration
[2026-09-16 04:10:45] [--------] [info ] [devin_models_updater.go:60] startup Devin model refresh completed from https://raw.githubusercontent.com/router-for-me/models/refs/heads/main/devin_models.json, no changes detected
[2026-09-16 04:10:45] [--------] [info ] [devin_models_updater.go:36] periodic Devin model refresh started (interval=3h0m0s)
[2026-09-16 04:10:45] [--------] [info ] [model_updater.go:142] startup model refresh completed from https://raw.githubusercontent.com/router-for-me/models/refs/heads/main/models.json, changes detected for providers: [gemini gemini-interactions vertex aistudio antigravity]
[2026-09-16 04:10:45] [--------] [info ] [model_updater.go:92] periodic model refresh started (interval=3h0m0s)
[2026-09-16 04:10:45] [--------] [info ] [codex_client_models_updater.go:60] startup Codex client model refresh completed from https://raw.githubusercontent.com/router-for-me/models/refs/heads/main/codex_client_models.json, no changes detected
[2026-09-16 04:10:45] [--------] [info ] [codex_client_models_updater.go:36] periodic Codex client model refresh started (interval=3h0m0s)
API server started successfully on: :18317
server clients and configuration updated: 7 clients (0 auth entries + 1 Gemini API keys + 0 Interactions API keys + 0 Claude API keys + 3 Codex keys + 0 xAI keys + 0 Meta API keys + 0 Vertex-compat + 3 OpenAI-compat)
[2026-09-16 04:10:45] [--------] [info ] [clients.go:152] full client load complete - 7 clients (0 auth files + 1 Gemini API keys + 0 Vertex API keys + 0 Claude API keys + 3 Codex keys + 0 xAI keys + 0 Meta API keys + 3 OpenAI-compat)
[2026-09-16 04:10:45] [--------] [info ] [service_lifecycle.go:204] file watcher started for config and auth directory changes
[2026-09-16 04:10:45] [--------] [info ] [service_plugins.go:369] re-registered models for 1 auth(s) due to model catalog changes: [gemini gemini-interactions vertex aistudio antigravity]
[2026-09-16 04:10:45] [--------] [info ] [antigravity_version.go:87] fetched latest antigravity version version=2.14.0
[2026-09-16 04:10:46] [--------] [info ] [gin_logger.go:103] 200 |           1ms |      172.17.0.1 | GET     "/"
[2026-09-16 04:10:46] [bf71a75c] [warn ] [conductor_execution.go:1946] 500 |           6ms | upstream execution failed: provider=codex model=gpt-mock-codex auth=api_key=s4-c...ey-a err={"error": {"message": "mock rate limit", "type": "rate_limit_exceeded", "code": 500, "status": "INTERNAL"}}
[2026-09-16 04:10:46] [bf71a75c] [warn ] [conductor_execution.go:1946] 500 |           1ms | upstream execution failed: provider=codex model=gpt-mock-codex auth=api_key=s4-c...ey-c err={"error": {"message": "mock rate limit", "type": "rate_limit_exceeded", "code": 500, "status": "INTERNAL"}}
[2026-09-16 04:10:46] [bf71a75c] [warn ] [conductor_execution.go:1946] 500 |           1ms | upstream execution failed: provider=codex model=gpt-mock-codex auth=api_key=s4-c...ey-b err={"error": {"message": "mock rate limit", "type": "rate_limit_exceeded", "code": 500, "status": "INTERNAL"}}
[2026-09-16 04:10:46] [bf71a75c] [error] [gin_logger.go:99] 500 |          17ms |      172.17.0.1 | POST    "/v1/responses/compact"
[2026-09-16 04:10:46] [f6a8288e] [warn ] [conductor_execution.go:1946] 500 |           2ms | upstream execution failed: provider=codex model=gpt-mock-codex auth=api_key=s4-c...ey-a err={"error": {"message": "mock rate limit", "type": "rate_limit_exceeded", "code": 500, "status": "INTERNAL"}}
[2026-09-16 04:10:46] [f6a8288e] [warn ] [conductor_execution.go:1946] 500 |           2ms | upstream execution failed: provider=codex model=gpt-mock-codex auth=api_key=s4-c...ey-c err={"error": {"message": "mock rate limit", "type": "rate_limit_exceeded", "code": 500, "status": "INTERNAL"}}
[2026-09-16 04:10:46] [f6a8288e] [warn ] [conductor_execution.go:1946] 500 |           1ms | upstream execution failed: provider=codex model=gpt-mock-codex auth=api_key=s4-c...ey-b err={"error": {"message": "mock rate limit", "type": "rate_limit_exceeded", "code": 500, "status": "INTERNAL"}}
[2026-09-16 04:10:46] [f6a8288e] [error] [gin_logger.go:99] 500 |          11ms |      172.17.0.1 | POST    "/v1/responses/compact"
[2026-09-16 04:10:46] [1e7df7a7] [warn ] [conductor_execution.go:1946] 500 |           2ms | upstream execution failed: provider=codex model=gpt-mock-codex auth=api_key=s4-c...ey-a err={"error": {"message": "mock rate limit", "type": "rate_limit_exceeded", "code": 500, "status": "INTERNAL"}}
[2026-09-16 04:10:46] [1e7df7a7] [warn ] [conductor_execution.go:1946] 500 |           1ms | upstream execution failed: provider=codex model=gpt-mock-codex auth=api_key=s4-c...ey-c err={"error": {"message": "mock rate limit", "type": "rate_limit_exceeded", "code": 500, "status": "INTERNAL"}}
[2026-09-16 04:10:46] [1e7df7a7] [warn ] [conductor_execution.go:1946] 500 |           1ms | upstream execution failed: provider=codex model=gpt-mock-codex auth=api_key=s4-c...ey-b err={"error": {"message": "mock rate limit", "type": "rate_limit_exceeded", "code": 500, "status": "INTERNAL"}}
[2026-09-16 04:10:46] [1e7df7a7] [error] [gin_logger.go:99] 500 |          16ms |      172.17.0.1 | POST    "/v1/responses"
[2026-09-16 04:10:46] [2332624c] [error] [gin_logger.go:99] 503 |           6ms |      172.17.0.1 | POST    "/v1/responses"

```
