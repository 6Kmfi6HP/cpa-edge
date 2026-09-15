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
X-Cpa-Trace-Id: 20260916010447-4ed6b48e6df227c2-eb52d39c
Date: Tue, 15 Sep 2026 17:04:47 GMT
Transfer-Encoding: chunked

```

### Body (818 bytes, exact)
```
data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Hello from mock claude upstream"}]}}],"usageMetadata":{"trafficType":"PROVISIONED_THROUGHPUT"},"modelVersion":"claude-mock-model","createTime":"2026-09-16T01:04:47+08:00","responseId":"msg_mock_01"}

data: {"candidates":[{"content":{"role":"model","parts":[{"text":" more"}]}}],"usageMetadata":{"trafficType":"PROVISIONED_THROUGHPUT"},"modelVersion":"claude-mock-model","createTime":"2026-09-16T01:04:47+08:00","responseId":"msg_mock_01"}

data: {"candidates":[{"content":{"role":"model","parts":[]},"finishReason":"STOP"}],"usageMetadata":{"trafficType":"PROVISIONED_THROUGHPUT","promptTokenCount":0,"candidatesTokenCount":6,"totalTokenCount":6},"modelVersion":"claude-mock-model","createTime":"2026-09-16T01:04:47+08:00","responseId":"msg_mock_01"}


```
