# S2d8-01-nostream-basic downstream (exact bytes; body)

## Status + headers
```
HTTP/1.1 200 OK
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json
X-Cpa-Trace-Id: 20260916043304-8003f8df5449db3b-5ca65e41
Date: Tue, 15 Sep 2026 20:33:04 GMT
Content-Length: 238

```

## body
```
{"id":"","type":"message","role":"assistant","model":"gemini-mock-model","content":[{"type":"text","text":"Hello from mock gemini upstream more"}],"stop_reason":"end_turn","stop_sequence":null,"usage":{"input_tokens":9,"output_tokens":6}}

```

HTTP status: 200
