import { type BlackoutConfig, isInBlackout } from "./levers/blackout.js";
import type { ProxyProfile } from "./proxy.js";

// Holds the live, mutable state of a running proxy. The static profile passed
// at startup is just the *initial* value — the admin API can switch profiles,
// force a blackout window, or queue a one-shot failure on top of it.
//
// Read operations are O(1) and called on every request, so the implementation
// stays plain field reads. No event emitters: the proxy reads through the
// state on each request, no subscription needed.
export interface PendingFailure {
  status: number;
  remaining: number;
}

export class ProxyState {
  private profile: ProxyProfile;
  // Epoch ms when a manually-forced blackout ends. Zero (or past) means none.
  private forcedBlackoutUntilMs = 0;
  private failure: PendingFailure | null = null;

  constructor(initial: ProxyProfile) {
    this.profile = initial;
  }

  getProfile(): ProxyProfile {
    return this.profile;
  }

  setProfile(next: ProxyProfile): void {
    this.profile = next;
  }

  // True when either the profile's normal blackout cycle is active OR the
  // admin API has forced one. The reaper and per-request handler both go
  // through here so they stay in sync.
  isInBlackout(elapsedMs: number, nowMs: number): boolean {
    if (this.forcedBlackoutUntilMs > nowMs) return true;
    const cfg = this.profile.blackout;
    if (!cfg) return false;
    return isInBlackout(cfg, elapsedMs);
  }

  forceBlackout(durationMs: number, nowMs: number): void {
    if (durationMs <= 0) {
      this.forcedBlackoutUntilMs = 0;
      return;
    }
    this.forcedBlackoutUntilMs = nowMs + durationMs;
  }

  // 0.2.3 will replace this with rule matching on path/method/sample. For now
  // it's a one-shot queue: queueFailure(503, 3) makes the next 3 requests
  // return 503 regardless of the profile.
  queueFailure(status: number, count: number): void {
    if (count <= 0) {
      this.failure = null;
      return;
    }
    this.failure = { status, remaining: count };
  }

  // Returns the next queued failure (and decrements the counter), or null.
  // Called from handle() before forwarding to upstream.
  consumeFailure(): PendingFailure | null {
    if (!this.failure) return null;
    const out = { status: this.failure.status, remaining: this.failure.remaining };
    this.failure.remaining -= 1;
    if (this.failure.remaining <= 0) this.failure = null;
    return out;
  }

  snapshot(): {
    profile: ProxyProfile;
    forcedBlackoutMsRemaining: number;
    pendingFailure: PendingFailure | null;
  } {
    const now = Date.now();
    return {
      profile: this.profile,
      forcedBlackoutMsRemaining: Math.max(0, this.forcedBlackoutUntilMs - now),
      pendingFailure: this.failure ? { ...this.failure } : null,
    };
  }
}

// Convenience for callers that want a state without thinking about it.
export function makeState(profile: ProxyProfile): ProxyState {
  return new ProxyState(profile);
}

// Re-export so the admin module doesn't need to reach into levers/.
export type { BlackoutConfig };
