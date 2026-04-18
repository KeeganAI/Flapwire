# Flapwire

Local HTTP proxy that degrades traffic on purpose — jittered latency, random connection drops, periodic blackouts — so you can see what breaks before production does.

## Forward proxy (classic)

```sh
npx flapwire --profile slow-3g
# then, in another terminal:
curl -x http://127.0.0.1:8080 http://example.com/
```

## Reverse proxy

Point your app at Flapwire instead of the upstream and it'll degrade on the way through — no browser proxy config, no `/etc/hosts`, no flags. Plain HTTP requests and WebSocket upgrades (e.g. Next.js / Vite HMR) are both forwarded, and the same levers apply to the WebSocket handshake.

Single target:

```sh
npx flapwire --target http://localhost:3000 --profile flaky-wifi
# listens on http://127.0.0.1:13000 → http://localhost:3000
```

Multiple services in one process:

```sh
npx flapwire \
  --route 13000=http://localhost:3000 \
  --route 15173=http://localhost:5173 \
  --route 18080=http://localhost:8080 \
  --profile train-wifi
```

Listen ports are the upstream port with a leading `1` by convention (`3000 → 13000`). When that doesn't fit (out of range, already taken, duplicated), Flapwire picks a free port and tells you which one.

The proxy logs each request:

```
GET http://example.com/ → 200 (412ms)
GET http://example.com/favicon.ico → drop
GET /api/me → 504 blackout (380ms)
```

## Profiles

| Name         | Latency (base ± σ) | Drop rate | Blackout         |
| ------------ | ------------------ | --------- | ---------------- |
| `fast-3g`    | 100ms ± 50ms       | 0%        | —                |
| `slow-3g`    | 400ms ± 200ms      | 0.5%      | —                |
| `flaky-wifi` | 150ms ± 300ms      | 2%        | —                |
| `train-wifi` | 500ms ± 400ms      | 2%        | 4s every 60s     |

## How the levers work

Each profile is a mix of three independent levers.

**Latency** — every request is delayed by a sample drawn from a normal distribution centred on `baseMs` with standard deviation `jitterMs`, clamped to zero. Roughly 68% of samples fall within `baseMs ± jitterMs`, 95% within `±2 × jitterMs`. The delay is applied before the response is written, so the client experiences it as time-to-first-byte — exactly what happens on a real slow link.

**Drop** — before latency kicks in, each incoming connection is independently discarded with probability `connectionDropRate` (a value between 0 and 1). "Discarded" here means the TCP socket is destroyed with no response at all, the way a client would see a packet-loss or RST event from the network.

**Blackout** — windows where the proxy stops forwarding entirely. `everySeconds` is the cycle length, `durationSeconds` is how much of each cycle the blackout covers. The blackout lands at the *end* of every cycle: for the last `durationSeconds` of each window, existing connections are torn down and new requests are answered with `504 Gateway Timeout` — after the profile's latency, so the stall feels like a real upstream going unreachable rather than an instant reset. WebSocket upgrade attempts during a blackout are refused the same way: the TCP socket is closed.

A lever with no configured value is simply inactive: no latency, no drops, or no blackout cycle at all.

## Options

```sh
flapwire [--profile <name>] [--port <number>] [--target <url>] [--route <PORT=URL> ...]
```

- `--profile`, `-p` — one of `fast-3g`, `slow-3g`, `flaky-wifi`, `train-wifi`. Default: `slow-3g`.
- `--port` — port to listen on. Forward mode default is `8080`. In `--target` mode use an explicit number, or `auto` (or leave it off) to let Flapwire derive it from the upstream port.
- `--target <url>` — single reverse-proxy upstream. Mutually exclusive with `--route`.
- `--route <PORT=URL>` — repeatable; open one listen port per route, all sharing the same profile.

If neither `--target` nor `--route` is given, Flapwire runs as a forward proxy (v0.1 behaviour).

## Why not ...

- **Chrome DevTools throttling** — lives in the browser, can't be scripted, applies a flat delay. Fine for one manual check; not usable in CI or for non-browser clients.
- **Playwright / Cypress network emulation** — same browser-only limitation, no real jitter, loss, or blackout.
- **`tc` / `netem`** — kernel-level, far more powerful, Linux-only without contortions, steep learning curve. If you need packet-level fidelity, reach for `tc`.
- **toxiproxy** — closest neighbour. More features, more configurability, a running daemon and its own config format. Flapwire is deliberately smaller.

## Not in this release

HTTPS is still not supported. `CONNECT` tunnels are rejected with `501 Not Implemented`; for HTTPS upstreams, wait for v0.2.

No bandwidth throttling, external YAML profiles, admin API, UI, or CI helpers yet.

## License

MIT. See [LICENSE](./LICENSE).

---

This is a side project maintained in spare time. Issues are read but response time is not guaranteed.
