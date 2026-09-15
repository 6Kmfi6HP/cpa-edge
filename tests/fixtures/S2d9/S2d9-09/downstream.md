# S2d9-09 downstream (exact bytes)

## Status line
HTTP/1.1 401 Unauthorized

## Response headers (raw, received order)
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json
X-Cpa-Trace-Id: 20260916051238-ddc1112c036d93f5-705e2746
Date: Tue, 15 Sep 2026 21:12:38 GMT
Content-Length: 93
Connection: close

## Body / byte stream (exact bytes received, 93 bytes)
```
{"error":{"code":"auth_unavailable","message":"Invalid token","type":"authentication_error"}}
```
