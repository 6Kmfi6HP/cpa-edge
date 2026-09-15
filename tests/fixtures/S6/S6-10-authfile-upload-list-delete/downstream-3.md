# S6-10-authfile-upload-list-delete — response 2/8 (step 3)

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
Date: Tue, 15 Sep 2026 17:24:14 GMT
Content-Length: 1646
Connection: close

## Body (exact bytes received, 1646 bytes)
```
{"files":[{"account":"s6@example.com","account_type":"oauth","auth_index":"3868834fdeed1be9","cooldowns":[],"created_at":"2026-09-16T01:24:14.900490756+08:00","disabled":false,"email":"s6@example.com","failed":0,"id":"s6-test-claude.json","label":"s6@example.com","last_refresh":"2026-01-01T00:00:00Z","modtime":"2026-09-16T01:24:14.902707406+08:00","name":"s6-test-claude.json","path":"/root/.cli-proxy-api/s6-test-claude.json","provider":"claude","quota":{"signals":{}},"recent_requests":[{"time":"22:10-22:20","success":0,"failed":0},{"time":"22:20-22:30","success":0,"failed":0},{"time":"22:30-22:40","success":0,"failed":0},{"time":"22:40-22:50","success":0,"failed":0},{"time":"22:50-23:00","success":0,"failed":0},{"time":"23:00-23:10","success":0,"failed":0},{"time":"23:10-23:20","success":0,"failed":0},{"time":"23:20-23:30","success":0,"failed":0},{"time":"23:30-23:40","success":0,"failed":0},{"time":"23:40-23:50","success":0,"failed":0},{"time":"23:50-00:00","success":0,"failed":0},{"time":"00:00-00:10","success":0,"failed":0},{"time":"00:10-00:20","success":0,"failed":0},{"time":"00:20-00:30","success":0,"failed":0},{"time":"00:30-00:40","success":0,"failed":0},{"time":"00:40-00:50","success":0,"failed":0},{"time":"00:50-01:00","success":0,"failed":0},{"time":"01:00-01:10","success":0,"failed":0},{"time":"01:10-01:20","success":0,"failed":0},{"time":"01:20-01:30","success":0,"failed":0}],"runtime_only":false,"size":196,"source":"file","status":"active","status_message":"","success":0,"type":"claude","unavailable":false,"updated_at":"2026-09-16T01:24:14.902794548+08:00"}],"observed_at":"2026-09-15T17:24:14.960229048Z"}
```
