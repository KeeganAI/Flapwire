import { type Server, createServer, request as httpRequest } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { type LatencyConfig, sampleLatencyMs } from "./levers/latency.js";
import { type LossConfig, shouldDropConnection } from "./levers/loss.js";

export interface ProxyProfile {
  latency?: LatencyConfig;
  loss?: LossConfig;
}

export function createProxy(profile: ProxyProfile, random: () => number = Math.random): Server {
  return createServer(async (clientReq, clientRes) => {
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
}
