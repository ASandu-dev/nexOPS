"use client";

import Link from "next/link";
import type { JobDto } from "@/lib/types";
import { formatJobDuration, JOB_TYPE_LABEL } from "@/lib/display";
import {
  JobStatusBadge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui";
import { RelativeTime } from "@/components/common/relative-time";

export interface JobsTableProps {
  jobs: readonly JobDto[];
  onSelect: (job: JobDto) => void;
  /** Show the target column (hidden on the target detail page). */
  showTarget?: boolean;
}

/** Shared jobs table. Rows are clickable; the type cell is a real button for keyboard users. */
export function JobsTable({ jobs, onSelect, showTarget = true }: JobsTableProps) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Type</TableHead>
          {showTarget ? <TableHead>Target</TableHead> : null}
          <TableHead>Status</TableHead>
          <TableHead className="hidden md:table-cell">Requested by</TableHead>
          <TableHead>Created</TableHead>
          <TableHead className="hidden lg:table-cell">Finished</TableHead>
          <TableHead className="hidden sm:table-cell">Duration</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {jobs.map((job) => (
          <TableRow key={job.id} onClick={() => onSelect(job)} className="cursor-pointer">
            <TableCell>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onSelect(job);
                }}
                className="font-medium text-primary hover:underline focus-visible:ring-2 focus-visible:ring-primary"
              >
                {JOB_TYPE_LABEL[job.type]}
              </button>
            </TableCell>
            {showTarget ? (
              <TableCell>
                <Link
                  href={`/targets/${job.targetId}`}
                  onClick={(event) => event.stopPropagation()}
                  className="text-primary hover:underline"
                >
                  {job.targetName ?? job.targetId}
                </Link>
              </TableCell>
            ) : null}
            <TableCell>
              <JobStatusBadge status={job.status} />
            </TableCell>
            <TableCell className="hidden max-w-[12rem] truncate md:table-cell" title={job.requestedBy}>
              {job.requestedBy}
            </TableCell>
            <TableCell className="whitespace-nowrap">
              <RelativeTime value={job.createdAt} />
            </TableCell>
            <TableCell className="hidden whitespace-nowrap lg:table-cell">
              <RelativeTime value={job.finishedAt} />
            </TableCell>
            <TableCell className="hidden whitespace-nowrap sm:table-cell">
              {formatJobDuration(job)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
