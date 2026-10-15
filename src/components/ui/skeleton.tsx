import type { HTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export interface SkeletonProps extends HTMLAttributes<HTMLDivElement> {
  /** Tailwind sizing classes, e.g. "h-4 w-32". */
  className?: string;
}

/** Grey placeholder with `aria-hidden`; screen readers should read a live region instead. */
export function Skeleton({ className, ...rest }: SkeletonProps) {
  return (
    <div
      aria-hidden="true"
      className={cn("animate-pulse rounded-md bg-surface-container-high", className)}
      {...rest}
    />
  );
}

export interface SkeletonTextProps {
  lines?: number;
  className?: string;
}

/** Stack of text-line placeholders. */
export function SkeletonText({ lines = 3, className }: SkeletonTextProps) {
  return (
    <div className={cn("flex flex-col gap-2", className)} role="presentation">
      {Array.from({ length: Math.max(lines, 0) }, (_, index) => (
        <Skeleton
          key={index}
          className={index === lines - 1 ? "h-4 w-2/3" : "h-4 w-full"}
        />
      ))}
    </div>
  );
}
