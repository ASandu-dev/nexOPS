"use client";

import dynamic from "next/dynamic";
import { Activity } from "lucide-react";
import type { ApiError } from "@/lib/use-api";
import type { TelemetryRange, TelemetrySeriesDto } from "@/lib/types";
import { TELEMETRY_RANGES } from "@/lib/types";
import { formatBytes, formatPercent } from "@/lib/format";
import { percentOf } from "@/lib/display";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  ErrorState,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui";
import { FilterChips } from "@/components/common/filter-chips";

const CpuChart = dynamic(
  () => import("@/components/charts/telemetry-charts").then((module) => module.CpuChart),
  { ssr: false, loading: () => <ChartSkeleton /> },
);
const MemoryChart = dynamic(
  () => import("@/components/charts/telemetry-charts").then((module) => module.MemoryChart),
  { ssr: false, loading: () => <ChartSkeleton /> },
);
const NetworkChart = dynamic(
  () => import("@/components/charts/telemetry-charts").then((module) => module.NetworkChart),
  { ssr: false, loading: () => <ChartSkeleton /> },
);
const LoadChart = dynamic(
  () => import("@/components/charts/telemetry-charts").then((module) => module.LoadChart),
  { ssr: false, loading: () => <ChartSkeleton /> },
);

const RANGE_OPTIONS = TELEMETRY_RANGES.map((range) => ({ value: range, label: range }));

export interface MonitoringTabProps {
  series: TelemetrySeriesDto | null;
  loading: boolean;
  error: ApiError | null;
  range: TelemetryRange;
  onRangeChange: (range: TelemetryRange) => void;
  onRefresh: () => void;
}

export function MonitoringTab({
  series,
  loading,
  error,
  range,
  onRangeChange,
  onRefresh,
}: MonitoringTabProps) {
  const points = series?.points ?? [];
  const latest = series?.latest ?? null;
  const hasLoadSeries = points.some((point) => point.load1 !== undefined && point.load1 !== null);

  return (
    <div className="flex flex-col gap-5">
      <FilterChips
        label="Time range"
        options={RANGE_OPTIONS}
        selected={[range]}
        onChange={(next) => {
          const selected = next[next.length - 1];
          if (selected) onRangeChange(selected as TelemetryRange);
        }}
      />

      {loading ? (
        <Skeleton className="h-72 w-full" />
      ) : error ? (
        <ErrorState message={error.message} onRetry={onRefresh} />
      ) : points.length === 0 ? (
        <EmptyState
          icon={<Activity className="size-5" />}
          title="No telemetry in this range"
          description="The target has not reported metrics for the selected window."
        />
      ) : (
        <>
          <div className="grid gap-5 lg:grid-cols-2">
            <ChartCard title="CPU usage">
              <CpuChart points={points} />
            </ChartCard>
            <ChartCard title="Memory usage">
              <MemoryChart points={points} />
            </ChartCard>
            <ChartCard title="Network throughput">
              <NetworkChart points={points} />
            </ChartCard>
            <ChartCard title="Load average">
              {hasLoadSeries ? (
                <LoadChart points={points} />
              ) : (
                <div className="flex h-full items-center justify-center gap-6">
                  <LoadStat label="1 min" value={latest?.load1 ?? null} />
                  <LoadStat label="5 min" value={latest?.load5 ?? null} />
                  <LoadStat label="15 min" value={latest?.load15 ?? null} />
                </div>
              )}
            </ChartCard>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Filesystems</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {latest === null || latest.disks.length === 0 ? (
                <p className="p-4 text-sm text-on-surface-variant">No filesystem data reported.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Mount</TableHead>
                      <TableHead>FS</TableHead>
                      <TableHead>Used / Total</TableHead>
                      <TableHead>Used %</TableHead>
                      <TableHead className="hidden sm:table-cell">Inodes %</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {latest.disks.map((disk) => {
                      const usedPct = percentOf(disk.usedBytes, disk.totalBytes);
                      const inodePct = percentOf(disk.inodesUsed, disk.inodesTotal);
                      return (
                        <TableRow key={`${disk.mount}-${disk.fsType}`}>
                          <TableCell className="font-medium">{disk.mount}</TableCell>
                          <TableCell>{disk.fsType}</TableCell>
                          <TableCell className="whitespace-nowrap tabular-nums">
                            {formatBytes(disk.usedBytes)} / {formatBytes(disk.totalBytes)}
                          </TableCell>
                          <TableCell className="tabular-nums">{formatPercent(usedPct)}</TableCell>
                          <TableCell className="hidden tabular-nums sm:table-cell">
                            {formatPercent(inodePct)}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </>
      )}

      {series === null ? null : (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onRefresh}
            className="text-sm text-primary hover:underline focus-visible:ring-2 focus-visible:ring-primary"
          >
            Refresh data
          </button>
        </div>
      )}
    </div>
  );
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="h-64 w-full">{children}</div>
      </CardContent>
    </Card>
  );
}

function ChartSkeleton() {
  return <Skeleton className="h-full w-full" />;
}

function LoadStat({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="flex flex-col items-center gap-1">
      <span className="text-2xl font-semibold tabular-nums text-on-surface">
        {value === null ? "—" : value.toFixed(2)}
      </span>
      <span className="text-xs text-on-surface-variant">{label}</span>
    </div>
  );
}
