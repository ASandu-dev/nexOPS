"use client";

import { useMemo, useState } from "react";
import { ListChecks } from "lucide-react";
import type { JobDto, Paginated } from "@/lib/types";
import { JOB_STATUSES } from "@/lib/types";
import { useApi } from "@/lib/use-api";
import { EmptyState, ErrorState, Pagination, Skeleton } from "@/components/ui";
import { FilterChips } from "@/components/common/filter-chips";
import { JobsTable } from "@/components/jobs/jobs-table";
import { JobDetailDialog } from "@/components/jobs/job-detail-dialog";

const STATUS_OPTIONS = JOB_STATUSES.map((status) => ({
  value: status,
  label: status.replace(/_/g, " ").toLowerCase(),
}));

const PAGE_SIZE = 20;

export function JobsTab({ targetId }: { targetId: string }) {
  const [statuses, setStatuses] = useState<string[]>([]);
  const [page, setPage] = useState(1);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);

  const url = useMemo(() => {
    const params = new URLSearchParams();
    if (statuses.length > 0) params.set("status", statuses.join(","));
    params.set("page", String(page));
    params.set("pageSize", String(PAGE_SIZE));
    return `/api/targets/${targetId}/jobs?${params.toString()}`;
  }, [targetId, statuses, page]);

  const { data, error, loading, refresh } = useApi<Paginated<JobDto>>(url);

  return (
    <div className="flex flex-col gap-4">
      <FilterChips
        label="Filter by status"
        options={STATUS_OPTIONS}
        selected={statuses}
        onChange={(next) => {
          setStatuses(next);
          setPage(1);
        }}
      />

      {loading ? (
        <Skeleton className="h-64 w-full" />
      ) : error ? (
        <ErrorState message={error.message} onRetry={refresh} />
      ) : !data || data.items.length === 0 ? (
        <EmptyState
          icon={<ListChecks className="size-5" />}
          title="No jobs"
          description="Jobs queued for this target will appear here."
        />
      ) : (
        <>
          <JobsTable jobs={data.items} showTarget={false} onSelect={(job) => setSelectedJobId(job.id)} />
          <Pagination
            page={data.page}
            totalPages={data.totalPages}
            total={data.total}
            pageSize={data.pageSize}
            onPageChange={setPage}
          />
        </>
      )}

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
