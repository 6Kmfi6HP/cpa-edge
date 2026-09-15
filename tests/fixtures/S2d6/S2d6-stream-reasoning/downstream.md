# S2d6-stream-reasoning downstream (exact bytes)

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
X-Cpa-Trace-Id: 20260916043643-47b77fbeb6ecb734-6555a76a
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
data: {"type":"response.output_item.added","sequence_number":3,"output_index":0,"item":{"id":"rs_chatcmpl-mock-0001_0","type":"reasoning","status":"in_progress","summary":[]}}

event: response.reasoning_summary_part.added
data: {"type":"response.reasoning_summary_part.added","sequence_number":4,"item_id":"rs_chatcmpl-mock-0001_0","output_index":0,"summary_index":0,"part":{"type":"summary_text","text":""}}

event: response.reasoning_summary_text.delta
data: {"type":"response.reasoning_summary_text.delta","sequence_number":5,"item_id":"rs_chatcmpl-mock-0001_0","output_index":0,"summary_index":0,"delta":"Let me think."}

event: response.reasoning_summary_text.delta
data: {"type":"response.reasoning_summary_text.delta","sequence_number":6,"item_id":"rs_chatcmpl-mock-0001_0","output_index":0,"summary_index":0,"delta":" Carefully."}

event: response.reasoning_summary_text.done
data: {"type":"response.reasoning_summary_text.done","sequence_number":7,"item_id":"rs_chatcmpl-mock-0001_0","output_index":0,"summary_index":0,"text":"Let me think. Carefully."}

event: response.reasoning_summary_part.done
data: {"type":"response.reasoning_summary_part.done","sequence_number":8,"item_id":"rs_chatcmpl-mock-0001_0","output_index":0,"summary_index":0,"part":{"type":"summary_text","text":"Let me think. Carefully."}}

event: response.output_item.done
data: {"type":"response.output_item.done","item":{"id":"rs_chatcmpl-mock-0001_0","type":"reasoning","encrypted_content":"","summary":[{"type":"summary_text","text":"Let me think. Carefully."}]},"output_index":0,"sequence_number":9}

event: response.output_item.added
data: {"type":"response.output_item.added","sequence_number":10,"output_index":1,"item":{"id":"msg_chatcmpl-mock-0001_0","type":"message","status":"in_progress","content":[],"role":"assistant"}}

event: response.content_part.added
data: {"type":"response.content_part.added","sequence_number":11,"item_id":"msg_chatcmpl-mock-0001_0","output_index":1,"content_index":0,"part":{"type":"output_text","annotations":[],"logprobs":[],"text":""}}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":12,"item_id":"msg_chatcmpl-mock-0001_0","output_index":1,"content_index":0,"delta":"Hi there","logprobs":[]}

event: response.output_text.done
data: {"type":"response.output_text.done","sequence_number":13,"item_id":"msg_chatcmpl-mock-0001_0","output_index":1,"content_index":0,"text":"Hi there","logprobs":[]}

event: response.content_part.done
data: {"type":"response.content_part.done","sequence_number":14,"item_id":"msg_chatcmpl-mock-0001_0","output_index":1,"content_index":0,"part":{"type":"output_text","annotations":[],"logprobs":[],"text":"Hi there"}}

event: response.output_item.done
data: {"type":"response.output_item.done","sequence_number":15,"output_index":1,"item":{"id":"msg_chatcmpl-mock-0001_0","type":"message","status":"completed","content":[{"type":"output_text","annotations":[],"logprobs":[],"text":"Hi there"}],"role":"assistant"}}

event: response.completed
data: {"type":"response.completed","sequence_number":16,"response":{"id":"chatcmpl-mock-0001","object":"response","created_at":1770000000,"status":"completed","background":false,"error":null,"model":"mock-model","reasoning":{"effort":"high"},"output":[{"id":"rs_chatcmpl-mock-0001_0","type":"reasoning","summary":[{"type":"summary_text","text":"Let me think. Carefully."}]},{"id":"msg_chatcmpl-mock-0001_0","type":"message","status":"completed","content":[{"type":"output_text","annotations":[],"logprobs":[],"text":"Hi there"}],"role":"assistant"}]}}




```

HTTP status: 200
