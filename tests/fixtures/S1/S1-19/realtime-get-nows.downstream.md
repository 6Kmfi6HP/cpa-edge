# S1-19 / realtime-get-nows — downstream response (exact bytes)

## Status + response headers (received order)
```
HTTP/1.1 426 Upgrade Required
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json; charset=utf-8
Upgrade: websocket
Date: Tue, 15 Sep 2026 16:46:48 GMT
Content-Length: 130

```

## Body (stdout)
```
{"error":{"code":"websocket_upgrade_required","message":"WebSocket upgrade required","param":null,"type":"invalid_request_error"}}
```

HTTP status: 426
