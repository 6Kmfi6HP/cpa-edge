# S2d1-C07-nostream-reasoning-effort downstream (exact bytes)

## Status line
HTTP/1.1 200 OK

## Response headers (raw, received order)
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json
X-Cpa-Trace-Id: 20260916051655-0ae4da1a9243c611-c55e901a
Date: Tue, 15 Sep 2026 21:16:55 GMT
Content-Length: 350
Connection: close

## Body / SSE byte stream (exact bytes received, 350 bytes)
```
{"id":"","object":"chat.completion","created":0,"model":"gemini-mock-model-think","choices":[{"index":0,"message":{"role":"assistant","content":"Hello from mock gemini upstream more","reasoning_content":null,"tool_calls":null},"finish_reason":"stop","native_finish_reason":"stop"}],"usage":{"completion_tokens":6,"total_tokens":15,"prompt_tokens":9}}
```
