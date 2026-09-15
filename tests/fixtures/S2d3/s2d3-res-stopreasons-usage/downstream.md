# s2d3-res-stopreasons-usage — response 1/3 (step 1)

## Status line
HTTP/1.1 200 OK

## Response headers (raw, received order)
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Cache-Control: no-cache
Content-Type: text/event-stream
X-Cpa-Trace-Id: 20260916015659-42f16b36d73439c3-26510cb6
Date: Tue, 15 Sep 2026 17:56:59 GMT
Connection: close
Transfer-Encoding: chunked

## Body (Transfer-Encoding: chunked framing preserved) (exact bytes received, 1008 bytes)
```
data: {"id":"msg_stop_01","object":"chat.completion.chunk","created":1789495019,"model":"claude-mock-model","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}

data: {"id":"msg_stop_01","object":"chat.completion.chunk","created":1789495019,"model":"claude-mock-model","choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}

data: {"id":"msg_stop_01","object":"chat.completion.chunk","created":1789495019,"model":"claude-mock-model","choices":[{"index":0,"delta":{},"finish_reason":"length"}],"usage":{"prompt_tokens":137,"completion_tokens":7,"total_tokens":144,"prompt_tokens_details":{"cached_tokens":32,"cached_creation_tokens":5,"cache_write_tokens":5}}}

data: {"id":"msg_stop_01","object":"chat.completion.chunk","created":1789495019,"model":"claude-mock-model","choices":[],"usage":{"prompt_tokens":137,"completion_tokens":7,"total_tokens":144,"prompt_tokens_details":{"cached_tokens":32,"cached_creation_tokens":5,"cache_write_tokens":5}}}

data: [DONE]


```

## Body (raw chunked stream as received)
```
b8
data: {"id":"msg_stop_01","object":"chat.completion.chunk","created":1789495019,"model":"claude-mock-model","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}


b9
data: {"id":"msg_stop_01","object":"chat.completion.chunk","created":1789495019,"model":"claude-mock-model","choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}


150
data: {"id":"msg_stop_01","object":"chat.completion.chunk","created":1789495019,"model":"claude-mock-model","choices":[{"index":0,"delta":{},"finish_reason":"length"}],"usage":{"prompt_tokens":137,"completion_tokens":7,"total_tokens":144,"prompt_tokens_details":{"cached_tokens":32,"cached_creation_tokens":5,"cache_write_tokens":5}}}


121
data: {"id":"msg_stop_01","object":"chat.completion.chunk","created":1789495019,"model":"claude-mock-model","choices":[],"usage":{"prompt_tokens":137,"completion_tokens":7,"total_tokens":144,"prompt_tokens_details":{"cached_tokens":32,"cached_creation_tokens":5,"cache_write_tokens":5}}}


e
data: [DONE]


0


```

## Trailers
```


```
