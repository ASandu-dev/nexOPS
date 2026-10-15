import { enrolAgent } from "@/lib/server/agent";
import { json, parseBody, readJson, respond } from "@/lib/server/errors";
import { clientIp, enforceRateLimit, RATE_RULES } from "@/lib/server/rate-limit";
import { enrolSchema } from "@/lib/server/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return respond(async () => {
    enforceRateLimit(`enrol:${clientIp(request.headers)}`, RATE_RULES.enrol);
    const input = parseBody(enrolSchema, await readJson(request));
    return json(await enrolAgent(input));
  });
}
