# S4-14-unauthorized-terminal-and-hot-reload downstream (numbered steps)

## Step 1 — HTTP 401
### Response headers
```
HTTP/1.1 401 Unauthorized
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json
X-Cpa-Trace-Id: 20260916005858-a42ae2a9f932510a-1710c697
Date: Tue, 15 Sep 2026 16:58:58 GMT
Content-Length: 85

```
### Body
```
{"error": {"message": "mock rate limit", "type": "mock_error", "code": "mock_error"}}

```

## Step 2 — HTTP 503
### Response headers
```
HTTP/1.1 503 Service Unavailable
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json
Date: Tue, 15 Sep 2026 16:58:58 GMT
Content-Length: 331

```
### Body
```
{"error":{"message":"auth_unavailable: no auth available (providers=openai-compatible-mock-openai, model=mock-model; last upstream error: {\"error\": {\"message\": \"mock rate limit\", \"type\": \"mock_error\", \"code\": \"mock_error\"}})","type":"authentication_error","code":"upstream_authentication_required","retryable":false}}

```

## Step 4 — HTTP 503
### Response headers
```
HTTP/1.1 503 Service Unavailable
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json
Date: Tue, 15 Sep 2026 16:59:03 GMT
Content-Length: 331

```
### Body
```
{"error":{"message":"auth_unavailable: no auth available (providers=openai-compatible-mock-openai, model=mock-model; last upstream error: {\"error\": {\"message\": \"mock rate limit\", \"type\": \"mock_error\", \"code\": \"mock_error\"}})","type":"authentication_error","code":"upstream_authentication_required","retryable":false}}

```
