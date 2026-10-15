import { requireUser } from "@/lib/server/clerk";
import { toJobDto } from "@/lib/server/dto";
import { json, parseBody, parseQuery, readJson, respond } from "@/lib/server/errors";
import { createJob, listJobs } from "@/lib/server/jobs";
import { createJobSchema, jobListQuerySchema } from "@/lib/server/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return respond(async () => {
    await requireUser();
    const query = parseQuery(jobListQuerySchema, new URL(request.url).searchParams);
    return json(
      await listJobs({
        ...(query.status ? { statuses: query.status } : {}),
        ...(query.targetId ? { targetId: query.targetId } : {}),
        page: query.page ?? 1,
        pageSize: query.pageSize ?? 20,
      }),
    );
  });
}

export async function POST(request: Request): Promise<Response> {
  return respond(async () => {
    const userId = await requireUser();
    const body = parseBody(createJobSchema, await readJson(request));
    const job = await createJob(
      {
        targetId: body.targetId,
        type: body.type,
        params: body.params ?? null,
      },
      userId,
    );
    return json(toJobDto(job));
  });
}
