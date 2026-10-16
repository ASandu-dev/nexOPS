import type { Job, Prisma } from "@prisma/client";
import type { JobStatus, Paginated, JobDto } from "@/lib/types";
import { prisma } from "./prisma";
import { recordAudit } from "./audit";
import { toJobDto, toPaginated, emptyPaginated } from "./dto";
import { conflict, notFound } from "./errors";
import { getSettings } from "./settings";

const TERMINAL_STATUSES: readonly JobStatus[] = ["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT"];

export const isTerminal = (status: JobStatus): boolean => TERMINAL_STATUSES.includes(status);

/** Hard cap on stored stdout/stderr tails (bytes, kept from the end of the output). */
export const TAIL_MAX_BYTES = 64 * 1024;

/** Keeps the last `maxBytes` UTF-8 bytes of `value` without splitting code points. */
export function capTail(value: string | null, maxBytes: number = TAIL_MAX_BYTES): string | null {
  if (value === null) return null;
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  // Truncate from the front; a small overshoot buffer absorbs multi-byte chars.
  let sliced = value.slice(-Math.ceil(maxBytes / 2));
  while (Buffer.byteLength(sliced, "utf8") > maxBytes) {
    sliced = sliced.slice(1);
  }
  return sliced;
}

/**
 * Atomically moves all QUEUED jobs for a target to DISPATCHED and returns them.
 * Single UPDATE ... RETURNING so two concurrent heartbeats cannot double-dispatch.
 */
export async function dispatchQueuedJobs(targetId: string): Promise<Job[]> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      UPDATE "Job"
      SET "status" = 'DISPATCHED', "dispatchedAt" = now()
      WHERE "targetId" = ${targetId} AND "status" = 'QUEUED'
      RETURNING "id"
    `;
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    return tx.job.findMany({ where: { id: { in: ids } }, orderBy: { createdAt: "asc" } });
  });
}

/**
 * Fallback heartbeat interval (seconds) when settings cannot be read. The
 * pickup/start grace is twice this value.
 */
const DEFAULT_HEARTBEAT_INTERVAL_SEC = 60;

/**
 * Reaps jobs that can no longer make progress:
 *  - RUNNING past `startedAt + timeoutSec` (ARCHITECTURE.md §3);
 *  - DISPATCHED but never acknowledged by the agent within 2× the heartbeat
 *    interval (the poll response was lost or the agent died before starting);
 *  - RUNNING with no `startedAt` within the same grace (malformed start report).
 *
 * The grace is derived from the configured heartbeat interval so a slow but
 * healthy agent is not reaped prematurely.
 */
export async function reapTimedOutJobs(): Promise<number> {
  const graceSec = await pickupGraceSec();

  const timedOut = await prisma.$executeRaw`
    UPDATE "Job"
    SET "status" = 'TIMED_OUT',
        "finishedAt" = now(),
        "error" = 'Exceeded timeoutSec without finishing'
    WHERE "status" = 'RUNNING'
      AND "startedAt" IS NOT NULL
      AND "startedAt" + ("timeoutSec"::double precision * interval '1 second') < now()
  `;

  const neverPickedUp = await prisma.$executeRaw`
    UPDATE "Job"
    SET "status" = 'TIMED_OUT',
        "finishedAt" = now(),
        "error" = 'agent never picked up job'
    WHERE "status" = 'DISPATCHED'
      AND "dispatchedAt" IS NOT NULL
      AND "dispatchedAt" + (${graceSec}::double precision * interval '1 second') < now()
  `;

  const neverStarted = await prisma.$executeRaw`
    UPDATE "Job"
    SET "status" = 'TIMED_OUT',
        "finishedAt" = now(),
        "error" = 'agent did not report job start'
    WHERE "status" = 'RUNNING'
      AND "startedAt" IS NULL
      AND "dispatchedAt" IS NOT NULL
      AND "dispatchedAt" + (${graceSec}::double precision * interval '1 second') < now()
  `;

  return timedOut + neverPickedUp + neverStarted;
}

/** Twice the configured heartbeat interval; falls back to a constant if settings are unreadable. */
async function pickupGraceSec(): Promise<number> {
  try {
    const { settings } = await getSettings();
    return settings.heartbeatIntervalSec * 2;
  } catch {
    // Settings are best-effort here: the reaping queries below surface any real
    // DB failure, so a transient read error must not block cleanup.
    return DEFAULT_HEARTBEAT_INTERVAL_SEC * 2;
  }
}

export interface CreateJobInput {
  targetId: string;
  type: "APT_UPDATE" | "APT_UPGRADE" | "CHECK_UPDATES" | "SERVICE_STATUS";
  params: Record<string, unknown> | null;
}

/** Creates a QUEUED job after verifying the target exists (not soft-deleted). */
export async function createJob(input: CreateJobInput, requestedBy: string): Promise<Job> {
  const target = await prisma.target.findFirst({
    where: { id: input.targetId, deletedAt: null },
    select: { id: true, name: true },
  });
  if (!target) throw notFound("Target not found");

  const job = await prisma.job.create({
    data: {
      targetId: target.id,
      type: input.type,
      requestedBy,
      // exactOptionalPropertyTypes: omit rather than pass explicit undefined.
      ...(input.params !== null ? { params: input.params as Prisma.InputJsonValue } : {}),
    },
  });
  await recordAudit({
    actorId: requestedBy,
    actorType: "USER",
    action: "job.create",
    targetType: "job",
    // AuditEvent.targetId is a FK to Target, so the owning target is referenced
    // and the job id travels in metadata.
    targetId: target.id,
    metadata: { jobId: job.id, jobType: job.type, targetName: target.name },
  });
  return job;
}

/** QUEUED → CANCELLED only; anything already dispatched/terminal is a 409. */
export async function cancelJob(jobId: string, actorId: string): Promise<Job> {
  const existing = await prisma.job.findUnique({ where: { id: jobId } });
  if (!existing) throw notFound("Job not found");

  const result = await prisma.job.updateMany({
    where: { id: jobId, status: "QUEUED" },
    data: { status: "CANCELLED", finishedAt: new Date(), error: "Cancelled by operator" },
  });
  if (result.count === 0) {
    throw conflict(`Job is ${existing.status}; only queued jobs can be cancelled`);
  }

  await recordAudit({
    actorId,
    actorType: "USER",
    action: "job.cancel",
    targetType: "job",
    targetId: existing.targetId,
    metadata: { jobId, jobType: existing.type },
  });
  return prisma.job.findUniqueOrThrow({ where: { id: jobId } });
}

export interface JobListFilters {
  statuses?: JobStatus[];
  targetId?: string;
  page: number;
  pageSize: number;
}

export async function listJobs(filters: JobListFilters): Promise<Paginated<JobDto>> {
  await reapTimedOutJobs();
  const where: Prisma.JobWhereInput = {};
  if (filters.statuses && filters.statuses.length > 0) {
    where.status = { in: filters.statuses };
  }
  if (filters.targetId) {
    where.targetId = filters.targetId;
  }

  const total = await prisma.job.count({ where });
  if (total === 0) return emptyPaginated<JobDto>(filters.page, filters.pageSize);

  const jobs = await prisma.job.findMany({
    where,
    orderBy: { createdAt: "desc" },
    skip: (filters.page - 1) * filters.pageSize,
    take: filters.pageSize,
    include: { target: { select: { name: true } } },
  });
  return toPaginated(
    jobs.map((job) => toJobDto(job, job.target.name)),
    filters.page,
    filters.pageSize,
    total,
  );
}

export async function getJobOrThrow(jobId: string): Promise<Job & { targetName: string }> {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    include: { target: { select: { name: true } } },
  });
  if (!job) throw notFound("Job not found");
  return { ...job, targetName: job.target.name };
}
