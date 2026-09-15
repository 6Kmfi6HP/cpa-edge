# S4-23-compact-fault-neutral downstream

## Step 1 — HTTP 500
### Headers
```
HTTP/1.1 500 Internal Server Error
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json
X-Cpa-Trace-Id: 20260916041046-f8131d354f71b829-bf71a75c
Date: Tue, 15 Sep 2026 20:10:46 GMT
Content-Length: 107

```
### Body
```
{"error": {"message": "mock rate limit", "type": "rate_limit_exceeded", "code": 500, "status": "INTERNAL"}}

```

## Step 2 — HTTP 500
### Headers
```
HTTP/1.1 500 Internal Server Error
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json
X-Cpa-Trace-Id: 20260916041046-f8131d354f71b829-f6a8288e
Date: Tue, 15 Sep 2026 20:10:46 GMT
Content-Length: 107

```
### Body
```
{"error": {"message": "mock rate limit", "type": "rate_limit_exceeded", "code": 500, "status": "INTERNAL"}}

```

## Step 3 — HTTP 500
### Headers
```
HTTP/1.1 500 Internal Server Error
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json
X-Cpa-Trace-Id: 20260916041046-f8131d354f71b829-1e7df7a7
Date: Tue, 15 Sep 2026 20:10:46 GMT
Content-Length: 107

```
### Body
```
{"error": {"message": "mock rate limit", "type": "rate_limit_exceeded", "code": 500, "status": "INTERNAL"}}

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
Date: Tue, 15 Sep 2026 20:10:46 GMT
Content-Length: 287

```
### Body
```
{"error":{"message":"auth_unavailable: no auth available (providers=codex, model=cxx; last upstream error: {\"error\": {\"message\": \"mock rate limit\", \"type\": \"rate_limit_exceeded\", \"code\": 500, \"status\": \"INTERNAL\"}})","type":"server_error","code":"internal_server_error"}}

```
