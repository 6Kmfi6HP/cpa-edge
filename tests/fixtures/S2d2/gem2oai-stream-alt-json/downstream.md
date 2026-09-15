## R1

### Response head (exact bytes)
```
HTTP/1.1 200 OK
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
X-Cpa-Trace-Id: 20260916021340-88c6027083ccc8bc-bdfa79a8
Date: Tue, 15 Sep 2026 18:13:40 GMT
Content-Type: text/plain; charset=utf-8
Transfer-Encoding: chunked

```

### Body (455 bytes, exact)
```
{"candidates":[{"content":{"parts":[{"text":"Hello"}],"role":"model"},"index":0}],"model":"mock-gpt-model"}{"candidates":[{"content":{"parts":[{"text":" world"}],"role":"model"},"index":0}],"model":"mock-gpt-model"}{"candidates":[{"content":{"parts":[],"role":"model"},"index":0,"finishReason":"STOP"}],"model":"mock-gpt-model"}{"candidates":[],"usageMetadata":{"promptTokenCount":8,"candidatesTokenCount":2,"totalTokenCount":10},"model":"mock-gpt-model"}
```
