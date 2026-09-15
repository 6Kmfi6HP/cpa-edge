# S2d4-stream-tools downstream (exact bytes, 1 step)

## STEP 1 — POST /v1/messages

### Status + response headers (received order)
```
HTTP/1.1 200 OK
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Cache-Control: no-cache
Connection: keep-alive
Content-Type: text/event-stream
X-Cpa-Trace-Id: 20260916051004-4236bb647a544144-577b2f5e
Date: Tue, 15 Sep 2026 21:10:04 GMT
Transfer-Encoding: chunked
```

### SSE byte stream (concatenated, chunk boundaries not recorded)
```
event: message_start
data: {"type":"message_start","message":{"id":"chatcmpl-tool-0001","type":"message","role":"assistant","model":"mock-gpt-model","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":33,"output_tokens":0}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call_tool_01","name":"Get_Weather","input":{}}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"city\":\"Paris\"}"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"input_tokens":0,"output_tokens":0}}

event: message_stop
data: {"type":"message_stop"}

```

HTTP status: 200
