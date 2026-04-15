import { type Server, createServer, request as httpRequest } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { type LatencyConfig, sampleLatencyMs } from "./levers/latency.js";
import { type LossConfig, shouldDropConnection } from "./levers/loss.js";

export interface ProxyProfile {
  latency?: LatencyConfig;
  loss?: LossConfig;
}

export type RequestOutcome = "response" | "drop" | "error";

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
}

const CONNECT_BODY =
  "HTTPS (CONNECT tunneling) is not supported in this build of Flapwire. " +
  "It is planned for v0.2. For now, proxy plain HTTP traffic or use reverse-proxy mode in v0.1.5.\n";

export function createProxy(profile: ProxyProfile, options: ProxyOptions = {}): Server {
  const random = options.random ?? Math.random;
  const log = options.log ?? (() => {});

  const server = createServer(async (clientReq, clientRes) => {
    const method = clientReq.method ?? "GET";
    const url = clientReq.url ?? "";

    if (profile.loss && shouldDropConnection(profile.loss, random)) {
      log({ method, url, outcome: "drop", appliedLatencyMs: 0 });
      clientReq.socket.destroy();
      return;
    }

    const appliedLatencyMs = profile.latency ? sampleLatencyMs(profile.latency, random) : 0;
    if (appliedLatencyMs > 0) {
      await delay(appliedLatencyMs);
    }

    const target = new URL(url);
    const upstreamReq = httpRequest(
      {
        hostname: target.hostname,
        port: target.port || 80,
        method,
        path: `${target.pathname}${target.search}`,
        headers: clientReq.headers,
      },
      (upstreamRes) => {
        const status = upstreamRes.statusCode ?? 502;
        clientRes.writeHead(status, upstreamRes.headers);
        upstreamRes.pipe(clientRes);
        upstreamRes.on("end", () => {
          log({ method, url, outcome: "response", status, appliedLatencyMs });
        });
      },
    );
    upstreamReq.on("error", () => {
      clientRes.writeHead(502);
      clientRes.end();
      log({ method, url, outcome: "error", status: 502, appliedLatencyMs });
    });
    clientReq.pipe(upstreamReq);
  });

  server.on("connect", (_req, clientSocket) => {
    clientSocket.on("error", () => {});
    const bodyBytes = Buffer.byteLength(CONNECT_BODY);
    clientSocket.write(
      `HTTP/1.1 501 Not Implemented\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${bodyBytes}\r\nConnection: close\r\n\r\n${CONNECT_BODY}`,
    );
    clientSocket.end();
  });

  return server;
}
