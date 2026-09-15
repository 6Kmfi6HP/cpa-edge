# S1-15 / chat-stream — downstream response (exact bytes)

## Status + response headers (received order)
```
HTTP/1.1 200 OK
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Cache-Control: no-cache
Connection: keep-alive
Content-Type: text/event-stream
X-Cpa-Trace-Id: 20260916004708-47b77fbeb6ecb734-348f7d53
Date: Tue, 15 Sep 2026 16:47:08 GMT
Transfer-Encoding: chunked

```

## Body (stdout)
```
data: {"id": "chatcmpl-mock-0001", "object": "chat.completion.chunk", "created": 1770000000, "model": "mock-gpt-model", "choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": null}]}

data: {"id": "chatcmpl-mock-0001", "object": "chat.completion.chunk", "created": 1770000000, "model": "mock-gpt-model", "choices": [{"index": 0, "delta": {"content": "Hello from mock openai upstream"}, "finish_reason": null}]}

data: {"id": "chatcmpl-mock-0001", "object": "chat.completion.chunk", "created": 1770000000, "model": "mock-gpt-model", "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}

data: [DONE]
```

HTTP status: 200
