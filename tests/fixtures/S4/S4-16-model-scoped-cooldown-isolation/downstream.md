# S4-16-model-scoped-cooldown-isolation downstream (numbered steps)

## Step 1 — HTTP 500
### Response headers
```
HTTP/1.1 500 Internal Server Error
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json
X-Cpa-Trace-Id: 20260916005905-a42ae2a9f932510a-f50d4fee
Date: Tue, 15 Sep 2026 16:59:05 GMT
Content-Length: 85

```
### Body
```
{"error": {"message": "mock rate limit", "type": "mock_error", "code": "mock_error"}}

```

## Step 2 — HTTP 503
### Response headers
```
HTTP/1.1 503 Service Unavailable
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json
Date: Tue, 15 Sep 2026 16:59:05 GMT
Content-Length: 295

```
### Body
```
{"error":{"message":"auth_unavailable: no auth available (providers=openai-compatible-mock-openai, model=iso-model-1; last upstream error: {\"error\": {\"message\": \"mock rate limit\", \"type\": \"mock_error\", \"code\": \"mock_error\"}})","type":"server_error","code":"internal_server_error"}}

```

## Step 4 — HTTP 200
### Response headers
```
HTTP/1.1 200 OK
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json
X-Cpa-Trace-Id: 20260916005905-6a5fde1a341d633e-b27cfea6
Date: Tue, 15 Sep 2026 16:59:05 GMT
Content-Length: 315

```
### Body
```
{"id": "chatcmpl-mock-0001", "object": "chat.completion", "created": 1770000000, "model": "mock-iso-2", "choices": [{"index": 0, "message": {"role": "assistant", "content": "Hello from mock openai upstream more"}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 9, "completion_tokens": 6, "total_tokens": 15}}

```

## Step 5 — HTTP 200
### Response headers
```
HTTP/1.1 200 OK
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json
X-Cpa-Trace-Id: 20260916005905-9a4c4e139e376f20-0da33981
Date: Tue, 15 Sep 2026 16:59:05 GMT
Content-Length: 315

```
### Body
```
{"id": "chatcmpl-mock-0001", "object": "chat.completion", "created": 1770000000, "model": "mock-iso-2", "choices": [{"index": 0, "message": {"role": "assistant", "content": "Hello from mock openai upstream more"}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 9, "completion_tokens": 6, "total_tokens": 15}}

```
