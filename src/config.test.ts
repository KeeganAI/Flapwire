import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, mergeOverrides, parseConfig } from "./config.js";

describe("parseConfig", () => {
  it("returns an empty object for an empty document", () => {
    expect(parseConfig("")).toEqual({});
    expect(parseConfig("# only a comment\n")).toEqual({});
  });

  it("parses profile, port, target, upstreamCa", () => {
    const cfg = parseConfig(`
profile: flaky-wifi
port: 13000
target: http://localhost:3000
upstreamCa: /tmp/ca.pem
`);
    expect(cfg).toEqual({
      profile: "flaky-wifi",
      port: 13000,
      target: "http://localhost:3000",
      upstreamCa: "/tmp/ca.pem",
    });
  });

  it("parses a list of routes with optional listen ports", () => {
    const cfg = parseConfig(`
profile: train-wifi
routes:
  - listen: 13000
    target: http://localhost:3000
  - target: https://localhost:5173
`);
    expect(cfg.profile).toBe("train-wifi");
    expect(cfg.routes).toEqual([
      { listen: 13000, target: "http://localhost:3000" },
      { target: "https://localhost:5173" },
    ]);
  });

  it("rejects non-mapping documents", () => {
    expect(() => parseConfig("- a\n- b")).toThrow(/mapping/);
    expect(() => parseConfig("'just a string'")).toThrow(/mapping/);
  });

  it("rejects bad types on top-level fields", () => {
    expect(() => parseConfig("profile: 7")).toThrow(/profile/);
    expect(() => parseConfig("port: 70000")).toThrow(/port/);
    expect(() => parseConfig("port: -1")).toThrow(/port/);
    expect(() => parseConfig("target: 42")).toThrow(/target/);
  });

  it("rejects an unsupported scheme on target", () => {
    expect(() => parseConfig("target: ftp://x")).toThrow(/http:\/\/ or https:\/\//);
  });

  it("rejects routes that aren't a list", () => {
    expect(() => parseConfig("routes: not-a-list")).toThrow(/list/);
  });

  it("rejects route entries missing a target", () => {
    expect(() => parseConfig("routes:\n  - listen: 13000\n")).toThrow(/routes\[0\]\.target/);
  });

  it("parses admin.port", () => {
    const cfg = parseConfig("admin:\n  port: 17070\n");
    expect(cfg.admin).toEqual({ port: 17070 });
  });

  it("rejects admin that isn't a mapping", () => {
    expect(() => parseConfig("admin: 17070")).toThrow(/admin/);
  });

  it("rejects bad admin.port", () => {
    expect(() => parseConfig("admin:\n  port: 70000\n")).toThrow(/admin\.port/);
  });

  it("rejects mixing target and routes (the CLI rejects it too)", () => {
    expect(() =>
      parseConfig(`
target: http://localhost:3000
routes:
  - target: http://localhost:5173
`),
    ).toThrow(/both `target` and `routes`/);
  });
});

describe("loadConfig", () => {
  let workDir: string;
  let savedCwd: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "flapwire-config-"));
    savedCwd = process.cwd();
    process.chdir(workDir);
  });

  afterEach(() => {
    process.chdir(savedCwd);
    rmSync(workDir, { recursive: true, force: true });
  });

  it("returns null when no flapwire.config.yaml is in the cwd", () => {
    expect(loadConfig()).toBeNull();
  });

  it("reads flapwire.config.yaml from the cwd by default", () => {
    writeFileSync(join(workDir, "flapwire.config.yaml"), "profile: slow-3g\n");
    expect(loadConfig()).toEqual({ profile: "slow-3g" });
  });

  it("reads from an explicit path when given", () => {
    const path = join(workDir, "custom.yaml");
    writeFileSync(path, "profile: fast-3g\n");
    expect(loadConfig(path)).toEqual({ profile: "fast-3g" });
  });

  it("throws when an explicit path doesn't exist", () => {
    expect(() => loadConfig(join(workDir, "missing.yaml"))).toThrow(/not found/);
  });
});

describe("mergeOverrides", () => {
  it("returns the overrides when there's no base", () => {
    expect(mergeOverrides(null, { profile: "fast-3g" })).toEqual({ profile: "fast-3g" });
  });

  it("CLI overrides win field by field", () => {
    const base = { profile: "slow-3g", port: 8080, target: "http://a" };
    const merged = mergeOverrides(base, { profile: "fast-3g" });
    expect(merged).toEqual({ profile: "fast-3g", port: 8080, target: "http://a" });
  });

  it("explicit routes from the CLI clear a target from the file", () => {
    const base = { target: "http://a" };
    const merged = mergeOverrides(base, { routes: [{ target: "http://b" }] });
    expect(merged.target).toBeUndefined();
    expect(merged.routes).toEqual([{ target: "http://b" }]);
  });

  it("an empty routes override is treated as no override", () => {
    const base = { target: "http://a" };
    const merged = mergeOverrides(base, { routes: [] });
    expect(merged).toEqual({ target: "http://a" });
  });
});
