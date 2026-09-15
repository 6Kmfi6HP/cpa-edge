# S2d9-06 downstream (exact bytes)

## Status line
HTTP/1.1 200 OK

## Response headers (raw, received order)
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Cache-Control: no-cache
Content-Type: text/event-stream
X-Cpa-Trace-Id: 20260916051059-ddc1112c036d93f5-652f1e91
Date: Tue, 15 Sep 2026 21:10:59 GMT
Connection: close
Transfer-Encoding: chunked

## Body / byte stream (Transfer-Encoding: chunked framing preserved) (exact bytes received, 1395 bytes)
```
event: response.created
data: {"type":"response.created","sequence_number":0,"response":{"id":"resp_mock_006","object":"response","created_at":1742812800,"status":"in_progress","model":"mock-codex-upstream","output":[]}}

event: response.output_item.added
data: {"type":"response.output_item.added","sequence_number":1,"output_index":0,"item":{"id":"msg_mock_006","type":"message","status":"in_progress","role":"assistant","content":[]}}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":2,"item_id":"msg_mock_006","output_index":0,"content_index":0,"delta":"Ok"}

event: response.output_item.done
data: {"type":"response.output_item.done","sequence_number":3,"output_index":0,"item":{"id":"msg_mock_006","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"Ok","annotations":[]}]}}

event: response.completed
data: {"type":"response.completed","sequence_number":4,"response":{"id":"resp_mock_006","object":"response","created_at":1742812800,"status":"completed","model":"mock-codex-upstream","output":[{"id":"msg_mock_006","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"Ok","annotations":[]}]}],"usage":{"input_tokens":9,"output_tokens":2,"total_tokens":11,"output_tokens_details":{"reasoning_tokens":0},"input_tokens_details":{"cached_tokens":0}}}}



```

## Body (raw chunked stream as received)
```
de
event: response.created
data: {"type":"response.created","sequence_number":0,"response":{"id":"resp_mock_006","object":"response","created_at":1742812800,"status":"in_progress","model":"mock-codex-upstream","output":[]}}


d9
event: response.output_item.added
data: {"type":"response.output_item.added","sequence_number":1,"output_index":0,"item":{"id":"msg_mock_006","type":"message","status":"in_progress","role":"assistant","content":[]}}


ac
event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":2,"item_id":"msg_mock_006","output_index":0,"content_index":0,"delta":"Ok"}


108
event: response.output_item.done
data: {"type":"response.output_item.done","sequence_number":3,"output_index":0,"item":{"id":"msg_mock_006","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"Ok","annotations":[]}]}}


207
event: response.completed
data: {"type":"response.completed","sequence_number":4,"response":{"id":"resp_mock_006","object":"response","created_at":1742812800,"status":"completed","model":"mock-codex-upstream","output":[{"id":"msg_mock_006","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"Ok","annotations":[]}]}],"usage":{"input_tokens":9,"output_tokens":2,"total_tokens":11,"output_tokens_details":{"reasoning_tokens":0},"input_tokens_details":{"cached_tokens":0}}}}


1


0


```
