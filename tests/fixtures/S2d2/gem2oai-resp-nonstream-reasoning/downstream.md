## R1

### Response head (exact bytes)
```
HTTP/1.1 200 OK
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json
X-Cpa-Trace-Id: 20260916011804-88c6027083ccc8bc-51ef1352
Date: Tue, 15 Sep 2026 17:18:04 GMT
Content-Length: 301

```

### Body (301 bytes, exact)
```
{"candidates":[{"content":{"parts":[{"thought":true,"text":"Working through it"},{"text":"Final answer text"}],"role":"model"},"index":0,"finishReason":"MAX_TOKENS"}],"model":"mock-gpt-model","usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5,"totalTokenCount":15,"thoughtsTokenCount":4}}
```
