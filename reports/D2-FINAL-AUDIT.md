# D2 — GLOBAL FINAL AUDIT (final report)
Auditor: adv-d2-final. Full 4-part report delivered via agent messages 2026-09-16; archived conclusions + the orchestrator rulings.

## VERDICT: NOT release-ready as published -> re-scoped honestly per the (b) recommendation; rulings GR-1..GR-8 registered in SPEC section 5 (commit 904b7e6).

## The audited state (summary)
- 344/399 golden case dirs replayed byte-exactly by 2057 green tests; the protocol surface (S1 routing/envelopes, 10 translation directions, S5 management, S6 state, S3 auth) faithfully pinned; cloudflare + vercel deliver their REGISTERED degradation contracts cleanly.
- Release-blocking findings (all ruled):
  M1 OAuth credentials never serve (GR-1: registered; v1.1) — claude/codex/antigravity/kimi/xai/meta/devin OAuth files load/login/refresh but no model maps to them (400 model_not_found).
  M2 antigravity executor absent while claimed satisfied (GR-2: registered honestly; 18 recorded goldens = the v1.1 spec).
  M3 published node capability list false in 7+ rows (RESOLVED: D1 doc-truth rewrite d49a1b2; node parity round items re-registered per T1's final state).
  M4 round-robin/multi-account not wired at request time (GR-4: registered; engine merged + unit-pinned; serving = first-fit + cooldown + retry; v1.1 wiring).
  M5 node /v1/ws absent (per T1 parity round final state — gates + replay if landed, else GR-5 registered).
- High: M6 node background drivers absent (GR-5); M7 hot-reload absent on node (GR-5; T1 round); M8 node proxy bypass (GR-5: ingestion+fail-closed in the T1 round; dialing registered).
- Medium: M9 503-vs-501 seam shapes (GR-3: the 503 seam body IS the registered v1 shape); M10 native passthroughs unlisted (GR-3); M11 accepted-inert config (GR-6); M12 unreplayed golden classes (GR-8); M13 /v1/completions legacy seam (GR-7).
- Top-10 residual risks: see the message thread (value-proposition inversion; doc-as-contract; traffic concentration; node driver gaps; proxy bypass; hot-reload freeze; spec-vs-tree drift; unreplayed classes; process residuals; serverless sharp edges).

## T4 END-TO-END SMOKE (the release gate): 16 recorded requests, REF vs EDGE over real sockets: statuses 16/16 equal, bodies 16/16 byte-identical, upstream wires byte-identical; golden-parity 13/16 (3 header-layer divergences: F1 trace presence on the cooldown envelope; F2 SSE emission order; both dispatched to fix-t4-parity; T1/T2 transport emissions registered as node-platform facts). Re-run staged.
