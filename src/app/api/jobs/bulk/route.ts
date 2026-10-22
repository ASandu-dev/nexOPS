import { requireUser } from "@/lib/server/clerk";
import { bulkCreateJobs } from "@/lib/server/bulk-jobs";
import { json, parseBody, readJson, respond } from "@/lib/server/errors";
import { bulkCreateJobSchema } from "@/lib/server/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Dispatches one job to every eligible target (ONLINE or DEGRADED).
 *
 * Body: `{ type, targetIds? }` — omitting `targetIds` targets the whole
 * fleet. Every ineligible target is reported in `skipped` with the reason, so
 * an empty fleet is a `200` with `created: 0`, never an error.
 */
export async function POST(request: Request): Promise<Response> {
  return respond(async () => {
    const userId = await requireUser();
    const body = parseBody(bulkCreateJobSchema, await readJson(request));
    const result = await bulkCreateJobs(
      {
        type: body.type,
        ...(body.targetIds !== undefined ? { targetIds: body.targetIds } : {}),
      },
      userId,
    );
    return json(result);
  });
}
