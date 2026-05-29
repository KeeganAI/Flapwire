import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { type FailureRule, parseRules } from "./failures.js";

// One file describes everything Flapwire needs to start. Mirrors the existing
// CLI surface so a config is just "the same flags, persisted" — nothing more
// expressive yet. Admin/UI ports and failure-injection rules will land in
// later patches and extend this same schema.
export interface FlapwireConfig {
  profile?: string;
  port?: number;
  target?: string;
  routes?: ConfigRoute[];
  upstreamCa?: string;
  admin?: AdminConfig;
  failures?: FailureRule[];
}

// Admin API control plane. Off by default — turn it on by setting `port` (or
// passing `--admin-port`). Bound to 127.0.0.1 to keep the no-auth contract
// honest; future versions may add `host` here for trusted private networks.
export interface AdminConfig {
  port?: number;
}

export interface ConfigRoute {
  listen?: number;
  target: string;
}

export const DEFAULT_CONFIG_FILENAME = "flapwire.config.yaml";

// Loads from an explicit path when given, otherwise looks for
// `flapwire.config.yaml` in the cwd. Returns null when nothing is found, so
// the CLI can fall back to its previous behaviour without ceremony.
export function loadConfig(explicitPath?: string): FlapwireConfig | null {
  const path = explicitPath
    ? resolve(explicitPath)
    : resolve(process.cwd(), DEFAULT_CONFIG_FILENAME);
  if (!existsSync(path)) return explicitPath ? throwMissing(path) : null;
  const raw = readFileSync(path, "utf8");
  return parseConfig(raw);
}

function throwMissing(path: string): never {
  throw new Error(`config file not found: ${path}`);
}

// Parsing is its own export so tests don't need the filesystem.
export function parseConfig(yaml: string): FlapwireConfig {
  const doc = parseYaml(yaml);
  if (doc === null || doc === undefined) return {};
  if (typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error("config must be a YAML mapping at the top level");
  }
  const out: FlapwireConfig = {};
  const d = doc as Record<string, unknown>;

  if ("profile" in d) {
    if (typeof d.profile !== "string") throw new Error("`profile` must be a string");
    out.profile = d.profile;
  }
  if ("port" in d) {
    const n = d.port;
    if (typeof n !== "number" || !Number.isInteger(n) || n <= 0 || n > 65535) {
      throw new Error("`port` must be an integer between 1 and 65535");
    }
    out.port = n;
  }
  if ("target" in d) {
    if (typeof d.target !== "string") throw new Error("`target` must be a string");
    validateUpstreamUrl(d.target, "target");
    out.target = d.target;
  }
  if ("routes" in d) {
    if (!Array.isArray(d.routes)) throw new Error("`routes` must be a list");
    out.routes = d.routes.map((r, i) => parseRouteEntry(r, i));
  }
  if ("upstreamCa" in d) {
    if (typeof d.upstreamCa !== "string") throw new Error("`upstreamCa` must be a string");
    out.upstreamCa = d.upstreamCa;
  }
  if ("failures" in d) {
    out.failures = parseRules(d.failures);
  }
  if ("admin" in d) {
    if (d.admin === null || typeof d.admin !== "object" || Array.isArray(d.admin)) {
      throw new Error("`admin` must be a mapping");
    }
    const a = d.admin as Record<string, unknown>;
    const adminCfg: AdminConfig = {};
    if ("port" in a) {
      const n = a.port;
      if (typeof n !== "number" || !Number.isInteger(n) || n <= 0 || n > 65535) {
        throw new Error("`admin.port` must be an integer between 1 and 65535");
      }
      adminCfg.port = n;
    }
    out.admin = adminCfg;
  }

  if (out.target && out.routes && out.routes.length > 0) {
    throw new Error("config sets both `target` and `routes` — pick one");
  }

  return out;
}

function parseRouteEntry(raw: unknown, idx: number): ConfigRoute {
  if (raw === null || typeof raw !== "object") {
    throw new Error(`routes[${idx}] must be a mapping`);
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.target !== "string") {
    throw new Error(`routes[${idx}].target must be a string`);
  }
  validateUpstreamUrl(r.target, `routes[${idx}].target`);
  const route: ConfigRoute = { target: r.target };
  if ("listen" in r) {
    const n = r.listen;
    if (typeof n !== "number" || !Number.isInteger(n) || n <= 0 || n > 65535) {
      throw new Error(`routes[${idx}].listen must be an integer between 1 and 65535`);
    }
    route.listen = n;
  }
  return route;
}

function validateUpstreamUrl(value: string, field: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${field} is not a valid URL: ${value}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${field} must be http:// or https://, got ${url.protocol}`);
  }
}

// Merges CLI-provided overrides on top of a base config. Anything explicitly
// passed on the command line wins; missing CLI values keep whatever the file
// had. The result is what the CLI runs with.
export function mergeOverrides(
  base: FlapwireConfig | null,
  overrides: Partial<FlapwireConfig>,
): FlapwireConfig {
  const b: FlapwireConfig = base ?? {};
  const out: FlapwireConfig = { ...b };
  if (overrides.profile !== undefined) out.profile = overrides.profile;
  if (overrides.port !== undefined) out.port = overrides.port;
  if (overrides.target !== undefined) out.target = overrides.target;
  if (overrides.routes !== undefined && overrides.routes.length > 0) {
    out.routes = overrides.routes;
    out.target = undefined;
  }
  if (overrides.upstreamCa !== undefined) out.upstreamCa = overrides.upstreamCa;
  if (overrides.admin !== undefined) out.admin = { ...out.admin, ...overrides.admin };
  if (overrides.failures !== undefined) out.failures = overrides.failures;
  return out;
}
