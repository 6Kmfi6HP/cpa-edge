# S2d9-12 downstream (exact bytes)

## Status line
HTTP/1.1 429 Too Many Requests

## Response headers (raw, received order)
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json
Retry-After: 3600
Date: Tue, 15 Sep 2026 21:12:06 GMT
Content-Length: 353
Connection: close

## Body / byte stream (exact bytes received, 353 bytes)
```
{"error":{"code":"model_cooldown","last_upstream_error":"usage_limit_reached: You have exceeded your usage limit","message":"All credentials for model codex-mock are cooling down via provider codex (last error: usage_limit_reached: You have exceeded your usage limit)","model":"codex-mock","provider":"codex","reset_seconds":3600,"reset_time":"1h0m0s"}}
```
