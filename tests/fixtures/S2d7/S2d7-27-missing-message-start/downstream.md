### Response head (exact bytes)
```
HTTP/1.1 502 Bad Gateway
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json
X-Cpa-Trace-Id: 20260916015544-4ed6b48e6df227c2-3a1d48a7
Date: Tue, 15 Sep 2026 17:55:44 GMT
Content-Length: 143

```

### Body (143 bytes, exact)
```
{"error":{"message":"claude executor: upstream stream response is missing message_start","type":"server_error","code":"internal_server_error"}}
```
