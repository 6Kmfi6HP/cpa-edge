# CPA-Edge

Clean-room, serverless-first TypeScript rewrite of the
[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) gateway behavior.

CPA-Edge is a protocol gateway. Clients speak OpenAI, Claude, Gemini, or
Codex/Responses shapes at one endpoint; the gateway picks one of your
configured upstream credentials, translates the request to that provider's
wire format, and translates the response or SSE stream back. Routing,
scheduling, cooldowns, OAuth token lifecycle, and the `/v0/management` API
are all part of the served behavior — pinned to recorded evidence, not
re-invented.

## Behavioral anchor

Every behavior in this repo is pinned to one upstream build:

| Item | Value |
|---|---|
| Reference project | CLIProxyAPI — https://github.com/router-for-me/CLIProxyAPI (MIT License) |
| Version | **CLIProxyAPI v7.3.4** (tag dated 2026-09-15) |
| Commit | `8335eac731946bd4eff18f500653f93736df53d6` |
| Oracle image | `eceasy/cli-proxy-api:v7.3.4` |
| Image digest | `sha256:97825da3009f98acf78b5c172fde650a5fbe7a690950a69ce6d7b535d77d4266` |

All golden fixtures — 399 recorded case directories holding 2,256 files
under `tests/fixtures/` — were recorded against exactly this build
(recording setup and recipes: `reports/oracle/BOOTSTRAP.md`). When recorded
behavior, this spec, and an implementation disagree, recorded behavior
wins; see [SPEC.md](SPEC.md) §0 for the precedence rule.

## Source of truth and governance

- [SPEC.md](SPEC.md) + [spec/sections/](spec/sections/) — the functional
  specification. Each section was written by an assigned spec author and
  admitted only after an adversarial review gate.
- [STATUS.md](STATUS.md) — per-step ownership, pipeline state, verdicts.
- [AGENTS.md](AGENTS.md) — contributor rules for agents and humans.
- [reports/](reports/) — oracle recording notes and adversarial gate
  artifacts (every gate round leaves a written report).
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — deployment guides, security
  warnings, and the published degradation list.

## Architecture

The core is runtime-agnostic: `packages/*` use only Web Standard APIs
(`fetch`, streams, `crypto.subtle`, `URL`, `AbortController`). Every
platform-specific concern lives in an adapter under `runtimes/`.

| Path | Role |
|---|---|
| `packages/core` | `Store` abstraction (+ in-memory implementation), shared model types, error registry, the S4 strategy engine (round-robin / weighted / fill-first / session affinity — merged and unit-pinned), and the `RuntimeCapabilities` descriptor each runtime declares. v1 serving rotation is config-order first-fit with cooldown skip and request-retry; full strategy wiring is a v1.1 item (GR-4) |
| `packages/translators` | pairwise protocol translation — one module per direction, no canonical intermediate form |
| `packages/executors` | executor seam; recorded provider wires are served by the direction modules (R-EXECS; the antigravity executor is pending per GR-2) |
| `packages/auth` | OAuth and device flows, token refresh and lifecycle, client API-key auth, management-key authorization |
| `packages/management` | the `/v0/management` API and the state layer over the `Store` |
| `runtimes/node` | reference runtime (`node:http` adapter); all contract tests run against it |
| `runtimes/cloudflare` | Cloudflare Workers adapter: one Worker plus a Durable Object store, alarms, WebSocket hibernation |
| `runtimes/vercel` | serverless-function adapter, deliberately degraded per the S7 matrix |
| `tests/contract` + `tests/fixtures` | golden contract suites and recorded upstream transcripts (spec-side ownership) |

All persistent state flows through the abstract `Store` from
`@cpa-edge/core`; there is no shared mutable global state. Each runtime
passes its capability profile into the router at construction; when a
capability is missing, the gateway answers with the pinned 501 bodies from
S7 instead of silently deviating.

## Quickstart

```bash
pnpm install     # install from the root lockfile
pnpm test        # all vitest suites (unit + golden contract)
pnpm typecheck   # tsc --noEmit across all packages + tests
pnpm lint        # eslint
```

Running the node runtime: it ships as a library, so a host composes a
gateway and binds it. A minimal host (`host.ts`):

```ts
import { createNodeGateway, listenGateway } from '@cpa-edge/runtime-node'

const config = {
  port: 8317,
  'api-keys': ['set-a-strong-client-key'], // unset = open proxy, see below
  'openai-compatibility': [
    {
      name: 'my-openai',
      'api-key': 'upstream-key',
      'base-url': 'https://api.openai.com/v1',
      models: [{ name: 'gpt-4o-mini', alias: 'gpt-4o-mini' }],
    },
  ],
}

const gateway = createNodeGateway({ config })
const server = await listenGateway(gateway, { host: '127.0.0.1', port: 8317 })
console.log(`gateway listening on http://127.0.0.1:${server.port}`)
```

The workspace ships TypeScript sources without a build step, so bundle the
host first (esbuild ships in the dev dependency tree):

```bash
pnpm exec esbuild host.ts --bundle --platform=node --format=esm --outfile=host.mjs
node host.mjs
```

Point a client at it:

```bash
curl http://127.0.0.1:8317/v1/models \
  -H "Authorization: Bearer set-a-strong-client-key"
```

Deployment recipes for node, Cloudflare Workers, and Vercel — plus the
mandatory security warnings — live in
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Test philosophy

Two mechanisms keep the rewrite honest:

- **Oracle-recorded goldens.** A dedicated oracle role drove the pinned
  upstream binary against local mock upstreams and saved raw wire
  transcripts under `tests/fixtures/<step>/<case>/` (layout recipes in
  `reports/oracle/BOOTSTRAP.md`). Contract suites replay those transcripts
  against a composed runtime and compare byte-exactly, masking only the
  fixture-declared volatile fields (timestamps, trace ids, ports). The
  comparison rules are rulings of record: streaming compares the decoded
  SSE event sequence, never transport chunk boundaries (R-SSE);
  multi-tool-call flush frames compare as sorted sets because the
  reference itself is order-nondeterministic there (R-ORDER); token-count
  numbers compare exactly (R-TOK).
- **Adversarial gates.** No spec section and no implementation module
  merges without a reviewer hunting defects against the recorded
  evidence. Each round leaves a report under `reports/adversary/` and a
  verdict line in `STATUS.md`; rounds are capped and unresolved findings
  escalate to a human.

Some upstream quirks are mirrored on purpose because clients may depend
on them: 404 responses have empty bodies and a wrong method on a known
route is 404, not 405 (R-404); any OPTIONS request is answered 204 with
CORS and never authenticated; every response carries the recorded CORS
header block.

## Security essentials

Read [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) §1 before exposing any
deployment. The three that bite hardest:

1. **`api-keys` unset means an open proxy on every runtime** (ruling
   R-S7-A). The gateway mirrors the upstream fail-open default. Set
   `api-keys` before exposing it.
2. **Serverless management requires `allow-remote: true` plus a strong
   `secret-key`.** On Cloudflare and Vercel every management client is
   remote, so the loopback gate can never pass without it.
3. **`GET /v0/management/config` returns stored values including
   secrets.** Provider API keys come back in cleartext to anyone holding
   the management key. Protect that key accordingly.

## Published degradations (operator summary)

The full list in operator terms is
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) §5, including the D2 gap
rulings GR-1..GR-8. The headline items:

- **v1 serves API-KEY upstreams** (gemini, claude, codex,
  openai-compatibility). OAuth credential types load, list, patch,
  refresh, and expire — but no client-facing model maps to them;
  requests for OAuth-only models answer `400 model_not_found` (GR-1).
  CLI-subscription serving is the primary v1.1 item.
- **The antigravity executor is unimplemented in v1** — its
  login/redirect/callback surface is pinned, its request wire is
  recorded, the module is pending (GR-2).
- **Native passthrough and never-recorded seams answer the exact 503
  body**: Claude→Claude, Gemini→Gemini, plus the xai/meta/interactions/vertex
  native wires — `{"error":{"message":"direction not yet available in this build",...}}`
  (GR-3).
- **Serving rotation in v1 is config-order first-fit** with cooldown
  skip and request-retry; the strategy engine is merged and unit-pinned
  but strategy/weights/affinity switches echo only (GR-4).
- **Node scope (GR-5)**: `/v1/ws` gates, hot-reload recompose, and
  proxy-url ingestion (fail-closed strip + warning) land in the final
  parity round; registered absent on node: background token-refresh
  driver (manual `POST /auth-files/refresh` is the v1 path), device-flow
  poll driver (envelope-only, same observable as vercel), file-log
  substrate (the Store ring serves `/logs`), TLS listener (hosts own
  TLS), loopback redirect forwarders (manual relay via
  `oauth-callback`), and actual proxy dialing.
- **Accepted-inert config (GR-6)**: payload rules, `force-model-prefix`,
  `$`-dynamic headers outside codex-passthrough, streaming keepalives,
  and quota refresh of request-error-logs — accepted and echoed, no
  runtime consumer.
- **The RESP usage side-band is protocol-only in v1**: the byte-exact
  state machine lives in the management package (harness-pinned); no
  runtime ships the raw TCP listener — a host binds the wire itself.
- **Device-flow logins are live only on Cloudflare** (Store-backed
  sessions plus Durable Object alarms); node and vercel are
  envelope-only (the NE-S7-11 observable).
- **Strict request boundary**: malformed JSON bodies are rejected with
  400 where the reference leniently parses them (NE-LENIENT).

## Clean-room and license

Upstream CLIProxyAPI is treated strictly as a specification. All code in
this repo is original TypeScript; nothing is transliterated from the Go
sources, and no upstream comments or internal identifiers are copied.
Public interface names — routes, config keys, header names, JSON fields —
match for compatibility. The upstream reference checkout lives outside
this repo and is readable only by designated roles.

Licensed under the MIT License — see [LICENSE](LICENSE).
