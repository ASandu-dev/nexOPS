import type { ActorType, JobDto, JobStatus, JobType } from "@/lib/types";
import { formatDuration } from "@/lib/format";

/**
 * Presentation-only mappings shared across the dashboard. Kept free of React so
 * they can be used from both Server and Client Components.
 */

export const JOB_STATUS_LABEL: Record<JobStatus, string> = {
  QUEUED: "Queued",
  DISPATCHED: "Dispatched",
  RUNNING: "Running",
  SUCCEEDED: "Succeeded",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
  TIMED_OUT: "Timed out",
};

export const JOB_TYPE_LABEL: Record<JobType, string> = {
  APT_UPDATE: "APT update",
  APT_UPGRADE: "APT upgrade",
  APT_FIX_BROKEN: "Fix broken packages",
  CHECK_UPDATES: "Check updates",
  SERVICE_STATUS: "Service status",
  SELF_UPDATE: "Agent self-update",
};

export const JOB_TYPE_DESCRIPTION: Record<JobType, string> = {
  APT_UPDATE: "Refresh the APT package index (apt-get update).",
  APT_UPGRADE: "Install available package upgrades (apt-get upgrade).",
  APT_FIX_BROKEN: "Fix broken dependencies (apt-get -f install).",
  CHECK_UPDATES: "Report how many package updates are available.",
  SERVICE_STATUS: "Report the state of watched systemd services.",
  SELF_UPDATE: "Install the latest agent release and restart the agent.",
};

export const ACTOR_TYPE_LABEL: Record<ActorType, string> = {
  USER: "User",
  AGENT: "Agent",
  SYSTEM: "System",
};

/** `target.create` → `Target create`; keeps unknown actions readable. */
export function prettifyAction(action: string): string {
  const [scope, ...rest] = action.split(".");
  const head = scope ? scope.charAt(0).toUpperCase() + scope.slice(1) : action;
  return rest.length > 0 ? `${head} ${rest.join(" ")}` : head;
}

/** Absolute local timestamp for tooltips; falls back to an em dash. */
export function formatAbsoluteTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString();
}

/** True when `value` is older than `thresholdMs` relative to now. */
export function isOlderThan(value: string | null | undefined, thresholdMs: number): boolean {
  if (!value) return false;
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return false;
  return Date.now() - time > thresholdMs;
}

/** Percentage of `used` over `total`, or null when the total is unusable. */
export function percentOf(used: number | null, total: number | null): number | null {
  if (used === null || total === null || total <= 0) return null;
  return (used / total) * 100;
}

/** Human label for a job's duration, or null while it has not finished. */
export function jobDurationSeconds(startedAt: string | null, finishedAt: string | null): number | null {
  if (!startedAt || !finishedAt) return null;
  const start = new Date(startedAt).getTime();
  const end = new Date(finishedAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.max(0, (end - start) / 1000);
}

/** Duration cell for a job row: a formatted span once finished, otherwise an em dash. */
export function formatJobDuration(job: JobDto): string {
  const seconds = jobDurationSeconds(job.startedAt, job.finishedAt);
  return seconds === null ? "—" : formatDuration(seconds);
}
