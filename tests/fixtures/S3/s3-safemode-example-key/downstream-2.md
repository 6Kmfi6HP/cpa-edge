# s3-safemode-example-key — response 2/2 (step 2)

## Status line
HTTP/1.1 200 OK

## Response headers (raw, received order)
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Cache-Control: no-store
Content-Type: text/html; charset=utf-8
Date: Tue, 15 Sep 2026 16:54:28 GMT
Content-Length: 1359
Connection: close

## Body (exact bytes received, 1359 bytes)
```
<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Example API key detected</title><style>body{margin:0;font-family:Arial,sans-serif;background:#f6f8fa;color:#1f2328}.wrap{max-width:760px;margin:12vh auto;padding:0 24px}.panel{background:#fff;border:1px solid #d0d7de;border-radius:8px;padding:28px;box-shadow:0 8px 24px rgba(140,149,159,.2)}h1{margin:0 0 12px;font-size:28px;line-height:1.25}p{font-size:16px;line-height:1.55}code{background:#f6f8fa;border:1px solid #d0d7de;border-radius:4px;padding:2px 5px}.keys{margin:16px 0;padding-left:22px}.actions{margin-top:24px}.button{display:inline-block;border-radius:6px;background:#0969da;color:#fff;text-decoration:none;font-weight:600;padding:10px 16px}.button:hover{background:#0759b8}</style></head><body><main class="wrap"><section class="panel"><h1>Example API key detected</h1><p>Proxy API endpoints are disabled because the top-level <code>api-keys</code> configuration still contains template values.</p><p>Replace these values before using the proxy:</p><ul class="keys"><li><code>your-api-key-1</code></li></ul><p>Set strong random API keys, then retry the proxy endpoint.</p><div class="actions"><a class="button" href="/management.html?safe-mode=configure">Open Management</a></div></section></main></body></html>
```
