#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import type { Server } from "node:http";
import { Command } from "commander";
import pc from "picocolors";
import { type CertStore, createCertStore, loadCertStore } from "./cert.js";
import { type FlapwireConfig, loadConfig, mergeOverrides } from "./config.js";
import { deriveConventionalPort, listenPreferred } from "./ports.js";
import { PROFILE_NAMES, getProfile } from "./profiles.js";
import { type ProxyProfile, type RequestLog, createProxy, createReverseProxy } from "./proxy.js";
import { installTrust, uninstallTrust } from "./trust.js";

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
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`route target must be http:// or https://, got ${url.protocol}: ${raw}`);
  }
  const isHttps = url.protocol === "https:";
  const upstreamPort = url.port ? Number(url.port) : isHttps ? 443 : 80;
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

// HTTPS support is opt-in by existence: if the user has run `flapwire trust`
// (or we're writing the CA for the first time in that command), we have a
// store on disk and MITM is enabled. Without it, CONNECT still returns 501
// with a message pointing at the trust subcommand.
function maybeLoadCertStore(): CertStore | undefined {
  try {
    return loadCertStore() ?? undefined;
  } catch {
    return undefined;
  }
}

function httpsBanner(store: CertStore | undefined): void {
  if (store) {
    console.log(pc.dim(`  https: on (CA at ${store.caPath})`));
  } else {
    console.log(pc.dim("  https: off (run `flapwire trust` to enable)"));
  }
}

async function runForward(profile: ProxyProfile, profileName: string, port: number): Promise<void> {
  const certStore = maybeLoadCertStore();
  const server = createProxy(profile, { log: (e) => console.log(formatLog(e)), certStore });
  await new Promise<void>((r) => server.listen(port, () => r()));
  console.log(pc.dim(`flapwire listening on http://127.0.0.1:${port} (forward proxy)`));
  printProfileBanner(profileName, profile);
  httpsBanner(certStore);
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
  const isHttps = targetUrl.protocol === "https:";
  const upstreamPort = targetUrl.port ? Number(targetUrl.port) : isHttps ? 443 : 80;
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
    // Second Ctrl+C bails immediately — users shouldn't have to guess whether
    // the first one was heard.
    if (shuttingDown) process.exit(1);
    shuttingDown = true;
    let remaining = servers.length;
    if (remaining === 0) process.exit(0);
    for (const s of servers) {
      // close() on its own waits for HTTP keep-alive sockets (every browser
      // will have some) to drain. closeAllConnections() forces them shut now.
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
  .description("Local HTTP/HTTPS proxy that degrades traffic for resilience testing.")
  .option("-p, --profile <name>", `network profile (${PROFILE_NAMES.join(", ")})`)
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
  .option(
    "-c, --config <path>",
    "path to flapwire.config.yaml (default: ./flapwire.config.yaml if present)",
  )
  .action(
    async (opts: {
      profile?: string;
      port?: string;
      target?: string;
      route?: string[];
      config?: string;
    }) => {
      // Load config first (file is the source of truth), then layer CLI flags
      // on top so explicit invocation always wins.
      let fileConfig: FlapwireConfig | null;
      try {
        fileConfig = loadConfig(opts.config);
      } catch (err) {
        console.error(pc.red((err as Error).message));
        process.exit(1);
      }

      const cliPort = parsePortOption(opts.port);
      const cliRoutes = (opts.route ?? []).map(parseRoute).map((r) => ({
        target: r.target,
        ...(r.listenPort !== null ? { listen: r.listenPort } : {}),
      }));
      const cliOverrides: Partial<FlapwireConfig> = {
        ...(opts.profile ? { profile: opts.profile } : {}),
        ...(cliPort !== null ? { port: cliPort } : {}),
        ...(opts.target ? { target: opts.target } : {}),
        ...(cliRoutes.length > 0 ? { routes: cliRoutes } : {}),
      };

      const cfg = mergeOverrides(fileConfig, cliOverrides);
      const profileName = cfg.profile ?? "slow-3g";

      let profile: ProxyProfile;
      try {
        profile = getProfile(profileName);
      } catch (err) {
        console.error(pc.red((err as Error).message));
        process.exit(1);
      }

      const usingRoutes = (cfg.routes?.length ?? 0) > 0;
      const usingTarget = typeof cfg.target === "string" && cfg.target.length > 0;

      if (usingTarget && usingRoutes) {
        console.error(pc.red("use either --target / target or --route / routes, not both"));
        process.exit(1);
      }

      try {
        if (usingRoutes) {
          const routes: ParsedRoute[] = (cfg.routes ?? []).map((r) => ({
            listenPort: r.listen ?? null,
            target: r.target,
            upstreamPort: upstreamPortOf(r.target),
          }));
          await runReverseRoutes(profile, profileName, routes);
          return;
        }

        if (usingTarget) {
          const target = cfg.target as string;
          // Validate again — file values may have skipped CLI's URL check.
          try {
            const u = new URL(target);
            if (u.protocol !== "http:" && u.protocol !== "https:") {
              console.error(pc.red(`target must be http:// or https://, got ${u.protocol}`));
              process.exit(1);
            }
          } catch {
            console.error(pc.red(`invalid target URL: ${target}`));
            process.exit(1);
          }
          await runReverseSingle(profile, profileName, target, cfg.port ?? null);
          return;
        }

        // No routes, no target → forward proxy (v0.1 behavior).
        const port = cfg.port ?? 8080;
        if (!Number.isInteger(port) || port <= 0 || port > 65535) {
          console.error(pc.red(`invalid port: ${port}`));
          process.exit(1);
        }
        await runForward(profile, profileName, port);
      } catch (err) {
        console.error(pc.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    },
  );

function parsePortOption(raw: string | undefined): number | null {
  if (!raw || raw === "auto") return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0 || n > 65535) {
    throw new Error(`invalid port: ${raw}`);
  }
  return n;
}

function upstreamPortOf(target: string): number {
  const u = new URL(target);
  if (u.port) return Number(u.port);
  return u.protocol === "https:" ? 443 : 80;
}

// Re-runs the current flapwire invocation under sudo. Only called after we've
// already decided we need to — the runner detects that non-interactively.
// stdio inheritance lets sudo talk to the user's terminal for the password.
function reexecElevated(): number {
  const result = spawnSync("sudo", [process.execPath, ...process.argv.slice(1)], {
    stdio: "inherit",
  });
  return result.status ?? 1;
}

async function cmdTrust(opts: { uninstall?: boolean }): Promise<void> {
  // Ensure the CA exists on disk before we try to install it. Also fine to
  // call during uninstall — it won't change anything that's already there.
  const store = createCertStore();
  console.log(pc.dim(`CA at ${store.caPath}`));

  const action = opts.uninstall ? await uninstallTrust() : await installTrust(store.caPath);

  if (action.action === "needs-elevation") {
    if (action.platform === "win32") {
      // UAC elevation from a Node child process is flaky. Show the command
      // and let the user paste it into an elevated PowerShell.
      console.error(pc.yellow(action.message));
      console.error(pc.bold(`  ${action.commands[0] ?? ""}`));
      process.exit(1);
    }
    console.log(pc.dim(action.message));
    process.exit(reexecElevated());
  }

  if (action.action === "installed" || action.action === "uninstalled") {
    console.log(pc.green(action.message));
    return;
  }

  if (action.action === "already-present" || action.action === "already-absent") {
    console.log(pc.dim(action.message));
    return;
  }

  console.error(pc.red(action.message));
  process.exit(1);
}

program
  .command("trust")
  .description("install Flapwire's local CA in the OS trust store so HTTPS works")
  .option("--uninstall", "remove Flapwire's CA from the trust store instead")
  .action((opts: { uninstall?: boolean }) => cmdTrust(opts));

program.parseAsync(process.argv).catch((err) => {
  console.error(pc.red(err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
