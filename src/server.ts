import "./lib/error-capture";

import os from "os";
import si from "systeminformation";
import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

type NetworkState = {
  rxBytes: number;
  txBytes: number;
  timestamp: number;
};

const lastNetworkStats: Record<string, NetworkState> = {};

async function getOsMetrics() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const cpus = os.cpus();
  const load = await si.currentLoad();
  const netStats = await si.networkStats();

  const network = await si.networkInterfaces();
  const networkInterfaces = network.map((iface) => ({
    name: iface.iface,
    addresses: iface.ip4 ? [{ address: iface.ip4, family: "IPv4", mac: iface.mac, internal: iface.internal }] : [],
  }));

  const throughput = netStats.map((stat) => {
    const previous = lastNetworkStats[stat.iface];
    const now = Date.now();
    const duration = previous ? (now - previous.timestamp) / 1000 : 1;
    const rx = previous ? (stat.rx_bytes - previous.rxBytes) / duration : 0;
    const tx = previous ? (stat.tx_bytes - previous.txBytes) / duration : 0;

    lastNetworkStats[stat.iface] = {
      rxBytes: stat.rx_bytes,
      txBytes: stat.tx_bytes,
      timestamp: now,
    };

    return {
      iface: stat.iface,
      rxKb: rx / 1024,
      txKb: tx / 1024,
    };
  });

  return {
    hostname: os.hostname(),
    type: os.type(),
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    uptime: os.uptime(),
    memory: {
      total: totalMem,
      free: freeMem,
      used: usedMem,
      usedPercent: totalMem > 0 ? (usedMem / totalMem) * 100 : 0,
    },
    cpu: {
      cores: cpus.length,
      model: cpus[0]?.model ?? "Unknown",
      speed: cpus[0]?.speed ?? 0,
      loadAverage: os.loadavg(),
      usagePercent: load.currentLoad,
    },
    network: networkInterfaces,
    throughput,
  };
}

let serverEntryPromise: Promise<ServerEntry> | undefined;

async function getServerEntry(): Promise<ServerEntry> {
  if (!serverEntryPromise) {
    serverEntryPromise = import("@tanstack/react-start/server-entry").then(
      (m) => (m.default ?? m) as ServerEntry,
    );
  }
  return serverEntryPromise;
}

// h3 swallows in-handler throws into a normal 500 Response with body
// {"unhandled":true,"message":"HTTPError"} — try/catch alone never fires for those.
async function normalizeCatastrophicSsrResponse(response: Response): Promise<Response> {
  if (response.status < 500) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const body = await response.clone().text();
  if (!isH3SwallowedErrorBody(body)) return response;

  console.error(consumeLastCapturedError() ?? new Error(`h3 swallowed SSR error: ${body}`));
  return new Response(renderErrorPage(), {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function isH3SwallowedErrorBody(body: string): boolean {
  try {
    const payload = JSON.parse(body) as { unhandled?: unknown; message?: unknown };
    return payload.unhandled === true && payload.message === "HTTPError";
  } catch {
    return false;
  }
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/api/os" && request.method === "GET") {
        return new Response(JSON.stringify(await getOsMetrics()), {
          status: 200,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
          },
        });
      }

      const handler = await getServerEntry();
      const response = await handler.fetch(request, env, ctx);
      return await normalizeCatastrophicSsrResponse(response);
    } catch (error) {
      console.error(error);
      return new Response(renderErrorPage(), {
        status: 500,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
  },
};
