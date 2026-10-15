"use client";

import { useEffect, useState } from "react";
import type { TargetDto } from "@/lib/types";
import { apiFetch, toApiError } from "@/lib/use-api";
import {
  Button,
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  useSnackbar,
} from "@/components/ui";

export interface EditTargetDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: TargetDto;
  onSaved: (target: TargetDto) => void;
}

export function EditTargetDialog({ open, onOpenChange, target, onSaved }: EditTargetDialogProps) {
  const { notify } = useSnackbar();
  const [name, setName] = useState(target.name);
  const [hostnameOverride, setHostnameOverride] = useState(target.hostnameOverride ?? "");
  const [labels, setLabels] = useState(target.labels.join(", "));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setName(target.name);
      setHostnameOverride(target.hostnameOverride ?? "");
      setLabels(target.labels.join(", "));
    }
  }, [open, target]);

  async function save() {
    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      notify({ message: "Name cannot be empty.", variant: "warning" });
      return;
    }
    const parsedLabels = labels
      .split(",")
      .map((label) => label.trim())
      .filter((label) => label.length > 0);

    setSaving(true);
    try {
      const updated = await apiFetch<TargetDto>(`/api/targets/${target.id}`, {
        method: "PATCH",
        body: {
          name: trimmedName,
          hostnameOverride: hostnameOverride.trim() ? hostnameOverride.trim() : null,
          labels: parsedLabels,
        },
      });
      notify({ message: "Target updated.", variant: "success" });
      onSaved(updated);
      onOpenChange(false);
    } catch (caught) {
      notify({ message: toApiError(caught).message, variant: "error" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} ariaLabel="Edit target">
      <DialogHeader>
        <DialogTitle>Edit target</DialogTitle>
        <DialogDescription>Update the display name, hostname override, and labels.</DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-4">
        <Input
          label="Name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={100}
        />
        <Input
          label="Hostname override"
          value={hostnameOverride}
          onChange={(event) => setHostnameOverride(event.target.value)}
          placeholder="Leave empty to use the reported hostname"
          maxLength={253}
        />
        <Input
          label="Labels"
          value={labels}
          onChange={(event) => setLabels(event.target.value)}
          placeholder="web, production"
          hint="Comma-separated."
        />
      </div>

      <DialogFooter>
        <Button variant="text" onClick={() => onOpenChange(false)} disabled={saving}>
          Cancel
        </Button>
        <Button onClick={save} loading={saving}>
          Save changes
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
