## R1

### Response head (exact bytes)
```
HTTP/1.1 502 Bad Gateway
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json
X-Cpa-Trace-Id: 20260916041359-6dd67e98f20665e0-a94ffbb6
Date: Tue, 15 Sep 2026 20:13:59 GMT
Content-Length: 152

```

### Body (152 bytes, exact)
```
{"error":{"message":"stream error: upstream terminated with incomplete empty response (0 tokens)","type":"server_error","code":"internal_server_error"}}
```
