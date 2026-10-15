/**
 * Server startup hook (Next.js instrumentation).
 *
 * Owns the background retention task. A `globalThis` guard ensures exactly one
 * timer exists per Node.js process, even across dev-server hot reloads.
 */

import { PrismaClient } from "@prisma/client";

declare global {
  var __nexopsRetentionTimer: ReturnType<typeof setInterval> | undefined;
}

const DEFAULT_RETENTION_DAYS = 30;
const USED_TOKEN_MAX_AGE_DAYS = 7;
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

function retentionDays(): number {
  const parsed = Number.parseInt(process.env.TELEMETRY_RETENTION_DAYS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RETENTION_DAYS;
}

export async function register(): Promise<void> {
  // Only the Node.js runtime has Prisma; skip Edge/middleware environments.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (globalThis.__nexopsRetentionTimer) return;

  const prisma = new PrismaClient();
  const telemetryCutoffMs = retentionDays() * 24 * 60 * 60 * 1000;
  const tokenCutoffMs = USED_TOKEN_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

  async function sweep(): Promise<void> {
    const now = Date.now();
    try {
      await prisma.telemetrySnapshot.deleteMany({
        where: { capturedAt: { lt: new Date(now - telemetryCutoffMs) } },
      });
      await prisma.enrolmentToken.deleteMany({
        where: { usedAt: { not: null, lt: new Date(now - tokenCutoffMs) } },
      });
    } catch (error) {
      // Cleanup must never crash the process; log and retry on the next sweep.
      console.error("[retention] sweep failed", error);
    }
  }

  globalThis.__nexopsRetentionTimer = setInterval(() => void sweep(), SWEEP_INTERVAL_MS);
  // Do not keep the event loop alive solely for cleanup.
  globalThis.__nexopsRetentionTimer.unref?.();
  void sweep();
}
