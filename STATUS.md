# CPA-Edge STATUS

> Orchestrator-only file. Children must not edit it. A row with a non-empty assignee is WRITE-LOCKED to that agent.
> Started: 2026-09-15T22:40 local — 12h wall-clock budget. Phase ordering per task charter.

## Pipeline legend
`pending → locked(assignee) → spec → spec-adv → | impl → impl-adv → (fix → impl-adv)* | → merged` — gate max 3 rounds, then escalate to human.

## Steps
| step | scope | phase | assignee (lock) | pipeline | gate rounds | notes |
|---|---|---|---|---|---|---|
| P0.1 | repo skeleton (root configs, SPEC/STATUS) | 0 | — | pending | 0 |  |
| P0.2 | packages/core: Store interface + memory impl + error registry | 0 | — | merged | 2 | impl-p0-core impl; adv round1 FAIL (B1 aliasing) -> fix-p0-core -> round2 PASS; N8 portability note carried to S6/T2 |
| ORACLE | reference env at _cpa_edge_ref (outside repo) | — | — | merged | 0 | v7.3.4 anchor; image digest recorded; 17 probes; recordable/credentialed table; harness proven |
| S1 | spec: endpoint inventory | 1 | spec-s1-endpoints | merged | 2 | ADMITTED round 2. 25 goldens (283 files). Feeds T1 routing + all handler contracts. 4 residual nits -> writer cleanup, no re-gate per reviewer. |
| S2d1 | spec: OpenAI client → Gemini upstream | 1 | spec-s2d1-oai2gem | merged | 2 | ADMITTED round 2. 23 goldens incl. C22/C23 multi-candidate. PHASE 1 COMPLETE: 16/16 sections admitted. |
| S2d2 | spec: Gemini client → OpenAI upstream | 1 | spec-s2d2-gem2oai | merged | 2 | ADMITTED round 2. 26 goldens; countTokens formula independently reproduced by reviewer. Unlocks I-tr-S2d2. |
| S2d3 | spec: OpenAI client → Claude upstream | 1 | spec-s2d3-oai2cla | merged | 2 | ADMITTED round 2. 26 goldens. Unlocks I-tr-S2d3. |
| S2d4 | spec: Claude client → OpenAI upstream | 1 | spec-s2d4-cla2oai | merged | 2 | ADMITTED round 2. 34 goldens; two-stage effective thinking fully recorded; discriminator settled. Unlocks I-tr-S2d4 (queued for slot). |
| S2d5 | spec: OpenAI client → Codex/Responses upstream | 1 | spec-s2d5-oai2codex | merged | 2 | ADMITTED round 2 (R1-R7 text rider to writer). 26 goldens; union->enum MUST + type-selection pinned. Unlocks I-tr-S2d5. |
| S2d6 | spec: Responses client → OpenAI chat upstream | 1 | spec-s2d6-res2oai | merged | 3 | ADMITTED round 3. 27 goldens; stream Ensure + CloseError catalog + empty200 conductor rule. Unlocks I-tr-S2d6. |
| S2d7 | spec: Gemini client → Claude upstream | 1 | spec-s2d7-gem2cla | merged | 2 | ADMITTED round 2. 31 goldens; validator families byte-pinned; empty-stream conductor gate recorded-deviation integrated. Unlocks I-tr-S2d7. |
| S2d8 | spec: Claude client → Gemini upstream | 1 | spec-s2d8-cla2gem | merged | 2 | ADMITTED round 2. 18 goldens; two-stage thinking rule; byte-encoding MUSTs. Unlocks I-tr-S2d8. |
| S2d9 | spec: Codex/Responses passthrough semantics | 1 | spec-s2d9-codex | merged | 2 | ADMITTED round 2. 17 goldens + S2d9-18 observation pin. NOTE: reviewer verified the pre-S2d9-18 state (conservative); the recorded 404->503 pin only strengthens. Unlocks I-tr-S2d9. |
| S2d10 | spec: Antigravity redirect rules | 1 | spec-s2d10-antigravity | merged | 2 | ADMITTED round 2. 18 goldens; R-SYNCREDS precedent; feeds I-exec-antigravity + I-auth antigravity flow. |
| S3 | spec: auth flows | 1 | spec-s3-auth | merged | 3 | ADMITTED after 3 rounds. Goldens: 44 dirs. Unlocked I-auth + S3 contract tests. |
| S4 | spec: scheduling | 1 | spec-s4-scheduling | merged | 2 | ADMITTED round 2. 23 goldens; per-family ID contracts numerically verified; WS-preference divergence pinned. Unlocks I-core. |
| S5 | spec: management API | 1 | spec-s5-mgmt | merged | 2 | ADMITTED round 2. 22 goldens / 168 steps. Unlocks I-mgmt (after I-auth interfaces land) + S5 contract tests. |
| S6 | spec: state & storage schemas | 1 | spec-s6-state | merged | 2 | ADMITTED round 2. 17 goldens; 3 catalogs; per-path re-serialization; vertex type; RESP node-contract. Residual editorial: N2 schema omitempty marks, N7 store-auth shape, citation tag split |
| S7 | spec: platform degradation matrix | 1 | spec-s7-platform | merged | 3 | ADMITTED after 3 rounds. NE registry feeds SPEC §5. RuntimeCapabilities -> I-core; T2/T3/D1 bindings recorded. |
| I-core | packages/core: scheduling algorithms | 2 | impl-i-core | impl | 0 |  |
| I-auth | packages/auth: OAuth/device/refresh | 2 | — | merged | 2 | MERGED: auth complete (spec 3 rounds + impl gate 2 rounds). 168 unit + 44 contract live. Ledger: reset-preserves-ban + blocked_until-field hardening -> T1; N4/N5/N6/N8-N16 residuals -> D2. |
| I-tr-S2d1 | packages/translators: OpenAI→Gemini | 2 | impl-i-tr-s2d1 | impl | 0 |  |
| I-tr-S2d2 | packages/translators: Gemini→OpenAI | 2 | — | merged | 1 | MERGED: gem2oai PASS-WITH-NONBLOCKING round 1. 123 module + 26 contract live green. Ledger: N1 depth-cap->400 (T1 hardening), N2 countTokens time-box (T2), N3 failureCount atomicity (S4-impl note), N4 alt-empty spec sentence, N5 model-stamp parity, N6 leniency notes (D2). |
| I-tr-S2d3 | packages/translators: OpenAI→Claude | 2 | — | merged | 2 | MERGED: oai2cla complete (spec 2 rounds, impl-review 2 rounds). 141 unit + 28 contract green. Residual: Store-get-throw hardening -> T2; N6 UA default blessed; N9 js-tiktoken kept (R-TOK) |
| I-tr-S2d4 | packages/translators: Claude→OpenAI | 2 | — | merged | 1 | MERGED: cla2oai PASS-WITH-NONBLOCKING round 1. 89/89 (34 golden). Rulings: N2 per-surface recorded pins stand (S2d8-20 vs S2d6 cross-surface contrast); N1 depth guard -> T1 wrapper covers; N3-N6 ledger. |
| I-tr-S2d5 | packages/translators: OpenAI→Codex/Responses | 2 | — | merged | 1 | MERGED: oai2codex PASS round 1. 89 module + contract 25/25 live. Ledger: N1 E8/401 interplay (spec ruling if ever recorded), N3 usage_limit type-only, N5 dup-key first-vs-last, N6 pattern-strip blacklist-vs-whitelist, N8 fleet cooldown candidate order (S4), N12 text-object presence (D2). |
| I-tr-S2d6 | packages/translators: Responses→OpenAI chat | 2 | — | merged | 1 | MERGED: res2oai PASS-WITH-NONBLOCKING round 1. 107 module + 29 contract live. Ledger: N1 depth-cap (T1 uniform hardening), N2-N4 unpinned corners (spec notes), N5 auth-transport (route layer owns), N6/N7 trivia. |
| I-tr-S2d7 | packages/translators: Gemini→Claude | 2 | — | merged | 2 | MERGED: gem2cla complete (spec 2 rounds, impl gate 2 rounds incl. S2d7-31 recorded ruling). 108 module + 33 contract green. |
| I-tr-S2d8 | packages/translators: Claude→Gemini | 2 | — | merged | 2 | MERGED: cla2gem complete (impl gate 2 rounds). 105 module + contract 22/22 incl. S2d8-21. Ledger: NR1 depth-cap asymmetry 7-10k response-side; N2/N4/N5/N6 carried. |
| I-tr-S2d9 | packages/translators: Codex passthrough | 2 | impl-i-tr-s2d9 | impl-adv | 0 | delivered: 91/91; contract clause bug routed; impl-review running on adv-impl-2 |
| I-tr-S2d10 | packages/translators: Antigravity redirect | 2 | — | pending | 0 |  |
| I-exec-openai | packages/executors: openai executor | 2 | — | merged | 0 | SATISFIED via direction modules per R-EXECS |
| I-exec-claude | packages/executors: claude executor | 2 | — | merged | 0 | SATISFIED via direction modules per R-EXECS |
| I-exec-gemini | packages/executors: gemini executor | 2 | — | merged | 0 | SATISFIED via direction modules per R-EXECS |
| I-exec-kimi | packages/executors: kimi executor | 2 | — | merged | 0 | OUT OF RECORDED SCOPE v1 per R-EXECS (native-wire degradation registered; credential lifecycle covered by S3/S4/S6) |
| I-exec-grok | packages/executors: grok executor | 2 | — | merged | 0 | OUT OF RECORDED SCOPE v1 per R-EXECS (native-wire degradation registered; credential lifecycle covered by S3/S4/S6) |
| I-exec-antigravity | packages/executors: antigravity executor | 2 | — | merged | 0 | SATISFIED via direction modules per R-EXECS |
| I-exec-custom-openai | packages/executors: custom-openai executor | 2 | — | merged | 0 | SATISFIED via direction modules per R-EXECS |
| I-mgmt | packages/management: /v0/management | 2 | — | merged | 2 | MERGED: management complete (impl gate 2 rounds). 50 unit + S5 24/24 + S6 20/20. Ledger: NR1 overflow-record off-by-one, NR2 callback now()-stamp, N3-N10. |
| T1 | runtimes/node integration + full contract tests | 3 | integrator-t1 | impl | 0 |  |
| T2 | runtimes/cloudflare (DO store, alarms, WS hibernation) | 3 | integrator-t2 | impl | 0 |  |
| T3 | runtimes/vercel (degraded per S7) | 3 | integrator-t3 | impl | 0 |  |
| T4 | end-to-end smoke: fixture replay vs upstream diff | 3 | — | pending | 0 |  |
| D1 | README/deploy guide, SPEC version anchor publication | 4 | — | pending | 0 |  |
| D2 | global final audit vs upstream README | 4 | — | pending | 0 |  |

## Verdict / escalation log
(appended by orchestrator)
