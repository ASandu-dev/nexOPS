"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
import { cn } from "@/lib/cn";

export type SnackbarVariant = "info" | "success" | "warning" | "error";

export interface SnackbarOptions {
  message: string;
  variant?: SnackbarVariant;
  /** Milliseconds before auto-dismiss. Use 0 to require manual dismissal. */
  durationMs?: number;
}

interface SnackbarItem extends Required<Omit<SnackbarOptions, "message">> {
  id: number;
  message: string;
}

interface SnackbarContextValue {
  notify: (options: SnackbarOptions) => number;
  dismiss: (id: number) => void;
}

const SnackbarContext = createContext<SnackbarContextValue | null>(null);

const VARIANT_ICON = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  error: XCircle,
} as const;

const VARIANT_CLASSES: Record<SnackbarVariant, string> = {
  info: "border-outline-variant bg-surface-container-high text-on-surface",
  success: "border-success/40 bg-success-container text-on-success-container",
  warning: "border-warning/40 bg-warning-container text-on-warning-container",
  error: "border-error/40 bg-error-container text-on-error-container",
};

export function useSnackbar(): SnackbarContextValue {
  const ctx = useContext(SnackbarContext);
  if (!ctx) {
    throw new Error("useSnackbar must be used within <SnackbarProvider>");
  }
  return ctx;
}

export function SnackbarProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<SnackbarItem[]>([]);
  const counterRef = useRef(0);

  const dismiss = useCallback((id: number) => {
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  const notify = useCallback((options: SnackbarOptions) => {
    counterRef.current += 1;
    const id = counterRef.current;
    setItems((current) => [
      ...current,
      {
        id,
        message: options.message,
        variant: options.variant ?? "info",
        durationMs: options.durationMs ?? 5000,
      },
    ]);
    return id;
  }, []);

  const value = useMemo<SnackbarContextValue>(
    () => ({ notify, dismiss }),
    [notify, dismiss],
  );

  return (
    <SnackbarContext.Provider value={value}>
      {children}
      <div
        className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-full max-w-sm flex-col gap-2"
        aria-live="polite"
        aria-atomic="false"
      >
        {items.map((item) => (
          <SnackbarRow key={item.id} item={item} onDismiss={dismiss} />
        ))}
      </div>
    </SnackbarContext.Provider>
  );
}

function SnackbarRow({
  item,
  onDismiss,
}: {
  item: SnackbarItem;
  onDismiss: (id: number) => void;
}) {
  useEffect(() => {
    if (item.durationMs <= 0) return;
    const timer = window.setTimeout(() => onDismiss(item.id), item.durationMs);
    return () => window.clearTimeout(timer);
  }, [item.id, item.durationMs, onDismiss]);

  const Icon = VARIANT_ICON[item.variant];
  return (
    <div
      role="status"
      className={cn(
        "pointer-events-auto flex items-start gap-3 rounded-lg border p-3 shadow-lg",
        VARIANT_CLASSES[item.variant],
      )}
    >
      <Icon className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
      <p className="flex-1 text-sm">{item.message}</p>
      <button
        type="button"
        onClick={() => onDismiss(item.id)}
        aria-label="Dismiss notification"
        className="rounded p-0.5 opacity-70 transition-opacity hover:opacity-100 focus-visible:ring-2 focus-visible:ring-current"
      >
        <X className="size-4" aria-hidden="true" />
      </button>
    </div>
  );
}
