# CPA-Edge — contributor conventions (for agents)

Clean-room, serverless-first TypeScript rewrite of the CLIProxyAPI behavior.
Behavior source of truth: SPEC.md (+ spec/sections/*). Ownership: STATUS.md.

## Ground rules
1. CLEAN-ROOM: the upstream (github.com/router-for-me/CLIProxyAPI, MIT) is a SPECIFICATION for permitted roles only. Code here is original TypeScript. No line-by-line transliteration; no copied comments or internal identifiers. Public interface names (routes, config keys, headers, JSON fields) may match for compatibility.
2. RUNTIME-AGNOSTIC CORE: packages/{core,translators,executors,auth,management} use ONLY Web Standard APIs. Node-specific APIs live only in runtimes/node and tools.
3. TypeScript strict everywhere; cross-package access only via exported interfaces.
4. No shared mutable global state — persistent state flows through the Store interface from @cpa-edge/core.

## Commands (repo root: ~/projects/llm-api/cpa-edge)
- `pnpm install` — install (root lockfile; NEVER run pnpm add yourself, request deps via your reply)
- `pnpm test` — all vitest suites (unit + contract)
- `pnpm typecheck` — tsc --noEmit across all packages + tests
- `pnpm lint`
- single package: `pnpm --filter @cpa-edge/<name> typecheck`; `pnpm vitest run packages/<name>` for its tests only

## Ownership map (enforced by orchestrator locks)
- `packages/<pkg>/**` — the assigned implementer only
- `spec/sections/**` — the assigned spec-writer only (admitted via gate)
- `tests/contract/**` — spec side only. Implementers MUST NOT edit contract tests.
- `tests/fixtures/**` — @oracle-runner only
- `reports/**` — gate artifacts by the assigned role (adversary reports, fix logs, oracle notes)
- `STATUS.md`, `SPEC.md`, root configs — orchestrator only
- Upstream reference lives OUTSIDE this repo at ~/projects/llm-api/_cpa_edge_ref — implementers must NOT read it; @spec-writer and @oracle-runner may.

## Self-check before replying (adversary will hunt for these)
- No TODO/stub/placeholder left in delivered code; no silently swallowed catches.
- No `any` (use `unknown` + narrowing); no Node imports in packages/*.
- Comments in your own words; nothing that reads like translated Go.
- Tests assert observable behavior; flaky/timing-dependent assertions are defects.

## Reply protocol
When done or blocked: `await agent_message.send(summary, receiver_role='parent')` with deliverable paths, commands + results, self-check outcome, open questions.
