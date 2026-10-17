import { z } from "zod";
import {
  ACTOR_TYPES,
  JOB_STATUSES,
  JOB_TYPES,
  OS_FAMILIES,
  TARGET_STATUSES,
  TELEMETRY_RANGES,
  type OsFamily,
} from "@/lib/types";

/** Lenient ISO-8601 check: agents may send 'Z' or numeric offsets. */
export const isoDateTimeSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => Number.isFinite(Date.parse(value)), { message: "Invalid ISO-8601 timestamp" });

const byteCount = z.number().nonnegative();
const rate = z.number().nonnegative();

export const diskDtoSchema = z.object({
  mount: z.string().min(1).max(4096),
  fsType: z.string().min(1).max(64),
  totalBytes: byteCount,
  usedBytes: byteCount,
  inodesTotal: byteCount,
  inodesUsed: byteCount,
});

export const netDtoSchema = z.object({
  name: z.string().min(1).max(64),
  rxBytes: byteCount,
  txBytes: byteCount,
  rxRateBps: rate,
  txRateBps: rate,
});

export const serviceDtoSchema = z.object({
  name: z.string().min(1).max(128),
  state: z.string().min(1).max(64),
});

export const pkgUpdatesSchema = z.object({
  availableCount: z.number().int().nonnegative(),
  rebootRequired: z.boolean(),
});

/** Mirrors `HeartbeatRequest` in src/lib/types.ts. */
export const heartbeatSchema = z.object({
  capturedAt: isoDateTimeSchema,
  cpuPct: z.number().min(0).max(100).nullable(),
  cores: z.number().int().nonnegative().nullable(),
  load1: z.number().nonnegative().nullable(),
  load5: z.number().nonnegative().nullable(),
  load15: z.number().nonnegative().nullable(),
  memTotalBytes: byteCount,
  memUsedBytes: byteCount,
  memAvailableBytes: byteCount,
  swapUsedBytes: byteCount.nullable(),
  disks: z.array(diskDtoSchema).max(64),
  net: z.array(netDtoSchema).max(64),
  uptimeSec: byteCount.nullable(),
  bootTime: isoDateTimeSchema.nullable(),
  kernel: z.string().max(256).nullable(),
  hostname: z.string().min(1).max(253),
  agentVersion: z.string().min(1).max(64),
  services: z.array(serviceDtoSchema).max(256),
  pkgUpdates: pkgUpdatesSchema.nullable(),
  activeJobIds: z.array(z.string().min(1).max(64)).optional(),
});

export type HeartbeatPayload = z.infer<typeof heartbeatSchema>;

/** Mirrors `AgentEnrolRequest` in src/lib/types.ts. */
export const enrolSchema = z.object({
  token: z.string().min(16).max(512),
  publicKey: z.string().min(32).max(2048),
  hostname: z.string().min(1).max(253),
  os: z.enum(OS_FAMILIES),
  arch: z.string().min(1).max(32),
  osVersion: z.string().min(1).max(64),
  agentVersion: z.string().min(1).max(64),
  signature: z.string().min(64).max(256),
});

/**
 * Mirrors `JobResultRequest`, widened with TIMED_OUT and CANCELLED: the agent
 * reports it after killing a process group on timeout/cancel (ARCHITECTURE.md §3).
 */
export const jobResultSchema = z.object({
  status: z.enum(["SUCCEEDED", "FAILED", "TIMED_OUT", "CANCELLED"]),
  exitCode: z.number().int().min(-256).max(65535).nullable(),
  stdoutTail: z.string().nullable(),
  stderrTail: z.string().nullable(),
  startedAt: isoDateTimeSchema.nullable(),
  finishedAt: isoDateTimeSchema.nullable(),
});

// ---------------------------------------------------------------------------
// Operator-side query schemas
// ---------------------------------------------------------------------------

/**
 * Parses a comma-separated list of enum values. The final transform casts to
 * the literal union — safe because `refine` already rejected every other value.
 */
function csvEnum<T extends readonly [string, ...string[]]>(allowed: T) {
  return z
    .string()
    .optional()
    .transform((value) =>
      value === undefined || value === ""
        ? undefined
        : [
            ...new Set(
              value
                .split(",")
                .map((entry) => entry.trim())
                .filter((entry) => entry.length > 0),
            ),
          ],
    )
    .refine(
      (values) => values === undefined || values.every((v) => (allowed as readonly string[]).includes(v)),
      { message: "Unsupported value in comma-separated list" },
    )
    .transform((values): T[number][] | undefined => values as T[number][] | undefined);
}

export const targetListQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  status: csvEnum(TARGET_STATUSES),
  label: z.string().trim().max(120).optional(),
  sort: z.enum(["name", "status", "lastHeartbeatAt", "createdAt"]).optional(),
  order: z.enum(["asc", "desc"]).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});

export const jobListQuerySchema = z.object({
  status: csvEnum(JOB_STATUSES),
  targetId: z.string().trim().max(64).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});

export const auditListQuerySchema = z.object({
  action: z.string().trim().max(120).optional(),
  actorType: z.enum(ACTOR_TYPES).optional(),
  targetId: z.string().trim().max(64).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});

export const telemetryQuerySchema = z.object({
  range: z.enum(TELEMETRY_RANGES).optional(),
});

// ---------------------------------------------------------------------------
// Operator-side body schemas
// ---------------------------------------------------------------------------

const labelsSchema = z
  .array(z.string().trim().min(1).max(40))
  .max(20)
  .default([])
  .transform((labels) => [...new Set(labels)]);

export const createTargetSchema = z.object({
  name: z.string().trim().min(1).max(100),
  // Accepts "ubuntu"/"UBUNTU" (and debian) — both sides of the contract speak either.
  os: z
    .string()
    .trim()
    .toLowerCase()
    .refine((value) => value === "ubuntu" || value === "debian", {
      message: "os must be 'ubuntu' or 'debian'",
    })
    .transform((value): OsFamily => (value === "ubuntu" ? "UBUNTU" : "DEBIAN")),
  hostnameOverride: z.string().trim().min(1).max(253).nullish(),
  labels: labelsSchema,
});

export const updateTargetSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    hostnameOverride: z.string().trim().min(1).max(253).nullish(),
    labels: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  })
  .refine((value) => Object.values(value).some((v) => v !== undefined), {
    message: "Provide at least one field to update",
  });

export const createJobSchema = z.object({
  targetId: z.string().trim().min(1).max(64),
  type: z.enum(JOB_TYPES),
  params: z.record(z.string().max(64), z.unknown()).nullable().optional(),
});
