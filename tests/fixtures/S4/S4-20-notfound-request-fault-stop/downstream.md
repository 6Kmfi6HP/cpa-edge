# S4-18-mixed-provider-rotation downstream (numbered steps)

## Step 1 — HTTP 404
### Response headers
```
HTTP/1.1 404 Not Found
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json
X-Cpa-Trace-Id: 20260916010100-2f8a144d9ae23286-f95cf4d4
Date: Tue, 15 Sep 2026 17:01:00 GMT
Content-Length: 140

```
### Body
```
{"error": {"message": "mock openai: no handler for POST /v1/v1beta/models/mock-gpt-model:generateContent", "type": "invalid_request_error"}}

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
X-Cpa-Trace-Id: 20260916010100-8003f8df5449db3b-7b0ca0c8
Date: Tue, 15 Sep 2026 17:01:00 GMT
Content-Length: 344

```
### Body
```
{"id":"","object":"chat.completion","created":0,"model":"gemini-mock-model","choices":[{"index":0,"message":{"role":"assistant","content":"Hello from mock gemini upstream more","reasoning_content":null,"tool_calls":null},"finish_reason":"stop","native_finish_reason":"stop"}],"usage":{"completion_tokens":6,"total_tokens":15,"prompt_tokens":9}}

```

## Step 4 — HTTP 404
### Response headers
```
HTTP/1.1 404 Not Found
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json
X-Cpa-Trace-Id: 20260916010101-2f8a144d9ae23286-d9ec69c4
Date: Tue, 15 Sep 2026 17:01:01 GMT
Content-Length: 140

```
### Body
```
{"error": {"message": "mock openai: no handler for POST /v1/v1beta/models/mock-gpt-model:generateContent", "type": "invalid_request_error"}}

```

## Step 5 — HTTP 404
### Response headers
```
HTTP/1.1 404 Not Found
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json
X-Cpa-Trace-Id: 20260916010101-2f8a144d9ae23286-69c401a4
Date: Tue, 15 Sep 2026 17:01:01 GMT
Content-Length: 140

```
### Body
```
{"error": {"message": "mock openai: no handler for POST /v1/v1beta/models/mock-gpt-model:generateContent", "type": "invalid_request_error"}}

```
