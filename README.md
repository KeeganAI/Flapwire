# Flapwire

Local HTTP/HTTPS proxy that degrades traffic realistically — jitter, packet loss, bandwidth throttling, blackouts — so you can test how your app behaves when the network actually misbehaves.

> **Status:** pre-release. v0.1 in active development. No public releases yet.

## Why

The browser's "Slow 3G" gives you constant-speed slowness. Real networks don't work that way — they have jitter, dropped connections, bandwidth that oscillates, 4-second blackouts when a tunnel starts. That's where the interesting bugs live: retry storms, misconfigured timeouts, half-finished transactions, UI state that assumed the request would always come back.

Flapwire aims to make those conditions trivial to reproduce — locally in a browser, or in CI behind a Playwright suite.

## Non-goals

- Replacing `tc` / `netem` — kernel-level tools are more powerful; Flapwire trades fidelity for zero-setup.
- Load testing (`k6`, Artillery) or infrastructure chaos (Chaos Mesh, Gremlin).

## License

MIT. See [LICENSE](./LICENSE).

---

This is a side project maintained in spare time. Issues are read but response time is not guaranteed.
