# Changelog

All notable changes to Flapwire are recorded here. Hand-written.

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