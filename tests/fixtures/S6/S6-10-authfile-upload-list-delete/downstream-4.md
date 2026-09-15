# S6-10-authfile-upload-list-delete — response 3/8 (step 4)

## Status line
HTTP/1.1 200 OK

## Response headers (raw, received order)
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Disposition: attachment; filename="s6-test-claude.json"
Content-Type: application/json
X-Cpa-Build-Date: 2026-09-15T14:07:06Z
X-Cpa-Commit: 8335eac
X-Cpa-Support-Plugin: 1
X-Cpa-Version: v7.3.4
Date: Tue, 15 Sep 2026 17:24:15 GMT
Content-Length: 196
Connection: close

## Body (exact bytes received, 196 bytes)
```
{"access_token":"s6-fake-access","disabled":false,"email":"s6@example.com","expired":"2099-01-01T00:00:00Z","last_refresh":"2026-01-01T00:00:00Z","refresh_token":"s6-fake-refresh","type":"claude"}
```
