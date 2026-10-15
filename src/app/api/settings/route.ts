import { requireUser } from "@/lib/server/clerk";
import { json, parseBody, readJson, respond } from "@/lib/server/errors";
import { recordAudit } from "@/lib/server/audit";
import { getSettingsDto, settingsPatchSchema, updateSettings } from "@/lib/server/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return respond(async () => {
    await requireUser();
    return json(await getSettingsDto());
  });
}

export async function PATCH(request: Request): Promise<Response> {
  return respond(async () => {
    const userId = await requireUser();
    const patch = parseBody(settingsPatchSchema, await readJson(request));
    const settings = await updateSettings(patch);

    await recordAudit({
      actorId: userId,
      actorType: "USER",
      action: "settings.update",
      targetType: "settings",
      metadata: { fields: Object.keys(patch) },
    });
    return json(settings);
  });
}
