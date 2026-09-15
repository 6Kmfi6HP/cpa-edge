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
X-Cpa-Trace-Id: 20260916010451-4ed6b48e6df227c2-2d5ab175
Date: Tue, 15 Sep 2026 17:04:51 GMT
Transfer-Encoding: chunked

```

### Body (329 bytes, exact)
```
data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Partial "}]}}],"usageMetadata":{"trafficType":"PROVISIONED_THROUGHPUT"},"modelVersion":"claude-mock-model","createTime":"2026-09-16T01:04:51+08:00","responseId":"msg_mock_03"}

data: {"error":{"code":400,"message":"mock overloaded","status":"INVALID_ARGUMENT"}}


```
