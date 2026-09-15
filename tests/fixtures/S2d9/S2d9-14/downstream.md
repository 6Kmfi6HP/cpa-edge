# S2d9-14 downstream (exact bytes)

## Status line
HTTP/1.1 200 OK

## Response headers (raw, received order)
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Cache-Control: no-cache
Content-Type: text/event-stream
X-Cpa-Trace-Id: 20260916051103-ddc1112c036d93f5-946459af
Date: Tue, 15 Sep 2026 21:11:03 GMT
Connection: close
Transfer-Encoding: chunked

## Body / byte stream (Transfer-Encoding: chunked framing preserved) (exact bytes received, 570 bytes)
```
event: response.created
data: {"type":"response.created","sequence_number":0,"response":{"id":"resp_mock_014","object":"response","created_at":1742812800,"status":"in_progress","model":"mock-codex-upstream","output":[]}}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":1,"item_id":"msg_mock_014","output_index":0,"content_index":0,"delta":"partial"}


event: response.failed
data: {"type":"response.failed","sequence_number":2,"response":{"status":"failed","error":{"code":"server_error","message":"upstream exploded"}}}


```

## Body (raw chunked stream as received)
```
de
event: response.created
data: {"type":"response.created","sequence_number":0,"response":{"id":"resp_mock_014","object":"response","created_at":1742812800,"status":"in_progress","model":"mock-codex-upstream","output":[]}}


b1
event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":1,"item_id":"msg_mock_014","output_index":0,"content_index":0,"delta":"partial"}


ab

event: response.failed
data: {"type":"response.failed","sequence_number":2,"response":{"status":"failed","error":{"code":"server_error","message":"upstream exploded"}}}


0


```
