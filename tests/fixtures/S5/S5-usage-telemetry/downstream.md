# S5-usage-telemetry downstream (exact bytes, 5 steps)

## STEP 1 — GET /v0/management/api-key-usage

### Status + response headers (received order)
```
HTTP/1.1 200 OK
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json; charset=utf-8
X-Cpa-Build-Date: 2026-09-15T14:07:06Z
X-Cpa-Commit: 8335eac
X-Cpa-Support-Plugin: 1
X-Cpa-Version: v7.3.4
Date: Tue, 15 Sep 2026 17:00:16 GMT
Transfer-Encoding: chunked
```

### Body
```
{"claude":{"http://host.docker.internal:22002|mock-claude-key":{"success":0,"failed":0,"recent_requests":[{"time":"21:50-22:00","success":0,"failed":0},{"time":"22:00-22:10","success":0,"failed":0},{"time":"22:10-22:20","success":0,"failed":0},{"time":"22:20-22:30","success":0,"failed":0},{"time":"22:30-22:40","success":0,"failed":0},{"time":"22:40-22:50","success":0,"failed":0},{"time":"22:50-23:00","success":0,"failed":0},{"time":"23:00-23:10","success":0,"failed":0},{"time":"23:10-23:20","success":0,"failed":0},{"time":"23:20-23:30","success":0,"failed":0},{"time":"23:30-23:40","success":0,"failed":0},{"time":"23:40-23:50","success":0,"failed":0},{"time":"23:50-00:00","success":0,"failed":0},{"time":"00:00-00:10","success":0,"failed":0},{"time":"00:10-00:20","success":0,"failed":0},{"time":"00:20-00:30","success":0,"failed":0},{"time":"00:30-00:40","success":0,"failed":0},{"time":"00:40-00:50","success":0,"failed":0},{"time":"00:50-01:00","success":0,"failed":0},{"time":"01:00-01:10","success":0,"failed":0}]}},"codex":{"http://host.docker.internal:22003|mock-codex-key":{"success":0,"failed":0,"recent_requests":[{"time":"21:50-22:00","success":0,"failed":0},{"time":"22:00-22:10","success":0,"failed":0},{"time":"22:10-22:20","success":0,"failed":0},{"time":"22:20-22:30","success":0,"failed":0},{"time":"22:30-22:40","success":0,"failed":0},{"time":"22:40-22:50","success":0,"failed":0},{"time":"22:50-23:00","success":0,"failed":0},{"time":"23:00-23:10","success":0,"failed":0},{"time":"23:10-23:20","success":0,"failed":0},{"time":"23:20-23:30","success":0,"failed":0},{"time":"23:30-23:40","success":0,"failed":0},{"time":"23:40-23:50","success":0,"failed":0},{"time":"23:50-00:00","success":0,"failed":0},{"time":"00:00-00:10","success":0,"failed":0},{"time":"00:10-00:20","success":0,"failed":0},{"time":"00:20-00:30","success":0,"failed":0},{"time":"00:30-00:40","success":0,"failed":0},{"time":"00:40-00:50","success":0,"failed":0},{"time":"00:50-01:00","success":0,"failed":0},{"time":"01:00-01:10","success":0,"failed":0}]}},"gemini":{"http://host.docker.internal:22001|mock-gem-key":{"success":0,"failed":0,"recent_requests":[{"time":"21:50-22:00","success":0,"failed":0},{"time":"22:00-22:10","success":0,"failed":0},{"time":"22:10-22:20","success":0,"failed":0},{"time":"22:20-22:30","success":0,"failed":0},{"time":"22:30-22:40","success":0,"failed":0},{"time":"22:40-22:50","success":0,"failed":0},{"time":"22:50-23:00","success":0,"failed":0},{"time":"23:00-23:10","success":0,"failed":0},{"time":"23:10-23:20","success":0,"failed":0},{"time":"23:20-23:30","success":0,"failed":0},{"time":"23:30-23:40","success":0,"failed":0},{"time":"23:40-23:50","success":0,"failed":0},{"time":"23:50-00:00","success":0,"failed":0},{"time":"00:00-00:10","success":0,"failed":0},{"time":"00:10-00:20","success":0,"failed":0},{"time":"00:20-00:30","success":0,"failed":0},{"time":"00:30-00:40","success":0,"failed":0},{"time":"00:40-00:50","success":0,"failed":0},{"time":"00:50-01:00","success":0,"failed":0},{"time":"01:00-01:10","success":0,"failed":0}]}},"gemini-interactions":{"http://host.docker.internal:22006|mock-int-key":{"success":0,"failed":0,"recent_requests":[{"time":"21:50-22:00","success":0,"failed":0},{"time":"22:00-22:10","success":0,"failed":0},{"time":"22:10-22:20","success":0,"failed":0},{"time":"22:20-22:30","success":0,"failed":0},{"time":"22:30-22:40","success":0,"failed":0},{"time":"22:40-22:50","success":0,"failed":0},{"time":"22:50-23:00","success":0,"failed":0},{"time":"23:00-23:10","success":0,"failed":0},{"time":"23:10-23:20","success":0,"failed":0},{"time":"23:20-23:30","success":0,"failed":0},{"time":"23:30-23:40","success":0,"failed":0},{"time":"23:40-23:50","success":0,"failed":0},{"time":"23:50-00:00","success":0,"failed":0},{"time":"00:00-00:10","success":0,"failed":0},{"time":"00:10-00:20","success":0,"failed":0},{"time":"00:20-00:30","success":0,"failed":0},{"time":"00:30-00:40","success":0,"failed":0},{"time":"00:40-00:50","success":0,"failed":0},{"time":"00:50-01:00","success":0,"failed":0},{"time":"01:00-01:10","success":0,"failed":0}]}},"meta":{"http://host.docker.internal:22005|mock-meta-key":{"success":0,"failed":0,"recent_requests":[{"time":"21:50-22:00","success":0,"failed":0},{"time":"22:00-22:10","success":0,"failed":0},{"time":"22:10-22:20","success":0,"failed":0},{"time":"22:20-22:30","success":0,"failed":0},{"time":"22:30-22:40","success":0,"failed":0},{"time":"22:40-22:50","success":0,"failed":0},{"time":"22:50-23:00","success":0,"failed":0},{"time":"23:00-23:10","success":0,"failed":0},{"time":"23:10-23:20","success":0,"failed":0},{"time":"23:20-23:30","success":0,"failed":0},{"time":"23:30-23:40","success":0,"failed":0},{"time":"23:40-23:50","success":0,"failed":0},{"time":"23:50-00:00","success":0,"failed":0},{"time":"00:00-00:10","success":0,"failed":0},{"time":"00:10-00:20","success":0,"failed":0},{"time":"00:20-00:30","success":0,"failed":0},{"time":"00:30-00:40","success":0,"failed":0},{"time":"00:40-00:50","success":0,"failed":0},{"time":"00:50-01:00","success":0,"failed":0},{"time":"01:00-01:10","success":0,"failed":0}]}},"mock-openai":{"http://host.docker.internal:21999/v1|mock-upstream-key":{"success":0,"failed":0,"recent_requests":[{"time":"21:50-22:00","success":0,"failed":0},{"time":"22:00-22:10","success":0,"failed":0},{"time":"22:10-22:20","success":0,"failed":0},{"time":"22:20-22:30","success":0,"failed":0},{"time":"22:30-22:40","success":0,"failed":0},{"time":"22:40-22:50","success":0,"failed":0},{"time":"22:50-23:00","success":0,"failed":0},{"time":"23:00-23:10","success":0,"failed":0},{"time":"23:10-23:20","success":0,"failed":0},{"time":"23:20-23:30","success":0,"failed":0},{"time":"23:30-23:40","success":0,"failed":0},{"time":"23:40-23:50","success":0,"failed":0},{"time":"23:50-00:00","success":0,"failed":0},{"time":"00:00-00:10","success":0,"failed":0},{"time":"00:10-00:20","success":0,"failed":0},{"time":"00:20-00:30","success":0,"failed":0},{"time":"00:30-00:40","success":0,"failed":0},{"time":"00:40-00:50","success":0,"failed":0},{"time":"00:50-01:00","success":0,"failed":0},{"time":"01:00-01:10","success":0,"failed":0}]}},"vertex":{"http://host.docker.internal:22007|mock-vertex-key":{"success":0,"failed":0,"recent_requests":[{"time":"21:50-22:00","success":0,"failed":0},{"time":"22:00-22:10","success":0,"failed":0},{"time":"22:10-22:20","success":0,"failed":0},{"time":"22:20-22:30","success":0,"failed":0},{"time":"22:30-22:40","success":0,"failed":0},{"time":"22:40-22:50","success":0,"failed":0},{"time":"22:50-23:00","success":0,"failed":0},{"time":"23:00-23:10","success":0,"failed":0},{"time":"23:10-23:20","success":0,"failed":0},{"time":"23:20-23:30","success":0,"failed":0},{"time":"23:30-23:40","success":0,"failed":0},{"time":"23:40-23:50","success":0,"failed":0},{"time":"23:50-00:00","success":0,"failed":0},{"time":"00:00-00:10","success":0,"failed":0},{"time":"00:10-00:20","success":0,"failed":0},{"time":"00:20-00:30","success":0,"failed":0},{"time":"00:30-00:40","success":0,"failed":0},{"time":"00:40-00:50","success":0,"failed":0},{"time":"00:50-01:00","success":0,"failed":0},{"time":"01:00-01:10","success":0,"failed":0}]}},"xai":{"http://host.docker.internal:22004|mock-xai-key":{"success":0,"failed":0,"recent_requests":[{"time":"21:50-22:00","success":0,"failed":0},{"time":"22:00-22:10","success":0,"failed":0},{"time":"22:10-22:20","success":0,"failed":0},{"time":"22:20-22:30","success":0,"failed":0},{"time":"22:30-22:40","success":0,"failed":0},{"time":"22:40-22:50","success":0,"failed":0},{"time":"22:50-23:00","success":0,"failed":0},{"time":"23:00-23:10","success":0,"failed":0},{"time":"23:10-23:20","success":0,"failed":0},{"time":"23:20-23:30","success":0,"failed":0},{"time":"23:30-23:40","success":0,"failed":0},{"time":"23:40-23:50","success":0,"failed":0},{"time":"23:50-00:00","success":0,"failed":0},{"time":"00:00-00:10","success":0,"failed":0},{"time":"00:10-00:20","success":0,"failed":0},{"time":"00:20-00:30","success":0,"failed":0},{"time":"00:30-00:40","success":0,"failed":0},{"time":"00:40-00:50","success":0,"failed":0},{"time":"00:50-01:00","success":0,"failed":0},{"time":"01:00-01:10","success":0,"failed":0}]}}}```

HTTP status: 200

## STEP 2 — GET /v0/management/usage-queue

### Status + response headers (received order)
```
HTTP/1.1 200 OK
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json; charset=utf-8
X-Cpa-Build-Date: 2026-09-15T14:07:06Z
X-Cpa-Commit: 8335eac
X-Cpa-Support-Plugin: 1
X-Cpa-Version: v7.3.4
Date: Tue, 15 Sep 2026 17:00:16 GMT
Content-Length: 2
```

### Body
```
[]```

HTTP status: 200

## STEP 3 — GET /v0/management/usage-queue?count=abc

### Status + response headers (received order)
```
HTTP/1.1 400 Bad Request
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json; charset=utf-8
X-Cpa-Build-Date: 2026-09-15T14:07:06Z
X-Cpa-Commit: 8335eac
X-Cpa-Support-Plugin: 1
X-Cpa-Version: v7.3.4
Date: Tue, 15 Sep 2026 17:00:16 GMT
Content-Length: 44
```

### Body
```
{"error":"count must be a positive integer"}```

HTTP status: 400

## STEP 4 — GET /v0/management/usage-queue?count=0

### Status + response headers (received order)
```
HTTP/1.1 400 Bad Request
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json; charset=utf-8
X-Cpa-Build-Date: 2026-09-15T14:07:06Z
X-Cpa-Commit: 8335eac
X-Cpa-Support-Plugin: 1
X-Cpa-Version: v7.3.4
Date: Tue, 15 Sep 2026 17:00:16 GMT
Content-Length: 44
```

### Body
```
{"error":"count must be a positive integer"}```

HTTP status: 400

## STEP 5 — GET /v0/management/usage-queue?count=3

### Status + response headers (received order)
```
HTTP/1.1 200 OK
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json; charset=utf-8
X-Cpa-Build-Date: 2026-09-15T14:07:06Z
X-Cpa-Commit: 8335eac
X-Cpa-Support-Plugin: 1
X-Cpa-Version: v7.3.4
Date: Tue, 15 Sep 2026 17:00:16 GMT
Content-Length: 2
```

### Body
```
[]```

HTTP status: 200
