import { Prisma } from "@prisma/client";
import type {
  BulkJobResultDto,
  BulkJobType,
  BulkSkipDto,
  BulkSkipReason,
  TargetStatus,
} from "@/lib/types";
import { prisma } from "./prisma";
import { writeAudit } from "./audit";
import { createJobInTx } from "./jobs";
import { deriveTargetStatus, isEnrolmentExpiredUnused } from "./status";

export interface BulkJobInput {
  type: BulkJobType;
  /** Target ids to dispatch to; omitted means every eligible target. */
  targetIds?: string[] | undefined;
}

/**
 * Reason a target is skipped, or null when it is eligible. The derived status
 * decides it — the same rules the target list and detail endpoints use
 * (ARCHITECTURE.md §4), so the dashboard never sees two different notions of
 * "eligible".
 */
function skipReason(status: TargetStatus): BulkSkipReason | null {
  switch (status) {
    case "ONLINE":
    case "DEGRADED":
      return null;
    case "OFFLINE":
      return "offline";
    case "PENDING_ENROLMENT":
      return "pending_enrolment";
    case "ENROLMENT_FAILED":
      return "enrolment_failed";
    case "MAINTENANCE":
      return "maintenance";
    case "REMOVED":
      // Soft-deleted targets are filtered out of the query and therefore
      // reported as missing.
      return "not_found";
  }
}

/** Removes duplicate ids, preserving the caller's order. */
function dedupe(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

/**
 * Dispatches one job to every eligible target in a single transaction.
 *
 * Eligible = the derived status is ONLINE or DEGRADED. Every other target is
 * reported in `skipped` with the reason it was not eligible; a target with a
 * RUNNING job is skipped as "maintenance" so a bulk dispatch cannot pile up
 * behind a long upgrade.
 *
 * An empty fleet is not an error: the result is `created: 0`.
 */
export async function bulkCreateJobs(
  input: BulkJobInput,
  requestedBy: string,
): Promise<BulkJobResultDto> {
  const now = new Date();
  const targetIds = input.targetIds === undefined ? undefined : dedupe(input.targetIds);

  const where: Prisma.TargetWhereInput = { deletedAt: null };
  if (targetIds !== undefined) where.id = { in: targetIds };

  const targets = await prisma.target.findMany({
    where,
    include: { tokens: { select: { expiresAt: true, usedAt: true } } },
  });

  const byId = new Map(targets.map((target) => [target.id, target]));

  // Running jobs make a target MAINTENANCE; counted in one grouped query
  // instead of one query per target.
  const runningCounts =
    targets.length === 0
      ? []
      : await prisma.job.groupBy({
          by: ["targetId"],
          where: { targetId: { in: targets.map((target) => target.id) }, status: "RUNNING" },
          _count: { _all: true },
        });
  const runningMap = new Map(runningCounts.map((row) => [row.targetId, row._count._all]));

  const skipped: BulkSkipDto[] = [];
  const eligible: string[] = [];
  const candidates = targetIds ?? targets.map((target) => target.id);

  for (const id of candidates) {
    const target = byId.get(id);
    if (!target) {
      skipped.push({ targetId: id, reason: "not_found" });
      continue;
    }
    const status = deriveTargetStatus(target, {
      runningJobCount: runningMap.get(target.id) ?? 0,
      enrolmentExpiredUnused: isEnrolmentExpiredUnused(target.tokens, now),
      now,
    });
    const reason = skipReason(status);
    if (reason === null) {
      eligible.push(target.id);
      continue;
    }
    skipped.push({ targetId: target.id, reason });
  }

  // Jobs and their audit events commit together: a partial fleet dispatch is
  // never observable.
  const created = await prisma.$transaction(async (tx) => {
    for (const targetId of eligible) {
      await createJobInTx(tx, { targetId, type: input.type, params: null }, requestedBy);
    }
    await writeAudit(tx, {
      actorId: requestedBy,
      actorType: "USER",
      action: "jobs.bulkCreate",
      targetType: "job",
      metadata: { type: input.type, count: eligible.length, targetIds: eligible },
    });
    return eligible.length;
  });

  return { created, skipped };
}
