# S2d9-07 downstream (exact bytes)

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
X-Cpa-Trace-Id: 20260916005211-d2c426aebf9f2c5c-124611e4
Date: Tue, 15 Sep 2026 16:52:11 GMT
Transfer-Encoding: chunked

```

## Body / byte stream
```
event: response.created
data: {"type":"response.created","sequence_number":0,"response":{"id":"resp_mock_007","object":"response","created_at":1742812800,"status":"in_progress","model":"mock-codex-upstream","output":[]}}

event: response.output_item.added
data: {"type":"response.output_item.added","sequence_number":1,"output_index":0,"item":{"id":"msg_mock_007","type":"message","status":"in_progress","role":"assistant","content":[]}}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":2,"item_id":"msg_mock_007","output_index":0,"content_index":0,"delta":"Lite"}

event: response.output_item.done
data: {"type":"response.output_item.done","sequence_number":3,"output_index":0,"item":{"id":"msg_mock_007","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"Lite","annotations":[]}]}}

event: response.completed
data: {"type":"response.completed","sequence_number":4,"response":{"id":"resp_mock_007","object":"response","created_at":1742812800,"status":"completed","model":"mock-codex-upstream","output":[{"id":"msg_mock_007","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"Lite","annotations":[]}]}],"usage":{"input_tokens":6,"output_tokens":4,"total_tokens":10,"output_tokens_details":{"reasoning_tokens":0},"input_tokens_details":{"cached_tokens":0}}}}




```

HTTP status: 200
