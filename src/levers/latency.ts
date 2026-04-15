export interface LatencyConfig {
  baseMs: number;
  jitterMs: number;
}

export function sampleLatencyMs(config: LatencyConfig, random: () => number = Math.random): number {
  const offset = (random() * 2 - 1) * config.jitterMs;
  return Math.max(0, config.baseMs + offset);
}
