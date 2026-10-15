import type { HTMLAttributes } from "react";
import { cn } from "@/lib/cn";
import type { ActorType, JobStatus, TargetStatus } from "@/lib/types";
import { ACTOR_TYPE_LABEL, JOB_STATUS_LABEL } from "@/lib/display";

export type BadgeVariant =
  | "neutral"
  | "info"
  | "online"
  | "offline"
  | "degraded"
  | "error"
  | "pending";

const VARIANT_CLASSES: Record<BadgeVariant, string> = {
  neutral: "bg-surface-container-high text-on-surface-variant border-outline-variant",
  info: "bg-primary-container text-on-primary-container border-transparent",
  online: "bg-success-container text-on-success-container border-transparent",
  offline: "bg-surface-container-high text-on-surface-variant border-outline-variant",
  degraded: "bg-warning-container text-on-warning-container border-transparent",
  error: "bg-error-container text-on-error-container border-transparent",
  pending: "bg-pending-container text-on-pending-container border-transparent",
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
  /** Optional leading swatch. Colour is never the sole carrier of meaning. */
  withDot?: boolean;
}

/**
 * Every badge renders a visible text label. Colour is reinforcement, never the
 * only signal, so the UI stays usable for colour-blind users and screen readers.
 */
export function Badge({
  variant = "neutral",
  withDot = false,
  className,
  children,
  ...rest
}: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium",
        VARIANT_CLASSES[variant],
        className,
      )}
      {...rest}
    >
      {withDot ? (
        <span
          className="size-1.5 rounded-full bg-current"
          aria-hidden="true"
        />
      ) : null}
      {children}
    </span>
  );
}

const STATUS_VARIANT: Record<TargetStatus, BadgeVariant> = {
  ONLINE: "online",
  OFFLINE: "offline",
  DEGRADED: "degraded",
  MAINTENANCE: "info",
  PENDING_ENROLMENT: "pending",
  ENROLMENT_FAILED: "error",
  REMOVED: "neutral",
};

const STATUS_LABEL: Record<TargetStatus, string> = {
  ONLINE: "Online",
  OFFLINE: "Offline",
  DEGRADED: "Degraded",
  MAINTENANCE: "Maintenance",
  PENDING_ENROLMENT: "Pending enrolment",
  ENROLMENT_FAILED: "Enrolment failed",
  REMOVED: "Removed",
};

export interface StatusBadgeProps extends Omit<HTMLAttributes<HTMLSpanElement>, "children"> {
  status: TargetStatus;
}

/** Canonical target-status pill. Always shows the human-readable label. */
export function StatusBadge({ status, ...rest }: StatusBadgeProps) {
  return (
    <Badge variant={STATUS_VARIANT[status]} withDot role="status" {...rest}>
      {STATUS_LABEL[status]}
    </Badge>
  );
}

const JOB_STATUS_VARIANT: Record<JobStatus, BadgeVariant> = {
  QUEUED: "pending",
  DISPATCHED: "info",
  RUNNING: "info",
  SUCCEEDED: "online",
  FAILED: "error",
  CANCELLED: "neutral",
  TIMED_OUT: "degraded",
};

export interface JobStatusBadgeProps extends Omit<HTMLAttributes<HTMLSpanElement>, "children"> {
  status: JobStatus;
}

/** Job-status pill; text label always present, colour is reinforcement only. */
export function JobStatusBadge({ status, ...rest }: JobStatusBadgeProps) {
  return (
    <Badge variant={JOB_STATUS_VARIANT[status]} withDot role="status" {...rest}>
      {JOB_STATUS_LABEL[status]}
    </Badge>
  );
}

const ACTOR_VARIANT: Record<ActorType, BadgeVariant> = {
  USER: "info",
  AGENT: "neutral",
  SYSTEM: "neutral",
};

export interface ActorTypeBadgeProps extends Omit<HTMLAttributes<HTMLSpanElement>, "children"> {
  actorType: ActorType;
}

/** Audit actor-type pill. */
export function ActorTypeBadge({ actorType, ...rest }: ActorTypeBadgeProps) {
  return (
    <Badge variant={ACTOR_VARIANT[actorType]} {...rest}>
      {ACTOR_TYPE_LABEL[actorType]}
    </Badge>
  );
}
