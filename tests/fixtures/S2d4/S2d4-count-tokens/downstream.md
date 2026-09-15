# S2d4-count-tokens downstream (exact bytes, 1 step)

## STEP 1 — POST /v1/messages/count_tokens

### Status + response headers (received order)
```
HTTP/1.1 200 OK
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json
X-Cpa-Trace-Id: 20260916051004-4236bb647a544144-a843f3a1
Date: Tue, 15 Sep 2026 21:10:04 GMT
Content-Length: 19
```

### Body
```
{"input_tokens":43}
```

HTTP status: 200
