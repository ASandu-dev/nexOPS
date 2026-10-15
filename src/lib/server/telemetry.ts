import { Prisma, type AgentIdentity, type Target } from "@prisma/client";
import type {
  FleetAggregateDto,
  TelemetryPointDto,
  TelemetryRange,
  TelemetrySeriesDto,
} from "@/lib/types";
import { prisma } from "./prisma";
import { toTelemetryDto } from "./dto";
import { getSettings } from "./settings";
import type { HeartbeatPayload } from "./schemas";

/**
 * Range → window and downsample bucket sizes (seconds).
 * Buckets are fixed grid-aligned (epoch origin) so consecutive requests line up.
 */
const RANGE_CONFIG: Record<TelemetryRange, { spanSec: number; bucketSec: number }> = {
  "1h": { spanSec: 60 * 60, bucketSec: 60 },
  "6h": { spanSec: 6 * 60 * 60, bucketSec: 300 },
  "24h": { spanSec: 24 * 60 * 60, bucketSec: 900 },
  "7d": { spanSec: 7 * 24 * 60 * 60, bucketSec: 3600 },
};

interface BucketRow {
  bucket: Date;
  cpuPct: number | null;
  memUsedPct: number | null;
  diskUsedPct: number | null;
  netRxRateBps: number | null;
  netTxRateBps: number | null;
}

/**
 * Persists one heartbeat: telemetry snapshot + liveness columns on the target,
 * and the agent's reported version. Callers have already authenticated the
 * bearer credential; this function assumes a valid, non-revoked identity.
 *
 * @returns whether this was the target's first-ever heartbeat
 */
export async function recordHeartbeat(args: {
  identity: AgentIdentity;
  target: Target;
  payload: HeartbeatPayload;
}): Promise<boolean> {
  const { identity, target, payload } = args;
  const now = new Date();
  const firstHeartbeat = target.lastHeartbeatAt === null;

  const hasDisks = payload.disks.length > 0;
  const hasNet = payload.net.length > 0;
  const diskUsedBytes = payload.disks.reduce((sum, d) => sum + d.usedBytes, 0);
  const diskTotalBytes = payload.disks.reduce((sum, d) => sum + d.totalBytes, 0);
  const netRxRateBps = payload.net.reduce((sum, n) => sum + n.rxRateBps, 0);
  const netTxRateBps = payload.net.reduce((sum, n) => sum + n.txRateBps, 0);

  await prisma.$transaction([
    prisma.telemetrySnapshot.create({
      data: {
        targetId: target.id,
        capturedAt: new Date(payload.capturedAt),
        cpuPct: payload.cpuPct,
        load1: payload.load1,
        load5: payload.load5,
        load15: payload.load15,
        memTotalBytes: BigInt(Math.round(payload.memTotalBytes)),
        memUsedBytes: BigInt(Math.round(payload.memUsedBytes)),
        memAvailableBytes: BigInt(Math.round(payload.memAvailableBytes)),
        swapUsedBytes:
          payload.swapUsedBytes === null ? null : BigInt(Math.round(payload.swapUsedBytes)),
        diskUsedBytes: hasDisks ? BigInt(Math.round(diskUsedBytes)) : null,
        diskTotalBytes: hasDisks ? BigInt(Math.round(diskTotalBytes)) : null,
        netRxRateBps: hasNet ? netRxRateBps : null,
        netTxRateBps: hasNet ? netTxRateBps : null,
        uptimeSec: payload.uptimeSec === null ? null : BigInt(Math.round(payload.uptimeSec)),
        raw: payload as unknown as Prisma.InputJsonValue,
      },
    }),
    prisma.target.update({
      where: { id: target.id },
      data: {
        lastHeartbeatAt: now,
        lastTelemetryAt: now,
        hostname: payload.hostname,
        // Stored liveness becomes ONLINE; MAINTENANCE/DEGRADED/OFFLINE are derived at read time.
        ...(target.status !== "ONLINE" ? { status: "ONLINE" as const } : {}),
      },
    }),
    prisma.agentIdentity.update({
      where: { id: identity.id },
      data: { agentVersion: payload.agentVersion },
    }),
  ]);

  return firstHeartbeat;
}

/** Downsampled point series for charts, aggregated in SQL over the (targetId, capturedAt) index. */
export async function getTelemetrySeries(
  targetId: string,
  range: TelemetryRange,
): Promise<TelemetrySeriesDto> {
  const config = RANGE_CONFIG[range];
  const sinceMs = Date.now() - config.spanSec * 1000;
  // bucketSec only ever comes from the whitelist above; injected as a SQL literal interval.
  const interval = Prisma.raw(`interval '${config.bucketSec} seconds'`);

  const rows = await prisma.$queryRaw<BucketRow[]>`
    SELECT
      date_bin(${interval}, "capturedAt", to_timestamp(0)) AS bucket,
      avg("cpuPct") AS "cpuPct",
      avg(CASE WHEN "memTotalBytes" > 0
          THEN "memUsedBytes"::float8 / "memTotalBytes" * 100 END) AS "memUsedPct",
      avg(CASE WHEN "diskTotalBytes" > 0
          THEN "diskUsedBytes"::float8 / "diskTotalBytes" * 100 END) AS "diskUsedPct",
      avg("netRxRateBps") AS "netRxRateBps",
      avg("netTxRateBps") AS "netTxRateBps"
    FROM "TelemetrySnapshot"
    WHERE "targetId" = ${targetId}
      AND "capturedAt" >= to_timestamp(${sinceMs}::float8 / 1000.0)
    GROUP BY bucket
    ORDER BY bucket ASC
  `;

  const latest = await prisma.telemetrySnapshot.findFirst({
    where: { targetId },
    orderBy: { capturedAt: "desc" },
  });

  const points: TelemetryPointDto[] = rows.map((row) => ({
    capturedAt: row.bucket.toISOString(),
    cpuPct: row.cpuPct,
    memUsedPct: row.memUsedPct,
    diskUsedPct: row.diskUsedPct,
    netRxRateBps: row.netRxRateBps,
    netTxRateBps: row.netTxRateBps,
  }));

  return {
    targetId,
    range,
    intervalSec: config.bucketSec,
    points,
    latest: latest ? toTelemetryDto(latest) : null,
  };
}

/** Fleet-wide averages from each target's latest snapshot (one lateral join per target). */
export async function getFleetAggregates(): Promise<FleetAggregateDto> {
  const rows = await prisma.$queryRaw<
    Array<{
      sampledTargets: bigint;
      avgCpuPct: number | null;
      avgMemUsedPct: number | null;
      avgDiskUsedPct: number | null;
    }>
  >`
    SELECT
      count(*) AS "sampledTargets",
      avg(s."cpuPct") AS "avgCpuPct",
      avg(CASE WHEN s."memTotalBytes" > 0
          THEN s."memUsedBytes"::float8 / s."memTotalBytes" * 100 END) AS "avgMemUsedPct",
      avg(CASE WHEN s."diskTotalBytes" > 0
          THEN s."diskUsedBytes"::float8 / s."diskTotalBytes" * 100 END) AS "avgDiskUsedPct"
    FROM "Target" t
    JOIN LATERAL (
      SELECT s2."cpuPct", s2."memUsedBytes", s2."memTotalBytes",
             s2."diskUsedBytes", s2."diskTotalBytes"
      FROM "TelemetrySnapshot" s2
      WHERE s2."targetId" = t."id"
      ORDER BY s2."capturedAt" DESC
      LIMIT 1
    ) s ON TRUE
    WHERE t."deletedAt" IS NULL
  `;

  const row = rows[0];
  return {
    sampledTargets: row ? Number(row.sampledTargets) : 0,
    avgCpuPct: row?.avgCpuPct ?? null,
    avgMemUsedPct: row?.avgMemUsedPct ?? null,
    avgDiskUsedPct: row?.avgDiskUsedPct ?? null,
  };
}

export interface RetentionSweepResult {
  telemetryDeleted: number;
  tokensDeleted: number;
}

/**
 * Deletes telemetry older than the configured retention window and used
 * enrolment tokens older than 7 days (ARCHITECTURE.md §7).
 */
export async function runRetentionSweep(now = new Date()): Promise<RetentionSweepResult> {
  const { settings } = await getSettings();
  const telemetryCutoff = new Date(now.getTime() - settings.telemetryRetentionDays * 86_400_000);
  const tokenCutoff = new Date(now.getTime() - 7 * 86_400_000);

  const telemetry = await prisma.telemetrySnapshot.deleteMany({
    where: { capturedAt: { lt: telemetryCutoff } },
  });
  const tokens = await prisma.enrolmentToken.deleteMany({
    where: { usedAt: { not: null, lt: tokenCutoff } },
  });
  return { telemetryDeleted: telemetry.count, tokensDeleted: tokens.count };
}
