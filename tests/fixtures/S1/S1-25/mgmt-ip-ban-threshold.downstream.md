# mgmt-ip-ban-threshold (config variant V4: fresh container, discarded after)
# 5 wrong-key attempts then 1 VALID-key attempt; ban check runs before key validation.

## Attempt 1 (wrong key: wrong-key-01) — HTTP 401
```json
{"error":"invalid management key"}
```

## Attempt 2 (wrong key: wrong-key-02) — HTTP 401
```json
{"error":"invalid management key"}
```

## Attempt 3 (wrong key: wrong-key-03) — HTTP 401
```json
{"error":"invalid management key"}
```

## Attempt 4 (wrong key: wrong-key-04) — HTTP 401
```json
{"error":"invalid management key"}
```

## Attempt 5 (wrong key: wrong-key-05) — HTTP 401
```json
{"error":"invalid management key"}
```

## Attempt 6 (VALID key) — HTTP 403 (IP banned; ban check precedes key validation)
### Response headers (received order)
```
HTTP/1.1 403 Forbidden
Content-Type: application/json; charset=utf-8
X-Cpa-Build-Date: 2026-09-15T14:07:06Z
X-Cpa-Commit: 8335eac
<plus the standard CORS block + Date (dynamic)>
```
### Body
```json
{"error":"IP banned due to too many failed attempts. Try again in 30m0s"}
```

DYNAMIC FIELD: the "30m0s" remaining-ban duration (Go duration string; full window is 30m).
