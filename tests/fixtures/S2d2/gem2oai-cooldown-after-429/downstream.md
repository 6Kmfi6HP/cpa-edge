## R1

### Response head (exact bytes)
```
HTTP/1.1 429 Too Many Requests
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json
X-Cpa-Trace-Id: 20260916011813-88c6027083ccc8bc-7b36ab5b
Date: Tue, 15 Sep 2026 17:18:13 GMT
Content-Length: 97

```

### Body (97 bytes, exact)
```
{"error":{"message":"mock rate limit","type":"rate_limit_exceeded","code":"rate_limit_exceeded"}}
```

## R2

### Response head (exact bytes)
```
HTTP/1.1 429 Too Many Requests
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json
Retry-After: 4
Date: Tue, 15 Sep 2026 17:18:13 GMT
Content-Length: 356

```

### Body (356 bytes, exact)
```
{"error":{"code":"model_cooldown","last_upstream_error":"rate_limit_exceeded: mock rate limit","message":"All credentials for model mock-model are cooling down via provider openai-compatible-mock-openai (last error: rate_limit_exceeded: mock rate limit)","model":"mock-model","provider":"openai-compatible-mock-openai","reset_seconds":4,"reset_time":"4s"}}
```
