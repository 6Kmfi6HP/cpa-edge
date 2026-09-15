# s2d3-res-tooluse-stream — response 1/1 (step 1)

## Status line
HTTP/1.1 200 OK

## Response headers (raw, received order)
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Cache-Control: no-cache
Content-Type: text/event-stream
X-Cpa-Trace-Id: 20260916015659-42f16b36d73439c3-bc059003
Date: Tue, 15 Sep 2026 17:56:59 GMT
Connection: close
Transfer-Encoding: chunked

## Body (Transfer-Encoding: chunked framing preserved) (exact bytes received, 1118 bytes)
```
data: {"id":"msg_tool_01","object":"chat.completion.chunk","created":1789495019,"model":"claude-mock-model","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}

data: {"id":"msg_tool_01","object":"chat.completion.chunk","created":1789495019,"model":"claude-mock-model","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"toolu_mock01","type":"function","function":{"name":"get_weather","arguments":"{\"city\":\"Paris\"}"}}]},"finish_reason":null}]}

data: {"id":"msg_tool_01","object":"chat.completion.chunk","created":1789495019,"model":"claude-mock-model","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":9,"completion_tokens":6,"total_tokens":15,"prompt_tokens_details":{"cached_tokens":0,"cached_creation_tokens":0,"cache_write_tokens":0}}}

data: {"id":"msg_tool_01","object":"chat.completion.chunk","created":1789495019,"model":"claude-mock-model","choices":[],"usage":{"prompt_tokens":9,"completion_tokens":6,"total_tokens":15,"prompt_tokens_details":{"cached_tokens":0,"cached_creation_tokens":0,"cache_write_tokens":0}}}

data: [DONE]


```

## Body (raw chunked stream as received)
```
b8
data: {"id":"msg_tool_01","object":"chat.completion.chunk","created":1789495019,"model":"claude-mock-model","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}


12b
data: {"id":"msg_tool_01","object":"chat.completion.chunk","created":1789495019,"model":"claude-mock-model","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"toolu_mock01","type":"function","function":{"name":"get_weather","arguments":"{\"city\":\"Paris\"}"}}]},"finish_reason":null}]}


150
data: {"id":"msg_tool_01","object":"chat.completion.chunk","created":1789495019,"model":"claude-mock-model","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":9,"completion_tokens":6,"total_tokens":15,"prompt_tokens_details":{"cached_tokens":0,"cached_creation_tokens":0,"cache_write_tokens":0}}}


11d
data: {"id":"msg_tool_01","object":"chat.completion.chunk","created":1789495019,"model":"claude-mock-model","choices":[],"usage":{"prompt_tokens":9,"completion_tokens":6,"total_tokens":15,"prompt_tokens_details":{"cached_tokens":0,"cached_creation_tokens":0,"cache_write_tokens":0}}}


e
data: [DONE]


0


```

## Trailers
```


```
