"use client";

import { useEffect, useId, useState } from "react";
import { Info } from "lucide-react";
import type { BulkJobResultDto, BulkJobType } from "@/lib/types";
import { BULK_JOB_TYPES } from "@/lib/types";
import { apiFetch, toApiError } from "@/lib/use-api";
import { JOB_TYPE_LABEL } from "@/lib/display";
import { cn } from "@/lib/cn";
import {
  Button,
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  useSnackbar,
} from "@/components/ui";

/** One-line explanation per bulk job type, shown under the radio label. */
const BULK_TYPE_HINT: Record<BulkJobType, string> = {
  APT_UPGRADE: "Installs every available OS package upgrade on each eligible target.",
  SELF_UPDATE:
    "Replaces the agent binary on each eligible target with the latest release and restarts the agent.",
};

export interface BulkUpgradeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the API result once the dispatch is accepted. */
  onDispatched?: ((result: BulkJobResultDto) => void) | undefined;
}

/**
 * Fleet-wide upgrade dispatch. Sends one job to every eligible target and
 * reports how many were created and how many were skipped.
 */
export function BulkUpgradeDialog({ open, onOpenChange, onDispatched }: BulkUpgradeDialogProps) {
  const { notify } = useSnackbar();
  const [type, setType] = useState<BulkJobType>("APT_UPGRADE");
  const [dispatching, setDispatching] = useState(false);
  const groupName = useId();

  // Always start from the default choice when the dialog is reopened.
  useEffect(() => {
    if (open) setType("APT_UPGRADE");
  }, [open]);

  async function dispatch() {
    setDispatching(true);
    try {
      const result = await apiFetch<BulkJobResultDto>("/api/jobs/bulk", {
        method: "POST",
        body: { type },
      });
      const created = result.created;
      const skipped = result.skipped.length;
      const jobLabel = JOB_TYPE_LABEL[type];

      if (created === 0) {
        notify({
          message:
            skipped > 0
              ? `No jobs queued — ${skipped} target${skipped === 1 ? "" : "s"} skipped (offline, pending enrolment, or in maintenance).`
              : "No jobs queued — no target is eligible for this upgrade.",
          variant: "info",
        });
      } else {
        notify({
          message:
            skipped > 0
              ? `Queued ${created} ${jobLabel} job${created === 1 ? "" : "s"}; ${skipped} target${skipped === 1 ? "" : "s"} skipped.`
              : `Queued ${created} ${jobLabel} job${created === 1 ? "" : "s"}.`,
          variant: "success",
        });
      }

      onDispatched?.(result);
      onOpenChange(false);
    } catch (caught) {
      notify({ message: toApiError(caught).message, variant: "error" });
    } finally {
      setDispatching(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      dismissOnBackdropClick={!dispatching}
      ariaLabel="Upgrade all targets"
    >
      <DialogHeader>
        <DialogTitle>Upgrade all targets</DialogTitle>
        <DialogDescription>
          Queue one {JOB_TYPE_LABEL[type]} job for every eligible target in the fleet.
        </DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-4">
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium text-on-surface">What should be upgraded?</legend>
          {BULK_JOB_TYPES.map((option) => (
            <label
              key={option}
              className={cn(
                "flex cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors",
                type === option
                  ? "border-primary bg-primary-container/20"
                  : "border-outline-variant hover:bg-surface-container-high",
              )}
            >
              <input
                type="radio"
                name={groupName}
                value={option}
                checked={type === option}
                onChange={() => setType(option)}
                className="mt-0.5 size-4 shrink-0 accent-primary focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
              />
              <span className="flex flex-col gap-0.5">
                <span className="text-sm font-medium text-on-surface">{JOB_TYPE_LABEL[option]}</span>
                <span className="text-xs text-on-surface-variant">{BULK_TYPE_HINT[option]}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <p className="flex items-start gap-2 rounded-md border border-outline-variant bg-surface-container px-3 py-2 text-xs text-on-surface-variant">
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>
            Only online targets receive a job. Offline, pending-enrolment, enrolment-failed, and
            maintenance targets are skipped and reported after the dispatch.
          </span>
        </p>
      </div>

      <DialogFooter>
        <Button variant="text" onClick={() => onOpenChange(false)} disabled={dispatching}>
          Cancel
        </Button>
        <Button onClick={dispatch} loading={dispatching}>
          Queue upgrade
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
