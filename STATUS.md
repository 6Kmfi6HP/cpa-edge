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
| S2d1 | spec: OpenAI client → Gemini upstream | 1 | spec-s2d1-oai2gem | spec | 0 |  |
| S2d2 | spec: Gemini client → OpenAI upstream | 1 | spec-s2d2-gem2oai | merged | 2 | ADMITTED round 2. 26 goldens; countTokens formula independently reproduced by reviewer. Unlocks I-tr-S2d2. |
| S2d3 | spec: OpenAI client → Claude upstream | 1 | spec-s2d3-oai2cla | merged | 2 | ADMITTED round 2. 26 goldens. Unlocks I-tr-S2d3. |
| S2d4 | spec: Claude client → OpenAI upstream | 1 | spec-s2d4-cla2oai | spec | 0 |  |
| S2d5 | spec: OpenAI client → Codex/Responses upstream | 1 | spec-s2d5-oai2codex | merged | 2 | ADMITTED round 2 (R1-R7 text rider to writer). 26 goldens; union->enum MUST + type-selection pinned. Unlocks I-tr-S2d5. |
| S2d6 | spec: Responses client → OpenAI chat upstream | 1 | spec-s2d6-res2oai | spec | 0 |  |
| S2d7 | spec: Gemini client → Claude upstream | 1 | spec-s2d7-gem2cla | merged | 2 | ADMITTED round 2. 31 goldens; validator families byte-pinned; empty-stream conductor gate recorded-deviation integrated. Unlocks I-tr-S2d7. |
| S2d8 | spec: Claude client → Gemini upstream | 1 | spec-s2d8-cla2gem | spec | 0 | section+18 cases done; rulings sent; recording queued w5 |
| S2d9 | spec: Codex/Responses passthrough semantics | 1 | spec-s2d9-codex | spec | 0 |  |
| S2d10 | spec: Antigravity redirect rules | 1 | spec-s2d10-antigravity | merged | 2 | ADMITTED round 2. 18 goldens; R-SYNCREDS precedent; feeds I-exec-antigravity + I-auth antigravity flow. |
| S3 | spec: auth flows | 1 | spec-s3-auth | merged | 3 | ADMITTED after 3 rounds. Goldens: 44 dirs. Unlocked I-auth + S3 contract tests. |
| S4 | spec: scheduling | 1 | spec-s4-scheduling | merged | 2 | ADMITTED round 2. 23 goldens; per-family ID contracts numerically verified; WS-preference divergence pinned. Unlocks I-core. |
| S5 | spec: management API | 1 | spec-s5-mgmt | merged | 2 | ADMITTED round 2. 22 goldens / 168 steps. Unlocks I-mgmt (after I-auth interfaces land) + S5 contract tests. |
| S6 | spec: state & storage schemas | 1 | spec-s6-state | merged | 2 | ADMITTED round 2. 17 goldens; 3 catalogs; per-path re-serialization; vertex type; RESP node-contract. Residual editorial: N2 schema omitempty marks, N7 store-auth shape, citation tag split |
| S7 | spec: platform degradation matrix | 1 | spec-s7-platform | merged | 3 | ADMITTED after 3 rounds. NE registry feeds SPEC §5. RuntimeCapabilities -> I-core; T2/T3/D1 bindings recorded. |
| I-core | packages/core: scheduling algorithms | 2 | impl-i-core | impl | 0 |  |
| I-auth | packages/auth: OAuth/device/refresh | 2 | impl-i-auth | impl | 0 |  |
| I-tr-S2d1 | packages/translators: OpenAI→Gemini | 2 | — | pending | 0 |  |
| I-tr-S2d2 | packages/translators: Gemini→OpenAI | 2 | impl-i-tr-s2d2 | impl | 0 |  |
| I-tr-S2d3 | packages/translators: OpenAI→Claude | 2 | — | merged | 2 | MERGED: oai2cla complete (spec 2 rounds, impl-review 2 rounds). 141 unit + 28 contract green. Residual: Store-get-throw hardening -> T2; N6 UA default blessed; N9 js-tiktoken kept (R-TOK) |
| I-tr-S2d4 | packages/translators: Claude→OpenAI | 2 | — | pending | 0 |  |
| I-tr-S2d5 | packages/translators: OpenAI→Codex/Responses | 2 | impl-i-tr-s2d5 | impl | 0 |  |
| I-tr-S2d6 | packages/translators: Responses→OpenAI chat | 2 | — | pending | 0 |  |
| I-tr-S2d7 | packages/translators: Gemini→Claude | 2 | impl-i-tr-s2d7 | impl | 0 |  |
| I-tr-S2d8 | packages/translators: Claude→Gemini | 2 | — | pending | 0 |  |
| I-tr-S2d9 | packages/translators: Codex passthrough | 2 | — | pending | 0 |  |
| I-tr-S2d10 | packages/translators: Antigravity redirect | 2 | — | pending | 0 |  |
| I-exec-openai | packages/executors: openai executor | 2 | — | pending | 0 |  |
| I-exec-claude | packages/executors: claude executor | 2 | — | pending | 0 |  |
| I-exec-gemini | packages/executors: gemini executor | 2 | — | pending | 0 |  |
| I-exec-kimi | packages/executors: kimi executor | 2 | — | pending | 0 |  |
| I-exec-grok | packages/executors: grok executor | 2 | — | pending | 0 |  |
| I-exec-antigravity | packages/executors: antigravity executor | 2 | — | pending | 0 |  |
| I-exec-custom-openai | packages/executors: custom-openai executor | 2 | — | pending | 0 |  |
| I-mgmt | packages/management: /v0/management | 2 | — | pending | 0 |  |
| T1 | runtimes/node integration + full contract tests | 3 | — | pending | 0 |  |
| T2 | runtimes/cloudflare (DO store, alarms, WS hibernation) | 3 | — | pending | 0 |  |
| T3 | runtimes/vercel (degraded per S7) | 3 | — | pending | 0 |  |
| T4 | end-to-end smoke: fixture replay vs upstream diff | 3 | — | pending | 0 |  |
| D1 | README/deploy guide, SPEC version anchor publication | 4 | — | pending | 0 |  |
| D2 | global final audit vs upstream README | 4 | — | pending | 0 |  |

## Verdict / escalation log
(appended by orchestrator)
