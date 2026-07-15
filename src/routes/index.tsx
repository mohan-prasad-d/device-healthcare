import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
} from "recharts";

export const Route = createFileRoute("/")({
  component: Index,
});

type OsMetric = {
  hostname: string;
  type: string;
  platform: string;
  release: string;
  arch: string;
  uptime: number;
  memory: {
    total: number;
    free: number;
    used: number;
    usedPercent: number;
  };
  cpu: {
    cores: number;
    model: string;
    speed: number;
    loadAverage: number[];
    usagePercent: number;
  };
  network: Array<{
    name: string;
    addresses: Array<{
      address: string;
      family: string;
      mac: string;
      internal: boolean;
    }>;
  }>;
  throughput: Array<{
    iface: string;
    rxKb: number;
    txKb: number;
  }>;
};

type StatPoint = { time: string; value: number };

function getBrowserMetrics(): OsMetric {
  const connection = (navigator as Navigator & {
    connection?: {
      effectiveType?: string;
      downlink?: number;
      rtt?: number;
      saveData?: boolean;
    };
  }).connection;

  const performanceMemory = (performance as Performance & {
    memory?: {
      usedJSHeapSize?: number;
      totalJSHeapSize?: number;
    };
  }).memory;

  const totalHeap = performanceMemory?.totalJSHeapSize ?? 0;
  const usedHeap = performanceMemory?.usedJSHeapSize ?? 0;
  const usedPercent = totalHeap > 0 ? (usedHeap / totalHeap) * 100 : 0;

  const ua = navigator.userAgent;
  let platform = "Unknown";
  if (/Windows/i.test(ua)) platform = "Windows";
  else if (/Mac OS/i.test(ua)) platform = "macOS";
  else if (/Linux/i.test(ua)) platform = "Linux";
  else if (/Android/i.test(ua)) platform = "Android";
  else if (/iPhone|iPad|iPod/i.test(ua)) platform = "iOS";

  const browserPlatform = navigator.platform || "Unknown";
  const browserCpuCount = navigator.hardwareConcurrency || 1;
  const browserMemoryGb = (navigator as Navigator & { deviceMemory?: number }).deviceMemory || 0;

  return {
    hostname: window.location.hostname,
    type: "Browser",
    platform,
    release: navigator.userAgent,
    arch: browserPlatform,
    uptime: Math.floor(performance.now() / 1000),
    memory: {
      total: browserMemoryGb > 0 ? browserMemoryGb * 1024 * 1024 * 1024 : totalHeap,
      free: browserMemoryGb > 0 ? Math.max(browserMemoryGb * 1024 * 1024 * 1024 - usedHeap, 0) : Math.max(totalHeap - usedHeap, 0),
      used: usedHeap,
      usedPercent,
    },
    cpu: {
      cores: browserCpuCount,
      model: "Browser runtime",
      speed: 0,
      loadAverage: [0, 0, 0],
      usagePercent: 0,
    },
    network: [
      {
        name: "Browser network",
        addresses: [
          {
            address: connection?.effectiveType ?? "unknown",
            family: "Browser",
            mac: "",
            internal: false,
          },
        ],
      },
    ],
    throughput: [],
  };
}

function mapExpressMonitorToOsMetric(data: Record<string, unknown>): OsMetric {
  const osData = data.os as Record<string, unknown> | undefined;
  const cpuData = data.cpu as Record<string, unknown> | undefined;
  const memData = data.memory as Record<string, unknown> | undefined;
  const uptimeData = data.uptime as Record<string, unknown> | undefined;
  return {
    hostname: (osData?.hostname as string) || "Unknown",
    type: (osData?.type as string) || "Unknown",
    platform: (osData?.platform as string) || "Unknown",
    release: (osData?.release as string) || "Unknown",
    arch: (cpuData?.architecture as string) || "Unknown",
    uptime: (uptimeData?.seconds as number) || 0,
    memory: {
      total: ((memData?.totalGB as number) || 0) * 1024 * 1024 * 1024,
      free: ((memData?.freeGB as number) || 0) * 1024 * 1024 * 1024,
      used: ((memData?.usedGB as number) || 0) * 1024 * 1024 * 1024,
      usedPercent: (memData?.usedPercent as number) || 0,
    },
    cpu: {
      cores: (cpuData?.cores as number) || 1,
      model: (cpuData?.model as string) || "Unknown",
      speed: (cpuData?.speedMHz as number) || 0,
      loadAverage: (cpuData?.loadAverage as number[]) || [0, 0, 0],
      usagePercent: (cpuData?.usagePercent as number) || 0,
    },
    network: [],
    throughput: [],
  };
}

const fetchOsMetrics = async (sourceType: string, customUrl: string) => {
  let url = "/api/os";
  if (sourceType === "local-agent") {
    url = "http://localhost:5173/api/os";
  } else if (sourceType === "local-monitor") {
    url = "http://localhost:3000/api/system-status";
  } else if (sourceType === "custom") {
    url = customUrl || "/api/os";
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error("Unable to load OS data");
  }
  const rawData = await response.json() as Record<string, unknown>;
  if (sourceType === "local-monitor") {
    return mapExpressMonitorToOsMetric(rawData);
  }
  return rawData as unknown as OsMetric;
};

// WebSocket hook for real-time streaming from the local Express monitor
function useMonitorWebSocket(
  enabled: boolean,
  onData: (metric: OsMetric) => void,
) {
  const wsRef = useRef<WebSocket | null>(null);
  const retryRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onDataRef = useRef(onData);
  onDataRef.current = onData;

  useEffect(() => {
    if (!enabled) {
      if (wsRef.current) {
        wsRef.current.onopen = null;
        wsRef.current.onmessage = null;
        wsRef.current.onclose = null;
        wsRef.current.onerror = null;
        wsRef.current.close();
        wsRef.current = null;
      }
      if (timerRef.current) clearTimeout(timerRef.current);
      return;
    }

    function connect() {
      if (wsRef.current) {
        wsRef.current.onopen = null;
        wsRef.current.onmessage = null;
        wsRef.current.onclose = null;
        wsRef.current.onerror = null;
        wsRef.current.close();
      }

      const ws = new WebSocket("ws://localhost:3000/ws");
      wsRef.current = ws;

      ws.onopen = () => {
        retryRef.current = 0;
      };

      ws.onmessage = (ev) => {
        try {
          const raw = JSON.parse(ev.data as string) as Record<string, unknown>;
          onDataRef.current(mapExpressMonitorToOsMetric(raw));
        } catch {
          // ignore parse errors
        }
      };

      ws.onclose = () => {
        const delay = Math.min(1000 * 2 ** retryRef.current, 15000);
        retryRef.current = Math.min(retryRef.current + 1, 6);
        timerRef.current = setTimeout(connect, delay);
      };

      ws.onerror = () => {
        try { ws.close(); } catch { /* no-op */ }
      };
    }

    connect();

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [enabled]);
}

function Index() {
  const [cpuHistory, setCpuHistory] = useState<StatPoint[]>([]);
  const [memHistory, setMemHistory] = useState<StatPoint[]>([]);
  const [netHistory, setNetHistory] = useState<StatPoint[]>([]);
  const [cpuThreshold, setCpuThreshold] = useState(80);
  const [memThreshold, setMemThreshold] = useState(85);
  const [netThreshold, setNetThreshold] = useState(1024);
  const [browserMetrics, setBrowserMetrics] = useState<OsMetric | null>(null);
  const [wsData, setWsData] = useState<OsMetric | null>(null);

  const [sourceType, setSourceType] = useState(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("monitor-source-type") || "relative";
    }
    return "relative";
  });

  const [customUrl, setCustomUrl] = useState(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("monitor-custom-url") || "";
    }
    return "";
  });

  useEffect(() => {
    localStorage.setItem("monitor-source-type", sourceType);
  }, [sourceType]);

  useEffect(() => {
    localStorage.setItem("monitor-custom-url", customUrl);
  }, [customUrl]);

  // Reset wsData when switching away from local-monitor
  useEffect(() => {
    if (sourceType !== "local-monitor") {
      setWsData(null);
    }
  }, [sourceType]);

  const isLocalHost = typeof window !== "undefined" && ["localhost", "127.0.0.1"].includes(window.location.hostname);
  const useWs = sourceType === "local-monitor";

  // Live WebSocket stream for local-monitor source
  useMonitorWebSocket(useWs, (metric) => {
    setWsData(metric);
  });

  const { data: restData, isLoading, refetch } = useQuery({
    queryKey: ["osMetrics", sourceType, customUrl],
    queryFn: () => fetchOsMetrics(sourceType, customUrl),
    enabled: sourceType !== "browser" && !useWs,
    refetchInterval: sourceType !== "browser" && !useWs ? 2000 : false,
    staleTime: 1000,
  });

  useEffect(() => {
    setBrowserMetrics(getBrowserMetrics());
  }, []);

  // Unified data: prefer WebSocket for local-monitor, REST otherwise
  const data = useWs ? wsData : restData;

  useEffect(() => {
    if (!data) return;

    const now = new Date();
    const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
    const totalThroughput = data.throughput.reduce((sum, item) => sum + item.rxKb + item.txKb, 0);

    setCpuHistory((prev) => [...prev.slice(-29), { time, value: Math.round(data.cpu.usagePercent * 10) / 10 }]);
    setMemHistory((prev) => [...prev.slice(-29), { time, value: Math.round(data.memory.usedPercent * 10) / 10 }]);
    setNetHistory((prev) => [...prev.slice(-29), { time, value: Math.round(totalThroughput * 10) / 10 }]);
  }, [data]);

  const formatBytes = (value: number) => {
    if (value === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const index = Math.floor(Math.log(value) / Math.log(1024));
    return `${(value / 1024 ** index).toFixed(1)} ${units[index]}`;
  };

  const formatUptime = (seconds: number) => {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    return `${hrs}h ${mins}m ${secs}s`;
  };

  const liveData = sourceType === "browser" ? browserMetrics : (data || browserMetrics);
  const totalThroughput = useMemo(
    () => liveData?.throughput.reduce((sum, item) => sum + item.rxKb + item.txKb, 0) ?? 0,
    [liveData],
  );

  const cpuWarning = liveData?.cpu.usagePercent != null && liveData.cpu.usagePercent > cpuThreshold;
  const memWarning = liveData?.memory.usedPercent != null && liveData.memory.usedPercent > memThreshold;
  const netWarning = totalThroughput > netThreshold;
  const showLoading = isLoading && !liveData;

  return (
    <main className="min-h-screen bg-slate-950 px-6 py-8 text-slate-100">
      <div className="mx-auto max-w-7xl">
        <div className="space-y-6 rounded-3xl border border-slate-800 bg-slate-900/95 p-6 shadow-2xl shadow-slate-950/40 sm:p-8">
          <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="inline-flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.2em] text-emerald-300">
                <span className="h-2.5 w-2.5 rounded-full bg-emerald-400" />
                Device Healthcare
              </p>
              <h1 className="mt-3 text-3xl font-semibold sm:text-4xl">Live OS Dashboard</h1>
              <p className="mt-2 text-sm text-slate-400 sm:text-base">
                Real-time CPU, memory, and network throughput with alert thresholds.
              </p>
              <p className="mt-2 text-xs text-slate-500 sm:text-sm">
                {sourceType === "relative"
                  ? (isLocalHost
                      ? "Reading local machine metrics from the app runtime."
                      : "Reading serverless function metrics from the Vercel runtime.")
                  : sourceType === "local-agent"
                  ? "Reading from the local dev agent on http://localhost:5173/api/os."
                  : sourceType === "local-monitor"
                  ? `Streaming live from ws://localhost:3000/ws · ${wsData ? "🟢 connected" : "🟡 connecting…"}`
                  : sourceType === "custom"
                  ? `Reading from a custom URL: ${customUrl || "/api/os"}`
                  : "Reading device heuristics from the browser sandbox (limited features)."}
              </p>
            </div>
            <button
              onClick={() => void refetch()}
              disabled={useWs}
              className="inline-flex items-center justify-center rounded-full border border-slate-700 bg-slate-800 px-4 py-2 text-sm font-semibold text-slate-100 transition hover:border-slate-500 hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {useWs ? "WebSocket active" : "Refresh Now"}
            </button>
          </header>

          <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
            <section className="grid gap-6">
              <div className="grid gap-6 sm:grid-cols-2">
                <MetricCard
                  title="RAM Usage"
                  value={showLoading ? "--" : `${liveData?.memory.usedPercent.toFixed(1)} %`}
                  detail={showLoading ? "Loading..." : `${formatBytes(liveData?.memory.used ?? 0)} used of ${formatBytes(liveData?.memory.total ?? 0)}`}
                  warning={memWarning}
                />
                <MetricCard
                  title="CPU Usage"
                  value={showLoading ? "--" : `${liveData?.cpu.usagePercent.toFixed(1)} %`}
                  detail={showLoading ? "Loading..." : `${liveData?.cpu.model} • ${liveData?.cpu.cores} cores`}
                  warning={cpuWarning}
                />
                <MetricCard title="Uptime" value={showLoading ? "--" : formatUptime(liveData?.uptime ?? 0)} detail="Time since last reboot" />
                <MetricCard
                  title="Network Throughput"
                  value={showLoading ? "--" : `${totalThroughput.toFixed(1)} KB/s`}
                  detail={showLoading ? "Loading..." : `Threshold ${netThreshold} KB/s`}
                  warning={netWarning}
                />
              </div>

              <div className="grid gap-6">
                <GraphCard title="CPU usage" data={cpuHistory} threshold={cpuThreshold} unit="%" warning={cpuWarning} color="#38bdf8" />
                <GraphCard title="Memory usage" data={memHistory} threshold={memThreshold} unit="%" warning={memWarning} color="#a78bfa" />
                <GraphCard title="Network throughput" data={netHistory} threshold={netThreshold} unit="KB/s" warning={netWarning} color="#34d399" />
              </div>
            </section>

            <aside className="space-y-6">
              <div className="rounded-3xl border border-slate-800 bg-slate-950/80 p-6">
                <h2 className="text-lg font-semibold">Connection settings</h2>
                <p className="mt-2 text-sm text-slate-400">Select which device or server metrics to display.</p>
                <div className="mt-4 space-y-4">
                  <div className="space-y-2">
                    <label className="text-xs font-semibold uppercase tracking-wider text-slate-500">Data source</label>
                    <select
                      value={sourceType}
                      onChange={(e) => setSourceType(e.target.value)}
                      className="w-full rounded-2xl border border-slate-800 bg-slate-900 px-4 py-3 text-sm text-slate-200 outline-none focus:border-sky-500"
                    >
                      <option value="relative">This Server (Vercel / Local)</option>
                      <option value="local-agent">Local Dev Agent (localhost:5173)</option>
                      <option value="local-monitor">Local Express Monitor — WebSocket (localhost:3000)</option>
                      <option value="custom">Custom API URL</option>
                      <option value="browser">Browser Sandbox (This Device)</option>
                    </select>
                  </div>
                  {sourceType === "custom" && (
                    <div className="space-y-2">
                      <label className="text-xs font-semibold uppercase tracking-wider text-slate-500">Custom URL</label>
                      <input
                        type="text"
                        value={customUrl}
                        onChange={(e) => setCustomUrl(e.target.value)}
                        placeholder="https://my-server.com/api/os"
                        className="w-full rounded-2xl border border-slate-800 bg-slate-900 px-4 py-3 text-sm text-slate-200 outline-none focus:border-sky-500"
                      />
                    </div>
                  )}
                  {sourceType === "local-monitor" && (
                    <div className={`flex items-center gap-2 rounded-2xl border px-4 py-3 text-xs font-medium ${wsData ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300" : "border-amber-500/30 bg-amber-500/10 text-amber-300"}`}>
                      <span className={`inline-block h-2 w-2 rounded-full ${wsData ? "bg-emerald-400 animate-pulse" : "bg-amber-400"}`} />
                      {wsData ? "WebSocket stream live · push every 2s" : "Connecting to ws://localhost:3000/ws…"}
                    </div>
                  )}
                </div>
              </div>

              <div className="rounded-3xl border border-slate-800 bg-slate-950/80 p-6">
                <h2 className="text-lg font-semibold">Alert thresholds</h2>
                <p className="mt-2 text-sm text-slate-400">Set warning levels for CPU, memory, and network throughput.</p>
                <div className="mt-6 space-y-4">
                  <ThresholdControl label="CPU" value={cpuThreshold} onChange={setCpuThreshold} suffix="%" />
                  <ThresholdControl label="Memory" value={memThreshold} onChange={setMemThreshold} suffix="%" />
                  <ThresholdControl label="Network" value={netThreshold} onChange={setNetThreshold} suffix="KB/s" />
                </div>
              </div>

              <div className="rounded-3xl border border-slate-800 bg-slate-950/80 p-6">
                <h2 className="text-lg font-semibold">Live status</h2>
                <div className="mt-4 space-y-4 text-sm text-slate-300">
                  <StatusRow name="Host" value={showLoading ? "--" : liveData?.hostname ?? "--"} />
                  <StatusRow name="OS" value={showLoading ? "--" : liveData?.platform ?? "--"} />
                  <StatusRow name="Release" value={showLoading ? "--" : liveData?.release ?? "--"} />
                  <StatusRow name="Arch" value={showLoading ? "--" : liveData?.arch ?? "--"} />
                  <StatusRow name="CPU" value={showLoading ? "--" : `${liveData?.cpu.cores ?? 0} cores • ${liveData?.cpu.speed ?? 0} MHz`} />
                  <StatusRow name="Memory" value={showLoading ? "--" : `${formatBytes(liveData?.memory.used ?? 0)} / ${formatBytes(liveData?.memory.total ?? 0)}`} />
                  <StatusRow name="Throughput" value={showLoading ? "--" : `${totalThroughput.toFixed(1)} KB/s`} />
                </div>
              </div>

              {(cpuWarning || memWarning || netWarning) && (
                <div className="rounded-3xl border border-rose-500/40 bg-rose-500/10 p-6 text-sm text-rose-100">
                  <h3 className="font-semibold text-rose-100">Warning</h3>
                  <p className="mt-2 text-slate-200">
                    {cpuWarning && "CPU usage is above the threshold."}
                    {cpuWarning && memWarning ? " " : ""}
                    {memWarning && "Memory usage is above the threshold."}
                    {(cpuWarning || memWarning) && netWarning ? " " : ""}
                    {netWarning && "Network throughput is above the threshold."}
                  </p>
                </div>
              )}
            </aside>
          </div>
        </div>
      </div>
    </main>
  );
}

function MetricCard({
  title,
  value,
  detail,
  warning,
}: {
  title: string;
  value: string;
  detail: string;
  warning?: boolean;
}) {
  return (
    <div
      className={`rounded-3xl border p-5 shadow-lg shadow-slate-950/10 ${
        warning ? "border-rose-400/40 bg-rose-500/10" : "border-slate-800 bg-slate-950/80"
      }`}
    >
      <p className="text-sm uppercase tracking-[0.2em] text-slate-500">{title}</p>
      <p className="mt-4 text-3xl font-semibold text-white">{value}</p>
      <p className="mt-2 text-sm text-slate-400">{detail}</p>
    </div>
  );
}

function GraphCard({
  title,
  data,
  threshold,
  unit,
  warning,
  color,
}: {
  title: string;
  data: StatPoint[];
  threshold: number;
  unit: string;
  warning: boolean;
  color: string;
}) {
  const latest = data[data.length - 1]?.value ?? 0;
  const gradientId = `grad-${title.replace(/\s+/g, "-")}`;

  return (
    <div className={`rounded-3xl border p-6 ${warning ? "border-rose-400/40 bg-rose-500/10" : "border-slate-800 bg-slate-950/80"}`}>
      <div className="flex items-center justify-between gap-4">
        <div>
          <h3 className="text-lg font-semibold text-white">{title}</h3>
          <p className="text-sm text-slate-400">Live snapshot · dashed line = threshold</p>
        </div>
        <span className="rounded-full bg-slate-800 px-3 py-1 text-xs uppercase tracking-[0.2em] text-slate-400">{unit}</span>
      </div>
      <div className="mt-5 h-48">
        {data.length > 1 ? (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 8, right: 4, left: -24, bottom: 0 }}>
              <defs>
                <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={color} stopOpacity={0.3} />
                  <stop offset="95%" stopColor={color} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <XAxis
                dataKey="time"
                tick={{ fill: "#64748b", fontSize: 10 }}
                tickLine={false}
                axisLine={false}
                interval="preserveStartEnd"
              />
              <YAxis
                tick={{ fill: "#64748b", fontSize: 10 }}
                tickLine={false}
                axisLine={false}
                domain={[0, (dataMax: number) => Math.max(dataMax * 1.15, threshold * 1.1)]}
              />
              <Tooltip
                contentStyle={{
                  background: "#0f172a",
                  border: "1px solid #1e293b",
                  borderRadius: "12px",
                  color: "#e2e8f0",
                  fontSize: "12px",
                }}
                formatter={(val: number) => [`${val.toFixed(1)} ${unit}`, title]}
              />
              <ReferenceLine
                y={threshold}
                stroke="#fb7185"
                strokeDasharray="6 3"
                strokeWidth={1.5}
                label={{
                  value: `${threshold} ${unit}`,
                  fill: "#fb7185",
                  fontSize: 10,
                  position: "insideTopRight" as const,
                }}
              />
              <Area
                type="monotone"
                dataKey="value"
                stroke={color}
                strokeWidth={2}
                fill={`url(#${gradientId})`}
                dot={false}
                activeDot={{ r: 4, fill: color }}
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-slate-500">
            Collecting data…
          </div>
        )}
      </div>
      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        <StatBadge label="Threshold" value={`${threshold} ${unit}`} />
        <StatBadge label="Latest" value={`${latest.toFixed(1)} ${unit}`} />
      </div>
    </div>
  );
}

function ThresholdControl({
  label,
  value,
  onChange,
  suffix,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  suffix: string;
}) {
  return (
    <div className="space-y-2 rounded-3xl border border-slate-800 bg-slate-950/80 p-4">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm font-medium text-slate-200">{label} threshold</p>
        <span className="rounded-full bg-slate-800 px-2 py-1 text-xs uppercase tracking-[0.2em] text-slate-400">{value}{suffix}</span>
      </div>
      <input
        type="range"
        min="0"
        max={label === "Network" ? 5000 : 100}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="w-full accent-sky-400"
      />
    </div>
  );
}

function StatusRow({ name, value }: { name: string; value: string }) {
  return (
    <div className="flex items-center justify-between rounded-2xl bg-slate-950/70 px-4 py-3 text-slate-300">
      <span>{name}</span>
      <strong className="text-slate-100">{value}</strong>
    </div>
  );
}

function StatBadge({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl bg-slate-950/80 px-4 py-3 text-sm text-slate-300">
      <p className="text-xs uppercase tracking-[0.2em] text-slate-500">{label}</p>
      <p className="mt-1 font-semibold text-white">{value}</p>
    </div>
  );
}
