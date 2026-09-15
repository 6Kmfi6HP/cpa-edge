# S2d9-11 downstream (exact bytes)

## Status line
HTTP/1.1 429 Too Many Requests

## Response headers (raw, received order)
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json
X-Cpa-Trace-Id: 20260916051206-ddc1112c036d93f5-467217b0
Date: Tue, 15 Sep 2026 21:12:06 GMT
Content-Length: 141
Connection: close

## Body / byte stream (exact bytes received, 141 bytes)
```
{"error":{"code":"usage_limit_reached","message":"You have exceeded your usage limit","resets_in_seconds":3600,"type":"usage_limit_reached"}}
```
