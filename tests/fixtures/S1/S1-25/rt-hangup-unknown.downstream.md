# rt-hangup-unknown (config variant: baseline)

## Status + response headers
```
HTTP/1.1 404 Not Found
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json; charset=utf-8
Date: Tue, 15 Sep 2026 17:28:23 GMT
Content-Length: 124

```

## Body
```
{"error":{"code":"realtime_call_not_found","message":"Realtime call not found","param":null,"type":"invalid_request_error"}}
```

HTTP status: 404
