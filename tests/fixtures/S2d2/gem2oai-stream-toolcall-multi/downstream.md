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
X-Cpa-Trace-Id: 20260916021342-88c6027083ccc8bc-aa325711
Date: Tue, 15 Sep 2026 18:13:42 GMT
Transfer-Encoding: chunked

```

### Body (281 bytes, exact)
```
data: {"candidates":[{"content":{"parts":[{"functionCall":{"id":"call_multi_a","name":"get_weather","args":{"city":"Paris"}}},{"functionCall":{"id":"call_multi_b","name":"get_time","args":{"tz":"UTC"}}}],"role":"model"},"index":0,"finishReason":"STOP"}],"model":"mock-gpt-model"}


```
