# S4-21-ws-transport-preference container logs (tail)
```
CLIProxyAPI Version: v7.3.4, Commit: 8335eac, BuiltAt: 2026-09-15T14:07:06Z
[2026-09-16 04:11:41] [--------] [info ] [main.go:634] CLIProxyAPI Version: v7.3.4, Commit: 8335eac, BuiltAt: 2026-09-15T14:07:06Z
[2026-09-16 04:11:41] [--------] [info ] [antigravity_version.go:62] periodic antigravity version refresh started (interval=3h0m0s)
[2026-09-16 04:11:41] [--------] [info ] [service_lifecycle.go:93] core auth auto-refresh started (interval=15m0s)
[2026-09-16 04:11:41] [--------] [info ] [server_management.go:22] management routes registered after secret key configuration
[2026-09-16 04:11:41] [--------] [info ] [gin_logger.go:103] 200 |            0s |      172.17.0.1 | GET     "/"
[2026-09-16 04:11:41] [--------] [info ] [openai_responses_websocket.go:278] responses websocket: client connected id=cfff4f4b-08dc-4c6a-b2d6-5c28a2c35dcc remote=172.17.0.1
API server started successfully on: :18317
[2026-09-16 04:11:41] [--------] [info ] [openai_responses_websocket_forward.go:108] responses websocket: downstream_out id=cfff4f4b-08dc-4c6a-b2d6-5c28a2c35dcc type=1 event=error payload={"type":"error","status":404,"error":{"message": "mock codex: no handler for GET /responses", "type": "invalid_request_error"}}
[2026-09-16 04:11:41] [--------] [info ] [openai_responses_websocket.go:322] responses websocket: upstream execution session closed id=cfff4f4b-08dc-4c6a-b2d6-5c28a2c35dcc
[2026-09-16 04:11:41] [adb920d7] [info ] [gin_logger.go:103] 200 |          20ms |      172.17.0.1 | GET     "/v1/responses"
[2026-09-16 04:11:41] [--------] [info ] [model_updater.go:142] startup model refresh completed from https://raw.githubusercontent.com/router-for-me/models/refs/heads/main/models.json, changes detected for providers: [gemini gemini-interactions vertex aistudio antigravity]
[2026-09-16 04:11:41] [--------] [info ] [model_updater.go:92] periodic model refresh started (interval=3h0m0s)
[2026-09-16 04:11:41] [--------] [info ] [devin_models_updater.go:60] startup Devin model refresh completed from https://raw.githubusercontent.com/router-for-me/models/refs/heads/main/devin_models.json, no changes detected
[2026-09-16 04:11:41] [--------] [info ] [devin_models_updater.go:36] periodic Devin model refresh started (interval=3h0m0s)
[2026-09-16 04:11:41] [--------] [info ] [codex_client_models_updater.go:60] startup Codex client model refresh completed from https://raw.githubusercontent.com/router-for-me/models/refs/heads/main/codex_client_models.json, no changes detected
[2026-09-16 04:11:41] [--------] [info ] [codex_client_models_updater.go:36] periodic Codex client model refresh started (interval=3h0m0s)
server clients and configuration updated: 6 clients (0 auth entries + 1 Gemini API keys + 0 Interactions API keys + 0 Claude API keys + 2 Codex keys + 0 xAI keys + 0 Meta API keys + 0 Vertex-compat + 3 OpenAI-compat)
[2026-09-16 04:11:41] [--------] [info ] [clients.go:152] full client load complete - 6 clients (0 auth files + 1 Gemini API keys + 0 Vertex API keys + 0 Claude API keys + 2 Codex keys + 0 xAI keys + 0 Meta API keys + 3 OpenAI-compat)
[2026-09-16 04:11:41] [--------] [info ] [service_lifecycle.go:204] file watcher started for config and auth directory changes
[2026-09-16 04:11:41] [--------] [info ] [service_plugins.go:369] re-registered models for 1 auth(s) due to model catalog changes: [gemini gemini-interactions vertex aistudio antigravity]
[2026-09-16 04:11:41] [cd35f95b] [info ] [gin_logger.go:103] 200 |           7ms |      172.17.0.1 | POST    "/v1/chat/completions"
[2026-09-16 04:11:41] [--------] [info ] [service_auth.go:311] websocket provider connected: aistudio-v79py20uhwvuk5eq
[2026-09-16 04:11:41] [cb153c5c] [info ] [gin_logger.go:103] 200 |            0s |      172.17.0.1 | GET     "/v1/ws"
[2026-09-16 04:11:41] [--------] [info ] [antigravity_version.go:87] fetched latest antigravity version version=2.14.0
[2026-09-16 04:11:46] [--------] [warn ] [service_auth.go:328] websocket provider disconnected: aistudio-v79py20uhwvuk5eq (websocket: close 1006 (abnormal closure): unexpected EOF)

```
