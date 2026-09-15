## R1

### Response head (exact bytes)
```
HTTP/1.1 200 OK
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Cache-Control: no-cache
Connection: keep-alive
Content-Type: text/event-stream
X-Cpa-Trace-Id: 20260916012736-6dd67e98f20665e0-f87b396d
Date: Tue, 15 Sep 2026 17:27:36 GMT
Transfer-Encoding: chunked

```

### Body (326 bytes, exact)
```
data: {"id":"resp_mock_fail_01","object":"chat.completion.chunk","created":1770000600,"model":"gpt-mock-codex","choices":[{"index":0,"delta":{"role":"assistant","content":"Some text."},"finish_reason":null,"native_finish_reason":null}]}

data: {"error":{"code": "server_error", "message": "upstream mock failed mid-stream"}}


```
