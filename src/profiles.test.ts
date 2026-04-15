import { describe, expect, it } from "vitest";
import { getProfile } from "./profiles.js";

describe("getProfile", () => {
  it("returns the slow-3g profile by name", () => {
    const profile = getProfile("slow-3g");
    expect(profile.latency?.baseMs).toBeGreaterThan(0);
  });

  it("throws on an unknown profile name", () => {
    expect(() => getProfile("not-a-profile")).toThrow(/unknown profile/);
  });
});
