# S6-15-hot-reload-provider — response 1/2 (step 1)

## Status line
HTTP/1.1 200 OK

## Response headers (raw, received order)
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json; charset=utf-8
Date: Tue, 15 Sep 2026 17:29:56 GMT
Content-Length: 597
Connection: close

## Body (exact bytes received, 597 bytes)
```
{"data":[{"created":1789493395,"id":"xg","object":"model","owned_by":"xai"},{"created":1789493395,"id":"mm","object":"model","owned_by":"meta"},{"created":1789493395,"id":"mock-model","object":"model","owned_by":"mock-openai"},{"created":1789493395,"id":"vm","object":"model","owned_by":"google"},{"created":1789493395,"id":"gm","object":"model","owned_by":"google"},{"created":1789493395,"id":"im","object":"model","owned_by":"google"},{"created":1789493395,"id":"cm","object":"model","owned_by":"anthropic"},{"created":1789493395,"id":"cx","object":"model","owned_by":"openai"}],"object":"list"}
```
