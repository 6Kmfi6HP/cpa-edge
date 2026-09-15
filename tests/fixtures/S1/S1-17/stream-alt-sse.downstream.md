# S1-17 / stream-alt-sse — downstream response (exact bytes)

## Status + response headers (received order)
```
HTTP/1.1 200 OK
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Cache-Control: no-cache
Connection: keep-alive
Content-Type: text/event-stream
X-Cpa-Trace-Id: 20260916004708-47b77fbeb6ecb734-16d0a53b
Date: Tue, 15 Sep 2026 16:47:08 GMT
Transfer-Encoding: chunked

```

## Body (stdout)
```
data: {"candidates":[{"content":{"parts":[{"text":"Hello from mock openai upstream"}],"role":"model"},"index":0}],"model":"mock-gpt-model"}

data: {"candidates":[{"content":{"parts":[],"role":"model"},"index":0,"finishReason":"STOP"}],"model":"mock-gpt-model"}
```

HTTP status: 200
