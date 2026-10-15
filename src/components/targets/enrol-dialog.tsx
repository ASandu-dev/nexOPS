"use client";

import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, ShieldCheck, Terminal } from "lucide-react";
import type { CreateTargetResponseDto, OsFamily, TargetDto } from "@/lib/types";
import { apiFetch, toApiError, useApi } from "@/lib/use-api";
import { formatDuration } from "@/lib/format";
import {
  Button,
  CodeBlock,
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Select,
  StatusBadge,
  useSnackbar,
} from "@/components/ui";

type Step = "form" | "command";

const OS_OPTIONS = [
  { value: "ubuntu", label: "Ubuntu" },
  { value: "debian", label: "Debian" },
] as const;

export interface EnrolDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: () => void;
}

export function EnrolDialog({ open, onOpenChange, onCreated }: EnrolDialogProps) {
  const { notify } = useSnackbar();
  const [step, setStep] = useState<Step>("form");
  const [name, setName] = useState("");
  const [hostnameOverride, setHostnameOverride] = useState("");
  const [os, setOs] = useState<OsFamily>("UBUNTU");
  const [tags, setTags] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState<CreateTargetResponseDto | null>(null);

  // Reset to a clean form each time the dialog opens.
  useEffect(() => {
    if (open) {
      setStep("form");
      setName("");
      setHostnameOverride("");
      setOs("UBUNTU");
      setTags("");
      setCreated(null);
    }
  }, [open]);

  const targetId = created?.target.id ?? null;
  const { data: polledTarget } = useApi<TargetDto>(
    step === "command" && targetId ? `/api/targets/${targetId}` : null,
    { refreshIntervalMs: 5000 },
  );
  const liveTarget = polledTarget ?? created?.target ?? null;
  const enrolled = liveTarget !== null && liveTarget.status !== "PENDING_ENROLMENT";

  async function submit() {
    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      notify({ message: "Enter a target name.", variant: "warning" });
      return;
    }
    const labels = tags
      .split(",")
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0);

    setSubmitting(true);
    try {
      const response = await apiFetch<CreateTargetResponseDto>("/api/targets", {
        method: "POST",
        body: {
          name: trimmedName,
          os: os.toLowerCase(),
          ...(hostnameOverride.trim() ? { hostnameOverride: hostnameOverride.trim() } : {}),
          labels,
        },
      });
      setCreated(response);
      setStep("command");
      onCreated?.();
    } catch (caught) {
      notify({ message: toApiError(caught).message, variant: "error" });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      className="max-w-2xl"
      dismissOnBackdropClick={step === "form"}
      ariaLabel="Add target"
    >
      <DialogHeader>
        <DialogTitle>{step === "form" ? "Add target" : "Enrol target"}</DialogTitle>
        <DialogDescription>
          {step === "form"
            ? "Create a target and generate a single-use enrolment command."
            : "Run the command below on the target as root to install the agent."}
        </DialogDescription>
      </DialogHeader>

      {step === "form" ? (
        <div className="flex flex-col gap-4">
          <Input
            label="Name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="vm-01"
            maxLength={100}
            required
          />
          <Input
            label="Hostname override (optional)"
            value={hostnameOverride}
            onChange={(event) => setHostnameOverride(event.target.value)}
            placeholder="vm-01.internal"
            maxLength={253}
            hint="Overrides the hostname the agent reports."
          />
          <Select
            label="Operating system"
            value={os}
            onChange={(event) => setOs(event.target.value as OsFamily)}
            options={OS_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
          />
          <Input
            label="Tags (optional)"
            value={tags}
            onChange={(event) => setTags(event.target.value)}
            placeholder="web, production"
            hint="Comma-separated labels used for filtering."
          />
        </div>
      ) : created ? (
        <EnrolCommandStep created={created} enrolled={enrolled} liveTarget={liveTarget} />
      ) : null}

      <DialogFooter>
        {step === "form" ? (
          <>
            <Button variant="text" onClick={() => onOpenChange(false)} disabled={submitting}>
              Cancel
            </Button>
            <Button onClick={submit} loading={submitting}>
              Generate command
            </Button>
          </>
        ) : (
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        )}
      </DialogFooter>
    </Dialog>
  );
}

function EnrolCommandStep({
  created,
  enrolled,
  liveTarget,
}: {
  created: CreateTargetResponseDto;
  enrolled: boolean;
  liveTarget: TargetDto | null;
}) {
  const [remainingSec, setRemainingSec] = useState(() => secondsUntil(created.expiresAt));

  useEffect(() => {
    const timer = window.setInterval(() => setRemainingSec(secondsUntil(created.expiresAt)), 1000);
    return () => window.clearInterval(timer);
  }, [created.expiresAt]);

  const expired = remainingSec <= 0;

  const instructions = useMemo(
    () => [
      "Copy the command below and run it on the target as root (or with sudo).",
      "It downloads the installer over TLS and verifies its SHA-256 checksum before running.",
      "The installer creates an unprivileged nexops-agent service account and a systemd unit.",
      "The enrolment token is single-use and expires automatically.",
    ],
    [],
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-warning/40 bg-warning-container px-3 py-2 text-sm text-on-warning-container">
        <ShieldCheck className="size-4 shrink-0" aria-hidden="true" />
        <span>
          This command contains a one-time enrolment token. Treat it as a secret and do not share it.
        </span>
      </div>

      <CodeBlock label="Install command" code={created.installCommand} />

      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="text-on-surface-variant">
          {expired ? (
            <span className="font-medium text-error">Token expired — create a new target.</span>
          ) : (
            <>
              Token expires in{" "}
              <span className="font-medium tabular-nums text-on-surface">
                {formatDuration(remainingSec)}
              </span>
            </>
          )}
        </span>
        <span className="flex items-center gap-2">
          <span className="text-on-surface-variant">Status</span>
          {liveTarget ? <StatusBadge status={liveTarget.status} /> : null}
        </span>
      </div>

      {enrolled ? (
        <p className="flex items-center gap-2 rounded-md border border-success/40 bg-success-container px-3 py-2 text-sm text-on-success-container">
          <CheckCircle2 className="size-4 shrink-0" aria-hidden="true" />
          Target enrolled successfully.
        </p>
      ) : null}

      <div className="flex flex-col gap-2">
        <p className="flex items-center gap-2 text-sm font-medium text-on-surface">
          <Terminal className="size-4" aria-hidden="true" />
          Instructions
        </p>
        <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm text-on-surface-variant">
          {instructions.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ol>
      </div>
    </div>
  );
}

function secondsUntil(iso: string): number {
  const target = new Date(iso).getTime();
  if (Number.isNaN(target)) return 0;
  return Math.max(0, Math.round((target - Date.now()) / 1000));
}
