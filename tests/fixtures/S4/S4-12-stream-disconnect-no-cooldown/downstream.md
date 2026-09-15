# S4-12-stream-disconnect-no-cooldown downstream (numbered steps)

## Step 1 — HTTP 200
### Response headers
```
HTTP/1.1 200 OK
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Cache-Control: no-cache
Connection: keep-alive
Content-Type: text/event-stream
X-Cpa-Trace-Id: 20260916005856-6a5fde1a341d633e-75abb9fc
Date: Tue, 15 Sep 2026 16:58:56 GMT
Transfer-Encoding: chunked

```
### Body
```
data: {"id": "chatcmpl-mock-0001", "object": "chat.completion.chunk", "created": 1770000000, "model": "mock-gpt-model", "choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": null}]}

data: {"id": "chatcmpl-mock-0001", "object": "chat.completion.chunk", "created": 1770000000, "model": "mock-gpt-model", "choices": [{"index": 0, "delta": {"content": "Hello from mock openai upstream"}, "finish_reason": null}]}

data: {"error":{"message":"unexpected EOF","type":"server_error","code":"internal_server_error"}}



```

## Step 3 — HTTP 200
### Response headers
```
HTTP/1.1 200 OK
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json
X-Cpa-Trace-Id: 20260916005856-6a5fde1a341d633e-7453cfb1
Date: Tue, 15 Sep 2026 16:58:56 GMT
Content-Length: 319

```
### Body
```
{"id": "chatcmpl-mock-0001", "object": "chat.completion", "created": 1770000000, "model": "mock-gpt-model", "choices": [{"index": 0, "message": {"role": "assistant", "content": "Hello from mock openai upstream more"}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 9, "completion_tokens": 6, "total_tokens": 15}}

```
