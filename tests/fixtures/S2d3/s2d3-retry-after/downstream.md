# s2d3-retry-after — response 1/2 (step 1)

## Status line
HTTP/1.1 429 Too Many Requests

## Response headers (raw, received order)
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json
X-Cpa-Trace-Id: 20260916023120-42f16b36d73439c3-5dcaf31e
Date: Tue, 15 Sep 2026 18:31:20 GMT
Content-Length: 86
Connection: close

## Body (exact bytes received, 86 bytes)
```
{"type": "error", "error": {"type": "rate_limit_error", "message": "mock rate limit"}}
```
