# s2d3-err-instream-event — response 2/2 (step 2)

## Status line
HTTP/1.1 502 Bad Gateway

## Response headers (raw, received order)
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json
X-Cpa-Trace-Id: 20260916015659-42f16b36d73439c3-0ce8ba91
Date: Tue, 15 Sep 2026 17:56:59 GMT
Content-Length: 145
Connection: close

## Body (exact bytes received, 145 bytes)
```
{"error":{"message":"claude executor: upstream returned error event: mock in-stream error","type":"server_error","code":"internal_server_error"}}
```
