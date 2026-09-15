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
X-Cpa-Trace-Id: 20260916012736-6dd67e98f20665e0-8e36dc67
Date: Tue, 15 Sep 2026 17:27:36 GMT
Transfer-Encoding: chunked

```

### Body (636 bytes, exact)
```
data: {"id":"resp_mock_01","object":"chat.completion.chunk","created":1770000000,"model":"gpt-mock-codex","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello from mock codex upstream"},"finish_reason":null,"native_finish_reason":null}]}

data: {"id":"resp_mock_01","object":"chat.completion.chunk","created":1770000000,"model":"gpt-mock-codex","choices":[{"index":0,"delta":{"role":"assistant","content":" more"},"finish_reason":null,"native_finish_reason":null}]}

data: {"error":{"message":"stream error: stream disconnected before completion: stream closed before response.completed","type":"invalid_request_error"}}


```
