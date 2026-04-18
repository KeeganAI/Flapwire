import {
  type IncomingMessage,
  createServer as createHttpServer,
  request as httpRequest,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { type RequestLog, createProxy, createReverseProxy } from "./proxy.js";

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

  async function startProxy(
    profile: Parameters<typeof createProxy>[0],
    options?: Parameters<typeof createProxy>[1],
  ) {
    const proxy = createProxy(profile, options);
    const port = await listenRandom(proxy);
    closers.push(() => new Promise<void>((r) => proxy.close(() => r())));
    return port;
  }

  it("invokes the log callback with method, url, status, and applied latency on success", async () => {
    const upstreamPort = await startUpstream((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    const logs: RequestLog[] = [];
    const proxyPort = await startProxy(
      { latency: { baseMs: 50, jitterMs: 0 } },
      { log: (e) => logs.push(e) },
    );

    await requestThroughProxy(proxyPort, `http://127.0.0.1:${upstreamPort}/path?q=1`);

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      method: "GET",
      url: `http://127.0.0.1:${upstreamPort}/path?q=1`,
      outcome: "response",
      status: 200,
    });
    expect(logs[0]?.appliedLatencyMs).toBeGreaterThanOrEqual(40);
  });

  it("invokes the log callback with outcome 'drop' when the loss lever fires", async () => {
    const upstreamPort = await startUpstream((_req, res) => res.end("never"));
    const logs: RequestLog[] = [];
    const proxyPort = await startProxy(
      { loss: { connectionDropRate: 1 } },
      { log: (e) => logs.push(e) },
    );

    await expect(
      requestThroughProxy(proxyPort, `http://127.0.0.1:${upstreamPort}/`),
    ).rejects.toThrow();

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      method: "GET",
      url: `http://127.0.0.1:${upstreamPort}/`,
      outcome: "drop",
    });
  });

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

  it("rejects HTTPS CONNECT tunneling with 501 and a clear message", async () => {
    const proxyPort = await startProxy({});

    const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest({
        method: "CONNECT",
        host: "127.0.0.1",
        port: proxyPort,
        path: "example.com:443",
      });
      req.on("connect", (res, socket, head) => {
        const chunks: Buffer[] = [head];
        socket.on("data", (c: Buffer) => chunks.push(c));
        socket.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        socket.on("error", reject);
      });
      req.on("error", reject);
      req.end();
    });

    expect(result.status).toBe(501);
    expect(result.body).toMatch(/HTTPS/i);
  });

  it("does not crash the proxy process when a CONNECT client resets abruptly", async () => {
    const proxyPort = await startProxy({});

    await new Promise<void>((resolve, reject) => {
      const req = httpRequest({
        method: "CONNECT",
        host: "127.0.0.1",
        port: proxyPort,
        path: "example.com:443",
      });
      req.on("connect", (_res, socket) => {
        socket.destroy();
        resolve();
      });
      req.on("error", reject);
      req.end();
    });

    await new Promise((r) => setTimeout(r, 50));

    const ok = await new Promise<boolean>((resolve) => {
      const probe = httpRequest({
        method: "GET",
        host: "127.0.0.1",
        port: proxyPort,
        path: "http://127.0.0.1:1/",
      });
      probe.on("response", () => resolve(true));
      probe.on("error", () => resolve(true));
      probe.end();
    });

    expect(ok).toBe(true);
  });

  it("returns 504 for new requests during a blackout window", async () => {
    const upstreamPort = await startUpstream((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    let clock = 0;
    const logs: RequestLog[] = [];
    const proxyPort = await startProxy(
      { blackout: { everySeconds: 10, durationSeconds: 5 } },
      { now: () => clock, log: (e) => logs.push(e) },
    );
    clock = 6_000;
    const result = await requestThroughProxy(proxyPort, `http://127.0.0.1:${upstreamPort}/`);
    expect(result.status).toBe(504);
    expect(logs[0]?.outcome).toBe("blackout");
  });

  it("passes through when the blackout window is not active", async () => {
    const upstreamPort = await startUpstream((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    let clock = 0;
    const proxyPort = await startProxy(
      { blackout: { everySeconds: 10, durationSeconds: 2 } },
      { now: () => clock },
    );
    clock = 1_000;
    const result = await requestThroughProxy(proxyPort, `http://127.0.0.1:${upstreamPort}/`);
    expect(result.status).toBe(200);
    expect(result.body).toBe("ok");
  });
});

describe("createReverseProxy", () => {
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

  async function startReverse(
    profile: Parameters<typeof createReverseProxy>[0],
    options: Parameters<typeof createReverseProxy>[1],
  ) {
    const proxy = createReverseProxy(profile, options);
    const port = await listenRandom(proxy);
    closers.push(
      () =>
        new Promise<void>((r) => {
          proxy.closeAllConnections();
          proxy.close(() => r());
        }),
    );
    return port;
  }

  function directGet(port: number, path: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port, method: "GET", path }, async (res) => {
        const body = await readBody(res);
        resolve({ status: res.statusCode ?? 0, body });
      });
      req.on("error", reject);
      req.end();
    });
  }

  it("forwards a direct request to the configured target and returns its body", async () => {
    const upstreamPort = await startUpstream((req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(`path=${req.url}`);
    });
    const proxyPort = await startReverse({}, { target: `http://127.0.0.1:${upstreamPort}` });
    const r = await directGet(proxyPort, "/users/42?q=1");
    expect(r.status).toBe(200);
    expect(r.body).toBe("path=/users/42?q=1");
  });

  it("applies the latency lever", async () => {
    const upstreamPort = await startUpstream((_req, res) => res.end("ok"));
    const proxyPort = await startReverse(
      { latency: { baseMs: 120, jitterMs: 0 } },
      { target: `http://127.0.0.1:${upstreamPort}` },
    );
    const start = Date.now();
    const r = await directGet(proxyPort, "/");
    expect(r.body).toBe("ok");
    expect(Date.now() - start).toBeGreaterThanOrEqual(110);
  });

  it("rewrites the Host header to the upstream authority", async () => {
    let observedHost: string | undefined;
    const upstreamPort = await startUpstream((req, res) => {
      observedHost = req.headers.host;
      res.end("ok");
    });
    const proxyPort = await startReverse({}, { target: `http://127.0.0.1:${upstreamPort}` });
    await directGet(proxyPort, "/");
    expect(observedHost).toBe(`127.0.0.1:${upstreamPort}`);
  });

  it("serves 504 during blackout", async () => {
    const upstreamPort = await startUpstream((_req, res) => res.end("ok"));
    let clock = 0;
    const proxyPort = await startReverse(
      { blackout: { everySeconds: 10, durationSeconds: 5 } },
      { target: `http://127.0.0.1:${upstreamPort}`, now: () => clock },
    );
    clock = 6_000;
    const r = await directGet(proxyPort, "/");
    expect(r.status).toBe(504);
  });

  function startUpstreamWithUpgrade(): Promise<{ port: number; close: () => Promise<void> }> {
    return new Promise((resolve) => {
      const upgraded = new Set<Socket>();
      const server = createHttpServer((_req, res) => res.end("ok"));
      server.on("upgrade", (_req: IncomingMessage, socket: Socket) => {
        upgraded.add(socket);
        socket.on("close", () => upgraded.delete(socket));
        socket.write(
          "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
        );
      });
      server.listen(0, "127.0.0.1", () => {
        const port = (server.address() as AddressInfo).port;
        resolve({
          port,
          close: () =>
            new Promise<void>((r) => {
              for (const s of upgraded) s.destroy();
              upgraded.clear();
              server.closeAllConnections();
              server.close(() => r());
            }),
        });
      });
    });
  }

  function sendUpgrade(
    proxyPort: number,
    path: string,
  ): Promise<{ status: number; socket: Socket }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest({
        host: "127.0.0.1",
        port: proxyPort,
        method: "GET",
        path,
        headers: {
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Version": "13",
          "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        },
      });
      req.on("upgrade", (res, socket) => resolve({ status: res.statusCode ?? 0, socket }));
      req.on("error", reject);
      req.end();
    });
  }

  it("forwards WebSocket upgrade to upstream and returns 101", async () => {
    const upstream = await startUpstreamWithUpgrade();
    closers.push(upstream.close);
    const proxyPort = await startReverse({}, { target: `http://127.0.0.1:${upstream.port}` });

    const { status, socket } = await sendUpgrade(proxyPort, "/_ws");
    socket.destroy();

    expect(status).toBe(101);
  });

  it("drops WebSocket upgrade when loss lever fires", async () => {
    const upstream = await startUpstreamWithUpgrade();
    closers.push(upstream.close);
    const proxyPort = await startReverse(
      { loss: { connectionDropRate: 1 } },
      { target: `http://127.0.0.1:${upstream.port}` },
    );

    await expect(sendUpgrade(proxyPort, "/")).rejects.toThrow();
  });

  it("logs WebSocket upgrade with outcome response and status 101", async () => {
    const upstream = await startUpstreamWithUpgrade();
    closers.push(upstream.close);
    const logs: RequestLog[] = [];
    const proxyPort = await startReverse(
      {},
      { target: `http://127.0.0.1:${upstream.port}`, log: (e) => logs.push(e) },
    );

    const { socket } = await sendUpgrade(proxyPort, "/chat");
    socket.destroy();
    await new Promise((r) => setTimeout(r, 20));

    expect(logs[0]).toMatchObject({ outcome: "response", status: 101, url: "/chat" });
  });

  it("destroys WebSocket upgrade socket during blackout", async () => {
    const upstream = await startUpstreamWithUpgrade();
    closers.push(upstream.close);
    let clock = 0;
    const proxyPort = await startReverse(
      { blackout: { everySeconds: 10, durationSeconds: 5 } },
      { target: `http://127.0.0.1:${upstream.port}`, now: () => clock },
    );
    clock = 6_000;

    await expect(sendUpgrade(proxyPort, "/")).rejects.toThrow();
  });
});
