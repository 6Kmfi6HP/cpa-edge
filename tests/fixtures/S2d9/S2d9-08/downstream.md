# S2d9-08 downstream (exact bytes)

## Status line
HTTP/1.1 200 OK

## Response headers (raw, received order)
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Cache-Control: no-cache
Content-Type: text/event-stream
X-Cpa-Trace-Id: 20260916051100-ddc1112c036d93f5-b50016f0
Date: Tue, 15 Sep 2026 21:11:00 GMT
Connection: close
Transfer-Encoding: chunked

## Body / byte stream (Transfer-Encoding: chunked framing preserved) (exact bytes received, 865 bytes)
```
event: response.created
data: {"type":"response.created","sequence_number":0,"response":{"id":"resp_mock_008","object":"response","created_at":1742812800,"status":"in_progress","model":"mock-codex-upstream","output":[]}}

event: response.output_item.added
data: {"type":"response.output_item.added","sequence_number":1,"output_index":0,"item":{"id":"msg_mock_008","type":"message","status":"in_progress","role":"assistant","content":[]}}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":2,"item_id":"msg_mock_008","output_index":0,"content_index":0,"delta":"partial answer"}


event: error
data: {"type":"error","error":{"code":"request_timeout","message":"stream error: stream disconnected before completion: stream closed before response.completed","param":null,"type":"invalid_request_error"},"sequence_number":3}


```

## Body (raw chunked stream as received)
```
de
event: response.created
data: {"type":"response.created","sequence_number":0,"response":{"id":"resp_mock_008","object":"response","created_at":1742812800,"status":"in_progress","model":"mock-codex-upstream","output":[]}}


d9
event: response.output_item.added
data: {"type":"response.output_item.added","sequence_number":1,"output_index":0,"item":{"id":"msg_mock_008","type":"message","status":"in_progress","role":"assistant","content":[]}}


b8
event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":2,"item_id":"msg_mock_008","output_index":0,"content_index":0,"delta":"partial answer"}


f2

event: error
data: {"type":"error","error":{"code":"request_timeout","message":"stream error: stream disconnected before completion: stream closed before response.completed","param":null,"type":"invalid_request_error"},"sequence_number":3}


0


```
