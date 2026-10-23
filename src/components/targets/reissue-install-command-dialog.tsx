"use client";

import { useEffect, useRef, useState } from "react";
import { KeyRound, ShieldCheck } from "lucide-react";
import type { ReissueInstallCommandDto } from "@/lib/types";
import { apiFetch, toApiError } from "@/lib/use-api";
import {
  Button,
  CodeBlock,
  ConfirmDialog,
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  useSnackbar,
} from "@/components/ui";
import { RelativeTime } from "@/components/common/relative-time";

export interface ReissueInstallCommandActionProps {
  targetId: string;
}

/**
 * Re-issues a single-use enrolment token for an existing target.
 *
 * The command is kept only in this component's state for the lifetime of the
 * result dialog: it must never be cached, logged, or rendered elsewhere.
 */
export function ReissueInstallCommandAction({ targetId }: ReissueInstallCommandActionProps) {
  const { notify } = useSnackbar();
  const [open, setOpen] = useState(false);
  const [reissuing, setReissuing] = useState(false);
  const [result, setResult] = useState<ReissueInstallCommandDto | null>(null);
  const requestRef = useRef(0);

  // Invalidate any in-flight request and drop the secret when the dialog closes.
  useEffect(() => {
    if (open) return;
    requestRef.current += 1;
    setReissuing(false);
    setResult(null);
  }, [open]);

  async function reissue() {
    const requestId = ++requestRef.current;
    setReissuing(true);
    try {
      const response = await apiFetch<ReissueInstallCommandDto>(
        `/api/targets/${targetId}/install-command`,
        { method: "POST" },
      );
      if (requestRef.current !== requestId) return;
      setResult(response);
    } catch (caught) {
      if (requestRef.current !== requestId) return;
      notify({ message: toApiError(caught).message, variant: "error" });
    } finally {
      if (requestRef.current === requestId) setReissuing(false);
    }
  }

  return (
    <>
      <Button
        variant="outlined"
        size="sm"
        onClick={() => setOpen(true)}
        loading={reissuing}
        leadingIcon={<KeyRound className="size-4" aria-hidden="true" />}
      >
        Re-issue install command
      </Button>

      <ConfirmDialog
        open={open && result === null}
        onOpenChange={setOpen}
        title="Re-issue install command"
        description={
          <>
            Generates a new single-use enrolment command for this target. The current agent
            credential keeps working until the new enrolment succeeds, then stops working
            immediately. The command is shown once and cannot be retrieved again.
          </>
        }
        confirmLabel="Re-issue command"
        loading={reissuing}
        onConfirm={reissue}
      />

      <Dialog
        open={open && result !== null}
        onOpenChange={setOpen}
        className="max-w-2xl"
        ariaLabel="Re-issued install command"
      >
        <DialogHeader>
          <DialogTitle>Re-issued install command</DialogTitle>
          <DialogDescription>
            Run the command below on the target as root to enrol it again.
          </DialogDescription>
        </DialogHeader>

        {result ? <InstallCommandStep result={result} /> : null}

        <DialogFooter>
          <Button onClick={() => setOpen(false)}>Done</Button>
        </DialogFooter>
      </Dialog>
    </>
  );
}

function InstallCommandStep({ result }: { result: ReissueInstallCommandDto }) {
  const origin = installerOrigin(result.installerUrl);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-warning/40 bg-warning-container px-3 py-2 text-sm text-on-warning-container">
        <ShieldCheck className="size-4 shrink-0" aria-hidden="true" />
        <span>
          This command contains a one-time enrolment token. Treat it as a secret; it will not be
          shown again after this dialog closes.
        </span>
      </div>

      <CodeBlock label="Install command" code={result.installCommand} />

      <p className="text-sm text-on-surface-variant">
        The installer is served from <code className="font-mono">{origin}</code>. Run the command
        as root (or with sudo) on the target machine.
      </p>

      <p className="text-sm text-on-surface-variant">
        Token expires <RelativeTime value={result.expiresAt} />.
      </p>
    </div>
  );
}

/** Fall back to the raw value if the server ever returns a non-absolute URL. */
function installerOrigin(installerUrl: string): string {
  try {
    return new URL(installerUrl).origin;
  } catch {
    return installerUrl;
  }
}
