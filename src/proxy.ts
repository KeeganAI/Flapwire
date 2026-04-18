import {
  type IncomingMessage,
  type Server,
  type ServerResponse,
  createServer,
  request as httpRequest,
} from "node:http";
import type { Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { type BlackoutConfig, isInBlackout } from "./levers/blackout.js";
import { type LatencyConfig, sampleLatencyMs } from "./levers/latency.js";
import { type LossConfig, shouldDropConnection } from "./levers/loss.js";

export interface ProxyProfile {
  latency?: LatencyConfig;
  loss?: LossConfig;
  blackout?: BlackoutConfig;
}

export type RequestOutcome = "response" | "drop" | "error" | "blackout";

export interface RequestLog {
  method: string;
  url: string;
  outcome: RequestOutcome;
  status?: number;
  appliedLatencyMs: number;
}

export interface ProxyOptions {
  random?: () => number;
  log?: (entry: RequestLog) => void;
  now?: () => number;
}

export interface UpstreamTarget {
  hostname: string;
  port: number;
  path: string;
}

const CONNECT_BODY =
  "HTTPS (CONNECT tunneling) is not supported in this build of Flapwire. " +
  "It is planned for v0.2. For now, proxy plain HTTP traffic or use reverse-proxy mode.\n";

interface HandlerDeps {
  profile: ProxyProfile;
  random: () => number;
  log: (entry: RequestLog) => void;
  now: () => number;
  startedAt: number;
  resolveUpstream: (req: IncomingMessage) => UpstreamTarget | null;
  logUrl: (req: IncomingMessage) => string;
}

async function handle(
  clientReq: IncomingMessage,
  clientRes: ServerResponse,
  deps: HandlerDeps,
): Promise<void> {
  const method = clientReq.method ?? "GET";
  const url = deps.logUrl(clientReq);

  if (deps.profile.loss && shouldDropConnection(deps.profile.loss, deps.random)) {
    deps.log({ method, url, outcome: "drop", appliedLatencyMs: 0 });
    clientReq.socket.destroy();
    return;
  }

  const blackoutNow =
    deps.profile.blackout !== undefined &&
    isInBlackout(deps.profile.blackout, deps.now() - deps.startedAt);

  const appliedLatencyMs = deps.profile.latency
    ? sampleLatencyMs(deps.profile.latency, deps.random)
    : 0;
  if (appliedLatencyMs > 0) {
    await delay(appliedLatencyMs);
  }

  if (blackoutNow) {
    if (!clientRes.headersSent && !clientRes.socket?.destroyed) {
      clientRes.writeHead(504, { "Content-Type": "text/plain; charset=utf-8" });
      clientRes.end("Gateway Timeout (blackout)\n");
    }
    deps.log({ method, url, outcome: "blackout", status: 504, appliedLatencyMs });
    return;
  }

  const target = deps.resolveUpstream(clientReq);
  if (!target) {
    if (!clientRes.headersSent && !clientRes.socket?.destroyed) {
      clientRes.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
      clientRes.end("Bad Gateway\n");
    }
    deps.log({ method, url, outcome: "error", status: 502, appliedLatencyMs });
    return;
  }

  const hostAuthority = target.port === 80 ? target.hostname : `${target.hostname}:${target.port}`;
  const upstreamHeaders = { ...clientReq.headers, host: hostAuthority };
  const upstreamReq = httpRequest(
    {
      hostname: target.hostname,
      port: target.port,
      method,
      path: target.path,
      headers: upstreamHeaders,
    },
    (upstreamRes) => {
      const status = upstreamRes.statusCode ?? 502;
      clientRes.writeHead(status, upstreamRes.headers);
      upstreamRes.pipe(clientRes);
      upstreamRes.on("end", () => {
        deps.log({ method, url, outcome: "response", status, appliedLatencyMs });
      });
    },
  );
  upstreamReq.on("error", () => {
    if (!clientRes.headersSent) clientRes.writeHead(502);
    clientRes.end();
    deps.log({ method, url, outcome: "error", status: 502, appliedLatencyMs });
  });
  clientReq.pipe(upstreamReq);
}

function attachBlackoutReaper(
  server: Server,
  profile: ProxyProfile,
  now: () => number,
  startedAt: number,
): void {
  if (!profile.blackout) return;
  const sockets = new Set<Socket>();
  server.on("connection", (s: Socket) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  let inBlackout = false;
  const tick = setInterval(() => {
    const next = isInBlackout(profile.blackout as BlackoutConfig, now() - startedAt);
    if (next && !inBlackout) {
      for (const s of sockets) s.destroy();
    }
    inBlackout = next;
  }, 250);
  tick.unref();
  server.on("close", () => clearInterval(tick));
}

function rejectConnect(server: Server): void {
  server.on("connect", (_req, clientSocket) => {
    clientSocket.on("error", () => {});
    const bodyBytes = Buffer.byteLength(CONNECT_BODY);
    clientSocket.write(
      `HTTP/1.1 501 Not Implemented\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${bodyBytes}\r\nConnection: close\r\n\r\n${CONNECT_BODY}`,
    );
    clientSocket.end();
  });
}

export function createProxy(profile: ProxyProfile, options: ProxyOptions = {}): Server {
  const random = options.random ?? Math.random;
  const log = options.log ?? (() => {});
  const now = options.now ?? Date.now;
  const startedAt = now();

  const server = createServer((req, res) => {
    void handle(req, res, {
      profile,
      random,
      log,
      now,
      startedAt,
      resolveUpstream: (r) => {
        const raw = r.url ?? "";
        try {
          const u = new URL(raw);
          return {
            hostname: u.hostname,
            port: u.port ? Number(u.port) : 80,
            path: `${u.pathname}${u.search}`,
          };
        } catch {
          return null;
        }
      },
      logUrl: (r) => r.url ?? "",
    });
  });

  rejectConnect(server);
  attachBlackoutReaper(server, profile, now, startedAt);
  return server;
}

export interface ReverseProxyOptions extends ProxyOptions {
  target: string;
}

export function createReverseProxy(profile: ProxyProfile, options: ReverseProxyOptions): Server {
  const random = options.random ?? Math.random;
  const log = options.log ?? (() => {});
  const now = options.now ?? Date.now;
  const startedAt = now();

  const targetUrl = new URL(options.target);
  const targetHost = targetUrl.hostname;
  const targetPort = targetUrl.port ? Number(targetUrl.port) : 80;
  const targetBasePath = targetUrl.pathname.replace(/\/$/, "");

  const server = createServer((req, res) => {
    void handle(req, res, {
      profile,
      random,
      log,
      now,
      startedAt,
      resolveUpstream: (r) => ({
        hostname: targetHost,
        port: targetPort,
        path: `${targetBasePath}${r.url ?? "/"}`,
      }),
      logUrl: (r) => r.url ?? "/",
    });
  });

  attachBlackoutReaper(server, profile, now, startedAt);
  return server;
}
