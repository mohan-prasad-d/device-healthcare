// Real-Time System Monitor — Backend
// Node.js + Express API + WebSocket stream exposing live OS metrics.

const express = require("express");
const cors = require("cors");
const os = require("os");
const path = require("path");
const http = require("http");
const { WebSocketServer } = require("ws");

const app = express();
const PORT = process.env.PORT || 3000;
const STREAM_INTERVAL_MS = 2000;

app.use(cors());

// --- Helpers ---------------------------------------------------------------

function bytesToGB(bytes) {
  return +(bytes / 1024 / 1024 / 1024).toFixed(2);
}

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const parts = [];
  if (d) parts.push(`${d} day${d !== 1 ? "s" : ""}`);
  if (h) parts.push(`${h} hour${h !== 1 ? "s" : ""}`);
  if (m) parts.push(`${m} minute${m !== 1 ? "s" : ""}`);
  if (!d && !h) parts.push(`${s} second${s !== 1 ? "s" : ""}`);
  return parts.join(", ");
}

// Snapshot of raw CPU times per core.
function cpuTimesSnapshot() {
  return os.cpus().map((cpu) => {
    const times = cpu.times;
    const total = times.user + times.nice + times.sys + times.idle + times.irq;
    return { idle: times.idle, total };
  });
}

// Diff two snapshots to compute per-core and aggregate usage %.
function diffCpuUsage(prev, next) {
  const perCore = prev.map((p, i) => {
    const n = next[i] || p;
    const idleDiff = n.idle - p.idle;
    const totalDiff = n.total - p.total;
    const usage = totalDiff > 0 ? 100 - (100 * idleDiff) / totalDiff : 0;
    return +Math.max(0, Math.min(100, usage)).toFixed(1);
  });
  const avg = perCore.length
    ? +(perCore.reduce((a, b) => a + b, 0) / perCore.length).toFixed(1)
    : 0;
  return { perCore, avg };
}

// Sample CPU over a window and resolve with { perCore, avg }.
function sampleCpuUsage(sampleMs = 200) {
  return new Promise((resolve) => {
    const start = cpuTimesSnapshot();
    setTimeout(() => resolve(diffCpuUsage(start, cpuTimesSnapshot())), sampleMs);
  });
}

async function buildStatusPayload() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const cpus = os.cpus();
  const { perCore, avg } = await sampleCpuUsage();

  return {
    cpu: {
      model: cpus[0]?.model?.trim() || "Unknown",
      cores: cpus.length,
      architecture: os.arch(),
      speedMHz: cpus[0]?.speed || 0,
      usagePercent: avg,
      perCoreUsage: perCore,
      loadAverage: os.loadavg(),
    },
    memory: {
      totalGB: bytesToGB(totalMem),
      freeGB: bytesToGB(freeMem),
      usedGB: bytesToGB(usedMem),
      usedPercent: +((usedMem / totalMem) * 100).toFixed(1),
    },
    uptime: {
      seconds: os.uptime(),
      human: formatUptime(os.uptime()),
    },
    os: {
      type: os.type(),
      platform: os.platform(),
      release: os.release(),
      hostname: os.hostname(),
    },
    timestamp: new Date().toISOString(),
  };
}

// --- REST route (kept for compatibility) -----------------------------------

app.get("/api/system-status", async (_req, res) => {
  try {
    res.json(await buildStatusPayload());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to read system status" });
  }
});

// Serve the dashboard from /public
app.use(express.static(path.join(__dirname, "public")));

// --- HTTP + WebSocket server ----------------------------------------------

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

// Single shared sampler: one CPU diff loop feeds every connected client.
let broadcastTimer = null;

function startBroadcasting() {
  if (broadcastTimer) return;
  broadcastTimer = setInterval(async () => {
    if (wss.clients.size === 0) return;
    try {
      const payload = JSON.stringify(await buildStatusPayload());
      for (const client of wss.clients) {
        if (client.readyState === client.OPEN) client.send(payload);
      }
    } catch (err) {
      console.error("Broadcast failed:", err);
    }
  }, STREAM_INTERVAL_MS);
}

wss.on("connection", async (socket) => {
  startBroadcasting();
  try {
    socket.send(JSON.stringify(await buildStatusPayload()));
  } catch (err) {
    console.error("Initial send failed:", err);
  }
});

server.listen(PORT, () => {
  console.log(`🚀 Server Health Monitor running at http://localhost:${PORT}`);
  console.log(`   Dashboard: http://localhost:${PORT}`);
  console.log(`   REST:      http://localhost:${PORT}/api/system-status`);
  console.log(`   WebSocket: ws://localhost:${PORT}/ws  (streams every ${STREAM_INTERVAL_MS}ms)`);
});
