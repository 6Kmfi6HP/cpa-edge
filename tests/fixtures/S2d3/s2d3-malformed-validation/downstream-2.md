# s2d3-malformed-validation — response 2/5 (step 2)

## Status line
HTTP/1.1 502 Bad Gateway

## Response headers (raw, received order)
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json
X-Cpa-Trace-Id: 20260916023118-42f16b36d73439c3-0998f1e2
Date: Tue, 15 Sep 2026 18:31:18 GMT
Content-Length: 133
Connection: close

## Body (exact bytes received, 133 bytes)
```
{"error":{"message":"claude executor: upstream returned empty stream response","type":"server_error","code":"internal_server_error"}}
```
