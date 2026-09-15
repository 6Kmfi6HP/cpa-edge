# S2d1-C03-nostream-tools-history downstream (exact bytes)

## Status line
HTTP/1.1 200 OK

## Response headers (raw, received order)
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json
X-Cpa-Trace-Id: 20260916051655-0ae4da1a9243c611-ce40f563
Date: Tue, 15 Sep 2026 21:16:55 GMT
Content-Length: 457
Connection: close

## Body / SSE byte stream (exact bytes received, 457 bytes)
```
{"id":"","object":"chat.completion","created":0,"model":"gemini-mock-model-tools","choices":[{"index":0,"message":{"role":"assistant","content":null,"reasoning_content":null,"tool_calls":[{"id":"get_weather-1789507015440843630-1","type":"function","function":{"name":"get_weather","arguments":"{\"city\": \"Paris\"}"}}]},"finish_reason":"tool_calls","native_finish_reason":"tool_calls"}],"usage":{"completion_tokens":3,"total_tokens":14,"prompt_tokens":11}}
```
