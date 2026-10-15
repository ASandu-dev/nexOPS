import { requireUser } from "@/lib/server/clerk";
import { json, parseBody, parseQuery, readJson, respond } from "@/lib/server/errors";
import { clientIp, enforceRateLimit, RATE_RULES } from "@/lib/server/rate-limit";
import { resolveBaseUrl } from "@/lib/server/releases";
import { createTargetSchema, targetListQuerySchema } from "@/lib/server/schemas";
import { createTarget, listTargets } from "@/lib/server/targets";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  return respond(async () => {
    await requireUser();
    const query = parseQuery(targetListQuerySchema, new URL(request.url).searchParams);
    return json(await listTargets(query));
  });
}

export async function POST(request: Request): Promise<Response> {
  return respond(async () => {
    const userId = await requireUser();
    enforceRateLimit(`target-create:${userId}:${clientIp(request.headers)}`, RATE_RULES.targetCreate);

    const body = parseBody(createTargetSchema, await readJson(request));
    return json(
      await createTarget(
        {
          name: body.name,
          os: body.os,
          hostnameOverride: body.hostnameOverride ?? null,
          labels: body.labels,
        },
        resolveBaseUrl(request),
        userId,
      ),
    );
  });
}
