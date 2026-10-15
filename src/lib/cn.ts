export type ClassValue =
  | string
  | number
  | null
  | false
  | undefined
  | ClassValue[]
  | Record<string, boolean | null | undefined>;

/**
 * Minimal class-name joiner.
 *
 * Deliberately dependency-free: NexOPS UI primitives only need conditional
 * concatenation, not `tailwind-merge` semantics. Order is preserved so callers
 * can rely on later classes winning via normal CSS source order.
 */
export function cn(...inputs: ClassValue[]): string {
  const out: string[] = [];
  for (const input of inputs) {
    if (!input) continue;
    if (typeof input === "string" || typeof input === "number") {
      out.push(String(input));
    } else if (Array.isArray(input)) {
      const nested = cn(...input);
      if (nested) out.push(nested);
    } else {
      for (const [key, active] of Object.entries(input)) {
        if (active) out.push(key);
      }
    }
  }
  return out.join(" ");
}
