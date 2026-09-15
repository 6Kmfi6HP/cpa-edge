# Deploying CPA-Edge

Per-runtime deployment guides, the security warnings every operator must
read, and the published list of intentional behavior gaps. The normative
sources are [SPEC.md](../SPEC.md) — in particular the platform-degradation
registry in [spec/sections/S7-platform-degradation.md](../spec/sections/S7-platform-degradation.md)
(SPEC §5 summarizes it) and the config/storage schemas in
[spec/sections/S6-state-storage.md](../spec/sections/S6-state-storage.md).
This document states them in operator terms.

How to read the runtime sections: each runtime declares a fixed
`RuntimeCapabilities` profile (S7 §3.1). Missing capabilities produce the
pinned 501 bodies below — never silent deviation.

| Capability | node | cloudflare | vercel |
|---|---|---|---|
| `inboundWebSocket` (`/v1/ws` upgrade + relay) | yes | yes | no |
| `proxyTransport` (outbound `proxy-url` dialing) | yes | no | no |
| `pluginLoading` (C-ABI dynamic libraries) | no | no | no |
| `fileLogging` (persistent rotating logs) | yes | yes (DO-backed) | no |
| `fileWatching` (external config/auth edits) | yes | no | no |
| `localCallbackServer` (OAuth localhost forwarders) | yes | no | no |

## 1. Security warnings — read before exposing anything

### 1.1 `api-keys` unset means an open proxy

With `api-keys` absent or empty, every client route accepts
unauthenticated requests. This mirrors the upstream fail-open default and
applies to **all runtimes** (ruling R-S7-A). On a serverless deployment
the gateway URL is public, so an unset list is an open proxy on the
internet. The WebSocket gate defaults to auth-required (`ws-auth: true`
when unset), but that is a separate gate from the client API.

How to close the gateway:

1. Set `api-keys` to one or more strong, random values in the config —
   or update them live via `PUT /v0/management/api-keys`.
2. Set a strong `remote-management.secret-key`, or leave it empty to keep
   the management API fully unregistered (empty key: every
   `/v0/management/*` request returns 404 with an empty body — S6 fact
   B19).
3. On self-hosted node, keep the listener on loopback (the adapter
   defaults to `127.0.0.1`) and bind a public interface only when needed.
4. On serverless, put the `api-keys` in place **before** the deployment
   receives traffic; a public URL with no keys is open from the first
   request.

Client keys are accepted on several transports (`Authorization: Bearer`,
`X-Api-Key`, `x-goog-api-key`, …) — see S1 §4.1 for the full accept
matrix.

### 1.2 Serverless management requires `allow-remote: true` plus a strong `secret-key`

Upstream `remote-management.allow-remote: false` admits only loopback
management clients. On Cloudflare and Vercel **every** management client
is remote, so the loopback gate can never succeed (S7 note N7). A
serverless deployment must set:

```yaml
remote-management:
  allow-remote: true
  secret-key: <strong random value>
```

Without it the management API cannot authorize anything. With it, the
management key is the only thing guarding the gateway's control surface,
so treat it as a production secret.

Key-handling facts (recorded upstream behavior, mirrored here):

- A plaintext `secret-key` is bcrypt-hashed on first startup and the hash
  is written back into the stored config; the **plaintext remains the
  accepted key** afterwards (ruling R-BCRYPT; S6 fact B21). Already-hashed
  values are left untouched.
- The accepted management key travels as `Authorization: Bearer <key>` or
  `X-Management-Key: <key>`. An empty configured secret (with no env/local
  fallback) leaves the management routes unregistered (404 empty, B19).
  The `MANAGEMENT_PASSWORD` environment variable is an accepted
  alternative key, compared constant-time.
- The failure ladder: missing key → 401 `{"error":"missing management key"}`;
  wrong key → 401 `{"error":"invalid management key"}`; remote client
  without `allow-remote` → 403 `{"error":"remote management disabled"}`;
  five consecutive failures from one client address → 30-minute ban.

### 1.3 `GET /v0/management/config` returns stored values including secrets

This endpoint echoes the full effective config — **including provider API
keys in cleartext** — to any caller holding the management key (S5
mirror ruling). The echo never includes the `remote-management` block
itself, so the management key is not disclosed, but every upstream
credential is. Consequences for operators:

- Treat the management key as read access to all upstream credentials.
- Do not expose the management surface more widely than necessary; keep
  the key out of logs and shells.
- On the node runtime the same applies: management is reachable from
  loopback by default, so any local process holding the key can read all
  credentials.

### 1.4 Mirrored quirks worth knowing (not security holes, but surprising)

- Wrong method on a known route → 404 with an **empty body** (not 405);
  unknown routes → 404 empty too (R-404).
- Any OPTIONS request → 204 with CORS headers, no auth, no routing.
- Trailing-slash redirects (301/307) are the only responses that carry
  **no** CORS headers.
- `GET /healthz` is the health route; `/keep-alive` returns 404 outside
  TUI mode (upstream registers it only there, mirrored).

## 2. Node runtime (self-host)

The node runtime is the reference runtime: the full route surface, the
merged translation directions, the management API, and the auth plane
composed over a `Store`. It ships as a library — an operator (or the
packaged host, once T1 delivers it) composes the gateway and binds it.

### 2.1 Quickstart (verified against the current tree)

```ts
// host.ts — minimal CPA-Edge gateway host
import { createNodeGateway, listenGateway } from '@cpa-edge/runtime-node'

const config = {
  port: 8317,
  'api-keys': ['set-a-strong-client-key'],
  'remote-management': { 'allow-remote': false, 'secret-key': '' },
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

The workspace ships TypeScript sources without a build step, so bundle
before running (esbuild is already in the dev dependency tree):

```bash
pnpm exec esbuild host.ts --bundle --platform=node --format=esm --outfile=host.mjs
node host.mjs
```

Smoke checks:

```bash
curl -s http://127.0.0.1:8317/healthz          # {"status":"ok"}
curl -s http://127.0.0.1:8317/v1/models \
  -H "Authorization: Bearer set-a-strong-client-key"
```

### 2.2 Composition surface

`createNodeGateway(options)` accepts (all optional except `config`):

| Option | Meaning |
|---|---|
| `config` | the parsed config document — a plain object with the reference `config.yaml` key names |
| `store` | platform `Store`; defaults to a process-local in-memory store (state does not survive restart) |
| `configYaml` | raw `config.yaml` text — required for the management payload surface (see 2.4) |
| `remoteAddress` | client address used by the management loopback gate (tests and non-socket hosts) |
| `capabilities` | capability profile override — this is how contract suites exercise degraded paths |
| `fetch`, `now`, `zstdDecode` | transport / clock / zstd-decoder injection seams |
| `managementApi`, `managementPanelHtml`, `keepAlivePassword` | management overrides and optional panel/TUI-mode wiring |

`listenGateway(gateway, { host, port })` binds the socket. Defaults are
deliberately safe: loopback host, ephemeral port. The bind address comes
from these options, not from the config document's `port` key.

### 2.3 Config surface

The runtime ingests the reference `config.yaml` dialect as a plain
object (YAML key names are public interface). Keys consumed today:

| Key | Notes |
|---|---|
| `api-keys` | client keys; **empty = open proxy** (§1.1) |
| `port` | parsed for the config surface; the actual bind comes from `listenGateway` |
| `remote-management.allow-remote` / `.secret-key` / `.disable-control-panel` | see §1.2; `secret-key` empty → management unregistered (B19) |
| `openai-compatibility[]` | `name` (provider id, becomes `owned_by`), `api-key`, `base-url` (required), `headers`, `models[]` |
| `gemini-api-key[]`, `claude-api-key[]`, `codex-api-key[]`, `xai-api-key[]`, `meta-api-key[]`, `interactions-api-key[]`, `vertex-api-key[]` | api-key provider entries: `api-key`, `base-url` (required for codex/xai/meta), `name`, `headers`, `fingerprint-profile` (claude), `models[]` |
| `models[]` entries | `name` (upstream id), `alias` (client-visible id), `display-name`, `image`, `is-compat`, `force-mapping`, `thinking {min,max,levels}` |
| `request-retry` | extra credential retry rounds (0 = none) |
| `transient-error-cooldown-seconds` | 0 means the legacy 60s cooldown, **not** off; negative disables (recorded upstream fact) |
| `disable-image-generation` | four states: `false`, `true`, `"chat"`, `"passthrough"` |
| `claude-code.disable-cloaking-model-list`, `codex.disable-codex-cloaking` | protocol-cloaking switches |

Notes:

- `claude-api-key` entries default `base-url` to `https://api.anthropic.com`
  when omitted; codex/xai/meta/openai-compatibility entries without a
  `base-url` are dropped, mirroring the reference.
- Unknown keys are ignored, so a full reference `config.yaml` can be
  mapped in as-is; the complete dialect (including `proxy-url`, `tls`,
  logging, routing, and watcher keys) is specified in S6 §3.1. Keys the
  runtime does not yet ingest still round-trip through the management
  echo, which serves off the raw YAML text, but do not drive gateway
  behavior until T1 wires them (§2.5).

### 2.4 Management API on node

The composed gateway serves `/v0/management/*` when two things hold: a
non-empty `remote-management.secret-key` **and** raw `configYaml` text
passed in the options (the management layer does surgical edits on the
original YAML bytes). Management responses carry the anchored build
headers (`X-Cpa-Version: v7.3.4`, `X-Cpa-Commit: 8335eac`, …).

The loopback gate: with `allow-remote: false` (default), only loopback
clients pass. `listenGateway` feeds each connection's socket address to
that gate. Keep `allow-remote: false` unless you front the gateway with an
authenticating proxy on a non-loopback bind.

### 2.5 Node-bound features: contract vs current wiring

S7 classifies the node runtime as the full-capability reference. The node
contract and today's wiring status:

| Feature (S7 id) | Node contract | Wiring status today |
|---|---|---|
| F1 outbound proxy egress | EQUIVALENT — `proxy-url` honored incl. socks5 | transport dials direct today; the `proxy-url` management endpoints serve off the raw YAML text; proxy dialing lands with T1 |
| F2 C-ABI plugins | ABSENT — config surface served, installs 501 | served (config/echo routes over the management facade) |
| F3 file logging | EQUIVALENT — rotating files under `<auth-dir>/logs/` | `/v0/management/logs` served from the log ring; file substrate lands with T1 |
| F4 inbound WebSocket `/v1/ws` | EQUIVALENT — auth gate, 400 for non-upgrades, 101 upgrade | route + relay session wiring lands with T1 |
| F5 OAuth logins | EQUIVALENT — localhost forwarders on 54545/1455/51121 for redirect flows; device flows native | auth-url + session-registry endpoints served over the auth plane; forwarder binding lands with T1 |
| F6 hot reload | EQUIVALENT — external config/auth file watching | management-API writes apply on the next composed request; file watchers land with T1 |
| F7 TLS listener | EQUIVALENT — `tls.enable/cert/key` with startup validation | adapter wiring lands with T1 (terminate TLS at a reverse proxy meanwhile) |
| F8 RESP usage side-band | EQUIVALENT — S6 §4 is the node contract | raw-listener multiplexing lands with T1 |

T1 (runtime integration) is the in-flight step that owns this column;
the "lands with T1" items are recorded integration seams, not scope cuts.

## 3. Cloudflare Workers (as delivered by T2)

Source: the T2 runtime, its shipped operator notes
(`runtimes/cloudflare/DEPLOY.md`, `runtimes/cloudflare/wrangler.toml`),
and T2's final delivery report (folded in below). Delivery status per that
report: 74/74 package tests green; `wrangler deploy --dry-run` passed —
bundle 6.42 MiB (2.72 MiB gzip), within Workers limits; the
`CpaEdgeDurableObject` DO binding resolves (sqlite-backed, migrations tag
`v1`). T2's gate review is in flight; any finding that changes a fact
below will be folded in when forwarded.

### 3.1 Topology

One Worker deployment serves the whole gateway. All state — config text,
auth files, cooldowns, OAuth sessions, usage queue, log ring — lives in
one sqlite-backed Durable Object (`CpaEdgeDurableObject`, binding
`CPA_EDGE_DO`), which is this platform's equivalent of the reference's
single process. Token refresh, device-flow polling, and retention sweeps
run on the object's alarm, which re-arms at the earliest of: the next
refresh due, the next device-poll tick, the next management retention
sweep, or a 60-second idle heartbeat. `/v1/ws` upgrades are accepted
(101) into WebSocket hibernation; enabling `ws-auth` while sessions are
live terminates them with close code 1008 (policy violation).

### 3.2 Deploy

1. `npx wrangler deploy` (from `runtimes/cloudflare`; wrangler resolves
   the workspace TypeScript sources — no build step).
2. Provide the config (one of):
   - **KV binding `CPA_CONFIG`** holding the `config.yaml` text under
     the key `config.yaml` (recommended). Create the namespace with
     `npx wrangler kv namespace create CPA_CONFIG`, bind it in
     `wrangler.toml`, then put the config text under the key, or
   - **plain-text var `CPA_CONFIG_YAML`** with the config inline
     (`[vars]` in `wrangler.toml` — keep secrets out of it).
3. Config precedence at boot: the object's **stored copy first**, then
   the KV binding, then the plain-text var, then an empty config. First
   boot seeds the stored copy from the first available source. After
   that, config changes go through the management API only
   (`PUT /v0/management/config.yaml`, scalar writes) and are written
   back to the stored copy — there is no file watcher on this platform
   (S7 F6), and writes hot-reload the gateway immediately.

### 3.3 Required config on this platform

- `remote-management.allow-remote: true` **must** be set for the
  management API to work at all (§1.2), with a strong `secret-key`.
- `api-keys` must be set before the deployment is exposed (§1.1).

### 3.4 Platform behavior vs the reference (T2-delivered)

| Feature | Behavior here |
|---|---|
| F1 outbound proxy | proxy-credentialed credentials are excluded from scheduling; requests with no eligible credential get 501 `proxy_unavailable`; config accepted and echoed; `POST /v0/management/api-call` keeps the upstream scheme validation (`400 {"error":"invalid proxy_url"}`) and returns the F1 501 body when a proxy would be required |
| F2 plugins | config surface served; installs 501; nothing loads |
| F3 logs | `GET/DELETE /v0/management/logs` served from the DO-backed log ring (capacity 1000, same shapes) |
| F4 `/v1/ws` | route served: auth gate (`ws-auth`, default required), gorilla-style 400 for non-upgrades, passing upgrades accepted into DO hibernation; the relay protocol behind the 101 has no merged executor yet, sessions hold silent |
| F5a redirect logins | `anthropic/codex/antigravity/devin-auth-url` → 501 `local callback server is not available on this runtime` |
| F5b device logins | EQUIVALENT (live): sessions are Store-backed, polling runs on DO alarms with per-provider loop semantics byte-matching the package flows, completions persist auth files exactly like the packaged flows |
| F5c callbacks | EQUIVALENT: `/anthropic/callback` etc. and the oauth-callback ladder run over the Store-backed registry |
| F6 hot reload | management API writes only, applied immediately |
| F7 TLS | platform-terminated; the `tls` block is accepted and ignored |
| F8 RESP usage wire | no raw TCP listener exists; config keys accepted; `GET /v0/management/usage-queue` keeps its semantics |

### 3.5 Notes and constraints (T2)

- Config text is parsed by this runtime's block-YAML reader. Flow
  collections, anchors, block scalars, and tab indentation are rejected
  at boot with explicit errors — rewrite the config in block style first
  (the management facade's own writer always emits block style).
- `content-encoding: zstd` request bodies decode through the runtime's
  `fzstd` decoder (the earlier open item is resolved — the dependency is
  installed in the runtime package).

## 4. Vercel (as delivered by T3)

Status: delivered. 68/68 package tests; full-repo suite 2055/2055;
typecheck and lint clean (per T3's final report). The runtime-local
recipe with full detail lives at `runtimes/vercel/DEPLOY.md` — this
section carries the operator essentials; the two are kept consistent.

### 4.1 Topology

One serverless function (`runtimes/vercel/api/index.ts`) answers every
request: `runtimes/vercel/vercel.json` rewrites `/(.*)` to it (built
with `@vercel/node`; memory 1024, `maxDuration` 300). The handler
composes the gateway per invocation from the same shared composition as
the node runtime, pinned to the vercel capability profile — so routing
and translation behavior are identical, and only the platform substrate
differs. No per-request state lives in module globals.

### 4.2 External KV and environment (required)

There is no filesystem and no Durable Object on this platform: all
persistent state lives in an **external Redis-compatible KV service**
(the Vercel KV / Upstash REST wire):

| Variable | Role |
|---|---|
| `KV_REST_API_URL` + `KV_REST_API_TOKEN` | the KV service binding — without both, the runtime falls back to a per-invocation in-memory store, logs loudly, and persists nothing (not for production) |
| `CPA_CONFIG_JSON` | the config document as JSON (YAML-shaped keys) — recommended source; carries `remote-management`, `api-keys`, provider sections, `ws-auth`, `logging-to-file`, `proxy-url`, … exactly like `config.yaml` |
| `CPA_CONFIG_YAML` | alternative: the config document as block-style YAML text (the `config.yaml` dialect) |
| `CPA_CONFIG_FROM_KV=1` | load the config from the KV document `config/effective` instead of the environment (falls back to env when absent) |
| `CPA_CONFIG_PERSIST=1` | persist management config mutations to the KV document so the next invocation sees them; recommended together with `CPA_CONFIG_FROM_KV=1` |
| `CPA_MAX_STREAMING_DURATION_MS` | streaming budget override (default 240000; see §4.3) |
| `MANAGEMENT_PASSWORD` | fallback management key when the config carries none (§1.2) |

### 4.3 The streaming boundary (300 s / 800 s ceilings)

Vercel functions have a hard `maxDuration` ceiling — 60 s on Hobby, up
to 300 s on Pro (fluid compute), up to 800 s on Enterprise
configurations. When the ceiling hits, the platform stops the
invocation with no chance to emit anything; an SSE response still open
at that moment would die mid-frame.

The mitigation implemented here (the boundary envelope is **un-pinned**
by S7 — this is the runtime's documented choice):

- Every upstream request leaves with the *remaining* budget of
  `CPA_MAX_STREAMING_DURATION_MS` (default 240000 — the 300 s Pro
  ceiling minus a safety margin). Set it at or below your plan's
  `maxDuration` minus a margin; an Enterprise deployment with
  `maxDuration: 800` should raise it accordingly (e.g. 780000).
- When the budget trips, the upstream exchange aborts mid-stream. The
  direction facades observe the abort as the recorded mid-stream
  transport disconnect and render their family's pinned terminal frame
  (OpenAI-chat family: one in-stream `unexpected EOF` server-error data
  frame, no `[DONE]`); the response then ends cleanly instead of
  hanging until the platform kills it.
- An abort before the first translated frame stays the family's
  pre-commit failure (a plain 500 envelope for the chat family), like
  any other upstream transport failure.

### 4.4 Platform behavior vs the reference (per S7, vercel column)

- **Inbound WebSocket (`/v1/ws`)**: the route exists and the auth gate is
  preserved (401 shapes identical, or no gate when `ws-auth: false`),
  but no upgrade can happen — after the gate, 501
  `websocket_unavailable`. `POST /v1/ws` stays the empty 404; `OPTIONS`
  stays 204.
- **Outbound proxy**: fail closed. Proxy-credentialed credentials never
  receive traffic: they are excluded from scheduling, and models served
  only by proxied credentials answer 501 `proxy_unavailable` while
  models with at least one direct credential succeed. Proxied providers
  also disappear from `/v1/models` (the runtime's fail-closed choice;
  S7 pins the request-time 501, not the list treatment). `POST
  /v0/management/api-call` resolved to proxy mode answers the
  management 501.
- **File logging**: config and toggles accepted; `GET/DELETE
  /v0/management/logs` answer 501 while `logging-to-file: true` (the
  400 `logging to file disabled` gate still runs first). Per-request
  error dumps (`request-error-logs*`, `request-log-by-id`) answer the
  F3 501 after upstream-shaped validation errors. The log/error rings
  persist through the KV store.
- **Redirect-flow logins** (`anthropic/codex/antigravity/devin-auth-url`)
  → 501 after the management-key gate. Serverless hosts cannot bind the
  localhost callback ports.
- **Device-flow logins** (`xai/meta/kimi-auth-url`): the 200 envelope
  returns and the session persists to the KV store, but background
  polling cannot run — `get-auth-status` answers `wait` until the
  30-minute TTL, then `unknown or expired state`. Sessions **never
  complete**; token exchange never happens (NE-S7-11; tested).
- **Callback routes + session registry**: the HTTP ladder
  (`/anthropic/callback` etc., `oauth-callback`, `get-auth-status`,
  `oauth-session`) is served with upstream shapes over the KV-backed
  store, but no session can reach a completion transition.
- **Hot reload**: management-API writes persist to the KV document and
  apply on the next invocation; there is no watcher.
- **TLS**: platform-terminated; the `tls` block is accepted and echoed.
- **RESP usage wire**: no raw TCP listener; no substitute surface; the
  usage queue keeps its S6 semantics through the KV store.
- **Management control panel** (`/management.html`): absent — 404s
  exactly as if `disable-control-panel: true` were set.
- **Management**: `remote-management.allow-remote: true` + strong
  `secret-key` required (§1.2); the per-IP failure counter and
  30-minute ban apply as upstream.

### 4.5 Deploy

The deployment unit is the `runtimes/vercel` directory. Link a project
and set the environment variables in the dashboard first; then:

```bash
cd runtimes/vercel
npx esbuild api/index.ts --bundle --platform=node --format=esm \
  --outfile=api/index.js --external:fzstd
vercel deploy
```

Bundling first is the reliable path: the `@vercel/node` builder traces
imports, but workspace symlinks outside the deployment directory are
environment-dependent. Set `maxDuration` in `vercel.json` to your plan's
ceiling and `CPA_MAX_STREAMING_DURATION_MS` below it (§4.3).

### 4.6 Store substrate and consistency trade-offs (vs. the DO store)

- Single-key operations are atomic (server-side scripts), so the
  optimistic compare-and-swap behind `update()` never commits a wrong
  value; the callback may re-run under contention (the core contract
  already requires purity).
- Reads through an asynchronous replica can be stale; the CAS loop
  absorbs staleness as a retry. There is **no cross-key transaction** —
  S6's mapping keeps every document single-key, so the contract holds,
  but multi-document invariants would not be atomic here (the
  Cloudflare DO store provides those).
- Queue leases are reclaimed lazily by the next `claim`, and rings trim
  on append: **all retention sweeps ride request traffic** — no
  background timers exist (the S7 alarm substrate MUSTs apply to
  Cloudflare only).

## 5. Published degradation list

This is SPEC §5's registry in operator terms. It is the contract; per-
runtime wiring status lives in §2-§4.

### 5.1 Provider native-wire gaps (every runtime) — R-EXECS

Provider types whose native wires were never recorded — **kimi-native,
xai-native, meta-native OAuth, interactions, and vertex standalone** —
follow one rule everywhere: their credentials load, schedule, and refresh
per the auth/scheduling contracts, but a call that would use their native
wire returns the S7-style 501 degradation. The recorded directions —
gemini (×3), claude, openai-chat, codex-responses, antigravity — are
served by the direction modules, which is how R-EXECS satisfies the
charter's executor steps.

### 5.2 Platform matrix (S7) — per feature

| Feature | node | cloudflare | vercel |
|---|---|---|---|
| Outbound proxy egress (`proxy-url`) | served | 501 when only proxy-credentialed candidates exist (fail closed) | same as cloudflare |
| C-ABI plugins | config surface only; installs 501 | same | same |
| File logging (`/v0/management/logs`) | served (files) | served (DO-backed ring) | 501 when `logging-to-file: true` |
| Inbound WebSocket `/v1/ws` | served | served (DO hibernation) | 501 after the auth gate |
| Redirect-flow logins (localhost forwarders) | served | 501 | 501 |
| Device-flow logins (xai/meta/kimi) | served | served — Store-backed sessions + DO-alarm polling (conditional MUSTs met) | envelope only; sessions never complete |
| OAuth callback routes + session registry | served | served (Store-backed registry) | ladder served; no session completes |
| CLI `--login` UX (browser open, user-code print) | out of HTTP contract | absent | absent |
| External file watching / hot reload | served | management writes only | management writes only |
| TLS listener (`tls.enable/cert/key`) | served | platform-terminated; config no-op | platform-terminated; config no-op |
| Local Redis-RESP usage side-band | served | no listener; `usage-queue` HTTP keeps semantics | no listener; `usage-queue` HTTP keeps semantics |

Invalid `proxy-url` values behave as upstream on every runtime: the
request proceeds direct (log and fall through), no 501.

### 5.3 Adjacent absences — NE-S7-08

- `pprof` debug server, mDNS/DNS-SD discovery, TUI mode: absent on every
  runtime; config keys accepted, ignored.
- `/keep-alive` route: absent (404) on every runtime — upstream itself
  only registers it in TUI mode.
- Home mode (cluster membership) and the management control panel
  (GitHub-asset download to a writable disk): absent on cloudflare and
  vercel; the panel route 404s exactly as if
  `remote-management.disable-control-panel: true` were set.

### 5.4 Environment proxies ignored — NE-S7-04

An empty `proxy-url` ("inherit") honors `HTTP(S)_PROXY`-style environment
variables in the reference. CPA-Edge ignores environment proxies on
every runtime: inherit is direct. `direct`/`none` and explicit URLs
behave identically to upstream.

### 5.5 Strict request boundary — NE-LENIENT

The reference parses request bodies leniently (a truncated-JSON body was
recorded as 200 with full translation). CPA-Edge enforces a strict
boundary instead: non-JSON or malformed bodies are rejected with 400 in
each surface's error shape. Well-formed clients see no difference.

## 6. Fill-in ledger (T2 + T3 filled)

This section tracks what was folded in from the integrators' final
reports and what remains open. Nothing here is invented; each entry
names its source.

T2 (Cloudflare) — FILLED (2026-09-16, from T2's final report):

- [x] Deploy verification: 74/74 package tests; `wrangler deploy
      --dry-run` passed (bundle 6.42 MiB / 2.72 MiB gzip, within
      Workers limits; DO binding resolves; sqlite-backed DO, migrations
      tag `v1`). Folded into §3.
- [x] KV provisioning: `npx wrangler kv namespace create CPA_CONFIG`,
      bind in `wrangler.toml`, config text under key `config.yaml` (or
      the `CPA_CONFIG_YAML` var). Folded into §3.2.
- [x] zstd open item: resolved — `fzstd` installed in the runtime
      package. Folded into §3.5.
- [x] Alarm cadence (earliest-of re-arm with a 60s idle heartbeat), WS
      hibernation with `ws-auth` termination close 1008, F5b device
      flows live with per-provider loop parity, F1 501 ladder incl.
      api-call scheme validation. Folded into §3.1/§3.4.
- Residual: T2's gate review was in flight at fill time — any finding
  that changes a folded fact gets re-folded here when forwarded.

T3 (Vercel) — FILLED (2026-09-16, from T3's final report +
`runtimes/vercel/DEPLOY.md`):

- [x] Delivery verification: 68/68 package tests; full-repo 2055/2055;
      typecheck + lint clean. Folded into §4 status.
- [x] Deployment recipe: `runtimes/vercel` as the deployment unit,
      esbuild-bundle-then-`vercel deploy`, `maxDuration`/budget
      guidance. Folded into §4.5; full detail in the runtime-local
      DEPLOY.md.
- [x] Env surface confirmed (§4.2 now matches the runtime-local
      DEPLOY.md): KV REST pair, `CPA_CONFIG_JSON`/`CPA_CONFIG_YAML`,
      KV document `config/effective` via `CPA_CONFIG_FROM_KV` +
      `CPA_CONFIG_PERSIST`, streaming budget, `MANAGEMENT_PASSWORD`.
- [x] Streaming-budget behavior at the deadline: mid-stream abort
      surfaces as the family's pinned terminal frame (chat family:
      in-stream `unexpected EOF` frame, no `[DONE]`); pre-first-frame
      aborts stay pre-commit 500; boundary envelope un-pinned by S7
      (documented runtime choice). Folded into §4.3.
- [x] S7 vercel-column verification: WS 501-after-auth, proxy
      fail-closed incl. the `/v1/models` exclusion (unpinned choice,
      documented), file-logs 501 with the 400 gate first, device flows
      NE-S7-11 tested, panel absent. Folded into §4.4.
- [x] KV consistency notes: CAS retries never commit wrong values, no
      cross-key transactions vs. the DO store, retention sweeps ride
      request traffic. Folded into §4.6.

Open residuals (none blocking D1):

- [ ] T2 gate-review findings, if any change a folded §3 fact.
- [ ] T3 gate-review findings, if any change a folded §4 fact.
