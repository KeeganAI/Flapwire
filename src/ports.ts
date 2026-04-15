import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

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
