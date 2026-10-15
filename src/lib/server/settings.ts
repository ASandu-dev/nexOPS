import { z } from "zod";
import type { SettingsDto } from "@/lib/types";
import { prisma } from "./prisma";

const CONFIG_KEY = "singleton";

const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_HEARTBEAT_INTERVAL_SEC = 30;
const DEFAULT_WATCHED_SERVICES: string[] = [];

export const settingsPatchSchema = z
  .object({
    telemetryRetentionDays: z.number().int().min(1).max(365).optional(),
    heartbeatIntervalSec: z.number().int().min(10).max(3600).optional(),
    watchedServices: z
      .array(z.string().trim().min(1).max(128))
      .max(50)
      .optional(),
  })
  .refine(
    (value) => Object.values(value).some((v) => v !== undefined),
    { message: "At least one setting must be provided" },
  );

export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

const storedSettingsSchema = z.object({
  telemetryRetentionDays: z.number().int().min(1).max(365),
  heartbeatIntervalSec: z.number().int().min(10).max(3600),
  watchedServices: z.array(z.string().min(1).max(128)).max(50),
});

// A type alias (not interface) so the object stays assignable to Prisma's
// InputJsonValue without an index-signature cast.
export type AppSettings = {
  telemetryRetentionDays: number;
  heartbeatIntervalSec: number;
  watchedServices: string[];
};

function envInt(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

/** Env-derived defaults; the AppConfig row (if any) overrides them. */
function defaultSettings(): AppSettings {
  const watched = process.env["WATCHED_SERVICES"];
  return {
    telemetryRetentionDays: envInt("TELEMETRY_RETENTION_DAYS", DEFAULT_RETENTION_DAYS, 1, 365),
    heartbeatIntervalSec: envInt("HEARTBEAT_INTERVAL_SEC", DEFAULT_HEARTBEAT_INTERVAL_SEC, 10, 3600),
    watchedServices: watched
      ? watched.split(",").map((s) => s.trim()).filter((s) => s.length > 0).slice(0, 50)
      : [...DEFAULT_WATCHED_SERVICES],
  };
}

export async function getSettings(): Promise<{ settings: AppSettings; updatedAt: Date | null }> {
  const row = await prisma.appConfig.findUnique({ where: { key: CONFIG_KEY } });
  const defaults = defaultSettings();
  if (!row) {
    return { settings: defaults, updatedAt: null };
  }
  const parsed = storedSettingsSchema.safeParse(row.value);
  if (!parsed.success) {
    // Corrupt override must not take the platform down; fall back to env defaults.
    console.error("[settings] stored AppConfig value is invalid; using env defaults");
    return { settings: defaults, updatedAt: row.updatedAt };
  }
  return { settings: parsed.data, updatedAt: row.updatedAt };
}

export async function getSettingsDto(): Promise<SettingsDto> {
  const { settings, updatedAt } = await getSettings();
  return { ...settings, updatedAt: (updatedAt ?? new Date(0)).toISOString() };
}

/** Persists overrides (partial patch merged over current effective values). */
export async function updateSettings(patch: SettingsPatch): Promise<SettingsDto> {
  const { settings: current } = await getSettings();
  const next: AppSettings = {
    telemetryRetentionDays: patch.telemetryRetentionDays ?? current.telemetryRetentionDays,
    heartbeatIntervalSec: patch.heartbeatIntervalSec ?? current.heartbeatIntervalSec,
    watchedServices: patch.watchedServices
      ? [...new Set(patch.watchedServices.map((s) => s.trim()).filter((s) => s.length > 0))]
      : current.watchedServices,
  };
  const row = await prisma.appConfig.upsert({
    where: { key: CONFIG_KEY },
    create: { key: CONFIG_KEY, value: next },
    update: { value: next },
  });
  return { ...next, updatedAt: row.updatedAt.toISOString() };
}
