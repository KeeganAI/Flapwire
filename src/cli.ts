#!/usr/bin/env node
import { Command } from "commander";
import pc from "picocolors";
import { PROFILE_NAMES, getProfile } from "./profiles.js";
import { type RequestLog, createProxy } from "./proxy.js";

function colorForStatus(status: number | undefined): (s: string) => string {
  if (status === undefined) return pc.red;
  if (status >= 500) return pc.red;
  if (status >= 400) return pc.yellow;
  if (status >= 300) return pc.cyan;
  return pc.green;
}

function formatLog(entry: RequestLog): string {
  const method = pc.bold(entry.method);
  const url = entry.url;
  if (entry.outcome === "drop") {
    return `${method} ${url} ${pc.red("→ drop")}`;
  }
  const arrow = colorForStatus(entry.status)(`→ ${entry.status ?? "???"}`);
  const timing = pc.dim(`(${Math.round(entry.appliedLatencyMs)}ms)`);
  return `${method} ${url} ${arrow} ${timing}`;
}

const program = new Command();

program
  .name("flapwire")
  .description("Local HTTP proxy that degrades traffic for resilience testing.")
  .option("-p, --profile <name>", `network profile (${PROFILE_NAMES.join(", ")})`, "slow-3g")
  .option("--port <number>", "port to listen on", "8080")
  .action((opts: { profile: string; port: string }) => {
    let profile: ReturnType<typeof getProfile>;
    try {
      profile = getProfile(opts.profile);
    } catch (err) {
      console.error(pc.red((err as Error).message));
      process.exit(1);
    }

    const port = Number.parseInt(opts.port, 10);
    if (!Number.isFinite(port) || port <= 0 || port > 65535) {
      console.error(pc.red(`invalid port: ${opts.port}`));
      process.exit(1);
    }

    const server = createProxy(profile, {
      log: (entry) => console.log(formatLog(entry)),
    });
    server.listen(port, () => {
      const lat = profile.latency;
      const loss = profile.loss;
      console.log(pc.dim(`flapwire listening on http://127.0.0.1:${port}`));
      console.log(pc.dim(`profile: ${pc.bold(opts.profile)}`));
      if (lat) console.log(pc.dim(`  latency: ${lat.baseMs}ms ± ${lat.jitterMs}ms`));
      if (loss) console.log(pc.dim(`  drop rate: ${(loss.connectionDropRate * 100).toFixed(2)}%`));
      console.log(pc.dim("use as an HTTP proxy, e.g.:"));
      console.log(pc.dim(`  curl -x http://127.0.0.1:${port} http://httpbin.org/get`));
    });

    const shutdown = () => {
      server.close(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(pc.red(err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
