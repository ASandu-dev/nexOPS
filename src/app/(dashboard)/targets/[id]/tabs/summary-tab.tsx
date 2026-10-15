"use client";

import { AlertTriangle, Info } from "lucide-react";
import type { TargetDetailDto, TelemetryDto } from "@/lib/types";
import { formatBytes, formatDuration, formatPercent } from "@/lib/format";
import { isOlderThan, percentOf } from "@/lib/display";
import { Badge, Card, CardContent, CardHeader, CardTitle, Meter } from "@/components/ui";
import { RelativeTime } from "@/components/common/relative-time";

const TELEMETRY_STALE_MS = 2 * 60 * 1000;

export interface SummaryTabProps {
  target: TargetDetailDto;
  latest: TelemetryDto | null;
}

export function SummaryTab({ target, latest }: SummaryTabProps) {
  const telemetryStale = isOlderThan(target.lastTelemetryAt, TELEMETRY_STALE_MS);
  const memPct = latest ? percentOf(latest.memUsedBytes, latest.memTotalBytes) : null;
  const diskPct = latest ? percentOf(latest.diskUsedBytes, latest.diskTotalBytes) : null;

  return (
    <div className="flex flex-col gap-5">
      {target.warnings.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertTriangle className="size-4 text-warning" aria-hidden="true" />
              Warnings
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-2">
              {target.warnings.map((warning) => (
                <li key={`${warning.code}-${warning.message}`} className="flex items-start gap-2 text-sm">
                  <Badge variant="degraded">{warning.code.replace(/_/g, " ").toLowerCase()}</Badge>
                  <span className="text-on-surface">{warning.message}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>System</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
              <Field label="Hostname">{target.hostname ?? target.hostnameOverride ?? "—"}</Field>
              <Field label="Operating system">
                {target.os}
                {target.osVersion ? ` ${target.osVersion}` : ""}
              </Field>
              <Field label="Architecture">{target.arch ?? "—"}</Field>
              <Field label="Agent version">{target.agent?.agentVersion ?? "—"}</Field>
              <Field label="Last contact">
                <RelativeTime value={target.lastHeartbeatAt} />
              </Field>
              <Field label="Uptime">
                {latest?.uptimeSec === null || latest?.uptimeSec === undefined
                  ? "—"
                  : formatDuration(latest.uptimeSec)}
              </Field>
              <Field label="Last telemetry">
                <span className="flex items-center gap-1.5">
                  <RelativeTime value={target.lastTelemetryAt} />
                  {telemetryStale ? (
                    <Badge variant="degraded" withDot>
                      stale
                    </Badge>
                  ) : null}
                </span>
              </Field>
              <Field label="Enrolled">
                <RelativeTime value={target.agent?.enrolledAt ?? null} />
              </Field>
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Resource usage</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            {latest === null ? (
              <p className="flex items-center gap-2 text-sm text-on-surface-variant">
                <Info className="size-4" aria-hidden="true" />
                No telemetry reported yet.
              </p>
            ) : (
              <>
                <Meter
                  label="CPU"
                  value={latest.cpuPct}
                  detail={formatPercent(latest.cpuPct)}
                />
                <Meter
                  label="Memory"
                  value={memPct}
                  detail={`${formatBytes(latest.memUsedBytes)} / ${formatBytes(latest.memTotalBytes)}`}
                />
                <Meter
                  label="Disk"
                  value={diskPct}
                  detail={
                    latest.diskUsedBytes !== null && latest.diskTotalBytes !== null
                      ? `${formatBytes(latest.diskUsedBytes)} / ${formatBytes(latest.diskTotalBytes)}`
                      : "—"
                  }
                />
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs font-medium uppercase tracking-wide text-on-surface-variant">{label}</dt>
      <dd className="text-on-surface">{children}</dd>
    </div>
  );
}
