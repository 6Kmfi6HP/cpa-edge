# s3-realtime-ek-invalid-secret — response 1/1 (step 1)

## Status line
HTTP/1.1 401 Unauthorized

## Response headers (raw, received order)
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json; charset=utf-8
Date: Tue, 15 Sep 2026 17:38:11 GMT
Content-Length: 152
Connection: close

## Body (exact bytes received, 152 bytes)
```
{"error":{"code":"invalid_realtime_client_secret","message":"Realtime client secret is invalid or expired","param":null,"type":"invalid_request_error"}}```
