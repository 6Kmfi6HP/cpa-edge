# S4-13-model-pool-rotation downstream (numbered steps)

## Step 1 — HTTP 200
### Response headers
```
HTTP/1.1 200 OK
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json
X-Cpa-Trace-Id: 20260916010059-6a5fde1a341d633e-99340aee
Date: Tue, 15 Sep 2026 17:00:59 GMT
Content-Length: 316

```
### Body
```
{"id": "chatcmpl-mock-0001", "object": "chat.completion", "created": 1770000000, "model": "mock-pool-1", "choices": [{"index": 0, "message": {"role": "assistant", "content": "Hello from mock openai upstream more"}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 9, "completion_tokens": 6, "total_tokens": 15}}

```

## Step 2 — HTTP 200
### Response headers
```
HTTP/1.1 200 OK
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json
X-Cpa-Trace-Id: 20260916010059-6a5fde1a341d633e-7f0aad1f
Date: Tue, 15 Sep 2026 17:00:59 GMT
Content-Length: 316

```
### Body
```
{"id": "chatcmpl-mock-0001", "object": "chat.completion", "created": 1770000000, "model": "mock-pool-2", "choices": [{"index": 0, "message": {"role": "assistant", "content": "Hello from mock openai upstream more"}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 9, "completion_tokens": 6, "total_tokens": 15}}

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
X-Cpa-Trace-Id: 20260916010059-6a5fde1a341d633e-aaf918bd
Date: Tue, 15 Sep 2026 17:00:59 GMT
Content-Length: 316

```
### Body
```
{"id": "chatcmpl-mock-0001", "object": "chat.completion", "created": 1770000000, "model": "mock-pool-1", "choices": [{"index": 0, "message": {"role": "assistant", "content": "Hello from mock openai upstream more"}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 9, "completion_tokens": 6, "total_tokens": 15}}

```
