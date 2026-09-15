# Oracle worker-3 — isolated reference stack (BOOT-3)

Standing role: @oracle-runner worker 3 (sibling of `oracle-runner`), same contract as worker 1
(see `BOOTSTRAP.md` for version anchor v7.3.4 and the RECIPES fixture contract).
Sandbox: `~/projects/llm-api/_cpa_edge_ref/run3/` (worker-3 private; worker-1's
`mock/`, `run/`, `probes/` untouched). Clean-room: only wire transcripts, no upstream source.

## Ready state (2026-09-16)

BOOT-3 complete. Everything is currently SHUT DOWN (container removed, mocks killed, all
worker-3 ports verified free). The stack is reproducible in <1 minute with the commands below.

## Ports (worker-3 private set)

| Purpose | Port |
|---|---|
| Reference binary (container `cpa-oracle-3`) | 127.0.0.1:8397 |
| openai mock (openai-compatibility) | 127.0.0.1:20999 |
| gemini mock (gemini-api-key) | 127.0.0.1:21001 |
| claude mock (claude-api-key) | 127.0.0.1:21002 |
| codex mock (codex-api-key) | 127.0.0.1:21003 |
| xai mock (xai-api-key) | 127.0.0.1:21004 |
| meta mock (meta-api-key) | 127.0.0.1:21005 |
| interactions mock (interactions-api-key) | 127.0.0.1:21006 |
| vertex mock (vertex-api-key) | 127.0.0.1:21007 |

## Layout

```
_cpa_edge_ref/run3/
  mock/                  # worker-1 fleet copy, port defaults patched to the set above
                         #   (codex/xai/meta gained optional argv port; others re-defaulted)
                         #   mocklib.py + wire semantics UNCHANGED -> run3/mock/logs/<type>.jsonl
                         #   mode control: run3/mock/control/<type>.json or X-Mock-* headers
  run/config.yaml        # port 8397; all 8 base-urls -> host.docker.internal:<worker-3 port>
  run/auths/             # empty auth dir mounted at /root/.cli-proxy-api
  tools/probe_boot3.py   # boot proof runner (transcripts -> probes/boot3/)
  probes/boot3/          # BOOT-3 proof transcripts (see below)
```

## Run instructions

```bash
# 1. mocks (each takes an optional explicit port; defaults are the worker-3 set)
cd _cpa_edge_ref/run3/mock
python3 mock_openai.py &        # 20999
python3 mock_gemini.py &        # 21001
python3 mock_claude.py &        # 21002
python3 mock_codex.py &         # 21003
python3 mock_xai.py &           # 21004
python3 mock_meta.py &          # 21005
python3 mock_interactions.py &  # 21006
python3 mock_vertex.py &        # 21007

# 2. reference binary (image eceasy/cli-proxy-api:v7.3.4,
#    digest sha256:97825da3009f98acf78b5c172fde650a5fbe7a690950a69ce6d7b535d77d4266)
docker run -d --name cpa-oracle-3 \
  -p 127.0.0.1:8397:8397 \
  -v ~/projects/llm-api/_cpa_edge_ref/run3/run/config.yaml:/CLIProxyAPI/config.yaml \
  -v ~/projects/llm-api/_cpa_edge_ref/run3/run/auths:/root/.cli-proxy-api \
  eceasy/cli-proxy-api:v7.3.4
docker logs -f cpa-oracle-3    # wait for: API server started successfully on: :8397

# 3. probe
python3 _cpa_edge_ref/run3/tools/probe_boot3.py

# 4. tear down (no daemons may outlive a mission)
docker rm -f cpa-oracle-3
pkill -f 'run3/mock/mock_.*\.py'
lsof -nP -iTCP -sTCP:LISTEN | grep -E ':(8397|20999|2100[1-7])'   # must print nothing
```

Keys: client api-key `oracle-local-key-1`; management secret-key plaintext `oracle-mgmt-key-1`
(config stores the bcrypt hash worker-1 already generated; the server does NOT re-mutate an
already-hashed config — verified byte-identical after a full container run).

## BOOT-3 proof transcripts (`_cpa_edge_ref/run3/probes/boot3/`)

All 200 OK through `http://127.0.0.1:8397`:

| Transcript | Path (client entry -> mock) | Result |
|---|---|---|
| t1-openai-compat-nonstream.md | OpenAI chat -> openai-compatibility (20999) | 200, `chat.completion`, model keeps upstream name `mock-gpt-model` (alias `mock-model` rewritten upstream), body byte-identical to worker-1's `probes/mocks/openai/t1-chat-nonstream.md` |
| t2-openai-compat-stream.md | OpenAI chat SSE -> openai-compatibility (20999) | 200, 3 chunks + `[DONE]`, decoded body byte-identical to worker-1's t2 |
| t1-gemini-nonstream.md | OpenAI chat -> gemini-api-key (21001) | 200, translated `{"id":"","object":"chat.completion","created":0,...,"native_finish_reason":"stop"}` — byte-identical to worker-1's `probes/mocks/gemini/t1-chat-nonstream.md` (344 bytes) |
| t2-gemini-stream.md | OpenAI chat SSE -> gemini-api-key (21001) | 200, deltas with `reasoning_content:null`,`tool_calls:null` — byte-identical to worker-1's t2 after Date/trace-id masking |
| upstream-openai.jsonl / upstream-gemini.jsonl | reference -> mock wire (secrets redacted) | identical to worker-1's upstream.jsonl after port normalization: UA `cli-proxy-openai-compat` vs `Go-http-client/1.1`, Bearer vs `x-goog-api-key`, injected `stream_options.include_usage` (openai stream), injected `safetySettings` all-OFF + `model` (gemini), alias->upstream model rewrite, `?alt=sse` stream URL |

## Wire deviations vs worker-1's README

NONE in request/response semantics. Two non-deviation observations:

1. SSE chunk-boundary jitter: curl `-v` reports the raw chunked-framing read size
   (`{ [654 bytes data]` worker-1 vs `{ [635 bytes data]` worker-3 for the same openai t2
   case). Decoded SSE bodies are byte-identical (629 bytes both). The reference re-chunks the
   downstream SSE per flush; contract tests must compare decoded SSE content, never chunk
   boundaries or raw verbose read sizes.
2. No config re-mutation: mounting an already-bcrypt-hashed `secret-key` left the file
   byte-identical through a full container run (worker-1 only documented the
   plaintext-gets-hashed case).

## Recording requests (spec-writers)

Send cases files + target fixture dirs per the RECIPES contract in `BOOTSTRAP.md` §7. I record
into `tests/fixtures/<step>/<case>/` only when a mission assigns that dir; I never approximate
a mode/behavior I cannot reproduce — I say so explicitly instead.

## Recording missions completed (2026-09-16)

All against the v7.3.4 anchor on the worker-3 stack; fixtures in RECIPES layout; raw transcripts
under `_cpa_edge_ref/run3/probes/<step>/`; drivers under `_cpa_edge_ref/run3/tools/record_*.py`.

| Step | Cases | Fixture dir | Mock extensions in run3/mock (mine only) | Key deviations recorded |
|---|---|---|---|---|
| S7 | 15 (+S7-16 deferred, not recorded) | `tests/fixtures/S7/` | none | ws-auth unset => auth REQUIRED (S7-01 401); logs land under AUTH DIR (S7-10); /v1/models non-empty on fleet config (S7-14); forwarder 302 port = config port (S7-13) |
| S2d7 | 25 (23 + 2 follow-up valid-args) | `tests/fixtures/S2d7/` | mock_claude.py: control `variant` tool/errstream/maxtokens/tool-valid | verbatim model name does NOT resolve on /v1beta; cooldown surfaces 429 (not 500); invalid input_json_delta spliced RAW (invalid-JSON frame, top-level finishReason, duplicate usageMetadata) — valid args confirm clean-shape hypothesis |
| S2d2 | 20 | `tests/fixtures/S2d2/` | mock_openai.py: control `scenario` (7 byte-exact scripts) + mocklib raw-string error_body | thinkingLevel auto -> reasoning_effort medium (no passthrough); cooldown 429 + reset 4s + Retry-After 4; models/-prefixed single-model GET 404s |
| S2d5 | 24 | `tests/fixtures/S2d5/` | responses_common.py: control `script` (9 scripts via s2d5_scripts.json) + mocklib x-mock-script | cooldown pair: R2 429 (not 500), reset 4/4s, last_upstream_error VERBATIM body (codex keeps raw, unlike openai-compat summary); rate-limit window outlasts the reported 1s — leave >=5s between error cases |

Operational notes for future missions on this stack:
- Rate-limit cooldowns are NOT disabled by `transient-error-cooldown-seconds: -1` and outlast the
  reported reset tail (1s reported, ~4s effective for codex/openai-compat). Wait >= 5s between
  error-mode cases; fire cooldown-pair B within <1s of A.
- The server persists management PUTs into config.yaml (e.g. `ws-auth: false` appears in the echo);
  reset config from `run3/run/config.pristine.yaml` between container sessions.
- Enabling logging-to-file also revealed: per-request error dumps (`error-*.log`) are written under
  the AUTH DIR even while logging is off (see S7-10/logs.md + aux copies in probes/S7/aux-logs/).
