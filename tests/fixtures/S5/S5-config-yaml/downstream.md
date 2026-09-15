# S5-config-yaml downstream (exact bytes, 7 steps)

## STEP 1 — GET /v0/management/config.yaml

### Status + response headers (received order)
```
HTTP/1.1 200 OK
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Cache-Control: no-store
Content-Type: application/yaml; charset=utf-8
X-Content-Type-Options: nosniff
X-Cpa-Build-Date: 2026-09-15T14:07:06Z
X-Cpa-Commit: 8335eac
X-Cpa-Support-Plugin: 1
X-Cpa-Version: v7.3.4
Date: Tue, 15 Sep 2026 17:09:28 GMT
Content-Length: 1969
```

### Body
```
# Oracle worker-4 fleet config - all mock upstreams wired to run4 ports, NO real credentials.
# Derived from _cpa_edge_ref/run/config.yaml; reference listens on 8407
# (isolated: worker-1 18317, worker-2 8387, worker-3 8397).
# Oracle fleet config - all mock upstreams wired, NO real credentials.
host: ""
port: 8407
remote-management:
  allow-remote: true
  secret-key: "$2a$10$22ixgJLGCPJD6mqcT8In8uLtq7nvCHnP.I279ahVk.67DruCKA2Yy"
  disable-control-panel: true
auth-dir: "/root/.cli-proxy-api"
api-keys:
  - "oracle-local-key-1"
debug: false
request-retry: 0
transient-error-cooldown-seconds: -1
usage-statistics-enabled: false
openai-compatibility:
  - name: "mock-openai"
    base-url: "http://host.docker.internal:21999/v1"
    api-key-entries:
      - api-key: "mock-upstream-key"
    models:
      - name: "mock-gpt-model"
        alias: "mock-model"
gemini-api-key:
  - api-key: "mock-gem-key"
    base-url: "http://host.docker.internal:22001"
    models:
      - name: "gemini-mock-model"
        alias: "gm"
claude-api-key:
  - api-key: "mock-claude-key"
    base-url: "http://host.docker.internal:22002"
    models:
      - name: "claude-mock-model"
        alias: "cm"
codex-api-key:
  - api-key: "mock-codex-key"
    base-url: "http://host.docker.internal:22003"
    models:
      - name: "gpt-mock-codex"
        alias: "cx"
xai-api-key:
  - api-key: "mock-xai-key"
    base-url: "http://host.docker.internal:22004"
    models:
      - name: "grok-mock"
        alias: "xg"
meta-api-key:
  - api-key: "mock-meta-key"
    base-url: "http://host.docker.internal:22005"
    models:
      - name: "muse-mock"
        alias: "mm"
interactions-api-key:
  - api-key: "mock-int-key"
    base-url: "http://host.docker.internal:22006"
    models:
      - name: "gemini-mock-model"
        alias: "im"
vertex-api-key:
  - api-key: "mock-vertex-key"
    base-url: "http://host.docker.internal:22007"
    models:
      - name: "vertex-mock-model"
        alias: "vm"
```

HTTP status: 200

## STEP 2 — PUT /v0/management/config.yaml

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
Date: Tue, 15 Sep 2026 17:09:28 GMT
Content-Length: 68
```

### Body
```
{"error":"invalid_yaml","message":"yaml: did not find expected key"}
```

HTTP status: 400

## STEP 3 — PUT /v0/management/config.yaml

### Status + response headers (received order)
```
HTTP/1.1 422 Unprocessable Entity
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id
Content-Type: application/json; charset=utf-8
X-Cpa-Build-Date: 2026-09-15T14:07:06Z
X-Cpa-Commit: 8335eac
X-Cpa-Support-Plugin: 1
X-Cpa-Version: v7.3.4
Date: Tue, 15 Sep 2026 17:09:31 GMT
Content-Length: 95
```

### Body
```
{"error":"invalid_config","message":"gemini-api-key[0].weight: weight must not exceed 1000000"}
```

HTTP status: 422

## STEP 4 — PUT /v0/management/config.yaml

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
Date: Tue, 15 Sep 2026 17:09:34 GMT
Content-Length: 32
```

### Body
```
{"changed":["config"],"ok":true}
```

HTTP status: 200

## STEP 5 — GET /v0/management/request-retry

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
Date: Tue, 15 Sep 2026 17:09:37 GMT
Content-Length: 19
```

### Body
```
{"request-retry":2}
```

HTTP status: 200

## STEP 6 — PUT /v0/management/config.yaml

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
Date: Tue, 15 Sep 2026 17:09:37 GMT
Content-Length: 32
```

### Body
```
{"changed":["config"],"ok":true}
```

HTTP status: 200

## STEP 7 — GET /v0/management/request-retry

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
Date: Tue, 15 Sep 2026 17:09:40 GMT
Content-Length: 19
```

### Body
```
{"request-retry":0}
```

HTTP status: 200
