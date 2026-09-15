# S4-21-ws-transport-preference downstream

## Step 1 (websocket) — upgrade: HTTP/1.1 101 Switching Protocols
### Upgrade + any non-upgrade body
```
HTTP/1.1 101 Switching Protocols
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Accept: h131xSamldQNCz2m2o9VJTQLF7s=


```
### Frames received
```
{"opcode": "text", "payload": "{\"type\":\"error\",\"status\":404,\"error\":{\"message\": \"mock codex: no handler for GET /responses\", \"type\": \"invalid_request_error\"}}"}
```

## Step 2 — HTTP 200
### Headers
```
HTTP/1.1 200 OK
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json
X-Cpa-Trace-Id: 20260916041141-f8131d354f71b829-cd35f95b
Date: Tue, 15 Sep 2026 20:11:41 GMT
Content-Length: 361

```
### Body
```
{"id":"resp_mock_01","object":"chat.completion","created":1770000000,"model":"gpt-mock-codex","choices":[{"index":0,"message":{"role":"assistant","content":"Hello from mock codex upstream more","reasoning_content":null,"tool_calls":null},"finish_reason":"stop","native_finish_reason":"stop"}],"usage":{"completion_tokens":6,"total_tokens":15,"prompt_tokens":9}}

```

## Bonus probe: /v1/ws provider-bridge
### Upgrade
```
HTTP/1.1 101 Switching Protocols
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Accept: mC2h66nb0+dlYYWSg5bLRG5SCAE=


```
### Frames
```

```
