# S2d10-executor-429-cooldown — response 1/2 (step 1)

## Status line
HTTP/1.1 429 Too Many Requests

## Response headers (raw, received order)
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json
X-Cpa-Trace-Id: 20260916014128-baa9dcaf84c2c04a-376d2ed4
Date: Tue, 15 Sep 2026 17:41:28 GMT
Content-Length: 271
Connection: close

## Body (exact bytes received, 271 bytes)
```
{"error": {"code": 429, "message": "mock resource exhausted", "status": "RESOURCE_EXHAUSTED", "details": [{"@type": "type.googleapis.com/google.rpc.ErrorInfo", "reason": "RATE_LIMIT_EXCEEDED"}, {"@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": "30s"}]}}
```
