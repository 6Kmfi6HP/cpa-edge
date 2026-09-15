# S2d8-07-nostream-thinking downstream (exact bytes; body)

## Status + headers
```
HTTP/1.1 200 OK
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json
X-Cpa-Trace-Id: 20260916043306-8003f8df5449db3b-3c813edb
Date: Tue, 15 Sep 2026 20:33:06 GMT
Content-Length: 330

```

## body
```
{"id":"","type":"message","role":"assistant","model":"gemini-mock-model","content":[{"type":"thinking","thinking":"User wants arithmetic.","signature":"sig-mock-1"},{"type":"text","text":"The answer is 42."}],"stop_reason":"end_turn","stop_sequence":null,"usage":{"input_tokens":17,"output_tokens":10,"cache_read_input_tokens":3}}

```

HTTP status: 200
