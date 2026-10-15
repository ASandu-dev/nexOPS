import Link from "next/link";
import type { Route } from "next";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export type StatTone = "default" | "success" | "warning" | "error" | "info";

const TONE_VALUE: Record<StatTone, string> = {
  default: "text-on-surface",
  success: "text-success",
  warning: "text-warning",
  error: "text-error",
  info: "text-primary",
};

export interface StatCardProps {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  tone?: StatTone;
  /** When set the whole card becomes a link. */
  href?: Route;
  className?: string;
}

/** Compact metric tile used across the overview. */
export function StatCard({ label, value, hint, icon, tone = "default", href, className }: StatCardProps) {
  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-on-surface-variant">{label}</span>
        {icon ? <span className="text-on-surface-variant">{icon}</span> : null}
      </div>
      <span className={cn("text-2xl font-semibold tabular-nums", TONE_VALUE[tone])}>{value}</span>
      {hint ? <span className="text-xs text-on-surface-variant">{hint}</span> : null}
    </>
  );

  const base = "flex flex-col gap-1 rounded-lg border border-outline-variant bg-surface-container p-4 shadow-sm";

  if (href) {
    return (
      <Link
        href={href}
        className={cn(
          base,
          "transition-colors hover:bg-surface-container-high focus-visible:ring-2 focus-visible:ring-primary",
          className,
        )}
      >
        {body}
      </Link>
    );
  }

  return <div className={cn(base, className)}>{body}</div>;
}
