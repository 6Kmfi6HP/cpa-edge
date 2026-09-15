# Deploying CPA-Edge on Vercel (runtime T3)

This package is the serverless-functions runtime of CPA-Edge. It composes the
same workspace facades as the reference runtime, pinned to the vercel
capability profile (`VERCEL_RUNTIME_CAPABILITIES`), and implements the
`runtimes/vercel` column of the S7 platform-degradation matrix
(`spec/sections/S7-platform-degradation.md`). Everything a deployment must
know lives here; D1 folds these notes into the project README.

## What is degraded on this platform (S7 matrix)

| Feature | State | What clients observe |
|---|---|---|
| F1 outbound proxy transport | **off** | Proxy-credentialed providers never receive traffic. A model served only by proxied credentials answers `501 {"error":{"message":"outbound proxy transport (proxy-url) is not available on this runtime",...}}`; models with at least one direct credential succeed through it. `POST /v0/management/api-call` resolved to proxy mode answers the management 501. |
| F2 C-ABI plugins | **absent** (project-wide) | Config + management surface intact (`registered:false`, `effective_enabled:false`); `POST /v0/management/plugin-store/:id/install` answers the F2 501. |
| F3 file logging | **off** | Config + toggles accepted; `GET/DELETE /v0/management/logs` answer 501 while `logging-to-file: true` (the 400 `logging to file disabled` gate stays first). Per-request error dumps (`request-error-logs*`, `request-log-by-id`) answer the F3 501 after upstream-shaped validation errors. The log/error rings persist through the KV Store. |
| F4 inbound WebSocket `/v1/ws` | **off** | The upstream auth gate is preserved (401 `Missing/Invalid API key` bodies, or no gate when `ws-auth: false`); after it, `GET /v1/ws` answers `501 {"error":{"message":"inbound WebSocket is not available on this runtime",...}}`. `POST /v1/ws` stays the empty 404, `OPTIONS` stays 204. The 501 is the compatibility seam: a future Fluid-WS flip is non-breaking (OQ-S7-01). |
| F5a redirect auth-URLs | **off** | `{anthropic,codex,antigravity,devin}-auth-url` answer 501 after the management-key gate (no loopback callback ports exist). |
| F5b/c device flows | **degraded** (NE-S7-11) | `{xai,meta,kimi}-auth-url` run the vendor device-authorization in-invocation and return the recorded 200 envelope; the session is persisted to the KV Store and **never completes** — `get-auth-status` reads `{"status":"wait"}` for the 30-minute TTL, then `{"error":"unknown or expired state","status":"error"}`. Token exchange never happens: the poll loop would need background execution, which serverless does not have. |
| F6 config watching | **env/KV, management-writes-only** | No filesystem exists. The config arrives from the environment (or the KV document); management-API writes persist to the KV document (`config/effective`) and apply on the next invocation. |
| F7 TLS listener | **platform-terminated** | The `tls` config block is accepted and echoed; the platform edge terminates TLS. No 501 (no route involved). |
| F8 Redis RESP usage output | **absent** | No raw TCP side-band can exist; there is no substitute wire. Config keys are accepted; the usage queue keeps S6 semantics through the KV Store and is readable via `/v0/management/usage-queue`. |

Also absent on this runtime (S7 NE-S7-08): the management control panel
(route 404s as with `disable-control-panel: true`), Home mode, pprof,
mDNS discovery, TUI. `/keep-alive` 404s exactly as in upstream non-TUI mode.

## The 300 s / 800 s streaming boundary

Vercel functions have a hard `maxDuration` ceiling - 60 s on Hobby, up to
300 s on Pro (fluid compute), up to 800 s on Enterprise configurations.
When the ceiling hits, the platform stops the invocation with no chance to
emit anything; an SSE response still open at that moment would die
mid-frame.

Mitigation implemented here (the boundary envelope is **un-pinned** by S7;
this is the runtime's documented choice):

- Every upstream request leaves with the *remaining* budget of
  `CPA_MAX_STREAMING_DURATION_MS` (default `240000` - the 300 s Pro
  ceiling minus a safety margin). Set it at or below your plan's
  `maxDuration` minus a margin; Enterprise deployments with
  `maxDuration: 800` should raise it accordingly (e.g. `780000`).
- When the budget trips, the upstream exchange aborts mid-stream. The
  direction facades observe the abort as the recorded mid-stream
  transport disconnect and render their family's pinned terminal frame
  (for the OpenAI-chat family: one in-stream
  `{"error":{"message":"unexpected EOF","type":"server_error","code":"internal_server_error"}}`
  data frame, no `[DONE]`); the response then ENDS cleanly instead of
  hanging until the platform kills it. No separate 503/timeout envelope
  is emitted - S7 §4.2 keeps the mid-stream failure path family-owned.
- An abort before the first translated frame stays the family's
  pre-commit failure (a plain 500 envelope for the chat family), exactly
  like any other upstream transport failure.
- The unit test `gateway.test.ts > streaming boundary` forces the abort
  at an arbitrary byte count through the transport seam and asserts the
  terminal frame.

## Environment variables

| Variable | Meaning |
|---|---|
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | The Redis-compatible REST binding (Vercel KV / Upstash). **Required for stateful deployments**; without them the runtime falls back to a per-invocation in-memory store and logs a loud warning (nothing persists). |
| `CPA_CONFIG_JSON` | The config document as JSON (YAML-shaped keys, the recommended source). Takes `remote-management`, `api-keys`, provider sections, `logging-to-file`, `ws-auth`, `proxy-url`, ... exactly like `config.yaml`. |
| `CPA_CONFIG_YAML` | Alternative: block-style YAML text (the config.yaml dialect). |
| `CPA_CONFIG_FROM_KV=1` | Load the config from the KV document `config/effective` instead of the environment (falls back to the env when absent). |
| `CPA_CONFIG_PERSIST=1` | Persist management config mutations to the KV document so the next invocation sees them. Recommended with `CPA_CONFIG_FROM_KV=1`. |
| `CPA_MAX_STREAMING_DURATION_MS` | Streaming budget override (see the boundary section). |
| `MANAGEMENT_PASSWORD` | Fallback management secret when the config carries none (same role as on the reference runtime). |

## Deploying

The deployment unit is this directory: `vercel.json` routes every path to
the single function `api/index.ts`, which exports the platform handler.

```bash
cd runtimes/vercel
vercel deploy            # link a project first; set the env vars in the dashboard
```

Because the runtime lives inside a pnpm workspace, the most reliable path
is bundling first (the `@vercel/node` builder traces imports but workspace
symlinks outside the deployment directory are environment-dependent):

```bash
cd runtimes/vercel
npx esbuild api/index.ts --bundle --platform=node --format=esm --outfile=api/index.js --external:fzstd
vercel deploy
```

Set `maxDuration` in `vercel.json` to your plan's ceiling and
`CPA_MAX_STREAMING_DURATION_MS` below it.

## Security warnings (R-S7-A; read before going public)

- **A serverless deployment is public by default.** With no `api-keys`
  configured, client routes accept unauthenticated requests exactly as
  upstream does - but here "unauthenticated" means the whole internet.
  Configure `api-keys` before deploying.
- **Management only works with `allow-remote: true`.** Every management
  client is remote on this platform (the loopback gate can never
  succeed). Set `remote-management: { "allow-remote": true }` with a
  strong `secret-key`, or leave management unset (the whole surface
  404s). The per-IP failure counter and 30-minute ban apply as upstream.
- `GET /v0/management/config` echoes stored values **including secrets**
  (upstream parity) - the management key protects them; use a strong one
  (prefer a pre-hashed bcrypt value; a plaintext key is bcrypt-hashed at
  materialization at a cost of ~100 ms per cold invocation).
- Proxy-credentialed credentials fail **closed**: they are excluded from
  scheduling entirely, so no direct egress ever happens for a credential
  whose operator explicitly asked for a proxy (NE-S7-01).

## Store substrate and consistency trade-offs (vs. the DO store)

- The Store is an external Redis-compatible KV service over its REST
  protocol; there are no Durable Objects here. Single-key operations are
  atomic (server-side scripts), so the optimistic compare-and-swap
  behind `update()` cannot lose updates; the callback may re-run under
  contention (the core contract already requires purity).
- Reads that travel through an asynchronous replica can be stale; the
  CAS loop absorbs staleness as a retry. There is **no cross-key
  transaction** - S6's mapping keeps every document single-key, so the
  contract holds, but multi-document invariants would not be atomic here
  (the DO store provides those).
- Queue leases are reclaimed lazily by the next `claim` and rings trim
  on append: **all retention sweeps ride request traffic** - no
  background timers exist (the S7 substrate MUSTs about alarms apply to
  cloudflare only). The claim walks the queue head-to-tail inside one
  atomic command; that is the documented degraded cost. The usage-queue
  consumer applies `redis-usage-queue-retention-seconds` while popping,
  so retention also rides management traffic.
- Device-flow sessions persist in the KV Store; the poll loop that
  would complete them cannot exist (see the F5b row) - that is
  NE-S7-11, not a bug.

## Known unpinned choices

- **Proxied providers disappear from `/v1/models`.** S7 pins the
  request-time behavior for their models (the 501), not the list
  treatment; excluding them from the registry is this runtime's
  fail-closed choice (a listed-but-unservable model invites traffic
  that can only ever fail).
- **The `ws-auth` view tracks scalar management writes and
  `config.yaml` replacements**; a config replaced by other means
  between invocations is picked up on the next boot regardless
  (config is re-read per invocation).
