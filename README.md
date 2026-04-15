# Flapwire

Local HTTP proxy that degrades traffic — latency, jitter, simulated packet loss — so you can see how your app behaves under bad network conditions.

> **Status:** pre-release, not on npm yet. The commands below assume you cloned the repo.

## What works today

- Explicit HTTP proxy on a local port.
- Latency lever: configurable base delay plus uniform jitter.
- Loss lever: probabilistic connection drop (the proxy destroys the client socket; from the caller's perspective it looks like a reset).
- Three built-in profiles: `fast-3g`, `slow-3g`, `flaky-wifi`.

HTTPS, an admin UI, external profiles, and CI helpers are not in this build.

## Run from source

Requires Node >= 22.

```sh
git clone https://github.com/KeeganAI/flapwire.git
cd flapwire
npm install
npm run build
```

Start the proxy:

```sh
node dist/cli.js --profile slow-3g --port 8080
```

Send HTTP traffic through it (in another terminal):

```sh
curl -x http://127.0.0.1:8080 http://example.com/
```

Stop with `Ctrl-C`.

## Commands

```sh
node dist/cli.js [--profile <name>] [--port <number>]
```

| Option            | Default   | Description                                                 |
| ----------------- | --------- | ----------------------------------------------------------- |
| `--profile`, `-p` | `slow-3g` | One of `fast-3g`, `slow-3g`, `flaky-wifi`.                  |
| `--port`          | `8080`    | Local port the proxy listens on.                            |

### Built-in profiles

| Name         | Latency (base ± jitter) | Connection drop rate |
| ------------ | ----------------------- | -------------------- |
| `fast-3g`    | 100ms ± 50ms            | 0%                   |
| `slow-3g`    | 400ms ± 200ms           | 0.5%                 |
| `flaky-wifi` | 150ms ± 300ms           | 2%                   |

## Development

```sh
npm test          # vitest run
npm run lint      # biome check
npm run typecheck # tsc --noEmit
npm run build     # tsup
```

Tests are co-located with sources as `*.test.ts`.

## License

MIT. See [LICENSE](./LICENSE).

---

This is a side project maintained in spare time. Issues are read but response time is not guaranteed.
