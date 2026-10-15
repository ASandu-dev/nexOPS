import type { AgentIdentity, Job, Target } from "@prisma/client";
import type { JobDto, OverviewDto, StatusCountDto, TargetDto, TargetStatus } from "@/lib/types";
import { prisma } from "./prisma";
import { jobCountMaps, toAuditDto, toJobDto, toTargetDto } from "./dto";
import { reapTimedOutJobs } from "./jobs";
import { deriveTargetStatus, isEnrolmentExpiredUnused } from "./status";
import { getFleetAggregates } from "./telemetry";

type TargetRow = Target & {
  agent: AgentIdentity | null;
  tokens: { expiresAt: Date; usedAt: Date | null }[];
};

const FAILED_JOB_STATUSES = ["FAILED", "TIMED_OUT"] as const;
const DEGRADEDISH: readonly TargetStatus[] = ["DEGRADED", "OFFLINE"];
const FAILED_WINDOW_MS = 24 * 60 * 60 * 1000;
const ALL_STATUSES: readonly TargetStatus[] = [
  "ONLINE",
  "OFFLINE",
  "DEGRADED",
  "MAINTENANCE",
  "PENDING_ENROLMENT",
  "ENROLMENT_FAILED",
  "REMOVED",
];

type JobWithTargetName = Job & { target: { name: string } };

const toNamedJobDto = (job: JobWithTargetName): JobDto => toJobDto(job, job.target.name);

/**
 * Fleet overview assembled entirely from live queries: derived status counts,
 * worst-freshness targets, job activity, audit feed and latest-snapshot fleet
 * averages (ARCHITECTURE.md §5, GET /api/overview).
 */
export async function buildOverview(): Promise<OverviewDto> {
  const now = new Date();
  await reapTimedOutJobs();

  const targets = await prisma.target.findMany({
    where: { deletedAt: null },
    include: {
      agent: true,
      tokens: { select: { expiresAt: true, usedAt: true } },
    },
  });
  const targetIds = targets.map((target) => target.id);

  const [jobCounts, activeJobs, failedJobs, recentJobs, recentAudit, fleet] = await Promise.all([
    prisma.job.groupBy({
      by: ["targetId", "status"],
      where: { targetId: { in: targetIds }, status: { in: ["QUEUED", "RUNNING"] } },
      _count: { _all: true },
    }),
    prisma.job.findMany({
      where: { status: { in: ["QUEUED", "DISPATCHED", "RUNNING"] } },
      orderBy: { createdAt: "desc" },
      take: 25,
      include: { target: { select: { name: true } } },
    }),
    prisma.job.findMany({
      where: {
        status: { in: [...FAILED_JOB_STATUSES] },
        finishedAt: { gte: new Date(now.getTime() - FAILED_WINDOW_MS) },
      },
      orderBy: { finishedAt: "desc" },
      take: 20,
      include: { target: { select: { name: true } } },
    }),
    prisma.job.findMany({
      orderBy: { createdAt: "desc" },
      take: 10,
      include: { target: { select: { name: true } } },
    }),
    prisma.auditEvent.findMany({ orderBy: { createdAt: "desc" }, take: 10 }),
    getFleetAggregates(),
  ]);

  const { pending, running } = jobCountMaps(jobCounts);
  const enriched = targets.map((target: TargetRow) => {
    const runningCount = running.get(target.id) ?? 0;
    return {
      target,
      runningCount,
      pendingCount: pending.get(target.id) ?? 0,
      status: deriveTargetStatus(target, {
        runningJobCount: runningCount,
        enrolmentExpiredUnused: isEnrolmentExpiredUnused(target.tokens, now),
        now,
      }),
    };
  });

  const counts = new Map<TargetStatus, number>(
    ALL_STATUSES.map((status): [TargetStatus, number] => [status, 0]),
  );
  for (const entry of enriched) {
    counts.set(entry.status, (counts.get(entry.status) ?? 0) + 1);
  }

  const countsByStatus: StatusCountDto[] = [...counts.entries()].map(([status, count]) => ({
    status,
    count,
  }));

  const toDto = (entry: (typeof enriched)[number]): TargetDto =>
    toTargetDto(entry.target, {
      status: entry.status,
      pendingJobCount: entry.pendingCount,
      runningJobCount: entry.runningCount,
    });

  const degradedTargets = enriched
    .filter((entry) => DEGRADEDISH.includes(entry.status))
    .sort((a, b) => {
      const bySeverity =
        (a.status === "OFFLINE" ? 0 : 1) - (b.status === "OFFLINE" ? 0 : 1);
      if (bySeverity !== 0) return bySeverity;
      return (a.target.lastHeartbeatAt?.getTime() ?? 0) - (b.target.lastHeartbeatAt?.getTime() ?? 0);
    })
    .slice(0, 10)
    .map(toDto);

  return {
    totals: {
      targets: enriched.length,
      online: counts.get("ONLINE") ?? 0,
      offline: counts.get("OFFLINE") ?? 0,
      degraded: counts.get("DEGRADED") ?? 0,
      maintenance: counts.get("MAINTENANCE") ?? 0,
      pendingEnrolment: counts.get("PENDING_ENROLMENT") ?? 0,
      enrolmentFailed: counts.get("ENROLMENT_FAILED") ?? 0,
    },
    countsByStatus,
    degradedTargets,
    activeJobs: activeJobs.map(toNamedJobDto),
    failedJobs: failedJobs.map(toNamedJobDto),
    recentJobs: recentJobs.map(toNamedJobDto),
    recentAudit: recentAudit.map(toAuditDto),
    fleet,
  };
}
