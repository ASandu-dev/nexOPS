import type { FleetMachineDto, TargetStatus, TelemetryDto } from "@/lib/types";
import { prisma } from "./prisma";
import { isoOrNull, toTelemetryDto, type TelemetrySnapshotInput } from "./dto";
import { deriveResourceWarnings } from "./warnings";

/**
 * Row shape of the latest-snapshot-per-target query below.
 *
 * `bigint` columns mirror the Prisma model: they are converted with `Number()`
 * inside the shared snapshot mapper, never leaked into JSON.
 */
interface FleetSnapshotRow {
  targetId: string;
  snapshotId: string | null;
  capturedAt: Date | null;
  cpuPct: number | null;
  load1: number | null;
  load5: number | null;
  load15: number | null;
  memTotalBytes: bigint | null;
  memUsedBytes: bigint | null;
  memAvailableBytes: bigint | null;
  swapUsedBytes: bigint | null;
  diskUsedBytes: bigint | null;
  diskTotalBytes: bigint | null;
  netRxRateBps: number | null;
  netTxRateBps: number | null;
  uptimeSec: bigint | null;
  /** Parsed JSON payload of the snapshot (Postgres jsonb). */
  raw: unknown;
}

/**
 * Operator-facing ordering of the fleet list: machines with connection
 * trouble first (OFFLINE, then DEGRADED), then healthy ONLINE machines, then
 * everything else (MAINTENANCE, PENDING_ENROLMENT, ENROLMENT_FAILED). Each
 * group is sorted by name so the list stays stable and scannable.
 */
const FLEET_STATUS_RANK: Record<TargetStatus, number> = {
  OFFLINE: 0,
  DEGRADED: 1,
  ONLINE: 2,
  MAINTENANCE: 3,
  PENDING_ENROLMENT: 3,
  ENROLMENT_FAILED: 3,
  REMOVED: 3,
};

/** A target and the latest snapshot that belongs to it (null when never seen). */
export interface FleetMachineInput {
  id: string;
  name: string;
  status: TargetStatus;
  lastHeartbeatAt: Date | null;
  lastTelemetryAt: Date | null;
  /** Enrolled identity's agent version; fallback when the snapshot has none. */
  agentVersion: string | null;
  snapshot: TelemetrySnapshotInput | null;
}

const round1 = (value: number): number => Math.round(value * 10) / 10;

/** memAvailable / memTotal as a percentage; null without a usable sample. */
function memAvailablePct(telemetry: TelemetryDto | null): number | null {
  if (!telemetry || telemetry.memTotalBytes <= 0) return null;
  return round1((telemetry.memAvailableBytes / telemetry.memTotalBytes) * 100);
}

/** swapUsed / swapTotal as a percentage; null when swap is absent or unknown. */
function swapUsedPct(telemetry: TelemetryDto | null): number | null {
  if (!telemetry) return null;
  const total = telemetry.swapTotalBytes;
  const used = telemetry.swapUsedBytes;
  if (total === null || total <= 0 || used === null) return null;
  return round1((used / total) * 100);
}

interface WorstDisk {
  mount: string;
  usedPct: number;
}

/** The filesystem with the highest used ratio; null when no disk is usable. */
function worstDisk(telemetry: TelemetryDto | null): WorstDisk | null {
  if (!telemetry) return null;
  let worst: { mount: string; usedPct: number } | null = null;
  for (const disk of telemetry.disks) {
    if (disk.totalBytes <= 0) continue;
    const usedPct = (disk.usedBytes / disk.totalBytes) * 100;
    if (worst === null || usedPct > worst.usedPct) {
      worst = { mount: disk.mount, usedPct };
    }
  }
  if (worst === null) return null;
  return { mount: worst.mount, usedPct: round1(worst.usedPct) };
}

/** Builds one fleet row from a target and its latest snapshot. */
export function toFleetMachineDto(input: FleetMachineInput): FleetMachineDto {
  const telemetry = input.snapshot ? toTelemetryDto(input.snapshot) : null;
  const disk = worstDisk(telemetry);

  return {
    id: input.id,
    name: input.name,
    status: input.status,
    lastHeartbeatAt: isoOrNull(input.lastHeartbeatAt),
    lastTelemetryAt: isoOrNull(input.lastTelemetryAt),
    agentVersion: telemetry?.agentVersion ?? input.agentVersion,
    cpuPct: telemetry?.cpuPct ?? null,
    memAvailablePct: memAvailablePct(telemetry),
    swapUsedPct: swapUsedPct(telemetry),
    diskWorstMount: disk?.mount ?? null,
    diskWorstUsedPct: disk?.usedPct ?? null,
    warnings: deriveResourceWarnings(telemetry),
    collectionErrorCount: telemetry?.collectionErrors.length ?? 0,
  };
}

function compareFleetMachines(a: FleetMachineDto, b: FleetMachineDto): number {
  const byRank = FLEET_STATUS_RANK[a.status] - FLEET_STATUS_RANK[b.status];
  if (byRank !== 0) return byRank;
  const byName = a.name.localeCompare(b.name);
  if (byName !== 0) return byName;
  // Names are not unique; the id keeps the order deterministic.
  return a.id.localeCompare(b.id);
}

/** Maps and orders the fleet rows: trouble first, then name within each group. */
export function buildFleetMachines(inputs: readonly FleetMachineInput[]): FleetMachineDto[] {
  return inputs.map(toFleetMachineDto).sort(compareFleetMachines);
}

function toSnapshotInput(row: FleetSnapshotRow): TelemetrySnapshotInput | null {
  if (row.snapshotId === null || row.capturedAt === null) return null;
  return {
    id: row.snapshotId,
    targetId: row.targetId,
    capturedAt: row.capturedAt,
    cpuPct: row.cpuPct,
    load1: row.load1,
    load5: row.load5,
    load15: row.load15,
    memTotalBytes: row.memTotalBytes ?? 0n,
    memUsedBytes: row.memUsedBytes ?? 0n,
    memAvailableBytes: row.memAvailableBytes ?? 0n,
    swapUsedBytes: row.swapUsedBytes,
    diskUsedBytes: row.diskUsedBytes,
    diskTotalBytes: row.diskTotalBytes,
    netRxRateBps: row.netRxRateBps,
    netTxRateBps: row.netTxRateBps,
    uptimeSec: row.uptimeSec,
    raw: row.raw,
  };
}

/**
 * Latest telemetry snapshot per non-deleted target, keyed by target id.
 *
 * One round-trip for the whole fleet. `DISTINCT ON (t.id)` is used because
 * Prisma's query API cannot express "latest row per group": there is no window
 * function support and `groupBy` cannot pick a row per group. The query rides
 * the existing `TelemetrySnapshot(targetId, capturedAt)` index and the fleet is
 * homelab-sized, so one indexed lookup per target is cheap.
 *
 * The LEFT JOIN keeps targets that never reported telemetry in the result set
 * with null metrics instead of dropping them from the fleet view.
 *
 * The SQL is a literal with no interpolation: no user input reaches it (the
 * caller is an authenticated operator viewing their own fleet).
 */
export async function getLatestSnapshotsByTarget(): Promise<Map<string, TelemetrySnapshotInput>> {
  const rows = await prisma.$queryRaw<FleetSnapshotRow[]>`
    SELECT DISTINCT ON (t."id")
      t."id" AS "targetId",
      s."id" AS "snapshotId",
      s."capturedAt" AS "capturedAt",
      s."cpuPct" AS "cpuPct",
      s."load1" AS "load1",
      s."load5" AS "load5",
      s."load15" AS "load15",
      s."memTotalBytes" AS "memTotalBytes",
      s."memUsedBytes" AS "memUsedBytes",
      s."memAvailableBytes" AS "memAvailableBytes",
      s."swapUsedBytes" AS "swapUsedBytes",
      s."diskUsedBytes" AS "diskUsedBytes",
      s."diskTotalBytes" AS "diskTotalBytes",
      s."netRxRateBps" AS "netRxRateBps",
      s."netTxRateBps" AS "netTxRateBps",
      s."uptimeSec" AS "uptimeSec",
      s."raw" AS "raw"
    FROM "Target" t
    LEFT JOIN "TelemetrySnapshot" s ON s."targetId" = t."id"
    WHERE t."deletedAt" IS NULL
    ORDER BY t."id", s."capturedAt" DESC
  `;

  const byTarget = new Map<string, TelemetrySnapshotInput>();
  for (const row of rows) {
    const snapshot = toSnapshotInput(row);
    if (snapshot) byTarget.set(row.targetId, snapshot);
  }
  return byTarget;
}
