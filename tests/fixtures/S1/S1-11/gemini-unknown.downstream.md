# S1-11 / gemini-unknown — downstream response (exact bytes)

## Status + response headers (received order)
```
HTTP/1.1 400 Bad Request
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json
Date: Tue, 15 Sep 2026 16:47:08 GMT
Content-Length: 136

```

## Body (stdout)
```
{"error":{"message":"unknown provider for model no-such-model","type":"invalid_request_error","code":"model_not_found","param":"model"}}
```

HTTP status: 400
