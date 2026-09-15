# S5-model-definitions downstream (exact bytes, 4 steps)

## STEP 1 — GET /v0/management/model-definitions

### Status + response headers (received order)
```
HTTP/1.1 404 Not Found
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
X-Cpa-Build-Date: 2026-09-15T14:07:06Z
X-Cpa-Commit: 8335eac
X-Cpa-Support-Plugin: 1
X-Cpa-Version: v7.3.4
Date: Tue, 15 Sep 2026 17:05:49 GMT
Content-Length: 0
```

### Body
```
```

HTTP status: 404

## STEP 2 — GET /v0/management/model-definitions?channel=unknown

### Status + response headers (received order)
```
HTTP/1.1 404 Not Found
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
X-Cpa-Build-Date: 2026-09-15T14:07:06Z
X-Cpa-Commit: 8335eac
X-Cpa-Support-Plugin: 1
X-Cpa-Version: v7.3.4
Date: Tue, 15 Sep 2026 17:05:49 GMT
Content-Length: 0
```

### Body
```
```

HTTP status: 404

## STEP 3 — GET /v0/management/model-definitions/kimi

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
Date: Tue, 15 Sep 2026 17:05:49 GMT
Transfer-Encoding: chunked
```

### Body
```
{"channel":"kimi","models":[{"id":"kimi-k2","object":"model","created":1752192000,"owned_by":"moonshot","type":"kimi","display_name":"Kimi K2","description":"Kimi K2 - Moonshot AI's flagship coding model","context_length":131072,"max_completion_tokens":32768,"supportedInputModalities":["text"],"supportedOutputModalities":["text"]},{"id":"kimi-k2-thinking","object":"model","created":1762387200,"owned_by":"moonshot","type":"kimi","display_name":"Kimi K2 Thinking","description":"Kimi K2 Thinking - Extended reasoning model","context_length":131072,"max_completion_tokens":32768,"supportedInputModalities":["text"],"supportedOutputModalities":["text"],"thinking":{"zero_allowed":true,"levels":["low","high"]}},{"id":"kimi-k2.5","object":"model","created":1769472000,"owned_by":"moonshot","type":"kimi","display_name":"Kimi K2.5","description":"Kimi K2.5 - Native multimodal agentic model with text, image, and video input; supports thinking and non-thinking modes","context_length":262144,"max_completion_tokens":32768,"supportedInputModalities":["text","image","video"],"supportedOutputModalities":["text"],"thinking":{"zero_allowed":true,"levels":["low","high"]}},{"id":"kimi-k2.6","object":"model","created":1776729600,"owned_by":"moonshot","type":"kimi","display_name":"Kimi K2.6","description":"Kimi K2.6 - Native multimodal agentic model with stronger long-horizon agentic coding, long-context reasoning, and preserved thinking support","context_length":262144,"max_completion_tokens":65536,"supportedInputModalities":["text","image","video"],"supportedOutputModalities":["text"],"thinking":{"zero_allowed":true,"levels":["low","high"]}},{"id":"kimi-k2.7-code","object":"model","created":1780396800,"owned_by":"moonshot","type":"kimi","display_name":"Kimi K2.7 Code","description":"Kimi K2.7 Code - Moonshot AI's latest coding-focused model","context_length":262144,"max_completion_tokens":65536,"supportedInputModalities":["text","image","video"],"supportedOutputModalities":["text"],"thinking":{"levels":["low","high"]}},{"id":"kimi-k2.7-code-highspeed","object":"model","created":1780396800,"owned_by":"moonshot","type":"kimi","display_name":"Kimi K2.7 Code HighSpeed","description":"Kimi K2.7 Code HighSpeed - Same capabilities as Kimi K2.7 Code with higher output speed (~180 tokens/s)","context_length":262144,"max_completion_tokens":65536,"supportedInputModalities":["text","image","video"],"supportedOutputModalities":["text"],"thinking":{"levels":["low","high"]}},{"id":"kimi-k2.8","object":"model","created":1789115500,"owned_by":"moonshot","type":"kimi","display_name":"Kimi K2.8 Preview","description":"Kimi K2.8 Preview - Lightweight coding and agent model with near-K3 performance and 1M context window","context_length":1048576,"max_completion_tokens":65536,"supportedInputModalities":["text","image","video"],"supportedOutputModalities":["text"],"thinking":{"zero_allowed":true,"levels":["low","high","max"]}},{"id":"kimi-k2.8-code","object":"model","created":1789115500,"owned_by":"moonshot","type":"kimi","display_name":"Kimi K2.8 Code Preview","description":"Kimi K2.8 Code Preview - Lightweight coding and agent model with near-K3 performance and 1M context window","context_length":1048576,"max_completion_tokens":65536,"supportedInputModalities":["text","image","video"],"supportedOutputModalities":["text"],"thinking":{"zero_allowed":true,"levels":["low","high","max"]}},{"id":"kimi-k3","object":"model","created":1784073600,"owned_by":"moonshot","type":"kimi","display_name":"Kimi K3","description":"Kimi K3 - Moonshot AI's next-generation flagship model (~2.8T MoE) with multimodal input","context_length":1048576,"max_completion_tokens":65536,"supportedInputModalities":["text","image","video"],"supportedOutputModalities":["text"],"thinking":{"zero_allowed":true,"levels":["low","high","max"]}},{"id":"kimi-k3-256k","object":"model","created":1785110400,"owned_by":"moonshot","type":"kimi","display_name":"Kimi K3 256K","description":"Kimi K3 256K - 256K context version of Kimi K3 delivering the same results within 256K context at reduced quota consumption; supports image input only (no video)","context_length":262144,"max_completion_tokens":65536,"supportedInputModalities":["text","image"],"supportedOutputModalities":["text"],"thinking":{"zero_allowed":true,"levels":["low","high","max"]}}]}
```

HTTP status: 200

## STEP 4 — GET /v0/management/model-definitions/KIMI

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
Date: Tue, 15 Sep 2026 17:05:49 GMT
Transfer-Encoding: chunked
```

### Body
```
{"channel":"kimi","models":[{"id":"kimi-k2","object":"model","created":1752192000,"owned_by":"moonshot","type":"kimi","display_name":"Kimi K2","description":"Kimi K2 - Moonshot AI's flagship coding model","context_length":131072,"max_completion_tokens":32768,"supportedInputModalities":["text"],"supportedOutputModalities":["text"]},{"id":"kimi-k2-thinking","object":"model","created":1762387200,"owned_by":"moonshot","type":"kimi","display_name":"Kimi K2 Thinking","description":"Kimi K2 Thinking - Extended reasoning model","context_length":131072,"max_completion_tokens":32768,"supportedInputModalities":["text"],"supportedOutputModalities":["text"],"thinking":{"zero_allowed":true,"levels":["low","high"]}},{"id":"kimi-k2.5","object":"model","created":1769472000,"owned_by":"moonshot","type":"kimi","display_name":"Kimi K2.5","description":"Kimi K2.5 - Native multimodal agentic model with text, image, and video input; supports thinking and non-thinking modes","context_length":262144,"max_completion_tokens":32768,"supportedInputModalities":["text","image","video"],"supportedOutputModalities":["text"],"thinking":{"zero_allowed":true,"levels":["low","high"]}},{"id":"kimi-k2.6","object":"model","created":1776729600,"owned_by":"moonshot","type":"kimi","display_name":"Kimi K2.6","description":"Kimi K2.6 - Native multimodal agentic model with stronger long-horizon agentic coding, long-context reasoning, and preserved thinking support","context_length":262144,"max_completion_tokens":65536,"supportedInputModalities":["text","image","video"],"supportedOutputModalities":["text"],"thinking":{"zero_allowed":true,"levels":["low","high"]}},{"id":"kimi-k2.7-code","object":"model","created":1780396800,"owned_by":"moonshot","type":"kimi","display_name":"Kimi K2.7 Code","description":"Kimi K2.7 Code - Moonshot AI's latest coding-focused model","context_length":262144,"max_completion_tokens":65536,"supportedInputModalities":["text","image","video"],"supportedOutputModalities":["text"],"thinking":{"levels":["low","high"]}},{"id":"kimi-k2.7-code-highspeed","object":"model","created":1780396800,"owned_by":"moonshot","type":"kimi","display_name":"Kimi K2.7 Code HighSpeed","description":"Kimi K2.7 Code HighSpeed - Same capabilities as Kimi K2.7 Code with higher output speed (~180 tokens/s)","context_length":262144,"max_completion_tokens":65536,"supportedInputModalities":["text","image","video"],"supportedOutputModalities":["text"],"thinking":{"levels":["low","high"]}},{"id":"kimi-k2.8","object":"model","created":1789115500,"owned_by":"moonshot","type":"kimi","display_name":"Kimi K2.8 Preview","description":"Kimi K2.8 Preview - Lightweight coding and agent model with near-K3 performance and 1M context window","context_length":1048576,"max_completion_tokens":65536,"supportedInputModalities":["text","image","video"],"supportedOutputModalities":["text"],"thinking":{"zero_allowed":true,"levels":["low","high","max"]}},{"id":"kimi-k2.8-code","object":"model","created":1789115500,"owned_by":"moonshot","type":"kimi","display_name":"Kimi K2.8 Code Preview","description":"Kimi K2.8 Code Preview - Lightweight coding and agent model with near-K3 performance and 1M context window","context_length":1048576,"max_completion_tokens":65536,"supportedInputModalities":["text","image","video"],"supportedOutputModalities":["text"],"thinking":{"zero_allowed":true,"levels":["low","high","max"]}},{"id":"kimi-k3","object":"model","created":1784073600,"owned_by":"moonshot","type":"kimi","display_name":"Kimi K3","description":"Kimi K3 - Moonshot AI's next-generation flagship model (~2.8T MoE) with multimodal input","context_length":1048576,"max_completion_tokens":65536,"supportedInputModalities":["text","image","video"],"supportedOutputModalities":["text"],"thinking":{"zero_allowed":true,"levels":["low","high","max"]}},{"id":"kimi-k3-256k","object":"model","created":1785110400,"owned_by":"moonshot","type":"kimi","display_name":"Kimi K3 256K","description":"Kimi K3 256K - 256K context version of Kimi K3 delivering the same results within 256K context at reduced quota consumption; supports image input only (no video)","context_length":262144,"max_completion_tokens":65536,"supportedInputModalities":["text","image"],"supportedOutputModalities":["text"],"thinking":{"zero_allowed":true,"levels":["low","high","max"]}}]}
```

HTTP status: 200
