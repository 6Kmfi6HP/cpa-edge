# S2d4-count-tokens-bad-budget downstream (exact bytes, 1 step)

## STEP 1 — POST /v1/messages/count_tokens

### Status + response headers (received order)
```
HTTP/1.1 400 Bad Request
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json
X-Cpa-Trace-Id: 20260916052903-4236bb647a544144-c945b8bb
Date: Tue, 15 Sep 2026 21:29:03 GMT
Content-Length: 116
```

### Body
```
{"type":"error","error":{"type":"invalid_request_error","message":"budget -5 cannot be converted to a valid level"}}
```

HTTP status: 400
