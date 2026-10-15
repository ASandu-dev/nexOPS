import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}

/** Centered placeholder for views with no data. */
export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-outline-variant bg-surface-container px-6 py-12 text-center",
        className,
      )}
    >
      {icon ? (
        <div className="flex size-11 items-center justify-center rounded-full bg-surface-container-high text-on-surface-variant">
          {icon}
        </div>
      ) : null}
      <div className="flex flex-col gap-1">
        <p className="text-base font-semibold text-on-surface">{title}</p>
        {description ? (
          <p className="max-w-md text-sm text-on-surface-variant">{description}</p>
        ) : null}
      </div>
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}
