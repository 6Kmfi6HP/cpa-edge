# S6-11-authfile-patch-fields — response 11/12 (step 11)

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
Content-Length: 255
Connection: close

## Body (exact bytes received, 255 bytes)
```
{"access_token":"s6-fake-access","disabled":false,"email":"s6@example.com","expired":"2099-01-01T00:00:00Z","last_refresh":"2026-01-01T00:00:00Z","note":"s6 note","priority":5,"refresh_token":"s6-fake-refresh","request_retry":3,"type":"claude","weight":7}
```
