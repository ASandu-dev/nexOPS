import { formatBytes, formatPercent } from "@/lib/format";
import type { TelemetryDto } from "@/lib/types";

export type ResourceWarningCode =
  | "cpu_high"
  | "mem_low"
  | "swap_high"
  | "disk_high"
  | "disk_critical"
  | "metrics_degraded";

export interface ResourceWarning {
  code: ResourceWarningCode;
  severity: "warning" | "critical";
  message: string;
}

const CPU_HIGH_PCT = 90;
const MEM_LOW_AVAILABLE_RATIO = 0.1;
const SWAP_HIGH_RATIO = 0.5;
const DISK_CRITICAL_RATIO = 0.95;
const DISK_WARNING_RATIO = 0.9;

/**
 * Derives operator-facing resource-pressure warnings from the latest telemetry
 * snapshot. Pure and framework-free: callers pass a `TelemetryDto` and can use
 * the result from a Server Component, route handler, or test without Prisma.
 *
 * Warnings are derived at read time rather than persisted so threshold changes
 * apply retroactively to stored snapshots.
 */
export function deriveResourceWarnings(latest: TelemetryDto | null): ResourceWarning[] {
  if (!latest) return [];

  const warnings: ResourceWarning[] = [];

  if (latest.cpuPct !== null && latest.cpuPct > CPU_HIGH_PCT) {
    warnings.push({
      code: "cpu_high",
      severity: "warning",
      message: `CPU usage is ${formatPercent(latest.cpuPct)}.`,
    });
  }

  if (latest.memTotalBytes > 0) {
    const availableRatio = latest.memAvailableBytes / latest.memTotalBytes;
    if (availableRatio < MEM_LOW_AVAILABLE_RATIO) {
      warnings.push({
        code: "mem_low",
        severity: "warning",
        message: `Only ${formatPercent(availableRatio * 100)} of memory is available (${formatBytes(latest.memAvailableBytes)} of ${formatBytes(latest.memTotalBytes)}).`,
      });
    }
  }

  if (
    latest.swapTotalBytes !== null &&
    latest.swapTotalBytes > 0 &&
    latest.swapUsedBytes !== null
  ) {
    const usedRatio = latest.swapUsedBytes / latest.swapTotalBytes;
    if (usedRatio > SWAP_HIGH_RATIO) {
      warnings.push({
        code: "swap_high",
        severity: "warning",
        message: `Swap usage is ${formatPercent(usedRatio * 100, 0)} (${formatBytes(latest.swapUsedBytes)} of ${formatBytes(latest.swapTotalBytes)}).`,
      });
    }
  }

  for (const disk of latest.disks) {
    if (disk.totalBytes <= 0) continue;
    const usedRatio = disk.usedBytes / disk.totalBytes;
    if (usedRatio > DISK_CRITICAL_RATIO) {
      warnings.push({
        code: "disk_critical",
        severity: "critical",
        message: `Filesystem ${disk.mount} is ${formatPercent(usedRatio * 100)} full.`,
      });
    } else if (usedRatio > DISK_WARNING_RATIO) {
      warnings.push({
        code: "disk_high",
        severity: "warning",
        message: `Filesystem ${disk.mount} is ${formatPercent(usedRatio * 100)} full.`,
      });
    }
  }

  if (latest.collectionErrors.length > 0) {
    warnings.push({
      code: "metrics_degraded",
      severity: "warning",
      message: `${latest.collectionErrors.length} metric collector(s) failed on the last check-in`,
    });
  }

  // Stable, deterministic presentation order independent of collector order.
  return warnings.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
}
