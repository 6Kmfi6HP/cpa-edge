# S1-13 / generate-content — downstream response (exact bytes)

## Status + response headers (received order)
```
HTTP/1.1 200 OK
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json
X-Cpa-Trace-Id: 20260916004708-47b77fbeb6ecb734-8133268e
Date: Tue, 15 Sep 2026 16:47:08 GMT
Content-Length: 245

```

## Body (stdout)
```
{"candidates":[{"content":{"parts":[{"text":"Hello from mock openai upstream more"}],"role":"model"},"index":0,"finishReason":"STOP"}],"model":"mock-gpt-model","usageMetadata":{"promptTokenCount":9,"candidatesTokenCount":6,"totalTokenCount":15}}
```

HTTP status: 200
