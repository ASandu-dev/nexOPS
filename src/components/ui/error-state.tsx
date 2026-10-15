"use client";

import { AlertTriangle, RotateCw } from "lucide-react";
import { Button } from "./button";
import { cn } from "@/lib/cn";

export interface ErrorStateProps {
  title?: string;
  message: string;
  onRetry?: () => void;
  className?: string;
}

/** Inline error panel with an optional retry action. */
export function ErrorState({
  title = "Something went wrong",
  message,
  onRetry,
  className,
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-start gap-3 rounded-lg border border-error/40 bg-error-container px-4 py-4 text-on-error-container",
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
        <div className="flex flex-col gap-1">
          <p className="text-sm font-semibold">{title}</p>
          <p className="text-sm opacity-90">{message}</p>
        </div>
      </div>
      {onRetry ? (
        <Button
          variant="outlined"
          size="sm"
          onClick={onRetry}
          leadingIcon={<RotateCw className="size-4" aria-hidden="true" />}
          className="border-current text-current hover:bg-black/5"
        >
          Retry
        </Button>
      ) : null}
    </div>
  );
}
