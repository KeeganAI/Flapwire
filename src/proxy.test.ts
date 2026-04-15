import {
  type IncomingMessage,
  createServer as createHttpServer,
  request as httpRequest,
} from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createProxy } from "./proxy.js";

function listenRandom<
  S extends {
    listen: (port: number, host: string, cb: () => void) => void;
    address: () => AddressInfo | string | null;
  },
>(server: S): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve(addr.port);
    });
  });
}

function readBody(res: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    res.on("data", (c: Buffer) => chunks.push(c));
    res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    res.on("error", reject);
  });
}

function requestThroughProxy(
  proxyPort: number,
  targetUrl: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: proxyPort,
        method: "GET",
        path: targetUrl,
        headers: { Host: new URL(targetUrl).host },
      },
      async (res) => {
        const body = await readBody(res);
        resolve({ status: res.statusCode ?? 0, body });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("createProxy", () => {
  const closers: (() => Promise<void>)[] = [];

  afterEach(async () => {
    for (const close of closers) await close();
    closers.length = 0;
  });

  async function startUpstream(
    handler: (req: IncomingMessage, res: import("node:http").ServerResponse) => void,
  ) {
    const upstream = createHttpServer(handler);
    const port = await listenRandom(upstream);
    closers.push(() => new Promise<void>((r) => upstream.close(() => r())));
    return port;
  }

  async function startProxy(profile: Parameters<typeof createProxy>[0]) {
    const proxy = createProxy(profile);
    const port = await listenRandom(proxy);
    closers.push(() => new Promise<void>((r) => proxy.close(() => r())));
    return port;
  }

  it("forwards a GET request to upstream and returns the response body", async () => {
    const upstreamPort = await startUpstream((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("hello from upstream");
    });
    const proxyPort = await startProxy({});

    const result = await requestThroughProxy(proxyPort, `http://127.0.0.1:${upstreamPort}/`);

    expect(result.status).toBe(200);
    expect(result.body).toBe("hello from upstream");
  });

  it("delays response by at least the configured latency", async () => {
    const upstreamPort = await startUpstream((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    const proxyPort = await startProxy({ latency: { baseMs: 150, jitterMs: 0 } });

    const start = Date.now();
    const result = await requestThroughProxy(proxyPort, `http://127.0.0.1:${upstreamPort}/`);
    const elapsed = Date.now() - start;

    expect(result.body).toBe("ok");
    expect(elapsed).toBeGreaterThanOrEqual(140);
  });

  it("destroys the connection when loss lever says drop", async () => {
    const upstreamPort = await startUpstream((_req, res) => {
      res.end("should-not-arrive");
    });
    const proxyPort = await startProxy({ loss: { connectionDropRate: 1 } });

    await expect(
      requestThroughProxy(proxyPort, `http://127.0.0.1:${upstreamPort}/`),
    ).rejects.toThrow();
  });
});
