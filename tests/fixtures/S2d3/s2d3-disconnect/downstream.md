# s2d3-disconnect — response 1/2 (step 1)

## Status line
HTTP/1.1 200 OK

## Response headers (raw, received order)
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Cache-Control: no-cache
Content-Type: text/event-stream
X-Cpa-Trace-Id: 20260916015659-42f16b36d73439c3-959ad8e4
Date: Tue, 15 Sep 2026 17:56:59 GMT
Connection: close
Transfer-Encoding: chunked

## Body (Transfer-Encoding: chunked framing preserved) (exact bytes received, 675 bytes)
```
data: {"id":"msg_mock_01","object":"chat.completion.chunk","created":1789495019,"model":"claude-mock-model","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}

data: {"id":"msg_mock_01","object":"chat.completion.chunk","created":1789495019,"model":"claude-mock-model","choices":[{"index":0,"delta":{"content":"Hello from mock claude upstream"},"finish_reason":null}]}

data: {"id":"msg_mock_01","object":"chat.completion.chunk","created":1789495019,"model":"claude-mock-model","choices":[{"index":0,"delta":{"content":" more"},"finish_reason":null}]}

data: {"error":{"message":"unexpected EOF","type":"server_error","code":"internal_server_error"}}


```

## Body (raw chunked stream as received)
```
b8
data: {"id":"msg_mock_01","object":"chat.completion.chunk","created":1789495019,"model":"claude-mock-model","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}


d1
data: {"id":"msg_mock_01","object":"chat.completion.chunk","created":1789495019,"model":"claude-mock-model","choices":[{"index":0,"delta":{"content":"Hello from mock claude upstream"},"finish_reason":null}]}


b7
data: {"id":"msg_mock_01","object":"chat.completion.chunk","created":1789495019,"model":"claude-mock-model","choices":[{"index":0,"delta":{"content":" more"},"finish_reason":null}]}


63
data: {"error":{"message":"unexpected EOF","type":"server_error","code":"internal_server_error"}}


0


```

## Trailers
```


```
