# S5-api-keys-crud downstream (exact bytes, 15 steps)

## STEP 1 — PUT /v0/management/api-keys

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
Date: Tue, 15 Sep 2026 17:02:52 GMT
Content-Length: 15
```

### Body
```
{"status":"ok"}
```

HTTP status: 200

## STEP 2 — GET /v0/management/api-keys

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
Date: Tue, 15 Sep 2026 17:02:54 GMT
Content-Length: 50
```

### Body
```
{"api-keys":["oracle-local-key-1","s5-extra-key"]}
```

HTTP status: 200

## STEP 3 — PATCH /v0/management/api-keys

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
Date: Tue, 15 Sep 2026 17:02:54 GMT
Content-Length: 15
```

### Body
```
{"status":"ok"}
```

HTTP status: 200

## STEP 4 — GET /v0/management/api-keys

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
Date: Tue, 15 Sep 2026 17:02:55 GMT
Content-Length: 48
```

### Body
```
{"api-keys":["oracle-local-key-1","s5-renamed"]}
```

HTTP status: 200

## STEP 5 — PATCH /v0/management/api-keys

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
Date: Tue, 15 Sep 2026 17:02:55 GMT
Content-Length: 15
```

### Body
```
{"status":"ok"}
```

HTTP status: 200

## STEP 6 — GET /v0/management/api-keys

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
Date: Tue, 15 Sep 2026 17:02:56 GMT
Content-Length: 46
```

### Body
```
{"api-keys":["oracle-local-key-1","s5-extra"]}
```

HTTP status: 200

## STEP 7 — DELETE /v0/management/api-keys?index=1

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
Date: Tue, 15 Sep 2026 17:02:57 GMT
Content-Length: 15
```

### Body
```
{"status":"ok"}
```

HTTP status: 200

## STEP 8 — GET /v0/management/api-keys

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
Date: Tue, 15 Sep 2026 17:02:58 GMT
Content-Length: 35
```

### Body
```
{"api-keys":["oracle-local-key-1"]}
```

HTTP status: 200

## STEP 9 — PUT /v0/management/api-keys

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
Date: Tue, 15 Sep 2026 17:02:58 GMT
Content-Length: 24
```

### Body
```
{"error":"invalid body"}
```

HTTP status: 400

## STEP 10 — PUT /v0/management/api-keys

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
Date: Tue, 15 Sep 2026 17:02:59 GMT
Content-Length: 24
```

### Body
```
{"error":"invalid body"}
```

HTTP status: 400

## STEP 11 — PATCH /v0/management/api-keys

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
Date: Tue, 15 Sep 2026 17:03:00 GMT
Content-Length: 26
```

### Body
```
{"error":"missing fields"}
```

HTTP status: 400

## STEP 12 — PATCH /v0/management/api-keys

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
Date: Tue, 15 Sep 2026 17:03:02 GMT
Content-Length: 26
```

### Body
```
{"error":"missing fields"}
```

HTTP status: 400

## STEP 13 — DELETE /v0/management/api-keys

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
Date: Tue, 15 Sep 2026 17:03:03 GMT
Content-Length: 34
```

### Body
```
{"error":"missing index or value"}
```

HTTP status: 400

## STEP 14 — DELETE /v0/management/api-keys?value=ghost

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
Date: Tue, 15 Sep 2026 17:03:04 GMT
Content-Length: 15
```

### Body
```
{"status":"ok"}
```

HTTP status: 200

## STEP 15 — PUT /v0/management/api-keys

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
Date: Tue, 15 Sep 2026 17:03:06 GMT
Content-Length: 15
```

### Body
```
{"status":"ok"}
```

HTTP status: 200
