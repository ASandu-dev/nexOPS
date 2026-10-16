/**
 * In-memory token-bucket rate limiter (no Redis — single-process control
 * plane, per ARCHITECTURE.md §5). Buckets are keyed by route + client IP or
 * agent identity; expired buckets are pruned lazily.
 */

import { ApiError } from "./errors";

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export interface RateLimitRule {
  /** Burst size. */
  capacity: number;
  /** Sustained refill rate. */
  refillPerSec: number;
}

export interface RateLimitDecision {
  ok: boolean;
  /** Seconds the caller must wait before retrying (only when `ok` is false). */
  retryAfterSec: number;
}

const buckets = new Map<string, Bucket>();
const PRUNE_AFTER_MS = 10 * 60 * 1000;
let lastPruneAt = 0;

function prune(now: number): void {
  if (now - lastPruneAt < PRUNE_AFTER_MS) return;
  lastPruneAt = now;
  for (const [key, bucket] of buckets) {
    if (now - bucket.updatedAt > PRUNE_AFTER_MS) {
      buckets.delete(key);
    }
  }
}

/** Consumes one token from the bucket for `key`. First call returns ok. */
export function consumeToken(key: string, rule: RateLimitRule): RateLimitDecision {
  const now = Date.now();
  prune(now);

  const bucket = buckets.get(key);
  if (!bucket) {
    buckets.set(key, { tokens: rule.capacity - 1, updatedAt: now });
    return { ok: true, retryAfterSec: 0 };
  }

  const elapsedSec = (now - bucket.updatedAt) / 1000;
  bucket.tokens = Math.min(rule.capacity, bucket.tokens + elapsedSec * rule.refillPerSec);
  bucket.updatedAt = now;

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return { ok: true, retryAfterSec: 0 };
  }

  const deficit = 1 - bucket.tokens;
  return { ok: false, retryAfterSec: Math.max(1, Math.ceil(deficit / rule.refillPerSec)) };
}

/**
 * Client IP behind the reverse proxy; never trusted for auth, only for
 * throttling.
 *
 * Trust assumption (docs/DEPLOYMENT.md): exactly one reverse proxy fronts the
 * control plane. It sets `x-real-ip` itself and APPENDS the peer address to
 * `x-forwarded-for`, so earlier list entries are client-controlled and
 * spoofable — only the last entry (or the proxy-set `x-real-ip`) is reliable.
 */
export function clientIp(headers: Headers): string {
  const real = headers.get("x-real-ip")?.trim();
  if (real) return real;
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const entries = forwarded.split(",");
    const last = entries[entries.length - 1]?.trim();
    if (last) return last;
  }
  return "unknown";
}

/** Shared bucket capacities for the routes that must be throttled (ARCHITECTURE.md §5). */
export const RATE_RULES = {
  enrol: { capacity: 10, refillPerSec: 1 / 30 },
  heartbeat: { capacity: 120, refillPerSec: 10 },
  jobResult: { capacity: 120, refillPerSec: 5 },
  releases: { capacity: 30, refillPerSec: 0.5 },
  targetCreate: { capacity: 10, refillPerSec: 1 / 6 },
} as const satisfies Record<string, RateLimitRule>;

/**
 * Consumes a token or throws 429 with `Retry-After`.
 * errors.ts does not import this module, so a static import is cycle-free.
 */
export function enforceRateLimit(key: string, rule: RateLimitRule): void {
  const decision = consumeToken(key, rule);
  if (!decision.ok) {
    throw new ApiError(429, "RATE_LIMITED", "Too many requests, slow down", {
      headers: { "Retry-After": String(decision.retryAfterSec) },
    });
  }
}
