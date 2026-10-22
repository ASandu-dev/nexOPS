"use client";

import { useState } from "react";
import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Cpu,
  HardDrive,
  ListChecks,
  MemoryStick,
  Server,
  WifiOff,
} from "lucide-react";
import type { JobDto, OverviewDto } from "@/lib/types";
import { useApi } from "@/lib/use-api";
import { formatPercent } from "@/lib/format";
import { prettifyAction } from "@/lib/display";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  ErrorState,
  Skeleton,
  StatusBadge,
} from "@/components/ui";
import { PageHeader } from "@/components/common/page-header";
import { StatCard } from "@/components/common/stat-card";
import { RelativeTime } from "@/components/common/relative-time";
import { JobsTable } from "@/components/jobs/jobs-table";
import { JobDetailDialog } from "@/components/jobs/job-detail-dialog";

export function OverviewClient() {
  const { data, error, loading, refresh } = useApi<OverviewDto>("/api/overview", {
    refreshIntervalMs: 15000,
  });
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);

  if (loading) return <OverviewSkeleton />;

  if (error) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Overview" description="Fleet health at a glance." />
        <ErrorState message={error.message} onRetry={refresh} />
      </div>
    );
  }

  if (!data) return null;

  const { totals, fleet } = data;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Overview" description="Fleet health at a glance." />

      <section aria-label="Fleet summary" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Total targets" value={totals.targets} icon={<Server className="size-4" />} href="/targets" />
        <StatCard
          label="Online"
          value={totals.online}
          tone="success"
          icon={<CheckCircle2 className="size-4" />}
          href="/targets?status=ONLINE"
        />
        <StatCard
          label="Offline"
          value={totals.offline}
          tone={totals.offline > 0 ? "error" : "default"}
          icon={<WifiOff className="size-4" />}
          href="/targets?status=OFFLINE"
        />
        <StatCard
          label="Degraded"
          value={totals.degraded}
          tone={totals.degraded > 0 ? "warning" : "default"}
          icon={<AlertTriangle className="size-4" />}
          href="/targets?status=DEGRADED"
        />
        <StatCard
          label="Pending enrolment"
          value={totals.pendingEnrolment}
          tone="info"
          href="/targets?status=PENDING_ENROLMENT"
        />
        <StatCard
          label="Active jobs"
          value={data.activeJobs.length}
          icon={<ListChecks className="size-4" />}
          href="/jobs"
        />
        <StatCard
          label="Failed jobs (24h)"
          value={data.failedJobs.length}
          tone={data.failedJobs.length > 0 ? "error" : "default"}
          href="/jobs?status=FAILED,TIMED_OUT"
        />
        <StatCard
          label="Fleet averages"
          value={
            <span className="flex flex-col gap-0.5 text-base">
              <span className="flex items-center gap-1.5">
                <Cpu className="size-3.5" aria-hidden="true" /> {formatPercent(fleet.avgCpuPct)}
              </span>
              <span className="flex items-center gap-1.5">
                <MemoryStick className="size-3.5" aria-hidden="true" /> {formatPercent(fleet.avgMemUsedPct)}
              </span>
              <span className="flex items-center gap-1.5">
                <HardDrive className="size-3.5" aria-hidden="true" /> {formatPercent(fleet.avgDiskUsedPct)}
              </span>
            </span>
          }
          hint={`${fleet.sampledTargets} target(s) sampled`}
        />
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Needs attention</CardTitle>
          </CardHeader>
          <CardContent>
            {data.degradedTargets.length === 0 ? (
              <EmptyState
                icon={<CheckCircle2 className="size-5" />}
                title="All targets healthy"
                description="No degraded or offline targets right now."
              />
            ) : (
              <ul className="flex flex-col divide-y divide-outline-variant">
                {data.degradedTargets.map((target) => (
                  <li key={target.id}>
                    <Link
                      href={`/targets/${target.id}`}
                      className="flex items-center justify-between gap-3 py-2.5 transition-colors hover:text-primary"
                    >
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate font-medium">{target.name}</span>
                        <span className="truncate text-xs text-on-surface-variant">
                          {target.hostname ?? target.hostnameOverride ?? target.os}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-3">
                        <RelativeTime
                          value={target.lastHeartbeatAt}
                          className="text-xs text-on-surface-variant"
                        />
                        <StatusBadge status={target.status} />
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent activity</CardTitle>
          </CardHeader>
          <CardContent>
            {data.recentAudit.length === 0 ? (
              <EmptyState
                icon={<Activity className="size-5" />}
                title="No activity yet"
                description="Audit events will appear here as operators act."
              />
            ) : (
              <ul className="flex flex-col divide-y divide-outline-variant">
                {data.recentAudit.map((event) => (
                  <li key={event.id} className="flex items-center justify-between gap-3 py-2.5">
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-sm font-medium">{prettifyAction(event.action)}</span>
                      <span className="truncate text-xs text-on-surface-variant">{event.actorId}</span>
                    </span>
                    <RelativeTime value={event.createdAt} className="shrink-0 text-xs text-on-surface-variant" />
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Recent jobs</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {data.recentJobs.length === 0 ? (
            <div className="p-4">
              <EmptyState
                icon={<ListChecks className="size-5" />}
                title="No jobs yet"
                description="Queue a job from the Jobs page to see it here."
              />
            </div>
          ) : (
            <JobsTable
              jobs={data.recentJobs}
              onSelect={(job: JobDto) => setSelectedJobId(job.id)}
              onRetried={() => refresh()}
            />
          )}
        </CardContent>
      </Card>

      <JobDetailDialog
        jobId={selectedJobId}
        open={selectedJobId !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedJobId(null);
        }}
        onChanged={refresh}
      />
    </div>
  );
}

function OverviewSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Overview" description="Fleet health at a glance." />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 8 }, (_, index) => (
          <Skeleton key={index} className="h-24 w-full" />
        ))}
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
      <Skeleton className="h-72 w-full" />
    </div>
  );
}
