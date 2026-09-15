## R1

### Response head (exact bytes)
```
HTTP/1.1 429 Too Many Requests
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json
X-Cpa-Trace-Id: 20260916012739-6dd67e98f20665e0-3db8b4a0
Date: Tue, 15 Sep 2026 17:27:39 GMT
Content-Length: 103

```

### Body (103 bytes, exact)
```
{"error": {"message": "mock rate limit", "type": "rate_limit_exceeded", "code": "rate_limit_exceeded"}}
```
