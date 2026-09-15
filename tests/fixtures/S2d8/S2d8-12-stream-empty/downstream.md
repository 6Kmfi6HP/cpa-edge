# S2d8-12-stream-empty downstream (exact bytes; full SSE byte stream)

## Status + headers
```
HTTP/1.1 200 OK
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Cache-Control: no-cache
Connection: keep-alive
Content-Type: text/event-stream
X-Cpa-Trace-Id: 20260916043307-8003f8df5449db3b-d9ce5c58
Date: Tue, 15 Sep 2026 20:33:07 GMT
Transfer-Encoding: chunked

```

## full SSE byte stream
```
event: message_start
data: {"type":"message_start","message":{"id":"msg_1nZdL29xx5MUA1yADyHTEsnR8uuvGzszyY","type":"message","role":"assistant","content":[],"model":"gemini-mock-model","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":4,"output_tokens":0}}}




```

HTTP status: 200
