import type { TargetStatus } from "@/lib/types";

/** A target is OFFLINE once it has not heartbeat for 90 seconds. */
export const HEARTBEAT_STALE_MS = 90_000;
/** Telemetry older than 5 minutes (with a fresh heartbeat) marks the target DEGRADED. */
export const TELEMETRY_STALE_MS = 5 * 60_000;

export interface StatusSubject {
  deletedAt: Date | null;
  lastHeartbeatAt: Date | null;
  lastTelemetryAt: Date | null;
}

export interface StatusContext {
  /** Number of jobs currently in RUNNING state for the target. */
  runningJobCount: number;
  /**
   * True when an enrolment token expired unused and the target never
   * heartbeat (ARCHITECTURE.md §4: ENROLMENT_FAILED).
   */
  enrolmentExpiredUnused: boolean;
  now?: Date;
}

/**
 * Pure read-time status derivation per ARCHITECTURE.md §4.
 * Precedence: REMOVED > MAINTENANCE > freshness/freshness-derived states.
 */
export function deriveTargetStatus(
  subject: StatusSubject,
  context: StatusContext,
): TargetStatus {
  if (subject.deletedAt) return "REMOVED";

  if (subject.lastHeartbeatAt === null) {
    return context.enrolmentExpiredUnused ? "ENROLMENT_FAILED" : "PENDING_ENROLMENT";
  }

  // MAINTENANCE is a display overlay with precedence over freshness states.
  if (context.runningJobCount > 0) return "MAINTENANCE";

  const now = context.now ?? new Date();
  if (now.getTime() - subject.lastHeartbeatAt.getTime() > HEARTBEAT_STALE_MS) {
    return "OFFLINE";
  }
  if (
    subject.lastTelemetryAt === null ||
    now.getTime() - subject.lastTelemetryAt.getTime() > TELEMETRY_STALE_MS
  ) {
    return "DEGRADED";
  }
  return "ONLINE";
}

export interface EnrolmentTokenState {
  expiresAt: Date;
  usedAt: Date | null;
}

/**
 * ENROLMENT_FAILED applies only when the target never heartbeat and its
 * enrolment tokens are all expired-unused (no fresh unused token remains).
 */
export function isEnrolmentExpiredUnused(
  tokens: readonly EnrolmentTokenState[],
  now: Date,
): boolean {
  const hasFreshUnused = tokens.some((t) => t.usedAt === null && t.expiresAt > now);
  const hasExpiredUnused = tokens.some((t) => t.usedAt === null && t.expiresAt <= now);
  return !hasFreshUnused && hasExpiredUnused;
}
