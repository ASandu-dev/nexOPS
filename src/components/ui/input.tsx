import type { InputHTMLAttributes, ReactNode } from "react";
import { useId } from "react";
import { cn } from "@/lib/cn";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  leadingIcon?: ReactNode;
}

export function Input({
  label,
  hint,
  error,
  leadingIcon,
  className,
  id,
  "aria-describedby": ariaDescribedBy,
  ...rest
}: InputProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const hintId = hint ? `${inputId}-hint` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  const describedBy =
    [ariaDescribedBy, errorId, hintId].filter(Boolean).join(" ") || undefined;
  const invalid = error != null;

  return (
    <div className="flex flex-col gap-1.5">
      {label ? (
        <label htmlFor={inputId} className="text-sm font-medium text-on-surface">
          {label}
        </label>
      ) : null}
      <div className="relative flex items-center">
        {leadingIcon ? (
          <span
            className="pointer-events-none absolute left-3 flex text-on-surface-variant"
            aria-hidden="true"
          >
            {leadingIcon}
          </span>
        ) : null}
        <input
          id={inputId}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          className={cn(
            "h-10 w-full rounded-md border bg-surface-container px-3 text-sm text-on-surface placeholder:text-on-surface-variant/70 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50",
            invalid ? "border-error" : "border-outline",
            leadingIcon ? "pl-9" : undefined,
            className,
          )}
          {...rest}
        />
      </div>
      {error ? (
        <p id={errorId} className="text-xs text-error">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="text-xs text-on-surface-variant">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
