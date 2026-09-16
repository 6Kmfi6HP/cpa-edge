# T4 — end-to-end fixture-replay smoke (reference binary vs cpa-edge node runtime)

Owner: @oracle-runner (T4). Date: 2026-09-16. Verdict at the bottom.
Raw transcripts: `_cpa_edge_ref/t4/probes/` (stack layout + reproducible boot
sequence: `_cpa_edge_ref/t4/README.md`).

## 1. What ran

The same 16 recorded requests (taken byte-exactly from the fixtures named
below, only the `Host` header re-pointed at the live target) were replayed
over real TCP sockets against:

- **REF** — the pinned reference binary: fresh container per stack,
  `eceasy/cli-proxy-api:v7.3.4`, digest
  `sha256:97825da3009f98acf78b5c172fde650a5fbe7a690950a69ce6d7b535d77d4266`,
  config byte-derived from the RECORDED config files of the sampled fixtures
  (only port numbers adapted), mock fleet attached per the worker-stack
  recipes.
- **EDGE** — the cpa-edge node runtime via its documented composition
  (`createNodeGateway` + `listenGateway`, README quickstart; bundled with the
  repo's own `pnpm exec esbuild --bundle --platform=node --format=esm`),
  equivalent config, same mocks, same machine, same minutes.

Three stacks (the recorded fixtures pin the config per case):
- **A** baseline, no providers (S1-01/02/03/06/20/21) — ref 18417 / edge 18418
- **B** baseline + `openai-compatibility` mock-openai → mock 23999
  (S1-09/11/14/15/17, S2d2 countTokens, S2d2 cooldown pair) — ref 18427 / edge 18428
- **C** `gemini-api-key` mock-gem-key → mock 24001 (S2d8-09) — ref 18437 / edge 18438

Mock fidelity: `control/gemini.json` carried the S2d8-09 `canned_stream` from
the fixture meta; the cooldown pair used the recorded 429 `error_body`
control; happy paths used the fleet defaults (S1-14/15/17 reproduce the
recorded mock bytes, incl. the `data: [DONE]` terminator).

Diff method: status + headers (name→value) + body bytes, modulo the volatility
whitelist (SPEC §5 + each fixture's `meta.yaml dynamic_fields`: `Date`,
`Content-Length`, `X-Cpa-Trace-Id` values/presence-parity, `created`,
ports); SSE bodies compared as raw decoded bytes AND decoded event sequences
per R-SSE; header EMISSION ORDER compared separately (the fixtures record
"received order"); upstream wires compared from the mock logs (gateway-owned
set; transport bookkeeping masked).

## 2. The sample (16 requests / 12 groups) and results

| # | Mission item | Fixture request | REF | EDGE | GOLDEN | body parity REF=EDGE | REF vs GOLDEN | EDGE vs GOLDEN |
|---|---|---|---|---|---|---|---|---|
| 1 | meta (root) | S1-01 `GET /` | 200 | 200 | 200 | byte-identical (116 B) | exact | exact* |
| 2 | meta (healthz) | S1-21 `GET /healthz` | 200 | 200 | 200 | byte-identical (15 B) | exact | exact* |
| 3 | auth-matrix (invalid) | S1-06 `GET /v1/models` bad Bearer | 401 | 401 | 401 | byte-identical (27 B) | exact | exact* |
| 4 | auth-matrix (valid) | S1-09 `GET /v1/models` valid Bearer | 200 | 200 | 200 | identical; `created` masked (dynamic) | exact | exact* |
| 5 | R-404 | S1-03 `GET /top-level-nope` | 404 | 404 | 404 | empty body both | exact | exact* |
| 6 | OPTIONS+CORS | S1-02 `OPTIONS /v1/chat/completions` | 204 | 204 | 204 | empty body both | exact | exact* |
| 7 | mgmt auth (none) | S1-20 `GET /v0/management/config` no key | 401 | 401 | 401 | byte-identical (34 B) | exact | exact* |
| 8 | mgmt config-get | S1-20 `GET /v0/management/config` Bearer | 200 | 200 | 200 | **2686-byte effective-config echo byte-identical** | exact | exact* |
| 9 | model_not_found | S1-11 `POST /v1/chat/completions` unknown model | 400 | 400 | 400 | byte-identical (136 B) | exact | exact* |
| 10 | dispatch chat non-stream | S1-14 `POST /v1/chat/completions` mock-model | 200 | 200 | 200 | byte-identical (319 B) | exact | exact* |
| 11 | dispatch chat stream | S1-15 same route `stream:true` | 200 | 200 | 200 | **SSE raw decoded bytes identical (631 B, 4+DONE frames)** | exact | **header order F2** |
| 12 | countTokens local synthesis | S2d2 `POST /v1beta/models/mock-model:countTokens` | 200 | 200 | 200 | byte-identical `{"totalTokens":4,"promptTokensDetails":[{"modality":"TEXT","tokenCount":4}]}`; **0 upstream calls on both** | exact | exact* |
| 13 | /v1beta alt=json raw mode | S1-17 `:streamGenerateContent?alt=json` | 200 | 200 | 200 | byte-identical (246 B, 2 raw chunks, `text/plain` CT) | exact | exact* |
| 14 | cooldown pair R1 (429 passthrough) | S2d2 `:streamGenerateContent?alt=sse` | 429 | 429 | 429 | byte-identical (97 B error passthrough) | exact | exact* |
| 15 | cooldown pair R2 (window response) | S2d2 `:generateContent` | 429 | 429 | 429 | byte-identical; see §3.3 | exact | **trace presence F1** |
| 16 | dispatch messages stream (gemini alias) | S2d8-09 `POST /v1/messages` gm, stream | 200 | 200 | 200 | **SSE 941 B / 7 events byte-identical** (incl. `msg_1nZd…` literal id, usage 4/9/6, 3-newline framing) | exact | **header order F2** |

\* "exact" = every non-whitelisted header value, the body bytes, and the
golden `Content-Length` cross-check all match. On top of every EDGE row, the
transport-emission delta T1 (§3.4) applies.

### 3.1 REFERENCE reproduces the recordings
REF vs GOLDEN: **16/16 exact** (whitelisted fields masked). A fresh container
of the pinned image replaying the recorded requests reproduces every recorded
golden byte-for-byte — the fixtures and the diff method are sound.

### 3.2 cpa-edge golden parity
EDGE vs GOLDEN: **13/16 fully exact; 3 rows diverge, all header-layer**
(bodies + statuses byte-exact on all 16):
- **F2 (2 rows)** — SSE commit header order (rows 11, 16): EDGE emits
  `Content-Type` before `Cache-Control`; every recorded golden (and the live
  REF) emits `Cache-Control`, then `Connection: keep-alive`, then
  `Content-Type`.
- **F1 (1 row)** — cooldown window response (row 15): EDGE emits
  `X-Cpa-Trace-Id` on the 429 `model_cooldown` envelope; the recorded golden
  has none (see §3.3).

### 3.3 Cooldown pair — both states captured
The golden `reset_seconds: 4` was recorded at the **3rd consecutive 429**
(the S2d2 escalation ladder, spec §355: 1s → 2s → 4s per post-window failure).
- Fresh-state pair (first 429 of a fresh process): REF and EDGE both answer
  R2 with `Retry-After: 1`, `"reset_seconds":1,"reset_time":"1s"` —
  **byte-identical between the two systems** (356 B), matching the ladder's
  first step. Transcripts: `probes/{ref,edge}-stackB-error/`.
- Recorded-state pair (after driving both systems to the 3rd consecutive
  429): REF and EDGE both answer R2 with `Retry-After: 4` and
  `"reset_seconds":4,"reset_time":"4s"` — **byte-identical to each other and
  to the golden** (356 B). Transcripts: `probes/{ref,edge}-stackB-error3/`.
  The window-escalation model reproduces end-to-end on both systems.
- R1 (the 429 passthrough) is byte-exact in both states on both systems.

### 3.4 Transport-emission deltas (platform HTTP server layer, not gateway logic)
- **T1**: node:http auto-emits `Connection: keep-alive` +
  `Keep-Alive: timeout=5` on EVERY response and appends `Date` after the
  gateway headers. The reference (gin) emits `Connection: keep-alive` only
  where the gateway sets it (SSE commits), never `Keep-Alive`, and places
  `Date`/`Content-Length` at the tail. Example (row 1, `GET /`):
  ```
  REF : Content-Type: application/json; charset=utf-8 / Date: … / Content-Length: 116
  EDGE: Content-Type: application/json; charset=utf-8 / Content-Length: 116 / Date: … / Connection: keep-alive / Keep-Alive: timeout=5
  ```
  The runtime DOES emit the gateway-owned `Connection: keep-alive` on SSE
  commits (value matches the golden; only its position differs, because
  `runtimes/node/src/server.ts` treats `connection` as server-managed and
  node then re-adds its own at the tail).
- **T2 (upstream side)**: undici adds `connection: keep-alive`,
  `accept: */*` (non-stream calls only), `accept-language: *`,
  `sec-fetch-mode: cors` and lowercases header names. The gateway-owned
  upstream header set + bodies are byte-identical to the goldens (below).

### 3.5 Upstream wire parity (mock logs vs golden upstream.jsonl)
For every upstream-touching request (S1-14, S1-15, S1-17, S2d8-09, cooldown
R1), REF, EDGE and the RECORDED `upstream.jsonl` agree byte-exactly on:
method, path, gateway-owned headers (`User-Agent: cli-proxy-openai-compat`
/ `Go-http-client/1.1`, `Authorization: Bearer mock-upstream-key`,
`Content-Type`, `Accept-Encoding: gzip`, the stream-only `Accept:
text/event-stream` + `Cache-Control: no-cache` pair, `X-Goog-Api-Key`) and
full bodies — incl. the alias rewrite `mock-model`→`mock-gpt-model`, the
injected `"stream_options":{"include_usage":true}`, and the 425-byte
gemini body with the all-OFF `safetySettings`. Requests with recorded
`upstream_wire_delta 0` (countTokens, model_not_found, the cooldown R2,
auth/404/OPTIONS/mgmt rows) made **zero** upstream calls on both systems.

## 4. Findings (blockers by the T4 charter)

- **F1 — EDGE emits `X-Cpa-Trace-Id` on the 429 `model_cooldown` envelope**
  (row 15; also present in the fresh-state pair). Side-by-side (R2 head):
  ```
  GOLDEN/REF: Content-Type: application/json … Retry-After: 4, Date, Content-Length   (no trace header)
  EDGE      : … X-Cpa-Trace-Id: 2026…-0-… …  (trace present)
  ```
  Recorded evidence: every `model_cooldown` golden lacks the trace header —
  S2d2 (this sample), S2d1 C16, S2d3 `s2d3-err-429-verbatim-cooldown`,
  S2d7 `S2d7-19`/`S2d7-31`, S2d9 `S2d9-12`. All other 15 rows match golden
  trace presence exactly (incl. its ABSENCE on 401/400/404/204/root/healthz
  and its PRESENCE on executor-routed rows), so the divergence is specific
  to the cooldown envelope. Which side diverges from the golden: **EDGE**
  (REF matches). Locus: the route layer marks a resolved-model facade
  response trace-eligible even when the facade produced the
  selector-cooldown envelope with no upstream call (R-TRACE scopes trace to
  executor-routed responses). Charter nuance: `X-Cpa-Trace-Id` is IN the
  volatility whitelist, but the whitelist masks VALUES; the goldens (and the
  s1 suite's presence-parity rule) pin PRESENCE. Flagging for an
  orchestrator ruling.
- **F2 — SSE commit header order is swapped in EDGE** (rows 11, 16; systemic).
  ```
  GOLDEN/REF: … Access-Control-Expose-Headers / Cache-Control: no-cache / Connection: keep-alive / Content-Type: text/event-stream / X-Cpa-Trace-Id
  EDGE      : … Access-Control-Expose-Headers / Content-Type: text/event-stream / Cache-Control: no-cache / X-Cpa-Trace-Id
  ```
  Which side diverges from the golden: **EDGE** (REF matches). Locus: the
  `SSE_HEADERS` constant in every direction module declares
  `[Content-Type, Cache-Control, Connection]` (e.g.
  `packages/translators/src/oai2oai/service.ts`, `cla2gem/service.ts`,
  `gem2oai/service.ts`, `cla2oai/service.ts`, `res2oai/service.ts`); the
  recorded order is `Cache-Control, Connection, Content-Type`. No contract
  suite pins downstream header ORDER (s1 compares a name→value map; s2d*
  assert the direction-owned subset by value), which is why the 2053-test
  suite stays green. One shared constant reorder fixes all directions.
- **T1/T2 — platform transport emissions** (§3.4): non-whitelisted bytes by
  the letter of the charter (`Keep-Alive: timeout=5` is absent from the
  reference wire on every response; `Date`/`Connection` placement differs).
  Root cause is the node:http platform adapter vs gin, not gateway behavior:
  the gateway seam (the 2053-test surface) emits the recorded header set,
  and `runtimes/node/src/server.ts` deliberately manages
  `connection`/`transfer-encoding`/`date`. Byte-level socket parity with
  gin's transport would require the server adapter to emit `Date`/`Connection`
  itself in the recorded positions (pass the gateway `Connection` header
  through and let the platform skip its own) — an adapter decision for the
  integrator, outside my ownership. Submitted for an orchestrator ruling on
  whether hop-by-hop transport emissions block release.

## 5. Whitelist compliance

Masked per SPEC §5 + fixture `meta.yaml dynamic_fields` only: `Date`,
`Content-Length`, `X-Cpa-Trace-Id` (value; presence compared),
`created`/`created_at` (S1 metas; live stamps: REF 1789518378 / EDGE
1789518395 vs golden 1789490816 — registry-build epoch, dynamic), ports
(my stacks use the T4 port set; the reference port appears only in the
never-compared client `Host`). SSE compared per R-SSE (decoded events) —
and additionally raw decoded bytes, which also matched. Nothing else was
masked; every other byte was compared and matched.

## 6. Verdict

**PASS (final, after the F1/F2 fixer landed — see §8).** Every gateway-owned
byte matched across REF, EDGE and the RECORDED goldens on the re-run: all 16
statuses, all 16 bodies (both SSE streams, the management echo, both cooldown
states), upstream wires, header values and header emission order. The only
remaining deltas are the REGISTERED node-platform transport facts T1/T2
(orchestrator ruling, §7): node:http's `Connection: keep-alive` +
`Keep-Alive: timeout=5` + `Date` placement downstream, and undici's
default headers upstream — non-blocking, v1.1 refinement.

Initial verdict at first run: FAIL on F1 (trace on the cooldown envelope)
and F2 (SSE commit header order); both were fixed by the fixer commit
(`151ba6b`, "F1 trace exclusion on selector envelopes + F2 SSE emission
order across 10 modules") and re-verified green in §8.

## 7. Ruling addendum (orchestrator, 2026-09-16, msg agentmsg_3bcf1d47)

- **T1 / T2**: REGISTERED as node-platform transport facts. The gateway seam
  emits the recorded header set correctly; adapter-level emission parity
  (server.ts passthrough of the gateway `Connection` header + `Date`
  positioning) is a **v1.1 refinement**. Neither blocks release.
- **F1 / F2**: dispatched to a fixer (trace presence on the cooldown
  envelope; SSE commit header order). The FAIL verdict below stands on
  those two findings until the fixer lands and T4 re-verifies.


## 8. Re-verify after the F1/F2 fixes (2026-09-16, orchestrator-requested)

Trigger: orchestrator rulings (§7) + the accepted fixer commit `151ba6b`
(F1 trace exclusion on selector envelopes; F2 SSE emission order across 10
modules). Method unchanged: same `sample.json` bytes, same configs, same
mocks, fresh containers (REF) and a re-bundled edge host from the fixed tree
(`pnpm exec esbuild` of the same host.ts). Transcripts:
`_cpa_edge_ref/t4/probes/*-r2/` + `upstackB-r2-all.jsonl` / `upstackC-r2-all.jsonl`.

| Row | Fixture request | First-run problem | Re-run result |
|---|---|---|---|
| 11 | S1-15 chat-stream | F2 order | **GREEN** — edge wire now `…Expose-Headers, Cache-Control, Content-Type, X-Cpa-Trace-Id, Date, [transport]`; SSE 631 B byte-identical REF=EDGE and vs golden; order note gone |
| 16 | S2d8-09 messages-stream | F2 order | **GREEN** — edge wire `…Expose-Headers, Cache-Control, Content-Type, X-Cpa-Trace-Id, Date, [transport]`; SSE 941 B / 7 events byte-identical; zero golden problems on REF, transport-only on EDGE |
| 15 | S2d2 cooldown R2 (fresh state) | F1 trace presence | **GREEN** — edge R2 head now `…Expose-Headers, Content-Type, Retry-After: 1, [transport]`, **no X-Cpa-Trace-Id**; 356 B byte-identical REF=EDGE |
| 15 | S2d2 cooldown R2 (recorded state, 3rd consecutive 429 via escalate.py) | F1 + golden parity | **GREEN** — both systems emit `Retry-After: 4`, `"reset_seconds":4,"reset_time":"4s"`; body byte-exact vs golden; no trace header on either side |

Unchanged-rows confirmation (re-run as part of the same phases):
S1-09 / S1-11 / S1-14 / S1-17 / S2d2 countTokens all re-ran green — statuses,
bodies (109/136/319/246/76 B) and upstream wires byte-identical across
REF/EDGE/golden (`upstackB-r2-all.jsonl`, `upstackC-r2-all.jsonl`), zero
upstream calls for the local-synthesis and error rows.

Residual diffs on every edge row = the registered transport facts T1/T2
only (`Connection: keep-alive` + `Keep-Alive: timeout=5` present; `Date`
appended by node after the gateway headers; undici's upstream defaults).
The gateway-owned header set, values and ORDER now match the recorded
goldens everywhere.

Teardown re-verified after the re-run: containers `cpa-oracle-t4b/c`
removed, mocks + edge hosts killed, all T4 ports free, mock control
restored to `{"mode": "happy"}`.
