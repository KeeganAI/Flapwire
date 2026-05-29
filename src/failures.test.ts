import { describe, expect, it } from "vitest";
import { compileRules, matchRule, parseRules } from "./failures.js";

describe("parseRules", () => {
  it("returns an empty list for an empty input", () => {
    expect(parseRules([])).toEqual([]);
  });

  it("parses a status rule with path and method", () => {
    const rules = parseRules([{ path: "^/api", method: "POST", status: 503 }]);
    expect(rules).toEqual([{ path: "^/api", method: "POST", status: 503 }]);
  });

  it("parses a timeout rule", () => {
    expect(parseRules([{ path: "^/slow", timeout: true }])).toEqual([
      { path: "^/slow", timeout: true },
    ]);
  });

  it("parses a sample-only rule with status", () => {
    expect(parseRules([{ sample: 0.5, status: 504 }])).toEqual([{ sample: 0.5, status: 504 }]);
  });

  it("rejects a rule with neither status nor timeout", () => {
    expect(() => parseRules([{ path: "^/x" }])).toThrow(/status.*timeout/);
  });

  it("rejects a rule with both status and timeout", () => {
    expect(() => parseRules([{ path: "^/x", status: 503, timeout: true }])).toThrow(/pick one/);
  });

  it("rejects invalid status codes", () => {
    expect(() => parseRules([{ status: 99 }])).toThrow(/status/);
    expect(() => parseRules([{ status: 600 }])).toThrow(/status/);
  });

  it("rejects samples outside 0..1", () => {
    expect(() => parseRules([{ sample: -0.1, status: 503 }])).toThrow(/sample/);
    expect(() => parseRules([{ sample: 1.5, status: 503 }])).toThrow(/sample/);
  });

  it("rejects an invalid regex in path", () => {
    expect(() => parseRules([{ path: "([", status: 503 }])).toThrow(/regex/);
  });

  it("rejects non-list input", () => {
    expect(() => parseRules({})).toThrow(/list/);
  });
});

describe("matchRule", () => {
  it("returns null when no rule matches", () => {
    const rules = compileRules([{ path: "^/api", status: 503 }]);
    expect(matchRule(rules, "GET", "/home", () => 0)).toBeNull();
  });

  it("matches on path regex", () => {
    const rules = compileRules([{ path: "^/api/checkout", status: 503 }]);
    expect(matchRule(rules, "GET", "/api/checkout/start", () => 0)).toEqual({
      status: 503,
      timeout: undefined,
    });
  });

  it("matches case-insensitively on path", () => {
    const rules = compileRules([{ path: "^/API", status: 503 }]);
    expect(matchRule(rules, "GET", "/api/foo", () => 0)).not.toBeNull();
  });

  it("requires the method to match when specified", () => {
    const rules = compileRules([{ path: "^/api", method: "POST", status: 503 }]);
    expect(matchRule(rules, "GET", "/api/x", () => 0)).toBeNull();
    expect(matchRule(rules, "POST", "/api/x", () => 0)).toEqual({
      status: 503,
      timeout: undefined,
    });
  });

  it("honours the sample probability via the random oracle", () => {
    const rules = compileRules([{ status: 503, sample: 0.5 }]);
    // sample=0.5 means "fire when random() < 0.5"
    expect(matchRule(rules, "GET", "/", () => 0.4)).not.toBeNull();
    expect(matchRule(rules, "GET", "/", () => 0.6)).toBeNull();
  });

  it("first matching rule wins — order matters", () => {
    const rules = compileRules([
      { path: "^/api", status: 503 },
      { path: "^/api/payments", status: 504 },
    ]);
    // The second rule is more specific but the first matches first.
    expect(matchRule(rules, "GET", "/api/payments", () => 0)).toEqual({
      status: 503,
      timeout: undefined,
    });
  });

  it("passes through the timeout action when set", () => {
    const rules = compileRules([{ path: "^/slow", timeout: true }]);
    expect(matchRule(rules, "GET", "/slow/me", () => 0)).toEqual({
      status: undefined,
      timeout: true,
    });
  });
});
