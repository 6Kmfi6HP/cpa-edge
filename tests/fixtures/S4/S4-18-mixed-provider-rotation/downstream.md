# S4-18-mixed-provider-rotation downstream (numbered steps)

## Step 1 — HTTP 200
### Response headers
```
HTTP/1.1 200 OK
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json
X-Cpa-Trace-Id: 20260916005907-8003f8df5449db3b-2fbb74dd
Date: Tue, 15 Sep 2026 16:59:07 GMT
Content-Length: 344

```
### Body
```
{"id":"","object":"chat.completion","created":0,"model":"gemini-mock-model","choices":[{"index":0,"message":{"role":"assistant","content":"Hello from mock gemini upstream more","reasoning_content":null,"tool_calls":null},"finish_reason":"stop","native_finish_reason":"stop"}],"usage":{"completion_tokens":6,"total_tokens":15,"prompt_tokens":9}}

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
X-Cpa-Trace-Id: 20260916005907-8003f8df5449db3b-0f150a45
Date: Tue, 15 Sep 2026 16:59:07 GMT
Content-Length: 344

```
### Body
```
{"id":"","object":"chat.completion","created":0,"model":"gemini-mock-model","choices":[{"index":0,"message":{"role":"assistant","content":"Hello from mock gemini upstream more","reasoning_content":null,"tool_calls":null},"finish_reason":"stop","native_finish_reason":"stop"}],"usage":{"completion_tokens":6,"total_tokens":15,"prompt_tokens":9}}

```

## Step 4 — HTTP 500
### Response headers
```
HTTP/1.1 500 Internal Server Error
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json
X-Cpa-Trace-Id: 20260916005907-8003f8df5449db3b-ef6804c5
Date: Tue, 15 Sep 2026 16:59:07 GMT
Content-Length: 86

```
### Body
```
{"error": {"code": 429, "message": "mock rate limit", "status": "RESOURCE_EXHAUSTED"}}

```

## Step 5 — HTTP 503
### Response headers
```
HTTP/1.1 503 Service Unavailable
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json
Date: Tue, 15 Sep 2026 16:59:07 GMT
Content-Length: 262

```
### Body
```
{"error":{"message":"auth_unavailable: no auth available (providers=gemini, model=mx; last upstream error: {\"error\": {\"code\": 429, \"message\": \"mock rate limit\", \"status\": \"RESOURCE_EXHAUSTED\"}})","type":"server_error","code":"internal_server_error"}}

```
