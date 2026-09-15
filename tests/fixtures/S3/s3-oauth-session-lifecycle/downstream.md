# s3-oauth-session-lifecycle — response 1/5 (step 1)

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
Date: Tue, 15 Sep 2026 16:50:50 GMT
Content-Length: 497
Connection: close

## Body (exact bytes received, 497 bytes)
```
{"state":"b2e37792900f3d7e214c07edf0ea810c","status":"ok","url":"https://claude.ai/oauth/authorize?client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e\u0026code=true\u0026code_challenge=cKeopiFgTYnIALuimHt-Bgj2Ojt3aVBEq6LFhwhx2NU\u0026code_challenge_method=S256\u0026redirect_uri=http%3A%2F%2Flocalhost%3A54545%2Fcallback\u0026response_type=code\u0026scope=user%3Aprofile+user%3Ainference+user%3Asessions%3Aclaude_code+user%3Amcp_servers+user%3Afile_upload\u0026state=b2e37792900f3d7e214c07edf0ea810c"}
```
