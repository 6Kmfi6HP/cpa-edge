# S1-24 / count-tokens — downstream response (exact bytes)

## Status + response headers (received order)
```
HTTP/1.1 200 OK
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json
X-Cpa-Trace-Id: 20260916004709-47b77fbeb6ecb734-b1d8aaa6
Date: Tue, 15 Sep 2026 16:47:09 GMT
Content-Length: 76

```

## Body (stdout)
```
{"totalTokens":3,"promptTokensDetails":[{"modality":"TEXT","tokenCount":3}]}
```

HTTP status: 200
