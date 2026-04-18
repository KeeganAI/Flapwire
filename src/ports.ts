import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

// Reverse-proxy listen ports are the upstream port with a "1" prefixed
// (3000 → 13000, 5173 → 15173). Easy to remember, obviously not the upstream.
// Returns null when the derived port won't fit in a u16 so the caller can pick
// a random free port instead.
export function deriveConventionalPort(upstreamPort: number): number | null {
  if (!Number.isInteger(upstreamPort) || upstreamPort <= 0 || upstreamPort > 65535) {
    return null;
  }
  const derived = Number.parseInt(`1${upstreamPort}`, 10);
  if (derived > 65535) return null;
  return derived;
}

export interface ListenResult {
  port: number;
  fallback: boolean;
}

// Listens on `preferred`, or falls back to a random free port if that one is
// taken or permission-denied. The caller gets back which port was actually used
// and whether we had to fall back, so the CLI can surface the difference.
export function listenPreferred(
  server: Server,
  preferred: number | null,
  host = "127.0.0.1",
): Promise<ListenResult> {
  return new Promise((resolve, reject) => {
    const tryRandom = () => {
      server.once("error", reject);
      server.listen(0, host, () => {
        const addr = server.address() as AddressInfo;
        resolve({ port: addr.port, fallback: true });
      });
    };

    if (preferred === null) {
      tryRandom();
      return;
    }

    const onError = (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE" || err.code === "EACCES") {
        tryRandom();
      } else {
        reject(err);
      }
    };
    server.once("error", onError);
    server.listen(preferred, host, () => {
      server.removeListener("error", onError);
      resolve({ port: preferred, fallback: false });
    });
  });
}
