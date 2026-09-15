# S2d8-04-nostream-tool-call downstream (exact bytes; body)

## Status + headers
```
HTTP/1.1 200 OK
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json
X-Cpa-Trace-Id: 20260916043305-8003f8df5449db3b-49b8af65
Date: Tue, 15 Sep 2026 20:33:05 GMT
Content-Length: 281

```

## body
```
{"id":"","type":"message","role":"assistant","model":"gemini-mock-model","content":[{"type":"tool_use","id":"get_weather-1","name":"get weather","input":{"city":"Paris","unit":"celsius"}}],"stop_reason":"tool_use","stop_sequence":null,"usage":{"input_tokens":25,"output_tokens":4}}

```

HTTP status: 200
