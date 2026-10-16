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
  "APT_FIX_BROKEN",
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
  /** Live hostname reported by the agent at enrolment/heartbeat (null until first report). */
  hostname?: string | null;
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
  /** Jobs waiting to be picked up on the next heartbeat (QUEUED). Populated by list/detail endpoints. */
  pendingJobCount?: number;
  /** Jobs currently executing on the target (RUNNING). Populated by list/detail endpoints. */
  runningJobCount?: number;
  /**
   * Latest-snapshot usage percentages. Optional: the list endpoint does not
   * currently populate these, so the UI renders "—" when they are absent.
   */
  cpuPct?: number | null;
  memUsedPct?: number | null;
  diskUsedPct?: number | null;
  /** Latest reported uptime in seconds. Optional for the same reason as above. */
  uptimeSec?: number | null;
}

export type TargetWarningCode =
  | "OFFLINE"
  | "TELEMETRY_STALE"
  | "NO_TELEMETRY"
  | "LOW_DISK"
  | "ENROLMENT_FAILED"
  | "CREDENTIAL_REVOKED";

export interface TargetWarningDto {
  code: TargetWarningCode;
  message: string;
  /** Extra context (mount point, percentage, …) depending on `code`. */
  detail?: Record<string, number | string>;
}

/** Detail payload of `GET /api/targets/[id]`. */
export interface TargetDetailDto extends TargetDto {
  warnings: TargetWarningDto[];
  recentJobs: JobDto[];
}

/** Response of `POST /api/targets`; the only place the raw enrolment token is exposed. */
export interface CreateTargetResponseDto {
  target: TargetDto;
  enrolmentToken: string;
  expiresAt: IsoDateTime;
  installCommand: string;
  /** Absolute URL of the installer script referenced by `installCommand`. */
  installerUrl?: string;
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
  /**
   * Load averages. Optional: the telemetry series endpoint does not currently
   * aggregate these, so the UI falls back to the latest snapshot's values.
   */
  load1?: number | null;
  load5?: number | null;
  load15?: number | null;
}

export interface TelemetrySeriesDto {
  targetId: string;
  range: TelemetryRange;
  intervalSec: number;
  points: TelemetryPointDto[];
  /** Most recent full snapshot (raw disks/net/services/pkgUpdates); null when the target never reported. */
  latest: TelemetryDto | null;
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
  /** Target display name; populated by endpoints that join `Target`. */
  targetName?: string | null;
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

/** Averages computed from each target's latest telemetry snapshot. */
export interface FleetAggregateDto {
  sampledTargets: number;
  avgCpuPct: number | null;
  avgMemUsedPct: number | null;
  avgDiskUsedPct: number | null;
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
  /** Worst-freshness DEGRADED and OFFLINE targets, capped at 10. */
  degradedTargets: TargetDto[];
  activeJobs: JobDto[];
  failedJobs: JobDto[];
  recentJobs: JobDto[];
  recentAudit: AuditEventDto[];
  fleet: FleetAggregateDto;
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
  /** TIMED_OUT is accepted because the agent reports it after killing the process group. */
  status: Extract<JobStatus, "SUCCEEDED" | "FAILED" | "TIMED_OUT">;
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
