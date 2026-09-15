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
X-Cpa-Trace-Id: 20260916012734-6dd67e98f20665e0-241a61f8
Date: Tue, 15 Sep 2026 17:27:34 GMT
Transfer-Encoding: chunked

```

### Body (759 bytes, exact)
```
data: {"id":"resp_mock_01","object":"chat.completion.chunk","created":1770000000,"model":"gpt-mock-codex","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello from mock codex upstream"},"finish_reason":null,"native_finish_reason":null}]}

data: {"id":"resp_mock_01","object":"chat.completion.chunk","created":1770000000,"model":"gpt-mock-codex","choices":[{"index":0,"delta":{"role":"assistant","content":" more"},"finish_reason":null,"native_finish_reason":null}]}

data: {"id":"resp_mock_01","object":"chat.completion.chunk","created":1770000000,"model":"gpt-mock-codex","choices":[{"index":0,"delta":{},"finish_reason":"stop","native_finish_reason":"stop"}],"usage":{"completion_tokens":6,"total_tokens":15,"prompt_tokens":9}}

data: [DONE]


```
