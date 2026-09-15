# S2d6-error-nostream-429 downstream (exact bytes)

## Status + headers
```
HTTP/1.1 429 Too Many Requests
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json
X-Cpa-Trace-Id: 20260916043719-47b77fbeb6ecb734-ae3fe950
Date: Tue, 15 Sep 2026 20:37:19 GMT
Content-Length: 117

```

## body
```
{"error": {"message": "mock rate limit", "type": "rate_limit_exceeded", "code": 429, "status": "RESOURCE_EXHAUSTED"}}

```

HTTP status: 429
