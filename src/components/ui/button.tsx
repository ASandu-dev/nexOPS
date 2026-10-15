import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";

export type ButtonVariant =
  | "filled"
  | "outlined"
  | "text"
  | "tonal"
  | "danger";

export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Renders a spinner, disables interaction, and sets aria-busy. */
  loading?: boolean;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
}

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  filled:
    "bg-primary text-on-primary hover:brightness-110 active:brightness-95 shadow-sm",
  outlined:
    "border border-outline text-primary bg-transparent hover:bg-primary-container/40",
  text: "text-primary bg-transparent hover:bg-primary-container/40",
  tonal:
    "bg-primary-container text-on-primary-container hover:brightness-[0.97]",
  danger: "bg-error text-on-error hover:brightness-110 active:brightness-95",
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: "h-8 gap-1.5 px-3 text-sm",
  md: "h-10 gap-2 px-4 text-sm",
  lg: "h-12 gap-2 px-6 text-base",
};

const BASE_CLASSES =
  "inline-flex items-center justify-center rounded-md font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:opacity-50 disabled:pointer-events-none";

export function Button({
  variant = "filled",
  size = "md",
  loading = false,
  leadingIcon,
  trailingIcon,
  className,
  disabled,
  children,
  type = "button",
  ...rest
}: ButtonProps) {
  const isDisabled = disabled === true || loading;
  return (
    <button
      type={type}
      className={cn(BASE_CLASSES, VARIANT_CLASSES[variant], SIZE_CLASSES[size], className)}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? (
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
      ) : (
        leadingIcon
      )}
      {children}
      {!loading && trailingIcon}
    </button>
  );
}
