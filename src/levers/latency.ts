export interface LatencyConfig {
  baseMs: number;
  jitterMs: number;
}

// Draws a latency sample from a normal distribution centred on baseMs with
// standard deviation jitterMs, clamped to zero. Real network RTTs look more
// like a bell curve than a uniform "always ±200ms" window, so Box–Muller it is.
export function sampleLatencyMs(config: LatencyConfig, random: () => number = Math.random): number {
  // Box–Muller: feed it two uniform samples, get a standard-normal one out.
  // u1 is guarded against 0 because log(0) = -Infinity.
  const u1 = Math.max(random(), Number.MIN_VALUE);
  const u2 = random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const offset = z * config.jitterMs;
  return Math.max(0, config.baseMs + offset);
}
