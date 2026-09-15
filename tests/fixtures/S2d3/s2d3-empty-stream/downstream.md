# s2d3-empty-stream — response 1/2 (step 1)

## Status line
HTTP/1.1 500 Internal Server Error

## Response headers (raw, received order)
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json
X-Cpa-Trace-Id: 20260916023118-42f16b36d73439c3-fc1824be
Date: Tue, 15 Sep 2026 18:31:18 GMT
Content-Length: 134
Connection: close

## Body (exact bytes received, 134 bytes)
```
{"error":{"message":"empty_stream: upstream stream closed before first payload","type":"server_error","code":"internal_server_error"}}
```
