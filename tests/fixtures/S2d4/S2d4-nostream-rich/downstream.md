# S2d4-nostream-rich downstream (exact bytes, 1 step)

## STEP 1 — POST /v1/messages

### Status + response headers (received order)
```
HTTP/1.1 200 OK
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json
X-Cpa-Trace-Id: 20260916051004-4236bb647a544144-adee7347
Date: Tue, 15 Sep 2026 21:10:04 GMT
Content-Length: 453
```

### Body
```
{"id":"chatcmpl-rich-0001","type":"message","role":"assistant","model":"mock-gpt-model","content":[{"type":"text","text":"It is sunny in Paris."},{"type":"thinking","thinking":"deciding how to answer"},{"type":"tool_use","id":"call_rich_1","name":"Get_Weather","input":{"city":"Paris","unit":"C"}}],"stop_reason":"tool_use","stop_sequence":null,"usage":{"input_tokens":90,"output_tokens":13,"cache_read_input_tokens":30,"cache_creation_input_tokens":5}}
```

HTTP status: 200
