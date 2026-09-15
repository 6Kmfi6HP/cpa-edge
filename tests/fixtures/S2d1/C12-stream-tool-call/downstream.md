# S2d1-C12-stream-tool-call downstream (exact bytes)

## Status line
HTTP/1.1 200 OK

## Response headers (raw, received order)
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Cache-Control: no-cache
Content-Type: text/event-stream
X-Cpa-Trace-Id: 20260916051655-0ae4da1a9243c611-f4f88153
Date: Tue, 15 Sep 2026 21:16:55 GMT
Connection: close
Transfer-Encoding: chunked

## Body / SSE byte stream (Transfer-Encoding: chunked framing preserved) (exact bytes received, 967 bytes)
```
data: {"id":"","object":"chat.completion.chunk","created":0,"model":"model","choices":[{"index":0,"delta":{"role":"assistant","content":"Let me check.","reasoning_content":null,"tool_calls":null},"finish_reason":null,"native_finish_reason":null}]}

data: {"id":"","object":"chat.completion.chunk","created":0,"model":"model","choices":[{"index":0,"delta":{"role":"assistant","content":null,"reasoning_content":null,"tool_calls":[{"id":"get_weather-1789507015537079588-3","index":0,"type":"function","function":{"name":"get_weather","arguments":"{\"city\": \"Paris\"}"}}]},"finish_reason":null,"native_finish_reason":null}]}

data: {"id":"","object":"chat.completion.chunk","created":0,"model":"gemini-mock-model-tools","choices":[{"index":0,"delta":{"role":null,"content":null,"reasoning_content":null,"tool_calls":null},"finish_reason":"tool_calls","native_finish_reason":"stop"}],"usage":{"completion_tokens":5,"total_tokens":16,"prompt_tokens":11}}

data: [DONE]


```

## Body (raw chunked stream as received)
```
f9
data: {"id":"","object":"chat.completion.chunk","created":0,"model":"model","choices":[{"index":0,"delta":{"role":"assistant","content":"Let me check.","reasoning_content":null,"tool_calls":null},"finish_reason":null,"native_finish_reason":null}]}


178
data: {"id":"","object":"chat.completion.chunk","created":0,"model":"model","choices":[{"index":0,"delta":{"role":"assistant","content":null,"reasoning_content":null,"tool_calls":[{"id":"get_weather-1789507015537079588-3","index":0,"type":"function","function":{"name":"get_weather","arguments":"{\"city\": \"Paris\"}"}}]},"finish_reason":null,"native_finish_reason":null}]}


148
data: {"id":"","object":"chat.completion.chunk","created":0,"model":"gemini-mock-model-tools","choices":[{"index":0,"delta":{"role":null,"content":null,"reasoning_content":null,"tool_calls":null},"finish_reason":"tool_calls","native_finish_reason":"stop"}],"usage":{"completion_tokens":5,"total_tokens":16,"prompt_tokens":11}}


e
data: [DONE]


0


```
