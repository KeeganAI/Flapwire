import type { ProxyProfile } from "./proxy.js";

export const PROFILES = {
  "fast-3g": {
    latency: { baseMs: 100, jitterMs: 50 },
    loss: { connectionDropRate: 0 },
  },
  "slow-3g": {
    latency: { baseMs: 400, jitterMs: 200 },
    loss: { connectionDropRate: 0.005 },
  },
  "flaky-wifi": {
    latency: { baseMs: 150, jitterMs: 300 },
    loss: { connectionDropRate: 0.02 },
  },
} as const satisfies Record<string, ProxyProfile>;

export type ProfileName = keyof typeof PROFILES;

export const PROFILE_NAMES = Object.keys(PROFILES) as ProfileName[];

export function getProfile(name: string): ProxyProfile {
  if (!(name in PROFILES)) {
    throw new Error(`unknown profile: ${name}. available: ${PROFILE_NAMES.join(", ")}`);
  }
  return PROFILES[name as ProfileName];
}
