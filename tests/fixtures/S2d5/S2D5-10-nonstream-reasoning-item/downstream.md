## R1

### Response head (exact bytes)
```
HTTP/1.1 200 OK
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json
X-Cpa-Trace-Id: 20260916012735-6dd67e98f20665e0-6fc0c1cd
Date: Tue, 15 Sep 2026 17:27:35 GMT
Content-Length: 425

```

### Body (425 bytes, exact)
```
{"id":"resp_mock_reason_01","object":"chat.completion","created":1770000200,"model":"gpt-mock-codex","choices":[{"index":0,"message":{"role":"assistant","content":"Final answer.","reasoning_content":"Step one done. Step two done.","tool_calls":null},"finish_reason":"stop","native_finish_reason":"stop"}],"usage":{"completion_tokens":4,"total_tokens":14,"prompt_tokens":10,"completion_tokens_details":{"reasoning_tokens":2}}}
```
