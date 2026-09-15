## R1

### Response head (exact bytes)
```
HTTP/1.1 200 OK
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json
X-Cpa-Trace-Id: 20260916011804-88c6027083ccc8bc-661704f5
Date: Tue, 15 Sep 2026 17:18:04 GMT
Content-Length: 303

```

### Body (303 bytes, exact)
```
{"candidates":[{"content":{"parts":[{"functionCall":{"id":"call_mock_tool_1","name":"get_weather","args":{"city":"Paris","unit":"celsius"}}}],"role":"model"},"index":0,"finishReason":"STOP"}],"model":"mock-gpt-model","usageMetadata":{"promptTokenCount":21,"candidatesTokenCount":7,"totalTokenCount":28}}
```
