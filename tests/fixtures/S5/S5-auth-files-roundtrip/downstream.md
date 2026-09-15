# S5-auth-files-roundtrip downstream (exact bytes, 12 steps)

## STEP 1 — GET /v0/management/auth-files

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
Date: Tue, 15 Sep 2026 17:03:56 GMT
Content-Length: 59
```

### Body
```
{"files":[],"observed_at":"2026-09-15T17:03:56.792920012Z"}
```

HTTP status: 200

## STEP 2 — POST /v0/management/auth-files?name=s5-kimi.json

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
Date: Tue, 15 Sep 2026 17:03:56 GMT
Content-Length: 15
```

### Body
```
{"status":"ok"}
```

HTTP status: 200

## STEP 3 — GET /v0/management/auth-files

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
Date: Tue, 15 Sep 2026 17:03:59 GMT
Content-Length: 1635
```

### Body
```
{"files":[{"account":"s5@example.com","account_type":"oauth","auth_index":"76a4693a0a9f092b","cooldowns":[],"created_at":"2026-09-16T01:03:56.866652846+08:00","disabled":false,"email":"s5@example.com","failed":0,"id":"s5-kimi.json","label":"s5@example.com","last_refresh":"2026-09-16T01:03:56.867789012+08:00","modtime":"2026-09-16T01:03:56.868560627+08:00","name":"s5-kimi.json","path":"/root/.cli-proxy-api/s5-kimi.json","provider":"kimi","quota":{"signals":{}},"recent_requests":[{"time":"21:50-22:00","success":0,"failed":0},{"time":"22:00-22:10","success":0,"failed":0},{"time":"22:10-22:20","success":0,"failed":0},{"time":"22:20-22:30","success":0,"failed":0},{"time":"22:30-22:40","success":0,"failed":0},{"time":"22:40-22:50","success":0,"failed":0},{"time":"22:50-23:00","success":0,"failed":0},{"time":"23:00-23:10","success":0,"failed":0},{"time":"23:10-23:20","success":0,"failed":0},{"time":"23:20-23:30","success":0,"failed":0},{"time":"23:30-23:40","success":0,"failed":0},{"time":"23:40-23:50","success":0,"failed":0},{"time":"23:50-00:00","success":0,"failed":0},{"time":"00:00-00:10","success":0,"failed":0},{"time":"00:10-00:20","success":0,"failed":0},{"time":"00:20-00:30","success":0,"failed":0},{"time":"00:30-00:40","success":0,"failed":0},{"time":"00:40-00:50","success":0,"failed":0},{"time":"00:50-01:00","success":0,"failed":0},{"time":"01:00-01:10","success":0,"failed":0}],"runtime_only":false,"size":57,"source":"file","status":"active","status_message":"","success":0,"type":"kimi","unavailable":false,"updated_at":"2026-09-16T01:03:56.868693846+08:00"}],"observed_at":"2026-09-15T17:03:59.463377014Z"}
```

HTTP status: 200

## STEP 4 — GET /v0/management/auth-files/models?name=s5-kimi.json

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
Date: Tue, 15 Sep 2026 17:03:59 GMT
Content-Length: 910
```

### Body
```
{"models":[{"display_name":"Kimi K2","id":"kimi-k2","owned_by":"moonshot","type":"kimi"},{"display_name":"Kimi K2 Thinking","id":"kimi-k2-thinking","owned_by":"moonshot","type":"kimi"},{"display_name":"Kimi K2.5","id":"kimi-k2.5","owned_by":"moonshot","type":"kimi"},{"display_name":"Kimi K2.6","id":"kimi-k2.6","owned_by":"moonshot","type":"kimi"},{"display_name":"Kimi K2.7 Code","id":"kimi-k2.7-code","owned_by":"moonshot","type":"kimi"},{"display_name":"Kimi K2.7 Code HighSpeed","id":"kimi-k2.7-code-highspeed","owned_by":"moonshot","type":"kimi"},{"display_name":"Kimi K2.8 Preview","id":"kimi-k2.8","owned_by":"moonshot","type":"kimi"},{"display_name":"Kimi K2.8 Code Preview","id":"kimi-k2.8-code","owned_by":"moonshot","type":"kimi"},{"display_name":"Kimi K3","id":"kimi-k3","owned_by":"moonshot","type":"kimi"},{"display_name":"Kimi K3 256K","id":"kimi-k3-256k","owned_by":"moonshot","type":"kimi"}]}
```

HTTP status: 200

## STEP 5 — PATCH /v0/management/auth-files/status

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
Date: Tue, 15 Sep 2026 17:03:59 GMT
Content-Length: 31
```

### Body
```
{"disabled":true,"status":"ok"}
```

HTTP status: 200

## STEP 6 — GET /v0/management/auth-files

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
Date: Tue, 15 Sep 2026 17:04:02 GMT
Content-Length: 1634
```

### Body
```
{"files":[{"account":"s5@example.com","account_type":"oauth","auth_index":"76a4693a0a9f092b","cooldowns":[],"created_at":"2026-09-16T01:03:56.866652846+08:00","disabled":true,"email":"s5@example.com","failed":0,"id":"s5-kimi.json","label":"s5@example.com","last_refresh":"2026-09-16T01:03:59.58060018+08:00","modtime":"2026-09-16T01:03:59.580512043+08:00","name":"s5-kimi.json","path":"/root/.cli-proxy-api/s5-kimi.json","provider":"kimi","quota":{"signals":{}},"recent_requests":[{"time":"21:50-22:00","success":0,"failed":0},{"time":"22:00-22:10","success":0,"failed":0},{"time":"22:10-22:20","success":0,"failed":0},{"time":"22:20-22:30","success":0,"failed":0},{"time":"22:30-22:40","success":0,"failed":0},{"time":"22:40-22:50","success":0,"failed":0},{"time":"22:50-23:00","success":0,"failed":0},{"time":"23:00-23:10","success":0,"failed":0},{"time":"23:10-23:20","success":0,"failed":0},{"time":"23:20-23:30","success":0,"failed":0},{"time":"23:30-23:40","success":0,"failed":0},{"time":"23:40-23:50","success":0,"failed":0},{"time":"23:50-00:00","success":0,"failed":0},{"time":"00:00-00:10","success":0,"failed":0},{"time":"00:10-00:20","success":0,"failed":0},{"time":"00:20-00:30","success":0,"failed":0},{"time":"00:30-00:40","success":0,"failed":0},{"time":"00:40-00:50","success":0,"failed":0},{"time":"00:50-01:00","success":0,"failed":0},{"time":"01:00-01:10","success":0,"failed":0}],"runtime_only":false,"size":56,"source":"file","status":"disabled","status_message":"","success":0,"type":"kimi","unavailable":false,"updated_at":"2026-09-16T01:03:59.58060393+08:00"}],"observed_at":"2026-09-15T17:04:02.168030167Z"}
```

HTTP status: 200

## STEP 7 — PATCH /v0/management/auth-files/status

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
Date: Tue, 15 Sep 2026 17:04:02 GMT
Content-Length: 32
```

### Body
```
{"disabled":false,"status":"ok"}
```

HTTP status: 200

## STEP 8 — PATCH /v0/management/auth-files/fields

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
Date: Tue, 15 Sep 2026 17:04:04 GMT
Content-Length: 15
```

### Body
```
{"status":"ok"}
```

HTTP status: 200

## STEP 9 — GET /v0/management/auth-files

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
Date: Tue, 15 Sep 2026 17:04:07 GMT
Content-Length: 1669
```

### Body
```
{"files":[{"account":"s5@example.com","account_type":"oauth","auth_index":"76a4693a0a9f092b","cooldowns":[],"created_at":"2026-09-16T01:03:56.866652846+08:00","disabled":false,"email":"s5@example.com","failed":0,"id":"s5-kimi.json","label":"s5@example.com","last_refresh":"2026-09-16T01:03:59.58060018+08:00","modtime":"2026-09-16T01:04:04.820543697+08:00","name":"s5-kimi.json","note":"s5-note-value","path":"/root/.cli-proxy-api/s5-kimi.json","priority":7,"provider":"kimi","quota":{"signals":{}},"recent_requests":[{"time":"21:50-22:00","success":0,"failed":0},{"time":"22:00-22:10","success":0,"failed":0},{"time":"22:10-22:20","success":0,"failed":0},{"time":"22:20-22:30","success":0,"failed":0},{"time":"22:30-22:40","success":0,"failed":0},{"time":"22:40-22:50","success":0,"failed":0},{"time":"22:50-23:00","success":0,"failed":0},{"time":"23:00-23:10","success":0,"failed":0},{"time":"23:10-23:20","success":0,"failed":0},{"time":"23:20-23:30","success":0,"failed":0},{"time":"23:30-23:40","success":0,"failed":0},{"time":"23:40-23:50","success":0,"failed":0},{"time":"23:50-00:00","success":0,"failed":0},{"time":"00:00-00:10","success":0,"failed":0},{"time":"00:10-00:20","success":0,"failed":0},{"time":"00:20-00:30","success":0,"failed":0},{"time":"00:30-00:40","success":0,"failed":0},{"time":"00:40-00:50","success":0,"failed":0},{"time":"00:50-01:00","success":0,"failed":0},{"time":"01:00-01:10","success":0,"failed":0}],"runtime_only":false,"size":93,"source":"file","status":"active","status_message":"","success":0,"type":"kimi","unavailable":false,"updated_at":"2026-09-16T01:04:04.818924544+08:00"}],"observed_at":"2026-09-15T17:04:07.39195117Z"}
```

HTTP status: 200

## STEP 10 — GET /v0/management/auth-files/download?name=s5-kimi.json

### Status + response headers (received order)
```
HTTP/1.1 200 OK
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Disposition: attachment; filename="s5-kimi.json"
Content-Type: application/json
X-Cpa-Build-Date: 2026-09-15T14:07:06Z
X-Cpa-Commit: 8335eac
X-Cpa-Support-Plugin: 1
X-Cpa-Version: v7.3.4
Date: Tue, 15 Sep 2026 17:04:07 GMT
Content-Length: 93
```

### Body
```
{"disabled":false,"email":"s5@example.com","note":"s5-note-value","priority":7,"type":"kimi"}
```

HTTP status: 200

## STEP 11 — DELETE /v0/management/auth-files?name=s5-kimi.json

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
Date: Tue, 15 Sep 2026 17:04:07 GMT
Content-Length: 15
```

### Body
```
{"status":"ok"}
```

HTTP status: 200

## STEP 12 — GET /v0/management/auth-files

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
Date: Tue, 15 Sep 2026 17:04:10 GMT
Content-Length: 59
```

### Body
```
{"files":[],"observed_at":"2026-09-15T17:04:10.106628088Z"}
```

HTTP status: 200
