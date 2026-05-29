// Failure-injection rules. A rule says "when a request looks like X, respond
// with Y instead of forwarding to the upstream". The action is either an HTTP
// status code (respond immediately with it) or `timeout: true` (hold the
// socket open and never reply — the client times itself out).
//
// Rules are matched in order; the first hit wins. Sampling lets you say
// things like "fail 10% of POSTs to /api/checkout" — useful for surfacing
// retry-handling bugs without breaking the happy path entirely.

export interface FailureRule {
  // Regex source matched against the request path. Case-insensitive. Omitted
  // means "match any path".
  path?: string;
  // Upper-cased HTTP method. Omitted means "match any method".
  method?: string;
  // Probability of firing on a matching request (0-1). Omitted = 1.
  sample?: number;
  // Action: respond with this HTTP status. Mutually exclusive with `timeout`.
  status?: number;
  // Action: never respond. Client will time itself out. Mutex with `status`.
  timeout?: boolean;
}

// Parsed rule with a precompiled regex — keeps the hot path off the parser.
export interface CompiledRule {
  rule: FailureRule;
  methodUpper?: string;
  pathRe?: RegExp;
}

export function compileRules(rules: FailureRule[]): CompiledRule[] {
  return rules.map((r) => ({
    rule: r,
    methodUpper: r.method ? r.method.toUpperCase() : undefined,
    pathRe: r.path ? new RegExp(r.path, "i") : undefined,
  }));
}

// Parses a raw value (e.g. from YAML or admin POST body) into validated rules.
// Throws with a field-qualified message on the first problem.
export function parseRules(raw: unknown): FailureRule[] {
  if (!Array.isArray(raw)) {
    throw new Error("`failures` must be a list");
  }
  return raw.map((entry, i) => parseRule(entry, i));
}

function parseRule(raw: unknown, idx: number): FailureRule {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`failures[${idx}] must be a mapping`);
  }
  const r = raw as Record<string, unknown>;
  const out: FailureRule = {};

  if ("path" in r) {
    if (typeof r.path !== "string") throw new Error(`failures[${idx}].path must be a string`);
    try {
      new RegExp(r.path);
    } catch (err) {
      throw new Error(`failures[${idx}].path is not a valid regex: ${(err as Error).message}`);
    }
    out.path = r.path;
  }
  if ("method" in r) {
    if (typeof r.method !== "string") throw new Error(`failures[${idx}].method must be a string`);
    out.method = r.method;
  }
  if ("sample" in r) {
    const s = r.sample;
    if (typeof s !== "number" || !Number.isFinite(s) || s < 0 || s > 1) {
      throw new Error(`failures[${idx}].sample must be a number between 0 and 1`);
    }
    out.sample = s;
  }
  if ("status" in r) {
    const s = r.status;
    if (typeof s !== "number" || !Number.isInteger(s) || s < 100 || s > 599) {
      throw new Error(`failures[${idx}].status must be an HTTP status integer (100-599)`);
    }
    out.status = s;
  }
  if ("timeout" in r) {
    if (typeof r.timeout !== "boolean") {
      throw new Error(`failures[${idx}].timeout must be a boolean`);
    }
    out.timeout = r.timeout;
  }

  // Action is required — a rule that matches but does nothing would be a
  // silent foot-gun. Exactly one of status / timeout must be set.
  const hasStatus = out.status !== undefined;
  const hasTimeout = out.timeout === true;
  if (!hasStatus && !hasTimeout) {
    throw new Error(`failures[${idx}] must set either \`status\` or \`timeout: true\``);
  }
  if (hasStatus && hasTimeout) {
    throw new Error(`failures[${idx}] sets both \`status\` and \`timeout\` — pick one`);
  }

  return out;
}

export interface MatchedAction {
  status?: number;
  timeout?: boolean;
}

// Walks the compiled rules and returns the first match's action, or null if
// nothing matches. `random` is injected so tests are deterministic.
export function matchRule(
  rules: CompiledRule[],
  method: string,
  path: string,
  random: () => number,
): MatchedAction | null {
  for (const c of rules) {
    if (c.methodUpper && c.methodUpper !== method.toUpperCase()) continue;
    if (c.pathRe && !c.pathRe.test(path)) continue;
    const sample = c.rule.sample ?? 1;
    if (sample < 1 && random() >= sample) continue;
    return { status: c.rule.status, timeout: c.rule.timeout };
  }
  return null;
}
