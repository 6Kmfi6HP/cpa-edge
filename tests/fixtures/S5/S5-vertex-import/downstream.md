# S5-vertex-import downstream (exact bytes, 8 steps)

## STEP 1 — POST /v0/management/vertex/import

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
Date: Tue, 15 Sep 2026 17:15:34 GMT
Content-Length: 169
```

### Body
```
{"auth-file":"/root/.cli-proxy-api/vertex-s5-project.json","email":"s5@fixture.iam.gserviceaccount.com","location":"us-central1","project_id":"s5-project","status":"ok"}
```

HTTP status: 200

## STEP 2 — GET /v0/management/auth-files

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
Date: Tue, 15 Sep 2026 17:15:37 GMT
Content-Length: 1703
```

### Body
```
{"files":[{"account":"s5@fixture.iam.gserviceaccount.com","account_type":"oauth","auth_index":"348dbe20d745f87f","cooldowns":[],"created_at":"2026-09-16T01:15:34.536901835+08:00","disabled":false,"email":"s5@fixture.iam.gserviceaccount.com","failed":0,"id":"vertex-s5-project.json","label":"s5@fixture.iam.gserviceaccount.com","modtime":"2026-09-16T01:15:34.537657753+08:00","name":"vertex-s5-project.json","path":"/root/.cli-proxy-api/vertex-s5-project.json","project_id":"s5-project","provider":"vertex","quota":{"signals":{}},"recent_requests":[{"time":"22:00-22:10","success":0,"failed":0},{"time":"22:10-22:20","success":0,"failed":0},{"time":"22:20-22:30","success":0,"failed":0},{"time":"22:30-22:40","success":0,"failed":0},{"time":"22:40-22:50","success":0,"failed":0},{"time":"22:50-23:00","success":0,"failed":0},{"time":"23:00-23:10","success":0,"failed":0},{"time":"23:10-23:20","success":0,"failed":0},{"time":"23:20-23:30","success":0,"failed":0},{"time":"23:30-23:40","success":0,"failed":0},{"time":"23:40-23:50","success":0,"failed":0},{"time":"23:50-00:00","success":0,"failed":0},{"time":"00:00-00:10","success":0,"failed":0},{"time":"00:10-00:20","success":0,"failed":0},{"time":"00:20-00:30","success":0,"failed":0},{"time":"00:30-00:40","success":0,"failed":0},{"time":"00:40-00:50","success":0,"failed":0},{"time":"00:50-01:00","success":0,"failed":0},{"time":"01:00-01:10","success":0,"failed":0},{"time":"01:10-01:20","success":0,"failed":0}],"runtime_only":false,"size":2087,"source":"file","status":"active","status_message":"","success":0,"type":"vertex","unavailable":false,"updated_at":"2026-09-16T01:15:34.536964085+08:00"}],"observed_at":"2026-09-15T17:15:37.12010567Z"}
```

HTTP status: 200

## STEP 3 — POST /v0/management/vertex/import

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
Date: Tue, 15 Sep 2026 17:15:37 GMT
Content-Length: 25
```

### Body
```
{"error":"file required"}
```

HTTP status: 400

## STEP 4 — POST /v0/management/vertex/import

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
Date: Tue, 15 Sep 2026 17:15:39 GMT
Content-Length: 90
```

### Body
```
{"error":"invalid json","message":"invalid character 'o' in literal null (expecting 'u')"}
```

HTTP status: 400

## STEP 5 — POST /v0/management/vertex/import

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
Date: Tue, 15 Sep 2026 17:15:42 GMT
Content-Length: 30
```

### Body
```
{"error":"project_id missing"}
```

HTTP status: 400

## STEP 6 — POST /v0/management/vertex/import

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
Date: Tue, 15 Sep 2026 17:15:44 GMT
Content-Length: 166
```

### Body
```
{"auth-file":"/root/.cli-proxy-api/vertex-s5-project.json","email":"s5@fixture.iam.gserviceaccount.com","location":"us-east1","project_id":"s5-project","status":"ok"}
```

HTTP status: 200

## STEP 7 — DELETE /v0/management/auth-files?name=vertex-s5-project.json

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
Date: Tue, 15 Sep 2026 17:15:47 GMT
Content-Length: 15
```

### Body
```
{"status":"ok"}
```

HTTP status: 200

## STEP 8 — DELETE /v0/management/auth-files?name=vertex-s5-project.json

### Status + response headers (received order)
```
HTTP/1.1 404 Not Found
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json; charset=utf-8
X-Cpa-Build-Date: 2026-09-15T14:07:06Z
X-Cpa-Commit: 8335eac
X-Cpa-Support-Plugin: 1
X-Cpa-Version: v7.3.4
Date: Tue, 15 Sep 2026 17:15:50 GMT
Content-Length: 31
```

### Body
```
{"error":"auth file not found"}
```

HTTP status: 404
