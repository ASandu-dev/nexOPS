import { cn } from "@/lib/cn";

export type MeterTone = "auto" | "primary" | "success" | "warning" | "error";

export interface MeterProps {
  /** 0–100, or null when the value is unknown. */
  value: number | null;
  label?: string;
  /** Right-aligned detail such as "3.2 GiB / 8 GiB". */
  detail?: string;
  tone?: MeterTone;
  className?: string;
}

const TONE_CLASSES: Record<Exclude<MeterTone, "auto">, string> = {
  primary: "bg-primary",
  success: "bg-success",
  warning: "bg-warning",
  error: "bg-error",
};

/** Thresholds used when `tone="auto"`: warn at 75%, error at 90%. */
function autoTone(value: number): Exclude<MeterTone, "auto"> {
  if (value >= 90) return "error";
  if (value >= 75) return "warning";
  return "primary";
}

/**
 * Horizontal usage meter. Renders a text label and percentage alongside the bar
 * so the value is never conveyed by colour alone.
 */
export function Meter({ value, label, detail, tone = "auto", className }: MeterProps) {
  const clamped = value === null ? null : Math.min(100, Math.max(0, value));
  const resolvedTone = clamped === null ? "primary" : tone === "auto" ? autoTone(clamped) : tone;

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label || detail ? (
        <div className="flex items-baseline justify-between gap-2 text-sm">
          {label ? <span className="font-medium text-on-surface">{label}</span> : <span />}
          {detail ? <span className="text-on-surface-variant">{detail}</span> : null}
        </div>
      ) : null}
      <div
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={clamped === null ? undefined : Math.round(clamped)}
        aria-label={label}
        className="h-2 w-full overflow-hidden rounded-full bg-surface-container-high"
      >
        <div
          className={cn("h-full rounded-full transition-[width]", TONE_CLASSES[resolvedTone])}
          style={{ width: `${clamped ?? 0}%` }}
        />
      </div>
    </div>
  );
}
