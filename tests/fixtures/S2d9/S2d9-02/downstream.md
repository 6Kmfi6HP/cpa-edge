# S2d9-02 downstream (exact bytes)

## Status line
HTTP/1.1 200 OK

## Response headers (raw, received order)
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Cache-Control: no-cache
Content-Type: text/event-stream
X-Cpa-Trace-Id: 20260916051058-ddc1112c036d93f5-e6f7d146
Date: Tue, 15 Sep 2026 21:10:58 GMT
Connection: close
Transfer-Encoding: chunked

## Body / byte stream (Transfer-Encoding: chunked framing preserved) (exact bytes received, 2029 bytes)
```
event: response.created
data: {"type":"response.created","sequence_number":0,"response":{"id":"resp_mock_002","object":"response","created_at":1742812800,"status":"in_progress","output":[],"model":"codex-mock"}}

event: response.output_item.added
data: {"type":"response.output_item.added","sequence_number":1,"output_index":0,"item":{"id":"msg_mock_002","type":"message","status":"in_progress","role":"assistant","content":[]}}

event: response.content_part.added
data: {"type":"response.content_part.added","sequence_number":2,"item_id":"msg_mock_002","output_index":0,"content_index":0,"part":{"type":"output_text","text":"","annotations":[]}}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":3,"item_id":"msg_mock_002","output_index":0,"content_index":0,"delta":"Hello"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":4,"item_id":"msg_mock_002","output_index":0,"content_index":0,"delta":" world"}

event: response.content_part.done
data: {"type":"response.content_part.done","sequence_number":5,"item_id":"msg_mock_002","output_index":0,"content_index":0,"part":{"type":"output_text","text":"Hello world","annotations":[]}}

event: response.output_item.done
data: {"type":"response.output_item.done","sequence_number":6,"output_index":0,"item":{"id":"msg_mock_002","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"Hello world","annotations":[]}]}}

event: response.completed
data: {"type":"response.completed","sequence_number":7,"response":{"id":"resp_mock_002","object":"response","created_at":1742812800,"status":"completed","model":"mock-codex-upstream","output":[{"id":"msg_mock_002","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"Hello world","annotations":[]}]}],"usage":{"input_tokens":12,"input_tokens_details":{"cached_tokens":5},"output_tokens":7,"output_tokens_details":{"reasoning_tokens":3},"total_tokens":19}}}



```

## Body (raw chunked stream as received)
```
d5
event: response.created
data: {"type":"response.created","sequence_number":0,"response":{"id":"resp_mock_002","object":"response","created_at":1742812800,"status":"in_progress","output":[],"model":"codex-mock"}}


d9
event: response.output_item.added
data: {"type":"response.output_item.added","sequence_number":1,"output_index":0,"item":{"id":"msg_mock_002","type":"message","status":"in_progress","role":"assistant","content":[]}}


da
event: response.content_part.added
data: {"type":"response.content_part.added","sequence_number":2,"item_id":"msg_mock_002","output_index":0,"content_index":0,"part":{"type":"output_text","text":"","annotations":[]}}


af
event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":3,"item_id":"msg_mock_002","output_index":0,"content_index":0,"delta":"Hello"}


b0
event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":4,"item_id":"msg_mock_002","output_index":0,"content_index":0,"delta":" world"}


e3
event: response.content_part.done
data: {"type":"response.content_part.done","sequence_number":5,"item_id":"msg_mock_002","output_index":0,"content_index":0,"part":{"type":"output_text","text":"Hello world","annotations":[]}}


111
event: response.output_item.done
data: {"type":"response.output_item.done","sequence_number":6,"output_index":0,"item":{"id":"msg_mock_002","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"Hello world","annotations":[]}]}}


211
event: response.completed
data: {"type":"response.completed","sequence_number":7,"response":{"id":"resp_mock_002","object":"response","created_at":1742812800,"status":"completed","model":"mock-codex-upstream","output":[{"id":"msg_mock_002","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"Hello world","annotations":[]}]}],"usage":{"input_tokens":12,"input_tokens_details":{"cached_tokens":5},"output_tokens":7,"output_tokens_details":{"reasoning_tokens":3},"total_tokens":19}}}


1


0


```
