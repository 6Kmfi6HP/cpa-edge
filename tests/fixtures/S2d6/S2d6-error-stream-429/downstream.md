# S2d6-error-stream-429 downstream (exact bytes)

## Status + headers
```
HTTP/1.1 429 Too Many Requests
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json
X-Cpa-Trace-Id: 20260916043722-47b77fbeb6ecb734-566023cb
Date: Tue, 15 Sep 2026 20:37:22 GMT
Content-Length: 109

```

## full SSE byte stream (incl. trailing bytes)
```
{"error":{"code":429,"message":"mock rate limit","status":"RESOURCE_EXHAUSTED","type":"rate_limit_exceeded"}}

```

HTTP status: 429
