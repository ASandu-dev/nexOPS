import { requireUser } from "@/lib/server/clerk";
import { json, parseQuery, respond } from "@/lib/server/errors";
import { jobListQuerySchema } from "@/lib/server/schemas";
import { listJobs } from "@/lib/server/jobs";
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

    const query = parseQuery(jobListQuerySchema, new URL(request.url).searchParams);
    return json(
      await listJobs({
        // The path segment is authoritative; the query filter never overrides it.
        targetId: id,
        ...(query.status ? { statuses: query.status } : {}),
        page: query.page ?? 1,
        pageSize: query.pageSize ?? 20,
      }),
    );
  });
}
