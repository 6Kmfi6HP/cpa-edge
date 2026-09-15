# hot-reload to weight 1000001
```
CLIProxyAPI Version: v7.3.4, Commit: 8335eac, BuiltAt: 2026-09-15T14:07:06Z
[2026-09-16 00:59:13] [--------] [info ] [main.go:634] CLIProxyAPI Version: v7.3.4, Commit: 8335eac, BuiltAt: 2026-09-15T14:07:06Z
[2026-09-16 00:59:13] [--------] [info ] [antigravity_version.go:62] periodic antigravity version refresh started (interval=3h0m0s)
[2026-09-16 00:59:13] [--------] [info ] [service_lifecycle.go:93] core auth auto-refresh started (interval=15m0s)
[2026-09-16 00:59:13] [--------] [info ] [server_management.go:22] management routes registered after secret key configuration
[2026-09-16 00:59:13] [--------] [info ] [devin_models_updater.go:60] startup Devin model refresh completed from https://raw.githubusercontent.com/router-for-me/models/refs/heads/main/devin_models.json, no changes detected
[2026-09-16 00:59:13] [--------] [info ] [devin_models_updater.go:36] periodic Devin model refresh started (interval=3h0m0s)
[2026-09-16 00:59:13] [--------] [info ] [model_updater.go:142] startup model refresh completed from https://raw.githubusercontent.com/router-for-me/models/refs/heads/main/models.json, changes detected for providers: [gemini gemini-interactions vertex aistudio antigravity]
[2026-09-16 00:59:13] [--------] [info ] [model_updater.go:92] periodic model refresh started (interval=3h0m0s)
[2026-09-16 00:59:13] [--------] [info ] [codex_client_models_updater.go:60] startup Codex client model refresh completed from https://raw.githubusercontent.com/router-for-me/models/refs/heads/main/codex_client_models.json, no changes detected
[2026-09-16 00:59:13] [--------] [info ] [codex_client_models_updater.go:36] periodic Codex client model refresh started (interval=3h0m0s)
API server started successfully on: :18317
server clients and configuration updated: 4 clients (0 auth entries + 1 Gemini API keys + 0 Interactions API keys + 0 Claude API keys + 0 Codex keys + 0 xAI keys + 0 Meta API keys + 0 Vertex-compat + 3 OpenAI-compat)
[2026-09-16 00:59:13] [--------] [info ] [clients.go:152] full client load complete - 4 clients (0 auth files + 1 Gemini API keys + 0 Vertex API keys + 0 Claude API keys + 0 Codex keys + 0 xAI keys + 0 Meta API keys + 3 OpenAI-compat)
[2026-09-16 00:59:13] [--------] [info ] [service_lifecycle.go:204] file watcher started for config and auth directory changes
[2026-09-16 00:59:13] [--------] [info ] [service_plugins.go:369] re-registered models for 1 auth(s) due to model catalog changes: [gemini gemini-interactions vertex aistudio antigravity]
[2026-09-16 00:59:13] [--------] [info ] [antigravity_version.go:87] fetched latest antigravity version version=2.13.0
[2026-09-16 00:59:14] [--------] [info ] [gin_logger.go:103] 200 |            0s |      172.17.0.1 | GET     "/"
[2026-09-16 00:59:14] [--------] [info ] [config_reload.go:72] config file changed, reloading: /CLIProxyAPI/config.yaml
[2026-09-16 00:59:14] [--------] [info ] [config_reload.go:128] config changes detected:
[2026-09-16 00:59:14] [--------] [info ] [config_reload.go:130]   codex.live-media-relay.ice-servers: updated (0 -> 0 entries, credentials redacted)
[2026-09-16 00:59:14] [--------] [info ] [config_reload.go:130]   payload.default: updated (0 -> 0 rules)
[2026-09-16 00:59:14] [--------] [info ] [config_reload.go:130]   payload.default-raw: updated (0 -> 0 rules)
[2026-09-16 00:59:14] [--------] [info ] [config_reload.go:130]   payload.override: updated (0 -> 0 rules)
[2026-09-16 00:59:14] [--------] [info ] [config_reload.go:130]   payload.override-raw: updated (0 -> 0 rules)
[2026-09-16 00:59:14] [--------] [info ] [config_reload.go:130]   payload.filter: updated (0 -> 0 rules)
[2026-09-16 00:59:14] [--------] [info ] [config_reload.go:141] config successfully reloaded, triggering client reload
server clients and configuration updated: 4 clients (0 auth entries + 1 Gemini API keys + 0 Interactions API keys + 0 Claude API keys + 0 Codex keys + 0 xAI keys + 0 Meta API keys + 0 Vertex-compat + 3 OpenAI-compat)
[2026-09-16 00:59:14] [--------] [info ] [clients.go:152] full client load complete - 4 clients (0 auth files + 1 Gemini API keys + 0 Vertex API keys + 0 Claude API keys + 0 Codex keys + 0 xAI keys + 0 Meta API keys + 3 OpenAI-compat)

```
