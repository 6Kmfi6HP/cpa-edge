# S2d9-10 downstream (exact bytes)

## Status line
HTTP/1.1 404 Not Found

## Response headers (raw, received order)
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json
X-Cpa-Trace-Id: 20260916051134-ddc1112c036d93f5-280433df
Date: Tue, 15 Sep 2026 21:11:34 GMT
Content-Length: 132
Connection: close

## Body / byte stream (exact bytes received, 132 bytes)
```
{"error":{"code":"model_not_found","message":"model not found: mock-codex-upstream","param":"model","type":"invalid_request_error"}}
```
