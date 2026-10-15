"use client";

import { useId, useState } from "react";
import { cn } from "@/lib/cn";

export interface SwitchProps {
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  label?: string;
  /** Visually hide the label but keep it available to assistive tech. */
  hideLabel?: boolean;
  className?: string;
  id?: string;
}

/**
 * Accessible switch built on a native button with `role="switch"`.
 * Supports both controlled and uncontrolled usage.
 */
export function Switch({
  checked,
  defaultChecked = false,
  onCheckedChange,
  disabled = false,
  label,
  hideLabel = false,
  className,
  id,
}: SwitchProps) {
  const generatedId = useId();
  const switchId = id ?? generatedId;
  const [internal, setInternal] = useState(defaultChecked);
  const isControlled = checked !== undefined;
  const isOn = isControlled ? checked : internal;

  function toggle() {
    const next = !isOn;
    if (!isControlled) setInternal(next);
    onCheckedChange?.(next);
  }

  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <button
        type="button"
        role="switch"
        id={switchId}
        aria-checked={isOn}
        aria-label={label && hideLabel ? label : undefined}
        disabled={disabled}
        onClick={toggle}
        className={cn(
          "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border-2 border-transparent transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:cursor-not-allowed disabled:opacity-50",
          isOn ? "bg-primary" : "bg-outline",
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            "pointer-events-none block size-5 rounded-full bg-white shadow transition-transform",
            isOn ? "translate-x-5" : "translate-x-0",
          )}
        />
      </button>
      {label && !hideLabel ? (
        <label htmlFor={switchId} className="text-sm text-on-surface">
          {label}
        </label>
      ) : null}
    </span>
  );
}
