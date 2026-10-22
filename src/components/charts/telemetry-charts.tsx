"use client";

import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { TelemetryPointDto } from "@/lib/types";
import { formatBytes } from "@/lib/format";

/**
 * Recharts wrappers. This module is imported with `ssr: false` so the chart
 * library never runs during prerender (it touches `window`/measurement APIs).
 */

const AXIS_STYLE = { fontSize: 11, fill: "var(--on-surface-variant)" } as const;
const GRID_STROKE = "var(--outline-variant)";

function formatTick(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export interface ChartProps {
  points: readonly TelemetryPointDto[];
}

export function CpuChart({ points }: ChartProps) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={points as TelemetryPointDto[]} margin={{ top: 8, right: 12, bottom: 0, left: -12 }}>
        <CartesianGrid stroke={GRID_STROKE} strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="capturedAt" tickFormatter={formatTick} tick={AXIS_STYLE} minTickGap={32} />
        <YAxis domain={[0, 100]} tick={AXIS_STYLE} width={40} unit="%" />
        <Tooltip
          labelFormatter={(value) => new Date(String(value)).toLocaleString()}
          formatter={(value) => [`${Number(value).toFixed(1)}%`, "CPU"]}
          contentStyle={{ fontSize: 12 }}
        />
        <Line
          type="monotone"
          dataKey="cpuPct"
          name="CPU"
          stroke="var(--primary)"
          strokeWidth={2}
          dot={false}
          connectNulls
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

export function MemoryChart({ points }: ChartProps) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={points as TelemetryPointDto[]} margin={{ top: 8, right: 12, bottom: 0, left: -12 }}>
        <defs>
          <linearGradient id="memFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--primary)" stopOpacity={0.4} />
            <stop offset="100%" stopColor="var(--primary)" stopOpacity={0.05} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke={GRID_STROKE} strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="capturedAt" tickFormatter={formatTick} tick={AXIS_STYLE} minTickGap={32} />
        <YAxis domain={[0, 100]} tick={AXIS_STYLE} width={40} unit="%" />
        <Tooltip
          labelFormatter={(value) => new Date(String(value)).toLocaleString()}
          formatter={(value) => [`${Number(value).toFixed(1)}%`, "Memory"]}
          contentStyle={{ fontSize: 12 }}
        />
        <Area
          type="monotone"
          dataKey="memUsedPct"
          name="Memory"
          stroke="var(--primary)"
          strokeWidth={2}
          fill="url(#memFill)"
          connectNulls
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function DiskUsageChart({ points }: ChartProps) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={points as TelemetryPointDto[]} margin={{ top: 8, right: 12, bottom: 0, left: -12 }}>
        <defs>
          <linearGradient id="diskFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--warning)" stopOpacity={0.4} />
            <stop offset="100%" stopColor="var(--warning)" stopOpacity={0.05} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke={GRID_STROKE} strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="capturedAt" tickFormatter={formatTick} tick={AXIS_STYLE} minTickGap={32} />
        <YAxis domain={[0, 100]} tick={AXIS_STYLE} width={40} unit="%" />
        <Tooltip
          labelFormatter={(value) => new Date(String(value)).toLocaleString()}
          formatter={(value) => [`${Number(value).toFixed(1)}%`, "Disk"]}
          contentStyle={{ fontSize: 12 }}
        />
        <Area
          type="monotone"
          dataKey="diskUsedPct"
          name="Disk"
          stroke="var(--warning)"
          strokeWidth={2}
          fill="url(#diskFill)"
          connectNulls
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function NetworkChart({ points }: ChartProps) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={points as TelemetryPointDto[]} margin={{ top: 8, right: 12, bottom: 0, left: 4 }}>
        <CartesianGrid stroke={GRID_STROKE} strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="capturedAt" tickFormatter={formatTick} tick={AXIS_STYLE} minTickGap={32} />
        <YAxis tick={AXIS_STYLE} width={64} tickFormatter={(value) => formatBytes(Number(value))} />
        <Tooltip
          labelFormatter={(value) => new Date(String(value)).toLocaleString()}
          formatter={(value, name) => [`${formatBytes(Number(value))}/s`, String(name)]}
          contentStyle={{ fontSize: 12 }}
        />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Line
          type="monotone"
          dataKey="netRxRateBps"
          name="RX"
          stroke="var(--primary)"
          strokeWidth={2}
          dot={false}
          connectNulls
        />
        <Line
          type="monotone"
          dataKey="netTxRateBps"
          name="TX"
          stroke="var(--success)"
          strokeWidth={2}
          dot={false}
          connectNulls
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

export function LoadChart({ points }: ChartProps) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={points as TelemetryPointDto[]} margin={{ top: 8, right: 12, bottom: 0, left: -12 }}>
        <CartesianGrid stroke={GRID_STROKE} strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="capturedAt" tickFormatter={formatTick} tick={AXIS_STYLE} minTickGap={32} />
        <YAxis tick={AXIS_STYLE} width={40} />
        <Tooltip
          labelFormatter={(value) => new Date(String(value)).toLocaleString()}
          contentStyle={{ fontSize: 12 }}
        />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Line type="monotone" dataKey="load1" name="1m" stroke="var(--primary)" strokeWidth={2} dot={false} connectNulls />
        <Line type="monotone" dataKey="load5" name="5m" stroke="var(--warning)" strokeWidth={2} dot={false} connectNulls />
        <Line type="monotone" dataKey="load15" name="15m" stroke="var(--success)" strokeWidth={2} dot={false} connectNulls />
      </LineChart>
    </ResponsiveContainer>
  );
}
