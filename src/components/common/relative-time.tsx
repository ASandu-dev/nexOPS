"use client";

import { useEffect, useState } from "react";
import { formatRelativeTime } from "@/lib/format";
import { formatAbsoluteTime } from "@/lib/display";

export interface RelativeTimeProps {
  value: string | null | undefined;
  className?: string;
}

/**
 * Renders a relative timestamp with the absolute time in a tooltip.
 *
 * The relative string is computed after mount so server and client markup match
 * (the absolute time is the SSR fallback), avoiding hydration drift.
 */
export function RelativeTime({ value, className }: RelativeTimeProps) {
  const [label, setLabel] = useState<string | null>(null);

  useEffect(() => {
    setLabel(formatRelativeTime(value ?? null));
  }, [value]);

  const absolute = formatAbsoluteTime(value);
  return (
    <time dateTime={value ?? undefined} title={absolute} className={className}>
      {label ?? absolute}
    </time>
  );
}
