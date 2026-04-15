export interface LossConfig {
  connectionDropRate: number;
}

export function shouldDropConnection(
  config: LossConfig,
  random: () => number = Math.random,
): boolean {
  return random() < config.connectionDropRate;
}
