# ORACLE worker-2 — isolated recording stack (run2)

Owner: @oracle-runner worker 2. Sandbox: `~/projects/llm-api/_cpa_edge_ref/run2` (private).
Everything below is disjoint from worker-1 (ports 18317 / 18999-19007, files under `run/`, `probes/`).
Binary anchor: CLIProxyAPI v7.3.4, image `eceasy/cli-proxy-api:v7.3.4`,
digest `sha256:97825da3009f98acf78b5c172fde650a5fbe7a690950a69ce6d7b535d77d4266`.

## 1. Ports (worker-2)

| Component | Port |
|---|---|
| Reference binary (container `cpa-oracle-2`) | 127.0.0.1:8387 |
| mock openai (`openai-compatibility`) | 19999 |
| mock gemini (`gemini-api-key`) | 20001 |
| mock claude (`claude-api-key`) | 20002 |
| mock codex (`codex-api-key`) | 20003 |
| mock xai (`xai-api-key`) | 20004 |
| mock meta (`meta-api-key`) | 20005 |
| mock interactions (`interactions-api-key`) | 20006 |
| mock vertex (`vertex-api-key`) | 20007 |

Access keys: client API key `oracle2-local-key-1`; management key `oracle2-mgmt-key` (server
bcrypt-hashes it in the mounted config on startup — expected mutation, plaintext stays valid).

## 2. Files

- Config: `_cpa_edge_ref/run2/run/config.yaml` — port 8387; all 8 provider base-urls point at
  `host.docker.internal:<my port>`; same model aliases as worker-1 (`mock-model`, `gm`, `cm`,
  `cx`, `xg`, `mm`, `im`, `vm`); `request-retry: 0`, `transient-error-cooldown-seconds: -1`,
  `usage-statistics-enabled: false`; no real credentials.
- Mocks: `_cpa_edge_ref/run2/mock/` — copied from `_cpa_edge_ref/mock/`, ports adapted. All 8
  scripts now take the port as argv (codex/xai/meta were hardcoded in the shared copy; the
  defaults here are 20003/20004/20005). `mocklib.py` derives `control/` + `logs/` from the
  script location, so control files and wire logs stay inside `run2/mock/`.
- Probe runner: `_cpa_edge_ref/run2/tools/probe_boot2.py` (adapted from `tools/probe_mocks.py`).
- Boot proofs: `_cpa_edge_ref/run2/probes/` (see §4).

## 3. Run instructions

```bash
# 1. reference (config is mounted read-write; the server hashes secret-key in place)
docker run -d --name cpa-oracle-2   -p 127.0.0.1:8387:8387   -v ~/projects/llm-api/_cpa_edge_ref/run2/run/config.yaml:/CLIProxyAPI/config.yaml   -v ~/projects/llm-api/_cpa_edge_ref/run2/run/auths:/root/.cli-proxy-api   eceasy/cli-proxy-api:v7.3.4
docker logs -f cpa-oracle-2   # wait for "API server started successfully on: :8387"

# 2. mocks (one per needed type; port is optional argv, defaults are the run2 ports)
python3 _cpa_edge_ref/run2/mock/mock_openai.py 19999 &
python3 _cpa_edge_ref/run2/mock/mock_gemini.py 20001 &
# ... claude 20002, codex 20003, xai 20004, meta 20005, interactions 20006, vertex 20007

# 3. modes (optional): echo '{"mode":"error","status":429}' > _cpa_edge_ref/run2/mock/control/gemini.json
#    per-request override: X-Mock-Mode / X-Mock-Status / X-Mock-Delay-Ms / X-Mock-After

# 4. probe
curl -sS http://127.0.0.1:8387/v1/chat/completions \
  -H 'Authorization: Bearer oracle2-local-key-1' -H 'Content-Type: application/json' \
  -d '{"model":"gm","messages":[{"role":"user","content":"Say hello"}]}'

# stop: docker rm -f cpa-oracle-2; kill the mock processes; verify ports free
```

## 4. Boot proof (2026-09-16, recorded then torn down)

Container booted: "API server started successfully on: :8387", 8 clients loaded
(2 Gemini API keys incl. interactions + 1 each Vertex/Claude/Codex/xAI/Meta/OpenAI-compat).
`GET /v1/models` (Bearer oracle2-local-key-1) listed all 8 aliases.

| Round trip | Transcript | Result |
|---|---|---|
| OpenAI chat -> `openai-compatibility` mock, non-stream | `run2/probes/openai/t1-chat-nonstream.md` | 200, upstream id `chatcmpl-mock-0001` |
| OpenAI chat -> `openai-compatibility` mock, SSE | `run2/probes/openai/t2-chat-stream.md` | 200, `data:` framing + `[DONE]` |
| OpenAI chat -> `gemini-api-key` mock, non-stream | `run2/probes/gemini/t1-chat-nonstream.md` | 200, translated `{"id":"","object":"chat.completion","created":0,...}` |
| OpenAI chat -> `gemini-api-key` mock, SSE | `run2/probes/gemini/t2-chat-stream.md` | 200, `native_finish_reason`/`reasoning_content:null` + `[DONE]` |

Reference-emitted upstream wire logs (secrets redacted, my health-check lines excluded):
`run2/probes/openai/upstream.jsonl`, `run2/probes/gemini/upstream.jsonl`.
Container boot log: `run2/probes/container-boot-log.txt`. Index: `run2/probes/README.md`.

## 5. Wire deviations vs worker-1 (`probes/mocks/README.md`)

None. Byte-identical upstream shapes on the proven types:
- openai-compat: UA `cli-proxy-openai-compat`, non-stream body 83 bytes, stream request adds
  `Accept: text/event-stream` + `Cache-Control: no-cache` and injects
  `"stream_options":{"include_usage":true}` (139 bytes); alias `mock-model` -> `mock-gpt-model`.
- gemini: UA `Go-http-client/1.1`, `x-goog-api-key`, injected `safetySettings` (all-OFF) +
  `model` (425-byte body), stream via `:streamGenerateContent?alt=sse`.
- Downstream translation artifacts match (empty id / created 0 for gemini, CORS block on every
  response, `X-Cpa-Trace-Id` present).
One tooling note: `mocklib.py` appends the mock's own health-check requests to the wire log too;
`upstream.jsonl` snapshots here are filtered to `Host: host.docker.internal` (reference-emitted
only), same convention worker-1 documents. Caveat from BOOTSTRAP confirmed here as well: the
server bcrypt-hashes the mounted `secret-key` plaintext on startup.

## 6. Teardown verification (2026-09-16)

- Container `cpa-oracle-2` removed (`docker ps -a` empty).
- All 8 mocks SIGTERM'd; handles exited -15.
- All ports re-verified free: 8387, 19999, 20001-20007 (bind test; lsof/netstat clean).
- Worker-1 stack untouched (was idle the whole session; no files under `run/`, `probes/`, `mock/` modified).

## 7. Recording missions

Send case files per the RECIPES contract (BOOTSTRAP.md §7): step-id, request set per case,
upstream provider type + desired mode. Fixtures land in `cpa-edge/tests/fixtures/<step-id>/<case-id>/`
(meta.yaml / request.http / downstream.md / upstream.jsonl / mock-response.json). I only record
into fixture dirs a mission assigns to me; if a mode/behavior can't be reproduced I say so
instead of approximating.


## 8. Recording missions delivered (2026-09-16, after BOOT-2)

All executed on the isolated run2 stack (reference 127.0.0.1:8387; mocks 19999/20001-20008;
ports masked as dynamic fields per each section's whitelist). Stack torn down after every
mission; sandbox drivers + configs under `_cpa_edge_ref/run2/{s3,s6,s2d10,s2d3}/` and
`run2/tools/`.

| Mission | Fixtures | Notes |
|---|---|---|
| S3 auth flows (spec-s3-auth) | `tests/fixtures/S3/` — 38 cases | all 38 accepted; surprises A-F folded into S3 section §6 |
| S6 state/storage (spec-s6-state) | `tests/fixtures/S6/` — 17 cases (16 + follow-up S6-18) | AUTH $17 off-by-one, counted-pop *0, state-dependent QUIT, 503 auth_unavailable transient-cooldown + .cds restart persistence, upload re-serialization — folded into S6 section |
| S2d10 antigravity (spec-s2d10-antigravity) | `tests/fixtures/S2d10/` — 18 cases (13 + port-busy + 3 executor + gemini extra) | forwarder port-busy RECORDED via in-container perl listener; synthetic antigravity credential routes to my mock (20008); always-SSE upstream for claude-family, generateContent for gemini-family |
| S2d3 oai→claude (spec-s2d3-oai2cla) | `tests/fixtures/S2d3/` — 18 cases | user_id sha256 anchor byte-exact; case-14 cooldown envelope surfaces at 429 (predicted 500) |
| S5 management API | NOT recorded | reassigned to oracle-runner-4 per orchestrator; dropped before any S5 work started |
| S2d9 codex passthrough (spec-s2d9-codex, reassigned from worker-5) | `tests/fixtures/S2d9/` — 17 cases | worker-1's cancelled set WIPED, fresh single-provenance re-record; 408 root-caused (mock writes-dict bug); codex HTTP errors are content-verbatim re-serialized; accepted + section finalized |
| S2d1 oai2gem (spec-s2d1-oai2gem, reassigned from worker-5) | `tests/fixtures/S2d1/` — 21 cases (20 + optional C21) | per-URL-model scripted gemini mock (s2d1_scripts.json); rate-limit cooldown = 429 model_cooldown (not 500) — family now consistent across gemini/claude/antigravity |

New reusable assets in my sandbox: `mock_antigravity.py` (v1internal wire, 20008) and
`mock_claude.py` extended with scripts (tool_use/thinking/stop_variant/error_event) +
`mocklib` raw_body support — all in the run2 COPY only; worker-1's shared mock dir untouched.

Standing by for further recording requests per the RECIPES contract (BOOTSTRAP.md §7).
