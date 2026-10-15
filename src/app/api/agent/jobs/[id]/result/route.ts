import { requireAgent, submitJobResult } from "@/lib/server/agent";
import { toJobDto } from "@/lib/server/dto";
import { json, parseBody, readJson, respond } from "@/lib/server/errors";
import { clientIp, enforceRateLimit, RATE_RULES } from "@/lib/server/rate-limit";
import { jobResultSchema } from "@/lib/server/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  return respond(async () => {
    enforceRateLimit(`job-result:${clientIp(request.headers)}`, RATE_RULES.jobResult);

    const { id } = await context.params;
    const { identity } = await requireAgent(request);
    const input = parseBody(jobResultSchema, await readJson(request));

    const job = await submitJobResult(identity, id, input);
    return json(toJobDto(job));
  });
}
