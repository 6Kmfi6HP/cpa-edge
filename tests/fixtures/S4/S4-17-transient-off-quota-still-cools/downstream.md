# S4-17-transient-off-quota-still-cools downstream (numbered steps)

## Step 1 — HTTP 500
### Response headers
```
HTTP/1.1 500 Internal Server Error
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json
X-Cpa-Trace-Id: 20260916005906-a42ae2a9f932510a-c213756e
Date: Tue, 15 Sep 2026 16:59:06 GMT
Content-Length: 85

```
### Body
```
{"error": {"message": "mock rate limit", "type": "mock_error", "code": "mock_error"}}

```

## Step 2 — HTTP 500
### Response headers
```
HTTP/1.1 500 Internal Server Error
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json
X-Cpa-Trace-Id: 20260916005906-a42ae2a9f932510a-a5f8abc8
Date: Tue, 15 Sep 2026 16:59:06 GMT
Content-Length: 85

```
### Body
```
{"error": {"message": "mock rate limit", "type": "mock_error", "code": "mock_error"}}

```

## Step 4 — HTTP 429
### Response headers
```
HTTP/1.1 429 Too Many Requests
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json
X-Cpa-Trace-Id: 20260916005906-a42ae2a9f932510a-bf89fa03
Date: Tue, 15 Sep 2026 16:59:06 GMT
Content-Length: 85

```
### Body
```
{"error": {"message": "mock rate limit", "type": "mock_error", "code": "mock_error"}}

```

## Step 5 — HTTP 429
### Response headers
```
HTTP/1.1 429 Too Many Requests
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json
Retry-After: 1
Date: Tue, 15 Sep 2026 16:59:06 GMT
Content-Length: 482

```
### Body
```
{"error":{"code":"model_cooldown","last_upstream_error":"{\"error\": {\"message\": \"mock rate limit\", \"type\": \"mock_error\", \"code\": \"mock_error\"}}","message":"All credentials for model mock-model are cooling down via provider openai-compatible-mock-openai (last error: {\"error\": {\"message\": \"mock rate limit\", \"type\": \"mock_error\", \"code\": \"mock_error\"}})","model":"mock-model","provider":"openai-compatible-mock-openai","reset_seconds":1,"reset_time":"1s"}}

```
