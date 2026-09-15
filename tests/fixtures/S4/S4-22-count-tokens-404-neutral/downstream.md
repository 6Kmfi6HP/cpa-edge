# S4-22-count-tokens-404-neutral downstream

## Step 1 — HTTP 404
### Headers
```
HTTP/1.1 404 Not Found
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json
X-Cpa-Trace-Id: 20260916021855-fe64834399ed1d3b-16bd7030
Date: Tue, 15 Sep 2026 18:18:55 GMT
Content-Length: 77

```
### Body
```
{"error": {"code": 404, "message": "mock rate limit", "status": "NOT_FOUND"}}

```

## Step 2 — HTTP 404
### Headers
```
HTTP/1.1 404 Not Found
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json
X-Cpa-Trace-Id: 20260916021855-fe64834399ed1d3b-c3870f64
Date: Tue, 15 Sep 2026 18:18:55 GMT
Content-Length: 77

```
### Body
```
{"error": {"code": 404, "message": "mock rate limit", "status": "NOT_FOUND"}}

```

## Step 3 — HTTP 404
### Headers
```
HTTP/1.1 404 Not Found
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json
X-Cpa-Trace-Id: 20260916021855-fe64834399ed1d3b-365ed113
Date: Tue, 15 Sep 2026 18:18:55 GMT
Content-Length: 77

```
### Body
```
{"error": {"code": 404, "message": "mock rate limit", "status": "NOT_FOUND"}}

```

## Step 4 — HTTP 503
### Headers
```
HTTP/1.1 503 Service Unavailable
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json
Date: Tue, 15 Sep 2026 18:18:55 GMT
Content-Length: 254

```
### Body
```
{"error":{"message":"auth_unavailable: no auth available (providers=gemini, model=ctm; last upstream error: {\"error\": {\"code\": 404, \"message\": \"mock rate limit\", \"status\": \"NOT_FOUND\"}})","type":"server_error","code":"internal_server_error"}}

```
