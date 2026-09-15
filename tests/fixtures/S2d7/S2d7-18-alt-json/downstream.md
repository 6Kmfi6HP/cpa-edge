### Response head (exact bytes)
```
HTTP/1.1 200 OK
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
X-Cpa-Trace-Id: 20260916010450-4ed6b48e6df227c2-05c74135
Date: Tue, 15 Sep 2026 17:04:50 GMT
Content-Type: text/plain; charset=utf-8
Transfer-Encoding: chunked

```

### Body (794 bytes, exact)
```
{"candidates":[{"content":{"role":"model","parts":[{"text":"Hello from mock claude upstream"}]}}],"usageMetadata":{"trafficType":"PROVISIONED_THROUGHPUT"},"modelVersion":"claude-mock-model","createTime":"2026-09-16T01:04:50+08:00","responseId":"msg_mock_01"}{"candidates":[{"content":{"role":"model","parts":[{"text":" more"}]}}],"usageMetadata":{"trafficType":"PROVISIONED_THROUGHPUT"},"modelVersion":"claude-mock-model","createTime":"2026-09-16T01:04:50+08:00","responseId":"msg_mock_01"}{"candidates":[{"content":{"role":"model","parts":[]},"finishReason":"STOP"}],"usageMetadata":{"trafficType":"PROVISIONED_THROUGHPUT","promptTokenCount":0,"candidatesTokenCount":6,"totalTokenCount":6},"modelVersion":"claude-mock-model","createTime":"2026-09-16T01:04:50+08:00","responseId":"msg_mock_01"}
```
