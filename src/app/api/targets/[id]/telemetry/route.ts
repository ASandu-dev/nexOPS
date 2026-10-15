import { requireUser } from "@/lib/server/clerk";
import { json, parseQuery, respond } from "@/lib/server/errors";
import { telemetryQuerySchema } from "@/lib/server/schemas";
import { getTelemetrySeries } from "@/lib/server/telemetry";
import { assertTargetExists } from "@/lib/server/targets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  return respond(async () => {
    await requireUser();
    const { id } = await context.params;
    await assertTargetExists(id);

    const { range } = parseQuery(telemetryQuerySchema, new URL(request.url).searchParams);
    return json(await getTelemetrySeries(id, range ?? "1h"));
  });
}
