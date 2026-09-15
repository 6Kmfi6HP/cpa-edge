### Response head (exact bytes)
```
HTTP/1.1 429 Too Many Requests
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json
Retry-After: 1
Date: Tue, 15 Sep 2026 17:04:54 GMT
Content-Length: 422

```

### Body (422 bytes, exact)
```
{"error":{"code":"model_cooldown","last_upstream_error":"{\"type\": \"error\", \"error\": {\"type\": \"rate_limit_error\", \"message\": \"mock rate limit\"}}","message":"All credentials for model cm are cooling down via provider claude (last error: {\"type\": \"error\", \"error\": {\"type\": \"rate_limit_error\", \"message\": \"mock rate limit\"}})","model":"cm","provider":"claude","reset_seconds":1,"reset_time":"1s"}}
```
