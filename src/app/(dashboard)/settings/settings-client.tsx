"use client";

import { useEffect, useState } from "react";
import { UserButton } from "@clerk/nextjs";
import { Save } from "lucide-react";
import type { SettingsDto } from "@/lib/types";
import { apiFetch, toApiError, useApi } from "@/lib/use-api";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ErrorState,
  Input,
  Skeleton,
  useSnackbar,
} from "@/components/ui";
import { PageHeader } from "@/components/common/page-header";

export interface SettingsClientProps {
  controlPlaneVersion: string;
}

export function SettingsClient({ controlPlaneVersion }: SettingsClientProps) {
  const { notify } = useSnackbar();
  const { data, error, loading, refresh } = useApi<SettingsDto>("/api/settings");

  const [retentionDays, setRetentionDays] = useState("");
  const [heartbeatSec, setHeartbeatSec] = useState("");
  const [watchedServices, setWatchedServices] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!data) return;
    setRetentionDays(String(data.telemetryRetentionDays));
    setHeartbeatSec(String(data.heartbeatIntervalSec));
    setWatchedServices(data.watchedServices.join(", "));
  }, [data]);

  async function save() {
    const retention = Number.parseInt(retentionDays, 10);
    const heartbeat = Number.parseInt(heartbeatSec, 10);
    if (!Number.isFinite(retention) || retention < 1 || retention > 365) {
      notify({ message: "Retention must be between 1 and 365 days.", variant: "warning" });
      return;
    }
    if (!Number.isFinite(heartbeat) || heartbeat < 10 || heartbeat > 3600) {
      notify({ message: "Heartbeat interval must be between 10 and 3600 seconds.", variant: "warning" });
      return;
    }
    const services = watchedServices
      .split(",")
      .map((service) => service.trim())
      .filter((service) => service.length > 0);

    setSaving(true);
    try {
      await apiFetch<SettingsDto>("/api/settings", {
        method: "PATCH",
        body: {
          telemetryRetentionDays: retention,
          heartbeatIntervalSec: heartbeat,
          watchedServices: services,
        },
      });
      notify({ message: "Settings saved.", variant: "success" });
      refresh();
    } catch (caught) {
      notify({ message: toApiError(caught).message, variant: "error" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Settings" description="Control-plane configuration and account details." />

      {loading ? (
        <Skeleton className="h-72 w-full" />
      ) : error ? (
        <ErrorState message={error.message} onRetry={refresh} />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Telemetry &amp; agent</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <Input
              label="Telemetry retention (days)"
              type="number"
              min={1}
              max={365}
              value={retentionDays}
              onChange={(event) => setRetentionDays(event.target.value)}
              hint="Snapshots older than this are pruned by the background sweep."
            />
            <Input
              label="Heartbeat interval (seconds)"
              type="number"
              min={10}
              max={3600}
              value={heartbeatSec}
              onChange={(event) => setHeartbeatSec(event.target.value)}
              hint="How often agents report telemetry."
            />
            <Input
              label="Watched services"
              value={watchedServices}
              onChange={(event) => setWatchedServices(event.target.value)}
              placeholder="nginx, sshd, docker"
              hint="Comma-separated systemd units reported in telemetry."
            />
            <div className="flex justify-end">
              <Button
                onClick={save}
                loading={saving}
                leadingIcon={<Save className="size-4" aria-hidden="true" />}
              >
                Save settings
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>System information</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
              <div className="flex flex-col gap-0.5">
                <dt className="text-xs font-medium uppercase tracking-wide text-on-surface-variant">
                  Control plane
                </dt>
                <dd className="text-on-surface">NexOPS</dd>
              </div>
              <div className="flex flex-col gap-0.5">
                <dt className="text-xs font-medium uppercase tracking-wide text-on-surface-variant">
                  Version
                </dt>
                <dd className="text-on-surface tabular-nums">{controlPlaneVersion}</dd>
              </div>
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Account</CardTitle>
          </CardHeader>
          <CardContent className="flex items-center gap-3">
            <UserButton appearance={{ elements: { avatarBox: "size-10" } }} showName />
            <p className="text-sm text-on-surface-variant">
              Manage your profile, sessions, and security from the account menu.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
