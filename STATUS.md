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
| S1 | spec: endpoint inventory | 1 | spec-s1-endpoints | spec-adv-r2 | 1 | round-2 re-review queued on adv-spec-1 (after its S4 review) |
| S2d1 | spec: OpenAI client → Gemini upstream | 1 | spec-s2d1-oai2gem | spec | 0 |  |
| S2d2 | spec: Gemini client → OpenAI upstream | 1 | spec-s2d2-gem2oai | spec-fix | 1 | R1: adv-spec-4 FAIL (B1 alt=json raw mode; B2 auth transports; B3 post-translation thinking pipeline; B4 countTokens formula; B5 truncated-body re-record); NE-LENIENT registered |
| S2d3 | spec: OpenAI client → Claude upstream | 1 | spec-s2d3-oai2cla | spec | 0 |  |
| S2d4 | spec: Claude client → OpenAI upstream | 1 | spec-s2d4-cla2oai | spec | 0 |  |
| S2d5 | spec: OpenAI client → Codex/Responses upstream | 1 | spec-s2d5-oai2codex | spec-adv | 0 | section+24 goldens done; review assigned adv-spec-5; wire-note cooldown correction recorded |
| S2d6 | spec: Responses client → OpenAI chat upstream | 1 | spec-s2d6-res2oai | spec | 0 |  |
| S2d7 | spec: Gemini client → Claude upstream | 1 | spec-s2d7-gem2cla | spec-fix | 1 | R1: adv-spec-2 FAIL (B1 tokenizer ruling unapplied; B2 validator strings/goldens); R-TOK registered in SPEC §5 |
| S2d8 | spec: Claude client → Gemini upstream | 1 | spec-s2d8-cla2gem | spec | 0 | section+18 cases done; rulings sent; recording queued w5 |
| S2d9 | spec: Codex/Responses passthrough semantics | 1 | spec-s2d9-codex | spec | 0 |  |
| S2d10 | spec: Antigravity redirect rules | 1 | spec-s2d10-antigravity | spec-adv | 0 | section+17 goldens; synthetic-credential precedent; review queued on adv-spec-2 |
| S3 | spec: auth flows | 1 | spec-s3-auth | spec-fix | 2 | R2: B1-B6 RESOLVED; new F1 vertex-auth-files false clause + F2/F3 phrases; micro-amendment dispatched |
| S4 | spec: scheduling | 1 | spec-s4-scheduling | spec-adv | 0 | section+20 goldens done; review pending assignment |
| S5 | spec: management API | 1 | spec-s5-mgmt | spec-adv | 0 | section+22 goldens finalized; review assigned adv-spec-3 (GET/config secrets = mirror per S7-N2 ruling) |
| S6 | spec: state & storage schemas | 1 | spec-s6-state | spec-adv | 0 | section+17 goldens done; S7 amendments applied; review assigned adv-spec-6 |
| S7 | spec: platform degradation matrix | 1 | spec-s7-platform | spec-fix | 2 | R2: FAIL — propagation cluster only (F5a-3/NE-05/R-S7-B tails, vercel NE entry, 2 cosmetics). R3 = final round |
| I-core | packages/core: scheduling algorithms | 2 | — | pending | 0 |  |
| I-auth | packages/auth: OAuth/device/refresh | 2 | — | pending | 0 |  |
| I-tr-S2d1 | packages/translators: OpenAI→Gemini | 2 | — | pending | 0 |  |
| I-tr-S2d2 | packages/translators: Gemini→OpenAI | 2 | — | pending | 0 |  |
| I-tr-S2d3 | packages/translators: OpenAI→Claude | 2 | — | pending | 0 |  |
| I-tr-S2d4 | packages/translators: Claude→OpenAI | 2 | — | pending | 0 |  |
| I-tr-S2d5 | packages/translators: OpenAI→Codex/Responses | 2 | — | pending | 0 |  |
| I-tr-S2d6 | packages/translators: Responses→OpenAI chat | 2 | — | pending | 0 |  |
| I-tr-S2d7 | packages/translators: Gemini→Claude | 2 | — | pending | 0 |  |
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
