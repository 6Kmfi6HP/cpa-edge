### Response head (exact bytes)
```
HTTP/1.1 200 OK
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json; charset=utf-8
X-Cpa-Build-Date: 2026-09-15T14:07:06Z
X-Cpa-Commit: 8335eac
X-Cpa-Support-Plugin: 1
X-Cpa-Version: v7.3.4
Date: Tue, 15 Sep 2026 16:50:43 GMT
Content-Length: 683

```

### Body (683 bytes, exact)
```
{"latest-timestamp":1789491043,"line-count":2,"lines":["[2026-09-16 00:50:43] [--------] [info ] [clients.go:152] full client load complete - 8 clients (0 auth files + 2 Gemini API keys + 1 Vertex API keys + 1 Claude API keys + 1 Codex keys + 1 xAI keys + 1 Meta API keys + 1 OpenAI-compat)","[2026-09-16 00:50:43] [--------] [info ] [gin_logger.go:103] 200 |          53ms |      172.17.0.1 | GET     \"/v0/management/logging-to-file\""],"next-cursor":"eyJ2IjoxLCJmaWxlIjoibWFpbi5sb2ciLCJvZmZzZXQiOjM3Nywic2l6ZSI6Mzc3LCJtb2RUaW1lIjoxNzg5NDkxMDQzLCJtb2RUaW1lVW5peE5hbm8iOjE3ODk0OTEwNDM1NDg0NjE4MTksImxhdGVzdFRpbWVzdGFtcCI6MTc4OTQ5MTA0MywiZmluZ2VycHJpbnQiOiJlcktTckpwTGFBeWFfYWRzIn0"}
```
