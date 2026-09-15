# s3-auth-url-codex — response 1/1 (step 1)

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
Content-Length: 513
Connection: close

## Body (exact bytes received, 513 bytes)
```
{"state":"1e03c0c0d98b14ce83481d0f3352dec3","status":"ok","url":"https://auth.openai.com/oauth/authorize?client_id=app_EMoamEEZ73f0CkXaXp7hrann\u0026code_challenge=QzqE58A0TJ144p7OKzdcKzwGaboZOEC6ETw3N2ZFazE\u0026code_challenge_method=S256\u0026codex_cli_simplified_flow=true\u0026id_token_add_organizations=true\u0026prompt=login\u0026redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback\u0026response_type=code\u0026scope=openid+email+profile+offline_access\u0026state=1e03c0c0d98b14ce83481d0f3352dec3"}
```
