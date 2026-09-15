### Response head (exact bytes)
```
HTTP/1.1 200 OK
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json
X-Cpa-Trace-Id: 20260916010452-4ed6b48e6df227c2-90fdd1de
Date: Tue, 15 Sep 2026 17:04:52 GMT
Content-Length: 447

```

### Body (447 bytes, exact)
```
{"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"get_weather","args":{"city":"Par"is"}},"id":"toolu_mock01"}]},"finishReason":"STOP"}],"usageMetadata":{"trafficType":"PROVISIONED_THROUGHPUT"},"modelVersion":"claude-mock-model","createTime":"2026-09-16T01:04:52+08:00","responseId":"msg_mock_02","usageMetadata":{"promptTokenCount":0,"candidatesTokenCount":12,"totalTokenCount":12,"trafficType":"PROVISIONED_THROUGHPUT"}}
```
