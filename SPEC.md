# CPA-Edge Functional Specification

Single source of truth for behavior. The orchestrator maintains this index; section
content is produced by assigned @spec-writer agents and admitted only after the
adversarial gate. Section files under `spec/sections/` are authoritative per module
once admitted.

## 0. Upstream anchor
- Reference project: CLIProxyAPI — https://github.com/router-for-me/CLIProxyAPI (MIT License).
- Version anchor: **PENDING** — @oracle-runner records release tag + commit; every golden sample cites this anchor.

Precedence when sources conflict: (1) recorded upstream behavior (@oracle-runner fixtures) > (2) this SPEC > (3) any implementation.

## 1. Immutable rules
1. CLEAN-ROOM: the reference project CLIProxyAPI (github.com/router-for-me/CLIProxyAPI, MIT) may be READ as a specification ONLY by roles explicitly allowed to read it. All code you write must be original TypeScript. Do NOT transliterate Go code line-by-line. Do NOT copy comments or internal identifier names. Public interface names (routes, config keys, header names, JSON fields) may match for compatibility.
2. RUNTIME-AGNOSTIC CORE: packages/{core,translators,executors,auth,management} may use ONLY Web Standard APIs (fetch, ReadableStream/WritableStream/TransformStream, Web Crypto via crypto.subtle, TextEncoder/Decoder, URL, AbortController, structuredClone). NO Node-specific APIs (fs, process, Buffer, net, node:* imports). Platform adapters belong in runtimes/.
3. TypeScript strict mode everywhere. Cross-package communication happens ONLY through explicitly exported interfaces. Never reach into another package's internals.
4. NO shared mutable global state. All persistent state goes through the abstract Store interface from @cpa-edge/core.
5. You own ONLY the files assigned to you in your mission brief. Do not edit other modules, other packages, STATUS.md, SPEC.md, root config files, or tests/contract/**.
6. Dependencies: prefer Web Standard APIs; the workspace lockfile is shared, so NEVER run `pnpm add`/`npm install` yourself — if you need a dep, state it in your reply and the orchestrator installs it.
7. When done (or blocked), reply to the orchestrator with: await agent_message.send(summary, receiver_role='parent') — include deliverable paths, commands you ran with results, self-check outcome, open questions.

## 2. Architecture baseline
- `packages/core` — Store abstraction (+ in-memory impl), shared model types, error registry, scheduling algorithms.
- `packages/translators` — pairwise protocol translation (N×N), one module per direction. No canonical intermediate representation.
- `packages/executors` — one upstream executor module per provider.
- `packages/auth` — OAuth flows, token lifecycle, credential storage (via Store).
- `packages/management` — `/v0/management` API.
- `runtimes/{node,cloudflare,vercel}` — platform adapters. `runtimes/node` is the reference runtime for contract tests.
- `tests/contract` — golden-sample contract tests owned by the spec side; implementers must not edit them.
- All state flows through the abstract `Store` from `@cpa-edge/core`; no shared mutable globals.

## 3. Section registry
| id | module | section file | gate status | goldens |
|---|---|---|---|---|
| S1 | endpoint inventory | spec/sections/S1-endpoints.md | pending | — |
| S2d1 | OpenAI client → Gemini upstream | spec/sections/S2d1-oai2gem.md | pending | — |
| S2d2 | Gemini client → OpenAI upstream | spec/sections/S2d2-gem2oai.md | pending | — |
| S2d3 | OpenAI client → Claude upstream | spec/sections/S2d3-oai2cla.md | pending | — |
| S2d4 | Claude client → OpenAI upstream | spec/sections/S2d4-cla2oai.md | pending | — |
| S2d5 | OpenAI client → Codex/Responses upstream | spec/sections/S2d5-oai2codex.md | pending | — |
| S2d6 | Responses client → OpenAI chat upstream | spec/sections/S2d6-responses2oai.md | pending | — |
| S2d7 | Gemini client → Claude upstream | spec/sections/S2d7-gem2cla.md | pending | — |
| S2d8 | Claude client → Gemini upstream | spec/sections/S2d8-cla2gem.md | pending | — |
| S2d9 | Codex/Responses passthrough semantics | spec/sections/S2d9-codex-passthrough.md | pending | — |
| S2d10 | Antigravity redirect rules | spec/sections/S2d10-antigravity-redirect.md | pending | — |
| S3 | auth flows (OAuth code, device RFC 8628, refresh, API keys, mgmt authz) | spec/sections/S3-auth-flows.md | pending | — |
| S4 | scheduling (round-robin, fill-first, cooldown, auth index, key rotation) | spec/sections/S4-scheduling.md | pending | — |
| S5 | management API (/v0/management) | spec/sections/S5-management-api.md | pending | — |
| S6 | state & storage (config/auth schemas, usage queue, log ring buffer) | spec/sections/S6-state-storage.md | pending | — |
| S7 | platform degradation matrix | spec/sections/S7-platform-degradation.md | pending | — |

## 4. Required section template
Every admitted section must contain:
1. Scope and boundaries (in/out).
2. Behavior inventory: endpoints/routes with methods and status codes, or pure-function semantics.
3. Schemas: request/response/stream-event field-by-field semantics.
4. Streaming: exact SSE event sequence rules (contract-test material; byte-exact comparisons ignore only whitelisted volatile fields).
5. Error semantics.
6. Golden samples index: paths under `tests/fixtures/<id>/`, each recorded by @oracle-runner against the anchored version.
7. Explicit open questions and intentional non-equivalences.

## 5. Intentional non-equivalence registry
(empty — populated from S7 and orchestrator verdicts)
