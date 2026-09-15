# rt-translations-client-secrets (config variant: baseline)

## Status + response headers
```
HTTP/1.1 501 Not Implemented
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json; charset=utf-8
Date: Tue, 15 Sep 2026 17:28:23 GMT
Content-Length: 192

```

## Body
```
{"error":{"code":"realtime_capability_not_supported","message":"Realtime translation sessions are not supported by the ChatGPT/Codex OAuth upstream","param":null,"type":"not_supported_error"}}
```

HTTP status: 501
