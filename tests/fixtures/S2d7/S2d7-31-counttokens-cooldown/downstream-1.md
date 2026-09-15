### Response head (exact bytes)
```
HTTP/1.1 429 Too Many Requests
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json
X-Cpa-Trace-Id: 20260916045951-4ed6b48e6df227c2-e13f1cc3
Date: Tue, 15 Sep 2026 20:59:51 GMT
Content-Length: 86

```

### Body (86 bytes, exact)
```
{"type": "error", "error": {"type": "rate_limit_error", "message": "mock rate limit"}}
```
