import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

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

const fetchOsMetrics = async () => {
  const response = await fetch("/api/os");
  if (!response.ok) {
    throw new Error("Unable to load OS data");
  }
  return response.json() as Promise<OsMetric>;
};

function Index() {
  const [cpuHistory, setCpuHistory] = useState<StatPoint[]>([]);
  const [memHistory, setMemHistory] = useState<StatPoint[]>([]);
  const [netHistory, setNetHistory] = useState<StatPoint[]>([]);
  const [cpuThreshold, setCpuThreshold] = useState(80);
  const [memThreshold, setMemThreshold] = useState(85);
  const [netThreshold, setNetThreshold] = useState(1024);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["osMetrics"],
    queryFn: fetchOsMetrics,
    refetchInterval: 2000,
    staleTime: 1000,
  });

  useEffect(() => {
    if (!data) return;

    const now = new Date();
    const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
    const totalThroughput = data.throughput.reduce((sum, item) => sum + item.rxKb + item.txKb, 0);

    setCpuHistory((prev) => [...prev.slice(-19), { time, value: data.cpu.usagePercent }]);
    setMemHistory((prev) => [...prev.slice(-19), { time, value: data.memory.usedPercent }]);
    setNetHistory((prev) => [...prev.slice(-19), { time, value: totalThroughput }]);
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

  const totalThroughput = useMemo(
    () => data?.throughput.reduce((sum, item) => sum + item.rxKb + item.txKb, 0) ?? 0,
    [data],
  );

  const cpuWarning = data?.cpu.usagePercent != null && data.cpu.usagePercent > cpuThreshold;
  const memWarning = data?.memory.usedPercent != null && data.memory.usedPercent > memThreshold;
  const netWarning = totalThroughput > netThreshold;

  return (
    <main className="min-h-screen bg-slate-950 px-6 py-8 text-slate-100">
      <div className="mx-auto max-w-7xl">
        <div className="space-y-6 rounded-3xl border border-slate-800 bg-slate-900/95 p-6 shadow-2xl shadow-slate-950/40 sm:p-8">
          <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="inline-flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.2em] text-emerald-300">
                <span className="h-2.5 w-2.5 rounded-full bg-emerald-400" />
                Server Health Monitor
              </p>
              <h1 className="mt-3 text-3xl font-semibold sm:text-4xl">Live OS Dashboard</h1>
              <p className="mt-2 text-sm text-slate-400 sm:text-base">
                Real-time CPU, memory, and network throughput with alert thresholds.
              </p>
            </div>
            <button
              onClick={() => void refetch()}
              className="inline-flex items-center justify-center rounded-full border border-slate-700 bg-slate-800 px-4 py-2 text-sm font-semibold text-slate-100 transition hover:border-slate-500 hover:bg-slate-700"
            >
              Refresh Now
            </button>
          </header>

          <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
            <section className="grid gap-6">
              <div className="grid gap-6 sm:grid-cols-2">
                <MetricCard
                  title="RAM Usage"
                  value={isLoading ? "--" : `${data?.memory.usedPercent.toFixed(1)} %`}
                  detail={isLoading ? "Loading..." : `${formatBytes(data?.memory.used ?? 0)} / ${formatBytes(data?.memory.total ?? 0)}`}
                  warning={memWarning}
                />
                <MetricCard
                  title="CPU Usage"
                  value={isLoading ? "--" : `${data?.cpu.usagePercent.toFixed(1)} %`}
                  detail={isLoading ? "Loading..." : `${data?.cpu.model} • ${data?.cpu.cores} cores`}
                  warning={cpuWarning}
                />
                <MetricCard title="Uptime" value={isLoading ? "--" : formatUptime(data?.uptime ?? 0)} detail="Time since last reboot" />
                <MetricCard
                  title="Network Throughput"
                  value={isLoading ? "--" : `${totalThroughput.toFixed(1)} KB/s`}
                  detail={isLoading ? "Loading..." : `Threshold ${netThreshold} KB/s`}
                  warning={netWarning}
                />
              </div>

              <div className="grid gap-6">
                <GraphCard title="CPU usage" data={cpuHistory} threshold={cpuThreshold} unit="%" warning={cpuWarning} />
                <GraphCard title="Memory usage" data={memHistory} threshold={memThreshold} unit="%" warning={memWarning} />
                <GraphCard title="Network throughput" data={netHistory} threshold={netThreshold} unit="KB/s" warning={netWarning} />
              </div>
            </section>

            <aside className="space-y-6">
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
                  <StatusRow name="OS" value={isLoading ? "--" : data?.platform ?? "--"} />
                  <StatusRow name="Release" value={isLoading ? "--" : data?.release ?? "--"} />
                  <StatusRow name="Arch" value={isLoading ? "--" : data?.arch ?? "--"} />
                  <StatusRow name="Throughput" value={isLoading ? "--" : `${totalThroughput.toFixed(1)} KB/s`} />
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
}: {
  title: string;
  data: StatPoint[];
  threshold: number;
  unit: string;
  warning: boolean;
}) {
  const maxValue = Math.max(threshold, ...data.map((point) => point.value), 10);
  const points = data.map((point, index) => `${(index * 100) / Math.max(data.length - 1, 1)},${100 - (point.value / maxValue) * 100}`);
  const thresholdY = 100 - (threshold / maxValue) * 100;

  return (
    <div className={`rounded-3xl border p-6 ${warning ? "border-rose-400/40 bg-rose-500/10" : "border-slate-800 bg-slate-950/80"}`}>
      <div className="flex items-center justify-between gap-4">
        <div>
          <h3 className="text-lg font-semibold text-white">{title}</h3>
          <p className="text-sm text-slate-400">Current snapshot with threshold</p>
        </div>
        <span className="rounded-full bg-slate-800 px-3 py-1 text-xs uppercase tracking-[0.2em] text-slate-400">{unit}</span>
      </div>
      <div className="mt-5 h-48 overflow-hidden rounded-3xl bg-slate-950/60 p-3">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-full w-full">
          <path d={`M0,100 ${points.length ? "L" + points.join(" ") : ""} L100,100 Z`} fill="rgba(59,130,246,0.25)" stroke="transparent" />
          <path d={`M0,100 ${points.length ? "L" + points.join(" ") : ""}`} fill="none" stroke="#38bdf8" strokeWidth="2" />
          <line x1="0" y1="${thresholdY}" x2="100" y2="${thresholdY}" stroke="#fb7185" strokeDasharray="4 4" strokeWidth="1" />
        </svg>
      </div>
      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        <StatBadge label="Threshold" value={`${threshold} ${unit}`} />
        <StatBadge label="Latest" value={`${data[data.length - 1]?.value.toFixed(1) ?? 0} ${unit}`} />
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
