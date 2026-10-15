"use client";

import { useId, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";

export type TooltipSide = "top" | "bottom" | "left" | "right";

export interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  side?: TooltipSide;
  className?: string;
}

const SIDE_CLASSES: Record<TooltipSide, string> = {
  top: "bottom-full left-1/2 -translate-x-1/2 mb-2",
  bottom: "top-full left-1/2 -translate-x-1/2 mt-2",
  left: "right-full top-1/2 -translate-y-1/2 mr-2",
  right: "left-full top-1/2 -translate-y-1/2 ml-2",
};

/** Lightweight tooltip shown on hover and focus, dismissed with Escape. */
export function Tooltip({ content, children, side = "top", className }: TooltipProps) {
  const id = useId();
  const [open, setOpen] = useState(false);

  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocusCapture={() => setOpen(true)}
      onBlurCapture={() => setOpen(false)}
      onKeyDown={(event) => {
        if (event.key === "Escape") setOpen(false);
      }}
      aria-describedby={open ? id : undefined}
    >
      {children}
      {open ? (
        <span
          role="tooltip"
          id={id}
          className={cn(
            "absolute z-50 max-w-xs whitespace-nowrap rounded-md border border-outline-variant bg-surface-container-high px-2 py-1 text-xs text-on-surface shadow-md",
            SIDE_CLASSES[side],
            className,
          )}
        >
          {content}
        </span>
      ) : null}
    </span>
  );
}
