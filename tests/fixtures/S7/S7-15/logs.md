# docker logs cpa-oracle-3 during this case (auxiliary evidence)
```text
[2026-09-16 01:00:14] [--------] [info ] [events.go:126] auth file changed (CREATE): oracle-fake-kimi.json, processing incrementally
[2026-09-16 01:00:16] [--------] [info ] [gin_logger.go:103] 200 |          55ms |      172.17.0.1 | GET     "/v0/management/auth-files"
[2026-09-16 01:00:16] [--------] [info ] [events.go:117] auth file changed (REMOVE): oracle-fake-kimi.json, processing incrementally
[2026-09-16 01:00:18] [--------] [warn ] [devin_models_updater.go:80] devin models updater: fetch failed from https://raw.githubusercontent.com/router-for-me/models/refs/heads/main/devin_models.json: Get "https://raw.githubusercontent.com/router-for-me/models/refs/heads/main/devin_models.json": dial tcp 185.199.109.133:443: connect: connection refused
[2026-09-16 01:00:18] [--------] [info ] [gin_logger.go:103] 200 |          79ms |      172.17.0.1 | GET     "/v0/management/auth-files"
```
