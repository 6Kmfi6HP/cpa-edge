# S2d4-stream-disconnect downstream (exact bytes, 1 step)

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
X-Cpa-Trace-Id: 20260916051100-4236bb647a544144-3e0eeec3
Date: Tue, 15 Sep 2026 21:11:00 GMT
Transfer-Encoding: chunked
```

### SSE byte stream (concatenated, chunk boundaries not recorded)
```
event: message_start
data: {"type":"message_start","message":{"id":"chatcmpl-mock-0001","type":"message","role":"assistant","model":"mock-gpt-model","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":3,"output_tokens":0}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello from mock openai upstream"}}

event: error
data: {"type":"error","error":{"type":"api_error","message":"unexpected EOF"}}

```

HTTP status: 200
