/**
 * Server startup hook (Next.js instrumentation).
 *
 * Owns the background retention task. A `globalThis` guard ensures exactly one
 * timer exists per Node.js process, even across dev-server hot reloads.
 * The sweep itself lives in src/lib/server/telemetry.ts so the API and the
 * background job share one implementation of the retention rules.
 */

declare global {
  var __nexopsRetentionTimer: ReturnType<typeof setInterval> | undefined;
}

const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

export async function register(): Promise<void> {
  // Only the Node.js runtime has Prisma; skip Edge/middleware environments.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (globalThis.__nexopsRetentionTimer) return;

  // Dynamic import keeps Prisma (and the rest of the server graph) out of
  // any non-Node bundle that evaluates this file.
  const { runRetentionSweep } = await import("./lib/server/telemetry");

  async function sweep(): Promise<void> {
    try {
      const result = await runRetentionSweep();
      if (result.telemetryDeleted > 0 || result.tokensDeleted > 0) {
        console.info(
          `[retention] removed ${result.telemetryDeleted} telemetry snapshots, ${result.tokensDeleted} used enrolment tokens`,
        );
      }
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
