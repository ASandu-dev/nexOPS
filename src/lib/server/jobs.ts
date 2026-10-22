import type { Job, Prisma } from "@prisma/client";
import type { JobStatus, JobType, Paginated, JobDto } from "@/lib/types";
import { prisma } from "./prisma";
import { recordAudit, writeAudit, type AuditInput } from "./audit";
import { toJobDto, toPaginated, emptyPaginated } from "./dto";
import { conflict, jobAlreadyActive, jobNotRetryable, notFound } from "./errors";
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
  type: JobType;
  params: Record<string, unknown> | null;
}

/**
 * Shared job-creation core. `store` is the client the rows are written
 * through: the pooled client for a standalone job, a transaction client when
 * the job must be atomic with other writes (bulk dispatch).
 *
 * `audit` decides how the audit event is written: standalone jobs tolerate an
 * audit failure, transactional ones must not (a failed statement aborts the
 * transaction, so the event has to be part of the atomic unit).
 */
async function insertJob(
  store: Prisma.TransactionClient,
  input: CreateJobInput,
  requestedBy: string,
  audit: (event: AuditInput) => Promise<void>,
): Promise<Job> {
  const target = await store.target.findFirst({
    where: { id: input.targetId, deletedAt: null },
    select: { id: true, name: true },
  });
  if (!target) throw notFound("Target not found");

  const job = await store.job.create({
    data: {
      targetId: target.id,
      type: input.type,
      requestedBy,
      // exactOptionalPropertyTypes: omit rather than pass explicit undefined.
      ...(input.params !== null ? { params: input.params as Prisma.InputJsonValue } : {}),
    },
  });
  await audit({
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

/** Creates a QUEUED job after verifying the target exists (not soft-deleted). */
export async function createJob(input: CreateJobInput, requestedBy: string): Promise<Job> {
  return insertJob(prisma, input, requestedBy, recordAudit);
}

/**
 * Creates a QUEUED job inside an existing transaction, so the job row and its
 * audit event commit or roll back together.
 */
export async function createJobInTx(
  tx: Prisma.TransactionClient,
  input: CreateJobInput,
  requestedBy: string,
): Promise<Job> {
  return insertJob(tx, input, requestedBy, (event) => writeAudit(tx, event));
}

/** Job statuses a retry may be started from. */
const RETRYABLE_STATUSES: readonly JobStatus[] = ["FAILED", "TIMED_OUT"];

/** Job statuses that block a retry: the target is already busy with the same work. */
const ACTIVE_STATUSES: readonly JobStatus[] = ["QUEUED", "DISPATCHED", "RUNNING"];

/**
 * Narrows a stored JSON value to a Prisma input value. The `params` column is
 * `Json?`, so a top-level JSON null is stored as SQL NULL — the only value
 * that cannot be written back.
 */
function jsonInput(value: Prisma.JsonValue): Prisma.InputJsonValue | undefined {
  if (value === null) return undefined;
  // Prisma's input type excludes a top-level null; every other JSON document
  // is a valid input value.
  return value as unknown as Prisma.InputJsonValue;
}

/**
 * Re-queues a failed job as a NEW job (history is never rewritten): the new
 * row copies the target, type, params and timeout of the original.
 *
 * Only FAILED and TIMED_OUT jobs can be retried, and only when no job of the
 * same type is still active for the target. The check and the insert run in
 * one transaction behind an advisory lock, so two concurrent retries cannot
 * both see "no active job" and queue the same work twice.
 */
export async function retryJob(jobId: string, actorId: string): Promise<Job> {
  const original = await prisma.job.findUnique({ where: { id: jobId } });
  if (!original) throw notFound("Job not found");

  if (!RETRYABLE_STATUSES.includes(original.status)) {
    throw jobNotRetryable(
      `Job is ${original.status}; only FAILED or TIMED_OUT jobs can be retried`,
    );
  }

  return prisma.$transaction(async (tx) => {
    // Serialize retries per (target, type). The lock is released when the
    // transaction ends, so a failed attempt never blocks the next one.
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(
        ('x' || substr(md5(${`${original.targetId}:${original.type}`}), 1, 16))::bit(64)::bigint
      )
    `;

    const active = await tx.job.findFirst({
      where: {
        targetId: original.targetId,
        type: original.type,
        status: { in: [...ACTIVE_STATUSES] },
      },
      select: { id: true },
    });
    if (active) {
      throw jobAlreadyActive(
        `A ${original.type} job is already active for this target (job ${active.id})`,
      );
    }

    const params = jsonInput(original.params);
    const job = await tx.job.create({
      data: {
        targetId: original.targetId,
        type: original.type,
        requestedBy: actorId,
        timeoutSec: original.timeoutSec,
        ...(params !== undefined ? { params } : {}),
      },
    });

    await writeAudit(tx, {
      actorId,
      actorType: "USER",
      action: "job.retry",
      targetType: "job",
      targetId: original.targetId,
      metadata: { originalJobId: original.id, newJobId: job.id },
    });
    return job;
  });
}

/** QUEUED/DISPATCHED/RUNNING → CANCELLED; terminal jobs are a 409. */
export async function cancelJob(jobId: string, actorId: string): Promise<Job> {
  const existing = await prisma.job.findUnique({ where: { id: jobId } });
  if (!existing) throw notFound("Job not found");

  if (isTerminal(existing.status)) {
    throw conflict(`Job is ${existing.status}; terminal jobs cannot be cancelled`);
  }

  const result = await prisma.job.updateMany({
    where: { id: jobId, status: { in: ["QUEUED", "DISPATCHED", "RUNNING"] } },
    data: { status: "CANCELLED", finishedAt: new Date(), error: "Cancelled by operator" },
  });
  if (result.count === 0) {
    throw conflict(`Job is ${existing.status}; cannot be cancelled`);
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
