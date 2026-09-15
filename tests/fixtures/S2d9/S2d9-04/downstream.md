# S2d9-04 downstream (exact bytes)

## Status line
HTTP/1.1 200 OK

## Response headers (raw, received order)
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json
X-Cpa-Trace-Id: 20260916051059-ddc1112c036d93f5-ea1444b7
Date: Tue, 15 Sep 2026 21:10:59 GMT
Content-Length: 428
Connection: close

## Body / byte stream (exact bytes received, 428 bytes)
```
{"id":"resp_mock_004","object":"response","created_at":1742812800,"status":"completed","model":"mock-codex-upstream","output":[{"id":"msg_mock_004","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"Sunny","annotations":[]}]}],"usage":{"input_tokens":15,"output_tokens":6,"total_tokens":21,"output_tokens_details":{"reasoning_tokens":0},"input_tokens_details":{"cached_tokens":0}}}
```
