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

  // Drops happen before latency on purpose: a real packet-loss event is instant,
  // not "slow then vanish". The client sees an RST with no response at all.
  if (deps.profile.loss && shouldDropConnection(deps.profile.loss, deps.random)) {
    deps.log({ method, url, outcome: "drop", appliedLatencyMs: 0 });
    clientReq.socket.destroy();
    return;
  }

  // Decide the blackout state up front. If we decided it again after the delay,
  // a request that arrived just outside the window could still get a 504 because
  // the window started while it was sleeping — honest but noisy.
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
    // The blackout reaper may have destroyed this socket while we were waiting
    // out the latency; writing to it would throw. Same for the Bad-Gateway branch below.
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

  // Virtual-hosted upstreams (Vercel, nginx, most CDNs) route by the Host header.
  // The incoming request's Host points at Flapwire, so we rewrite it to the upstream's
  // authority. Port 80 is omitted to match what a browser would send.
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

// Tears existing connections down at the moment a blackout window starts, so
// long-lived requests (SSE, slow downloads) break the way they would on a real
// flaky link. New requests hitting the proxy during the window are handled
// separately in handle() / attachUpgradeHandler.
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
    // Destroy sockets on the rising edge only — during a blackout we want to
    // ignore new connections rather than actively kill them here, since handle()
    // will answer them with a 504.
    if (next && !inBlackout) {
      for (const s of sockets) s.destroy();
    }
    inBlackout = next;
  }, 250);
  // Don't let this timer keep the process alive after the server is closed.
  tick.unref();
  server.on("close", () => clearInterval(tick));
}

// CONNECT is how HTTP proxies tunnel HTTPS. We don't support that yet, but the
// default Node server behaviour (silently dropping the request) is confusing —
// the client just sees a closed socket. A 501 with a pointer to reverse-proxy
// mode is friendlier. Written as a raw HTTP/1.1 response because Node doesn't
// give you a ServerResponse for CONNECT.
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

// Forwards HTTP upgrade handshakes (i.e. WebSockets) through the reverse proxy.
// The same three levers apply to an upgrade as to a normal request — latency
// delays the handshake, loss drops the upgrade attempt, blackout closes the
// socket instead of answering it (there's no HTTP response to send once
// Connection: Upgrade is in flight, so a TCP close is the only honest signal).
function attachUpgradeHandler(
  server: Server,
  profile: ProxyProfile,
  random: () => number,
  log: (entry: RequestLog) => void,
  now: () => number,
  startedAt: number,
  resolveUpstream: (req: IncomingMessage) => UpstreamTarget | null,
  logUrl: (req: IncomingMessage) => string,
): void {
  // Node's Server.closeAllConnections() only knows about sockets currently
  // managed by the HTTP layer. Once a socket is upgraded and handed to user
  // code, it's no longer on that list — so shutdown would hang waiting for it
  // to drain. We keep our own set and wrap closeAllConnections to include it.
  const tracked = new Set<Socket>();
  const origCloseAll = server.closeAllConnections.bind(server);
  server.closeAllConnections = () => {
    for (const s of tracked) s.destroy();
    tracked.clear();
    origCloseAll();
  };

  server.on("upgrade", (clientReq: IncomingMessage, clientSocket: Socket, head: Buffer) => {
    const method = clientReq.method ?? "GET";
    const url = logUrl(clientReq);

    if (profile.loss && shouldDropConnection(profile.loss, random)) {
      log({ method, url, outcome: "drop", appliedLatencyMs: 0 });
      clientSocket.destroy();
      return;
    }

    // Decide blackout state up front — see the matching note in handle().
    const blackoutNow =
      profile.blackout !== undefined && isInBlackout(profile.blackout, now() - startedAt);

    const appliedLatencyMs = profile.latency ? sampleLatencyMs(profile.latency, random) : 0;

    void (async () => {
      if (appliedLatencyMs > 0) await delay(appliedLatencyMs);
      // The client may have walked away during the delay.
      if (clientSocket.destroyed) return;

      if (blackoutNow) {
        clientSocket.destroy();
        log({ method, url, outcome: "blackout", appliedLatencyMs });
        return;
      }

      const target = resolveUpstream(clientReq);
      if (!target) {
        clientSocket.destroy();
        return;
      }

      const hostAuthority =
        target.port === 80 ? target.hostname : `${target.hostname}:${target.port}`;

      const upstreamReq = httpRequest({
        hostname: target.hostname,
        port: target.port,
        method,
        path: target.path,
        headers: { ...clientReq.headers, host: hostAuthority },
      });

      upstreamReq.on("upgrade", (upstreamRes, upstreamSocket, upstreamHead) => {
        if (clientSocket.destroyed) {
          upstreamSocket.destroy();
          return;
        }
        // Track both ends so shutdown can tear them down; remove on close so
        // the Set doesn't retain destroyed sockets forever.
        tracked.add(clientSocket);
        tracked.add(upstreamSocket);
        clientSocket.on("close", () => tracked.delete(clientSocket));
        upstreamSocket.on("close", () => tracked.delete(upstreamSocket));
        // Replay the upstream's 101 to the client by hand — Node gives us the
        // parsed response but no helper to serialise it back out on a raw socket.
        let raw = "HTTP/1.1 101 Switching Protocols\r\n";
        for (const [k, v] of Object.entries(upstreamRes.headers)) {
          const vals = Array.isArray(v) ? v : [v];
          for (const val of vals) if (val !== undefined) raw += `${k}: ${val}\r\n`;
        }
        raw += "\r\n";
        clientSocket.write(raw);
        // `head` / `upstreamHead` are bytes that were already on the wire when
        // the upgrade event fired — they belong to the protocol that's taking
        // over, so we forward them before starting the pipe.
        if (upstreamHead.length > 0) clientSocket.write(upstreamHead);
        if (head.length > 0) upstreamSocket.write(head);
        upstreamSocket.pipe(clientSocket);
        clientSocket.pipe(upstreamSocket);
        upstreamSocket.on("error", () => {
          if (!clientSocket.destroyed) clientSocket.destroy();
        });
        clientSocket.on("error", () => upstreamSocket.destroy());
        log({ method, url, outcome: "response", status: 101, appliedLatencyMs });
      });

      upstreamReq.on("error", () => {
        if (!clientSocket.destroyed) clientSocket.destroy();
        log({ method, url, outcome: "error", status: 502, appliedLatencyMs });
      });

      clientSocket.on("error", () => upstreamReq.destroy());
      upstreamReq.end();
    })();
  });
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

  const resolveUpstream = (r: IncomingMessage): UpstreamTarget => ({
    hostname: targetHost,
    port: targetPort,
    path: `${targetBasePath}${r.url ?? "/"}`,
  });

  const server = createServer((req, res) => {
    void handle(req, res, {
      profile,
      random,
      log,
      now,
      startedAt,
      resolveUpstream,
      logUrl: (r) => r.url ?? "/",
    });
  });

  attachBlackoutReaper(server, profile, now, startedAt);
  attachUpgradeHandler(
    server,
    profile,
    random,
    log,
    now,
    startedAt,
    resolveUpstream,
    (r) => r.url ?? "/",
  );
  return server;
}
