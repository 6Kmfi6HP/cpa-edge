# S6-16-cds-cooldown — response 2/4 (step 4)

## Status line
HTTP/1.1 503 Service Unavailable

## Response headers (raw, received order)
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json
Date: Tue, 15 Sep 2026 17:26:56 GMT
Content-Length: 312
Connection: close

## Body (exact bytes received, 312 bytes)
```
{"error":{"message":"auth_unavailable: no auth available (providers=openai-compatible-mock-openai, model=mock-model; last upstream error: {\"error\": {\"message\": \"mock rate limit\", \"type\": \"rate_limit_exceeded\", \"code\": \"rate_limit_exceeded\"}})","type":"server_error","code":"internal_server_error"}}
```
