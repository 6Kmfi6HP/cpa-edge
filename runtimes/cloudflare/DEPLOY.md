# CPA-Edge on Cloudflare Workers (runtime T2)

One Worker deployment serves the whole gateway. All state - config text,
auth files, cooldowns, OAuth sessions, usage queue, log ring - lives in
one Durable Object (`CPA_EDGE_DO`), which is this platform's equivalent
of the reference's single process. Token refresh, RFC-8628 device-flow
polling and the retention sweeps run on the object's alarm; `/v1/ws`
upgrades are accepted into WebSocket hibernation.

## Deploy

1. `npx wrangler deploy` (from `runtimes/cloudflare`).
2. Provide the config (one of):
   - **KV binding** `CPA_CONFIG` holding the `config.yaml` text under
     the key `config.yaml` (recommended), or
   - **plain-text var** `CPA_CONFIG_YAML` with the config text inline
     (`[vars]` in `wrangler.toml` - keep secrets out of it).
3. First boot seeds the object's stored copy from that source. After
   that, config changes go through the management API only
   (`PUT /v0/management/config.yaml`, scalar writes) - there is no file
   watcher on this platform (S7 F6), and writes hot-reload the gateway
   immediately.

## Required config on this platform

- `remote-management.allow-remote: true` **must** be set for the
  management API to work at all: every management client is remote
  (S7 note N7), so the loopback gate can never succeed without it. Use a
  strong `secret-key`.
- With `api-keys` absent the gateway is an **open proxy** (upstream
  fail-open default, ruling R-S7-A) - set `api-keys` before exposing
  the deployment publicly.

## Platform behavior vs the reference (S7 matrix)

| Feature | Behavior here |
|---|---|
| F1 outbound proxy | proxy-credentialed credentials are excluded from scheduling; requests with no eligible credential get `501 proxy_unavailable`; config accepted + echoed |
| F2 plugins | config surface served; installs `501`; nothing loads |
| F3 logs | `GET/DELETE /v0/management/logs` served from the DO-backed log ring (capacity 1000, same shapes) |
| F4 `/v1/ws` | route served: auth gate (`ws-auth`, default required), gorilla-style 400 for non-upgrades, passing upgrades accepted into DO hibernation; the wsrelay protocol behind the 101 has no merged executor, sessions hold silent |
| F5a redirect logins | `anthropic/codex/antigravity/devin-auth-url` -> `501 local callback server is not available on this runtime` |
| F5b device logins | EQUIVALENT: sessions are Store-backed, polling runs on DO alarms, completions persist auth files exactly like the package flows |
| F5c callbacks | EQUIVALENT: `/anthropic/callback` etc. + the oauth-callback ladder run over the Store-backed registry |
| F6 hot reload | management API writes only, applied immediately |
| F7 TLS | platform-terminated; the `tls` block is accepted + ignored |
| F8 RESP usage wire | no raw TCP listener exists; config keys accepted; `GET /v0/management/usage-queue` keeps its semantics |

## Notes

- Config text for the gateway is parsed by this runtime's block-YAML
  reader (`src/yaml-config.ts`). Flow collections, anchors, block
  scalars and tab indentation are rejected at boot - rewrite the config
  in block style first (the management facade's own writer always emits
  block style).
- `content-encoding: zstd` request bodies need the `fzstd` decoder; it
  is not yet a dependency of this package, so such bodies answer
  `unsupported content encoding: zstd` until the orchestrator links it
  (open item in the T2 report).
