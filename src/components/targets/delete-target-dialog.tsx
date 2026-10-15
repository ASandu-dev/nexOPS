"use client";

import { useState } from "react";
import type { TargetDto } from "@/lib/types";
import { apiFetch, toApiError } from "@/lib/use-api";
import { ConfirmDialog, useSnackbar } from "@/components/ui";

export interface DeleteTargetDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: TargetDto;
  onDeleted: () => void;
}

export function DeleteTargetDialog({ open, onOpenChange, target, onDeleted }: DeleteTargetDialogProps) {
  const { notify } = useSnackbar();
  const [deleting, setDeleting] = useState(false);

  async function confirm() {
    setDeleting(true);
    try {
      await apiFetch<{ id: string; deleted: boolean }>(`/api/targets/${target.id}`, {
        method: "DELETE",
      });
      notify({ message: `Target "${target.name}" removed.`, variant: "success" });
      onDeleted();
      onOpenChange(false);
    } catch (caught) {
      notify({ message: toApiError(caught).message, variant: "error" });
    } finally {
      setDeleting(false);
    }
  }

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Delete target"
      description={
        <>
          This revokes the agent credential, cancels queued jobs, and soft-deletes the target. The
          agent will no longer be able to authenticate.
        </>
      }
      confirmLabel="Delete target"
      destructive
      loading={deleting}
      confirmPhrase={target.name}
      onConfirm={confirm}
    />
  );
}
