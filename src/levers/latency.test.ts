import { describe, expect, it } from "vitest";
import { sampleLatencyMs } from "./latency.js";

describe("sampleLatencyMs", () => {
  it("returns base delay when jitter is zero", () => {
    expect(sampleLatencyMs({ baseMs: 200, jitterMs: 0 }, () => 0.5)).toBe(200);
  });

  it("adds positive jitter when random source returns 1", () => {
    expect(sampleLatencyMs({ baseMs: 100, jitterMs: 50 }, () => 1)).toBe(150);
  });

  it("subtracts jitter when random source returns 0", () => {
    expect(sampleLatencyMs({ baseMs: 100, jitterMs: 50 }, () => 0)).toBe(50);
  });

  it("clamps to zero when base plus negative jitter would go below", () => {
    expect(sampleLatencyMs({ baseMs: 10, jitterMs: 100 }, () => 0)).toBe(0);
  });
});
