# S2d6-nostream-custom-tool downstream (exact bytes)

## Status + headers
```
HTTP/1.1 200 OK
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json
X-Cpa-Trace-Id: 20260916043639-47b77fbeb6ecb734-0213974a
Date: Tue, 15 Sep 2026 20:36:39 GMT
Content-Length: 675

```

## body
```
{"id":"chatcmpl-mock-0001","object":"response","created_at":1770000000,"status":"completed","background":false,"error":null,"incomplete_details":null,"model":"mock-gpt-model","tools":[{"function":{"description":"Apply a patch","name":"apply_patch","parameters":{"properties":{"input":{"type":"string"}},"required":["input"],"type":"object"}},"type":"function"}],"output":[{"id":"ctc_ct_mock_02","type":"custom_tool_call","status":"completed","input":"*** Begin Patch\n+hello","call_id":"ct_mock_02","name":"apply_patch"}],"usage":{"input_tokens":9,"output_tokens":6,"total_tokens":15,"output_tokens_details":{"reasoning_tokens":0},"input_tokens_details":{"cached_tokens":0}}}

```

HTTP status: 200
