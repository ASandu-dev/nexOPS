/**
 * Shared DTO contract for NexOPS.
 *
 * These types are the wire format spoken by the control-plane API, the UI, and
 * the agent. They are deliberately decoupled from Prisma models: enums are
 * modelled as string-literal unions so both sides compile independently, and
 * every field is camelCase.
 *
 * Byte counts are `number` on the wire. Prisma stores them as `BigInt`; the API
 * boundary is responsible for converting with `Number(value)` (or a lossless
 * string when a value can exceed Number.MAX_SAFE_INTEGER — see toBigIntSafe).
 */

export const TARGET_STATUSES = [
  "PENDING_ENROLMENT",
  "ONLINE",
  "OFFLINE",
  "DEGRADED",
  "ENROLMENT_FAILED",
  "MAINTENANCE",
  "REMOVED",
] as const;
export type TargetStatus = (typeof TARGET_STATUSES)[number];

export const OS_FAMILIES = ["UBUNTU", "DEBIAN"] as const;
export type OsFamily = (typeof OS_FAMILIES)[number];

export const JOB_TYPES = [
  "APT_UPDATE",
  "APT_UPGRADE",
  "CHECK_UPDATES",
  "SERVICE_STATUS",
] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const JOB_STATUSES = [
  "QUEUED",
  "DISPATCHED",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const ACTOR_TYPES = ["USER", "AGENT", "SYSTEM"] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export const TELEMETRY_RANGES = ["1h", "6h", "24h", "7d"] as const;
export type TelemetryRange = (typeof TELEMETRY_RANGES)[number];

/** ISO-8601 timestamp string. */
export type IsoDateTime = string;

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

export interface AgentIdentityDto {
  agentVersion: string | null;
  enrolledAt: IsoDateTime | null;
  revokedAt: IsoDateTime | null;
  /** Present only in the enrol response; never returned by read endpoints. */
  hasCredential: boolean;
}

export interface TargetDto {
  id: string;
  name: string;
  hostnameOverride: string | null;
  os: OsFamily;
  osVersion: string | null;
  arch: string | null;
  labels: string[];
  status: TargetStatus;
  lastHeartbeatAt: IsoDateTime | null;
  lastTelemetryAt: IsoDateTime | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  deletedAt: IsoDateTime | null;
  agent: AgentIdentityDto | null;
}

/** Response of `POST /api/targets`; the only place the raw enrolment token is exposed. */
export interface CreateTargetResponseDto {
  target: TargetDto;
  enrolmentToken: string;
  expiresAt: IsoDateTime;
  installCommand: string;
}

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

export interface DiskUsageDto {
  mount: string;
  fsType: string;
  totalBytes: number;
  usedBytes: number;
  inodesTotal: number;
  inodesUsed: number;
}

export interface NetInterfaceDto {
  name: string;
  rxBytes: number;
  txBytes: number;
  rxRateBps: number;
  txRateBps: number;
}

export interface ServiceStateDto {
  name: string;
  state: string;
}

export interface PkgUpdateSummaryDto {
  availableCount: number;
  rebootRequired: boolean;
}

export interface TelemetryDto {
  id: string;
  targetId: string;
  capturedAt: IsoDateTime;
  cpuPct: number | null;
  cores: number | null;
  load1: number | null;
  load5: number | null;
  load15: number | null;
  memTotalBytes: number;
  memUsedBytes: number;
  memAvailableBytes: number;
  swapUsedBytes: number | null;
  diskUsedBytes: number | null;
  diskTotalBytes: number | null;
  netRxRateBps: number | null;
  netTxRateBps: number | null;
  uptimeSec: number | null;
  bootTime: IsoDateTime | null;
  kernel: string | null;
  hostname: string | null;
  agentVersion: string | null;
  disks: DiskUsageDto[];
  net: NetInterfaceDto[];
  services: ServiceStateDto[];
  pkgUpdates: PkgUpdateSummaryDto | null;
}

/** Downsampled series returned by `GET /api/targets/[id]/telemetry`. */
export interface TelemetryPointDto {
  capturedAt: IsoDateTime;
  cpuPct: number | null;
  memUsedPct: number | null;
  diskUsedPct: number | null;
  netRxRateBps: number | null;
  netTxRateBps: number | null;
}

export interface TelemetrySeriesDto {
  targetId: string;
  range: TelemetryRange;
  intervalSec: number;
  points: TelemetryPointDto[];
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export interface JobDto {
  id: string;
  targetId: string;
  type: JobType;
  params: Record<string, unknown> | null;
  status: JobStatus;
  requestedBy: string;
  createdAt: IsoDateTime;
  dispatchedAt: IsoDateTime | null;
  startedAt: IsoDateTime | null;
  finishedAt: IsoDateTime | null;
  exitCode: number | null;
  stdoutTail: string | null;
  stderrTail: string | null;
  error: string | null;
  timeoutSec: number;
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export interface AuditEventDto {
  id: string;
  actorId: string;
  actorType: ActorType;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: IsoDateTime;
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export interface StatusCountDto {
  status: TargetStatus;
  count: number;
}

export interface OverviewDto {
  totals: {
    targets: number;
    online: number;
    offline: number;
    degraded: number;
    maintenance: number;
    pendingEnrolment: number;
    enrolmentFailed: number;
  };
  countsByStatus: StatusCountDto[];
  degradedTargets: TargetDto[];
  activeJobs: JobDto[];
  failedJobs: JobDto[];
  recentJobs: JobDto[];
  recentAudit: AuditEventDto[];
}

// ---------------------------------------------------------------------------
// Agent wire protocol
// ---------------------------------------------------------------------------

export interface AgentEnrolRequest {
  token: string;
  publicKey: string;
  hostname: string;
  os: OsFamily;
  arch: string;
  osVersion: string;
  agentVersion: string;
  /** Base64 Ed25519 signature over the raw token bytes. */
  signature: string;
}

export interface AgentEnrolResponse {
  agentId: string;
  targetId: string;
  credential: string;
  heartbeatIntervalSec: number;
}

export interface HeartbeatRequest {
  capturedAt: IsoDateTime;
  cpuPct: number | null;
  cores: number | null;
  load1: number | null;
  load5: number | null;
  load15: number | null;
  memTotalBytes: number;
  memUsedBytes: number;
  memAvailableBytes: number;
  swapUsedBytes: number | null;
  disks: DiskUsageDto[];
  net: NetInterfaceDto[];
  uptimeSec: number | null;
  bootTime: IsoDateTime | null;
  kernel: string | null;
  hostname: string;
  agentVersion: string;
  services: ServiceStateDto[];
  pkgUpdates: PkgUpdateSummaryDto | null;
}

export interface HeartbeatResponse {
  jobs: JobDto[];
}

export interface JobResultRequest {
  status: Extract<JobStatus, "SUCCEEDED" | "FAILED">;
  exitCode: number | null;
  stdoutTail: string | null;
  stderrTail: string | null;
  startedAt: IsoDateTime | null;
  finishedAt: IsoDateTime | null;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface SettingsDto {
  telemetryRetentionDays: number;
  heartbeatIntervalSec: number;
  watchedServices: string[];
  updatedAt: IsoDateTime;
}

// ---------------------------------------------------------------------------
// Pagination envelope
// ---------------------------------------------------------------------------

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}
