import { AlertTriangle, OctagonAlert } from "lucide-react";
import type { TelemetrySeriesDto } from "@/lib/types";
import { Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui";

/**
 * Resource-pressure warning as delivered by the telemetry series DTO.
 *
 * The warnings are derived server-side at read time (`src/lib/server/warnings.ts`),
 * so the UI only renders them. Deriving the type from the DTO keeps the UI
 * independent of the server module layout.
 */
export type ResourceWarning = TelemetrySeriesDto["warnings"][number];

/** Short, human label per warning code. */
const WARNING_LABEL: Record<ResourceWarning["code"], string> = {
  cpu_high: "CPU high",
  mem_low: "Memory low",
  swap_high: "Swap high",
  disk_high: "Disk high",
  disk_critical: "Disk critical",
  metrics_degraded: "Metrics degraded",
};

export interface ResourceWarningBadgeProps {
  warning: ResourceWarning;
}

/**
 * Severity pill for a single warning.
 *
 * The visible text carries the warning kind and the icon differs per severity,
 * so the state never depends on colour alone. Screen readers additionally get
 * the severity as text.
 */
export function ResourceWarningBadge({ warning }: ResourceWarningBadgeProps) {
  const critical = warning.severity === "critical";
  const Icon = critical ? OctagonAlert : AlertTriangle;

  return (
    <Badge variant={critical ? "error" : "degraded"}>
      <Icon className="size-3" aria-hidden="true" />
      <span className="sr-only">{critical ? "Critical: " : "Warning: "}</span>
      {WARNING_LABEL[warning.code]}
    </Badge>
  );
}

export interface ResourceWarningsProps {
  warnings: readonly ResourceWarning[];
}

/**
 * Full warnings strip: one row per warning with the server-rendered message.
 * Renders nothing when there is no warning, so healthy targets stay quiet.
 */
export function ResourceWarnings({ warnings }: ResourceWarningsProps) {
  if (warnings.length === 0) return null;
  const critical = warnings.some((warning) => warning.severity === "critical");

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <AlertTriangle className="size-4 text-warning" aria-hidden="true" />
          Resource warnings
          <Badge variant={critical ? "error" : "degraded"}>
            {warnings.length} {warnings.length === 1 ? "warning" : "warnings"}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col gap-2">
          {warnings.map((warning) => (
            <li
              key={`${warning.code}-${warning.message}`}
              className="flex flex-wrap items-center gap-2 text-sm"
            >
              <ResourceWarningBadge warning={warning} />
              <span className="text-on-surface">{warning.message}</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

/**
 * Compact at-a-glance rendering (count plus one badge per warning) for the
 * Summary tab, so trouble is visible without opening Monitoring.
 */
export function ResourceWarningSummary({ warnings }: ResourceWarningsProps) {
  if (warnings.length === 0) {
    return <span className="text-on-surface-variant">None</span>;
  }
  const critical = warnings.some((warning) => warning.severity === "critical");

  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <Badge variant={critical ? "error" : "degraded"}>
        {warnings.length} {warnings.length === 1 ? "warning" : "warnings"}
      </Badge>
      {warnings.map((warning) => (
        <ResourceWarningBadge
          key={`${warning.code}-${warning.message}`}
          warning={warning}
        />
      ))}
    </span>
  );
}
