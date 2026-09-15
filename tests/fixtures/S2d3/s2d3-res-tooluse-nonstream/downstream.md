# s2d3-res-tooluse-nonstream — response 1/1 (step 1)

## Status line
HTTP/1.1 200 OK

## Response headers (raw, received order)
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json
X-Cpa-Trace-Id: 20260916015659-42f16b36d73439c3-78c505a8
Date: Tue, 15 Sep 2026 17:56:59 GMT
Content-Length: 479
Connection: close

## Body (exact bytes received, 479 bytes)
```
{"id":"msg_tool_01","object":"chat.completion","created":1789495019,"model":"claude-mock-model","choices":[{"index":0,"message":{"role":"assistant","content":"","tool_calls":[{"id":"toolu_mock01","type":"function","function":{"name":"get_weather","arguments":"{\"city\":\"Paris\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":9,"completion_tokens":6,"total_tokens":15,"prompt_tokens_details":{"cached_tokens":0,"cached_creation_tokens":0,"cache_write_tokens":0}}}
```
