"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, Search, Server } from "lucide-react";
import type { Paginated, TargetDto } from "@/lib/types";
import { TARGET_STATUSES } from "@/lib/types";
import { useApi, useDebouncedValue } from "@/lib/use-api";
import { formatDuration, formatPercent } from "@/lib/format";
import { isOlderThan } from "@/lib/display";
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Input,
  Pagination,
  Select,
  Skeleton,
  StatusBadge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui";
import { PageHeader } from "@/components/common/page-header";
import { FilterChips } from "@/components/common/filter-chips";
import { RelativeTime } from "@/components/common/relative-time";
import { EnrolDialog } from "@/components/targets/enrol-dialog";

const STATUS_OPTIONS = TARGET_STATUSES.map((status) => ({
  value: status,
  label: status.replace(/_/g, " ").toLowerCase(),
}));

const SORT_OPTIONS = [
  { value: "createdAt", label: "Created" },
  { value: "name", label: "Name" },
  { value: "status", label: "Status" },
  { value: "lastHeartbeatAt", label: "Last heartbeat" },
];

const ORDER_OPTIONS = [
  { value: "desc", label: "Descending" },
  { value: "asc", label: "Ascending" },
];

const PAGE_SIZE = 20;

export function TargetsClient() {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [statuses, setStatuses] = useState<string[]>([]);
  const [label, setLabel] = useState("");
  const [sort, setSort] = useState("createdAt");
  const [order, setOrder] = useState("desc");
  const [page, setPage] = useState(1);
  const [enrolOpen, setEnrolOpen] = useState(false);

  const debouncedSearch = useDebouncedValue(search, 300);
  const debouncedLabel = useDebouncedValue(label, 300);

  const url = useMemo(() => {
    const params = new URLSearchParams();
    if (debouncedSearch.trim()) params.set("q", debouncedSearch.trim());
    if (statuses.length > 0) params.set("status", statuses.join(","));
    if (debouncedLabel.trim()) params.set("label", debouncedLabel.trim());
    params.set("sort", sort);
    params.set("order", order);
    params.set("page", String(page));
    params.set("pageSize", String(PAGE_SIZE));
    return `/api/targets?${params.toString()}`;
  }, [debouncedSearch, statuses, debouncedLabel, sort, order, page]);

  const { data, error, loading, refresh } = useApi<Paginated<TargetDto>>(url);

  function updateFilter(updater: () => void) {
    updater();
    setPage(1);
  }

  const hasFilters = statuses.length > 0 || search.trim() !== "" || label.trim() !== "";

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Targets"
        description="Every VM managed by the control plane."
        actions={
          <Button onClick={() => setEnrolOpen(true)} leadingIcon={<Plus className="size-4" aria-hidden="true" />}>
            Add target
          </Button>
        }
      />

      <div className="flex flex-col gap-3 rounded-lg border border-outline-variant bg-surface-container p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Input
            label="Search"
            value={search}
            onChange={(event) => updateFilter(() => setSearch(event.target.value))}
            placeholder="Name or hostname"
            leadingIcon={<Search className="size-4" aria-hidden="true" />}
          />
          <Input
            label="Label"
            value={label}
            onChange={(event) => updateFilter(() => setLabel(event.target.value))}
            placeholder="e.g. production"
          />
          <Select
            label="Sort by"
            value={sort}
            onChange={(event) => updateFilter(() => setSort(event.target.value))}
            options={SORT_OPTIONS}
          />
          <Select
            label="Order"
            value={order}
            onChange={(event) => updateFilter(() => setOrder(event.target.value))}
            options={ORDER_OPTIONS}
          />
        </div>
        <FilterChips
          label="Filter by status"
          options={STATUS_OPTIONS}
          selected={statuses}
          onChange={(next) => updateFilter(() => setStatuses(next))}
        />
      </div>

      {loading ? (
        <TargetsTableSkeleton />
      ) : error ? (
        <ErrorState message={error.message} onRetry={refresh} />
      ) : !data || data.items.length === 0 ? (
        <EmptyState
          icon={<Server className="size-5" />}
          title={hasFilters ? "No matching targets" : "No targets yet"}
          description={
            hasFilters
              ? "Try clearing the search, status, or label filters."
              : "Add your first target to start managing your fleet."
          }
          action={
            hasFilters ? (
              <Button
                variant="outlined"
                onClick={() =>
                  updateFilter(() => {
                    setSearch("");
                    setLabel("");
                    setStatuses([]);
                  })
                }
              >
                Clear filters
              </Button>
            ) : (
              <Button onClick={() => setEnrolOpen(true)}>Add target</Button>
            )
          }
        />
      ) : (
        <>
          <TargetsTable targets={data.items} onOpen={(id) => router.push(`/targets/${id}`)} />
          <Pagination
            page={data.page}
            totalPages={data.totalPages}
            total={data.total}
            pageSize={data.pageSize}
            onPageChange={setPage}
          />
        </>
      )}

      <EnrolDialog open={enrolOpen} onOpenChange={setEnrolOpen} onCreated={refresh} />
    </div>
  );
}

function TargetsTable({ targets, onOpen }: { targets: readonly TargetDto[]; onOpen: (id: string) => void }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="hidden md:table-cell">OS</TableHead>
          <TableHead className="hidden lg:table-cell">Labels</TableHead>
          <TableHead>Last heartbeat</TableHead>
          <TableHead className="hidden sm:table-cell">CPU</TableHead>
          <TableHead className="hidden sm:table-cell">Mem</TableHead>
          <TableHead className="hidden xl:table-cell">Disk</TableHead>
          <TableHead className="hidden xl:table-cell">Uptime</TableHead>
          <TableHead className="hidden lg:table-cell">Agent</TableHead>
          <TableHead className="hidden md:table-cell">Jobs</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {targets.map((target) => {
          const stale = isOlderThan(target.lastHeartbeatAt, 90_000);
          return (
            <TableRow key={target.id} onClick={() => onOpen(target.id)} className="cursor-pointer">
              <TableCell>
                <Link
                  href={`/targets/${target.id}`}
                  onClick={(event) => event.stopPropagation()}
                  className="font-medium text-primary hover:underline"
                >
                  {target.name}
                </Link>
                {target.hostnameOverride ? (
                  <span className="block text-xs text-on-surface-variant">{target.hostnameOverride}</span>
                ) : null}
              </TableCell>
              <TableCell>
                <StatusBadge status={target.status} />
              </TableCell>
              <TableCell className="hidden whitespace-nowrap md:table-cell">
                {target.os}
                {target.osVersion ? ` ${target.osVersion}` : ""}
              </TableCell>
              <TableCell className="hidden lg:table-cell">
                {target.labels.length === 0 ? (
                  <span className="text-on-surface-variant">—</span>
                ) : (
                  <span className="flex flex-wrap gap-1">
                    {target.labels.map((entry) => (
                      <Badge key={entry} variant="neutral">
                        {entry}
                      </Badge>
                    ))}
                  </span>
                )}
              </TableCell>
              <TableCell className="whitespace-nowrap">
                <span className="flex items-center gap-1.5">
                  <RelativeTime value={target.lastHeartbeatAt} />
                  {stale ? (
                    <Badge variant="degraded" withDot>
                      stale
                    </Badge>
                  ) : null}
                </span>
              </TableCell>
              <TableCell className="hidden tabular-nums sm:table-cell">
                {formatPercent(target.cpuPct ?? null)}
              </TableCell>
              <TableCell className="hidden tabular-nums sm:table-cell">
                {formatPercent(target.memUsedPct ?? null)}
              </TableCell>
              <TableCell className="hidden tabular-nums xl:table-cell">
                {formatPercent(target.diskUsedPct ?? null)}
              </TableCell>
              <TableCell className="hidden whitespace-nowrap xl:table-cell">
                {target.uptimeSec === undefined || target.uptimeSec === null
                  ? "—"
                  : formatDuration(target.uptimeSec)}
              </TableCell>
              <TableCell className="hidden whitespace-nowrap lg:table-cell">
                {target.agent?.agentVersion ?? "—"}
              </TableCell>
              <TableCell className="hidden whitespace-nowrap md:table-cell">
                <span className="text-on-surface-variant">
                  {target.pendingJobCount ?? 0} queued · {target.runningJobCount ?? 0} running
                </span>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function TargetsTableSkeleton() {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-outline-variant p-4">
      {Array.from({ length: 8 }, (_, index) => (
        <Skeleton key={index} className="h-10 w-full" />
      ))}
    </div>
  );
}
