#!/usr/bin/env node
import type { Server } from "node:http";
import { Command } from "commander";
import pc from "picocolors";
import { deriveConventionalPort, listenPreferred } from "./ports.js";
import { PROFILE_NAMES, getProfile } from "./profiles.js";
import { type ProxyProfile, type RequestLog, createProxy, createReverseProxy } from "./proxy.js";

function colorForStatus(status: number | undefined): (s: string) => string {
  if (status === undefined) return pc.red;
  if (status >= 500) return pc.red;
  if (status >= 400) return pc.yellow;
  if (status >= 300) return pc.cyan;
  return pc.green;
}

function formatLog(entry: RequestLog, tag?: string): string {
  const prefix = tag ? `${pc.dim(`[${tag}]`)} ` : "";
  const method = pc.bold(entry.method);
  const url = entry.url;
  if (entry.outcome === "drop") {
    return `${prefix}${method} ${url} ${pc.red("→ drop")}`;
  }
  if (entry.outcome === "blackout") {
    const timing = pc.dim(`(${Math.round(entry.appliedLatencyMs)}ms)`);
    return `${prefix}${method} ${url} ${pc.red("→ 504 blackout")} ${timing}`;
  }
  const arrow = colorForStatus(entry.status)(`→ ${entry.status ?? "???"}`);
  const timing = pc.dim(`(${Math.round(entry.appliedLatencyMs)}ms)`);
  return `${prefix}${method} ${url} ${arrow} ${timing}`;
}

interface ParsedRoute {
  listenPort: number | null;
  target: string;
  upstreamPort: number;
}

function parseRoute(raw: string): ParsedRoute {
  const eq = raw.indexOf("=");
  let listenSpec: string | null = null;
  let target: string;
  if (eq === -1) {
    target = raw;
  } else {
    listenSpec = raw.slice(0, eq);
    target = raw.slice(eq + 1);
  }
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new Error(`invalid route target: ${raw}`);
  }
  if (url.protocol !== "http:") {
    throw new Error(`route target must be http://, got ${url.protocol}: ${raw}`);
  }
  const upstreamPort = url.port ? Number(url.port) : 80;
  let listenPort: number | null = null;
  if (listenSpec !== null && listenSpec !== "auto") {
    const n = Number(listenSpec);
    if (!Number.isInteger(n) || n <= 0 || n > 65535) {
      throw new Error(`invalid listen port in route: ${raw}`);
    }
    listenPort = n;
  }
  return { listenPort, target, upstreamPort };
}

function printProfileBanner(name: string, profile: ProxyProfile): void {
  console.log(pc.dim(`profile: ${pc.bold(name)}`));
  if (profile.latency) {
    console.log(pc.dim(`  latency: ${profile.latency.baseMs}ms ± ${profile.latency.jitterMs}ms`));
  }
  if (profile.loss) {
    console.log(pc.dim(`  drop rate: ${(profile.loss.connectionDropRate * 100).toFixed(2)}%`));
  }
  if (profile.blackout) {
    console.log(
      pc.dim(
        `  blackout: ${profile.blackout.durationSeconds}s every ${profile.blackout.everySeconds}s`,
      ),
    );
  }
}

async function runForward(profile: ProxyProfile, profileName: string, port: number): Promise<void> {
  const server = createProxy(profile, { log: (e) => console.log(formatLog(e)) });
  await new Promise<void>((r) => server.listen(port, () => r()));
  console.log(pc.dim(`flapwire listening on http://127.0.0.1:${port} (forward proxy)`));
  printProfileBanner(profileName, profile);
  console.log(pc.dim("use as an HTTP proxy, e.g.:"));
  console.log(pc.dim(`  curl -x http://127.0.0.1:${port} http://example.com/`));
  registerShutdown([server]);
}

async function runReverseSingle(
  profile: ProxyProfile,
  profileName: string,
  target: string,
  explicitPort: number | null,
): Promise<void> {
  const targetUrl = new URL(target);
  const upstreamPort = targetUrl.port ? Number(targetUrl.port) : 80;
  const preferred = explicitPort ?? deriveConventionalPort(upstreamPort);
  const server = createReverseProxy(profile, {
    target,
    log: (e) => console.log(formatLog(e)),
  });
  const { port, fallback } = await listenPreferred(server, preferred);
  console.log(pc.dim(`flapwire listening on http://127.0.0.1:${port} → ${target} (reverse proxy)`));
  if (fallback && preferred !== null && preferred !== port) {
    console.log(
      pc.yellow(`  note: preferred port ${preferred} was unavailable, fell back to ${port}`),
    );
  }
  printProfileBanner(profileName, profile);
  registerShutdown([server]);
}

async function runReverseRoutes(
  profile: ProxyProfile,
  profileName: string,
  routes: ParsedRoute[],
): Promise<void> {
  const seen = new Set<number>();
  const servers: Server[] = [];
  const mappings: { listen: number; target: string }[] = [];
  for (const r of routes) {
    const preferred = r.listenPort ?? deriveConventionalPort(r.upstreamPort);
    const effectivePreferred = preferred !== null && seen.has(preferred) ? null : preferred;
    const tag = `${r.target}`;
    const server = createReverseProxy(profile, {
      target: r.target,
      log: (e) => console.log(formatLog(e, tag)),
    });
    const { port, fallback } = await listenPreferred(server, effectivePreferred);
    seen.add(port);
    servers.push(server);
    mappings.push({ listen: port, target: r.target });
    if (fallback && preferred !== null && preferred !== port) {
      console.log(
        pc.yellow(
          `  note: preferred port ${preferred} for ${r.target} was unavailable, using ${port}`,
        ),
      );
    }
  }
  console.log(
    pc.dim(
      `flapwire listening (reverse proxy, ${mappings.length} route${mappings.length === 1 ? "" : "s"}):`,
    ),
  );
  for (const m of mappings) {
    console.log(pc.dim(`  http://127.0.0.1:${m.listen} → ${m.target}`));
  }
  printProfileBanner(profileName, profile);
  registerShutdown(servers);
}

function registerShutdown(servers: Server[]): void {
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) process.exit(1);
    shuttingDown = true;
    let remaining = servers.length;
    if (remaining === 0) process.exit(0);
    for (const s of servers) {
      s.closeAllConnections();
      s.close(() => {
        remaining -= 1;
        if (remaining === 0) process.exit(0);
      });
    }
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const program = new Command();

program
  .name("flapwire")
  .description("Local HTTP proxy that degrades traffic for resilience testing.")
  .option("-p, --profile <name>", `network profile (${PROFILE_NAMES.join(", ")})`, "slow-3g")
  .option("--port <number>", "port to listen on (forward / single reverse)")
  .option("--target <url>", "single reverse-proxy upstream (http://host:port)")
  .option(
    "--route <mapping>",
    "reverse route: PORT=URL (repeatable)",
    (value: string, previous: string[] = []) => {
      previous.push(value);
      return previous;
    },
  )
  .action(async (opts: { profile: string; port?: string; target?: string; route?: string[] }) => {
    let profile: ProxyProfile;
    try {
      profile = getProfile(opts.profile);
    } catch (err) {
      console.error(pc.red((err as Error).message));
      process.exit(1);
    }

    const usingRoutes = (opts.route?.length ?? 0) > 0;
    const usingTarget = typeof opts.target === "string" && opts.target.length > 0;

    if (usingTarget && usingRoutes) {
      console.error(pc.red("use either --target or --route, not both"));
      process.exit(1);
    }

    try {
      if (usingRoutes) {
        const routes = (opts.route ?? []).map(parseRoute);
        await runReverseRoutes(profile, opts.profile, routes);
        return;
      }

      if (usingTarget) {
        const target = opts.target as string;
        let explicitPort: number | null = null;
        if (opts.port && opts.port !== "auto") {
          const n = Number.parseInt(opts.port, 10);
          if (!Number.isFinite(n) || n <= 0 || n > 65535) {
            console.error(pc.red(`invalid port: ${opts.port}`));
            process.exit(1);
          }
          explicitPort = n;
        }
        // validate target
        try {
          const u = new URL(target);
          if (u.protocol !== "http:") {
            console.error(pc.red(`--target must be http://, got ${u.protocol}`));
            process.exit(1);
          }
        } catch {
          console.error(pc.red(`invalid --target URL: ${target}`));
          process.exit(1);
        }
        await runReverseSingle(profile, opts.profile, target, explicitPort);
        return;
      }

      // forward proxy (v0.1 behavior)
      const portRaw = opts.port || "8080";
      const port = Number.parseInt(portRaw, 10);
      if (!Number.isFinite(port) || port <= 0 || port > 65535) {
        console.error(pc.red(`invalid port: ${portRaw}`));
        process.exit(1);
      }
      await runForward(profile, opts.profile, port);
    } catch (err) {
      console.error(pc.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(pc.red(err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
