"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Pencil, Search, Trash2, Upload, Wrench } from "lucide-react";
import Link from "next/link";
import type { JobDto, TargetDetailDto, TelemetryRange, TelemetrySeriesDto } from "@/lib/types";
import { apiFetch, toApiError, useApi } from "@/lib/use-api";
import {
  Button,
  ConfirmDialog,
  ErrorState,
  Skeleton,
  StatusBadge,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  useSnackbar,
} from "@/components/ui";
import { PageHeader } from "@/components/common/page-header";
import { EditTargetDialog } from "@/components/targets/edit-target-dialog";
import { DeleteTargetDialog } from "@/components/targets/delete-target-dialog";
import { SummaryTab } from "./tabs/summary-tab";
import { MonitoringTab } from "./tabs/monitoring-tab";
import { SystemTab } from "./tabs/system-tab";
import { JobsTab } from "./tabs/jobs-tab";
import { ActivityTab } from "./tabs/activity-tab";

export function TargetDetailClient({ id }: { id: string }) {
  const router = useRouter();
  const { notify } = useSnackbar();
  const [range, setRange] = useState<TelemetryRange>("1h");
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [fixOpen, setFixOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const { data: target, error, loading, refresh } = useApi<TargetDetailDto>(`/api/targets/${id}`);
  const {
    data: series,
    error: seriesError,
    loading: seriesLoading,
    refresh: refreshSeries,
  } = useApi<TelemetrySeriesDto>(`/api/targets/${id}/telemetry?range=${range}`);

  async function queueJob(type: JobDto["type"]) {
    await apiFetch<JobDto>("/api/jobs", { method: "POST", body: { targetId: id, type } });
  }

  async function runUpdate() {
    setBusy(true);
    try {
      await queueJob("APT_UPDATE");
      await queueJob("APT_UPGRADE");
      notify({ message: "Update jobs queued.", variant: "success" });
      setUpdateOpen(false);
      refresh();
    } catch (caught) {
      notify({ message: toApiError(caught).message, variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function checkUpdates() {
    setBusy(true);
    try {
      await queueJob("CHECK_UPDATES");
      notify({ message: "Update check queued.", variant: "success" });
      refresh();
    } catch (caught) {
      notify({ message: toApiError(caught).message, variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function fixBroken() {
    setBusy(true);
    try {
      await queueJob("APT_FIX_BROKEN");
      notify({ message: "Fix broken packages queued.", variant: "success" });
      setFixOpen(false);
      refresh();
    } catch (caught) {
      notify({ message: toApiError(caught).message, variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <TargetDetailSkeleton />;

  if (error) {
    return (
      <div className="flex flex-col gap-5">
        <BackLink />
        <ErrorState message={error.message} onRetry={refresh} />
      </div>
    );
  }

  if (!target) return null;

  return (
    <div className="flex flex-col gap-5">
      <BackLink />

      <PageHeader
        title={target.name}
        description={
          <span className="flex items-center gap-2">
            <StatusBadge status={target.status} />
            <span>{target.hostname ?? target.hostnameOverride ?? "no hostname reported"}</span>
          </span>
        }
        actions={
          <>
            <Button
              variant="outlined"
              size="sm"
              onClick={checkUpdates}
              loading={busy}
              leadingIcon={<Search className="size-4" aria-hidden="true" />}
            >
              Check updates
            </Button>
            <Button
              variant="outlined"
              size="sm"
              onClick={() => setFixOpen(true)}
              leadingIcon={<Wrench className="size-4" aria-hidden="true" />}
            >
              Fix broken packages
            </Button>
            <Button
              variant="outlined"
              size="sm"
              onClick={() => setUpdateOpen(true)}
              leadingIcon={<Upload className="size-4" aria-hidden="true" />}
            >
              Run update
            </Button>
            <Button
              variant="outlined"
              size="sm"
              onClick={() => setEditOpen(true)}
              leadingIcon={<Pencil className="size-4" aria-hidden="true" />}
            >
              Edit
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={() => setDeleteOpen(true)}
              leadingIcon={<Trash2 className="size-4" aria-hidden="true" />}
            >
              Delete
            </Button>
          </>
        }
      />

      <Tabs defaultValue="summary">
        <TabsList aria-label="Target sections" className="flex-wrap">
          <TabsTrigger value="summary">Summary</TabsTrigger>
          <TabsTrigger value="monitoring">Monitoring</TabsTrigger>
          <TabsTrigger value="system">System</TabsTrigger>
          <TabsTrigger value="jobs">Jobs</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
        </TabsList>

        <TabsContent value="summary" className="mt-4">
          <SummaryTab target={target} latest={series?.latest ?? null} />
        </TabsContent>
        <TabsContent value="monitoring" className="mt-4">
          <MonitoringTab
            series={series}
            loading={seriesLoading}
            error={seriesError}
            range={range}
            onRangeChange={setRange}
            onRefresh={refreshSeries}
          />
        </TabsContent>
        <TabsContent value="system" className="mt-4">
          <SystemTab target={target} latest={series?.latest ?? null} />
        </TabsContent>
        <TabsContent value="jobs" className="mt-4">
          <JobsTab targetId={id} />
        </TabsContent>
        <TabsContent value="activity" className="mt-4">
          <ActivityTab targetId={id} />
        </TabsContent>
      </Tabs>

      <EditTargetDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        target={target}
        onSaved={() => refresh()}
      />
      <DeleteTargetDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        target={target}
        onDeleted={() => router.push("/targets")}
      />
      <ConfirmDialog
        open={updateOpen}
        onOpenChange={setUpdateOpen}
        title="Run package update"
        description="Queues an APT update followed by an APT upgrade on this target. The agent runs them on its next heartbeat."
        confirmLabel="Queue update"
        loading={busy}
        onConfirm={runUpdate}
      />
      <ConfirmDialog
        open={fixOpen}
        onOpenChange={setFixOpen}
        title="Fix broken packages"
        description="Queues apt-get -f install on this target to repair a half-configured dpkg state. The agent runs it on its next heartbeat."
        confirmLabel="Queue fix"
        loading={busy}
        onConfirm={fixBroken}
      />
    </div>
  );
}

function BackLink() {
  return (
    <Link
      href="/targets"
      className="inline-flex w-fit items-center gap-1.5 text-sm text-on-surface-variant hover:text-primary"
    >
      <ArrowLeft className="size-4" aria-hidden="true" />
      Back to targets
    </Link>
  );
}

function TargetDetailSkeleton() {
  return (
    <div className="flex flex-col gap-5">
      <Skeleton className="h-5 w-32" />
      <Skeleton className="h-10 w-64" />
      <Skeleton className="h-10 w-full max-w-xl" />
      <Skeleton className="h-72 w-full" />
    </div>
  );
}
