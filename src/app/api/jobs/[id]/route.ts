import { requireUser } from "@/lib/server/clerk";
import { toJobDto } from "@/lib/server/dto";
import { json, respond } from "@/lib/server/errors";
import { getJobOrThrow, reapTimedOutJobs } from "@/lib/server/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  return respond(async () => {
    await requireUser();
    const { id } = await context.params;
    await reapTimedOutJobs();
    const job = await getJobOrThrow(id);
    return json(toJobDto(job, job.targetName));
  });
}
