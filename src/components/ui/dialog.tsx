"use client";

import {
  useCallback,
  useEffect,
  useRef,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
  /** Accessible name when no DialogTitle is rendered. */
  ariaLabel?: string;
  className?: string;
  /** Disable closing via backdrop click (e.g. destructive confirm in flight). */
  dismissOnBackdropClick?: boolean;
}

/**
 * Modal dialog rendered into a portal with a focus trap, Escape-to-close,
 * backdrop dismissal, and scroll locking.
 */
export function Dialog({
  open,
  onOpenChange,
  children,
  ariaLabel,
  className,
  dismissOnBackdropClick = true,
}: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  const close = useCallback(() => onOpenChange(false), [onOpenChange]);

  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current = document.activeElement as HTMLElement | null;

    const previouslyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const panel = panelRef.current;
    const first = panel?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel)?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
        return;
      }
      if (event.key !== "Tab" || !panel) return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const firstEl = focusable[0];
      const lastEl = focusable[focusable.length - 1];
      if (!firstEl || !lastEl) return;
      if (event.shiftKey && document.activeElement === firstEl) {
        event.preventDefault();
        lastEl.focus();
      } else if (!event.shiftKey && document.activeElement === lastEl) {
        event.preventDefault();
        firstEl.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previouslyOverflow;
      restoreFocusRef.current?.focus();
    };
  }, [open, close]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        aria-hidden="true"
        onClick={dismissOnBackdropClick ? close : undefined}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        tabIndex={-1}
        className={cn(
          "relative z-10 max-h-[90dvh] w-full max-w-lg overflow-y-auto rounded-lg border border-outline-variant bg-surface-container p-6 shadow-xl outline-none",
          className,
        )}
      >
        <button
          type="button"
          onClick={close}
          aria-label="Close dialog"
          className="absolute right-4 top-4 rounded-md p-1 text-on-surface-variant transition-colors hover:bg-surface-container-high focus-visible:ring-2 focus-visible:ring-primary"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
        {children}
      </div>
    </div>,
    document.body,
  );
}

export function DialogHeader({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("mb-4 flex flex-col gap-1", className)} {...rest} />;
}

export interface DialogTitleProps extends HTMLAttributes<HTMLHeadingElement> {
  as?: "h2" | "h3";
}

export function DialogTitle({ as: Tag = "h2", className, ...rest }: DialogTitleProps) {
  return <Tag className={cn("text-lg font-semibold", className)} {...rest} />;
}

export function DialogDescription({
  className,
  ...rest
}: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("text-sm text-on-surface-variant", className)} {...rest} />;
}

export function DialogFooter({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("mt-6 flex justify-end gap-2", className)} {...rest} />
  );
}
