# S2d6-stream-toolcalls downstream (exact bytes)

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
X-Cpa-Trace-Id: 20260916043642-47b77fbeb6ecb734-3c910be9
Date: Tue, 15 Sep 2026 20:36:42 GMT
Transfer-Encoding: chunked

```

## full SSE byte stream (incl. trailing bytes)
```
event: response.created
data: {"type":"response.created","sequence_number":1,"response":{"id":"chatcmpl-mock-0001","object":"response","created_at":1770000000,"status":"in_progress","background":false,"error":null,"output":[],"model":"mock-model"}}

event: response.in_progress
data: {"type":"response.in_progress","sequence_number":2,"response":{"id":"chatcmpl-mock-0001","object":"response","created_at":1770000000,"status":"in_progress","output":[],"model":"mock-model"}}

event: response.output_item.added
data: {"type":"response.output_item.added","sequence_number":3,"output_index":0,"item":{"id":"fc_call_mock_tool_01","type":"function_call","status":"in_progress","arguments":"","call_id":"call_mock_tool_01","name":"get_weather"}}

event: response.function_call_arguments.delta
data: {"type":"response.function_call_arguments.delta","sequence_number":4,"item_id":"fc_call_mock_tool_01","output_index":0,"delta":"{\"city\":"}

event: response.function_call_arguments.delta
data: {"type":"response.function_call_arguments.delta","sequence_number":5,"item_id":"fc_call_mock_tool_01","output_index":0,"delta":"\"SF\"}"}

event: response.function_call_arguments.done
data: {"type":"response.function_call_arguments.done","sequence_number":6,"item_id":"fc_call_mock_tool_01","output_index":0,"arguments":"{\"city\":\"SF\"}"}

event: response.output_item.done
data: {"type":"response.output_item.done","sequence_number":7,"output_index":0,"item":{"id":"fc_call_mock_tool_01","type":"function_call","status":"completed","arguments":"{\"city\":\"SF\"}","call_id":"call_mock_tool_01","name":"get_weather"}}

event: response.completed
data: {"type":"response.completed","sequence_number":8,"response":{"id":"chatcmpl-mock-0001","object":"response","created_at":1770000000,"status":"completed","background":false,"error":null,"model":"mock-model","tools":[{"description":"Get current weather","name":"get_weather","parameters":{"properties":{"city":{"type":"string"}},"required":["city"],"type":"object"},"type":"function"}],"output":[{"id":"fc_call_mock_tool_01","type":"function_call","status":"completed","arguments":"{\"city\":\"SF\"}","call_id":"call_mock_tool_01","name":"get_weather"}]}}




```

HTTP status: 200
