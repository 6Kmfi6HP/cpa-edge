# docker logs cpa-oracle-3 during this case (auxiliary evidence)
```text
[2026-09-16 00:50:44] [--------] [warn ] [gin_logger.go:101] 400 |            0s |      172.17.0.1 | GET     "/v0/management/oauth-callback"
[2026-09-16 00:50:44] [--------] [warn ] [gin_logger.go:101] 400 |            0s |      172.17.0.1 | GET     "/v0/management/oauth-callback?state=bad%2Fstate&code=c"
[2026-09-16 00:50:44] [--------] [warn ] [gin_logger.go:101] 400 |            0s |      172.17.0.1 | GET     "/v0/management/oauth-callback?state=zz"
[2026-09-16 00:50:44] [--------] [warn ] [gin_logger.go:101] 404 |            0s |      172.17.0.1 | GET     "/v0/management/oauth-callback?state=zz&code=c"
[2026-09-16 00:50:44] [--------] [warn ] [gin_logger.go:101] 400 |            0s |      172.17.0.1 | POST    "/v0/management/oauth-callback"
[2026-09-16 00:50:44] [--------] [warn ] [gin_logger.go:101] 404 |            0s |      172.17.0.1 | POST    "/v0/management/oauth-callback"
[2026-09-16 00:50:44] [--------] [info ] [gin_logger.go:103] 200 |          70ms |      172.17.0.1 | GET     "/v0/management/get-auth-status"
[2026-09-16 00:50:44] [--------] [warn ] [gin_logger.go:101] 401 |            0s |      172.17.0.1 | GET     "/v0/management/get-auth-status"
[2026-09-16 00:50:44] [--------] [info ] [gin_logger.go:103] 200 |          78ms |      172.17.0.1 | GET     "/v0/management/get-auth-status?state=zz"
[2026-09-16 00:50:44] [--------] [info ] [gin_logger.go:103] 200 |          54ms |      172.17.0.1 | DELETE  "/v0/management/oauth-session?state=zz"
[2026-09-16 00:50:44] [--------] [warn ] [gin_logger.go:101] 400 |          58ms |      172.17.0.1 | DELETE  "/v0/management/oauth-session"
```
