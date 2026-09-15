# hot-reload log excerpt
```
[2026-09-16 00:58:58] [--------] [info ] [service_lifecycle.go:204] file watcher started for config and auth directory changes
[2026-09-16 00:58:58] [--------] [info ] [service_plugins.go:369] re-registered models for 1 auth(s) due to model catalog changes: [gemini gemini-interactions vertex aistudio antigravity]
[2026-09-16 00:58:58] [--------] [info ] [antigravity_version.go:87] fetched latest antigravity version version=2.13.0
[2026-09-16 00:58:58] [--------] [info ] [gin_logger.go:103] 200 |            0s |      172.17.0.1 | GET     "/"
[2026-09-16 00:58:58] [1710c697] [warn ] [conductor_execution.go:1946] 401 |           6ms | upstream execution failed: provider=openai-compatible-mock-openai model=mock-gpt-model auth=api_key=s4-o...ey-1 err={"error": {"message": "mock rate limit", "type": "mock_error", "code": "mock_error"}}
[2026-09-16 00:58:58] [1710c697] [warn ] [conductor_execution.go:1946] 401 |           1ms | upstream execution failed: provider=openai-compatible-mock-openai model=mock-gpt-model auth=api_key=s4-o...ey-3 err={"error": {"message": "mock rate limit", "type": "mock_error", "code": "mock_error"}}
[2026-09-16 00:58:58] [1710c697] [warn ] [conductor_execution.go:1946] 401 |           1ms | upstream execution failed: provider=openai-compatible-mock-openai model=mock-gpt-model auth=api_key=s4-o...ey-2 err={"error": {"message": "mock rate limit", "type": "mock_error", "code": "mock_error"}}
[2026-09-16 00:58:58] [1710c697] [warn ] [gin_logger.go:101] 401 |          16ms |      172.17.0.1 | POST    "/v1/chat/completions"
[2026-09-16 00:58:58] [1ad291bf] [error] [gin_logger.go:99] 503 |          17ms |      172.17.0.1 | POST    "/v1/chat/completions"
[2026-09-16 00:58:59] [--------] [info ] [config_reload.go:72] config file changed, reloading: /CLIProxyAPI/config.yaml
[2026-09-16 00:58:59] [--------] [info ] [config_reload.go:128] config changes detected:
[2026-09-16 00:58:59] [--------] [info ] [config_reload.go:130]   codex.live-media-relay.ice-servers: updated (0 -> 0 entries, credentials redacted)
[2026-09-16 00:58:59] [--------] [info ] [config_reload.go:130]   payload.default: updated (0 -> 0 rules)
[2026-09-16 00:58:59] [--------] [info ] [config_reload.go:130]   payload.default-raw: updated (0 -> 0 rules)
[2026-09-16 00:58:59] [--------] [info ] [config_reload.go:130]   payload.override: updated (0 -> 0 rules)
[2026-09-16 00:58:59] [--------] [info ] [config_reload.go:130]   payload.override-raw: updated (0 -> 0 rules)
[2026-09-16 00:58:59] [--------] [info ] [config_reload.go:130]   payload.filter: updated (0 -> 0 rules)
[2026-09-16 00:58:59] [--------] [info ] [config_reload.go:141] config successfully reloaded, triggering client reload
server clients and configuration updated: 4 clients (0 auth entries + 1 Gemini API keys + 0 Interactions API keys + 0 Claude API keys + 0 Codex keys + 0 xAI keys + 0 Meta API keys + 0 Vertex-compat + 3 OpenAI-compat)
[2026-09-16 00:58:59] [--------] [info ] [clients.go:152] full client load complete - 4 clients (0 auth files + 1 Gemini API keys + 0 Vertex API keys + 0 Claude API keys + 0 Codex keys + 0 xAI keys + 0 Meta API keys + 3 OpenAI-compat)

```
