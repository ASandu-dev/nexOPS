"use client";

import { Fragment, useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { AuditEventDto } from "@/lib/types";
import { prettifyAction } from "@/lib/display";
import {
  ActorTypeBadge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui";
import { RelativeTime } from "@/components/common/relative-time";

export interface AuditTableProps {
  events: readonly AuditEventDto[];
}

/** Audit log table with expandable metadata rows. */
export function AuditTable({ events }: AuditTableProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  function toggle(id: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-10">
            <span className="sr-only">Metadata</span>
          </TableHead>
          <TableHead>Time</TableHead>
          <TableHead>Actor</TableHead>
          <TableHead className="hidden sm:table-cell">Type</TableHead>
          <TableHead>Action</TableHead>
          <TableHead className="hidden md:table-cell">Target</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {events.map((event) => {
          const isOpen = expanded.has(event.id);
          const hasMetadata = event.metadata !== null && Object.keys(event.metadata).length > 0;
          return (
            <Fragment key={event.id}>
              <TableRow>
                <TableCell>
                  {hasMetadata ? (
                    <button
                      type="button"
                      onClick={() => toggle(event.id)}
                      aria-expanded={isOpen}
                      aria-label={isOpen ? "Hide metadata" : "Show metadata"}
                      className="inline-flex size-7 items-center justify-center rounded-md text-on-surface-variant hover:bg-surface-container-high focus-visible:ring-2 focus-visible:ring-primary"
                    >
                      {isOpen ? (
                        <ChevronDown className="size-4" aria-hidden="true" />
                      ) : (
                        <ChevronRight className="size-4" aria-hidden="true" />
                      )}
                    </button>
                  ) : null}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  <RelativeTime value={event.createdAt} />
                </TableCell>
                <TableCell className="max-w-[12rem] truncate" title={event.actorId}>
                  {event.actorId}
                </TableCell>
                <TableCell className="hidden sm:table-cell">
                  <ActorTypeBadge actorType={event.actorType} />
                </TableCell>
                <TableCell className="font-medium">{prettifyAction(event.action)}</TableCell>
                <TableCell className="hidden md:table-cell">
                  {event.targetId ? (
                    <Link
                      href={`/targets/${event.targetId}`}
                      className="text-primary hover:underline"
                    >
                      {event.targetType ?? "target"}
                    </Link>
                  ) : (
                    <span className="text-on-surface-variant">{event.targetType ?? "—"}</span>
                  )}
                </TableCell>
              </TableRow>
              {isOpen && hasMetadata ? (
                <TableRow>
                  <TableCell colSpan={6} className="bg-surface-container-high/50">
                    <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-on-surface">
                      {JSON.stringify(event.metadata, null, 2)}
                    </pre>
                  </TableCell>
                </TableRow>
              ) : null}
            </Fragment>
          );
        })}
      </TableBody>
    </Table>
  );
}
