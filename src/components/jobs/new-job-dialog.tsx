"use client";

import { useEffect, useState } from "react";
import type { JobDto, JobType, Paginated, TargetDto } from "@/lib/types";
import { JOB_TYPES } from "@/lib/types";
import { apiFetch, toApiError, useApi } from "@/lib/use-api";
import { JOB_TYPE_DESCRIPTION, JOB_TYPE_LABEL } from "@/lib/display";
import {
  Button,
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  ErrorState,
  Select,
  Skeleton,
  useSnackbar,
} from "@/components/ui";

export interface NewJobDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-selects a target (used from the target detail page). */
  defaultTargetId?: string;
  onCreated?: (job: JobDto) => void;
}

export function NewJobDialog({ open, onOpenChange, defaultTargetId, onCreated }: NewJobDialogProps) {
  const { notify } = useSnackbar();
  const [targetId, setTargetId] = useState(defaultTargetId ?? "");
  const [type, setType] = useState<JobType>("CHECK_UPDATES");
  const [submitting, setSubmitting] = useState(false);

  const { data, error, loading, refresh } = useApi<Paginated<TargetDto>>(
    open ? "/api/targets?pageSize=100&sort=name&order=asc" : null,
  );

  useEffect(() => {
    if (open) setTargetId(defaultTargetId ?? "");
  }, [open, defaultTargetId]);

  const targets = data?.items ?? [];
  const targetOptions = targets.map((target) => ({
    value: target.id,
    label: `${target.name} · ${target.status.replace(/_/g, " ").toLowerCase()}`,
  }));

  async function submit() {
    if (!targetId) {
      notify({ message: "Select a target first.", variant: "warning" });
      return;
    }
    setSubmitting(true);
    try {
      const job = await apiFetch<JobDto>("/api/jobs", {
        method: "POST",
        body: { targetId, type },
      });
      notify({ message: `${JOB_TYPE_LABEL[type]} queued.`, variant: "success" });
      onCreated?.(job);
      onOpenChange(false);
    } catch (caught) {
      notify({ message: toApiError(caught).message, variant: "error" });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} ariaLabel="Create job">
      <DialogHeader>
        <DialogTitle>New job</DialogTitle>
        <DialogDescription>
          Queue a maintenance action. The target picks it up on its next heartbeat.
        </DialogDescription>
      </DialogHeader>

      {loading ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : error ? (
        <ErrorState message={error.message} onRetry={refresh} />
      ) : (
        <div className="flex flex-col gap-4">
          <Select
            label="Target"
            placeholder="Select a target"
            value={targetId}
            onChange={(event) => setTargetId(event.target.value)}
            options={targetOptions}
          />
          <div className="flex flex-col gap-1.5">
            <Select
              label="Job type"
              value={type}
              onChange={(event) => setType(event.target.value as JobType)}
              options={JOB_TYPES.map((value) => ({ value, label: JOB_TYPE_LABEL[value] }))}
            />
            <p className="text-xs text-on-surface-variant">{JOB_TYPE_DESCRIPTION[type]}</p>
          </div>
        </div>
      )}

      <DialogFooter>
        <Button variant="text" onClick={() => onOpenChange(false)} disabled={submitting}>
          Cancel
        </Button>
        <Button onClick={submit} loading={submitting} disabled={loading || error !== null}>
          Queue job
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
