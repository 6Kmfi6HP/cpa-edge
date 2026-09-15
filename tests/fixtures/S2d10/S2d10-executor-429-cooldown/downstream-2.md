# S2d10-executor-429-cooldown — response 2/2 (step 2)

## Status line
HTTP/1.1 429 Too Many Requests

## Response headers (raw, received order)
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json
Retry-After: 30
Date: Tue, 15 Sep 2026 17:41:28 GMT
Content-Length: 844
Connection: close

## Body (exact bytes received, 844 bytes)
```
{"error":{"code":"model_cooldown","last_upstream_error":"{\"error\": {\"code\": 429, \"message\": \"mock resource exhausted\", \"status\": \"RESOURCE_EXHAUSTED\", \"details\": [{\"@type\": \"type.googleapis.com/google.rpc.ErrorInfo\", \"reason\": \"RATE_LIMIT_EXCEEDED\"}, {\"@type\": \"type.googleapis.com/google.rpc.RetryInfo\", \"retr...","message":"All credentials for model claude-opus-4-6-thinking are cooling down via provider antigravity (last error: {\"error\": {\"code\": 429, \"message\": \"mock resource exhausted\", \"status\": \"RESOURCE_EXHAUSTED\", \"details\": [{\"@type\": \"type.googleapis.com/google.rpc.ErrorInfo\", \"reason\": \"RATE_LIMIT_EXCEEDED\"}, {\"@type\": \"type.googleapis.com/google.rpc.RetryInfo\", \"retr...)","model":"claude-opus-4-6-thinking","provider":"antigravity","reset_seconds":30,"reset_time":"30s"}}
```
