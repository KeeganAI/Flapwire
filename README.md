# Flapwire

Local HTTP proxy that degrades traffic on purpose — jittered latency, random connection drops — so you can see what breaks before production does.

```sh
npx flapwire --profile slow-3g
# then, in another terminal:
curl -x http://127.0.0.1:8080 http://example.com/
```

The proxy logs each request it passes:

```
GET http://example.com/ → 200 (412ms)
GET http://example.com/favicon.ico → drop
```

## Profiles

| Name         | Latency (base ± σ) | Connection drop rate |
| ------------ | ------------------ | -------------------- |
| `fast-3g`    | 100ms ± 50ms       | 0%                   |
| `slow-3g`    | 400ms ± 200ms      | 0.5%                 |
| `flaky-wifi` | 150ms ± 300ms      | 2%                   |

Latency uses a normal distribution — `jitterMs` is the standard deviation, not a uniform half-range. Real networks look more like this than "always 400ms".

## Options

```sh
flapwire [--profile <name>] [--port <number>]
```

- `--profile`, `-p` — one of `fast-3g`, `slow-3g`, `flaky-wifi`. Default: `slow-3g`.
- `--port` — local port to listen on. Default: `8080`.

## Why not ...

- **Chrome DevTools throttling** — lives in the browser, can't be scripted, applies a flat delay. Fine for one manual check; not usable in CI or for non-browser clients.
- **Playwright / Cypress network emulation** — same browser-only limitation, no real jitter or loss.
- **`tc` / `netem`** — kernel-level, far more powerful, Linux-only without contortions, steep learning curve. If you need packet-level fidelity, reach for `tc`.
- **toxiproxy** — closest neighbour. More features, more configurability, a running daemon and its own config format. Flapwire is deliberately smaller.

## Not in this release

HTTPS is not supported. CONNECT requests are rejected with `501 Not Implemented` and a message that says so.

No bandwidth throttling, external YAML profiles, admin API, UI, or CI helpers yet.

## License

MIT. See [LICENSE](./LICENSE).

---

This is a side project maintained in spare time. Issues are read but response time is not guaranteed.
