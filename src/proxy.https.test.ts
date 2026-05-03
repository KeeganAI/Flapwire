import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createHttpsServer } from "node:https";
import { type AddressInfo, connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TLSSocket, connect as tlsConnect } from "node:tls";
import forge from "node-forge";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type CertStore, createCertStore } from "./cert.js";
import { type RequestLog, createProxy, createReverseProxy } from "./proxy.js";

// Issues a plain self-signed cert for a single host. Used by the test-side
// upstream — Flapwire still verifies it (via upstreamCa), we just don't have
// a public CA to sign with in unit tests.
function selfSigned(hostname: string): { cert: string; key: string } {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  const attrs = [{ name: "commonName", value: hostname }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  const isIp = /^\d+\.\d+\.\d+\.\d+$/.test(hostname);
  cert.setExtensions([
    { name: "basicConstraints", cA: false },
    {
      name: "subjectAltName",
      altNames: [isIp ? { type: 7, ip: hostname } : { type: 2, value: hostname }],
    },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return {
    cert: forge.pki.certificateToPem(cert),
    key: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

interface HttpResponse {
  status: number;
  body: string;
  rawHead: string;
}

// Manually tunnels an HTTPS request through Flapwire: CONNECT, read 200, TLS
// handshake, HTTP request, read response, close. Built from net/tls rather
// than http/https because we need fine-grained control over what goes over
// the wire and which CA we trust.
async function httpsThroughProxy(args: {
  proxyPort: number;
  target: string; // "host:port"
  path: string;
  trustCa: string; // PEM of the CA we expect Flapwire's leaf to chain to
  servername?: string;
}): Promise<HttpResponse> {
  const raw = netConnect({ host: "127.0.0.1", port: args.proxyPort });
  await new Promise<void>((resolve, reject) => {
    raw.once("connect", () => resolve());
    raw.once("error", reject);
  });

  raw.write(`CONNECT ${args.target} HTTP/1.1\r\nHost: ${args.target}\r\n\r\n`);

  await new Promise<void>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      const text = Buffer.concat(chunks).toString("utf8");
      const idx = text.indexOf("\r\n\r\n");
      if (idx >= 0) {
        raw.off("data", onData);
        // Any bytes after the CONNECT reply are already part of the tunnel —
        // feed them back so the TLS socket sees the start of ServerHello.
        const tailStart = Buffer.byteLength(text.slice(0, idx + 4));
        const merged = Buffer.concat(chunks);
        const tail = merged.subarray(tailStart);
        if (tail.length > 0) raw.unshift(tail);
        const firstLine = text.split("\r\n")[0] ?? "";
        if (firstLine.startsWith("HTTP/1.1 200")) resolve();
        else reject(new Error(`CONNECT rejected: ${firstLine}`));
      }
    };
    raw.on("data", onData);
    raw.on("error", reject);
    // If the proxy destroys the socket mid-CONNECT (blackout, hard refuse),
    // we see `close` without ever getting response bytes — surface that as
    // an error to the caller instead of hanging.
    raw.on("close", () => reject(new Error("proxy closed the CONNECT socket")));
    raw.on("end", () => reject(new Error("proxy ended the CONNECT socket")));
  });

  const host = args.target.split(":")[0] as string;
  const tlsSocket = tlsConnect({
    socket: raw,
    servername: args.servername ?? host,
    ca: [args.trustCa],
  });
  await new Promise<void>((resolve, reject) => {
    tlsSocket.once("secureConnect", () => resolve());
    tlsSocket.once("error", reject);
  });

  tlsSocket.write(`GET ${args.path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);

  const respRaw = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    tlsSocket.on("data", (c: Buffer) => chunks.push(c));
    tlsSocket.on("end", () => resolve(Buffer.concat(chunks)));
    tlsSocket.on("error", reject);
  });

  const text = respRaw.toString("utf8");
  const sep = text.indexOf("\r\n\r\n");
  const rawHead = sep >= 0 ? text.slice(0, sep) : text;
  const body = sep >= 0 ? text.slice(sep + 4) : "";
  const statusLine = rawHead.split("\r\n")[0] ?? "";
  const status = Number.parseInt(statusLine.split(" ")[1] ?? "0", 10);
  return { status, body, rawHead };
}

describe("createProxy (CONNECT tunneling)", () => {
  let storeDir: string;
  let certStore: CertStore;
  let upstreamCert: string;
  let upstreamKey: string;
  const closers: (() => Promise<void>)[] = [];

  beforeAll(() => {
    storeDir = mkdtempSync(join(tmpdir(), "flapwire-https-test-"));
    certStore = createCertStore({ dir: storeDir });
    const ss = selfSigned("127.0.0.1");
    upstreamCert = ss.cert;
    upstreamKey = ss.key;
  });

  afterAll(() => {
    rmSync(storeDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    for (const close of closers) await close();
    closers.length = 0;
  });

  async function startHttpsUpstream(
    handler: (
      req: import("node:http").IncomingMessage,
      res: import("node:http").ServerResponse,
    ) => void,
  ) {
    const server = createHttpsServer({ cert: upstreamCert, key: upstreamKey }, handler);
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
    });
    closers.push(
      () =>
        new Promise<void>((r) => {
          server.closeAllConnections();
          server.close(() => r());
        }),
    );
    return port;
  }

  async function startProxy(
    profile: Parameters<typeof createProxy>[0],
    opts: Parameters<typeof createProxy>[1] = {},
  ) {
    const proxy = createProxy(profile, { certStore, upstreamCa: upstreamCert, ...opts });
    const port = await new Promise<number>((resolve) => {
      proxy.listen(0, "127.0.0.1", () => resolve((proxy.address() as AddressInfo).port));
    });
    closers.push(
      () =>
        new Promise<void>((r) => {
          proxy.closeAllConnections();
          proxy.close(() => r());
        }),
    );
    return port;
  }

  it("tunnels an HTTPS request to the upstream and returns its body", async () => {
    const upstreamPort = await startHttpsUpstream((req, res) => {
      const body = `path=${req.url}`;
      res.writeHead(200, {
        "Content-Type": "text/plain",
        "Content-Length": Buffer.byteLength(body),
      });
      res.end(body);
    });
    const proxyPort = await startProxy({});

    const r = await httpsThroughProxy({
      proxyPort,
      target: `127.0.0.1:${upstreamPort}`,
      path: "/hello?q=1",
      trustCa: certStore.ca.cert,
    });

    expect(r.status).toBe(200);
    expect(r.body).toBe("path=/hello?q=1");
  });

  it("applies latency to requests inside the tunnel", async () => {
    const upstreamPort = await startHttpsUpstream((_req, res) => res.end("ok"));
    const proxyPort = await startProxy({ latency: { baseMs: 150, jitterMs: 0 } });

    const start = Date.now();
    const r = await httpsThroughProxy({
      proxyPort,
      target: `127.0.0.1:${upstreamPort}`,
      path: "/",
      trustCa: certStore.ca.cert,
    });
    const elapsed = Date.now() - start;

    expect(r.body).toBe("ok");
    expect(elapsed).toBeGreaterThanOrEqual(140);
  });

  it("logs HTTPS tunneled requests with the https:// url", async () => {
    const upstreamPort = await startHttpsUpstream((_req, res) => res.end("ok"));
    const logs: RequestLog[] = [];
    const proxyPort = await startProxy({}, { log: (e) => logs.push(e) });

    await httpsThroughProxy({
      proxyPort,
      target: `127.0.0.1:${upstreamPort}`,
      path: "/api",
      trustCa: certStore.ca.cert,
    });

    const hit = logs.find((l) => l.outcome === "response");
    expect(hit).toBeTruthy();
    expect(hit?.url).toBe("https://127.0.0.1/api");
  });

  it("drops the request inside the tunnel when the loss lever fires", async () => {
    const upstreamPort = await startHttpsUpstream((_req, res) => res.end("never"));
    const logs: RequestLog[] = [];
    const proxyPort = await startProxy(
      { loss: { connectionDropRate: 1 } },
      { log: (e) => logs.push(e) },
    );

    // The drop fires inside handle(), which destroys the TLS socket. The
    // tunnel returns no data — body 0/empty, no exception. The truth is in
    // the log: a "drop" outcome on the GET that went through.
    const r = await httpsThroughProxy({
      proxyPort,
      target: `127.0.0.1:${upstreamPort}`,
      path: "/",
      trustCa: certStore.ca.cert,
    }).catch(() => ({ status: 0, body: "", rawHead: "" }));

    expect(r.status).toBe(0);
    expect(logs.some((l) => l.method === "GET" && l.outcome === "drop")).toBe(true);
  });

  it("closes the CONNECT socket when blackout is active", async () => {
    const upstreamPort = await startHttpsUpstream((_req, res) => res.end("ok"));
    let clock = 0;
    const logs: RequestLog[] = [];
    const proxyPort = await startProxy(
      { blackout: { everySeconds: 10, durationSeconds: 5 } },
      { now: () => clock, log: (e) => logs.push(e) },
    );
    clock = 6_000;

    await expect(
      httpsThroughProxy({
        proxyPort,
        target: `127.0.0.1:${upstreamPort}`,
        path: "/",
        trustCa: certStore.ca.cert,
      }),
    ).rejects.toThrow();

    expect(logs.some((l) => l.method === "CONNECT" && l.outcome === "blackout")).toBe(true);
  });

  it("rejects CONNECT with 501 when no certStore is configured", async () => {
    const proxyNoStore = createProxy({});
    const port = await new Promise<number>((resolve) => {
      proxyNoStore.listen(0, "127.0.0.1", () =>
        resolve((proxyNoStore.address() as AddressInfo).port),
      );
    });
    closers.push(
      () =>
        new Promise<void>((r) => {
          proxyNoStore.closeAllConnections();
          proxyNoStore.close(() => r());
        }),
    );

    const reply = await new Promise<string>((resolve, reject) => {
      const s = netConnect({ host: "127.0.0.1", port });
      s.on("connect", () => s.write("CONNECT x:443 HTTP/1.1\r\nHost: x\r\n\r\n"));
      const chunks: Buffer[] = [];
      s.on("data", (c: Buffer) => chunks.push(c));
      s.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      s.on("error", reject);
    });

    expect(reply).toMatch(/^HTTP\/1\.1 501/);
  });
});

describe("createReverseProxy (HTTPS upstream)", () => {
  let storeDir: string;
  let certStore: CertStore;
  let upstreamCert: string;
  let upstreamKey: string;
  const closers: (() => Promise<void>)[] = [];

  beforeAll(() => {
    storeDir = mkdtempSync(join(tmpdir(), "flapwire-reverse-https-"));
    certStore = createCertStore({ dir: storeDir });
    const ss = selfSigned("127.0.0.1");
    upstreamCert = ss.cert;
    upstreamKey = ss.key;
  });

  afterAll(() => {
    rmSync(storeDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    for (const close of closers) await close();
    closers.length = 0;
  });

  it("forwards to an https:// upstream when target uses the https scheme", async () => {
    const upstream = createHttpsServer({ cert: upstreamCert, key: upstreamKey }, (req, res) => {
      const body = `via=${req.headers.host},path=${req.url}`;
      res.writeHead(200, {
        "Content-Type": "text/plain",
        "Content-Length": Buffer.byteLength(body),
      });
      res.end(body);
    });
    const upstreamPort = await new Promise<number>((resolve) => {
      upstream.listen(0, "127.0.0.1", () => resolve((upstream.address() as AddressInfo).port));
    });
    closers.push(
      () =>
        new Promise<void>((r) => {
          upstream.closeAllConnections();
          upstream.close(() => r());
        }),
    );

    const proxy = createReverseProxy(
      {},
      { target: `https://127.0.0.1:${upstreamPort}`, upstreamCa: upstreamCert },
    );
    const proxyPort = await new Promise<number>((resolve) => {
      proxy.listen(0, "127.0.0.1", () => resolve((proxy.address() as AddressInfo).port));
    });
    closers.push(
      () =>
        new Promise<void>((r) => {
          proxy.closeAllConnections();
          proxy.close(() => r());
        }),
    );

    const r = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = require("node:http").request(
        { host: "127.0.0.1", port: proxyPort, method: "GET", path: "/x" },
        async (res: import("node:http").IncomingMessage) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () =>
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
          );
        },
      );
      req.on("error", reject);
      req.end();
    });

    // avoid unused warnings / ensure the cert store is live via its presence in the scope
    void certStore;

    expect(r.status).toBe(200);
    expect(r.body).toContain("path=/x");
    expect(r.body).toContain(`127.0.0.1:${upstreamPort}`);
  });
});
