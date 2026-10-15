"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "./button";
import { cn } from "@/lib/cn";

export interface PaginationProps {
  page: number;
  totalPages: number;
  total: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  disabled?: boolean;
  className?: string;
}

/** Compact prev/next pager with a "showing X–Y of Z" summary. */
export function Pagination({
  page,
  totalPages,
  total,
  pageSize,
  onPageChange,
  disabled = false,
  className,
}: PaginationProps) {
  const safeTotalPages = Math.max(1, totalPages);
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);

  return (
    <nav
      aria-label="Pagination"
      className={cn("flex flex-wrap items-center justify-between gap-3", className)}
    >
      <p className="text-sm text-on-surface-variant">
        {total === 0 ? "No results" : `Showing ${first}–${last} of ${total}`}
      </p>
      <div className="flex items-center gap-2">
        <Button
          variant="outlined"
          size="sm"
          onClick={() => onPageChange(page - 1)}
          disabled={disabled || page <= 1}
          leadingIcon={<ChevronLeft className="size-4" aria-hidden="true" />}
          aria-label="Previous page"
        >
          Previous
        </Button>
        <span className="text-sm text-on-surface-variant" aria-live="polite">
          Page {page} of {safeTotalPages}
        </span>
        <Button
          variant="outlined"
          size="sm"
          onClick={() => onPageChange(page + 1)}
          disabled={disabled || page >= safeTotalPages}
          trailingIcon={<ChevronRight className="size-4" aria-hidden="true" />}
          aria-label="Next page"
        >
          Next
        </Button>
      </div>
    </nav>
  );
}
