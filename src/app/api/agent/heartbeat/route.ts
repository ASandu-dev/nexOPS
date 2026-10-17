import { collectDispatchedJobs, requireAgent } from "@/lib/server/agent";
import { recordAudit } from "@/lib/server/audit";
import { json, parseBody, readJson, respond } from "@/lib/server/errors";
import { clientIp, enforceRateLimit, RATE_RULES } from "@/lib/server/rate-limit";
import { heartbeatSchema } from "@/lib/server/schemas";
import { recordHeartbeat } from "@/lib/server/telemetry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return respond(async () => {
    enforceRateLimit(`heartbeat:${clientIp(request.headers)}`, RATE_RULES.heartbeat);

    const { identity, target } = await requireAgent(request);
    const payload = parseBody(heartbeatSchema, await readJson(request));

    const firstHeartbeat = await recordHeartbeat({ identity, target, payload });
    if (firstHeartbeat) {
      // Audit only the PENDING_ENROLMENT → ONLINE transition, never routine beats.
      await recordAudit({
        actorId: identity.id,
        actorType: "AGENT",
        action: "target.online",
        targetType: "target",
        targetId: target.id,
        metadata: { hostname: payload.hostname, agentVersion: payload.agentVersion },
      });
    }

    return json(await collectDispatchedJobs(target.id, payload.activeJobIds));
  });
}
