# CPA-Edge STATUS

> Orchestrator-only file. Children must not edit it. A row with a non-empty assignee is WRITE-LOCKED to that agent.
> Started: 2026-09-15T22:40 local — 12h wall-clock budget. Phase ordering per task charter.

## Pipeline legend
`pending → locked(assignee) → spec → spec-adv → | impl → impl-adv → (fix → impl-adv)* | → merged` — gate max 3 rounds, then escalate to human.

## Steps
| step | scope | phase | assignee (lock) | pipeline | gate rounds | notes |
|---|---|---|---|---|---|---|
| P0.1 | repo skeleton (root configs, SPEC/STATUS) | 0 | — | pending | 0 |  |
| P0.2 | packages/core: Store interface + memory impl + error registry | 0 | impl-p0-core | fix | 1 | R1: adv FAIL (B1 update-return aliasing); fixer dispatched |
| ORACLE | reference env at _cpa_edge_ref (outside repo) | — | — | merged | 0 | v7.3.4 anchor; image digest recorded; 17 probes; recordable/credentialed table; harness proven |
| S1 | spec: endpoint inventory | 1 | — | pending | 0 |  |
| S2d1 | spec: OpenAI client → Gemini upstream | 1 | — | pending | 0 |  |
| S2d2 | spec: Gemini client → OpenAI upstream | 1 | — | pending | 0 |  |
| S2d3 | spec: OpenAI client → Claude upstream | 1 | — | pending | 0 |  |
| S2d4 | spec: Claude client → OpenAI upstream | 1 | — | pending | 0 |  |
| S2d5 | spec: OpenAI client → Codex/Responses upstream | 1 | — | pending | 0 |  |
| S2d6 | spec: Responses client → OpenAI chat upstream | 1 | — | pending | 0 |  |
| S2d7 | spec: Gemini client → Claude upstream | 1 | — | pending | 0 |  |
| S2d8 | spec: Claude client → Gemini upstream | 1 | — | pending | 0 |  |
| S2d9 | spec: Codex/Responses passthrough semantics | 1 | — | pending | 0 |  |
| S2d10 | spec: Antigravity redirect rules | 1 | — | pending | 0 |  |
| S3 | spec: auth flows | 1 | — | pending | 0 |  |
| S4 | spec: scheduling | 1 | — | pending | 0 |  |
| S5 | spec: management API | 1 | — | pending | 0 |  |
| S6 | spec: state & storage schemas | 1 | — | pending | 0 |  |
| S7 | spec: platform degradation matrix | 1 | — | pending | 0 |  |
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
- 2026-09-15 23:00 P0.2 gate round 1: FAIL — B1 blocking (update() returns internal object; caller mutation corrupts state). Rulings on N1-N8 in reports/adversary/P0.2.md. @fixer (fix-p0-core) dispatched: B1+N1+N3+N5 behavior fixes, N2/N4/N6/N7 doc-only, N8 deferred to S6/T2.
