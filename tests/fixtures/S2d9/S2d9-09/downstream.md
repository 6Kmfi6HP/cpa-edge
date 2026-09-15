# S2d9-09 downstream (exact bytes)

## Status + headers
```
HTTP/1.1 503 Service Unavailable
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json
Date: Tue, 15 Sep 2026 16:52:19 GMT
Content-Length: 224

```

## Body / byte stream
```
{"error":{"message":"auth_unavailable: no auth available (providers=codex, model=codex-mock; last upstream error: model_not_found: model not found: mock-codex-upstream)","type":"server_error","code":"internal_server_error"}}

```

HTTP status: 503
