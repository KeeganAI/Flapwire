import { describe, expect, it } from "vitest";
import { sampleLatencyMs } from "./latency.js";

function sequence(values: number[]): () => number {
  let i = 0;
  return () => values[i++] ?? 0;
}

describe("sampleLatencyMs", () => {
  it("returns base delay when jitter is zero", () => {
    expect(sampleLatencyMs({ baseMs: 200, jitterMs: 0 }, () => 0.5)).toBe(200);
  });

  it("returns base when Box-Muller produces z = 0 (cos(π/2) = 0)", () => {
    // u1 = 0.5 (nonzero), u2 = 0.25 -> cos(2π · 0.25) = cos(π/2) = 0 -> z = 0
    expect(sampleLatencyMs({ baseMs: 200, jitterMs: 50 }, sequence([0.5, 0.25]))).toBeCloseTo(
      200,
      6,
    );
  });

  it("adds +1σ when Box-Muller produces z = 1 (u1 = e^-0.5, u2 = 0)", () => {
    // sqrt(-2 · ln(e^-0.5)) · cos(0) = sqrt(1) · 1 = 1 -> offset = jitterMs
    expect(
      sampleLatencyMs({ baseMs: 100, jitterMs: 50 }, sequence([Math.exp(-0.5), 0])),
    ).toBeCloseTo(150, 6);
  });

  it("clamps to zero when a negative offset pushes base below zero", () => {
    // u1 = e^-0.5, u2 = 0.5 -> sqrt(1) · cos(π) = -1 -> offset = -100 -> base 10 + offset = -90 -> 0
    expect(sampleLatencyMs({ baseMs: 10, jitterMs: 100 }, sequence([Math.exp(-0.5), 0.5]))).toBe(0);
  });
});
