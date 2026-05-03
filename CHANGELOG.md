# Changelog

All notable changes to Flapwire are recorded here. Hand-written.

## [0.2.2] - 2026-05-03

### Added
- Admin API. A separate HTTP server, off by default, that lets you flip the active profile, force a blackout window, or queue a one-shot failure on the running proxy without restarting it. Bind it with `--admin-port 17070` on the CLI or `admin: { port: 17070 }` in the config; it always listens on `127.0.0.1` (no auth — localhost is the trust boundary).
  - `GET  /admin/status`
  - `POST /admin/profile  { "name": "fast-3g" }`
  - `POST /admin/blackout { "durationSeconds": 5 }`
  - `POST /admin/fail     { "status": 503, "count": 3 }`
  - In multi-route reverse mode, every proxy's state is updated together — one knob, all routes.

### Internals
- New `state` module holds the live profile, forced-blackout deadline, and pending failures behind one `ProxyState` object. `handle()`, the blackout reaper and the upgrade handler all read through it, so admin mutations apply mid-flight without restarting the proxy.

## [0.2.1] - 2026-05-03

### Added
- `flapwire.config.yaml` support. Drop a file in your project root (or point at one with `--config <path>`) and Flapwire reads `profile`, `port`, `target`, `routes`, and `upstreamCa` from it. CLI flags still work and override the file field by field — same convention as Vite, Next, Playwright. Schema is intentionally narrow for now; the admin API and failure-injection rules will extend it in the next two patches.

### Internals
- New `config` module with `parseConfig`, `loadConfig`, and `mergeOverrides`. CLI assembly is now: load file → layer CLI overrides → run.

## [0.2.0] - 2026-04-23

### Added
- HTTPS support, both ways. Forward-proxied browsers can now CONNECT through Flapwire and reach HTTPS sites: the proxy answers 200, terminates TLS with a leaf cert it signed on the fly, and re-establishes TLS with the real upstream. Reverse mode accepts `--target https://...` and `--route 13000=https://...` and speaks TLS to the upstream directly. Either way, the same three levers apply identically — latency delays the request, drop turns into an RST, blackout tears the tunnel down.
- `flapwire trust` subcommand. Installs the local CA in the OS trust store so HTTPS just works in the browser. macOS goes through `security add-trusted-cert`, Linux uses `update-ca-certificates` (Debian/Ubuntu) or `update-ca-trust` (Fedora/RHEL). Windows surfaces the `certutil` command for the user to paste into an elevated PowerShell. `flapwire trust --uninstall` reverses it. Sudo is invoked transparently when needed; the password prompt comes from sudo, not from us.
- `upstreamCa` option on `createProxy` / `createReverseProxy` for trusting a self-signed upstream — handy when proxying to a local dev server that doesn't have a real cert.
- `CONTRIBUTING.md`, plus issue templates for bug reports, feature requests, and new profiles. Profiles are still the easiest path for first-time contributions.

### Changed
- CI now runs on Windows too, alongside Linux and macOS. The trust-store paths are different enough between OSes that not testing them all is bugiardo.
- Package and CLI descriptions now correctly say "HTTP/HTTPS proxy". The README's "HTTPS deferred to v0.2" line is gone.

### Internals
- New `cert` module signs a 10-year self-signed root CA on first use (persisted at `$XDG_CONFIG_HOME/flapwire/ca.pem` with the private key chmod 600), then signs leaf certs per hostname on demand and caches them in process memory.
- New `trust` module abstracts the platform-specific trust-store calls behind a small runner interface, which keeps the unit tests honest without touching the real keychain.

## [0.1.6] - 2026-04-18

### Added
- Reverse-proxy mode now forwards HTTP `Upgrade` handshakes — the same mechanism browsers use to open WebSockets. Until now, any upgrade (Next.js HMR, Vite HMR, Socket.IO, a hand-rolled WebSocket client) would just hang on the proxy. The handshake is piped to the upstream and the raw sockets are bridged in both directions.
- The three levers apply to WebSocket upgrades the same way they apply to HTTP: latency delays the handshake, the loss lever can drop the upgrade attempt, and a blackout tears the handshake down instead of answering it.

### Changed
- README now has a dedicated "How the levers work" section spelling out exactly what `latency`, `drop`, and `blackout` do given their config values — including the fact that latency is Gaussian (so `jitterMs` is the standard deviation, not a half-range) and that blackouts fire at the *end* of each cycle.

## [0.1.56] - 2026-04-18

### Fixed
- Writes to the client socket after `await delay()` are now guarded against the socket being already destroyed (e.g. by the blackout reaper tearing down connections mid-request). Previously this could throw an unhandled error in the `blackout` and "no upstream" paths.
- `--help` no longer shows `(default: "")` for `--port` or `(default: [])` for `--route`.

## [0.1.55] - 2026-04-15

### Fixed
- Reverse-proxy mode now rewrites the `Host` header to the upstream's authority before forwarding. Before this, virtual-hosted upstreams (Vercel, nginx, most CDNs) saw `Host: localhost:13000` and couldn't route the request. Node.js dev servers didn't notice because they don't look.

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
