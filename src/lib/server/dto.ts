import type {
  AgentIdentity,
  AuditEvent,
  Job,
  Target,
  TelemetrySnapshot,
} from "@prisma/client";
import type {
  AgentIdentityDto,
  AuditEventDto,
  JobDto,
  Paginated,
  TargetDto,
  TargetStatus,
  TelemetryDto,
} from "@/lib/types";
import { heartbeatSchema } from "./schemas";

export type TargetWithAgent = Target & { agent: AgentIdentity | null };

export const iso = (date: Date): string => date.toISOString();
export const isoOrNull = (date: Date | null): string | null => (date ? date.toISOString() : null);

export function toAgentIdentityDto(agent: AgentIdentity | null): AgentIdentityDto | null {
  if (!agent) return null;
  return {
    agentVersion: agent.agentVersion,
    enrolledAt: isoOrNull(agent.enrolledAt),
    revokedAt: isoOrNull(agent.revokedAt),
    hasCredential: agent.credentialHash !== null,
  };
}

export interface TargetStatusInput {
  status: TargetStatus;
  pendingJobCount?: number;
  runningJobCount?: number;
}

export function toTargetDto(
  target: TargetWithAgent,
  input: TargetStatusInput,
): TargetDto {
  const dto: TargetDto = {
    id: target.id,
    name: target.name,
    hostname: target.hostname,
    hostnameOverride: target.hostnameOverride,
    os: target.os,
    osVersion: target.osVersion,
    arch: target.arch,
    labels: target.labels,
    status: input.status,
    lastHeartbeatAt: isoOrNull(target.lastHeartbeatAt),
    lastTelemetryAt: isoOrNull(target.lastTelemetryAt),
    createdAt: iso(target.createdAt),
    updatedAt: iso(target.updatedAt),
    deletedAt: isoOrNull(target.deletedAt),
    agent: toAgentIdentityDto(target.agent),
  };
  if (input.pendingJobCount !== undefined) dto.pendingJobCount = input.pendingJobCount;
  if (input.runningJobCount !== undefined) dto.runningJobCount = input.runningJobCount;
  return dto;
}

export function toJobDto(job: Job, targetName?: string | null): JobDto {
  const dto: JobDto = {
    id: job.id,
    targetId: job.targetId,
    type: job.type,
    params: (job.params as Record<string, unknown> | null) ?? null,
    status: job.status,
    requestedBy: job.requestedBy,
    createdAt: iso(job.createdAt),
    dispatchedAt: isoOrNull(job.dispatchedAt),
    startedAt: isoOrNull(job.startedAt),
    finishedAt: isoOrNull(job.finishedAt),
    exitCode: job.exitCode,
    stdoutTail: job.stdoutTail,
    stderrTail: job.stderrTail,
    error: job.error,
    timeoutSec: job.timeoutSec,
  };
  if (targetName !== undefined) dto.targetName = targetName;
  return dto;
}

export function toAuditDto(event: AuditEvent): AuditEventDto {
  return {
    id: event.id,
    actorId: event.actorId,
    actorType: event.actorType,
    action: event.action,
    targetType: event.targetType,
    targetId: event.targetId,
    metadata: (event.metadata as Record<string, unknown> | null) ?? null,
    createdAt: iso(event.createdAt),
  };
}

export function toPaginated<T>(items: T[], page: number, pageSize: number, total: number): Paginated<T> {
  return {
    items,
    page,
    pageSize,
    total,
    totalPages: pageSize > 0 ? Math.max(1, Math.ceil(total / pageSize)) : 1,
  };
}

export const emptyPaginated = <T>(page: number, pageSize: number): Paginated<T> =>
  toPaginated<T>([], page, pageSize, 0);

/**
 * Maps a stored TelemetrySnapshot to its wire DTO. The `raw` column holds the
 * full validated heartbeat payload, so auxiliary fields (cores, disks, services…)
 * are re-validated defensively before being returned.
 */
export function toTelemetryDto(snapshot: TelemetrySnapshot): TelemetryDto {
  const parsed = heartbeatSchema.safeParse(snapshot.raw);
  const raw = parsed.success ? parsed.data : null;

  return {
    id: snapshot.id,
    targetId: snapshot.targetId,
    capturedAt: iso(snapshot.capturedAt),
    cpuModel: raw?.cpuModel ?? null,
    cpuPct: snapshot.cpuPct,
    cores: raw?.cores ?? null,
    load1: snapshot.load1,
    load5: snapshot.load5,
    load15: snapshot.load15,
    memTotalBytes: Number(snapshot.memTotalBytes),
    memUsedBytes: Number(snapshot.memUsedBytes),
    memAvailableBytes: Number(snapshot.memAvailableBytes),
    swapTotalBytes: raw?.swapTotalBytes ?? null,
    swapUsedBytes: snapshot.swapUsedBytes === null ? null : Number(snapshot.swapUsedBytes),
    osPrettyName: raw?.osPrettyName ?? null,
    diskUsedBytes: snapshot.diskUsedBytes === null ? null : Number(snapshot.diskUsedBytes),
    diskTotalBytes: snapshot.diskTotalBytes === null ? null : Number(snapshot.diskTotalBytes),
    netRxRateBps: snapshot.netRxRateBps,
    netTxRateBps: snapshot.netTxRateBps,
    uptimeSec: snapshot.uptimeSec === null ? null : Number(snapshot.uptimeSec),
    bootTime: raw?.bootTime ?? null,
    kernel: raw?.kernel ?? null,
    hostname: raw?.hostname ?? null,
    agentVersion: raw?.agentVersion ?? null,
    disks: raw?.disks ?? [],
    diskIO: raw?.diskIO ?? [],
    net: raw?.net ?? [],
    services: raw?.services ?? [],
    pkgUpdates: raw?.pkgUpdates ?? null,
    collectionErrors: raw?.collectionErrors ?? [],
  };
}

export type JobCountsByStatus = Map<string, number>;

/** Reduces a `groupBy(['targetId','status'])` result into per-target maps. */
export function jobCountMaps(
  rows: readonly { targetId: string; status: string; _count: { _all: number } }[],
): { pending: JobCountsByStatus; running: JobCountsByStatus } {
  const pending: JobCountsByStatus = new Map();
  const running: JobCountsByStatus = new Map();
  for (const row of rows) {
    const count = row._count._all;
    if (row.status === "QUEUED") pending.set(row.targetId, count);
    if (row.status === "RUNNING") running.set(row.targetId, count);
  }
  return { pending, running };
}
