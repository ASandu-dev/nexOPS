import { Prisma, type TelemetrySnapshot } from "@prisma/client";
import type {
  CreateTargetResponseDto,
  OsFamily,
  Paginated,
  TargetDetailDto,
  TargetDto,
  TargetStatus,
  TargetWarningDto,
} from "@/lib/types";
import { prisma } from "./prisma";
import { recordAudit } from "./audit";
import { randomToken, sha256 } from "./crypto";
import {
  emptyPaginated,
  jobCountMaps,
  toJobDto,
  toPaginated,
  toTargetDto,
  type TargetWithAgent,
} from "./dto";
import { notFound } from "./errors";
import { buildInstallCommand } from "./releases";
import type { targetListQuerySchema } from "./schemas";
import {
  deriveTargetStatus,
  HEARTBEAT_STALE_MS,
  isEnrolmentExpiredUnused,
  TELEMETRY_STALE_MS,
} from "./status";
import { heartbeatSchema } from "./schemas";
import type { z } from "zod";

export type TargetListQuery = z.infer<typeof targetListQuerySchema>;

const ENROLMENT_TOKEN_TTL_MS = 15 * 60 * 1000;

/** Canonical health ordering used when sorting by derived status. */
const STATUS_RANK: Record<TargetStatus, number> = {
  ONLINE: 0,
  MAINTENANCE: 1,
  DEGRADED: 2,
  OFFLINE: 3,
  PENDING_ENROLMENT: 4,
  ENROLMENT_FAILED: 5,
  REMOVED: 6,
};

/**
 * Translates a requested derived status into a SQL predicate so filtering and
 * pagination stay in the database (derivation rules: ARCHITECTURE.md §4).
 */
function statusFilter(status: TargetStatus, now: Date): Prisma.TargetWhereInput {
  const hbStale = new Date(now.getTime() - HEARTBEAT_STALE_MS);
  const telStale = new Date(now.getTime() - TELEMETRY_STALE_MS);
  const noRunning: Prisma.TargetWhereInput = { jobs: { none: { status: "RUNNING" } } };

  switch (status) {
    case "ONLINE":
      return {
        deletedAt: null,
        ...noRunning,
        lastHeartbeatAt: { gte: hbStale },
        lastTelemetryAt: { gte: telStale },
      };
    case "DEGRADED":
      return {
        deletedAt: null,
        ...noRunning,
        lastHeartbeatAt: { gte: hbStale },
        OR: [{ lastTelemetryAt: null }, { lastTelemetryAt: { lt: telStale } }],
      };
    case "OFFLINE":
      return {
        deletedAt: null,
        ...noRunning,
        lastHeartbeatAt: { lt: hbStale },
      };
    case "MAINTENANCE":
      return { deletedAt: null, jobs: { some: { status: "RUNNING" } } };
    case "PENDING_ENROLMENT":
      return {
        deletedAt: null,
        ...noRunning,
        lastHeartbeatAt: null,
        tokens: { some: { usedAt: null, expiresAt: { gt: now } } },
      };
    case "ENROLMENT_FAILED":
      return {
        deletedAt: null,
        ...noRunning,
        lastHeartbeatAt: null,
        AND: [
          { tokens: { some: { usedAt: null, expiresAt: { lte: now } } } },
          { tokens: { none: { usedAt: null, expiresAt: { gt: now } } } },
        ],
      };
    case "REMOVED":
      return { deletedAt: { not: null } };
  }
}

function buildWhere(query: TargetListQuery, now: Date): Prisma.TargetWhereInput {
  const where: Prisma.TargetWhereInput = {};
  if (query.q) {
    where.OR = [
      { name: { contains: query.q, mode: "insensitive" } },
      { hostname: { contains: query.q, mode: "insensitive" } },
      { hostnameOverride: { contains: query.q, mode: "insensitive" } },
    ];
  }
  if (query.label) {
    where.labels = { has: query.label };
  }
  if (query.status && query.status.length > 0) {
    where.AND = [{ OR: query.status.map((status) => statusFilter(status, now)) }];
  } else {
    where.deletedAt = null;
  }
  return where;
}

export async function listTargets(query: TargetListQuery): Promise<Paginated<TargetDto>> {
  const now = new Date();
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? 20;
  const sort = query.sort ?? "createdAt";
  const order = query.order ?? "desc";
  const where = buildWhere(query, now);

  const total = await prisma.target.count({ where });
  if (total === 0) return emptyPaginated<TargetDto>(page, pageSize);

  let orderedIds: string[];
  if (sort === "status") {
    // Derived status is computed from time columns, so it cannot be ORDER BY'd
    // in SQL; hydrate the (small) filtered set, derive, sort, then slice.
    const rows = await prisma.target.findMany({
      where,
      select: {
        id: true,
        name: true,
        deletedAt: true,
        lastHeartbeatAt: true,
        lastTelemetryAt: true,
        tokens: { select: { expiresAt: true, usedAt: true } },
      },
    });
    const runningCounts = await prisma.job.groupBy({
      by: ["targetId"],
      where: { targetId: { in: rows.map((r) => r.id) }, status: "RUNNING" },
      _count: { _all: true },
    });
    const runningMap = new Map(runningCounts.map((c) => [c.targetId, c._count._all]));
    const derived = rows.map((row) => ({
      id: row.id,
      name: row.name,
      status: deriveTargetStatus(row, {
        runningJobCount: runningMap.get(row.id) ?? 0,
        enrolmentExpiredUnused: isEnrolmentExpiredUnused(row.tokens, now),
        now,
      }),
    }));
    derived.sort((a, b) => {
      const byStatus = STATUS_RANK[a.status] - STATUS_RANK[b.status];
      if (byStatus !== 0) return order === "asc" ? byStatus : -byStatus;
      const byName = a.name.localeCompare(b.name);
      return order === "asc" ? byName : -byName;
    });
    orderedIds = derived
      .slice((page - 1) * pageSize, page * pageSize)
      .map((entry) => entry.id);
  } else {
    const orderBy: Prisma.TargetOrderByWithRelationInput =
      sort === "name"
        ? { name: order }
        : sort === "lastHeartbeatAt"
          ? { lastHeartbeatAt: order }
          : { createdAt: order };
    const rows = await prisma.target.findMany({
      where,
      select: { id: true },
      orderBy,
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    orderedIds = rows.map((row) => row.id);
  }
  if (orderedIds.length === 0) return emptyPaginated<TargetDto>(page, pageSize);

  const [targets, jobCounts] = await Promise.all([
    prisma.target.findMany({
      where: { id: { in: orderedIds } },
      include: {
        agent: true,
        tokens: { select: { expiresAt: true, usedAt: true } },
      },
    }),
    prisma.job.groupBy({
      by: ["targetId", "status"],
      where: { targetId: { in: orderedIds }, status: { in: ["QUEUED", "RUNNING"] } },
      _count: { _all: true },
    }),
  ]);
  const { pending, running } = jobCountMaps(jobCounts);
  const byId = new Map(targets.map((target) => [target.id, target]));

  const items: TargetDto[] = [];
  for (const id of orderedIds) {
    const target = byId.get(id);
    if (!target) continue;
    const runningCount = running.get(id) ?? 0;
    items.push(
      toTargetDto(target, {
        status: deriveTargetStatus(target, {
          runningJobCount: runningCount,
          enrolmentExpiredUnused: isEnrolmentExpiredUnused(target.tokens, now),
          now,
        }),
        pendingJobCount: pending.get(id) ?? 0,
        runningJobCount: runningCount,
      }),
    );
  }
  return toPaginated(items, page, pageSize, total);
}

function buildWarnings(args: {
  target: TargetWithAgent;
  status: TargetStatus;
  latest: TelemetrySnapshot | null;
  now: Date;
}): TargetWarningDto[] {
  const { target, status, latest, now } = args;
  const warnings: TargetWarningDto[] = [];

  if (status === "OFFLINE") {
    const seconds = target.lastHeartbeatAt
      ? Math.round((now.getTime() - target.lastHeartbeatAt.getTime()) / 1000)
      : null;
    warnings.push({
      code: "OFFLINE",
      message: "No heartbeat received for more than 90 seconds.",
      ...(seconds !== null ? { detail: { secondsSinceHeartbeat: seconds } } : {}),
    });
  }
  if (status === "DEGRADED") {
    warnings.push({
      code: "TELEMETRY_STALE",
      message: "Heartbeat is fresh but telemetry is older than 5 minutes.",
    });
  }
  if (status === "ENROLMENT_FAILED") {
    warnings.push({
      code: "ENROLMENT_FAILED",
      message: "Enrolment token expired before the agent completed enrolment.",
    });
  }
  if (target.lastHeartbeatAt !== null && target.lastTelemetryAt === null) {
    warnings.push({ code: "NO_TELEMETRY", message: "Target heartbeat without telemetry." });
  }
  if (target.agent?.revokedAt) {
    warnings.push({
      code: "CREDENTIAL_REVOKED",
      message: "Agent credential was revoked; re-enrol the agent to restore access.",
    });
  }

  if (latest) {
    const parsed = heartbeatSchema.safeParse(latest.raw);
    if (parsed.success) {
      for (const disk of parsed.data.disks) {
        if (disk.totalBytes <= 0) continue;
        const usedPct = (disk.usedBytes / disk.totalBytes) * 100;
        if (usedPct >= 90) {
          warnings.push({
            code: "LOW_DISK",
            message: `Filesystem ${disk.mount} is ${usedPct.toFixed(1)}% full.`,
            detail: { mount: disk.mount, usedPct: Math.round(usedPct * 10) / 10 },
          });
        }
      }
    }
  }
  return warnings;
}

export async function getTargetDetail(id: string): Promise<TargetDetailDto> {
  const now = new Date();
  const target = await prisma.target.findFirst({
    where: { id, deletedAt: null },
    include: {
      agent: true,
      tokens: { select: { expiresAt: true, usedAt: true } },
    },
  });
  if (!target) throw notFound("Target not found");

  const [counts, latest, recentJobs] = await Promise.all([
    prisma.job.groupBy({
      by: ["status"],
      where: { targetId: id, status: { in: ["QUEUED", "RUNNING"] } },
      _count: { _all: true },
    }),
    prisma.telemetrySnapshot.findFirst({
      where: { targetId: id },
      orderBy: { capturedAt: "desc" },
    }),
    prisma.job.findMany({
      where: { targetId: id },
      orderBy: { createdAt: "desc" },
      take: 5,
    }),
  ]);
  const pending = counts.find((c) => c.status === "QUEUED")?._count._all ?? 0;
  const running = counts.find((c) => c.status === "RUNNING")?._count._all ?? 0;
  const status = deriveTargetStatus(target, {
    runningJobCount: running,
    enrolmentExpiredUnused: isEnrolmentExpiredUnused(target.tokens, now),
    now,
  });

  return {
    ...toTargetDto(target, {
      status,
      pendingJobCount: pending,
      runningJobCount: running,
    }),
    warnings: buildWarnings({ target, status, latest, now }),
    recentJobs: recentJobs.map((job) => toJobDto(job, target.name)),
  };
}

export interface CreateTargetInput {
  name: string;
  os: OsFamily;
  hostnameOverride?: string | null;
  labels: string[];
}

/**
 * Creates a target plus its single-use enrolment token (hash-only storage,
 * 15-minute TTL). Returns the plaintext token exactly once.
 */
export async function createTarget(
  input: CreateTargetInput,
  baseUrl: string,
  actorId: string,
): Promise<CreateTargetResponseDto> {
  const enrolmentToken = randomToken();
  const tokenHash = sha256(enrolmentToken);
  const expiresAt = new Date(Date.now() + ENROLMENT_TOKEN_TTL_MS);

  const target = await prisma.target.create({
    data: {
      name: input.name,
      os: input.os,
      hostnameOverride: input.hostnameOverride ?? null,
      labels: input.labels,
      status: "PENDING_ENROLMENT",
      tokens: { create: { tokenHash, expiresAt } },
    },
  });

  await recordAudit({
    actorId,
    actorType: "USER",
    action: "target.create",
    targetType: "target",
    targetId: target.id,
    metadata: { name: target.name, os: target.os, labels: target.labels },
  });

  return {
    target: toTargetDto({ ...target, agent: null }, {
      status: "PENDING_ENROLMENT",
      pendingJobCount: 0,
      runningJobCount: 0,
    }),
    enrolmentToken,
    expiresAt: expiresAt.toISOString(),
    installCommand: buildInstallCommand(baseUrl, enrolmentToken, input.os),
    installerUrl: `${baseUrl}/api/agent/releases/install.sh`,
  };
}

/** 404 unless the target exists and is not soft-deleted. */
export async function assertTargetExists(id: string): Promise<void> {
  const target = await prisma.target.findFirst({
    where: { id, deletedAt: null },
    select: { id: true },
  });
  if (!target) throw notFound("Target not found");
}

export interface UpdateTargetInput {
  name?: string;
  hostnameOverride?: string | null;
  labels?: string[];
}

export async function updateTarget(
  id: string,
  patch: UpdateTargetInput,
  actorId: string,
): Promise<TargetDto> {
  const now = new Date();
  const existing = await prisma.target.findFirst({
    where: { id, deletedAt: null },
    select: { id: true },
  });
  if (!existing) throw notFound("Target not found");

  const data: Prisma.TargetUpdateInput = {};
  if (patch.name !== undefined) data.name = patch.name;
  if (patch.hostnameOverride !== undefined) data.hostnameOverride = patch.hostnameOverride;
  if (patch.labels !== undefined) data.labels = patch.labels;

  const [target, jobCounts] = await Promise.all([
    prisma.target.update({
      where: { id },
      data,
      include: {
        agent: true,
        tokens: { select: { expiresAt: true, usedAt: true } },
      },
    }),
    prisma.job.groupBy({
      by: ["status"],
      where: { targetId: id, status: { in: ["QUEUED", "RUNNING"] } },
      _count: { _all: true },
    }),
  ]);

  await recordAudit({
    actorId,
    actorType: "USER",
    action: "target.update",
    targetType: "target",
    targetId: id,
    metadata: { fields: Object.keys(patch) },
  });

  const pending = jobCounts.find((c) => c.status === "QUEUED")?._count._all ?? 0;
  const running = jobCounts.find((c) => c.status === "RUNNING")?._count._all ?? 0;
  return toTargetDto(target, {
    status: deriveTargetStatus(target, {
      runningJobCount: running,
      enrolmentExpiredUnused: isEnrolmentExpiredUnused(target.tokens, now),
      now,
    }),
    pendingJobCount: pending,
    runningJobCount: running,
  });
}

/**
 * Soft-deletes a target: revokes the agent credential, cancels queued jobs,
 * marks the row REMOVED — all in one transaction (ARCHITECTURE.md §2).
 */
export async function deleteTarget(id: string, actorId: string): Promise<void> {
  const existing = await prisma.target.findFirst({
    where: { id, deletedAt: null },
    include: { agent: { select: { id: true, credentialHash: true } } },
  });
  if (!existing) throw notFound("Target not found");

  const now = new Date();
  const hadCredential = existing.agent !== null && existing.agent.credentialHash !== null;

  await prisma.$transaction(async (tx) => {
    if (existing.agent && existing.agent.credentialHash !== null) {
      await tx.agentIdentity.update({
        where: { targetId: id },
        data: { credentialHash: null, revokedAt: now },
      });
    }
    await tx.job.updateMany({
      where: { targetId: id, status: "QUEUED" },
      data: { status: "CANCELLED", finishedAt: now, error: "Cancelled: target removed" },
    });
    await tx.target.update({
      where: { id },
      data: { deletedAt: now, status: "REMOVED" },
    });
  });

  await recordAudit({
    actorId,
    actorType: "USER",
    action: "target.delete",
    targetType: "target",
    targetId: id,
    metadata: { name: existing.name },
  });
  if (hadCredential) {
    await recordAudit({
      actorId,
      actorType: "USER",
      action: "agent.credential.revoke",
      targetType: "agent",
      targetId: id,
    });
  }
}
