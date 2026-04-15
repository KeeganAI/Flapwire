import { describe, expect, it } from "vitest";
import { isInBlackout } from "./blackout.js";

describe("isInBlackout", () => {
  const cfg = { everySeconds: 60, durationSeconds: 4 };

  it("is false at the start of a cycle", () => {
    expect(isInBlackout(cfg, 0)).toBe(false);
  });

  it("is false during the open window before the blackout", () => {
    expect(isInBlackout(cfg, 55_000)).toBe(false);
  });

  it("is true during the last durationSeconds of each cycle", () => {
    expect(isInBlackout(cfg, 56_000)).toBe(true);
    expect(isInBlackout(cfg, 59_999)).toBe(true);
  });

  it("repeats on the next cycle", () => {
    expect(isInBlackout(cfg, 60_000)).toBe(false);
    expect(isInBlackout(cfg, 60_000 + 56_000)).toBe(true);
  });

  it("is always false when duration is zero or negative", () => {
    expect(isInBlackout({ everySeconds: 60, durationSeconds: 0 }, 59_000)).toBe(false);
    expect(isInBlackout({ everySeconds: 60, durationSeconds: -1 }, 59_000)).toBe(false);
  });

  it("is always true when duration covers the whole cycle", () => {
    expect(isInBlackout({ everySeconds: 10, durationSeconds: 10 }, 3_000)).toBe(true);
    expect(isInBlackout({ everySeconds: 10, durationSeconds: 20 }, 3_000)).toBe(true);
  });

  it("treats negative elapsed as outside the blackout", () => {
    expect(isInBlackout(cfg, -1)).toBe(false);
  });
});
