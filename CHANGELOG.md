# Changelog

All notable changes to Flapwire are recorded here. Hand-written.

## [0.1.51] - 2026-04-15

### Fixed
- `Ctrl+C` now actually stops the proxy. Previously `server.close()` waited for HTTP keep-alive connections (typical of any browser client) to drain on their own, so the CLI appeared to hang on SIGINT. Open sockets are now closed immediately; a second SIGINT forces exit.

## [0.1.5] - 2026-04-15

### Added
- Reverse-proxy mode. A single upstream via `--target http://host:port`, or several via repeatable `--route PORT=URL`. Pick the mode from the flags: `--target`/`--route` → reverse, otherwise forward (as in 0.1).
- Listen-port convention for reverse mode: prefix the upstream port with `1` (`3000 → 13000`, `5173 → 15173`, `8080 → 18080`). Falls back to a free random port — with a clear log line — when the derived port is out of range, taken, or duplicated across routes.
- `blackout` lever. Periodic windows where the proxy stops forwarding: existing connections are torn down, new requests get `504 Gateway Timeout` (still after the profile's latency, so the blackout feels like a real stall). Configurable as `{ everySeconds, durationSeconds }`.
- `train-wifi` profile: 500ms ± 400ms latency, 2% drop, 4s blackout every 60s.
- `--port auto` as an explicit shortcut for the single-target reverse mode (same as omitting `--port`).

### Changed
- The `501` message emitted on `CONNECT` now points at reverse-proxy mode as the near-term workaround instead of just deferring to v0.2.

### Known limits of this release
- Still HTTP only. HTTPS (and the `trust` subcommand) remains scheduled for v0.2.
- No external YAML config, admin API, UI, bandwidth throttling, or failure injection yet.

## [0.1.0] - 2026-04-15

### Added
- Forward HTTP proxy (explicit-proxy mode: `curl -x http://127.0.0.1:PORT ...`, or `HTTP_PROXY=...`).
- Three hardcoded network profiles: `fast-3g`, `slow-3g`, `flaky-wifi`.
- Latency degradation with Gaussian jitter via Box-Muller; `jitterMs` is the standard deviation.
- Connection-drop degradation: probabilistic RST on the client socket, rate from the profile.
- Per-request stdout logging: method, URL, applied latency, or `drop`.
- CLI with `--profile` and `--port`.

### Known limits of this release
- HTTPS is not supported, yet. CONNECT tunnels are rejected with `501 Not Implemented` and a short message pointing at v0.2.
- No bandwidth throttling, external YAML profiles, admin API, UI, or CI helpers yet.
