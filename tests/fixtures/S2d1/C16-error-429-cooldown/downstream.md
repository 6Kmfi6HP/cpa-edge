# S2d1-C16-error-429-cooldown downstream (exact bytes)

## Status line
HTTP/1.1 429 Too Many Requests

## Response headers (raw, received order)
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json
Retry-After: 1
Date: Tue, 15 Sep 2026 21:16:55 GMT
Content-Length: 450
Connection: close

## Body / SSE byte stream (exact bytes received, 450 bytes)
```
{"error":{"code":"model_cooldown","last_upstream_error":"{\"error\": {\"code\": 429, \"message\": \"mock rate limit\", \"status\": \"RESOURCE_EXHAUSTED\"}}","message":"All credentials for model mock-gemini-err429 are cooling down via provider gemini (last error: {\"error\": {\"code\": 429, \"message\": \"mock rate limit\", \"status\": \"RESOURCE_EXHAUSTED\"}})","model":"mock-gemini-err429","provider":"gemini","reset_seconds":1,"reset_time":"1s"}}
```
