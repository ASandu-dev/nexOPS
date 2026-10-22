import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import type { FleetMachineDto } from "@/lib/types";
import { formatPercent } from "@/lib/format";
import { cn } from "@/lib/cn";
import {
  Badge,
  StatusBadge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui";
import { RelativeTime } from "@/components/common/relative-time";
import { ResourceWarningCount, type ResourceWarning } from "@/components/targets/resource-warnings";

/** Severity of a metric cell; mirrors the server-derived warning severities. */
type Severity = "default" | "warning" | "critical";

const SEVERITY_CLASS: Record<Severity, string> = {
  default: "text-on-surface",
  warning: "text-warning",
  critical: "text-error",
};

export interface FleetStatusTableProps {
  machines: readonly FleetMachineDto[];
}

/**
 * Fleet status table: one row per machine, already ordered trouble-first by the
 * server.
 *
 * Rows are not clickable; the machine name is the navigation affordance, so the
 * table is fully usable with the keyboard and with assistive technology.
 */
export function FleetStatusTable({ machines }: FleetStatusTableProps) {
  return (
    <Table aria-label="Fleet status">
      <TableHeader>
        <TableRow>
          <TableHead>Machine</TableHead>
          <TableHead>Connection</TableHead>
          <TableHead className="hidden sm:table-cell">Agent</TableHead>
          <TableHead>CPU</TableHead>
          <TableHead>Memory</TableHead>
          <TableHead className="hidden sm:table-cell">Swap</TableHead>
          <TableHead>Disk</TableHead>
          <TableHead>Warnings</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {machines.map((machine) => (
          <FleetStatusRow key={machine.id} machine={machine} />
        ))}
      </TableBody>
    </Table>
  );
}

function FleetStatusRow({ machine }: { machine: FleetMachineDto }) {
  const warnings = machine.warnings;
  // Severity comes from the warnings the server derived for this machine, so a
  // metric cell and the warning pills can never disagree.
  const cpuSeverity = severityFor(warnings, (warning) => warning.code === "cpu_high");
  const diskSeverity = severityFor(
    warnings,
    (warning) => warning.code === "disk_high" || warning.code === "disk_critical",
  );
  // Telemetry only advances when a beat carried a sample, so an older
  // telemetry timestamp means the metrics lag behind the connection.
  const telemetryBehind = isBefore(machine.lastTelemetryAt, machine.lastHeartbeatAt);

  return (
    <TableRow>
      <TableCell>
        <Link
          href={`/targets/${machine.id}`}
          className="font-medium text-primary hover:underline focus-visible:ring-2 focus-visible:ring-primary"
        >
          {machine.name}
        </Link>
      </TableCell>

      <TableCell>
        <span className="flex flex-col items-start gap-1">
          <StatusBadge status={machine.status} />
          <span className="hidden flex-col items-start gap-0.5 sm:flex">
            <RelativeTime
              value={machine.lastHeartbeatAt}
              className="whitespace-nowrap text-xs text-on-surface-variant"
            />
            {telemetryBehind ? (
              <span className="flex items-center gap-1 whitespace-nowrap text-xs text-on-surface-variant">
                metrics
                <RelativeTime value={machine.lastTelemetryAt} />
              </span>
            ) : null}
          </span>
        </span>
      </TableCell>

      <TableCell className="hidden whitespace-nowrap sm:table-cell">
        {machine.agentVersion === null ? (
          <span className="text-on-surface-variant">—</span>
        ) : (
          machine.agentVersion
        )}
      </TableCell>

      <TableCell>
        <MetricValue value={machine.cpuPct} severity={cpuSeverity} warningText="CPU high" />
      </TableCell>

      <TableCell className="whitespace-nowrap">
        {machine.memAvailablePct === null ? (
          <span className="text-on-surface-variant">—</span>
        ) : (
          <span className="flex items-baseline gap-1">
            <span className="tabular-nums">{formatPercent(machine.memAvailablePct)}</span>
            <span className="text-xs text-on-surface-variant">free</span>
          </span>
        )}
      </TableCell>

      <TableCell className="hidden whitespace-nowrap tabular-nums sm:table-cell">
        {machine.swapUsedPct === null ? (
          <span className="text-on-surface-variant">—</span>
        ) : (
          formatPercent(machine.swapUsedPct)
        )}
      </TableCell>

      <TableCell>
        <span className="flex flex-col gap-0.5">
          <MetricValue
            value={machine.diskWorstUsedPct}
            severity={diskSeverity}
            warningText={diskSeverity === "critical" ? "Disk critical" : "Disk high"}
          />
          {machine.diskWorstMount === null ? null : (
            <span
              className="max-w-[10rem] truncate text-xs text-on-surface-variant"
              title={machine.diskWorstMount}
            >
              {machine.diskWorstMount}
            </span>
          )}
        </span>
      </TableCell>

      <TableCell>
        <span className="flex flex-wrap items-center gap-1.5">
          <ResourceWarningCount warnings={warnings} />
          {machine.collectionErrorCount > 0 ? (
            <Badge
              variant="degraded"
              title={`${machine.collectionErrorCount} metric collector(s) failed on the last check-in`}
            >
              <AlertTriangle className="size-3" aria-hidden="true" />
              {machine.collectionErrorCount} {machine.collectionErrorCount === 1 ? "error" : "errors"}
            </Badge>
          ) : null}
          {warnings.length === 0 && machine.collectionErrorCount === 0 ? (
            <span className="text-on-surface-variant">—</span>
          ) : null}
        </span>
      </TableCell>
    </TableRow>
  );
}

/**
 * A metric value with severity styling.
 *
 * The severity is repeated as text for assistive technology so the state never
 * depends on colour alone.
 */
function MetricValue({
  value,
  severity,
  warningText,
}: {
  value: number | null;
  severity: Severity;
  warningText: string;
}) {
  if (value === null) return <span className="text-on-surface-variant">—</span>;

  return (
    <span className={cn("tabular-nums", SEVERITY_CLASS[severity])}>
      {formatPercent(value)}
      {severity === "default" ? null : <span className="sr-only"> — {warningText}</span>}
    </span>
  );
}

/** Highest severity among the warnings matching `matches`. */
function severityFor(
  warnings: readonly ResourceWarning[],
  matches: (warning: ResourceWarning) => boolean,
): Severity {
  if (warnings.some((warning) => matches(warning) && warning.severity === "critical")) {
    return "critical";
  }
  if (warnings.some((warning) => matches(warning))) return "warning";
  return "default";
}

/** True when `earlier` is a valid timestamp strictly before `later`. */
function isBefore(earlier: string | null, later: string | null): boolean {
  if (earlier === null || later === null) return false;
  const left = new Date(earlier).getTime();
  const right = new Date(later).getTime();
  if (Number.isNaN(left) || Number.isNaN(right)) return false;
  return left < right;
}
