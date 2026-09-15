# S2d1-C17-error-400-nostream downstream (exact bytes)

## Status line
HTTP/1.1 400 Bad Request

## Response headers (raw, received order)
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json
X-Cpa-Trace-Id: 20260916051655-0ae4da1a9243c611-3198bd22
Date: Tue, 15 Sep 2026 21:16:55 GMT
Content-Length: 121
Connection: close

## Body / SSE byte stream (exact bytes received, 121 bytes)
```
{"error": {"code": 400, "message": "Invalid JSON payload received. Unknown name 'bogus'.", "status": "INVALID_ARGUMENT"}}
```
