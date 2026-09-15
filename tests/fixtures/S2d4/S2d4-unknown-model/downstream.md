# S2d4-unknown-model downstream (exact bytes, 1 step)

## STEP 1 — POST /v1/messages

### Status + response headers (received order)
```
HTTP/1.1 400 Bad Request
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json
Date: Tue, 15 Sep 2026 21:10:04 GMT
Content-Length: 119
```

### Body
```
{"type":"error","error":{"type":"invalid_request_error","message":"unknown provider for model claude-3-7-nonexistent"}}
```

HTTP status: 400
