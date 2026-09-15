# S6-13-logs-enabled — response 2/5 (step 2)

## Status line
HTTP/1.1 200 OK

## Response headers (raw, received order)
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json; charset=utf-8
X-Cpa-Build-Date: 2026-09-15T14:07:06Z
X-Cpa-Commit: 8335eac
X-Cpa-Support-Plugin: 1
X-Cpa-Version: v7.3.4
Date: Tue, 15 Sep 2026 17:24:48 GMT
Content-Length: 438
Connection: close

## Body (exact bytes received, 438 bytes)
```
{"latest-timestamp":1789493088,"line-count":1,"lines":["[2026-09-16 01:24:48] [--------] [info ] [gin_logger.go:103] 200 |          74ms |      172.17.0.1 | GET     \"/v0/management/logs\""],"next-cursor":"eyJ2IjoxLCJmaWxlIjoibWFpbi5sb2ciLCJvZmZzZXQiOjI0MjIsInNpemUiOjI0MjIsIm1vZFRpbWUiOjE3ODk0OTMwODgsIm1vZFRpbWVVbml4TmFubyI6MTc4OTQ5MzA4ODM5Nzc5MjQ5OCwibGF0ZXN0VGltZXN0YW1wIjoxNzg5NDkzMDg4LCJmaW5nZXJwcmludCI6IjJhZWFiSWpsb2xHYVhOT20ifQ"}
```
