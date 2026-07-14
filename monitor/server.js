// Real-Time System Monitor — Backend
// Node.js + Express API exposing live OS metrics via the built-in `os` module.

const express = require("express");
const cors = require("cors");
const os = require("os");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

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

// Compute CPU usage % across a short sampling window.
function cpuAverage() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    for (const t of Object.values(cpu.times)) total += t;
    idle += cpu.times.idle;
  }
  return { idle: idle / cpus.length, total: total / cpus.length };
}

function getCpuUsage(sampleMs = 200) {
  return new Promise((resolve) => {
    const start = cpuAverage();
    setTimeout(() => {
      const end = cpuAverage();
      const idleDiff = end.idle - start.idle;
      const totalDiff = end.total - start.total;
      const usage = totalDiff > 0 ? 100 - (100 * idleDiff) / totalDiff : 0;
      resolve(+usage.toFixed(1));
    }, sampleMs);
  });
}

// --- Routes ----------------------------------------------------------------

app.get("/api/system-status", async (_req, res) => {
  try {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const cpus = os.cpus();
    const cpuUsage = await getCpuUsage();

    res.json({
      cpu: {
        model: cpus[0]?.model?.trim() || "Unknown",
        cores: cpus.length,
        architecture: os.arch(),
        speedMHz: cpus[0]?.speed || 0,
        usagePercent: cpuUsage,
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
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to read system status" });
  }
});

// Serve the dashboard from /public
app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => {
  console.log(`🚀 Server Health Monitor API running at http://localhost:${PORT}`);
  console.log(`   Dashboard: http://localhost:${PORT}`);
  console.log(`   API:       http://localhost:${PORT}/api/system-status`);
});
