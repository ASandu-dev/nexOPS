"use client";

import { useState } from "react";
import { RotateCcw } from "lucide-react";
import type { JobDto, JobStatus } from "@/lib/types";
import { apiFetch, toApiError } from "@/lib/use-api";
import { Button, useSnackbar, type ButtonSize, type ButtonVariant } from "@/components/ui";

/** Statuses the API accepts for `POST /api/jobs/:id/retry`. */
const RETRYABLE_STATUSES: ReadonlySet<JobStatus> = new Set(["FAILED", "TIMED_OUT"]);

/** True when the job can be re-queued by the retry endpoint. */
export function isRetryableJob(status: JobStatus): boolean {
  return RETRYABLE_STATUSES.has(status);
}

export interface RetryJobButtonProps {
  jobId: string;
  /** Accessible name, e.g. "Retry APT upgrade job". */
  ariaLabel?: string | undefined;
  /** Called with the newly queued job once the retry is accepted. */
  onRetried?: ((job: JobDto) => void) | undefined;
  variant?: ButtonVariant | undefined;
  size?: ButtonSize | undefined;
  className?: string | undefined;
}

/**
 * Re-queues a failed or timed-out job. The API answers 409 `job_not_retryable`
 * (the job is no longer in a retryable state) and 409 `job_already_active` (an
 * equivalent job is already queued for the target); both are surfaced as
 * toasts and never as a page-level error.
 */
export function RetryJobButton({
  jobId,
  ariaLabel,
  onRetried,
  variant,
  size,
  className,
}: RetryJobButtonProps) {
  const { notify } = useSnackbar();
  const [retrying, setRetrying] = useState(false);

  async function retry() {
    setRetrying(true);
    try {
      const response = await apiFetch<{ job: JobDto }>(`/api/jobs/${jobId}/retry`, {
        method: "POST",
      });
      notify({
        message: `Queued retry as job ${response.job.id.slice(0, 8)}.`,
        variant: "success",
      });
      onRetried?.(response.job);
    } catch (caught) {
      const error = toApiError(caught);
      if (error.code === "job_already_active") {
        notify({
          message: "An equivalent job is already running for this target.",
          variant: "warning",
        });
        return;
      }
      notify({ message: error.message, variant: "error" });
    } finally {
      setRetrying(false);
    }
  }

  return (
    <Button
      variant={variant ?? "outlined"}
      size={size ?? "sm"}
      className={className}
      onClick={(event) => {
        // The button lives inside clickable table rows; retrying must not open
        // the job dialog as well.
        event.stopPropagation();
        retry();
      }}
      loading={retrying}
      aria-label={ariaLabel}
      leadingIcon={<RotateCcw className="size-4" aria-hidden="true" />}
    >
      Retry
    </Button>
  );
}
