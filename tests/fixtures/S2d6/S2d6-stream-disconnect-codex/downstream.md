# S2d6-stream-disconnect-codex downstream (exact bytes)

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
X-Cpa-Trace-Id: 20260916043643-47b77fbeb6ecb734-c20bec1c
Date: Tue, 15 Sep 2026 20:36:43 GMT
Transfer-Encoding: chunked

```

## full SSE byte stream (incl. trailing bytes)
```
event: response.created
data: {"type":"response.created","sequence_number":1,"response":{"id":"chatcmpl-mock-0001","object":"response","created_at":1770000000,"status":"in_progress","background":false,"error":null,"output":[],"model":"mock-model"}}

event: response.in_progress
data: {"type":"response.in_progress","sequence_number":2,"response":{"id":"chatcmpl-mock-0001","object":"response","created_at":1770000000,"status":"in_progress","output":[],"model":"mock-model"}}

event: response.output_item.added
data: {"type":"response.output_item.added","sequence_number":3,"output_index":0,"item":{"id":"msg_chatcmpl-mock-0001_0","type":"message","status":"in_progress","content":[],"role":"assistant"}}

event: response.content_part.added
data: {"type":"response.content_part.added","sequence_number":4,"item_id":"msg_chatcmpl-mock-0001_0","output_index":0,"content_index":0,"part":{"type":"output_text","annotations":[],"logprobs":[],"text":""}}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":5,"item_id":"msg_chatcmpl-mock-0001_0","output_index":0,"content_index":0,"delta":"Hello from mock openai upstream","logprobs":[]}


event: response.failed
data: {"type":"response.failed","sequence_number":5,"response":{"status":"failed","error":{"code":"internal_server_error","message":"unexpected EOF","param":null,"type":"server_error"}}}



```

HTTP status: 200
