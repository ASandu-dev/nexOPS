"use client";

import { cn } from "@/lib/cn";

export interface FilterChipOption {
  value: string;
  label: string;
}

export interface FilterChipsProps {
  options: readonly FilterChipOption[];
  selected: readonly string[];
  onChange: (next: string[]) => void;
  /** Accessible group label. */
  label: string;
  className?: string;
}

/**
 * Multi-select filter rendered as toggle chips. Each chip is a real button with
 * `aria-pressed`, so keyboard and screen-reader users get the same affordance.
 */
export function FilterChips({ options, selected, onChange, label, className }: FilterChipsProps) {
  function toggle(value: string) {
    onChange(
      selected.includes(value)
        ? selected.filter((entry) => entry !== value)
        : [...selected, value],
    );
  }

  return (
    <div role="group" aria-label={label} className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {options.map((option) => {
        const active = selected.includes(option.value);
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => toggle(option.value)}
            className={cn(
              "rounded-full border px-3 py-1 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-primary",
              active
                ? "border-transparent bg-primary text-on-primary"
                : "border-outline-variant bg-surface-container text-on-surface-variant hover:bg-surface-container-high",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
