# S2d4-thinking-adaptive-unknown downstream (exact bytes, 1 step)

## STEP 1 — POST /v1/messages

### Status + response headers (received order)
```
HTTP/1.1 400 Bad Request
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json
X-Cpa-Trace-Id: 20260916052903-4236bb647a544144-3c28fb4a
Date: Tue, 15 Sep 2026 21:29:03 GMT
Content-Length: 132
```

### Body
```
{"type":"error","error":{"type":"invalid_request_error","message":"level \"ultra\" not supported, valid levels: low, medium, high"}}
```

HTTP status: 400
