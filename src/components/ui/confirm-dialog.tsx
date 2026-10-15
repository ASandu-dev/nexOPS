"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./dialog";
import { Button } from "./button";
import { Input } from "./input";

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  loading?: boolean;
  /**
   * When set, the confirm button stays disabled until the operator types this
   * exact phrase — used for irreversible actions such as deleting a target.
   */
  confirmPhrase?: string;
  onConfirm: () => void;
  children?: ReactNode;
}

/** Reusable confirmation dialog with optional type-to-confirm gating. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  loading = false,
  confirmPhrase,
  onConfirm,
  children,
}: ConfirmDialogProps) {
  const [typed, setTyped] = useState("");

  useEffect(() => {
    if (!open) setTyped("");
  }, [open]);

  const phraseSatisfied = confirmPhrase === undefined || typed === confirmPhrase;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      dismissOnBackdropClick={!loading}
      ariaLabel={title}
    >
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        {description ? <DialogDescription>{description}</DialogDescription> : null}
      </DialogHeader>

      {children ? <div className="flex flex-col gap-4">{children}</div> : null}

      {confirmPhrase !== undefined ? (
        <div className="mt-4">
          <Input
            label={`Type "${confirmPhrase}" to confirm`}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
      ) : null}

      <DialogFooter>
        <Button variant="text" onClick={() => onOpenChange(false)} disabled={loading}>
          {cancelLabel}
        </Button>
        <Button
          variant={destructive ? "danger" : "filled"}
          onClick={onConfirm}
          loading={loading}
          disabled={!phraseSatisfied}
        >
          {confirmLabel}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
