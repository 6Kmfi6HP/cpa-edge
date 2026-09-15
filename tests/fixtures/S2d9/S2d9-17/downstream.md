# S2d9-17 downstream (exact bytes)

## Status line
HTTP/1.1 200 OK

## Response headers (raw, received order)
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Cache-Control: no-cache
Content-Type: text/event-stream
X-Cpa-Trace-Id: 20260916051101-ddc1112c036d93f5-3f3d24b1
Date: Tue, 15 Sep 2026 21:11:01 GMT
Connection: close
Transfer-Encoding: chunked

## Body / byte stream (Transfer-Encoding: chunked framing preserved) (exact bytes received, 929 bytes)
```
event: response.created
data: {"type":"response.created","sequence_number":0,"response":{"id":"resp_mock_017","object":"response","created_at":1742812800,"status":"in_progress","model":"mock-codex-upstream","output":[]}}

: keepalive
event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":1,"item_id":"msg_mock_017","output_index":0,"content_index":0,"delta":"Slow"}

event: response.completed
data: {"type":"response.completed","sequence_number":2,"response":{"id":"resp_mock_017","object":"response","created_at":1742812800,"status":"completed","model":"mock-codex-upstream","output":[{"id":"msg_mock_017","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"Slow","annotations":[]}]}],"usage":{"input_tokens":8,"output_tokens":1,"total_tokens":9,"output_tokens_details":{"reasoning_tokens":0},"input_tokens_details":{"cached_tokens":0}}}}



```

## Body (raw chunked stream as received)
```
de
event: response.created
data: {"type":"response.created","sequence_number":0,"response":{"id":"resp_mock_017","object":"response","created_at":1742812800,"status":"in_progress","model":"mock-codex-upstream","output":[]}}


ba
: keepalive
event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":1,"item_id":"msg_mock_017","output_index":0,"content_index":0,"delta":"Slow"}


208
event: response.completed
data: {"type":"response.completed","sequence_number":2,"response":{"id":"resp_mock_017","object":"response","created_at":1742812800,"status":"completed","model":"mock-codex-upstream","output":[{"id":"msg_mock_017","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"Slow","annotations":[]}]}],"usage":{"input_tokens":8,"output_tokens":1,"total_tokens":9,"output_tokens_details":{"reasoning_tokens":0},"input_tokens_details":{"cached_tokens":0}}}}


1


0


```
