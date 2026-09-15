# CPA-Edge Functional Specification

Single source of truth for behavior. The orchestrator maintains this index; section
content is produced by assigned @spec-writer agents and admitted only after the
adversarial gate. Section files under `spec/sections/` are authoritative per module
once admitted.

## 0. Upstream anchor
- Reference project: CLIProxyAPI — https://github.com/router-for-me/CLIProxyAPI (MIT License).
- Version anchor: **CLIProxyAPI v7.3.4** — commit `8335eac731946bd4eff18f500653f93736df53d6` (tag dated 2026-09-15).
- Oracle binary: docker image `eceasy/cli-proxy-api:v7.3.4` (digest `sha256:97825da3009f98acf78b5c172fde650a5fbe7a690950a69ce6d7b535d77d4266`); source build requires go 1.26 (not available locally).
- Recording harness, probe transcripts, fixture RECIPES layout: `reports/oracle/BOOTSTRAP.md` (sandbox: `~/projects/llm-api/_cpa_edge_ref`).

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
6. Golden samples index: paths under `tests/fixtures/<id>/`, each recorded by @oracle-runner against the anchored version, following the RECIPES layout in `reports/oracle/BOOTSTRAP.md`.
7. Explicit open questions and intentional non-equivalences.

## 5. Compatibility rulings & intentional non-equivalence registry
- **Ruling R-404 (2026-09-15, from recorded upstream behavior):** HTTP 404 responses have an EMPTY body (gin-style), and a wrong method on a known route also yields 404 (not 405). CPA-Edge mirrors this exactly for behavioral compatibility. S1 must encode it. Nobody may "improve" this unless registered here as a degradation.
- **Ruling R-FIXTURE (2026-09-15):** Upstream behaviors classified RECORDABLE-LOCALLY (all client protocols over api-key/base-url-override upstreams: openai-compatibility, gemini-api-key, claude-api-key, codex-api-key, xai-api-key, meta-api-key, interactions-api-key, vertex-api-key) MUST have oracle-recorded goldens. CREDENTIALED-ONLY behaviors (OAuth providers: Gemini CLI/AIStudio, Claude, Codex, xAI, Meta, Kimi-native, Devin, Antigravity) are specified from upstream docs with cases marked `FIXTURE-DEFERRED` (documented behavior; error paths that ARE recordable still get goldens).
- **Ruling R-SSE (2026-09-15, from oracle worker-3 boot evidence):** the reference gateway re-chunks SSE transport frames nondeterministically between runs (decoded bodies identical). Contract tests for streaming MUST compare the DECODED SSE event sequence byte-exactly (event name + data payload bytes, in order), never raw TCP/curl chunk boundaries. Volatility whitelist still applies (timestamps, trace ids, ports). Spec sections must phrase stream requirements as event sequences.
- **Ruling R-BCRYPT (2026-09-15):** the reference hashes a plaintext `secret-key` into the mounted config on first startup; already-hashed configs are left unchanged. S3/S6 must encode both observations.
- **Ruling R-TOK (2026-09-16):** all local token estimation (claude-client input_tokens, gemini-client countTokens synthesis) uses js-tiktoken's o200k_base encoding (installed in packages/translators), byte-exact NUMERICALLY in contract tests (never masked). The estimation input follows each direction's recorded semantics (e.g. claude: system + per-message role+text/tool fields + tools + tool_choice joined by "\n"; gemini countTokens: translated-body segments). If js-tiktoken output disagrees with a recorded golden, the implementer replicates the reference's exact estimation, not the library default.
- (S7 degradations will be appended here.)
