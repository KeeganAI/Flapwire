import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { parseRules } from "./failures.js";
import { getProfile } from "./profiles.js";
import type { ProxyState } from "./state.js";

// Tiny HTTP control plane the user can curl at, and (later) the v0.3 UI will
// talk to. Lives on its own port — never multiplexed with the proxy itself —
// so requests through the proxy can never hit /admin by accident.
//
// Endpoints, JSON in and out:
//   GET  /admin/status   → { bindings: [{ label, profile, ... }] }
//   POST /admin/profile  → { name: "fast-3g" }            switches profile
//   POST /admin/blackout → { durationSeconds: 5 }         forces a blackout
//   POST /admin/fail     → { status: 503, count: 3 }      queues N failures
//   GET  /admin/failures → { rules: [...] }                returns current rules
//   POST /admin/failures → { rules: [...] }                replaces rule list
//
// Mutations are fan-out: every binding gets the same change. That keeps
// multi-route setups behaving as one logical proxy.
//
// No auth — this is meant for localhost. The CLI binds it to 127.0.0.1.

export interface AdminBinding {
  // Human-readable label for /admin/status (e.g. the upstream URL).
  label: string;
  state: ProxyState;
}

export interface AdminOptions {
  bindings: AdminBinding[];
  now?: () => number;
}

export function createAdminServer(options: AdminOptions): Server {
  const now = options.now ?? Date.now;
  const bindings = options.bindings;

  return createServer(async (req, res) => {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";

    if (method === "GET" && url === "/admin/status") {
      return jsonOk(res, {
        bindings: bindings.map((b) => ({ label: b.label, ...b.state.snapshot() })),
      });
    }

    if (method === "POST" && url === "/admin/profile") {
      const body = await readJson(req).catch((e) => e as Error);
      if (body instanceof Error) return jsonError(res, 400, body.message);
      const name = (body as { name?: unknown }).name;
      if (typeof name !== "string" || name.length === 0) {
        return jsonError(res, 400, "expected JSON body { name: string }");
      }
      let profile: ReturnType<typeof getProfile>;
      try {
        profile = getProfile(name);
      } catch (err) {
        return jsonError(res, 400, (err as Error).message);
      }
      for (const b of bindings) b.state.setProfile(profile);
      return jsonOk(res, { profile: name, applied: bindings.length });
    }

    if (method === "POST" && url === "/admin/blackout") {
      const body = await readJson(req).catch((e) => e as Error);
      if (body instanceof Error) return jsonError(res, 400, body.message);
      const seconds = (body as { durationSeconds?: unknown }).durationSeconds;
      if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
        return jsonError(res, 400, "durationSeconds must be a non-negative number");
      }
      const nowMs = now();
      for (const b of bindings) b.state.forceBlackout(seconds * 1000, nowMs);
      return jsonOk(res, { forcedBlackoutSeconds: seconds, applied: bindings.length });
    }

    if (method === "POST" && url === "/admin/fail") {
      const body = await readJson(req).catch((e) => e as Error);
      if (body instanceof Error) return jsonError(res, 400, body.message);
      const status = (body as { status?: unknown }).status ?? 503;
      const count = (body as { count?: unknown }).count ?? 1;
      if (typeof status !== "number" || !Number.isInteger(status) || status < 100 || status > 599) {
        return jsonError(res, 400, "status must be an HTTP status integer (100-599)");
      }
      if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
        return jsonError(res, 400, "count must be a non-negative integer");
      }
      for (const b of bindings) b.state.queueFailure(status, count);
      return jsonOk(res, { status, count, applied: bindings.length });
    }

    if (method === "GET" && url === "/admin/failures") {
      // First binding's rules are authoritative — they're kept in sync by the
      // POST handler below, so any binding's view is the same as any other's.
      const rules = bindings[0]?.state.getRules() ?? [];
      return jsonOk(res, { rules });
    }

    if (method === "POST" && url === "/admin/failures") {
      const body = await readJson(req).catch((e) => e as Error);
      if (body instanceof Error) return jsonError(res, 400, body.message);
      const raw = (body as { rules?: unknown }).rules;
      try {
        const parsed = parseRules(raw);
        for (const b of bindings) b.state.setRules(parsed);
        return jsonOk(res, { rules: parsed, applied: bindings.length });
      } catch (err) {
        return jsonError(res, 400, (err as Error).message);
      }
    }

    return jsonError(res, 404, `unknown admin route: ${method} ${url}`);
  });
}

function jsonOk(res: ServerResponse, body: unknown): void {
  const payload = `${JSON.stringify(body)}\n`;
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function jsonError(res: ServerResponse, status: number, message: string): void {
  const payload = `${JSON.stringify({ error: message })}\n`;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

// Reads the whole request body (small admin payloads, no streaming) and parses
// as JSON. 64KB cap because there's no reason for an admin call to be larger
// and an unbounded read is just an attack surface.
function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const MAX = 64 * 1024;
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > MAX) {
        reject(new Error("admin request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.length === 0) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          return reject(new Error("admin request body must be a JSON object"));
        }
        resolve(parsed as Record<string, unknown>);
      } catch (err) {
        reject(new Error(`invalid JSON: ${(err as Error).message}`));
      }
    });
    req.on("error", reject);
  });
}
