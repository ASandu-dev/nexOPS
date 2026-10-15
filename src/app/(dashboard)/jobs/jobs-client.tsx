"use client";

import { useEffect, useMemo, useState } from "react";
import { ListChecks, Plus } from "lucide-react";
import type { JobDto, Paginated, TargetDto } from "@/lib/types";
import { JOB_STATUSES } from "@/lib/types";
import { useApi } from "@/lib/use-api";
import {
  Button,
  EmptyState,
  ErrorState,
  Pagination,
  Select,
  Skeleton,
} from "@/components/ui";
import { PageHeader } from "@/components/common/page-header";
import { FilterChips } from "@/components/common/filter-chips";
import { JobsTable } from "@/components/jobs/jobs-table";
import { JobDetailDialog } from "@/components/jobs/job-detail-dialog";
import { NewJobDialog } from "@/components/jobs/new-job-dialog";

const STATUS_OPTIONS = JOB_STATUSES.map((status) => ({
  value: status,
  label: status.replace(/_/g, " ").toLowerCase(),
}));

const ACTIVE_STATUSES: ReadonlySet<JobDto["status"]> = new Set(["QUEUED", "DISPATCHED", "RUNNING"]);
const PAGE_SIZE = 20;

export function JobsClient() {
  const [statuses, setStatuses] = useState<string[]>([]);
  const [targetId, setTargetId] = useState("");
  const [page, setPage] = useState(1);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [newJobOpen, setNewJobOpen] = useState(false);

  const url = useMemo(() => {
    const params = new URLSearchParams();
    if (statuses.length > 0) params.set("status", statuses.join(","));
    if (targetId) params.set("targetId", targetId);
    params.set("page", String(page));
    params.set("pageSize", String(PAGE_SIZE));
    return `/api/jobs?${params.toString()}`;
  }, [statuses, targetId, page]);

  const { data: targetsData } = useApi<Paginated<TargetDto>>(
    "/api/targets?pageSize=100&sort=name&order=asc",
  );

  // Poll only while the current page contains a non-terminal job.
  const [polling, setPolling] = useState(false);
  const { data, error, loading, refresh } = useApi<Paginated<JobDto>>(url, {
    ...(polling ? { refreshIntervalMs: 10000 } : {}),
  });

  useEffect(() => {
    setPolling(data?.items.some((job) => ACTIVE_STATUSES.has(job.status)) ?? false);
  }, [data]);

  const targetOptions = [
    { value: "", label: "All targets" },
    ...(targetsData?.items ?? []).map((target) => ({ value: target.id, label: target.name })),
  ];

  const hasFilters = statuses.length > 0 || targetId !== "";

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Jobs"
        description="Maintenance actions queued for your fleet."
        actions={
          <Button onClick={() => setNewJobOpen(true)} leadingIcon={<Plus className="size-4" aria-hidden="true" />}>
            New job
          </Button>
        }
      />

      <div className="flex flex-col gap-3 rounded-lg border border-outline-variant bg-surface-container p-4">
        <div className="max-w-xs">
          <Select
            label="Target"
            value={targetId}
            onChange={(event) => {
              setTargetId(event.target.value);
              setPage(1);
            }}
            options={targetOptions}
          />
        </div>
        <FilterChips
          label="Filter by status"
          options={STATUS_OPTIONS}
          selected={statuses}
          onChange={(next) => {
            setStatuses(next);
            setPage(1);
          }}
        />
        {polling ? (
          <p className="text-xs text-on-surface-variant" aria-live="polite">
            Auto-refreshing every 10 seconds while jobs are active.
          </p>
        ) : null}
      </div>

      {loading ? (
        <Skeleton className="h-72 w-full" />
      ) : error ? (
        <ErrorState message={error.message} onRetry={refresh} />
      ) : !data || data.items.length === 0 ? (
        <EmptyState
          icon={<ListChecks className="size-5" />}
          title={hasFilters ? "No matching jobs" : "No jobs yet"}
          description={
            hasFilters
              ? "Try clearing the status or target filters."
              : "Queue a job to run a maintenance action on a target."
          }
          action={
            hasFilters ? (
              <Button
                variant="outlined"
                onClick={() => {
                  setStatuses([]);
                  setTargetId("");
                  setPage(1);
                }}
              >
                Clear filters
              </Button>
            ) : (
              <Button onClick={() => setNewJobOpen(true)}>New job</Button>
            )
          }
        />
      ) : (
        <>
          <JobsTable jobs={data.items} onSelect={(job) => setSelectedJobId(job.id)} />
          <Pagination
            page={data.page}
            totalPages={data.totalPages}
            total={data.total}
            pageSize={data.pageSize}
            onPageChange={setPage}
          />
        </>
      )}

      <NewJobDialog
        open={newJobOpen}
        onOpenChange={setNewJobOpen}
        onCreated={() => {
          setPage(1);
          refresh();
        }}
      />
      <JobDetailDialog
        jobId={selectedJobId}
        open={selectedJobId !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedJobId(null);
        }}
        onChanged={refresh}
      />
    </div>
  );
}
