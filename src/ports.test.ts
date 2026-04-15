import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { deriveConventionalPort, listenPreferred } from "./ports.js";

describe("deriveConventionalPort", () => {
  it("prefixes a 1 for typical dev-server ports", () => {
    expect(deriveConventionalPort(3000)).toBe(13000);
    expect(deriveConventionalPort(5173)).toBe(15173);
    expect(deriveConventionalPort(8080)).toBe(18080);
  });

  it("returns null when the derived port would exceed the TCP range", () => {
    expect(deriveConventionalPort(60000)).toBe(null);
    expect(deriveConventionalPort(55536)).toBe(null);
  });

  it("returns null on invalid upstream ports", () => {
    expect(deriveConventionalPort(0)).toBe(null);
    expect(deriveConventionalPort(-1)).toBe(null);
    expect(deriveConventionalPort(70000)).toBe(null);
    expect(deriveConventionalPort(3.14)).toBe(null);
  });
});

describe("listenPreferred", () => {
  const closers: (() => Promise<void>)[] = [];

  afterEach(async () => {
    for (const c of closers) await c();
    closers.length = 0;
  });

  function track(server: ReturnType<typeof createServer>) {
    closers.push(() => new Promise<void>((r) => server.close(() => r())));
    return server;
  }

  it("binds to the preferred port when it is free", async () => {
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", () => r()));
    const freePort = (probe.address() as { port: number }).port;
    await new Promise<void>((r) => probe.close(() => r()));

    const s = track(createServer());
    const { port, fallback } = await listenPreferred(s, freePort);
    expect(port).toBe(freePort);
    expect(fallback).toBe(false);
  });

  it("falls back to a random port when the preferred one emits EADDRINUSE", async () => {
    const s = track(createServer());
    // Simulate an EADDRINUSE by emitting the error before the async listen resolves.
    const originalListen = s.listen.bind(s);
    let first = true;
    s.listen = ((...args: unknown[]) => {
      if (first) {
        first = false;
        queueMicrotask(() => {
          const err = new Error("address in use") as NodeJS.ErrnoException;
          err.code = "EADDRINUSE";
          s.emit("error", err);
        });
        return s;
      }
      return originalListen(...(args as Parameters<typeof originalListen>));
    }) as typeof s.listen;

    const result = await listenPreferred(s, 45321);
    expect(result.fallback).toBe(true);
    expect(result.port).toBeGreaterThan(0);
  });

  it("goes straight to a random port when preferred is null", async () => {
    const s = track(createServer());
    const result = await listenPreferred(s, null);
    expect(result.fallback).toBe(true);
    expect(result.port).toBeGreaterThan(0);
  });
});
