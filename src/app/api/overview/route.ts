import { requireUser } from "@/lib/server/clerk";
import { json, respond } from "@/lib/server/errors";
import { buildOverview } from "@/lib/server/overview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return respond(async () => {
    await requireUser();
    return json(await buildOverview());
  });
}
