# docker logs cpa-oracle-3 during this case (auxiliary evidence)
```text
[2026-09-16 00:50:37] [--------] [info ] [gin_logger.go:103] 200 |          71ms |      172.17.0.1 | PUT     "/v0/management/ws-auth"
[2026-09-16 00:50:37] [--------] [info ] [config_reload.go:72] config file changed, reloading: /CLIProxyAPI/config.yaml
[2026-09-16 00:50:37] [--------] [info ] [config_reload.go:128] config changes detected:
[2026-09-16 00:50:37] [--------] [info ] [config_reload.go:130]   codex.live-media-relay.ice-servers: updated (0 -> 0 entries, credentials redacted)
[2026-09-16 00:50:37] [--------] [info ] [config_reload.go:130]   payload.default: updated (0 -> 0 rules)
[2026-09-16 00:50:37] [--------] [info ] [config_reload.go:130]   payload.default-raw: updated (0 -> 0 rules)
[2026-09-16 00:50:37] [--------] [info ] [config_reload.go:130]   payload.override: updated (0 -> 0 rules)
[2026-09-16 00:50:37] [--------] [info ] [config_reload.go:130]   payload.override-raw: updated (0 -> 0 rules)
[2026-09-16 00:50:37] [--------] [info ] [config_reload.go:130]   payload.filter: updated (0 -> 0 rules)
[2026-09-16 00:50:37] [--------] [info ] [config_reload.go:141] config successfully reloaded, triggering client reload
server clients and configuration updated: 8 clients (0 auth entries + 1 Gemini API keys + 1 Interactions API keys + 1 Claude API keys + 1 Codex keys + 1 xAI keys + 1 Meta API keys + 1 Vertex-compat + 1 OpenAI-compat)
[2026-09-16 00:50:37] [--------] [info ] [clients.go:152] full client load complete - 8 clients (0 auth files + 2 Gemini API keys + 1 Vertex API keys + 1 Claude API keys + 1 Codex keys + 1 xAI keys + 1 Meta API keys + 1 OpenAI-compat)
[2026-09-16 00:50:37] [5ca48ecd] [warn ] [gin_logger.go:101] 401 |            0s |      172.17.0.1 | GET     "/v1/ws"
[2026-09-16 00:50:38] [ee4c66a1] [warn ] [gin_logger.go:101] 401 |            0s |      172.17.0.1 | GET     "/v1/ws"
[2026-09-16 00:50:38] [--------] [warn ] [manager.go:127] wsrelay: upgrade failed: websocket: the client is not using the websocket protocol: 'upgrade' token not found in 'Connection' header
[2026-09-16 00:50:38] [c1941b1a] [warn ] [gin_logger.go:101] 400 |            0s |      172.17.0.1 | GET     "/v1/ws"
[2026-09-16 00:50:38] [--------] [info ] [gin_logger.go:103] 200 |          63ms |      172.17.0.1 | PUT     "/v0/management/ws-auth"
[2026-09-16 00:50:38] [--------] [info ] [config_reload.go:72] config file changed, reloading: /CLIProxyAPI/config.yaml
[2026-09-16 00:50:38] [--------] [info ] [config_reload.go:128] config changes detected:
[2026-09-16 00:50:38] [--------] [info ] [config_reload.go:130]   ws-auth: true -> false
[2026-09-16 00:50:38] [--------] [info ] [config_reload.go:130]   codex.live-media-relay.ice-servers: updated (0 -> 0 entries, credentials redacted)
[2026-09-16 00:50:38] [--------] [info ] [config_reload.go:130]   payload.default: updated (0 -> 0 rules)
[2026-09-16 00:50:38] [--------] [info ] [config_reload.go:130]   payload.default-raw: updated (0 -> 0 rules)
[2026-09-16 00:50:38] [--------] [info ] [config_reload.go:130]   payload.override: updated (0 -> 0 rules)
[2026-09-16 00:50:38] [--------] [info ] [config_reload.go:130]   payload.override-raw: updated (0 -> 0 rules)
[2026-09-16 00:50:38] [--------] [info ] [config_reload.go:130]   payload.filter: updated (0 -> 0 rules)
[2026-09-16 00:50:38] [--------] [info ] [config_reload.go:141] config successfully reloaded, triggering client reload
server clients and configuration updated: 8 clients (0 auth entries + 1 Gemini API keys + 1 Interactions API keys + 1 Claude API keys + 1 Codex keys + 1 xAI keys + 1 Meta API keys + 1 Vertex-compat + 1 OpenAI-compat)
[2026-09-16 00:50:38] [--------] [info ] [clients.go:152] full client load complete - 8 clients (0 auth files + 2 Gemini API keys + 1 Vertex API keys + 1 Claude API keys + 1 Codex keys + 1 xAI keys + 1 Meta API keys + 1 OpenAI-compat)
[2026-09-16 00:50:38] [--------] [warn ] [manager.go:127] wsrelay: upgrade failed: websocket: the client is not using the websocket protocol: 'upgrade' token not found in 'Connection' header
[2026-09-16 00:50:38] [e15c9265] [warn ] [gin_logger.go:101] 400 |            0s |      172.17.0.1 | GET     "/v1/ws"
```
