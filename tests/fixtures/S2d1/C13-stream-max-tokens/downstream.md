# S2d1-C13-stream-max-tokens downstream (exact bytes)

## Status line
HTTP/1.1 200 OK

## Response headers (raw, received order)
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Cache-Control: no-cache
Content-Type: text/event-stream
X-Cpa-Trace-Id: 20260916051655-0ae4da1a9243c611-4c23e2f6
Date: Tue, 15 Sep 2026 21:16:55 GMT
Connection: close
Transfer-Encoding: chunked

## Body / SSE byte stream (Transfer-Encoding: chunked framing preserved) (exact bytes received, 595 bytes)
```
data: {"id":"","object":"chat.completion.chunk","created":0,"model":"model","choices":[{"index":0,"delta":{"role":"assistant","content":"The sea is ","reasoning_content":null,"tool_calls":null},"finish_reason":null,"native_finish_reason":null}]}

data: {"id":"","object":"chat.completion.chunk","created":0,"model":"gemini-mock-model-maxtok","choices":[{"index":0,"delta":{"role":null,"content":null,"reasoning_content":null,"tool_calls":null},"finish_reason":"max_tokens","native_finish_reason":"max_tokens"}],"usage":{"completion_tokens":8,"total_tokens":15,"prompt_tokens":7}}

data: [DONE]


```

## Body (raw chunked stream as received)
```
f7
data: {"id":"","object":"chat.completion.chunk","created":0,"model":"model","choices":[{"index":0,"delta":{"role":"assistant","content":"The sea is ","reasoning_content":null,"tool_calls":null},"finish_reason":null,"native_finish_reason":null}]}


14e
data: {"id":"","object":"chat.completion.chunk","created":0,"model":"gemini-mock-model-maxtok","choices":[{"index":0,"delta":{"role":null,"content":null,"reasoning_content":null,"tool_calls":null},"finish_reason":"max_tokens","native_finish_reason":"max_tokens"}],"usage":{"completion_tokens":8,"total_tokens":15,"prompt_tokens":7}}


e
data: [DONE]


0


```
