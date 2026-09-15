# S2d6-nostream-basic downstream (exact bytes)

## Status + headers
```
HTTP/1.1 200 OK
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json
X-Cpa-Trace-Id: 20260916043638-47b77fbeb6ecb734-8dcdcd6b
Date: Tue, 15 Sep 2026 20:36:38 GMT
Content-Length: 566

```

## body
```
{"id":"chatcmpl-mock-0001","object":"response","created_at":1770000000,"status":"completed","background":false,"error":null,"incomplete_details":null,"max_output_tokens":128,"model":"mock-gpt-model","output":[{"id":"msg_chatcmpl-mock-0001_0","type":"message","status":"completed","content":[{"type":"output_text","annotations":[],"logprobs":[],"text":"Hello from mock openai upstream more"}],"role":"assistant"}],"usage":{"input_tokens":9,"output_tokens":6,"total_tokens":15,"output_tokens_details":{"reasoning_tokens":0},"input_tokens_details":{"cached_tokens":0}}}

```

HTTP status: 200
