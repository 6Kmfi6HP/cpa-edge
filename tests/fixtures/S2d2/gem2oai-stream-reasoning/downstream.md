## R1

### Response head (exact bytes)
```
HTTP/1.1 200 OK
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Cache-Control: no-cache
Connection: keep-alive
Content-Type: text/event-stream
X-Cpa-Trace-Id: 20260916011805-88c6027083ccc8bc-874ef1a5
Date: Tue, 15 Sep 2026 17:18:05 GMT
Transfer-Encoding: chunked

```

### Body (504 bytes, exact)
```
data: {"candidates":[{"content":{"parts":[{"thought":true,"text":"Let me think"}],"role":"model"},"index":0}],"model":"mock-gpt-model"}

data: {"candidates":[{"content":{"parts":[{"text":"Answer"}],"role":"model"},"index":0}],"model":"mock-gpt-model"}

data: {"candidates":[{"content":{"parts":[{"thought":true,"text":" more"}],"role":"model"},"index":0}],"model":"mock-gpt-model"}

data: {"candidates":[{"content":{"parts":[],"role":"model"},"index":0,"finishReason":"STOP"}],"model":"mock-gpt-model"}


```
