import { type Server, createServer, request as httpRequest } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { type LatencyConfig, sampleLatencyMs } from "./levers/latency.js";
import { type LossConfig, shouldDropConnection } from "./levers/loss.js";

export interface ProxyProfile {
  latency?: LatencyConfig;
  loss?: LossConfig;
}

const CONNECT_BODY =
  "HTTPS (CONNECT tunneling) is not supported in this build of Flapwire. " +
  "It is planned for v0.2. For now, proxy plain HTTP traffic or use reverse-proxy mode in v0.1.5.\n";

export function createProxy(profile: ProxyProfile, random: () => number = Math.random): Server {
  const server = createServer(async (clientReq, clientRes) => {
    if (profile.loss && shouldDropConnection(profile.loss, random)) {
      clientReq.socket.destroy();
      return;
    }

    if (profile.latency) {
      await delay(sampleLatencyMs(profile.latency, random));
    }

    const target = new URL(clientReq.url ?? "");
    const upstreamReq = httpRequest(
      {
        hostname: target.hostname,
        port: target.port || 80,
        method: clientReq.method,
        path: `${target.pathname}${target.search}`,
        headers: clientReq.headers,
      },
      (upstreamRes) => {
        clientRes.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(clientRes);
      },
    );
    upstreamReq.on("error", () => {
      clientRes.writeHead(502);
      clientRes.end();
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
