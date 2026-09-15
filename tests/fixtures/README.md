# Fixtures (golden samples)

- Recorded by @oracle-runner against the ANCHORED upstream binary. Deterministic:
  fixed inputs; volatile fields (timestamps, request ids) normalized.
- Layout: `tests/fixtures/<step-id>/<case-id>/...` — the exact layout per step is
  defined by the corresponding spec section.
- Contract tests in `tests/contract/**` compare implementations against these
  byte-exactly, modulo the volatility whitelist declared in the spec section.
