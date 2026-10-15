import type { HTMLAttributes } from "react";
import { cn } from "@/lib/cn";
import type { TargetStatus } from "@/lib/types";

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
