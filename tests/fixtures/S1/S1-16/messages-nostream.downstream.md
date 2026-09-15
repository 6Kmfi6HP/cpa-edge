# S1-16 / messages-nostream — downstream response (exact bytes)

## Status + response headers (received order)
```
HTTP/1.1 200 OK
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json
X-Cpa-Trace-Id: 20260916004708-47b77fbeb6ecb734-5b9cfb4d
Date: Tue, 15 Sep 2026 16:47:08 GMT
Content-Length: 253

```

## Body (stdout)
```
{"id":"chatcmpl-mock-0001","type":"message","role":"assistant","model":"mock-gpt-model","content":[{"type":"text","text":"Hello from mock openai upstream more"}],"stop_reason":"end_turn","stop_sequence":null,"usage":{"input_tokens":9,"output_tokens":6}}
```

HTTP status: 200
