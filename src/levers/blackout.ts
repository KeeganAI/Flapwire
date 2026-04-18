export interface BlackoutConfig {
  everySeconds: number;
  durationSeconds: number;
}

// True when we're inside a blackout window. Blackouts land at the *end* of each
// cycle: for the last `durationSeconds` of every `everySeconds`, we're out.
// Starting each cycle in the clear means the process starts in a working state
// rather than immediately black, which is easier to reason about when testing.
export function isInBlackout(config: BlackoutConfig, elapsedMs: number): boolean {
  if (config.durationSeconds <= 0 || config.everySeconds <= 0) return false;
  // Misconfiguration: duration ≥ cycle means "always blacked out". Honour it
  // rather than silently ignoring — if someone sets that, they meant it.
  if (config.durationSeconds >= config.everySeconds) return true;
  if (elapsedMs < 0) return false;
  const everyMs = config.everySeconds * 1000;
  const durationMs = config.durationSeconds * 1000;
  const phase = elapsedMs % everyMs;
  return phase >= everyMs - durationMs;
}
