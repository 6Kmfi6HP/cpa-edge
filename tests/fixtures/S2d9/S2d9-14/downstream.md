# S2d9-14 downstream (exact bytes)

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
X-Cpa-Trace-Id: 20260916005213-d2c426aebf9f2c5c-da9f2708
Date: Tue, 15 Sep 2026 16:52:13 GMT
Transfer-Encoding: chunked

```

## Body / byte stream
```
event: response.created
data: {"type":"response.created","sequence_number":0,"response":{"id":"resp_mock_014","object":"response","created_at":1742812800,"status":"in_progress","model":"mock-codex-upstream","output":[]}}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":1,"item_id":"msg_mock_014","output_index":0,"content_index":0,"delta":"partial"}


event: response.failed
data: {"type":"response.failed","sequence_number":2,"response":{"status":"failed","error":{"code":"server_error","message":"upstream exploded"}}}



```

HTTP status: 200
