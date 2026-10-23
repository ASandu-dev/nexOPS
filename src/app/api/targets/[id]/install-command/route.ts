import { requireUser } from "@/lib/server/clerk";
import { json, respond } from "@/lib/server/errors";
import { resolveBaseUrl } from "@/lib/server/releases";
import { reissueInstallCommand } from "@/lib/server/targets";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  return respond(async () => {
    const userId = await requireUser();
    const { id } = await context.params;
    const result = await reissueInstallCommand(id, resolveBaseUrl(request), userId);
    // The response contains a live one-time credential; never cache it.
    return json(result, { headers: { "Cache-Control": "no-store" } });
  });
}
