import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createAdminServer } from "./admin.js";
import { ProxyState } from "./state.js";

interface AdminResponse {
  status: number;
  body: unknown;
}

function call(port: number, method: string, path: string, body?: unknown): Promise<AdminResponse> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: payload
          ? { "Content-Type": "application/json", "Content-Length": payload.length }
          : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let parsed: unknown = raw;
          try {
            parsed = JSON.parse(raw);
          } catch {}
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe("admin server", () => {
  const closers: (() => Promise<void>)[] = [];

  afterEach(async () => {
    for (const close of closers) await close();
    closers.length = 0;
  });

  async function start(state: ProxyState, now?: () => number): Promise<number> {
    const server = createAdminServer({ bindings: [{ label: "test", state }], now });
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

  it("GET /admin/status returns one entry per binding", async () => {
    const state = new ProxyState({});
    const port = await start(state);
    const r = await call(port, "GET", "/admin/status");
    expect(r.status).toBe(200);
    const body = r.body as {
      bindings: Array<{ label: string; forcedBlackoutMsRemaining: number }>;
    };
    expect(body.bindings).toHaveLength(1);
    expect(body.bindings[0]).toMatchObject({ label: "test", forcedBlackoutMsRemaining: 0 });
  });

  it("POST /admin/profile switches the live profile when the name is known", async () => {
    const state = new ProxyState({});
    const port = await start(state);
    const r = await call(port, "POST", "/admin/profile", { name: "fast-3g" });
    expect(r.status).toBe(200);
    expect(state.getProfile().latency?.baseMs).toBe(100);
  });

  it("POST /admin/profile rejects an unknown profile with 400", async () => {
    const state = new ProxyState({});
    const port = await start(state);
    const r = await call(port, "POST", "/admin/profile", { name: "bogus" });
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toMatch(/bogus/);
  });

  it("POST /admin/profile rejects a missing name with 400", async () => {
    const state = new ProxyState({});
    const port = await start(state);
    const r = await call(port, "POST", "/admin/profile", {});
    expect(r.status).toBe(400);
  });

  it("POST /admin/blackout forces a blackout window for the given seconds", async () => {
    const state = new ProxyState({});
    const clock = 1_000_000;
    const port = await start(state, () => clock);
    const r = await call(port, "POST", "/admin/blackout", { durationSeconds: 5 });
    expect(r.status).toBe(200);
    expect(state.isInBlackout(0, clock)).toBe(true);
    expect(state.isInBlackout(0, clock + 4_999)).toBe(true);
    expect(state.isInBlackout(0, clock + 5_001)).toBe(false);
  });

  it("POST /admin/blackout with a non-number is a 400", async () => {
    const state = new ProxyState({});
    const port = await start(state);
    const r = await call(port, "POST", "/admin/blackout", { durationSeconds: "soon" });
    expect(r.status).toBe(400);
  });

  it("POST /admin/fail queues N future failures with the given status", async () => {
    const state = new ProxyState({});
    const port = await start(state);
    const r = await call(port, "POST", "/admin/fail", { status: 503, count: 2 });
    expect(r.status).toBe(200);
    expect(state.consumeFailure()).toEqual({ status: 503, remaining: 2 });
    expect(state.consumeFailure()).toEqual({ status: 503, remaining: 1 });
    expect(state.consumeFailure()).toBeNull();
  });

  it("POST /admin/fail rejects a status outside the HTTP range", async () => {
    const state = new ProxyState({});
    const port = await start(state);
    const r = await call(port, "POST", "/admin/fail", { status: 99, count: 1 });
    expect(r.status).toBe(400);
  });

  it("unknown routes return 404 JSON", async () => {
    const state = new ProxyState({});
    const port = await start(state);
    const r = await call(port, "GET", "/admin/nothing");
    expect(r.status).toBe(404);
    expect((r.body as { error: string }).error).toMatch(/unknown admin route/);
  });
});
