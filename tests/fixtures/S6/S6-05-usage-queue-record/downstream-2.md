# S6-05-usage-queue-record — response 2/3 (step 2)

## Status line
HTTP/1.1 200 OK

## Response headers (raw, received order)
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json; charset=utf-8
X-Cpa-Build-Date: 2026-09-15T14:07:06Z
X-Cpa-Commit: 8335eac
X-Cpa-Support-Plugin: 1
X-Cpa-Version: v7.3.4
Date: Tue, 15 Sep 2026 17:20:15 GMT
Content-Length: 1282
Connection: close

## Body (exact bytes received, 1282 bytes)
```
[{"timestamp":"2026-09-16T01:20:15.486997548+08:00","latency_ms":5,"ttft_ms":5,"source":"mock-upstream-key","auth_index":"478b008489538d28","client_ip":"172.17.0.1","x_forwarded_for":"","user_agent":"oracle-s3-probe/1.0","tokens":{"input_tokens":9,"output_tokens":6,"reasoning_tokens":0,"cached_tokens":0,"cache_read_tokens":0,"cache_read_tokens_present":true,"cache_creation_tokens":0,"total_tokens":15},"failed":false,"generate":true,"stream":false,"fail":{"status_code":200,"body":""},"response_headers":{"Content-Length":["319"],"Content-Type":["application/json"],"Date":["Tue, 15 Sep 2026 17:20:15 GMT"],"Server":["BaseHTTP/0.6 Python/3.14.6"]},"accounting_version":2,"token_breakdown":{"schema_version":2,"quality":"complete","total_tokens":15,"input":{"total_tokens":9,"uncached_tokens":9,"cache_read_tokens":0,"cache_write_tokens":0},"output":{"total_tokens":6,"non_reasoning_tokens":6,"reasoning_tokens":0},"unclassified_tokens":0},"provider":"openai-compatible-mock-openai","executor_type":"OpenAICompatExecutor","model":"mock-gpt-model","alias":"mock-model","endpoint":"POST /v1/chat/completions","auth_type":"apikey","api_key":"oracle-local-key-1","request_id":"00d1b40e","session_id":"56df030b-7f52-886f-9d7d-51083b02dd3b","reasoning_effort":"","service_tier":"auto"}]
```
