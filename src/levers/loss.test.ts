import { describe, expect, it } from "vitest";
import { shouldDropConnection } from "./loss.js";

describe("shouldDropConnection", () => {
  it("never drops when rate is zero", () => {
    expect(shouldDropConnection({ connectionDropRate: 0 }, () => 0)).toBe(false);
  });

  it("always drops when rate is one", () => {
    expect(shouldDropConnection({ connectionDropRate: 1 }, () => 0.999)).toBe(true);
  });

  it("does not drop when random equals the rate exactly (strict <)", () => {
    expect(shouldDropConnection({ connectionDropRate: 0.5 }, () => 0.5)).toBe(false);
  });
});
