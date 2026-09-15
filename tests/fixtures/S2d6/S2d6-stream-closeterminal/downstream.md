# S2d6-stream-closeterminal downstream (exact bytes)

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
X-Cpa-Trace-Id: 20260916044735-47b77fbeb6ecb734-c208bd9d
Date: Tue, 15 Sep 2026 20:47:35 GMT
Transfer-Encoding: chunked

```

## full SSE byte stream (incl. trailing bytes)
```
event: response.created
data: {"type":"response.created","sequence_number":1,"response":{"id":"chatcmpl-mock-0001","object":"response","created_at":1770000000,"status":"in_progress","background":false,"error":null,"output":[],"model":"mock-model"}}

event: response.in_progress
data: {"type":"response.in_progress","sequence_number":2,"response":{"id":"chatcmpl-mock-0001","object":"response","created_at":1770000000,"status":"in_progress","output":[],"model":"mock-model"}}

event: response.output_item.added
data: {"type":"response.output_item.added","sequence_number":3,"output_index":0,"item":{"id":"rs_chatcmpl-mock-0001_0","type":"reasoning","status":"in_progress","summary":[]}}

event: response.reasoning_summary_part.added
data: {"type":"response.reasoning_summary_part.added","sequence_number":4,"item_id":"rs_chatcmpl-mock-0001_0","output_index":0,"summary_index":0,"part":{"type":"summary_text","text":""}}

event: response.reasoning_summary_text.delta
data: {"type":"response.reasoning_summary_text.delta","sequence_number":5,"item_id":"rs_chatcmpl-mock-0001_0","output_index":0,"summary_index":0,"delta":"Pondering."}

event: response.reasoning_summary_text.done
data: {"type":"response.reasoning_summary_text.done","sequence_number":6,"item_id":"rs_chatcmpl-mock-0001_0","output_index":0,"summary_index":0,"text":"Pondering."}

event: response.reasoning_summary_part.done
data: {"type":"response.reasoning_summary_part.done","sequence_number":7,"item_id":"rs_chatcmpl-mock-0001_0","output_index":0,"summary_index":0,"part":{"type":"summary_text","text":"Pondering."}}

event: response.output_item.done
data: {"type":"response.output_item.done","item":{"id":"rs_chatcmpl-mock-0001_0","type":"reasoning","encrypted_content":"","summary":[{"type":"summary_text","text":"Pondering."}]},"output_index":0,"sequence_number":8}


event: error
data: {"type":"error","error":{"code":"internal_server_error","message":"upstream stream closed before a terminal event (last event: response.output_item.done)","param":null,"type":"server_error"},"sequence_number":8}



```

HTTP status: 200
