export interface LatencyConfig {
  baseMs: number;
  jitterMs: number;
}

export function sampleLatencyMs(config: LatencyConfig, random: () => number = Math.random): number {
  const u1 = Math.max(random(), Number.MIN_VALUE);
  const u2 = random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const offset = z * config.jitterMs;
  return Math.max(0, config.baseMs + offset);
}
