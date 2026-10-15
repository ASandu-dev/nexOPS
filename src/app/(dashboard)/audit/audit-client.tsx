"use client";

import { useMemo, useState } from "react";
import { ScrollText } from "lucide-react";
import type { ActorType, AuditEventDto, Paginated } from "@/lib/types";
import { ACTOR_TYPES } from "@/lib/types";
import { useApi, useDebouncedValue } from "@/lib/use-api";
import {
  Button,
  EmptyState,
  ErrorState,
  Input,
  Pagination,
  Select,
  Skeleton,
} from "@/components/ui";
import { PageHeader } from "@/components/common/page-header";
import { AuditTable } from "@/components/audit/audit-table";

const ACTOR_OPTIONS = [
  { value: "", label: "All actors" },
  ...ACTOR_TYPES.map((actorType) => ({
    value: actorType,
    label: actorType.charAt(0) + actorType.slice(1).toLowerCase(),
  })),
];

const PAGE_SIZE = 20;

export function AuditClient() {
  const [action, setAction] = useState("");
  const [actorType, setActorType] = useState("");
  const [page, setPage] = useState(1);
  const debouncedAction = useDebouncedValue(action, 300);

  const url = useMemo(() => {
    const params = new URLSearchParams();
    if (debouncedAction.trim()) params.set("action", debouncedAction.trim());
    if (actorType) params.set("actorType", actorType);
    params.set("page", String(page));
    params.set("pageSize", String(PAGE_SIZE));
    return `/api/audit?${params.toString()}`;
  }, [debouncedAction, actorType, page]);

  const { data, error, loading, refresh } = useApi<Paginated<AuditEventDto>>(url);

  const hasFilters = action.trim() !== "" || actorType !== "";

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Activity" description="Audit trail of every operator and agent action." />

      <div className="grid gap-3 rounded-lg border border-outline-variant bg-surface-container p-4 sm:grid-cols-2">
        <Input
          label="Action"
          value={action}
          onChange={(event) => {
            setAction(event.target.value);
            setPage(1);
          }}
          placeholder="e.g. target.create"
        />
        <Select
          label="Actor type"
          value={actorType}
          onChange={(event) => {
            setActorType(event.target.value as ActorType | "");
            setPage(1);
          }}
          options={ACTOR_OPTIONS}
        />
      </div>

      {loading ? (
        <Skeleton className="h-72 w-full" />
      ) : error ? (
        <ErrorState message={error.message} onRetry={refresh} />
      ) : !data || data.items.length === 0 ? (
        <EmptyState
          icon={<ScrollText className="size-5" />}
          title={hasFilters ? "No matching events" : "No activity yet"}
          description={
            hasFilters
              ? "Try clearing the action or actor-type filters."
              : "Audit events will appear here as operators act."
          }
          action={
            hasFilters ? (
              <Button
                variant="outlined"
                onClick={() => {
                  setAction("");
                  setActorType("");
                  setPage(1);
                }}
              >
                Clear filters
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <AuditTable events={data.items} />
          <Pagination
            page={data.page}
            totalPages={data.totalPages}
            total={data.total}
            pageSize={data.pageSize}
            onPageChange={setPage}
          />
        </>
      )}
    </div>
  );
}
