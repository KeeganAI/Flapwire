export interface BlackoutConfig {
  everySeconds: number;
  durationSeconds: number;
}

export function isInBlackout(config: BlackoutConfig, elapsedMs: number): boolean {
  if (config.durationSeconds <= 0 || config.everySeconds <= 0) return false;
  if (config.durationSeconds >= config.everySeconds) return true;
  if (elapsedMs < 0) return false;
  const everyMs = config.everySeconds * 1000;
  const durationMs = config.durationSeconds * 1000;
  const phase = elapsedMs % everyMs;
  return phase >= everyMs - durationMs;
}
