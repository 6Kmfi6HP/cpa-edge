## Step 1 — HTTP 200
### Headers
```
HTTP/1.1 200 OK
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json
X-Cpa-Trace-Id: 20260916010111-6a5fde1a341d633e-9c358cd1
Date: Tue, 15 Sep 2026 17:01:11 GMT
Content-Length: 319

```
### Body
```
{"id": "chatcmpl-mock-0001", "object": "chat.completion", "created": 1770000000, "model": "mock-gpt-model", "choices": [{"index": 0, "message": {"role": "assistant", "content": "Hello from mock openai upstream more"}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 9, "completion_tokens": 6, "total_tokens": 15}}

```
