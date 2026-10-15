"use client";

import { useState } from "react";
import { ScrollText } from "lucide-react";
import type { AuditEventDto, Paginated } from "@/lib/types";
import { useApi } from "@/lib/use-api";
import { EmptyState, ErrorState, Pagination, Skeleton } from "@/components/ui";
import { AuditTable } from "@/components/audit/audit-table";

const PAGE_SIZE = 20;

export function ActivityTab({ targetId }: { targetId: string }) {
  const [page, setPage] = useState(1);
  const { data, error, loading, refresh } = useApi<Paginated<AuditEventDto>>(
    `/api/audit?targetId=${targetId}&page=${page}&pageSize=${PAGE_SIZE}`,
  );

  if (loading) return <Skeleton className="h-64 w-full" />;
  if (error) return <ErrorState message={error.message} onRetry={refresh} />;
  if (!data || data.items.length === 0) {
    return (
      <EmptyState
        icon={<ScrollText className="size-5" />}
        title="No activity"
        description="Audit events for this target will appear here."
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <AuditTable events={data.items} />
      <Pagination
        page={data.page}
        totalPages={data.totalPages}
        total={data.total}
        pageSize={data.pageSize}
        onPageChange={setPage}
      />
    </div>
  );
}
