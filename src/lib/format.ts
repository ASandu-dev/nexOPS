import { formatDistance } from "date-fns";

/**
 * Pure formatting helpers shared by every surface.
 *
 * No React, no side effects, deterministic output. Safe to use from Server
 * Components, Client Components, and tests alike.
 */

export const BINARY_UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"] as const;
export type BinaryUnit = (typeof BINARY_UNITS)[number];

/** The units the fleet UI actually presents in tables and cards. */
export type DisplayByteUnit = Extract<BinaryUnit, "MiB" | "GiB" | "TiB">;

const BYTES_PER_UNIT: Readonly<Record<BinaryUnit, number>> = {
  B: 1,
  KiB: 1024,
  MiB: 1024 ** 2,
  GiB: 1024 ** 3,
  TiB: 1024 ** 4,
  PiB: 1024 ** 5,
};

/**
 * Format a byte count using binary (1024-based) units.
 *
 * With no `unit` the largest unit that keeps the value >= 1 is chosen, so
 * callers can render `formatBytes(memTotalBytes)` directly. Passing a unit
 * forces that scale, which is useful when aligning table columns.
 */
export function formatBytes(
  bytes: number,
  unit?: DisplayByteUnit,
  fractionDigits = 1,
): string {
  if (!Number.isFinite(bytes)) return "—";

  const chosen: BinaryUnit = unit ?? autoUnit(bytes);
  const value = bytes / BYTES_PER_UNIT[chosen];
  return `${trimNumber(value, fractionDigits)} ${chosen}`;
}

function autoUnit(bytes: number): BinaryUnit {
  const abs = Math.abs(bytes);
  let index = 0;
  while (index < BINARY_UNITS.length - 1) {
    const next = BINARY_UNITS[index + 1];
    if (next === undefined || abs < BYTES_PER_UNIT[next]) break;
    index += 1;
  }
  return BINARY_UNITS[index] ?? "B";
}

/**
 * Human duration such as "3 days, 4 hours".
 *
 * Zero-valued units are omitted; sub-second durations render as "0 seconds".
 * At most `maxUnits` adjacent non-zero units are shown to keep the string tight.
 */
export function formatDuration(seconds: number, maxUnits = 2): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const whole = Math.floor(seconds);
  if (whole === 0) return "0 seconds";

  const units: ReadonlyArray<readonly [label: string, size: number]> = [
    ["year", 31_536_000],
    ["month", 2_592_000],
    ["week", 604_800],
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
    ["second", 1],
  ];

  const parts: string[] = [];
  let remainder = whole;
  for (const [label, size] of units) {
    const count = Math.floor(remainder / size);
    if (count === 0) continue;
    remainder -= count * size;
    parts.push(`${count} ${label}${count === 1 ? "" : "s"}`);
    if (parts.length >= maxUnits) break;
  }
  return parts.join(", ");
}

/** Format a 0–100 percentage with a fixed number of decimals. */
export function formatPercent(value: number | null, fractionDigits = 1): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${trimNumber(value, fractionDigits)}%`;
}

/**
 * Relative time such as "5 minutes ago" / "in 2 hours".
 *
 * `now` is injectable so the function stays pure and testable.
 */
export function formatRelativeTime(
  date: Date | string | number | null,
  now: Date = new Date(),
): string {
  if (date === null) return "—";
  const parsed = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(parsed.getTime())) return "—";
  return formatDistance(parsed, now, { addSuffix: true });
}

function trimNumber(value: number, fractionDigits: number): string {
  const clampedDigits = Math.min(Math.max(fractionDigits, 0), 6);
  const fixed = value.toFixed(clampedDigits);
  // Drop trailing zeros but keep at least the integer part ("12.0" -> "12").
  return fixed.includes(".") ? fixed.replace(/\.?0+$/, "") : fixed;
}
