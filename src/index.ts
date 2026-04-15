export {
  createProxy,
  type ProxyOptions,
  type ProxyProfile,
  type RequestLog,
  type RequestOutcome,
} from "./proxy.js";
export { type LatencyConfig, sampleLatencyMs } from "./levers/latency.js";
export { type LossConfig, shouldDropConnection } from "./levers/loss.js";
export { PROFILES, PROFILE_NAMES, type ProfileName, getProfile } from "./profiles.js";
