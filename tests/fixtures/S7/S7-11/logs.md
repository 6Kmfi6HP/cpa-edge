# docker logs cpa-oracle-3 during this case (auxiliary evidence)
```text
[2026-09-16 00:50:44] [--------] [info ] [gin_logger.go:103] 200 |            0s |      172.17.0.1 | GET     "/anthropic/callback"
[2026-09-16 00:50:44] [--------] [info ] [gin_logger.go:103] 200 |            0s |      172.17.0.1 | GET     "/anthropic/callback?code=demo-code&state=demo-state"
[2026-09-16 00:50:44] [--------] [info ] [gin_logger.go:103] 200 |            0s |      172.17.0.1 | GET     "/codex/callback"
[2026-09-16 00:50:44] [--------] [info ] [gin_logger.go:103] 200 |            0s |      172.17.0.1 | GET     "/antigravity/callback"
[2026-09-16 00:50:44] [--------] [warn ] [gin_logger.go:101] 400 |            0s |      172.17.0.1 | GET     "/callback"
[2026-09-16 00:50:44] [--------] [warn ] [gin_logger.go:101] 400 |            0s |      172.17.0.1 | GET     "/devin/callback?code=demo-code&state=demo-state"
[2026-09-16 00:50:44] [--------] [warn ] [gin_logger.go:101] 404 |           1ms |      172.17.0.1 | POST    "/anthropic/callback"
```
