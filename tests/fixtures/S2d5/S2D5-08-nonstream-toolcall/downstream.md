## R1

### Response head (exact bytes)
```
HTTP/1.1 200 OK
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json
X-Cpa-Trace-Id: 20260916012735-6dd67e98f20665e0-deef64c7
Date: Tue, 15 Sep 2026 17:27:35 GMT
Content-Length: 517

```

### Body (517 bytes, exact)
```
{"id":"resp_mock_tool_01","object":"chat.completion","created":1770000100,"model":"gpt-mock-codex","choices":[{"index":0,"message":{"role":"assistant","content":null,"reasoning_content":null,"tool_calls":[{"id":"call_mock_01","type":"function","function":{"name":"mcp__atlassian__jira_search_issues_with_advanced_filters_and_pagination_options","arguments":"{\"q\":\"table\"}"}}]},"finish_reason":"tool_calls","native_finish_reason":"tool_calls"}],"usage":{"completion_tokens":3,"total_tokens":15,"prompt_tokens":12}}
```
