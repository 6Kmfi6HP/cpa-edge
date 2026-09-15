# S2d6-stream-empty200 downstream (exact bytes)

## Status + headers
```
HTTP/1.1 500 Internal Server Error
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json
X-Cpa-Trace-Id: 20260916044734-47b77fbeb6ecb734-abf0d0f7
Date: Tue, 15 Sep 2026 20:47:34 GMT
Content-Length: 134

```

## full SSE byte stream (incl. trailing bytes)
```
{"error":{"message":"empty_stream: upstream stream closed before first payload","type":"server_error","code":"internal_server_error"}}

```

HTTP status: 500
