"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Ban } from "lucide-react";
import type { JobDto } from "@/lib/types";
import { apiFetch, toApiError, useApi } from "@/lib/use-api";
import { formatDuration } from "@/lib/format";
import { formatJobDuration, JOB_TYPE_LABEL } from "@/lib/display";
import {
  Button,
  CodeBlock,
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  ErrorState,
  JobStatusBadge,
  Skeleton,
  useSnackbar,
} from "@/components/ui";
import { RelativeTime } from "@/components/common/relative-time";
import { RetryJobButton, isRetryableJob } from "@/components/jobs/retry-job-button";

const TERMINAL_STATUSES: ReadonlySet<JobDto["status"]> = new Set([
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
]);

export interface JobDetailDialogProps {
  jobId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful cancel so lists can refresh. */
  onChanged?: () => void;
}

export function JobDetailDialog({ jobId, open, onOpenChange, onChanged }: JobDetailDialogProps) {
  const { notify } = useSnackbar();
  const [cancelling, setCancelling] = useState(false);
  const [confirming, setConfirming] = useState(false);

  // Poll only while the job is still running; terminal jobs never change again.
  const [polling, setPolling] = useState(false);
  const { data, error, loading, refresh } = useApi<JobDto>(
    open && jobId ? `/api/jobs/${jobId}` : null,
    { ...(polling ? { refreshIntervalMs: 5000 } : {}) },
  );

  useEffect(() => {
    setPolling(data !== null && !TERMINAL_STATUSES.has(data.status));
  }, [data]);

  const isActive = data !== null && !TERMINAL_STATUSES.has(data.status);
  const retryableJob = data !== null && isRetryableJob(data.status) ? data : null;

  async function cancel() {
    if (!jobId) return;
    setCancelling(true);
    try {
      await apiFetch<JobDto>(`/api/jobs/${jobId}/cancel`, { method: "POST" });
      notify({ message: "Cancel sent to the target.", variant: "success" });
      setConfirming(false);
      refresh();
      onChanged?.();
    } catch (caught) {
      notify({ message: toApiError(caught).message, variant: "error" });
    } finally {
      setCancelling(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} className="max-w-2xl" ariaLabel="Job details">
      <DialogHeader>
        <DialogTitle>Job details</DialogTitle>
        <DialogDescription>
          {data ? JOB_TYPE_LABEL[data.type] : "Loading job…"}
        </DialogDescription>
      </DialogHeader>

      {loading ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : error ? (
        <ErrorState message={error.message} onRetry={refresh} />
      ) : data ? (
        <div className="flex flex-col gap-4">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-3">
            <Detail label="Status">
              <JobStatusBadge status={data.status} />
            </Detail>
            <Detail label="Target">
              <Link
                href={`/targets/${data.targetId}`}
                className="text-primary hover:underline"
              >
                {data.targetName ?? data.targetId}
              </Link>
            </Detail>
            <Detail label="Requested by">
              <span className="break-all">{data.requestedBy}</span>
            </Detail>
            <Detail label="Created">
              <RelativeTime value={data.createdAt} />
            </Detail>
            <Detail label="Started">
              <RelativeTime value={data.startedAt} />
            </Detail>
            <Detail label="Finished">
              <RelativeTime value={data.finishedAt} />
            </Detail>
            <Detail label="Duration">
              {formatJobDuration(data)}
            </Detail>
            <Detail label="Exit code">
              {data.exitCode === null ? "—" : data.exitCode}
            </Detail>
            <Detail label="Timeout">{formatDuration(data.timeoutSec)}</Detail>
          </dl>

          {data.error ? (
            <p className="rounded-md border border-error/40 bg-error-container px-3 py-2 text-sm text-on-error-container">
              {data.error}
            </p>
          ) : null}

          {isSelfUpdateBootstrapFailure(data) ? (
            <SelfUpdateBootstrapCallout targetId={data.targetId} />
          ) : null}

          <CodeBlock label="stdout (tail)" code={data.stdoutTail ?? "(empty)"} />
          <CodeBlock label="stderr (tail)" code={data.stderrTail ?? "(empty)"} />
        </div>
      ) : null}

      <DialogFooter className="flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-end">
        {isActive && confirming ? (
          <>
            <p className="mr-auto text-sm text-on-surface-variant">
              Sends a kill to the job&apos;s process on the target. The agent stops it within a few
              seconds.
            </p>
            <Button variant="text" onClick={() => setConfirming(false)} disabled={cancelling}>
              Keep running
            </Button>
            <Button
              variant="danger"
              onClick={cancel}
              loading={cancelling}
              leadingIcon={<Ban className="size-4" aria-hidden="true" />}
            >
              Confirm cancel
            </Button>
          </>
        ) : (
          <>
            {isActive ? (
              <Button
                variant="danger"
                onClick={() => setConfirming(true)}
                leadingIcon={<Ban className="size-4" aria-hidden="true" />}
              >
                Cancel job
              </Button>
            ) : null}
            {retryableJob ? (
              <RetryJobButton
                jobId={retryableJob.id}
                ariaLabel={`Retry ${JOB_TYPE_LABEL[retryableJob.type]} job`}
                size="md"
                onRetried={() => {
                  refresh();
                  onChanged?.();
                }}
              />
            ) : null}
            <Button variant="text" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          </>
        )}
      </DialogFooter>
    </Dialog>
  );
}

/**
 * A pre-self-update agent rejects the job type outright, so the job fails in
 * milliseconds and the stderr tail alone does not explain how to recover.
 */
function isSelfUpdateBootstrapFailure(job: JobDto): boolean {
  if (job.type !== "SELF_UPDATE" || job.status !== "FAILED") return false;
  return job.stderrTail?.toLowerCase().includes("unknown job type") ?? false;
}

/** Mirrors the warning banner used for failed metric collectors. */
function SelfUpdateBootstrapCallout({ targetId }: { targetId: string }) {
  return (
    <div
      role="status"
      className="flex flex-col gap-2 rounded-lg border border-warning-container bg-warning-container p-4"
    >
      <p className="flex items-center gap-2 text-sm font-semibold text-on-warning-container">
        <AlertTriangle className="size-4" aria-hidden="true" />
        Agent predates self-update support
      </p>
      <p className="text-sm text-on-warning-container">
        This agent&apos;s binary predates self-update support, so this job cannot install it the
        first time. Re-run the install command once on the machine (use &quot;Re-issue install
        command&quot; on the target page), then self-update works unattended.
      </p>
      <Link
        href={`/targets/${targetId}`}
        className="w-fit text-sm font-semibold text-on-warning-container underline underline-offset-2 hover:text-primary focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-warning-container"
      >
        Open target page
      </Link>
    </div>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs font-medium uppercase tracking-wide text-on-surface-variant">{label}</dt>
      <dd className="text-on-surface">{children}</dd>
    </div>
  );
}
