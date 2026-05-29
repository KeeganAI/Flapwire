import {
  type CompiledRule,
  type FailureRule,
  type MatchedAction,
  compileRules,
  matchRule,
} from "./failures.js";
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
  // Rule-based failure injection (0.2.3). Independent of the one-shot
  // `failure` field above: rules apply continuously, the one-shot is a manual
  // trigger from /admin/fail that runs out after N hits.
  private rules: FailureRule[] = [];
  private compiledRules: CompiledRule[] = [];

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

  setRules(rules: FailureRule[]): void {
    this.rules = rules;
    this.compiledRules = compileRules(rules);
  }

  getRules(): FailureRule[] {
    return this.rules;
  }

  // Walks the rules in declared order and returns the first match's action,
  // or null. `random` is the same RNG used for loss sampling, so tests can
  // pin both together.
  matchFailureRule(method: string, path: string, random: () => number): MatchedAction | null {
    if (this.compiledRules.length === 0) return null;
    return matchRule(this.compiledRules, method, path, random);
  }

  snapshot(): {
    profile: ProxyProfile;
    forcedBlackoutMsRemaining: number;
    pendingFailure: PendingFailure | null;
    rules: FailureRule[];
  } {
    const now = Date.now();
    return {
      profile: this.profile,
      forcedBlackoutMsRemaining: Math.max(0, this.forcedBlackoutUntilMs - now),
      pendingFailure: this.failure ? { ...this.failure } : null,
      rules: this.rules,
    };
  }
}

// Convenience for callers that want a state without thinking about it.
export function makeState(profile: ProxyProfile): ProxyState {
  return new ProxyState(profile);
}

// Re-export so the admin module doesn't need to reach into levers/.
export type { BlackoutConfig };
